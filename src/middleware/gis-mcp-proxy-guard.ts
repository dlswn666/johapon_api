import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const GIS_MCP_PROXY_TOKEN_HEADER =
    'x-tonghari-gis-mcp-proxy-token' as const;
export const GIS_MCP_FORWARDED_PROTO_HEADER = 'x-forwarded-proto' as const;
export const GIS_MCP_PROXY_TOKEN_MIN_BYTES = 32;
export const GIS_MCP_PROXY_TOKEN_MAX_BYTES = 512;

export const GIS_MCP_PROXY_FORBIDDEN_BODY = Object.freeze({
    error: 'Forbidden',
    code: 'GIS_MCP_PROXY_FORBIDDEN',
});

export class GisMcpProxyGuardConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GisMcpProxyGuardConfigurationError';
    }
}

export interface GisMcpProxyGuardOptions {
    /** Caddy만 보유하는 raw proxy secret의 SHA-256 digest. */
    proxyTokenSha256?: string;
}

function readConfiguredDigest(value: string | undefined): Buffer {
    const normalized = value?.trim().toLowerCase() ?? '';
    if (!SHA256_HEX_PATTERN.test(normalized)) {
        throw new GisMcpProxyGuardConfigurationError(
            'GIS_MCP_PROXY_TOKEN_SHA256에는 SHA-256 hex digest 64자를 설정해야 합니다.'
        );
    }
    const digest = Buffer.alloc(32);
    digest.write(normalized, 'hex');
    return digest;
}

function readUnambiguousHeader(
    request: Request,
    name: typeof GIS_MCP_PROXY_TOKEN_HEADER
        | typeof GIS_MCP_FORWARDED_PROTO_HEADER
): string | undefined {
    const value = request.headers[name];
    if (typeof value !== 'string' || value.includes(',')) return undefined;
    return value;
}

function forbid(response: Response): void {
    response.status(403).json(GIS_MCP_PROXY_FORBIDDEN_BODY);
}

/** TLS 종료 proxy가 raw secret과 https proto를 덮어쓴 요청만 허용한다. */
export function createGisMcpProxyGuardMiddleware(
    options: GisMcpProxyGuardOptions = {}
): RequestHandler {
    const expectedDigest = readConfiguredDigest(
        options.proxyTokenSha256 ?? process.env.GIS_MCP_PROXY_TOKEN_SHA256
    );

    return (request, response, next): void => {
        response.set('Cache-Control', 'no-store');

        const forwardedProto = readUnambiguousHeader(
            request,
            GIS_MCP_FORWARDED_PROTO_HEADER
        );
        if (forwardedProto !== 'https') {
            forbid(response);
            return;
        }

        const proxyToken = readUnambiguousHeader(
            request,
            GIS_MCP_PROXY_TOKEN_HEADER
        );
        if (proxyToken === undefined) {
            forbid(response);
            return;
        }

        const tokenBytes = Buffer.byteLength(proxyToken, 'utf8');
        if (
            tokenBytes < GIS_MCP_PROXY_TOKEN_MIN_BYTES
            || tokenBytes > GIS_MCP_PROXY_TOKEN_MAX_BYTES
        ) {
            forbid(response);
            return;
        }

        const candidateDigest = createHash('sha256')
            .update(proxyToken, 'utf8')
            .digest();
        if (!timingSafeEqual(expectedDigest, candidateDigest)) {
            forbid(response);
            return;
        }

        next();
    };
}
