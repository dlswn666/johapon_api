import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const LEGAL_MCP_PROXY_TOKEN_HEADER = 'x-tonghari-mcp-proxy-token' as const;
export const LEGAL_MCP_FORWARDED_PROTO_HEADER = 'x-forwarded-proto' as const;
export const LEGAL_MCP_PROXY_TOKEN_MIN_BYTES = 32;
export const LEGAL_MCP_PROXY_TOKEN_MAX_BYTES = 512;

export const LEGAL_MCP_PROXY_FORBIDDEN_BODY = Object.freeze({
    error: 'Forbidden',
    code: 'LEGAL_MCP_PROXY_FORBIDDEN',
});

export class LegalMcpProxyGuardConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LegalMcpProxyGuardConfigurationError';
    }
}

export interface LegalMcpProxyGuardOptions {
    /**
     * Caddy에만 보관하는 256-bit 이상 raw secret의 SHA-256 digest.
     * 생략하면 process.env.LEGAL_MCP_PROXY_TOKEN_SHA256을 읽는다.
     */
    proxyTokenSha256?: string;
}

function readConfiguredDigest(value: string | undefined): Buffer {
    const normalized = value?.trim().toLowerCase() ?? '';
    if (!SHA256_HEX_PATTERN.test(normalized)) {
        throw new LegalMcpProxyGuardConfigurationError(
            'LEGAL_MCP_PROXY_TOKEN_SHA256에는 SHA-256 hex digest 64자를 설정해야 합니다.'
        );
    }

    const digest = Buffer.alloc(32);
    for (let index = 0; index < digest.length; index += 1) {
        digest[index] = Number.parseInt(
            normalized.slice(index * 2, index * 2 + 2),
            16
        );
    }
    return digest;
}

function readUnambiguousHeader(
    request: Request,
    name: typeof LEGAL_MCP_PROXY_TOKEN_HEADER | typeof LEGAL_MCP_FORWARDED_PROTO_HEADER
): string | undefined {
    const value = request.headers[name];

    // 중복 헤더는 Node에서 배열 또는 쉼표 결합 문자열이 될 수 있다.
    if (typeof value !== 'string' || value.includes(',')) {
        return undefined;
    }

    return value;
}

function forbid(response: Response): void {
    response.status(403).json(LEGAL_MCP_PROXY_FORBIDDEN_BODY);
}

/**
 * Caddy가 외부의 동명 헤더를 제거한 뒤 proxy 전용 raw secret을 overwrite해서
 * 주입한 요청만 허용한다. 이 미들웨어는 raw secret을 저장하거나 기록하지 않는다.
 */
export function createLegalMcpProxyGuardMiddleware(
    options: LegalMcpProxyGuardOptions = {}
): RequestHandler {
    const expectedDigest = readConfiguredDigest(
        options.proxyTokenSha256 ?? process.env.LEGAL_MCP_PROXY_TOKEN_SHA256
    );

    return (request, response, next): void => {
        // 인증 성공 여부와 무관하게 프록시 증명 요청/응답을 캐시하지 않는다.
        response.set('Cache-Control', 'no-store');

        const forwardedProto = readUnambiguousHeader(
            request,
            LEGAL_MCP_FORWARDED_PROTO_HEADER
        );
        if (forwardedProto !== 'https') {
            forbid(response);
            return;
        }

        const proxyToken = readUnambiguousHeader(
            request,
            LEGAL_MCP_PROXY_TOKEN_HEADER
        );
        if (proxyToken === undefined) {
            forbid(response);
            return;
        }

        const tokenBytes = Buffer.byteLength(proxyToken, 'utf8');
        if (
            tokenBytes < LEGAL_MCP_PROXY_TOKEN_MIN_BYTES
            || tokenBytes > LEGAL_MCP_PROXY_TOKEN_MAX_BYTES
        ) {
            forbid(response);
            return;
        }

        const candidateHash = createHash('sha256');
        candidateHash.write(proxyToken, 'utf8');
        const candidateDigest = candidateHash.digest();

        if (!timingSafeEqual(expectedDigest, candidateDigest)) {
            forbid(response);
            return;
        }

        next();
    };
}
