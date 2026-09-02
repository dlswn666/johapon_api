import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import {
    createGisMcpRoute,
    type GisMcpRouteHandle,
} from '../src/routes/gis-mcp';
import { PUBLIC_DATA_MCP_TOOL_NAMES } from '../src/services/public-data-mcp/policy';
import type { PublicDataMcpCallContext } from '../src/services/public-data-mcp/server';

const RAW_TOKEN = 'gis-mcp-route-contract-client-token';
const RAW_PROXY_TOKEN = 'gis-mcp-route-contract-proxy-token-32-bytes';
const sha256 = (value: string) => createHash('sha256')
    .update(value, 'utf8')
    .digest('hex');

function listen(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

describe('GIS MCP Streamable HTTP 공개 계약', () => {
    let route: GisMcpRouteHandle;
    let server: Server;
    let endpoint: string;
    let calls = 0;
    let lastContext: PublicDataMcpCallContext | undefined;

    before(async () => {
        const app = express();
        route = createGisMcpRoute({
            dependencies: {
                now: () => Date.parse('2026-09-03T00:00:00.000Z'),
                async execute(tool, input, context) {
                    calls += 1;
                    lastContext = context;
                    return {
                        contractVersion: 'TonghariPublicGisResultV1',
                        tool,
                        status: 'SUCCESS',
                        provider: 'contract-test',
                        source: 'https://example.test/public-data',
                        asOf: '2026-09-03T00:00:00.000Z',
                        attribution: '공개 자료 출처',
                        query: input as Record<string, unknown>,
                        data: { pnu: '1130510100100010000' },
                        warnings: [],
                    };
                },
            },
            allowedHosts: ['127.0.0.1'],
            allowedOrigins: [],
            tokenSha256: sha256(RAW_TOKEN),
            proxyTokenSha256: sha256(RAW_PROXY_TOKEN),
        });
        app.use('/gis-mcp', route.router);
        server = createServer(app);
        await listen(server);
        const address = server.address() as AddressInfo;
        endpoint = `http://127.0.0.1:${address.port}/gis-mcp`;
    });

    after(async () => {
        await route.close();
        await closeServer(server);
    });

    async function request(method: string, params: Record<string, unknown> = {}) {
        const headers: Record<string, string> = {
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${RAW_TOKEN}`,
            'content-type': 'application/json',
            'mcp-method': method,
            'mcp-protocol-version': '2026-07-28',
            'x-forwarded-proto': 'https',
            'x-tonghari-gis-mcp-proxy-token': RAW_PROXY_TOKEN,
        };
        if (typeof params.name === 'string') {
            headers['mcp-name'] = params.name;
        }
        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method,
                params: {
                    ...params,
                    _meta: {
                        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                        'io.modelcontextprotocol/clientInfo': {
                            name: 'tonghari-gis-contract-test',
                            version: '1.0.0',
                        },
                        'io.modelcontextprotocol/clientCapabilities': {},
                    },
                },
            }),
        });
        return {
            response,
            body: await response.json() as Record<string, any>,
        };
    }

    it('tools/list와 tools/call이 5개 read-only surface와 gis:read principal을 유지한다', async () => {
        const listed = await request('tools/list');
        assert.equal(listed.response.status, 200);
        assert.equal(listed.response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(
            listed.body.result.tools.map((tool: { name: string }) => tool.name),
            [...PUBLIC_DATA_MCP_TOOL_NAMES]
        );

        const called = await request('tools/call', {
            name: 'resolve_address_to_pnu_v1',
            arguments: { address: '서울특별시 강북구 미아동 1' },
        });
        assert.equal(called.response.status, 200);
        assert.equal(called.body.result.structuredContent.status, 'SUCCESS');
        assert.equal(calls, 1);
        assert.equal(lastContext?.principal.clientId, 'tonghari-gis-mcp');
        assert.deepEqual(lastContext?.principal.scopes, ['gis:read']);
    });
});
