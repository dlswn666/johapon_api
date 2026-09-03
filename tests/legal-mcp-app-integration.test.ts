import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getLegalMcpConfigurationStateV1 } from '../src/services/legal-research/mcp-config';

test('MCP 필수 설정과 단일 legacy 인증이 모두 있어야 활성화된다', () => {
    assert.deepEqual(
        getLegalMcpConfigurationStateV1({
            lawApiOc: 'registered-account',
            tokenSha256: 'a'.repeat(64),
            tokenRegistryJson: '',
            proxyTokenSha256: 'c'.repeat(64),
            packetSigningKey: 'b'.repeat(64),
            allowedHosts: 'api.tonghari.kr',
        }),
        {
            configured: true,
            missing: [],
            invalid: [],
            authMode: 'legacy_single',
            authSource: 'legacy_single',
            registeredClientCount: 1,
            registeredTokenCount: 1,
        }
    );

    const missing = getLegalMcpConfigurationStateV1({
        lawApiOc: '',
        tokenSha256: 'a'.repeat(64),
        tokenRegistryJson: '',
        proxyTokenSha256: 'c'.repeat(64),
        packetSigningKey: '',
        allowedHosts: 'api.tonghari.kr',
    });
    assert.equal(missing.configured, false);
    assert.deepEqual(missing.missing, ['lawApiOc', 'packetSigningKey']);
    assert.deepEqual(missing.invalid, []);
});

test('MCP 설정값이 존재해도 인증, proxy digest, signing key, hostname 형식이 틀리면 활성화하지 않는다', () => {
    const invalid = getLegalMcpConfigurationStateV1({
        lawApiOc: 'x',
        tokenSha256: 'not-a-digest',
        tokenRegistryJson: '',
        proxyTokenSha256: 'weak-proxy-digest',
        packetSigningKey: 'weak',
        allowedHosts: '*',
    });

    assert.equal(invalid.configured, false);
    assert.deepEqual(invalid.missing, []);
    assert.deepEqual(invalid.invalid, [
        'lawApiOc',
        'proxyTokenSha256',
        'packetSigningKey',
        'allowedHosts',
        'tokenAuthentication',
    ]);
    assert.equal(invalid.authMode, 'disabled');
    assert.equal(invalid.authSource, 'legacy_single');
    assert.equal(invalid.registeredClientCount, 0);
    assert.equal(invalid.registeredTokenCount, 0);
});

test('strict client registry를 세고 legacy와 동시에 설정하면 fail-closed 한다', () => {
    const registry = JSON.stringify({
        version: 1,
        clients: [
            { clientId: 'codex-mac', tokenSha256: 'a'.repeat(64) },
            { clientId: 'claude-server', tokenSha256: 'b'.repeat(64) },
        ],
    });
    const base = {
        lawApiOc: 'registered-account',
        tokenRegistryJson: registry,
        proxyTokenSha256: 'c'.repeat(64),
        packetSigningKey: 'd'.repeat(64),
        allowedHosts: 'api.tonghari.kr',
    };

    assert.deepEqual(getLegalMcpConfigurationStateV1({
        ...base,
        tokenSha256: '',
    }), {
        configured: true,
        missing: [],
        invalid: [],
        authMode: 'client_registry',
        authSource: 'json_registry',
        registeredClientCount: 2,
        registeredTokenCount: 2,
    });

    const conflict = getLegalMcpConfigurationStateV1({
        ...base,
        tokenSha256: 'e'.repeat(64),
    });
    assert.equal(conflict.configured, false);
    assert.deepEqual(conflict.missing, []);
    assert.deepEqual(conflict.invalid, ['tokenAuthentication']);
    assert.equal(conflict.authMode, 'disabled');
    assert.equal(conflict.authSource, 'disabled');
    assert.equal(conflict.registeredClientCount, 0);
});

test('MCP router는 전역 JSON parser보다 먼저 mount되고 미설정 상태는 503으로 닫힌다', async () => {
    const source = await readFile('src/index.ts', 'utf8');
    const mcpMount = source.indexOf("app.use('/mcp', legalMcp.router)");
    const globalJsonParser = source.indexOf("app.use(express.json({ limit: '1mb' }))");

    assert.notEqual(mcpMount, -1);
    assert.notEqual(globalJsonParser, -1);
    assert.equal(mcpMount < globalJsonParser, true);
    assert.match(source, /LEGAL_MCP_NOT_CONFIGURED/);
    assert.match(source, /closeServerAndMcpWithHardTimeoutV1/);
    assert.match(source, /SHUTDOWN_HARD_TIMEOUT_MS/);
    assert.match(source, /createLegalMcpTokenRegistryFileProviderV1/);
    assert.match(source, /tokenRegistryFileProvider: legalMcpTokenRegistryFileProvider/);
    assert.match(source, /setLegalMcpHealthTokenRegistryFileProviderV1/);
});

test('health는 secret 원문 없이 MCP startup 설정 형식의 유효성만 두 응답에 노출한다', async () => {
    const source = await readFile('src/routes/health.ts', 'utf8');
    assert.match(source, /legalMcpConfigurationValid:/);
    assert.match(source, /legalMcpAuthMode:/);
    assert.match(source, /legalMcpAuthSource:/);
    assert.match(source, /legalMcpRegisteredClientCount:/);
    assert.match(source, /legalMcpRegisteredTokenCount:/);
    assert.match(source, /await getLegalMcpRuntimeConfigurationStateV1/);
    assert.match(source, /await legalMcpHealthFeatures\(\)/);
    assert.equal(
        (source.match(/\.\.\.(?:await )?legalMcpHealthFeatures\(\)/g) ?? []).length,
        2
    );
});

test('운영 runbook의 registry 갱신과 lock 복구는 검증된 global lock 안에서 fail-fast 한다', async () => {
    const source = await readFile(
        'docs/2026-08-31-current-law-legal-mcp-runbook.md',
        'utf8'
    );
    assert.equal(
        (source.match(/\(\n  set -E?euo pipefail\n  cd \/home\/ubuntu\/alimtalk-proxy/g) ?? []).length,
        3
    );
    assert.equal(
        (source.match(/exec 9>>"\$\{production_lock_path\}"/g) ?? []).length,
        3
    );
    assert.equal(
        (source.match(/stat -c %a "\$\{production_lock_path\}"/g) ?? []).length,
        3
    );
    assert.doesNotMatch(source, /\) 9>>\.tonghari-api-production\.lock/);
    assert.match(
        source,
        /if docker container inspect tonghari-legal-mcp-registry-updater[\s\S]+exit 1[\s\S]+\.clients\.json\.\*\.tmp[\s\S]+fs\.fsyncSync\(descriptor\)/
    );
});
