import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { mock } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import {
    LEGAL_MCP_FORWARDED_PROTO_HEADER,
    LEGAL_MCP_PROXY_FORBIDDEN_BODY,
    LEGAL_MCP_PROXY_TOKEN_HEADER,
    LEGAL_MCP_PROXY_TOKEN_MAX_BYTES,
    LegalMcpProxyGuardConfigurationError,
    createLegalMcpProxyGuardMiddleware,
} from '../src/middleware/legal-mcp-proxy-guard';

const VALID_PROXY_TOKEN = 'proxy-secret-'.repeat(4);

function sha256(value: string): string {
    const hash = createHash('sha256');
    hash.write(value, 'utf8');
    return hash.digest('hex');
}

function createResponse() {
    const state: {
        status: number;
        body?: unknown;
        headers: Record<string, string>;
    } = {
        status: 200,
        headers: {},
    };
    const response = {
        set(name: string, value: string) {
            state.headers[name.toLowerCase()] = value;
            return response;
        },
        status(value: number) {
            state.status = value;
            return response;
        },
        json(value: unknown) {
            state.body = value;
            return response;
        },
    };

    return { response: response as unknown as Response, state };
}

function run(headers: Request['headers']) {
    const middleware = createLegalMcpProxyGuardMiddleware({
        proxyTokenSha256: sha256(VALID_PROXY_TOKEN),
    });
    const { response, state } = createResponse();
    let nextCallCount = 0;

    middleware(
        { headers } as Request,
        response,
        (() => {
            nextCallCount += 1;
        }) as NextFunction
    );

    return { state, nextCallCount };
}

test('Caddy가 주입한 단일 proxy token과 정확한 https 증명이 모두 일치할 때만 통과한다', () => {
    const result = run({
        [LEGAL_MCP_FORWARDED_PROTO_HEADER]: 'https',
        [LEGAL_MCP_PROXY_TOKEN_HEADER]: VALID_PROXY_TOKEN,
    });

    assert.equal(result.nextCallCount, 1);
    assert.equal(result.state.status, 200);
    assert.equal(result.state.body, undefined);
    assert.equal(result.state.headers['cache-control'], 'no-store');
});

test('proto 또는 token이 모호하거나 틀리면 동일한 403 JSON으로 fail-closed한다', () => {
    const invalidHeaders: Request['headers'][] = [
        {},
        {
            [LEGAL_MCP_FORWARDED_PROTO_HEADER]: 'http',
            [LEGAL_MCP_PROXY_TOKEN_HEADER]: VALID_PROXY_TOKEN,
        },
        {
            [LEGAL_MCP_FORWARDED_PROTO_HEADER]: 'HTTPS',
            [LEGAL_MCP_PROXY_TOKEN_HEADER]: VALID_PROXY_TOKEN,
        },
        {
            [LEGAL_MCP_FORWARDED_PROTO_HEADER]: 'https, http',
            [LEGAL_MCP_PROXY_TOKEN_HEADER]: VALID_PROXY_TOKEN,
        },
        {
            [LEGAL_MCP_FORWARDED_PROTO_HEADER]: ['https'],
            [LEGAL_MCP_PROXY_TOKEN_HEADER]: VALID_PROXY_TOKEN,
        },
        {
            [LEGAL_MCP_FORWARDED_PROTO_HEADER]: 'https',
            [LEGAL_MCP_PROXY_TOKEN_HEADER]: 'wrong-proxy-token-'.repeat(3),
        },
        {
            [LEGAL_MCP_FORWARDED_PROTO_HEADER]: 'https',
            [LEGAL_MCP_PROXY_TOKEN_HEADER]: `${VALID_PROXY_TOKEN},${VALID_PROXY_TOKEN}`,
        },
        {
            [LEGAL_MCP_FORWARDED_PROTO_HEADER]: 'https',
            [LEGAL_MCP_PROXY_TOKEN_HEADER]: [VALID_PROXY_TOKEN],
        },
        {
            [LEGAL_MCP_FORWARDED_PROTO_HEADER]: 'https',
            [LEGAL_MCP_PROXY_TOKEN_HEADER]: 'short',
        },
        {
            [LEGAL_MCP_FORWARDED_PROTO_HEADER]: 'https',
            [LEGAL_MCP_PROXY_TOKEN_HEADER]: 'x'.repeat(
                LEGAL_MCP_PROXY_TOKEN_MAX_BYTES + 1
            ),
        },
    ];

    for (const headers of invalidHeaders) {
        const result = run(headers);
        assert.equal(result.nextCallCount, 0);
        assert.equal(result.state.status, 403);
        assert.deepEqual(result.state.body, LEGAL_MCP_PROXY_FORBIDDEN_BODY);
        assert.equal(result.state.headers['cache-control'], 'no-store');
    }
});

test('거부 응답과 로그에 raw token 또는 digest를 노출하지 않는다', (context) => {
    const attemptedToken = 'attempted-secret-'.repeat(3);
    const configuredDigest = sha256(VALID_PROXY_TOKEN);
    const captured: string[] = [];
    const spies = [
        mock.method(console, 'debug', (...args: unknown[]) => {
            captured.push(args.map(String).join(' '));
        }),
        mock.method(console, 'info', (...args: unknown[]) => {
            captured.push(args.map(String).join(' '));
        }),
        mock.method(console, 'warn', (...args: unknown[]) => {
            captured.push(args.map(String).join(' '));
        }),
        mock.method(console, 'error', (...args: unknown[]) => {
            captured.push(args.map(String).join(' '));
        }),
    ];
    context.after(() => {
        for (const spy of spies) spy.mock.restore();
    });

    const result = run({
        [LEGAL_MCP_FORWARDED_PROTO_HEADER]: 'https',
        [LEGAL_MCP_PROXY_TOKEN_HEADER]: attemptedToken,
    });
    const serializedBody = JSON.stringify(result.state.body);

    assert.equal(captured.length, 0);
    assert.equal(serializedBody.includes(attemptedToken), false);
    assert.equal(serializedBody.includes(VALID_PROXY_TOKEN), false);
    assert.equal(serializedBody.includes(configuredDigest), false);
});

test('누락되거나 잘못된 digest 설정은 값 자체를 노출하지 않고 시작 시 거부한다', () => {
    for (const proxyTokenSha256 of ['', 'too-short', 'g'.repeat(64)]) {
        assert.throws(
            () => createLegalMcpProxyGuardMiddleware({ proxyTokenSha256 }),
            (error: unknown) => {
                assert.equal(
                    error instanceof LegalMcpProxyGuardConfigurationError,
                    true
                );
                if (proxyTokenSha256.length > 0) {
                    assert.equal(
                        String(error).includes(proxyTokenSha256),
                        false
                    );
                }
                return true;
            }
        );
    }
});
