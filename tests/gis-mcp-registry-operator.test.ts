import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { parseGisMcpTokenRegistryJson } from '../src/middleware/gis-mcp-token-registry';
import {
    addGisMcpRegistryClientV1,
    assertGisMcpRegistryOperatorPathV1,
    attestGisMcpRegistryClientV1,
    computeGisMcpRegistryTokenCommitmentV1,
    initGisMcpRegistryFromEnvironmentV1,
    GIS_MCP_REGISTRY_COMMIT_STATE_UNKNOWN_CODE,
    GisMcpRegistryCommitStateUnknownError,
    listGisMcpRegistryClientsV1,
    matchGisMcpRegistryEnvironmentV1,
    revokeGisMcpRegistryClientV1,
    validateGisMcpRegistryFileV1,
} from '../src/services/public-data-mcp/mcp-token-registry-operator';

const cleanupRoots: string[] = [];

function digest(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function privateRoot(): string {
    const root = realpathSync.native(
        mkdtempSync(path.join(tmpdir(), 'gis-mcp-registry-operator-'))
    );
    chmodSync(root, 0o700);
    cleanupRoots.push(root);
    return root;
}

function writeRegistry(
    filePath: string,
    clients: Array<{ clientId: string; tokenSha256: string }>
): void {
    writeFileSync(
        filePath,
        `${JSON.stringify({ version: 1, clients }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 }
    );
    chmodSync(filePath, 0o600);
}

function readRegistry(filePath: string) {
    return parseGisMcpTokenRegistryJson(readFileSync(filePath, 'utf8'));
}

afterEach(() => {
    while (cleanupRoots.length > 0) {
        rmSync(cleanupRoots.pop() as string, { recursive: true, force: true });
    }
});

describe('GIS MCP file registry operator', { concurrency: false }, () => {
    it('add commitment는 canonical dispatch와 동일하며 실제 저장 digest에 content-bound된다', () => {
        const root = privateRoot();
        const filePath = path.join(root, 'clients.json');
        const operationId = 'operation-content-1234';
        const clientId = 'client-content';
        const storedDigest = digest('stored-secret');
        const otherDigest = digest('different-secret');
        writeRegistry(filePath, [{ clientId, tokenSha256: storedDigest }]);

        const expected = createHash('sha256').update(JSON.stringify({
            version: 1,
            operationId,
            action: 'add',
            clientId,
            tokenSha256: storedDigest,
        }), 'utf8').digest('hex');
        assert.equal(computeGisMcpRegistryTokenCommitmentV1({
            operationId,
            clientId,
            tokenSha256: storedDigest,
        }), expected);
        assert.deepEqual(attestGisMcpRegistryClientV1(
            filePath,
            clientId,
            operationId
        ), {
            action: 'attest-client',
            clientCount: 1,
            clientId,
            tokenCommitment: expected,
        });
        assert.notEqual(computeGisMcpRegistryTokenCommitmentV1({
            operationId,
            clientId,
            tokenSha256: otherDigest,
        }), expected);
        assert.notEqual(expected, storedDigest);
        assert.notEqual(expected, otherDigest);
    });

    it('absolute canonical path만 허용하고 protected registry를 validate/list한다', () => {
        const root = privateRoot();
        const filePath = path.join(root, 'clients.json');
        writeRegistry(filePath, [
            { clientId: 'client-one', tokenSha256: digest('one') },
            { clientId: 'client-two', tokenSha256: digest('two') },
        ]);

        assert.deepEqual(validateGisMcpRegistryFileV1(filePath), {
            action: 'validate',
            clientCount: 2,
        });
        assert.deepEqual(listGisMcpRegistryClientsV1(filePath), {
            action: 'list',
            clientCount: 2,
            clientIds: ['client-one', 'client-two'],
        });
        assert.throws(() => assertGisMcpRegistryOperatorPathV1('clients.json'));
        assert.throws(() => assertGisMcpRegistryOperatorPathV1(
            `${root}/nested/../clients.json`
        ));
    });

    it('matches-env는 client 순서와 digest 대소문자 차이를 정규화해 semantic equality를 확인한다', () => {
        const root = privateRoot();
        const filePath = path.join(root, 'clients.json');
        const firstDigest = digest('one');
        const secondDigest = digest('two');
        writeRegistry(filePath, [
            { clientId: 'client-one', tokenSha256: firstDigest },
            { clientId: 'client-two', tokenSha256: secondDigest },
        ]);
        const previous = process.env.GIS_MCP_TOKEN_REGISTRY_JSON;
        process.env.GIS_MCP_TOKEN_REGISTRY_JSON = JSON.stringify({
            version: 1,
            clients: [
                { clientId: 'client-two', tokenSha256: secondDigest.toUpperCase() },
                { clientId: 'client-one', tokenSha256: ` ${firstDigest.toUpperCase()} ` },
            ],
        });
        try {
            assert.deepEqual(matchGisMcpRegistryEnvironmentV1(filePath), {
                action: 'matches-env',
                clientCount: 2,
            });
        } finally {
            if (previous === undefined) delete process.env.GIS_MCP_TOKEN_REGISTRY_JSON;
            else process.env.GIS_MCP_TOKEN_REGISTRY_JSON = previous;
        }
    });

    it('matches-env mismatch는 clientId와 digest를 노출하지 않는 고정 오류다', () => {
        const root = privateRoot();
        const filePath = path.join(root, 'clients.json');
        const fileDigest = digest('file-secret');
        const envDigest = digest('env-secret');
        writeRegistry(filePath, [
            { clientId: 'file-client', tokenSha256: fileDigest },
        ]);
        const previous = process.env.GIS_MCP_TOKEN_REGISTRY_JSON;
        process.env.GIS_MCP_TOKEN_REGISTRY_JSON = JSON.stringify({
            version: 1,
            clients: [{ clientId: 'env-client', tokenSha256: envDigest }],
        });
        try {
            assert.throws(() => matchGisMcpRegistryEnvironmentV1(filePath), (error) => {
                assert.equal(
                    error instanceof Error ? error.message : '',
                    '보호 file registry와 환경 registry가 일치하지 않습니다.'
                );
                for (const sensitive of [
                    'file-client',
                    'env-client',
                    fileDigest,
                    envDigest,
                ]) {
                    assert.equal(String(error).includes(sensitive), false);
                }
                return true;
            });
        } finally {
            if (previous === undefined) delete process.env.GIS_MCP_TOKEN_REGISTRY_JSON;
            else process.env.GIS_MCP_TOKEN_REGISTRY_JSON = previous;
        }
    });

    it('matches-env는 환경 registry 누락도 file 내용 노출 없이 fail-closed 한다', () => {
        const root = privateRoot();
        const filePath = path.join(root, 'clients.json');
        const fileDigest = digest('file-only-secret');
        writeRegistry(filePath, [
            { clientId: 'file-only-client', tokenSha256: fileDigest },
        ]);
        const previous = process.env.GIS_MCP_TOKEN_REGISTRY_JSON;
        delete process.env.GIS_MCP_TOKEN_REGISTRY_JSON;
        try {
            assert.throws(() => matchGisMcpRegistryEnvironmentV1(filePath), (error) => {
                assert.equal(String(error).includes('file-only-client'), false);
                assert.equal(String(error).includes(fileDigest), false);
                return true;
            });
        } finally {
            if (previous !== undefined) {
                process.env.GIS_MCP_TOKEN_REGISTRY_JSON = previous;
            }
        }
    });

    it('matches-env는 JSON 외 인증 source가 함께 있으면 비교 전에 fail-closed 한다', () => {
        const root = privateRoot();
        const filePath = path.join(root, 'clients.json');
        const fileDigest = digest('mixed-source-secret');
        writeRegistry(filePath, [
            { clientId: 'mixed-source-client', tokenSha256: fileDigest },
        ]);
        const previousJson = process.env.GIS_MCP_TOKEN_REGISTRY_JSON;
        const previousFile = process.env.GIS_MCP_TOKEN_REGISTRY_FILE;
        const previousLegacy = process.env.GIS_MCP_TOKEN_SHA256;
        process.env.GIS_MCP_TOKEN_REGISTRY_JSON = JSON.stringify({
            version: 1,
            clients: [{
                clientId: 'mixed-source-client',
                tokenSha256: fileDigest,
            }],
        });
        process.env.GIS_MCP_TOKEN_REGISTRY_FILE = '/must-not-be-used';
        process.env.GIS_MCP_TOKEN_SHA256 = digest('legacy-secret');
        try {
            assert.throws(() => matchGisMcpRegistryEnvironmentV1(filePath), (error) => {
                assert.equal(
                    error instanceof Error ? error.message : '',
                    '환경 migration에는 GIS_MCP_TOKEN_REGISTRY_JSON 단독 인증 source가 필요합니다.'
                );
                assert.equal(String(error).includes('mixed-source-client'), false);
                assert.equal(String(error).includes(fileDigest), false);
                return true;
            });
        } finally {
            if (previousJson === undefined) {
                delete process.env.GIS_MCP_TOKEN_REGISTRY_JSON;
            } else {
                process.env.GIS_MCP_TOKEN_REGISTRY_JSON = previousJson;
            }
            if (previousFile === undefined) {
                delete process.env.GIS_MCP_TOKEN_REGISTRY_FILE;
            } else {
                process.env.GIS_MCP_TOKEN_REGISTRY_FILE = previousFile;
            }
            if (previousLegacy === undefined) {
                delete process.env.GIS_MCP_TOKEN_SHA256;
            } else {
                process.env.GIS_MCP_TOKEN_SHA256 = previousLegacy;
            }
        }
    });

    it('init-from-env도 혼합 인증 source에서는 파일을 만들지 않는다', async () => {
        const root = privateRoot();
        const filePath = path.join(root, 'clients.json');
        const previousJson = process.env.GIS_MCP_TOKEN_REGISTRY_JSON;
        const previousFile = process.env.GIS_MCP_TOKEN_REGISTRY_FILE;
        process.env.GIS_MCP_TOKEN_REGISTRY_JSON = JSON.stringify({
            version: 1,
            clients: [{
                clientId: 'mixed-init-client',
                tokenSha256: digest('mixed-init-secret'),
            }],
        });
        process.env.GIS_MCP_TOKEN_REGISTRY_FILE = '/must-not-be-used';
        try {
            await assert.rejects(
                initGisMcpRegistryFromEnvironmentV1(filePath),
                /GIS_MCP_TOKEN_REGISTRY_JSON 단독 인증 source/
            );
            assert.equal(existsSync(filePath), false);
        } finally {
            if (previousJson === undefined) {
                delete process.env.GIS_MCP_TOKEN_REGISTRY_JSON;
            } else {
                process.env.GIS_MCP_TOKEN_REGISTRY_JSON = previousJson;
            }
            if (previousFile === undefined) {
                delete process.env.GIS_MCP_TOKEN_REGISTRY_FILE;
            } else {
                process.env.GIS_MCP_TOKEN_REGISTRY_FILE = previousFile;
            }
        }
    });

    it('init-from-env는 env registry를 0600으로 원자 생성하고 기존 target은 보존한다', async () => {
        const root = privateRoot();
        const filePath = path.join(root, 'clients.json');
        const firstDigest = digest('initial-one');
        const previous = process.env.GIS_MCP_TOKEN_REGISTRY_JSON;
        process.env.GIS_MCP_TOKEN_REGISTRY_JSON = JSON.stringify({
            version: 1,
            clients: [{ clientId: 'initial-one', tokenSha256: firstDigest }],
        });
        try {
            assert.deepEqual(await initGisMcpRegistryFromEnvironmentV1(filePath), {
                action: 'init-from-env',
                clientCount: 1,
            });
            assert.equal(lstatSync(filePath).mode & 0o777, 0o600);
            assert.deepEqual(readRegistry(filePath).clients, [
                { clientId: 'initial-one', tokenSha256: firstDigest },
            ]);

            process.env.GIS_MCP_TOKEN_REGISTRY_JSON = JSON.stringify({
                version: 1,
                clients: [{ clientId: 'other-client', tokenSha256: digest('other') }],
            });
            await assert.rejects(initGisMcpRegistryFromEnvironmentV1(filePath), /덮어쓰지/);
            assert.deepEqual(readRegistry(filePath).clients, [
                { clientId: 'initial-one', tokenSha256: firstDigest },
            ]);
        } finally {
            if (previous === undefined) delete process.env.GIS_MCP_TOKEN_REGISTRY_JSON;
            else process.env.GIS_MCP_TOKEN_REGISTRY_JSON = previous;
        }
    });

    it('init publish race에서도 이미 생성된 target을 hard-link no-replace로 보존한다', async () => {
        const root = privateRoot();
        const filePath = path.join(root, 'clients.json');
        const concurrentClients = [
            { clientId: 'external-client', tokenSha256: digest('external') },
        ];
        const previous = process.env.GIS_MCP_TOKEN_REGISTRY_JSON;
        process.env.GIS_MCP_TOKEN_REGISTRY_JSON = JSON.stringify({
            version: 1,
            clients: [{ clientId: 'migration-one', tokenSha256: digest('migration') }],
        });
        const createConcurrentTarget = new Promise<void>((resolve, reject) => {
            let attempts = 0;
            const inspect = (): void => {
                attempts += 1;
                const temporaryExists = readdirSync(root).some((name) => (
                    name.startsWith('.clients.json.') && name.endsWith('.tmp')
                ));
                if (temporaryExists) {
                    writeRegistry(filePath, concurrentClients);
                    resolve();
                    return;
                }
                if (attempts >= 1_000) {
                    reject(new Error('operator temporary file을 관찰하지 못했습니다.'));
                    return;
                }
                setImmediate(inspect);
            };
            setImmediate(inspect);
        });
        try {
            await Promise.all([
                createConcurrentTarget,
                assert.rejects(
                    initGisMcpRegistryFromEnvironmentV1(filePath),
                    /덮어쓰지/
                ),
            ]);
            assert.deepEqual(readRegistry(filePath).clients, concurrentClients);
            assert.deepEqual(readdirSync(root).sort(), ['clients.json']);
        } finally {
            if (previous === undefined) delete process.env.GIS_MCP_TOKEN_REGISTRY_JSON;
            else process.env.GIS_MCP_TOKEN_REGISTRY_JSON = previous;
        }
    });

    it('add는 새 client를 추가하며 기존 client 교체에 명시적 replace를 요구한다', async () => {
        const root = privateRoot();
        const filePath = path.join(root, 'clients.json');
        const originalDigest = digest('original');
        const addedDigest = digest('added');
        const replacementDigest = digest('replacement');
        writeRegistry(filePath, [
            { clientId: 'client-one', tokenSha256: originalDigest },
        ]);

        assert.deepEqual(await addGisMcpRegistryClientV1(filePath, {
            clientId: 'client-two',
            tokenSha256: addedDigest,
        }), {
            action: 'add',
            clientId: 'client-two',
            clientCount: 2,
        });
        assert.equal(lstatSync(filePath).mode & 0o777, 0o600);

        await assert.rejects(addGisMcpRegistryClientV1(filePath, {
            clientId: 'client-one',
            tokenSha256: replacementDigest,
        }), /--replace/);
        assert.equal(readRegistry(filePath).clients[0].tokenSha256, originalDigest);

        assert.deepEqual(await addGisMcpRegistryClientV1(filePath, {
            clientId: 'client-one',
            tokenSha256: replacementDigest,
        }, { replace: true }), {
            action: 'add',
            clientId: 'client-one',
            clientCount: 2,
        });
        assert.equal(readRegistry(filePath).clients[0].tokenSha256, replacementDigest);
        assert.deepEqual(
            readdirSync(root).sort(),
            ['clients.json'],
            '성공/실패 뒤 lock과 same-dir temp가 남지 않아야 한다'
        );
    });

    it('replace typo, 중복 digest, 공개 parent를 fail-closed로 거부한다', async () => {
        const root = privateRoot();
        const filePath = path.join(root, 'clients.json');
        const firstDigest = digest('first');
        writeRegistry(filePath, [
            { clientId: 'client-one', tokenSha256: firstDigest },
        ]);

        await assert.rejects(addGisMcpRegistryClientV1(filePath, {
            clientId: 'missing-client',
            tokenSha256: digest('missing'),
        }, { replace: true }), /registry에 없습니다/);
        await assert.rejects(addGisMcpRegistryClientV1(filePath, {
            clientId: 'client-two',
            tokenSha256: firstDigest,
        }), (error: unknown) => {
            assert.equal(String(error).includes(firstDigest), false);
            return true;
        });

        chmodSync(root, 0o755);
        await assert.rejects(addGisMcpRegistryClientV1(filePath, {
            clientId: 'client-two',
            tokenSha256: digest('second'),
        }), /mode 0700/);
    });

    it('기존 mkdir lock이 있으면 변경과 stale lock 자동 삭제를 모두 거부한다', async () => {
        const root = privateRoot();
        const filePath = path.join(root, 'clients.json');
        writeRegistry(filePath, [
            { clientId: 'client-one', tokenSha256: digest('one') },
        ]);
        const lockPath = `${filePath}.lock`;
        mkdirSync(lockPath, { mode: 0o700 });

        await assert.rejects(addGisMcpRegistryClientV1(filePath, {
            clientId: 'client-two',
            tokenSha256: digest('two'),
        }), /자동으로 제거하지/);
        assert.equal(existsSync(lockPath), true);
        assert.equal(readRegistry(filePath).clients.length, 1);
    });

    it('best-effort tamper detection은 rename 전 외부 변경을 발견해 기존 내용을 보존한다', async () => {
        const root = privateRoot();
        const filePath = path.join(root, 'clients.json');
        writeRegistry(filePath, [
            { clientId: 'client-one', tokenSha256: digest('one') },
        ]);
        const concurrentClients = [
            { clientId: 'client-one', tokenSha256: digest('concurrent-one') },
            { clientId: 'external-client', tokenSha256: digest('external') },
        ];
        let mutationObserved = false;
        const mutateWhenTemporaryAppears = new Promise<void>((resolve, reject) => {
            let attempts = 0;
            const inspect = (): void => {
                attempts += 1;
                const temporaryExists = readdirSync(root).some((name) => (
                    name.startsWith('.clients.json.') && name.endsWith('.tmp')
                ));
                if (temporaryExists) {
                    mutationObserved = true;
                    writeRegistry(filePath, concurrentClients);
                    resolve();
                    return;
                }
                if (attempts >= 1_000) {
                    reject(new Error('operator temporary file을 관찰하지 못했습니다.'));
                    return;
                }
                setImmediate(inspect);
            };
            setImmediate(inspect);
        });
        await Promise.all([
            mutateWhenTemporaryAppears,
            assert.rejects(addGisMcpRegistryClientV1(filePath, {
                clientId: 'client-two',
                tokenSha256: digest('two'),
            }), /원본 상태가 작업 중 변경/),
        ]);

        assert.equal(mutationObserved, true);
        assert.deepEqual(readRegistry(filePath).clients, concurrentClients);
        assert.deepEqual(readdirSync(root).sort(), ['clients.json']);
    });

    it('publication 성공 뒤 lock cleanup 실패는 blind retry 금지 commit-state 오류다', async () => {
        const root = privateRoot();
        const filePath = path.join(root, 'clients.json');
        const addedDigest = digest('two');
        writeRegistry(filePath, [
            { clientId: 'client-one', tokenSha256: digest('one') },
        ]);
        const makeLockNonEmpty = new Promise<void>((resolve, reject) => {
            let attempts = 0;
            const inspect = (): void => {
                attempts += 1;
                const temporaryExists = readdirSync(root).some((name) => (
                    name.startsWith('.clients.json.') && name.endsWith('.tmp')
                ));
                if (temporaryExists) {
                    writeFileSync(path.join(`${filePath}.lock`, 'keep'), 'operator-check');
                    resolve();
                    return;
                }
                if (attempts >= 1_000) {
                    reject(new Error('operator temporary file을 관찰하지 못했습니다.'));
                    return;
                }
                setImmediate(inspect);
            };
            setImmediate(inspect);
        });
        const operation = addGisMcpRegistryClientV1(filePath, {
            clientId: 'client-two',
            tokenSha256: addedDigest,
        });
        await makeLockNonEmpty;
        await assert.rejects(operation, (error: unknown) => {
            assert.equal(error instanceof GisMcpRegistryCommitStateUnknownError, true);
            assert.equal(
                (error as GisMcpRegistryCommitStateUnknownError).code,
                GIS_MCP_REGISTRY_COMMIT_STATE_UNKNOWN_CODE
            );
            assert.match(String(error), /재시도하지 말고 validate\/list/);
            assert.equal(String(error).includes(addedDigest), false);
            return true;
        });
        assert.deepEqual(
            readRegistry(filePath).clients.map(({ clientId }) => clientId),
            ['client-one', 'client-two']
        );
    });

    it('ancestor symlink 경로에는 init secret file을 쓰지 않는다', async () => {
        const root = privateRoot();
        const actualParent = path.join(root, 'actual', 'nested');
        mkdirSync(actualParent, { recursive: true, mode: 0o700 });
        chmodSync(path.dirname(actualParent), 0o700);
        chmodSync(actualParent, 0o700);
        symlinkSync(path.join(root, 'actual'), path.join(root, 'alias'));
        const aliasedTarget = path.join(root, 'alias', 'nested', 'clients.json');
        const previous = process.env.GIS_MCP_TOKEN_REGISTRY_JSON;
        process.env.GIS_MCP_TOKEN_REGISTRY_JSON = JSON.stringify({
            version: 1,
            clients: [{ clientId: 'client-one', tokenSha256: digest('one') }],
        });
        try {
            await assert.rejects(
                initGisMcpRegistryFromEnvironmentV1(aliasedTarget),
                /parent directory/
            );
            assert.equal(existsSync(path.join(actualParent, 'clients.json')), false);
        } finally {
            if (previous === undefined) delete process.env.GIS_MCP_TOKEN_REGISTRY_JSON;
            else process.env.GIS_MCP_TOKEN_REGISTRY_JSON = previous;
        }
    });

    it('revoke는 client를 제거하지만 마지막 client 제거는 거부한다', async () => {
        const root = privateRoot();
        const filePath = path.join(root, 'clients.json');
        writeRegistry(filePath, [
            { clientId: 'client-one', tokenSha256: digest('one') },
            { clientId: 'client-two', tokenSha256: digest('two') },
        ]);

        assert.deepEqual(await revokeGisMcpRegistryClientV1(
            filePath,
            'client-one'
        ), {
            action: 'revoke',
            clientId: 'client-one',
            clientCount: 1,
        });
        assert.deepEqual(readRegistry(filePath).clients.map(({ clientId }) => clientId), [
            'client-two',
        ]);
        await assert.rejects(
            revokeGisMcpRegistryClientV1(filePath, 'client-two'),
            /마지막 client/
        );
        assert.equal(readRegistry(filePath).clients.length, 1);
    });
});
