import { createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
    lstat,
    link,
    mkdir,
    open,
    realpath,
    rename,
    rmdir,
    unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
    readLegalMcpTokenRegistryFileV1,
} from '../../middleware/legal-mcp-token-registry-file';
import {
    parseLegalMcpTokenRegistryJson,
    validateLegalMcpClientId,
    type LegalMcpTokenRegistryEntryV1,
    type LegalMcpTokenRegistryV1,
} from '../../middleware/legal-mcp-token-registry';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type LegalMcpRegistryOperatorActionV1 =
    | 'validate'
    | 'matches-env'
    | 'list'
    | 'add'
    | 'revoke'
    | 'init-from-env';

export interface LegalMcpRegistryOperatorResultV1 {
    action: LegalMcpRegistryOperatorActionV1;
    clientCount: number;
    clientId?: string;
    clientIds?: string[];
}

export interface AddLegalMcpRegistryClientOptionsV1 {
    replace?: boolean;
}

/**
 * Production writer contract: host global flock을 먼저 획득한 뒤 이 suffix의
 * owner-only mkdir lock을 사용해야 한다. 이 process-local 도구만으로 다른
 * 구현의 writer와 linearizability를 제공한다고 간주하지 않는다.
 */
export const LEGAL_MCP_REGISTRY_OPERATION_LOCK_SUFFIX_V1 = '.lock';
export const LEGAL_MCP_REGISTRY_COMMIT_STATE_UNKNOWN_CODE =
    'LEGAL_MCP_REGISTRY_COMMIT_STATE_UNKNOWN';

interface LegalMcpRegistryFileFingerprintV1 {
    dev: number;
    ino: number;
    size: number;
    mode: number;
    uid: number;
    mtimeMs: number;
    ctimeMs: number;
}

interface LegalMcpRegistrySnapshotV1 {
    registry: LegalMcpTokenRegistryV1;
    fingerprint: LegalMcpRegistryFileFingerprintV1;
    contentSha256: string;
}

export class LegalMcpRegistryOperatorError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LegalMcpRegistryOperatorError';
    }
}

export class LegalMcpRegistryCommitStateUnknownError extends Error {
    readonly code = LEGAL_MCP_REGISTRY_COMMIT_STATE_UNKNOWN_CODE;

    constructor() {
        super(
            'registry 변경 게시 후 최종 상태 확인에 실패했습니다. 재시도하지 말고 validate/list로 확인하세요.'
        );
        this.name = 'LegalMcpRegistryCommitStateUnknownError';
    }
}

function operatorError(message: string): never {
    throw new LegalMcpRegistryOperatorError(message);
}

function commitStateUnknownError(): never {
    throw new LegalMcpRegistryCommitStateUnknownError();
}

function isErrnoException(error: unknown, code: string): boolean {
    return error instanceof Error
        && 'code' in error
        && (error as NodeJS.ErrnoException).code === code;
}

/** 운영 도구는 모호한 상대 경로나 정규화되지 않은 경로를 허용하지 않는다. */
export function assertLegalMcpRegistryOperatorPathV1(filePath: string): void {
    if (
        typeof filePath !== 'string'
        || filePath.length === 0
        || !path.isAbsolute(filePath)
        || path.resolve(filePath) !== filePath
        || path.dirname(filePath) === filePath
    ) {
        operatorError('registry path는 정규화된 absolute file path여야 합니다.');
    }
}

