import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import {
    createGisMcpTokenVerifier,
    GisMcpAuthConfigurationError,
} from '../src/middleware/gis-mcp-auth';
import {
    GIS_MCP_PROXY_FORBIDDEN_BODY,
    GIS_MCP_PROXY_TOKEN_HEADER,
    createGisMcpProxyGuardMiddleware,
} from '../src/middleware/gis-mcp-proxy-guard';
import { createGisMcpRateLimitMiddleware } from '../src/middleware/gis-mcp-rate-limit';
import {
    GisMcpTokenRegistryConfigurationError,
    parseGisMcpTokenRegistryJson,
} from '../src/middleware/gis-mcp-token-registry';
import { GIS_MCP_REQUIRED_SCOPE } from '../src/services/public-data-mcp/policy';

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('GIS MCP 보안 계약', () => {
    it('strict registry와 client별 gis:read principal을 사용한다', async () => {
        const firstToken = 'gis-client-a-secret-token';
        const secondToken = 'gis-client-b-secret-token';
        const registryJson = JSON.stringify({
            version: 1,
            clients: [
                { clientId: 'gis-client-a', tokenSha256: sha256(firstToken) },
                { clientId: 'gis-client-b', tokenSha256: sha256(secondToken) },
            ],
        });

        assert.equal(parseGisMcpTokenRegistryJson(registryJson).clients.length, 2);
        const verifier = createGisMcpTokenVerifier({
            tokenRegistryJson: registryJson,
            tokenSha256: '',
            now: () => 1_800_000_000_000,
        });
        const auth = await verifier.verifyAccessToken(secondToken);
        assert.equal(auth.clientId, 'gis-client-b');
        assert.deepEqual(auth.scopes, [GIS_MCP_REQUIRED_SCOPE]);
        assert.equal(auth.extra?.tokenId, sha256(secondToken));
    });

    it('registry unknown key/중복과 legacy 동시설정을 fail-closed 한다', () => {
        assert.throws(
            () => parseGisMcpTokenRegistryJson(JSON.stringify({
                version: 1,
                clients: [{
                    clientId: 'gis-client',
                    tokenSha256: 'a'.repeat(64),
                    rawToken: 'must-not-be-accepted',
                }],
            })),
            GisMcpTokenRegistryConfigurationError
        );
        assert.throws(
            () => createGisMcpTokenVerifier({
                tokenSha256: 'b'.repeat(64),
                tokenRegistryJson: JSON.stringify({
                    version: 1,
                    clients: [{
                        clientId: 'gis-client',
                        tokenSha256: 'c'.repeat(64),
                    }],
                }),
            }),
            GisMcpAuthConfigurationError
        );
    });

    it('proxy HTTPS 증명은 GIS 전용 header와 no-store를 요구한다', () => {
        const proxyToken = 'gis-mcp-proxy-token-with-at-least-32-bytes';
        const middleware = createGisMcpProxyGuardMiddleware({
            proxyTokenSha256: sha256(proxyToken),
        });

        const invoke = (headers: Record<string, string>) => {
            let statusCode = 200;
            let body: unknown;
            let nextCalled = false;
            const response = {
                set(name: string, value: string) {
                    assert.equal(name, 'Cache-Control');
                    assert.equal(value, 'no-store');
                    return this;
                },
                status(value: number) {
                    statusCode = value;
                    return this;
                },
                json(value: unknown) {
                    body = value;
                    return this;
                },
            } as unknown as Response;
            middleware(
                { headers } as unknown as Request,
                response,
                (() => { nextCalled = true; }) as NextFunction
            );
            return { statusCode, body, nextCalled };
        };

        assert.equal(invoke({
            'x-forwarded-proto': 'https',
            [GIS_MCP_PROXY_TOKEN_HEADER]: proxyToken,
        }).nextCalled, true);
        const rejected = invoke({
            'x-forwarded-proto': 'http',
            [GIS_MCP_PROXY_TOKEN_HEADER]: proxyToken,
        });
        assert.equal(rejected.statusCode, 403);
        assert.deepEqual(rejected.body, GIS_MCP_PROXY_FORBIDDEN_BODY);
    });

    it('upstream 도구만 bearer별·global bucket을 소비한다', () => {
        const middleware = createGisMcpRateLimitMiddleware({
            perTokenRequestsPerMinute: 1,
            globalRequestsPerMinute: 2,
        });
        const invoke = (tokenId: string, toolName: string) => {
            let statusCode = 200;
            let body: unknown;
            let nextCalled = false;
            const response = {
                setHeader() { return undefined; },
                status(value: number) {
                    statusCode = value;
                    return this;
                },
                json(value: unknown) {
                    body = value;
                    return this;
                },
            } as unknown as Response;
            middleware(
                {
                    body: {
                        jsonrpc: '2.0',
                        id: 'request-1',
                        method: 'tools/call',
                        params: { name: toolName },
                    },
                    auth: { extra: { tokenId } },
                } as unknown as Request,
                response,
                (() => { nextCalled = true; }) as NextFunction
            );
            return { statusCode, body, nextCalled };
        };

        const tokenA = 'a'.repeat(64);
        assert.equal(
            invoke(tokenA, 'resolve_address_to_pnu_v1').nextCalled,
            true
        );
        const rejected = invoke(tokenA, 'lookup_parcel_public_data_v1');
        assert.equal(rejected.statusCode, 429);
        assert.equal(rejected.nextCalled, false);
        assert.match(JSON.stringify(rejected.body), /GIS MCP bearer rate limit/);

        assert.equal(invoke(tokenA, 'tools/list').nextCalled, true);
    });
});
