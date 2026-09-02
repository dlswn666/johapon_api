import { createHash, randomBytes } from 'node:crypto';
import {
    parseGisMcpTokenRegistryJson,
    validateGisMcpClientId,
    type GisMcpTokenRegistryEntryV1,
} from '../../middleware/gis-mcp-token-registry';

export const GIS_MCP_BEARER_TOKEN_BYTES = 32;
export const GIS_MCP_BEARER_TOKEN_PREFIX = 'tgismcp_v1_';
export const GIS_MCP_PROXY_TOKEN_PREFIX = 'tgismcp_proxy_v1_';

const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/;

export interface ProvisionedGisMcpClientTokenV1 {
    clientId: string;
    bearerToken: string;
    tokenSha256: string;
    registryEntry: GisMcpTokenRegistryEntryV1;
}

export interface ProvisionedGisMcpProxyTokenV1 {
    proxyToken: string;
    proxyTokenSha256: string;
}

export function validateGisMcpRawBearerTokenV1(token: string): void {
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

export function digestGisMcpBearerTokenV1(token: string): string {
    validateGisMcpRawBearerTokenV1(token);
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

function generatePrefixedToken(
    prefix: string,
    randomBytesFactory: (size: number) => Buffer
): string {
    const entropy = randomBytesFactory(GIS_MCP_BEARER_TOKEN_BYTES);
    if (entropy.length !== GIS_MCP_BEARER_TOKEN_BYTES) {
        throw new Error('Bearer token 생성기는 정확히 256-bit 난수를 반환해야 합니다.');
    }
    const token = `${prefix}${entropy.toString('base64url')}`;
    validateGisMcpRawBearerTokenV1(token);
    return token;
}

export function provisionGisMcpClientTokenV1(
    clientId: string,
    options: {
        bearerToken?: string;
        randomBytesFactory?: (size: number) => Buffer;
    } = {}
): ProvisionedGisMcpClientTokenV1 {
    if (!validateGisMcpClientId(clientId)) {
        throw new Error(
            'clientId는 lowercase 영문·숫자와 단일 하이픈 조합 1~64자여야 합니다.'
        );
    }
    const bearerToken = options.bearerToken ?? generatePrefixedToken(
        GIS_MCP_BEARER_TOKEN_PREFIX,
        options.randomBytesFactory ?? randomBytes
    );
    const tokenSha256 = digestGisMcpBearerTokenV1(bearerToken);
    return {
        clientId,
        bearerToken,
        tokenSha256,
        registryEntry: { clientId, tokenSha256 },
    };
}

export function provisionGisMcpProxyTokenV1(
    randomBytesFactory: (size: number) => Buffer = randomBytes
): ProvisionedGisMcpProxyTokenV1 {
    const proxyToken = generatePrefixedToken(
        GIS_MCP_PROXY_TOKEN_PREFIX,
        randomBytesFactory
    );
    return {
        proxyToken,
        proxyTokenSha256: digestGisMcpBearerTokenV1(proxyToken),
    };
}

export function formatGisMcpTokenRegistryJsonV1(
    entries: GisMcpTokenRegistryEntryV1[]
): string {
    return JSON.stringify(parseGisMcpTokenRegistryJson(JSON.stringify({
        version: 1,
        clients: entries,
    })));
}