async function assertProtectedParentDirectory(filePath: string): Promise<void> {
    assertLegalMcpRegistryOperatorPathV1(filePath);
    let parentStat: Stats;
    let canonicalParent: string;
    try {
        const parentPath = path.dirname(filePath);
        [parentStat, canonicalParent] = await Promise.all([
            lstat(parentPath),
            realpath(parentPath),
        ]);
    } catch {
        return operatorError('registry parent directory를 안전하게 확인할 수 없습니다.');
    }

    const currentUid = typeof process.geteuid === 'function'
        ? process.geteuid()
        : typeof process.getuid === 'function'
            ? process.getuid()
            : undefined;
    if (
        parentStat.isSymbolicLink()
        || !parentStat.isDirectory()
        || canonicalParent !== path.dirname(filePath)
        || (parentStat.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
        || (currentUid !== undefined && parentStat.uid !== currentUid)
    ) {
        operatorError('registry parent directory는 current uid 소유의 mode 0700 directory여야 합니다.');
    }
}

async function targetExists(filePath: string): Promise<boolean> {
    try {
        await lstat(filePath);
        return true;
    } catch (error) {
        if (isErrnoException(error, 'ENOENT')) return false;
        return operatorError('registry target 상태를 안전하게 확인할 수 없습니다.');
    }
}

async function withExclusiveRegistryLock<T>(
    filePath: string,
    operation: () => Promise<T>
): Promise<T> {
    await assertProtectedParentDirectory(filePath);
    const lockPath = `${filePath}${LEGAL_MCP_REGISTRY_OPERATION_LOCK_SUFFIX_V1}`;
    try {
        await mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
        if (isErrnoException(error, 'EEXIST')) {
            return operatorError(
                'registry operation lock이 이미 존재합니다. 자동으로 제거하지 말고 운영자가 확인해야 합니다.'
            );
        }
        return operatorError('registry operation lock을 안전하게 획득할 수 없습니다.');
    }

    let operationCompleted = false;
    let operationError: unknown;
    try {
        const operationResult = await operation();
        operationCompleted = true;
        return operationResult;
    } catch (error) {
        operationError = error;
        throw error;
    } finally {
        try {
            await rmdir(lockPath);
        } catch {
            if (
                operationCompleted
                || operationError instanceof LegalMcpRegistryCommitStateUnknownError
            ) {
                commitStateUnknownError();
            }
            operatorError('registry operation lock을 안전하게 정리할 수 없습니다.');
        }
    }
}

function canonicalRegistryJson(registry: LegalMcpTokenRegistryV1): string {
    const parsed = parseLegalMcpTokenRegistryJson(JSON.stringify(registry));
    return `${JSON.stringify(parsed, null, 2)}\n`;
}

function fingerprint(info: Stats): LegalMcpRegistryFileFingerprintV1 {
    return {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mode: info.mode,
        uid: info.uid,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
    };
}

function sameFingerprint(
    left: LegalMcpRegistryFileFingerprintV1,
    right: LegalMcpRegistryFileFingerprintV1
): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mode === right.mode
        && left.uid === right.uid
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}

function contentSha256(registry: LegalMcpTokenRegistryV1): string {
    return createHash('sha256')
        .update(canonicalRegistryJson(registry), 'utf8')
        .digest('hex');
}

async function readRegistrySnapshot(
    filePath: string
): Promise<LegalMcpRegistrySnapshotV1> {
    let before: Stats;
    let after: Stats;
    try {
        before = await lstat(filePath);
        const registry = readLegalMcpTokenRegistryFileV1(filePath);
        after = await lstat(filePath);
        const beforeFingerprint = fingerprint(before);
        const afterFingerprint = fingerprint(after);
        if (!sameFingerprint(beforeFingerprint, afterFingerprint)) {
            return operatorError('registry 원본 상태가 읽는 동안 변경되었습니다.');
        }
        return {
            registry,
            fingerprint: afterFingerprint,
            contentSha256: contentSha256(registry),
        };
    } catch (error) {
        if (error instanceof LegalMcpRegistryOperatorError) throw error;
        throw error;
    }
}

async function assertRegistrySnapshotUnchanged(
    filePath: string,
    expected: LegalMcpRegistrySnapshotV1
): Promise<void> {
    const actual = await readRegistrySnapshot(filePath);
    if (
        !sameFingerprint(expected.fingerprint, actual.fingerprint)
        || expected.contentSha256 !== actual.contentSha256
    ) {
        operatorError('registry 원본 상태가 작업 중 변경되어 갱신을 중단했습니다.');
    }
}

function sameSemanticRegistry(
    left: LegalMcpTokenRegistryV1,
    right: LegalMcpTokenRegistryV1
): boolean {
    if (left.clients.length !== right.clients.length) return false;
    const byClientId = (
        first: LegalMcpTokenRegistryEntryV1,
        second: LegalMcpTokenRegistryEntryV1
    ): number => first.clientId < second.clientId
        ? -1
        : first.clientId > second.clientId
            ? 1
            : 0;
    const leftClients = left.clients.slice().sort(byClientId);
    const rightClients = right.clients.slice().sort(byClientId);
    return leftClients.every((entry, index) => (
        entry.clientId === rightClients[index].clientId
        && entry.tokenSha256 === rightClients[index].tokenSha256
    ));
}

