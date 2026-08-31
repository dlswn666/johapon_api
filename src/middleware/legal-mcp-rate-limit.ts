import type { NextFunction, Request, Response } from 'express';
import { FixedWindowRateLimiter } from '../security/fixed-window-rate-limiter';
import { LEGAL_RESEARCH_TOOL_NAME } from '../services/legal-research/mcp-policy';

export const LEGAL_MCP_RESEARCH_REQUESTS_PER_MINUTE = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLegalResearchCall(request: Request): boolean {
    if (!isRecord(request.body) || request.body.method !== 'tools/call') return false;
    const params = request.body.params;
    return isRecord(params) && params.name === LEGAL_RESEARCH_TOOL_NAME;
}

/** 공식 법령 API를 호출하는 고비용 research 도구만 bearer 세대별로 제한한다. */
export function createLegalMcpResearchRateLimitMiddleware(
    requestsPerMinute = LEGAL_MCP_RESEARCH_REQUESTS_PER_MINUTE
) {
    if (!Number.isSafeInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 100) {
        throw new Error('법률 MCP research 분당 제한은 1 이상 100 이하 정수여야 합니다.');
    }
    const limiter = new FixedWindowRateLimiter(requestsPerMinute, 60_000);

    return (request: Request, response: Response, next: NextFunction): void => {
        if (!isLegalResearchCall(request)) {
            next();
            return;
        }

        const tokenId = request.auth?.extra?.tokenId;
        if (typeof tokenId !== 'string' || !/^[0-9a-f]{64}$/i.test(tokenId)) {
            response.status(401).json({
                jsonrpc: '2.0',
                id: isRecord(request.body) ? request.body.id ?? null : null,
                error: { code: -32001, message: 'Authenticated MCP principal is required.' },
            });
            return;
        }

        const decision = limiter.consume(tokenId);
        response.setHeader('X-RateLimit-Remaining', String(decision.remaining));
        if (!decision.allowed) {
            response.setHeader('Retry-After', String(decision.retryAfterSeconds));
            response.status(429).json({
                jsonrpc: '2.0',
                id: isRecord(request.body) ? request.body.id ?? null : null,
                error: {
                    code: -32029,
                    message: 'Legal research request rate limit exceeded.',
                },
            });
            return;
        }
        next();
    };
}
