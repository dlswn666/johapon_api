import { createHash, timingSafeEqual } from 'node:crypto';
import { requireBearerAuth } from '@modelcontextprotocol/express';
import {
    OAuthError,
    OAuthErrorCode,
    type AuthInfo,
} from '@modelcontextprotocol/server';
import type { RequestHandler } from 'express';
import {
    GIS_MCP_CLIENT_ID,
    GIS_MCP_REQUIRED_SCOPE,
} from '../services/public-data-mcp/policy';
import {
    GisMcpTokenRegistryConfigurationError,
    parseGisMcpTokenRegistryJson,
} from './gis-mcp-token-registry';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
export const GIS_MCP_AUTH_EXPIRES_IN_SECONDS = 60 * 60;

export class GisMcpAuthConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GisMcpAuthConfigurationError';
    }
}

export interface GisMcpTokenVerifierOptions {
    /** 생략하면 GIS_MCP_TOKEN_SHA256을 읽는다. */
    tokenSha256?: string;
    /** 생략하면 GIS_MCP_TOKEN_REGISTRY_JSON을 읽는다. */
    tokenRegistryJson?: string;
    now?: () => number;
}

function readConfiguredDigest(value: string | undefined): Buffer {
    const normalized = value?.trim().toLowerCase() ?? '';
    if (!SHA256_HEX_PATTERN.test(normalized)) {
        throw new GisMcpAuthConfigurationError(
            'GIS_MCP_TOKEN_SHA256에는 SHA-256 hex digest 64자를 설정해야 합니다.'
        );
    }
    const digest = Buffer.alloc(32);
    digest.write(normalized, 'hex');
    return digest;
}

interface ConfiguredGisMcpToken {
    clientId: string;
    digest: Buffer;
}

function isConfigured(value: string | undefined): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function readConfiguredTokens(
    options: GisMcpTokenVerifierOptions
): ConfiguredGisMcpToken[] {
    const legacyValue = options.tokenSha256 ?? process.env.GIS_MCP_TOKEN_SHA256;
    const registryValue = options.tokenRegistryJson
        ?? process.env.GIS_MCP_TOKEN_REGISTRY_JSON;
    const hasLegacy = isConfigured(legacyValue);
    const hasRegistry = isConfigured(registryValue);

    if (hasLegacy && hasRegistry) {
        throw new GisMcpAuthConfigurationError(
            'GIS_MCP_TOKEN_REGISTRY_JSON과 GIS_MCP_TOKEN_SHA256은 동시에 설정할 수 없습니다.'
        );
    }

    if (hasRegistry) {
        try {
            return parseGisMcpTokenRegistryJson(registryValue).clients.map(
                (entry) => ({
                    clientId: entry.clientId,
                    digest: readConfiguredDigest(entry.tokenSha256),
                })
            );
        } catch (error) {
            if (error instanceof GisMcpTokenRegistryConfigurationError) {
                throw new GisMcpAuthConfigurationError(error.message);
            }
            throw error;
        }
    }

    return [{
        clientId: GIS_MCP_CLIENT_ID,
        digest: readConfiguredDigest(legacyValue),
    }];
}

/** raw token은 저장하지 않고 SHA-256 digest만 상수 시간으로 비교한다. */
export function createGisMcpTokenVerifier(
    options: GisMcpTokenVerifierOptions = {}
): { verifyAccessToken(token: string): Promise<AuthInfo> } {
    const configuredTokens = readConfiguredTokens(options);
    const now = options.now ?? Date.now;

    return {
        async verifyAccessToken(token: string): Promise<AuthInfo> {
            const candidateDigest = createHash('sha256')
                .update(token, 'utf8')
                .digest();
            let matchedToken: ConfiguredGisMcpToken | undefined;

            // registry 순서에 따른 timing 차이를 줄이기 위해 전 entry를 비교한다.
            for (const configuredToken of configuredTokens) {
                if (timingSafeEqual(configuredToken.digest, candidateDigest)) {
                    matchedToken = configuredToken;
                }
            }

            if (!matchedToken) {
                throw new OAuthError(
                    OAuthErrorCode.InvalidToken,
                    'Invalid access token'
                );
            }

            const nowSeconds = Math.floor(now() / 1000);
            return {
                token,
                clientId: matchedToken.clientId,
                scopes: [GIS_MCP_REQUIRED_SCOPE],
                expiresAt: nowSeconds + GIS_MCP_AUTH_EXPIRES_IN_SECONDS,
                extra: {
                    tokenId: candidateDigest.toString('hex'),
                },
            };
        },
    };
}

export function createGisMcpAuthMiddleware(
    options: GisMcpTokenVerifierOptions = {}
): RequestHandler {
    return requireBearerAuth({
        verifier: createGisMcpTokenVerifier(options),
        requiredScopes: [GIS_MCP_REQUIRED_SCOPE],
    });
}
