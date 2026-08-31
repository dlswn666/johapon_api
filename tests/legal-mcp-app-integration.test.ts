import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getLegalMcpConfigurationStateV1 } from '../src/services/legal-research/mcp-config';

test('MCP 필수 설정 4개가 모두 있어야 활성화되고 Origin은 비브라우저 운영에서 비울 수 있다', () => {
    assert.deepEqual(
        getLegalMcpConfigurationStateV1({
            lawApiOc: 'registered-account',
            tokenSha256: 'a'.repeat(64),
            packetSigningKey: 'b'.repeat(64),
            allowedHosts: 'api.tonghari.kr',
        }),
        { configured: true, missing: [], invalid: [] }
    );

    const missing = getLegalMcpConfigurationStateV1({
        lawApiOc: '',
        tokenSha256: 'a'.repeat(64),
        packetSigningKey: '',
        allowedHosts: 'api.tonghari.kr',
    });
    assert.equal(missing.configured, false);
    assert.deepEqual(missing.missing, ['lawApiOc', 'packetSigningKey']);
    assert.deepEqual(missing.invalid, []);
});

test('MCP 설정값이 존재해도 digest, signing key, hostname 형식이 틀리면 활성화하지 않는다', () => {
    const invalid = getLegalMcpConfigurationStateV1({
        lawApiOc: 'x',
        tokenSha256: 'not-a-digest',
        packetSigningKey: 'weak',
        allowedHosts: '*',
    });

    assert.equal(invalid.configured, false);
    assert.deepEqual(invalid.missing, []);
    assert.deepEqual(invalid.invalid, [
        'lawApiOc',
        'tokenSha256',
        'packetSigningKey',
        'allowedHosts',
    ]);
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
});

test('health는 secret 원문 없이 MCP startup 설정 형식의 유효성만 두 응답에 노출한다', async () => {
    const source = await readFile('src/routes/health.ts', 'utf8');
    assert.match(source, /legalMcpConfigurationValid:/);
    assert.equal(
        (source.match(/\.\.\.legalMcpHealthFeatures\(\)/g) ?? []).length,
        2
    );
});
