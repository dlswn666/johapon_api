import { createHash, timingSafeEqual } from 'node:crypto';
import { requireBearerAuth } from '@modelcontextprotocol/express';
import {
    OAuthError,
    OAuthErrorCode,
    type AuthInfo,
} from '@modelcontextprotocol/server';
import type { RequestHandler } from 'express';
import {
    LEGAL_MCP_CLIENT_ID,
    LEGAL_MCP_REQUIRED_SCOPE,
} from '../services/legal-research/mcp-policy';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
export const LEGAL_MCP_AUTH_EXPIRES_IN_SECONDS = 60 * 60;

export class LegalMcpAuthConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LegalMcpAuthConfigurationError';
    }
}

export interface LegalMcpTokenVerifierOptions {
    /** 생략하면 process.env.LEGAL_MCP_TOKEN_SHA256을 읽는다. */
    tokenSha256?: string;
    /** 테스트 가능한 epoch milliseconds clock. */
    now?: () => number;
}

function readConfiguredDigest(value: string | undefined): Buffer {
    const normalized = value?.trim().toLowerCase() ?? '';
    if (!SHA256_HEX_PATTERN.test(normalized)) {
        throw new LegalMcpAuthConfigurationError(
            'LEGAL_MCP_TOKEN_SHA256에는 SHA-256 hex digest 64자를 설정해야 합니다.'
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

/**
 * raw token을 저장하거나 비교하지 않고 두 32-byte digest만 상수 시간으로 비교한다.
 */
export function createLegalMcpTokenVerifier(
    options: LegalMcpTokenVerifierOptions = {}
): { verifyAccessToken(token: string): Promise<AuthInfo> } {
    const expectedDigest = readConfiguredDigest(
        options.tokenSha256 ?? process.env.LEGAL_MCP_TOKEN_SHA256
    );
    const now = options.now ?? Date.now;

    return {
        async verifyAccessToken(token: string): Promise<AuthInfo> {
            const candidateHash = createHash('sha256');
            candidateHash.write(token, 'utf8');
            const candidateDigest = candidateHash.digest();

            if (!timingSafeEqual(expectedDigest, candidateDigest)) {
                throw new OAuthError(
                    OAuthErrorCode.InvalidToken,
                    'Invalid access token'
                );
            }

            const nowSeconds = Math.floor(now() / 1000);
            return {
                token,
                clientId: LEGAL_MCP_CLIENT_ID,
                scopes: [LEGAL_MCP_REQUIRED_SCOPE],
                expiresAt: nowSeconds + LEGAL_MCP_AUTH_EXPIRES_IN_SECONDS,
                extra: {
                    // 패킷 proof를 발급한 bearer 세대에 묶어 token rotation 뒤 재사용을 막는다.
                    tokenId: candidateDigest.toString('hex'),
                },
            };
        },
    };
}

export function createLegalMcpAuthMiddleware(
    options: LegalMcpTokenVerifierOptions = {}
): RequestHandler {
    return requireBearerAuth({
        verifier: createLegalMcpTokenVerifier(options),
        requiredScopes: [LEGAL_MCP_REQUIRED_SCOPE],
    });
}
