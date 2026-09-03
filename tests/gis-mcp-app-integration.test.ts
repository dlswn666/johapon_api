import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getGisMcpConfigurationStateV1 } from '../src/services/public-data-mcp/mcp-config';

const base = {
    vworldApiKey: 'vworld-operation-key',
    vworldApiDomain: 'www.tonghari.kr',
    dataPortalApiKey: 'data-portal-operation-key',
    tokenSha256: '',
    tokenRegistryJson: JSON.stringify({
        version: 1,
        clients: [
            { clientId: 'codex-mac', tokenSha256: 'a'.repeat(64) },
            { clientId: 'claude-server', tokenSha256: 'b'.repeat(64) },
        ],
    }),
    proxyTokenSha256: 'c'.repeat(64),
    allowedHosts: 'api.tonghari.kr',
    allowedOrigins: '',
    requestsPerMinute: 20,
    globalRequestsPerMinute: 40,
    requestDeadlineMs: 45_000,
    maxConcurrency: 2,
    maxQueue: 4,
};

test('GIS MCP는 두 provider와 독립 registry가 모두 유효할 때만 활성화된다', () => {
    assert.deepEqual(getGisMcpConfigurationStateV1(base), {
        configured: true,
        missing: [],
        invalid: [],
        authMode: 'client_registry',
        authSource: 'json_registry',
        registeredClientCount: 2,
        registeredTokenCount: 2,
        providerMode: 'vworld_and_data_portal',
    });

    const missing = getGisMcpConfigurationStateV1({
        ...base,
        vworldApiKey: '',
        dataPortalApiKey: '',
    });
    assert.equal(missing.configured, false);
    assert.deepEqual(missing.missing, ['vworldApiKey', 'dataPortalApiKey']);
    assert.equal(missing.providerMode, 'disabled');
});

test('잘못된 Origin과 운영 상한은 전체 startup 대신 GIS MCP만 비활성화한다', () => {
    const state = getGisMcpConfigurationStateV1({
        ...base,
        allowedOrigins: 'https://browser.example',
        requestDeadlineMs: Number.NaN,
        maxConcurrency: 0,
        maxQueue: 101,
    });
    assert.equal(state.configured, false);
    assert.deepEqual(state.invalid, [
        'allowedOrigins',
        'requestDeadlineMs',
        'maxConcurrency',
        'maxQueue',
    ]);
});

test('GIS MCP router는 법률 MCP와 분리되고 전역 parser 전에 mount된다', async () => {
    const source = await readFile('src/index.ts', 'utf8');
    const gisMount = source.indexOf("app.use('/gis-mcp', gisMcp.router)");
    const legalMount = source.indexOf("app.use('/mcp', legalMcp.router)");
    const globalParser = source.indexOf("app.use(express.json({ limit: '1mb' }))");

    assert.notEqual(gisMount, -1);
    assert.notEqual(legalMount, -1);
    assert.notEqual(globalParser, -1);
    assert.equal(gisMount < globalParser, true);
    assert.equal(legalMount < globalParser, true);
    assert.match(source, /GIS_MCP_NOT_CONFIGURED/);
    assert.match(source, /Promise\.allSettled/);
    assert.match(source, /createGisMcpTokenRegistryFileProviderV1/);
    assert.match(source, /tokenRegistryFileProvider: gisMcpTokenRegistryFileProvider/);
    assert.match(source, /setGisMcpHealthTokenRegistryFileProviderV1/);
});
test('health는 secret 없이 GIS MCP 설정 형식만 두 응답에 노출한다', async () => {
    const source = await readFile('src/routes/health.ts', 'utf8');
    assert.match(source, /gisMcpConfigurationValid:/);
    assert.match(source, /gisMcpAuthMode:/);
    assert.match(source, /gisMcpAuthSource:/);
    assert.match(source, /gisMcpRegisteredClientCount:/);
    assert.match(source, /gisMcpRegisteredTokenCount:/);
    assert.match(source, /gisMcpProviderMode:/);
    assert.match(source, /await getGisMcpRuntimeConfigurationStateV1/);
    assert.match(source, /await gisMcpHealthFeatures\(\)/);
    assert.equal(
        (source.match(/\.\.\.(?:await )?gisMcpHealthFeatures\(\)/g) ?? []).length,
        2
    );
});
