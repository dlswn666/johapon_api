import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
    GIS_MCP_TOKEN_REGISTRY_FILE_MAX_BYTES,
    GisMcpTokenRegistryFileError,
    createGisMcpTokenRegistryFileProviderV1,
    readGisMcpTokenRegistryFileV1,
} from '../src/middleware/gis-mcp-token-registry-file';
import {
    getGisMcpConfigurationStateV1,
    getGisMcpRuntimeConfigurationStateV1,
    type GisMcpConfigurationInputV1,
} from '../src/services/public-data-mcp/mcp-config';

const roots: string[] = [];

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function registryJson(clientId = 'test-client', rawToken = 'test-token'): string {
    return JSON.stringify({
        version: 1,
        clients: [{ clientId, tokenSha256: sha256(rawToken) }],
    });
}

function gisConfigurationInput(
    overrides: Partial<GisMcpConfigurationInputV1> = {}
): GisMcpConfigurationInputV1 {
    return {
        vworldApiKey: 'vworld-operation-key',
        vworldApiDomain: 'www.tonghari.kr',
        dataPortalApiKey: 'data-portal-operation-key',
        tokenSha256: '',
        tokenRegistryJson: '',
        proxyTokenSha256: 'c'.repeat(64),
        allowedHosts: 'api.tonghari.kr',
        allowedOrigins: '',
        requestsPerMinute: 20,
        globalRequestsPerMinute: 40,
        requestDeadlineMs: 45_000,
        maxConcurrency: 2,
        maxQueue: 4,
        ...overrides,
    };
}

function createPrivateRegistry(body = registryJson()): {
    root: string;
    filePath: string;
} {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'gis-mcp-registry-')));
    roots.push(root);
    chmodSync(root, 0o700);
    const filePath = path.join(root, 'clients.json');
    writeFileSync(filePath, body, { encoding: 'utf8', mode: 0o600 });
    chmodSync(filePath, 0o600);
    return { root, filePath };
}

function replaceRegistryAtomically(filePath: string, body: string): void {
    const temporaryPath = path.join(path.dirname(filePath), 'clients.next.json');
    writeFileSync(temporaryPath, body, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, filePath);
}

