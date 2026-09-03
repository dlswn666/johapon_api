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
import {
    LegalMcpTokenRegistryConfigurationError,
    parseLegalMcpTokenRegistryJson,
    type LegalMcpTokenRegistryV1,
} from './legal-mcp-token-registry';
import {
    createLegalMcpTokenRegistryFileProviderV1,
    LegalMcpTokenRegistryFileError,
    type LegalMcpTokenRegistryFileProviderV1,
} from './legal-mcp-token-registry-file';

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
    /** 생략하면 process.env.LEGAL_MCP_TOKEN_REGISTRY_JSON을 읽는다. */
    tokenRegistryJson?: string;
    /** 생략하면 process.env.LEGAL_MCP_TOKEN_REGISTRY_FILE을 읽는다. */
    tokenRegistryFile?: string;
    /** index에서 auth와 health가 공유하는 file snapshot provider. */
    tokenRegistryFileProvider?: LegalMcpTokenRegistryFileProviderV1;
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

interface ConfiguredLegalMcpToken {
    clientId: string;
    digest: Buffer;
}

function isConfigured(value: string | undefined): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

interface ConfiguredLegalMcpTokenSource {
    readTokens(): Promise<ConfiguredLegalMcpToken[]>;
}

function configuredTokensFromRegistry(
    registry: LegalMcpTokenRegistryV1
): ConfiguredLegalMcpToken[] {
    return registry.clients.map((entry) => ({
        clientId: entry.clientId,
        digest: readConfiguredDigest(entry.tokenSha256),
    }));
}

function configurationError(error: unknown): never {
    if (
        error instanceof LegalMcpTokenRegistryConfigurationError
        || error instanceof LegalMcpTokenRegistryFileError
    ) {
        throw new LegalMcpAuthConfigurationError(error.message);
    }
    throw error;
}

function createConfiguredTokenSource(
    options: LegalMcpTokenVerifierOptions
): ConfiguredLegalMcpTokenSource {
    const legacyValue =
        options.tokenSha256 ?? process.env.LEGAL_MCP_TOKEN_SHA256;
    const registryValue =
        options.tokenRegistryJson
        ?? process.env.LEGAL_MCP_TOKEN_REGISTRY_JSON;
    const configuredProvider = options.tokenRegistryFileProvider;
    const registryFileValue = configuredProvider
        ? options.tokenRegistryFile
        : options.tokenRegistryFile
            ?? process.env.LEGAL_MCP_TOKEN_REGISTRY_FILE;
    const hasLegacy = isConfigured(legacyValue);
    const hasRegistry = isConfigured(registryValue);
    const hasRegistryFile = isConfigured(registryFileValue);
    const hasRegistryProvider = configuredProvider !== undefined;

    if (
        Number(hasLegacy)
        + Number(hasRegistry)
        + Number(hasRegistryFile)
        + Number(hasRegistryProvider) !== 1
    ) {
        throw new LegalMcpAuthConfigurationError(
            'LEGAL_MCP_TOKEN_REGISTRY_FILE, LEGAL_MCP_TOKEN_REGISTRY_JSON, LEGAL_MCP_TOKEN_SHA256 중 정확히 하나를 설정해야 합니다.'
        );
    }

    if (hasRegistryProvider || hasRegistryFile) {
        try {
            const provider = configuredProvider
                ?? createLegalMcpTokenRegistryFileProviderV1(
                    registryFileValue as string
                );
            // factory가 invalid 상태를 보존하더라도 auth startup은 동기식으로 거부한다.
            configuredTokensFromRegistry(provider.getStartupRegistryV1());
            return {
                async readTokens() {
                    return configuredTokensFromRegistry(
                        await provider.readRegistryV1()
                    );
                },
            };
        } catch (error) {
            return configurationError(error);
        }
    }

    if (hasRegistry) {
        try {
            const tokens = configuredTokensFromRegistry(
                parseLegalMcpTokenRegistryJson(registryValue)
            );
            return { readTokens: async () => tokens };
        } catch (error) {
            return configurationError(error);
        }
    }

    const tokens = [{
        clientId: LEGAL_MCP_CLIENT_ID,
        digest: readConfiguredDigest(legacyValue),
    }];
    return { readTokens: async () => tokens };
}

/**
 * raw token을 저장하거나 비교하지 않고 두 32-byte digest만 상수 시간으로 비교한다.
 */
export function createLegalMcpTokenVerifier(
    options: LegalMcpTokenVerifierOptions = {}
): { verifyAccessToken(token: string): Promise<AuthInfo> } {
    const configuredTokenSource = createConfiguredTokenSource(options);
    const now = options.now ?? Date.now;

    return {
        async verifyAccessToken(token: string): Promise<AuthInfo> {
            let configuredTokens: ConfiguredLegalMcpToken[];
            try {
                configuredTokens = await configuredTokenSource.readTokens();
            } catch {
                // 실행 중 파일이 사라지거나 깨지면 이전 snapshot을 사용하지 않는다.
                throw new OAuthError(
                    OAuthErrorCode.InvalidToken,
                    'Invalid access token'
                );
            }
            const candidateHash = createHash('sha256');
            candidateHash.write(token, 'utf8');
            const candidateDigest = candidateHash.digest();

            let matchedToken: ConfiguredLegalMcpToken | undefined;
            // 일치 후에도 모든 entry를 비교해 레지스트리 순서에 따른 timing 차이를 줄인다.
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
