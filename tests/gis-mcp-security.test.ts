import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    mkdtempSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
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
import { createGisMcpTokenRegistryFileProviderV1 } from '../src/middleware/gis-mcp-token-registry-file';

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

    it('보호 파일 atomic 교체를 다음 인증에서 읽고 구 bearer를 즉시 폐기한다', async () => {
        const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'gis-mcp-auth-')));
        chmodSync(root, 0o700);
        const filePath = path.join(root, 'clients.json');
        const firstToken = 'gis-file-client-first-token';
        const secondToken = 'gis-file-client-second-token';
        const writeRegistry = (token: string, target = filePath) => {
            writeFileSync(target, JSON.stringify({
                version: 1,
                clients: [{
                    clientId: 'gis-file-client',
                    tokenSha256: sha256(token),
                }],
            }), { encoding: 'utf8', mode: 0o600 });
            chmodSync(target, 0o600);
        };

        try {
            writeRegistry(firstToken);
            const provider = createGisMcpTokenRegistryFileProviderV1(filePath);
            const verifier = createGisMcpTokenVerifier({
                tokenRegistryFile: '',
                tokenRegistryFileProvider: provider,
            });
            assert.equal(
                (await verifier.verifyAccessToken(firstToken)).clientId,
                'gis-file-client'
            );

            const nextPath = path.join(root, 'clients.next.json');
            writeRegistry(secondToken, nextPath);
            renameSync(nextPath, filePath);

            assert.equal(
                (await verifier.verifyAccessToken(secondToken)).clientId,
                'gis-file-client'
            );
            await assert.rejects(verifier.verifyAccessToken(firstToken));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('교체 전 inspection이 멈춰 있어도 교체 뒤 요청은 새 세대로 인증한다', async () => {
        const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'gis-mcp-order-')));
        chmodSync(root, 0o700);
        const filePath = path.join(root, 'clients.json');
        const oldToken = 'gis-ordering-old-token';
        const newToken = 'gis-ordering-new-token';
        const writeAtomic = (clientId: string, token: string): void => {
            const temporaryPath = path.join(root, 'clients.next.json');
            writeFileSync(temporaryPath, JSON.stringify({
                version: 1,
                clients: [{ clientId, tokenSha256: sha256(token) }],
            }), { encoding: 'utf8', mode: 0o600 });
            chmodSync(temporaryPath, 0o600);
            renameSync(temporaryPath, filePath);
        };
        let announcePaused!: () => void;
        const paused = new Promise<void>((resolve) => {
            announcePaused = resolve;
        });
        let releaseInspection!: () => void;
        const inspectionReleased = new Promise<void>((resolve) => {
            releaseInspection = resolve;
        });
        let completedInspections = 0;
        let requestBeforeReplace: Promise<unknown> | null = null;

        try {
            writeAtomic('gis-ordering-old', oldToken);
            const provider = createGisMcpTokenRegistryFileProviderV1(filePath, {
                onRuntimeInspectionComplete: async () => {
                    completedInspections += 1;
                    if (completedInspections === 1) {
                        announcePaused();
                        await inspectionReleased;
                    }
                },
            });
            const verifier = createGisMcpTokenVerifier({
                tokenRegistryFile: '',
                tokenRegistryFileProvider: provider,
            });

            requestBeforeReplace = verifier.verifyAccessToken(oldToken);
            await paused;
            writeAtomic('gis-ordering-new', newToken);

            await assert.rejects(
                verifier.verifyAccessToken(oldToken),
                (error: unknown) => error instanceof OAuthError
                    && error.code === OAuthErrorCode.InvalidToken
            );
            assert.equal(
                (await verifier.verifyAccessToken(newToken)).clientId,
                'gis-ordering-new'
            );

            releaseInspection();
            await assert.rejects(
                requestBeforeReplace,
                (error: unknown) => error instanceof OAuthError
                    && error.code === OAuthErrorCode.InvalidToken
            );
        } finally {
            releaseInspection();
            await requestBeforeReplace?.catch(() => undefined);
            rmSync(root, { recursive: true, force: true });
        }
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