after(() => {
    for (const root of roots) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('GIS MCP 보호 파일 registry', () => {
    it('canonical absolute path의 0700 parent와 0400/0600 regular file만 읽는다', () => {
        const { filePath } = createPrivateRegistry();

        const parsed = readGisMcpTokenRegistryFileV1(filePath);
        assert.equal(parsed.version, 1);
        assert.equal(parsed.clients[0]?.clientId, 'test-client');

        chmodSync(filePath, 0o400);
        assert.equal(
            readGisMcpTokenRegistryFileV1(filePath).clients.length,
            1
        );
    });

    it('relative/non-canonical path, 약한 parent/file mode, symlink를 거부한다', () => {
        const relative = createPrivateRegistry();
        assert.throws(
            () => readGisMcpTokenRegistryFileV1('clients.json'),
            GisMcpTokenRegistryFileError
        );
        assert.throws(
            () => readGisMcpTokenRegistryFileV1(
                path.join(relative.root, '.', 'clients.json').replace(
                    `${path.sep}clients.json`,
                    `${path.sep}.${path.sep}clients.json`
                )
            ),
            GisMcpTokenRegistryFileError
        );

        const weakParent = createPrivateRegistry();
        chmodSync(weakParent.root, 0o755);
        assert.throws(
            () => readGisMcpTokenRegistryFileV1(weakParent.filePath),
            GisMcpTokenRegistryFileError
        );

        const weakFile = createPrivateRegistry();
        chmodSync(weakFile.filePath, 0o644);
        assert.throws(
            () => readGisMcpTokenRegistryFileV1(weakFile.filePath),
            GisMcpTokenRegistryFileError
        );

        const symlink = createPrivateRegistry();
        const symlinkPath = path.join(symlink.root, 'linked.json');
        symlinkSync(symlink.filePath, symlinkPath);
        assert.throws(
            () => readGisMcpTokenRegistryFileV1(symlinkPath),
            GisMcpTokenRegistryFileError
        );
    });

    it('missing path와 directory target을 regular registry로 취급하지 않는다', () => {
        const missing = createPrivateRegistry();
        assert.throws(
            () => readGisMcpTokenRegistryFileV1(
                path.join(missing.root, 'missing.json')
            ),
            GisMcpTokenRegistryFileError
        );

        const directory = createPrivateRegistry();
        const directoryPath = path.join(directory.root, 'registry-directory');
        mkdirSync(directoryPath, { mode: 0o700 });
        assert.throws(
            () => readGisMcpTokenRegistryFileV1(directoryPath),
            GisMcpTokenRegistryFileError
        );
    });

    it('file mode 000과 0640을 모두 거부한다', () => {
        for (const mode of [0o000, 0o640]) {
            const candidate = createPrivateRegistry();
            chmodSync(candidate.filePath, mode);
            assert.throws(
                () => readGisMcpTokenRegistryFileV1(candidate.filePath),
                GisMcpTokenRegistryFileError
            );
        }
    });

    it('immediate parent와 그 상위 ancestor의 symlink 경로를 거부한다', () => {
        const immediate = createPrivateRegistry();
        const realParent = path.join(immediate.root, 'real-parent');
        mkdirSync(realParent, { mode: 0o700 });
        const immediateFile = path.join(realParent, 'clients.json');
        writeFileSync(immediateFile, registryJson(), { mode: 0o600 });
        const linkedParent = path.join(immediate.root, 'linked-parent');
        symlinkSync(realParent, linkedParent);
        assert.throws(
            () => readGisMcpTokenRegistryFileV1(
                path.join(linkedParent, 'clients.json')
            ),
            GisMcpTokenRegistryFileError
        );

        const ancestor = createPrivateRegistry();
        const realAncestor = path.join(ancestor.root, 'real-ancestor');
        const privateParent = path.join(realAncestor, 'private-parent');
        mkdirSync(realAncestor, { mode: 0o700 });
        mkdirSync(privateParent, { mode: 0o700 });
        writeFileSync(path.join(privateParent, 'clients.json'), registryJson(), {
            mode: 0o600,
        });
        const linkedAncestor = path.join(ancestor.root, 'linked-ancestor');
        symlinkSync(realAncestor, linkedAncestor);
        assert.throws(
            () => readGisMcpTokenRegistryFileV1(
                path.join(linkedAncestor, 'private-parent', 'clients.json')
            ),
            GisMcpTokenRegistryFileError
        );
    });

    it('지원 플랫폼에서는 FIFO를 non-regular target으로 즉시 거부한다', (context) => {
        if (process.platform === 'win32') {
            context.skip('Windows에는 mkfifo가 없다.');
            return;
        }
        const candidate = createPrivateRegistry();
        const fifoPath = path.join(candidate.root, 'registry.fifo');
        const created = spawnSync('mkfifo', [fifoPath], {
            encoding: 'utf8',
        });
        if (created.status !== 0) {
            context.skip('실행 환경에서 mkfifo를 사용할 수 없다.');
            return;
        }
        chmodSync(fifoPath, 0o600);

        assert.throws(
            () => readGisMcpTokenRegistryFileV1(fifoPath),
            GisMcpTokenRegistryFileError
        );
    });

    it('1..16KiB byte 제한과 strict registry schema를 fail-closed 한다', () => {
        const empty = createPrivateRegistry('');
        assert.throws(
            () => readGisMcpTokenRegistryFileV1(empty.filePath),
            GisMcpTokenRegistryFileError
        );

        const oversized = createPrivateRegistry(
            'x'.repeat(GIS_MCP_TOKEN_REGISTRY_FILE_MAX_BYTES + 1)
        );
        assert.throws(
            () => readGisMcpTokenRegistryFileV1(oversized.filePath),
            GisMcpTokenRegistryFileError
        );

        const extraKey = createPrivateRegistry(JSON.stringify({
            version: 1,
            clients: [{ clientId: 'test-client', tokenSha256: 'a'.repeat(64) }],
            unexpected: true,
        }));
        assert.throws(
            () => readGisMcpTokenRegistryFileV1(extraKey.filePath),
            GisMcpTokenRegistryFileError
        );
    });

    it('오류 문자열에 registry path, JSON 원문 또는 digest를 포함하지 않는다', () => {
        const digest = sha256('must-never-leak');
        const body = JSON.stringify({
            version: 1,
            clients: [{
                clientId: 'INVALID_CLIENT',
                tokenSha256: digest,
            }],
        });
        const candidate = createPrivateRegistry(body);

        assert.throws(
            () => readGisMcpTokenRegistryFileV1(candidate.filePath),
            (error: unknown) => {
                const rendered = String(error);
                assert.equal(rendered.includes(candidate.filePath), false);
                assert.equal(rendered.includes(body), false);
                assert.equal(rendered.includes(digest), false);
                assert.equal(rendered.includes('INVALID_CLIENT'), false);
                return error instanceof GisMcpTokenRegistryFileError;
            }
        );
    });

    it('startup 설정 검증과 health용 source/count가 path나 clientId 없이 계산된다', () => {
        const { filePath } = createPrivateRegistry();
        const state = getGisMcpConfigurationStateV1(gisConfigurationInput({
            tokenRegistryFile: filePath,
        }));

        assert.deepEqual(state, {
            configured: true,
            missing: [],
            invalid: [],
            authMode: 'client_registry',
            authSource: 'file_registry',
            registeredClientCount: 1,
            registeredTokenCount: 1,
            providerMode: 'vworld_and_data_portal',
        });
        assert.equal(JSON.stringify(state).includes(filePath), false);
        assert.equal(JSON.stringify(state).includes('test-client'), false);

        const replacement = path.join(path.dirname(filePath), 'clients.next.json');
        writeFileSync(replacement, '{', { encoding: 'utf8', mode: 0o600 });
        chmodSync(replacement, 0o600);
        renameSync(replacement, filePath);
        const runtimeState = getGisMcpConfigurationStateV1(gisConfigurationInput({
            tokenRegistryFile: filePath,
        }));
        assert.equal(runtimeState.configured, false);
        assert.equal(runtimeState.authMode, 'disabled');
        assert.equal(runtimeState.authSource, 'file_registry');
        assert.equal(runtimeState.registeredClientCount, 0);
    });

    it('FILE/JSON/legacy 중 둘 이상이면 startup에서 비활성화한다', () => {
        const { filePath } = createPrivateRegistry();
        const base = gisConfigurationInput({
            tokenRegistryFile: filePath,
        });

        for (const conflicting of [
            { ...base, tokenSha256: 'a'.repeat(64) },
            { ...base, tokenRegistryJson: registryJson('json-client') },
        ]) {
            const state = getGisMcpConfigurationStateV1(conflicting);
            assert.equal(state.configured, false);
            assert.deepEqual(state.invalid, ['tokenAuthentication']);
            assert.equal(state.authSource, 'disabled');
        }
    });

    it('unchanged fingerprint는 async metadata만 검사하고 parsed snapshot을 재사용한다', async () => {
        const { filePath } = createPrivateRegistry();
        let inspections = 0;
        let reloads = 0;
        const provider = createGisMcpTokenRegistryFileProviderV1(filePath, {
            onRuntimeInspection: () => { inspections += 1; },
            onRuntimeReload: () => { reloads += 1; },
        });

        const first = await provider.readRegistryV1();
        const second = await provider.readRegistryV1();

        assert.strictEqual(first, second);
        assert.equal(first.clients[0]?.clientId, 'test-client');
        assert.equal(inspections, 2);
        assert.equal(reloads, 0);
    });

    it('동시 unchanged 요청도 각각 독립 fingerprint를 검사하고 본문은 재사용한다', async () => {
        const { filePath } = createPrivateRegistry();
        let inspections = 0;
        let reloads = 0;
        const provider = createGisMcpTokenRegistryFileProviderV1(filePath, {
            onRuntimeInspection: () => { inspections += 1; },
            onRuntimeReload: () => { reloads += 1; },
        });

        const results = await Promise.all(
            Array.from({ length: 24 }, () => provider.readRegistryV1())
        );

        assert.equal(inspections, 24);
        assert.equal(reloads, 0);
        assert.equal(
            results.every((registry) =>
                registry.clients[0]?.clientId === 'test-client'
            ),
            true
        );
    });

    it('동시 요청의 changed snapshot reload를 직렬화해 본문을 한 번만 읽는다', async () => {
        const { filePath } = createPrivateRegistry();
        let reloads = 0;
        const provider = createGisMcpTokenRegistryFileProviderV1(filePath, {
            onRuntimeReload: () => { reloads += 1; },
        });
        replaceRegistryAtomically(
            filePath,
            registryJson('rotated-client', 'rotated-token')
        );

        const results = await Promise.all(
            Array.from({ length: 12 }, () => provider.readRegistryV1())
        );

        assert.equal(reloads, 1);
        assert.equal(
            results.every((registry) =>
                registry.clients[0]?.clientId === 'rotated-client'
            ),
            true
        );
    });

    it('runtime invalid에서는 stale snapshot을 반환하지 않고 복구 다음 요청에 반영한다', async () => {
        const { filePath } = createPrivateRegistry();
        const provider = createGisMcpTokenRegistryFileProviderV1(filePath);
        assert.equal(
            (await provider.readRegistryV1()).clients[0]?.clientId,
            'test-client'
        );

        replaceRegistryAtomically(filePath, '{');
        await assert.rejects(
            provider.readRegistryV1(),
            GisMcpTokenRegistryFileError
        );

        replaceRegistryAtomically(
            filePath,
            registryJson('recovered-client', 'recovered-token')
        );
        assert.equal(
            (await provider.readRegistryV1()).clients[0]?.clientId,
            'recovered-client'
        );
    });

    it('stable malformed fingerprint는 본문을 한 번만 읽고 동시·후속 요청을 모두 거부한다', async () => {
        const { filePath } = createPrivateRegistry();
        let reloads = 0;
        const provider = createGisMcpTokenRegistryFileProviderV1(filePath, {
            onRuntimeReload: () => { reloads += 1; },
        });
        replaceRegistryAtomically(filePath, '{');

        const concurrent = await Promise.allSettled(
            Array.from({ length: 20 }, () => provider.readRegistryV1())
        );
        assert.equal(
            concurrent.every((result) =>
                result.status === 'rejected'
                && result.reason instanceof GisMcpTokenRegistryFileError
            ),
            true
        );
        assert.equal(reloads, 1);

        await assert.rejects(
            provider.readRegistryV1(),
            GisMcpTokenRegistryFileError
        );
        await assert.rejects(
            provider.readRegistryV1(),
            GisMcpTokenRegistryFileError
        );
        assert.equal(reloads, 1);

        replaceRegistryAtomically(
            filePath,
            registryJson('malformed-recovered', 'malformed-recovered-token')
        );
        assert.equal(
            (await provider.readRegistryV1()).clients[0]?.clientId,
            'malformed-recovered'
        );
        assert.equal(reloads, 2);
    });

    it('runtime health 검사는 auth provider를 공유하고 invalid/fail-recover를 반영한다', async () => {
        const { filePath } = createPrivateRegistry();
        const provider = createGisMcpTokenRegistryFileProviderV1(filePath);
        const input = gisConfigurationInput({
            tokenRegistryFile: filePath,
        });

        assert.equal(
            (await getGisMcpRuntimeConfigurationStateV1(input, provider))
                .configured,
            true
        );
        replaceRegistryAtomically(filePath, '{');
        const invalid = await getGisMcpRuntimeConfigurationStateV1(
            input,
            provider
        );
        assert.equal(invalid.configured, false);
        assert.equal(invalid.authMode, 'disabled');
        assert.equal(invalid.authSource, 'file_registry');
        assert.equal(invalid.registeredClientCount, 0);

        replaceRegistryAtomically(
            filePath,
            registryJson('health-recovered', 'health-recovered-token')
        );
        const recovered = await getGisMcpRuntimeConfigurationStateV1(
            input,
            provider
        );
        assert.equal(recovered.configured, true);
        assert.equal(recovered.registeredClientCount, 1);
    });

    it('startup invalid로 /gis-mcp가 미mount된 경우 파일만 복구해도 health를 true로 바꾸지 않는다', async () => {
        const { filePath } = createPrivateRegistry('{');
        const input = gisConfigurationInput({
            tokenRegistryFile: filePath,
        });
        const startup = getGisMcpConfigurationStateV1(input);
        assert.equal(startup.configured, false);
        replaceRegistryAtomically(filePath, registryJson('late-recovery'));

        const health = await getGisMcpRuntimeConfigurationStateV1(
            input,
            undefined,
            startup
        );
        assert.strictEqual(health, startup);
        assert.equal(health.configured, false);
        assert.equal(health.authSource, 'file_registry');
    });
});
