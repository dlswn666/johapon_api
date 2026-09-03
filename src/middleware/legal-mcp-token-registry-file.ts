import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    openSync,
    readSync,
    realpathSync,
    type BigIntStats,
} from 'node:fs';
import {
    lstat,
    open,
    realpath,
    type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import {
    parseLegalMcpTokenRegistryJson,
    type LegalMcpTokenRegistryV1,
} from './legal-mcp-token-registry';

export const LEGAL_MCP_TOKEN_REGISTRY_FILE_MAX_BYTES = 16 * 1024;

export class LegalMcpTokenRegistryFileError extends Error {
    constructor(message = 'LEGAL_MCP_TOKEN_REGISTRY_FILE을 안전하게 읽을 수 없습니다.') {
        super(message);
        this.name = 'LegalMcpTokenRegistryFileError';
    }
}

interface PinnedStat {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mode: bigint;
    uid: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
}

interface SecureFileFingerprint {
    parent: PinnedStat;
    file: PinnedStat;
    parentRealPath: string;
    targetRealPath: string;
}

interface LegalMcpTokenRegistryFileSnapshot {
    registry: LegalMcpTokenRegistryV1;
    fingerprint: SecureFileFingerprint;
}

const invalidSnapshotFingerprints = new WeakMap<
    LegalMcpTokenRegistryFileError,
    SecureFileFingerprint
>();

export interface LegalMcpTokenRegistryFileProviderInstrumentationV1 {
    /** 테스트/관측용이다. path 또는 registry 내용을 인자로 전달하지 않는다. */
    onRuntimeInspection?: () => void | Promise<void>;
    /** race 회귀 테스트에서 metadata snapshot 반환 직전을 제어한다. */
    onRuntimeInspectionComplete?: () => void | Promise<void>;
    /** 실제 파일 본문을 다시 읽을 때만 호출한다. */
    onRuntimeReload?: () => void;
}

export interface LegalMcpTokenRegistryFileProviderV1 {
    getStartupRegistryV1(): LegalMcpTokenRegistryV1;
    readRegistryV1(): Promise<LegalMcpTokenRegistryV1>;
    isForPathV1(filePath: string): boolean;
}

function fileError(): never {
    throw new LegalMcpTokenRegistryFileError();
}

function invalidSnapshotError(fingerprint: SecureFileFingerprint): never {
    const error = new LegalMcpTokenRegistryFileError();
    invalidSnapshotFingerprints.set(error, fingerprint);
    throw error;
}

function currentUid(): bigint {
    const uid = typeof process.geteuid === 'function'
        ? process.geteuid()
        : typeof process.getuid === 'function'
            ? process.getuid()
            : null;
    return uid === null ? fileError() : BigInt(uid);
}

function canonicalCandidate(filePath: string): string {
    const candidate = filePath.trim();
    if (
        candidate.length === 0
        || candidate !== filePath
        || !path.isAbsolute(candidate)
        || path.normalize(candidate) !== candidate
    ) {
        return fileError();
    }
    return candidate;
}

function exactMode(info: BigIntStats): bigint {
    return info.mode & 0o7777n;
}

function isProtectedParent(info: BigIntStats, uid: bigint): boolean {
    return info.isDirectory()
        && !info.isSymbolicLink()
        && info.uid === uid
        && exactMode(info) === 0o700n;
}

function isProtectedRegistryFile(info: BigIntStats, uid: bigint): boolean {
    const mode = exactMode(info);
    return info.isFile()
        && !info.isSymbolicLink()
        && info.uid === uid
        && (mode === 0o400n || mode === 0o600n)
        && info.size >= 1n
        && info.size <= BigInt(LEGAL_MCP_TOKEN_REGISTRY_FILE_MAX_BYTES);
}

function pin(info: BigIntStats): PinnedStat {
    return {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mode: info.mode,
        uid: info.uid,
        mtimeNs: info.mtimeNs,
        ctimeNs: info.ctimeNs,
    };
}

function samePinnedStat(expected: PinnedStat, actual: BigIntStats): boolean {
    return expected.dev === actual.dev
        && expected.ino === actual.ino
        && expected.size === actual.size
        && expected.mode === actual.mode
        && expected.uid === actual.uid
        && expected.mtimeNs === actual.mtimeNs
        && expected.ctimeNs === actual.ctimeNs;
}

function samePinnedSnapshot(left: PinnedStat, right: PinnedStat): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mode === right.mode
        && left.uid === right.uid
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

function sameSecureFingerprint(
    left: SecureFileFingerprint,
    right: SecureFileFingerprint
): boolean {
    return samePinnedSnapshot(left.parent, right.parent)
        && samePinnedSnapshot(left.file, right.file)
        && left.parentRealPath === right.parentRealPath
        && left.targetRealPath === right.targetRealPath;
}

function fingerprint(
    parent: BigIntStats,
    file: BigIntStats,
    parentRealPath: string,
    targetRealPath: string
): SecureFileFingerprint {
    return {
        parent: pin(parent),
        file: pin(file),
        parentRealPath,
        targetRealPath,
    };
}

function assertSecureMetadata(input: {
    candidate: string;
    uid: bigint;
    parent: BigIntStats;
    file: BigIntStats;
    parentRealPath: string;
    targetRealPath: string;
}): void {
    if (
        input.parentRealPath !== path.dirname(input.candidate)
        || input.targetRealPath !== input.candidate
        || path.dirname(input.targetRealPath) !== input.parentRealPath
        || !isProtectedParent(input.parent, input.uid)
        || !isProtectedRegistryFile(input.file, input.uid)
    ) {
        fileError();
    }
}

function parseRegistryBody(body: Buffer, bytesRead: number): LegalMcpTokenRegistryV1 {
    const json = body.subarray(0, bytesRead).toString('utf8');
    return parseLegalMcpTokenRegistryJson(json);
}

function readSnapshotSync(filePath: string): LegalMcpTokenRegistryFileSnapshot {
    const candidate = canonicalCandidate(filePath);
    const uid = currentUid();
    const parentPath = path.dirname(candidate);
    let descriptor: number | null = null;
    let body: Buffer | null = null;

    try {
        const parentBefore = lstatSync(parentPath, { bigint: true });
        const parentRealBefore = realpathSync.native(parentPath);
        const pathBefore = lstatSync(candidate, { bigint: true });
        const targetRealBefore = realpathSync.native(candidate);
        assertSecureMetadata({
            candidate,
            uid,
            parent: parentBefore,
            file: pathBefore,
            parentRealPath: parentRealBefore,
            targetRealPath: targetRealBefore,
        });

        descriptor = openSync(
            candidate,
            constants.O_RDONLY
                | constants.O_NOFOLLOW
                | constants.O_NONBLOCK
        );
        const descriptorBefore = fstatSync(descriptor, { bigint: true });
        const descriptorPin = pin(descriptorBefore);
        if (
            !isProtectedRegistryFile(descriptorBefore, uid)
            || !sameInode(pathBefore, descriptorBefore)
        ) {
            return fileError();
        }

        body = Buffer.alloc(LEGAL_MCP_TOKEN_REGISTRY_FILE_MAX_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < body.byteLength) {
            const count = readSync(
                descriptor,
                body,
                bytesRead,
                body.byteLength - bytesRead,
                null
            );
            if (count === 0) break;
            bytesRead += count;
        }

        const descriptorAfter = fstatSync(descriptor, { bigint: true });
        const pathAfter = lstatSync(candidate, { bigint: true });
        const parentAfter = lstatSync(parentPath, { bigint: true });
        const parentRealAfter = realpathSync.native(parentPath);
        const targetRealAfter = realpathSync.native(candidate);
        assertSecureMetadata({
            candidate,
            uid,
            parent: parentAfter,
            file: pathAfter,
            parentRealPath: parentRealAfter,
            targetRealPath: targetRealAfter,
        });
        if (
            bytesRead < 1
            || bytesRead > LEGAL_MCP_TOKEN_REGISTRY_FILE_MAX_BYTES
            || BigInt(bytesRead) !== descriptorPin.size
            || !samePinnedStat(descriptorPin, descriptorAfter)
            || !sameInode(descriptorAfter, pathAfter)
            || !sameInode(parentBefore, parentAfter)
            || parentRealAfter !== parentRealBefore
            || targetRealAfter !== targetRealBefore
        ) {
            return fileError();
        }

        return {
            registry: parseRegistryBody(body, bytesRead),
            fingerprint: fingerprint(
                parentAfter,
                pathAfter,
                parentRealAfter,
                targetRealAfter
            ),
        };
    } catch (error) {
        if (error instanceof LegalMcpTokenRegistryFileError) throw error;
        throw new LegalMcpTokenRegistryFileError();
    } finally {
        body?.fill(0);
        if (descriptor !== null) closeSync(descriptor);
    }
}

async function inspectSecureMetadataAsync(
    filePath: string,
    instrumentation?: LegalMcpTokenRegistryFileProviderInstrumentationV1
): Promise<SecureFileFingerprint> {
    await instrumentation?.onRuntimeInspection?.();
    const candidate = canonicalCandidate(filePath);
    const uid = currentUid();
    const parentPath = path.dirname(candidate);

    try {
        const [parentBefore, pathBefore, parentRealBefore, targetRealBefore] =
            await Promise.all([
                lstat(parentPath, { bigint: true }),
                lstat(candidate, { bigint: true }),
                realpath(parentPath),
                realpath(candidate),
            ]);
        assertSecureMetadata({
            candidate,
            uid,
            parent: parentBefore,
            file: pathBefore,
            parentRealPath: parentRealBefore,
            targetRealPath: targetRealBefore,
        });

        const [parentAfter, pathAfter, parentRealAfter, targetRealAfter] =
            await Promise.all([
                lstat(parentPath, { bigint: true }),
                lstat(candidate, { bigint: true }),
                realpath(parentPath),
                realpath(candidate),
            ]);
        assertSecureMetadata({
            candidate,
            uid,
            parent: parentAfter,
            file: pathAfter,
            parentRealPath: parentRealAfter,
            targetRealPath: targetRealAfter,
        });
        const before = fingerprint(
            parentBefore,
            pathBefore,
            parentRealBefore,
            targetRealBefore
        );
        const after = fingerprint(
            parentAfter,
            pathAfter,
            parentRealAfter,
            targetRealAfter
        );
        if (!sameSecureFingerprint(before, after)) return fileError();
        await instrumentation?.onRuntimeInspectionComplete?.();
        return after;
    } catch (error) {
        if (error instanceof LegalMcpTokenRegistryFileError) throw error;
        throw new LegalMcpTokenRegistryFileError();
    }
}

async function readSnapshotAsync(
    filePath: string,
    instrumentation?: LegalMcpTokenRegistryFileProviderInstrumentationV1
): Promise<LegalMcpTokenRegistryFileSnapshot> {
    const candidate = canonicalCandidate(filePath);
    const before = await inspectSecureMetadataAsync(candidate, instrumentation);
    let handle: FileHandle | null = null;
    let body: Buffer | null = null;

    try {
        handle = await open(
            candidate,
            constants.O_RDONLY
                | constants.O_NOFOLLOW
                | constants.O_NONBLOCK
        );
        const descriptorBefore = await handle.stat({ bigint: true });
        const descriptorPin = pin(descriptorBefore);
        if (
            !isProtectedRegistryFile(descriptorBefore, currentUid())
            || descriptorBefore.dev !== before.file.dev
            || descriptorBefore.ino !== before.file.ino
        ) {
            return fileError();
        }

        instrumentation?.onRuntimeReload?.();
        body = Buffer.alloc(LEGAL_MCP_TOKEN_REGISTRY_FILE_MAX_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < body.byteLength) {
            const result = await handle.read(
                body,
                bytesRead,
                body.byteLength - bytesRead,
                null
            );
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }

        const descriptorAfter = await handle.stat({ bigint: true });
        const after = await inspectSecureMetadataAsync(candidate, instrumentation);
        if (
            bytesRead < 1
            || bytesRead > LEGAL_MCP_TOKEN_REGISTRY_FILE_MAX_BYTES
            || BigInt(bytesRead) !== descriptorPin.size
            || !samePinnedStat(descriptorPin, descriptorAfter)
            || descriptorAfter.dev !== after.file.dev
            || descriptorAfter.ino !== after.file.ino
            || !sameSecureFingerprint(before, after)
        ) {
            return fileError();
        }

        let registry: LegalMcpTokenRegistryV1;
        try {
            registry = parseRegistryBody(body, bytesRead);
        } catch {
            return invalidSnapshotError(after);
        }
        return { registry, fingerprint: after };
    } catch (error) {
        if (error instanceof LegalMcpTokenRegistryFileError) throw error;
        throw new LegalMcpTokenRegistryFileError();
    } finally {
        body?.fill(0);
        await handle?.close().catch(() => undefined);
    }
}

export function readLegalMcpTokenRegistryFileV1(
    filePath: string
): LegalMcpTokenRegistryV1 {
    return readSnapshotSync(filePath).registry;
}

export async function readLegalMcpTokenRegistryFileAsyncV1(
    filePath: string
): Promise<LegalMcpTokenRegistryV1> {
    return (await readSnapshotAsync(filePath)).registry;
}

class LegalMcpTokenRegistryFileProvider
implements LegalMcpTokenRegistryFileProviderV1 {
    private snapshot: LegalMcpTokenRegistryFileSnapshot | null;
    private invalidFingerprint: SecureFileFingerprint | null = null;
    private reloadTail: Promise<void> = Promise.resolve();

    constructor(
        private readonly filePath: string,
        private readonly instrumentation:
            LegalMcpTokenRegistryFileProviderInstrumentationV1 = {}
    ) {
        try {
            this.snapshot = readSnapshotSync(filePath);
        } catch {
            // health는 startup invalid 이후 복구도 관측해야 하므로 provider 자체는 유지한다.
            this.snapshot = null;
        }
    }

    getStartupRegistryV1(): LegalMcpTokenRegistryV1 {
        return this.snapshot?.registry ?? fileError();
    }

    isForPathV1(filePath: string): boolean {
        return filePath === this.filePath;
    }

    private inspectRuntime(): Promise<SecureFileFingerprint> {
        // 요청마다 독립 fingerprint를 얻어, 교체 완료 뒤 도착한 요청이
        // 교체 전 in-flight 검사 결과를 공유하지 않도록 한다.
        return inspectSecureMetadataAsync(
            this.filePath,
            this.instrumentation
        );
    }

    private assertNotKnownInvalid(observed: SecureFileFingerprint): void {
        if (
            this.invalidFingerprint
            && sameSecureFingerprint(this.invalidFingerprint, observed)
        ) {
            fileError();
        }
    }

    async readRegistryV1(): Promise<LegalMcpTokenRegistryV1> {
        const observed = await this.inspectRuntime();
        this.assertNotKnownInvalid(observed);
        if (
            this.snapshot
            && sameSecureFingerprint(this.snapshot.fingerprint, observed)
        ) {
            return this.snapshot.registry;
        }

        let release!: () => void;
        const previousReload = this.reloadTail;
        this.reloadTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previousReload;
        try {
            const current = await this.inspectRuntime();
            this.assertNotKnownInvalid(current);
            if (
                this.snapshot
                && sameSecureFingerprint(this.snapshot.fingerprint, current)
            ) {
                return this.snapshot.registry;
            }
            try {
                const reloaded = await readSnapshotAsync(
                    this.filePath,
                    this.instrumentation
                );
                this.snapshot = reloaded;
                this.invalidFingerprint = null;
                return reloaded.registry;
            } catch (error) {
                if (error instanceof LegalMcpTokenRegistryFileError) {
                    const invalidFingerprint = invalidSnapshotFingerprints.get(
                        error
                    );
                    if (invalidFingerprint) {
                        this.invalidFingerprint = invalidFingerprint;
                        // 잘못된 세대가 확인되면 이전 정상 digest snapshot도 즉시 폐기한다.
                        this.snapshot = null;
                    }
                }
                throw error;
            }
        } finally {
            release();
        }
    }
}

export function createLegalMcpTokenRegistryFileProviderV1(
    filePath: string,
    instrumentation: LegalMcpTokenRegistryFileProviderInstrumentationV1 = {}
): LegalMcpTokenRegistryFileProviderV1 {
    return new LegalMcpTokenRegistryFileProvider(filePath, instrumentation);
}