function readSoleEnvironmentRegistry(): LegalMcpTokenRegistryV1 {
    const registryJson = process.env.LEGAL_MCP_TOKEN_REGISTRY_JSON ?? '';
    const hasRegistryJson = registryJson.trim().length > 0;
    const hasRegistryFile = (
        process.env.LEGAL_MCP_TOKEN_REGISTRY_FILE ?? ''
    ).trim().length > 0;
    const hasLegacyDigest = (
        process.env.LEGAL_MCP_TOKEN_SHA256 ?? ''
    ).trim().length > 0;
    if (
        !hasRegistryJson
        || Number(hasRegistryJson) + Number(hasRegistryFile)
            + Number(hasLegacyDigest) !== 1
    ) {
        operatorError(
            '환경 migration에는 LEGAL_MCP_TOKEN_REGISTRY_JSON 단독 인증 source가 필요합니다.'
        );
    }
    return parseLegalMcpTokenRegistryJson(registryJson);
}

async function syncParentDirectory(parentPath: string): Promise<void> {
    const directory = await open(parentPath, constants.O_RDONLY);
    try {
        await directory.sync();
    } finally {
        await directory.close();
    }
}

async function atomicWriteRegistry(
    filePath: string,
    registry: LegalMcpTokenRegistryV1,
    options: {
        requireTargetAbsent?: boolean;
        expectedCurrent?: LegalMcpRegistrySnapshotV1;
    } = {}
): Promise<LegalMcpTokenRegistryV1> {
    const serialized = canonicalRegistryJson(registry);
    const parentPath = path.dirname(filePath);
    const temporaryPath = path.join(
        parentPath,
        `.${path.basename(filePath)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`
    );

    let handle;
    let temporaryExists = false;
    let published = false;
    try {
        handle = await open(
            temporaryPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            PRIVATE_FILE_MODE
        );
        temporaryExists = true;
        await handle.writeFile(serialized, { encoding: 'utf8' });
        await handle.sync();
        await handle.close();
        handle = undefined;

        if (options.requireTargetAbsent) {
            // link(2)는 destination이 이미 있으면 EEXIST로 실패하므로 rename의
            // overwrite race 없이 완성된 inode를 원자적으로 게시할 수 있다.
            try {
                await link(temporaryPath, filePath);
                published = true;
            } catch (error) {
                if (isErrnoException(error, 'EEXIST')) {
                    operatorError('init-from-env는 기존 registry file을 덮어쓰지 않습니다.');
                }
                throw error;
            }
            await unlink(temporaryPath);
            temporaryExists = false;
        } else {
            if (!options.expectedCurrent) {
                operatorError('기존 registry 갱신에는 원본 snapshot이 필요합니다.');
            }
            // 동일 uid의 비협력 writer에 대한 best-effort tamper detection이다.
            // Writer 간 linearizability는 host global flock + mkdir lock 계약이 제공한다.
            await assertRegistrySnapshotUnchanged(filePath, options.expectedCurrent);
            await rename(temporaryPath, filePath);
            published = true;
            temporaryExists = false;
        }
        await syncParentDirectory(parentPath);

        // rename 이후에도 runtime과 같은 strict reader로 결과를 다시 확인한다.
        return readLegalMcpTokenRegistryFileV1(filePath);
    } catch (error) {
        if (error instanceof LegalMcpRegistryCommitStateUnknownError) throw error;
        if (published) return commitStateUnknownError();
        if (error instanceof LegalMcpRegistryOperatorError) throw error;
        return operatorError('registry file을 원자적으로 기록하고 검증하지 못했습니다.');
    } finally {
        let cleanupFailed = false;
        if (handle) {
            await handle.close().catch(() => {
                cleanupFailed = true;
            });
        }
        if (temporaryExists) {
            await unlink(temporaryPath).catch(() => {
                cleanupFailed = true;
            });
        }
        if (cleanupFailed) {
            if (published) commitStateUnknownError();
            operatorError('registry temporary file을 안전하게 정리할 수 없습니다.');
        }
    }
}

