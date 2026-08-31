const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;
export const LEGAL_MCP_CLIENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const LEGAL_MCP_TOKEN_REGISTRY_MAX_CLIENTS = 32;

export interface LegalMcpTokenRegistryEntryV1 {
    clientId: string;
    tokenSha256: string;
}

export interface LegalMcpTokenRegistryV1 {
    version: 1;
    clients: LegalMcpTokenRegistryEntryV1[];
}

export class LegalMcpTokenRegistryConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LegalMcpTokenRegistryConfigurationError';
    }
}

export function validateLegalMcpClientId(value: unknown): value is string {
    return typeof value === 'string'
        && value.length <= 64
        && LEGAL_MCP_CLIENT_ID_PATTERN.test(value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
    value: Record<string, unknown>,
    expectedKeys: readonly string[]
): boolean {
    const actualKeys = Object.keys(value);
    return actualKeys.length === expectedKeys.length
        && actualKeys.every((key) => expectedKeys.includes(key));
}

function configurationError(message: string): never {
    throw new LegalMcpTokenRegistryConfigurationError(message);
}

/**
 * 운영 환경 변수의 JSON 레지스트리를 엄격한 v1 schema로 검증한다.
 * 반환값에는 비교에 사용할 canonical lowercase digest만 남긴다.
 */
export function parseLegalMcpTokenRegistryJson(
    value: string | undefined
): LegalMcpTokenRegistryV1 {
    if (!value || value.trim().length === 0) {
        return configurationError(
            'LEGAL_MCP_TOKEN_REGISTRY_JSON에는 비어 있지 않은 JSON을 설정해야 합니다.'
        );
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(value) as unknown;
    } catch {
        return configurationError(
            'LEGAL_MCP_TOKEN_REGISTRY_JSON JSON 형식이 올바르지 않습니다.'
        );
    }

    if (!isJsonObject(parsed) || !hasExactKeys(parsed, ['version', 'clients'])) {
        return configurationError(
            'LEGAL_MCP_TOKEN_REGISTRY_JSON 최상위 schema가 올바르지 않습니다.'
        );
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.clients)) {
        return configurationError(
            'LEGAL_MCP_TOKEN_REGISTRY_JSON은 version 1과 clients 배열을 사용해야 합니다.'
        );
    }
    if (
        parsed.clients.length === 0
        || parsed.clients.length > LEGAL_MCP_TOKEN_REGISTRY_MAX_CLIENTS
    ) {
        return configurationError(
            `LEGAL_MCP_TOKEN_REGISTRY_JSON clients는 1~${LEGAL_MCP_TOKEN_REGISTRY_MAX_CLIENTS}개여야 합니다.`
        );
    }

    const clientIds = new Set<string>();
    const tokenDigests = new Set<string>();
    const clients = parsed.clients.map((entry, index) => {
        if (!isJsonObject(entry) || !hasExactKeys(entry, ['clientId', 'tokenSha256'])) {
            return configurationError(
                `LEGAL_MCP_TOKEN_REGISTRY_JSON clients[${index}] schema가 올바르지 않습니다.`
            );
        }
        if (!validateLegalMcpClientId(entry.clientId)) {
            return configurationError(
                `LEGAL_MCP_TOKEN_REGISTRY_JSON clients[${index}].clientId 형식이 올바르지 않습니다.`
            );
        }
        if (typeof entry.tokenSha256 !== 'string') {
            return configurationError(
                `LEGAL_MCP_TOKEN_REGISTRY_JSON clients[${index}].tokenSha256 형식이 올바르지 않습니다.`
            );
        }

        const tokenSha256 = entry.tokenSha256.trim().toLowerCase();
        if (!SHA256_HEX_PATTERN.test(tokenSha256)) {
            return configurationError(
                `LEGAL_MCP_TOKEN_REGISTRY_JSON clients[${index}].tokenSha256 형식이 올바르지 않습니다.`
            );
        }
        if (clientIds.has(entry.clientId)) {
            return configurationError(
                'LEGAL_MCP_TOKEN_REGISTRY_JSON clients에 중복 clientId가 있습니다.'
            );
        }
        if (tokenDigests.has(tokenSha256)) {
            return configurationError(
                'LEGAL_MCP_TOKEN_REGISTRY_JSON clients에 중복 tokenSha256이 있습니다.'
            );
        }

        clientIds.add(entry.clientId);
        tokenDigests.add(tokenSha256);
        return {
            clientId: entry.clientId,
            tokenSha256,
        };
    });

    return {
        version: 1,
        clients,
    };
}
