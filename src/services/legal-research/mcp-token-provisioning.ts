import { createHash, randomBytes } from 'node:crypto';
import {
    parseLegalMcpTokenRegistryJson,
    validateLegalMcpClientId,
    type LegalMcpTokenRegistryEntryV1,
} from '../../middleware/legal-mcp-token-registry';

export const LEGAL_MCP_BEARER_TOKEN_BYTES = 32;
export const LEGAL_MCP_BEARER_TOKEN_PREFIX = 'tlmcp_v1_';
export const LEGAL_MCP_PROXY_TOKEN_PREFIX = 'tlmcp_proxy_v1_';

const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/;

export interface ProvisionedLegalMcpClientTokenV1 {
    clientId: string;
    bearerToken: string;
    tokenSha256: string;
    registryEntry: LegalMcpTokenRegistryEntryV1;
}

export interface ProvisionedLegalMcpProxyTokenV1 {
    proxyToken: string;
    proxyTokenSha256: string;
}

export function validateLegalMcpRawBearerTokenV1(token: string): void {
    if (
        token.length < 32
        || token.length > 512
        || !BEARER_TOKEN_PATTERN.test(token)
    ) {
        throw new Error(
            'Bearer token은 공백 없는 RFC 6750 호환 ASCII 문자열 32~512자여야 합니다.'
        );
    }
}

export function digestLegalMcpBearerTokenV1(token: string): string {
    validateLegalMcpRawBearerTokenV1(token);
    const hash = createHash('sha256');
    hash.write(token, 'utf8');
    return hash.digest('hex');
}

function generatePrefixedToken(
    prefix: string,
    randomBytesFactory: (size: number) => Buffer
): string {
    const entropy = randomBytesFactory(LEGAL_MCP_BEARER_TOKEN_BYTES);
    if (entropy.length !== LEGAL_MCP_BEARER_TOKEN_BYTES) {
        throw new Error('Bearer token 생성기는 정확히 256-bit 난수를 반환해야 합니다.');
    }
    const token = `${prefix}${entropy.toString('base64url')}`;
    validateLegalMcpRawBearerTokenV1(token);
    return token;
}

export function provisionLegalMcpClientTokenV1(
    clientId: string,
    options: {
        bearerToken?: string;
        randomBytesFactory?: (size: number) => Buffer;
    } = {}
): ProvisionedLegalMcpClientTokenV1 {
    if (!validateLegalMcpClientId(clientId)) {
        throw new Error('clientId는 lowercase 영문·숫자와 단일 하이픈 조합 1~64자여야 합니다.');
    }
    const bearerToken = options.bearerToken ?? generatePrefixedToken(
        LEGAL_MCP_BEARER_TOKEN_PREFIX,
        options.randomBytesFactory ?? randomBytes
    );
    const tokenSha256 = digestLegalMcpBearerTokenV1(bearerToken);
    return {
        clientId,
        bearerToken,
        tokenSha256,
        registryEntry: { clientId, tokenSha256 },
    };
}

export function provisionLegalMcpProxyTokenV1(
    randomBytesFactory: (size: number) => Buffer = randomBytes
): ProvisionedLegalMcpProxyTokenV1 {
    const proxyToken = generatePrefixedToken(
        LEGAL_MCP_PROXY_TOKEN_PREFIX,
        randomBytesFactory
    );
    return {
        proxyToken,
        proxyTokenSha256: digestLegalMcpBearerTokenV1(proxyToken),
    };
}

export function formatLegalMcpTokenRegistryJsonV1(
    entries: LegalMcpTokenRegistryEntryV1[]
): string {
    const serialized = JSON.stringify({ version: 1, clients: entries });
    return JSON.stringify(parseLegalMcpTokenRegistryJson(serialized));
}
