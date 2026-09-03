import { parseLegalMcpTokenRegistryJson } from '../../middleware/legal-mcp-token-registry';
import {
    readLegalMcpTokenRegistryFileAsyncV1,
    readLegalMcpTokenRegistryFileV1,
    type LegalMcpTokenRegistryFileProviderV1,
} from '../../middleware/legal-mcp-token-registry-file';

export interface LegalMcpConfigurationInputV1 {
    lawApiOc: string;
    /** 단일 bearer를 위한 하위 호환 digest. registry와 동시에 설정할 수 없다. */
    tokenSha256: string;
    /** 외부 client별 bearer digest registry. */
    tokenRegistryJson: string;
    /** 외부 client별 bearer digest registry의 보호된 파일 경로. */
    tokenRegistryFile?: string;
    /** TLS 종료 reverse proxy만 알고 있는 raw secret의 digest. */
    proxyTokenSha256: string;
    packetSigningKey: string;
    allowedHosts: string;
}

export type LegalMcpConfigurationFieldV1 =
    | 'lawApiOc'
    | 'tokenAuthentication'
    | 'proxyTokenSha256'
    | 'packetSigningKey'
    | 'allowedHosts';

export type LegalMcpAuthModeV1 =
    | 'disabled'
    | 'legacy_single'
    | 'client_registry';

export type LegalMcpAuthSourceV1 =
    | 'disabled'
    | 'legacy_single'
    | 'json_registry'
    | 'file_registry';

