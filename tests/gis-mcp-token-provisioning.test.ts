import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
    parseGisMcpSmokeEndpointV1,
    probeGisMcpBearerV1,
} from '../src/cli/gis-mcp-smoke';
import {
    provisionGisMcpClientTokenV1,
    provisionGisMcpProxyTokenV1,
} from '../src/services/public-data-mcp/token-provisioning';
import { PUBLIC_DATA_MCP_TOOL_NAMES } from '../src/services/public-data-mcp/server';

describe('GIS MCP token provisioning', () => {
    it('client와 proxy에 서로 다른 256-bit token prefix를 사용한다', () => {
        const client = provisionGisMcpClientTokenV1('codex-mac-202609', {
            randomBytesFactory: () => Buffer.alloc(32, 7),
        });
        const proxy = provisionGisMcpProxyTokenV1(() => Buffer.alloc(32, 9));
        assert.match(client.bearerToken, /^tgismcp_v1_/);
        assert.match(proxy.proxyToken, /^tgismcp_proxy_v1_/);
        assert.equal(
            client.tokenSha256,
            createHash('sha256').update(client.bearerToken).digest('hex')
        );
        assert.notEqual(client.tokenSha256, proxy.proxyTokenSha256);
    });

    it('smoke endpoint는 credential/query 없는 HTTPS만 허용한다', () => {
        assert.equal(
            parseGisMcpSmokeEndpointV1('https://api.tonghari.kr/gis-mcp').href,
            'https://api.tonghari.kr/gis-mcp'
        );
        assert.throws(() => parseGisMcpSmokeEndpointV1(
            'http://api.tonghari.kr/gis-mcp'
        ));
        assert.throws(() => parseGisMcpSmokeEndpointV1(
            'https://api.tonghari.kr/gis-mcp?token=x'
        ));
    });

    it('smoke는 bearer를 Authorization에만 넣고 정확한 도구 allowlist를 검사한다', async () => {
        const token = `tgismcp_v1_${'b'.repeat(43)}`;
        let captured: RequestInit | undefined;
        const status = await probeGisMcpBearerV1(
            'https://api.tonghari.kr/gis-mcp',
            token,
            (async (_input: string | URL | Request, init?: RequestInit) => {
                captured = init;
                return Response.json({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        tools: PUBLIC_DATA_MCP_TOOL_NAMES.map((name) => ({ name })),
                    },
                });
            }) as typeof fetch
        );

        assert.equal(status, 200);
        assert.equal(captured?.redirect, 'error');
        const headers = captured?.headers as Record<string, string>;
        assert.equal(headers.Authorization, `Bearer ${token}`);
        assert.equal(String(captured?.body).includes(token), false);
    });

    it('2025-06-18 smoke는 initialize, initialized, tools/list 순서와 SSE 응답을 검증한다', async () => {
        const token = `tgismcp_v1_${'c'.repeat(43)}`;
        const captured: RequestInit[] = [];
        const fetchImpl = (async (
            _input: string | URL | Request,
            init?: RequestInit
        ) => {
            captured.push(init ?? {});
            const body = JSON.parse(String(init?.body));
            if (body.method === 'initialize') {
                return new Response(
                    `data: ${JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        result: { protocolVersion: '2025-06-18' },
                    })}\n\n`,
                    { status: 200, headers: { 'content-type': 'text/event-stream' } }
                );
            }
            if (body.method === 'notifications/initialized') {
                return new Response(null, { status: 202 });
            }
            return new Response(
                `data: ${JSON.stringify({
                    jsonrpc: '2.0',
                    id: 2,
                    result: {
                        tools: PUBLIC_DATA_MCP_TOOL_NAMES.map((name) => ({ name })),
                    },
                })}\n\n`,
                { status: 200, headers: { 'content-type': 'text/event-stream' } }
            );
        }) as typeof fetch;

        const status = await probeGisMcpBearerV1(
            'https://api.tonghari.kr/gis-mcp',
            token,
            fetchImpl,
            '2025-06-18'
        );

        assert.equal(status, 200);
        assert.deepEqual(
            captured.map((init) => JSON.parse(String(init.body)).method),
            ['initialize', 'notifications/initialized', 'tools/list']
        );
        for (const init of captured) {
            const headers = init.headers as Record<string, string>;
            const body = JSON.parse(String(init.body));
            assert.equal(headers.Authorization, `Bearer ${token}`);
            assert.equal(headers['MCP-Protocol-Version'], '2025-06-18');
            assert.equal(headers['MCP-Method'], body.method);
            assert.equal(String(init.body).includes(token), false);
            assert.equal(body.params._meta, undefined);
        }
    });
});
