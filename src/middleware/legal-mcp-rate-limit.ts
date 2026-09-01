import type { NextFunction, Request, Response } from 'express';
import { FixedWindowRateLimiter } from '../security/fixed-window-rate-limiter';
import { LEGAL_RESEARCH_TOOL_NAME } from '../services/legal-research/mcp-policy';

export const LEGAL_MCP_RESEARCH_REQUESTS_PER_MINUTE = 6;
export const LEGAL_MCP_GLOBAL_RESEARCH_REQUESTS_PER_MINUTE = 12;

export interface LegalMcpResearchRateLimitOptions {
    /** 인증된 bearer 하나가 1분 동안 실행할 수 있는 research 호출 수. */
    perTokenRequestsPerMinute?: number;
    /** 모든 bearer를 합산한 단일 프로세스의 1분 research 호출 수. */
    globalRequestsPerMinute?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLegalResearchCall(request: Request): boolean {
    if (!isRecord(request.body) || request.body.method !== 'tools/call') return false;
    const params = request.body.params;
    return isRecord(params) && params.name === LEGAL_RESEARCH_TOOL_NAME;
}

function validateRequestsPerMinute(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
        throw new Error(`${label}은 1 이상 1000 이하의 안전한 정수여야 합니다.`);
    }
}

function respondRateLimited(
    request: Request,
    response: Response,
    retryAfterSeconds: number,
    message: string,
): void {
    response.setHeader('Retry-After', String(retryAfterSeconds));
    response.status(429).json({
        jsonrpc: '2.0',
        id: isRecord(request.body) ? request.body.id ?? null : null,
        error: {
            code: -32029,
            message,
        },
    });
}

/** 공식 법령 API를 호출하는 고비용 research 도구만 bearer별·프로세스 합산으로 제한한다. */
export function createLegalMcpResearchRateLimitMiddleware(
    options: LegalMcpResearchRateLimitOptions = {}
) {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
        throw new Error('법률 MCP research 호출 제한은 options 객체로 설정해야 합니다.');
    }
    const perTokenRequestsPerMinute = options.perTokenRequestsPerMinute
        ?? LEGAL_MCP_RESEARCH_REQUESTS_PER_MINUTE;
    const globalRequestsPerMinute = options.globalRequestsPerMinute
        ?? LEGAL_MCP_GLOBAL_RESEARCH_REQUESTS_PER_MINUTE;
    validateRequestsPerMinute(
        perTokenRequestsPerMinute,
        '법률 MCP bearer별 research 분당 제한'
    );
    validateRequestsPerMinute(
        globalRequestsPerMinute,
        '법률 MCP 프로세스 전체 research 분당 제한'
    );

    const perTokenLimiter = new FixedWindowRateLimiter(
        perTokenRequestsPerMinute,
        60_000
    );
    const globalLimiter = new FixedWindowRateLimiter(
        globalRequestsPerMinute,
        60_000
    );

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

        // bearer별 제한을 먼저 확인해 한 bearer의 초과 호출이 global bucket을 소모하지 않게 한다.
        const perTokenDecision = perTokenLimiter.consume(tokenId);
        response.setHeader(
            'X-RateLimit-Remaining',
            String(perTokenDecision.remaining)
        );
        if (!perTokenDecision.allowed) {
            respondRateLimited(
                request,
                response,
                perTokenDecision.retryAfterSeconds,
                'Legal research bearer rate limit exceeded.'
            );
            return;
        }

        const globalDecision = globalLimiter.consume('legal-mcp-research');
        response.setHeader(
            'X-RateLimit-Global-Remaining',
            String(globalDecision.remaining)
        );
        if (!globalDecision.allowed) {
            respondRateLimited(
                request,
                response,
                globalDecision.retryAfterSeconds,
                'Legal research process-wide rate limit exceeded.'
            );
            return;
        }

        next();
    };
}