function result(
    action: LegalMcpRegistryOperatorActionV1,
    registry: LegalMcpTokenRegistryV1,
    details: Pick<LegalMcpRegistryOperatorResultV1, 'clientId' | 'clientIds'> = {}
): LegalMcpRegistryOperatorResultV1 {
    return {
        action,
        clientCount: registry.clients.length,
        ...details,
    };
}

export function validateLegalMcpRegistryFileV1(
    filePath: string
): LegalMcpRegistryOperatorResultV1 {
    assertLegalMcpRegistryOperatorPathV1(filePath);
    return result('validate', readLegalMcpTokenRegistryFileV1(filePath));
}

export function matchLegalMcpRegistryEnvironmentV1(
    filePath: string
): LegalMcpRegistryOperatorResultV1 {
    assertLegalMcpRegistryOperatorPathV1(filePath);
    const fileRegistry = readLegalMcpTokenRegistryFileV1(filePath);
    const environmentRegistry = readSoleEnvironmentRegistry();
    if (!sameSemanticRegistry(fileRegistry, environmentRegistry)) {
        operatorError('보호 file registry와 환경 registry가 일치하지 않습니다.');
    }
    return result('matches-env', fileRegistry);
}

export function listLegalMcpRegistryClientsV1(
    filePath: string
): LegalMcpRegistryOperatorResultV1 {
    assertLegalMcpRegistryOperatorPathV1(filePath);
    const registry = readLegalMcpTokenRegistryFileV1(filePath);
    return result('list', registry, {
        clientIds: registry.clients.map(({ clientId }) => clientId),
    });
}

export async function addLegalMcpRegistryClientV1(
    filePath: string,
    entry: LegalMcpTokenRegistryEntryV1,
    options: AddLegalMcpRegistryClientOptionsV1 = {}
): Promise<LegalMcpRegistryOperatorResultV1> {
    if (!validateLegalMcpClientId(entry.clientId)) {
        operatorError('clientId 형식이 올바르지 않습니다.');
    }

    return withExclusiveRegistryLock(filePath, async () => {
        const current = await readRegistrySnapshot(filePath);
        const existingIndex = current.registry.clients.findIndex(
            ({ clientId }) => clientId === entry.clientId
        );
        if (existingIndex >= 0 && options.replace !== true) {
            operatorError('이미 등록된 clientId입니다. 교체하려면 --replace가 필요합니다.');
        }
        if (existingIndex < 0 && options.replace === true) {
            operatorError('--replace 대상 clientId가 registry에 없습니다.');
        }

        const clients = current.registry.clients.slice();
        if (existingIndex >= 0) clients[existingIndex] = entry;
        else clients.push(entry);

        const updated = await atomicWriteRegistry(filePath, {
            version: 1,
            clients,
        }, {
            expectedCurrent: current,
        });
        return result('add', updated, { clientId: entry.clientId });
    });
}

export async function revokeLegalMcpRegistryClientV1(
    filePath: string,
    clientId: string
): Promise<LegalMcpRegistryOperatorResultV1> {
    if (!validateLegalMcpClientId(clientId)) {
        operatorError('clientId 형식이 올바르지 않습니다.');
    }

    return withExclusiveRegistryLock(filePath, async () => {
        const current = await readRegistrySnapshot(filePath);
        const existingIndex = current.registry.clients.findIndex(
            (entry) => entry.clientId === clientId
        );
        if (existingIndex < 0) {
            operatorError('revoke 대상 clientId가 registry에 없습니다.');
        }
        if (current.registry.clients.length === 1) {
            operatorError('마지막 client는 revoke할 수 없습니다.');
        }

        const updated = await atomicWriteRegistry(filePath, {
            version: 1,
            clients: current.registry.clients.filter((entry) => entry.clientId !== clientId),
        }, {
            expectedCurrent: current,
        });
        return result('revoke', updated, { clientId });
    });
}

export async function initLegalMcpRegistryFromEnvironmentV1(
    filePath: string
): Promise<LegalMcpRegistryOperatorResultV1> {
    return withExclusiveRegistryLock(filePath, async () => {
        if (await targetExists(filePath)) {
            operatorError('init-from-env는 기존 registry file을 덮어쓰지 않습니다.');
        }
        const registry = readSoleEnvironmentRegistry();
        const written = await atomicWriteRegistry(filePath, registry, {
            requireTargetAbsent: true,
        });
        return result('init-from-env', written);
    });
}
