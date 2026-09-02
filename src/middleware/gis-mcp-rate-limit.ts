import type { NextFunction, Request, Response } from 'express';
import { FixedWindowRateLimiter } from '../security/fixed-window-rate-limiter';
import { PUBLIC_DATA_MCP_TOOL_NAMES } from '../services/public-data-mcp/server';

export const GIS_MCP_REQUESTS_PER_MINUTE = 20;
export const GIS_MCP_GLOBAL_REQUESTS_PER_MINUTE = 40;

export interface GisMcpRateLimitOptions {
    perTokenRequestsPerMinute?: number;
    globalRequestsPerMinute?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGisProviderCall(request: Request): boolean {
    if (!isRecord(request.body) || request.body.method !== 'tools/call') return false;
    const params = request.body.params;
    return isRecord(params)
        && typeof params.name === 'string'
        && (PUBLIC_DATA_MCP_TOOL_NAMES as readonly string[]).includes(params.name);
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
    message: string
): void {
    response.setHeader('Retry-After', String(retryAfterSeconds));
    response.status(429).json({
        jsonrpc: '2.0',
        id: isRecord(request.body) ? request.body.id ?? null : null,
        error: { code: -32029, message },
    });
}

/** upstream을 호출하는 GIS 도구 전체를 bearer별·프로세스 합산으로 제한한다. */
export function createGisMcpRateLimitMiddleware(
    options: GisMcpRateLimitOptions = {}
) {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
        throw new Error('GIS MCP 호출 제한은 options 객체로 설정해야 합니다.');
    }
    const perTokenRequestsPerMinute = options.perTokenRequestsPerMinute
        ?? GIS_MCP_REQUESTS_PER_MINUTE;
    const globalRequestsPerMinute = options.globalRequestsPerMinute
        ?? GIS_MCP_GLOBAL_REQUESTS_PER_MINUTE;
    validateRequestsPerMinute(
        perTokenRequestsPerMinute,
        'GIS MCP bearer별 분당 제한'
    );
    validateRequestsPerMinute(
        globalRequestsPerMinute,
        'GIS MCP 프로세스 전체 분당 제한'
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
        if (!isGisProviderCall(request)) {
            next();
            return;
        }

        const tokenId = request.auth?.extra?.tokenId;
        if (typeof tokenId !== 'string' || !/^[0-9a-f]{64}$/i.test(tokenId)) {
            response.status(401).json({
                jsonrpc: '2.0',
                id: isRecord(request.body) ? request.body.id ?? null : null,
                error: {
                    code: -32001,
                    message: 'Authenticated MCP principal is required.',
                },
            });
            return;
        }

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
                'GIS MCP bearer rate limit exceeded.'
            );
            return;
        }

        const globalDecision = globalLimiter.consume('gis-mcp-provider');
        response.setHeader(
            'X-RateLimit-Global-Remaining',
            String(globalDecision.remaining)
        );
        if (!globalDecision.allowed) {
            respondRateLimited(
                request,
                response,
                globalDecision.retryAfterSeconds,
                'GIS MCP process-wide rate limit exceeded.'
            );
            return;
        }

        next();
    };
}
