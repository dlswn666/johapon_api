import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import {
    createLegalMcpResearchRateLimitMiddleware,
    type LegalMcpResearchRateLimitOptions,
} from '../src/middleware/legal-mcp-rate-limit';
import { LEGAL_RESEARCH_TOOL_NAME } from '../src/services/legal-research/mcp-policy';

interface InvocationResult {
    headers: Map<string, string>;
    nextCalled: boolean;
    responseBody?: unknown;
    statusCode?: number;
}

function invoke(
    middleware: ReturnType<typeof createLegalMcpResearchRateLimitMiddleware>,
    options: {
        tokenId?: string;
        method?: string;
        toolName?: string;
        id?: string;
    } = {}
): InvocationResult {
    const result: InvocationResult = {
        headers: new Map<string, string>(),
        nextCalled: false,
    };
    const request = {
        auth: options.tokenId === undefined
            ? undefined
            : { extra: { tokenId: options.tokenId } },
        body: {
            jsonrpc: '2.0',
            id: options.id ?? 'request-1',
            method: options.method ?? 'tools/call',
            params: {
                name: options.toolName ?? LEGAL_RESEARCH_TOOL_NAME,
            },
        },
    } as unknown as Request;
    const response = {
        setHeader(name: string, value: string | number | readonly string[]) {
            result.headers.set(name.toLowerCase(), String(value));
            return this;
        },
        status(statusCode: number) {
            result.statusCode = statusCode;
            return this;
        },
        json(body: unknown) {
            result.responseBody = body;
            return this;
        },
    } as unknown as Response;
    const next = (() => {
        result.nextCalled = true;
    }) as NextFunction;

    middleware(request, response, next);
    return result;
}

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const TOKEN_C = 'c'.repeat(64);

describe('법률 MCP research 호출 제한', () => {
    it('기본값은 bearer별 6회이고 한 bearer의 초과 호출은 다른 bearer bucket을 소모하지 않는다', () => {
        const middleware = createLegalMcpResearchRateLimitMiddleware();

        for (let index = 0; index < 6; index += 1) {
            const result = invoke(middleware, { tokenId: TOKEN_A });
            assert.equal(result.nextCalled, true);
            assert.equal(result.statusCode, undefined);
        }

        const rejectedA = invoke(middleware, { tokenId: TOKEN_A, id: 'a-7' });
        assert.equal(rejectedA.nextCalled, false);
        assert.equal(rejectedA.statusCode, 429);
        assert.equal(rejectedA.headers.get('x-ratelimit-remaining'), '0');
        assert.equal(rejectedA.headers.has('x-ratelimit-global-remaining'), false);
        assert.deepEqual(rejectedA.responseBody, {
            jsonrpc: '2.0',
            id: 'a-7',
            error: {
                code: -32029,
                message: 'Legal research bearer rate limit exceeded.',
            },
        });

        for (let index = 0; index < 6; index += 1) {
            const result = invoke(middleware, { tokenId: TOKEN_B });
            assert.equal(result.nextCalled, true);
        }
    });

    it('기본 global 12회 제한은 모든 bearer의 허용된 research 호출을 합산한다', () => {
        const middleware = createLegalMcpResearchRateLimitMiddleware();

        for (const tokenId of [TOKEN_A, TOKEN_B]) {
            for (let index = 0; index < 6; index += 1) {
                assert.equal(invoke(middleware, { tokenId }).nextCalled, true);
            }
        }

        const rejected = invoke(middleware, { tokenId: TOKEN_C, id: 'global-13' });
        assert.equal(rejected.nextCalled, false);
        assert.equal(rejected.statusCode, 429);
        assert.equal(rejected.headers.get('x-ratelimit-remaining'), '5');
        assert.equal(rejected.headers.get('x-ratelimit-global-remaining'), '0');
        assert.match(rejected.headers.get('retry-after') ?? '', /^\d+$/);
        assert.deepEqual(rejected.responseBody, {
            jsonrpc: '2.0',
            id: 'global-13',
            error: {
                code: -32029,
                message: 'Legal research process-wide rate limit exceeded.',
            },
        });
    });

    it('principal이 없거나 잘못되면 401이며 limiter를 소비하지 않는다', () => {
        const middleware = createLegalMcpResearchRateLimitMiddleware({
            perTokenRequestsPerMinute: 1,
            globalRequestsPerMinute: 2,
        });

        for (const tokenId of [undefined, 'not-a-token-id']) {
            const rejected = invoke(middleware, { tokenId, id: 'unauthorized' });
            assert.equal(rejected.nextCalled, false);
            assert.equal(rejected.statusCode, 401);
            assert.deepEqual(rejected.responseBody, {
                jsonrpc: '2.0',
                id: 'unauthorized',
                error: {
                    code: -32001,
                    message: 'Authenticated MCP principal is required.',
                },
            });
        }

        assert.equal(invoke(middleware, { tokenId: TOKEN_A }).nextCalled, true);
        assert.equal(invoke(middleware, { tokenId: TOKEN_B }).nextCalled, true);
    });

    it('research 이외의 MCP 호출은 bearer 유무와 관계없이 limiter를 소비하지 않는다', () => {
        const middleware = createLegalMcpResearchRateLimitMiddleware({
            perTokenRequestsPerMinute: 1,
            globalRequestsPerMinute: 1,
        });

        assert.equal(invoke(middleware, {
            method: 'initialize',
            tokenId: undefined,
        }).nextCalled, true);
        assert.equal(invoke(middleware, {
            tokenId: TOKEN_A,
            toolName: 'render_legal_answer_v1',
        }).nextCalled, true);

        assert.equal(invoke(middleware, { tokenId: TOKEN_A }).nextCalled, true);
        const globalRejected = invoke(middleware, { tokenId: TOKEN_B });
        assert.equal(globalRejected.statusCode, 429);
        assert.deepEqual(globalRejected.responseBody, {
            jsonrpc: '2.0',
            id: 'request-1',
            error: {
                code: -32029,
                message: 'Legal research process-wide rate limit exceeded.',
            },
        });
    });

    it('options의 두 제한값은 각각 1..1000 safe integer만 허용한다', () => {
        for (const invalidOptions of [null, 6, []]) {
            assert.throws(
                () => createLegalMcpResearchRateLimitMiddleware(
                    invalidOptions as unknown as LegalMcpResearchRateLimitOptions
                ),
                /options 객체/
            );
        }

        for (const key of [
            'perTokenRequestsPerMinute',
            'globalRequestsPerMinute',
        ] as const) {
            for (const invalid of [
                0,
                1_001,
                1.5,
                Number.NaN,
                Number.POSITIVE_INFINITY,
                Number.MAX_SAFE_INTEGER + 1,
            ]) {
                assert.throws(
                    () => createLegalMcpResearchRateLimitMiddleware({
                        [key]: invalid,
                    } as LegalMcpResearchRateLimitOptions),
                    /1 이상 1000 이하의 안전한 정수/
                );
            }
        }

        assert.doesNotThrow(() => createLegalMcpResearchRateLimitMiddleware({
            perTokenRequestsPerMinute: 1,
            globalRequestsPerMinute: 1_000,
        }));
    });
});
