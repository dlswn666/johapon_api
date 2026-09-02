import assert from 'node:assert/strict';
import test from 'node:test';
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { PUBLIC_DATA_MCP_TOOL_NAMES } from '../src/services/public-data-mcp/policy';
import { createPublicDataMcpServer } from '../src/services/public-data-mcp/server';

type RegisteredServer = {
    _registeredTools: Record<string, {
        annotations: Record<string, unknown>;
        handler(input: unknown, context: ServerContext): Promise<CallToolResult>;
    }>;
    _registeredPrompts: Record<string, unknown>;
    _registeredResources: Record<string, unknown>;
};

function context(): ServerContext {
    return {
        http: {
            authInfo: {
                token: 'not-returned', clientId: 'server-test', scopes: ['gis:read'],
                extra: { tokenId: 'a'.repeat(64) },
            },
        },
        mcpReq: { signal: new AbortController().signal },
    } as ServerContext;
}

test('서버는 정확히 5개 read-only 도구, prompt 1개, resource 1개만 등록한다', () => {
    const server = createPublicDataMcpServer({ async execute() { return {}; } });
    const registered = server as unknown as RegisteredServer;
    assert.deepEqual(Object.keys(registered._registeredTools), [...PUBLIC_DATA_MCP_TOOL_NAMES]);
    assert.equal(Object.keys(registered._registeredPrompts).length, 1);
    assert.equal(Object.keys(registered._registeredResources).length, 1);
    for (const tool of Object.values(registered._registeredTools)) {
        assert.equal(tool.annotations.readOnlyHint, true);
        assert.equal(tool.annotations.destructiveHint, false);
    }
});

test('128KB 초과와 금지 필드는 structured JSON 안전 오류로 fail-closed한다', async () => {
    for (const data of [
        { records: ['x'.repeat(140 * 1024)] },
        { apiKey: 'key-canary', ownerName: 'owner-canary', stack: 'stack-canary' },
    ]) {
        const server = createPublicDataMcpServer({
            async execute(tool) {
                return {
                    contractVersion: 'TonghariPublicGisResultV1', tool,
                    status: 'SUCCESS', provider: 'VWorld', source: 'https://api.vworld.kr',
                    asOf: '2026-09-03T00:00:00.000Z', attribution: '출처', query: {}, data,
                    warnings: [],
                };
            },
        }) as unknown as RegisteredServer;
        const result = await server._registeredTools.resolve_address_to_pnu_v1.handler(
            { address: '서울특별시 강북구 미아동 1' },
            context()
        );
        assert.equal(result.isError, true);
        assert.ok(result.structuredContent);
        const text = JSON.stringify(result);
        assert.equal(text.includes('canary'), false);
        assert.match(text, /OUTPUT_TOO_LARGE|PROVIDER_RESPONSE_INVALID/);
    }
});