export interface LegalMcpConfigurationStateV1 {
    configured: boolean;
    missing: LegalMcpConfigurationFieldV1[];
    invalid: LegalMcpConfigurationFieldV1[];
    authMode: LegalMcpAuthModeV1;
    authSource: LegalMcpAuthSourceV1;
    registeredClientCount: number;
    registeredTokenCount: number;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

function isBareHostname(value: string): boolean {
    if (!value || value === '*' || /[\s/?#@]/.test(value) || value.includes('://')) {
        return false;
    }
    try {
        const parsed = new URL(`http://${value}`);
        return !parsed.port
            && !parsed.username
            && !parsed.password
            && parsed.hostname.toLowerCase() === value.toLowerCase();
    } catch {
        return false;
    }
}

function hasValidAllowedHosts(value: string): boolean {
    const hosts = value.split(',').map((host) => host.trim()).filter(Boolean);
    return hosts.length > 0 && hosts.every(isBareHostname);
}

interface LegalMcpAuthenticationInspection {
    missing: boolean;
    invalid: boolean;
    authMode: LegalMcpAuthModeV1;
    authSource: LegalMcpAuthSourceV1;
    registeredClientCount: number;
    registeredTokenCount: number;
}

function validRegistryAuthentication(
    clientCount: number,
    authSource: 'json_registry' | 'file_registry'
): LegalMcpAuthenticationInspection {
    return {
        missing: false,
        invalid: false,
        authMode: 'client_registry',
        authSource,
        registeredClientCount: clientCount,
        registeredTokenCount: clientCount,
    };
}

function invalidRegistryAuthentication(
    authSource: 'json_registry' | 'file_registry'
): LegalMcpAuthenticationInspection {
    return {
        missing: false,
        invalid: true,
        authMode: 'disabled',
        authSource,
        registeredClientCount: 0,
        registeredTokenCount: 0,
    };
}

function inspectTokenAuthentication(
    tokenSha256: string,
    tokenRegistryJson: string,
    tokenRegistryFile: string | undefined
): LegalMcpAuthenticationInspection {
    const legacy = tokenSha256.trim();
    const registry = tokenRegistryJson.trim();
    const registryFileValue = tokenRegistryFile ?? '';
    const registryFile = registryFileValue.trim();
    const hasLegacy = legacy.length > 0;
    const hasRegistry = registry.length > 0;
    const hasRegistryFile = registryFile.length > 0;
    const configuredSourceCount = Number(hasLegacy)
        + Number(hasRegistry)
        + Number(hasRegistryFile);

    if (configuredSourceCount === 0) {
        return {
            missing: true,
            invalid: false,
            authMode: 'disabled',
            authSource: 'disabled',
            registeredClientCount: 0,
            registeredTokenCount: 0,
        };
    }
    if (configuredSourceCount !== 1) {
        return {
            missing: false,
            invalid: true,
            authMode: 'disabled',
            authSource: 'disabled',
            registeredClientCount: 0,
            registeredTokenCount: 0,
        };
    }
    if (hasLegacy) {
        const valid = SHA256_HEX_PATTERN.test(legacy);
        return {
            missing: false,
            invalid: !valid,
            authMode: valid ? 'legacy_single' : 'disabled',
            authSource: 'legacy_single',
            registeredClientCount: valid ? 1 : 0,
            registeredTokenCount: valid ? 1 : 0,
        };
    }

    try {
        const parsed = hasRegistryFile
            ? readLegalMcpTokenRegistryFileV1(registryFileValue)
            : parseLegalMcpTokenRegistryJson(registry);
        return validRegistryAuthentication(
            parsed.clients.length,
            hasRegistryFile ? 'file_registry' : 'json_registry'
        );
    } catch {
        return invalidRegistryAuthentication(
            hasRegistryFile ? 'file_registry' : 'json_registry'
        );
    }
}

async function inspectTokenAuthenticationRuntime(
    tokenSha256: string,
    tokenRegistryJson: string,
    tokenRegistryFile: string | undefined,
    provider: LegalMcpTokenRegistryFileProviderV1 | undefined
): Promise<LegalMcpAuthenticationInspection> {
    const hasLegacy = tokenSha256.trim().length > 0;
    const hasRegistry = tokenRegistryJson.trim().length > 0;
    const registryFileValue = tokenRegistryFile ?? '';
    const hasRegistryFile = registryFileValue.trim().length > 0;
    if (
        Number(hasLegacy) + Number(hasRegistry) + Number(hasRegistryFile) !== 1
        || !hasRegistryFile
    ) {
        return inspectTokenAuthentication(
            tokenSha256,
            tokenRegistryJson,
            tokenRegistryFile
        );
    }

    try {
        if (provider && !provider.isForPathV1(registryFileValue)) {
            return invalidRegistryAuthentication('file_registry');
        }
        const registry = provider
            ? await provider.readRegistryV1()
            : await readLegalMcpTokenRegistryFileAsyncV1(registryFileValue);
        return validRegistryAuthentication(
            registry.clients.length,
            'file_registry'
        );
    } catch {
        return invalidRegistryAuthentication('file_registry');
    }
}

function isValidValue(
    key: Exclude<LegalMcpConfigurationFieldV1, 'tokenAuthentication'>,
    value: string
): boolean {
    const normalized = value.trim();
    switch (key) {
        case 'lawApiOc':
            // 국가법령정보 공동활용 OC는 account identifier다. query 구분자·공백은 허용하지 않는다.
            return normalized.length >= 3
                && normalized.length <= 200
                && !/[\s&#?]/.test(normalized);
        case 'proxyTokenSha256':
            return SHA256_HEX_PATTERN.test(normalized);
        case 'packetSigningKey':
            return /^(?:[0-9a-f]{2}){32,}$/i.test(normalized);
        case 'allowedHosts':
            return hasValidAllowedHosts(normalized);
    }
}

/**
 * MCP를 mount하기 전에 필수 설정의 존재와 형식을 모두 검증한다.
 * 이는 upstream 연결 상태가 아니라 안전한 startup 구성 여부만 뜻한다.
 */
export function getLegalMcpConfigurationStateV1(
    input: LegalMcpConfigurationInputV1
): LegalMcpConfigurationStateV1 {
    const authentication = inspectTokenAuthentication(
        input.tokenSha256,
        input.tokenRegistryJson,
        input.tokenRegistryFile
    );
    return buildLegalMcpConfigurationState(input, authentication);
}

function buildLegalMcpConfigurationState(
    input: LegalMcpConfigurationInputV1,
    authentication: LegalMcpAuthenticationInspection
): LegalMcpConfigurationStateV1 {
    const values: Array<[
        Exclude<LegalMcpConfigurationFieldV1, 'tokenAuthentication'>,
        string,
    ]> = [
        ['lawApiOc', input.lawApiOc],
        ['proxyTokenSha256', input.proxyTokenSha256],
        ['packetSigningKey', input.packetSigningKey],
        ['allowedHosts', input.allowedHosts],
    ];
    const missing: LegalMcpConfigurationFieldV1[] = values
        .filter(([, value]) => value.trim().length === 0)
        .map(([key]) => key);
    if (authentication.missing) missing.push('tokenAuthentication');

    const missingSet = new Set(missing);
    const invalid: LegalMcpConfigurationFieldV1[] = values
        .filter(([key, value]) => !missingSet.has(key) && !isValidValue(key, value))
        .map(([key]) => key);
    if (authentication.invalid) invalid.push('tokenAuthentication');

    return {
        configured: missing.length === 0 && invalid.length === 0,
        missing,
        invalid,
        authMode: authentication.authMode,
        authSource: authentication.authSource,
        registeredClientCount: authentication.registeredClientCount,
        registeredTokenCount: authentication.registeredTokenCount,
    };
}

/** health 요청에서는 file I/O를 event loop 밖에서 수행하고 auth와 provider cache를 공유한다. */
export async function getLegalMcpRuntimeConfigurationStateV1(
    input: LegalMcpConfigurationInputV1,
    provider?: LegalMcpTokenRegistryFileProviderV1,
    startupConfiguration?: LegalMcpConfigurationStateV1
): Promise<LegalMcpConfigurationStateV1> {
    // startup에 endpoint가 mount되지 않았다면 file 복구만으로 health를 true로 만들지 않는다.
    if (startupConfiguration && !startupConfiguration.configured) {
        return startupConfiguration;
    }
    const authentication = await inspectTokenAuthenticationRuntime(
        input.tokenSha256,
        input.tokenRegistryJson,
        input.tokenRegistryFile,
        provider
    );
    return buildLegalMcpConfigurationState(input, authentication);
}
