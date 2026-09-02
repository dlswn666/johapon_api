import { parseGisMcpTokenRegistryJson } from '../../middleware/gis-mcp-token-registry';

export interface GisMcpConfigurationInputV1 {
    vworldApiKey: string;
    vworldApiDomain: string;
    dataPortalApiKey: string;
    tokenSha256: string;
    tokenRegistryJson: string;
    proxyTokenSha256: string;
    allowedHosts: string;
    allowedOrigins: string;
    requestsPerMinute: number;
    globalRequestsPerMinute: number;
    requestDeadlineMs: number;
    maxConcurrency: number;
    maxQueue: number;
}

export type GisMcpConfigurationFieldV1 =
    | 'vworldApiKey'
    | 'vworldApiDomain'
    | 'dataPortalApiKey'
    | 'tokenAuthentication'
    | 'proxyTokenSha256'
    | 'allowedHosts'
    | 'allowedOrigins'
    | 'requestsPerMinute'
    | 'globalRequestsPerMinute'
    | 'requestDeadlineMs'
    | 'maxConcurrency'
    | 'maxQueue';

export type GisMcpAuthModeV1 =
    | 'disabled'
    | 'legacy_single'
    | 'client_registry';

export interface GisMcpConfigurationStateV1 {
    configured: boolean;
    missing: GisMcpConfigurationFieldV1[];
    invalid: GisMcpConfigurationFieldV1[];
    authMode: GisMcpAuthModeV1;
    registeredClientCount: number;
    registeredTokenCount: number;
    providerMode: 'disabled' | 'vworld_and_data_portal';
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

function hasValidOptionalAllowedHosts(value: string): boolean {
    return value.trim() === '' || hasValidAllowedHosts(value);
}

function isIntegerInRange(
    value: number,
    minimum: number,
    maximum: number
): boolean {
    return Number.isSafeInteger(value)
        && value >= minimum
        && value <= maximum;
}

function isOpaqueSecret(value: string, maximumLength: number): boolean {
    return value.length >= 8
        && value.length <= maximumLength
        && !/[\s&#?]/.test(value);
}

function inspectTokenAuthentication(
    tokenSha256: string,
    tokenRegistryJson: string
): Pick<
    GisMcpConfigurationStateV1,
    'authMode' | 'registeredClientCount' | 'registeredTokenCount'
> & { missing: boolean; invalid: boolean } {
    const legacy = tokenSha256.trim();
    const registry = tokenRegistryJson.trim();
    const hasLegacy = legacy.length > 0;
    const hasRegistry = registry.length > 0;

    if (!hasLegacy && !hasRegistry) {
        return {
            missing: true,
            invalid: false,
            authMode: 'disabled',
            registeredClientCount: 0,
            registeredTokenCount: 0,
        };
    }
    if (hasLegacy && hasRegistry) {
        return {
            missing: false,
            invalid: true,
            authMode: 'disabled',
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
            registeredClientCount: valid ? 1 : 0,
            registeredTokenCount: valid ? 1 : 0,
        };
    }

    try {
        const parsed = parseGisMcpTokenRegistryJson(registry);
        return {
            missing: false,
            invalid: false,
            authMode: 'client_registry',
            registeredClientCount: parsed.clients.length,
            registeredTokenCount: parsed.clients.length,
        };
    } catch {
        return {
            missing: false,
            invalid: true,
            authMode: 'disabled',
            registeredClientCount: 0,
            registeredTokenCount: 0,
        };
    }
}

/** startup 설정 형식만 검사하며 upstream reachability를 뜻하지 않는다. */
export function getGisMcpConfigurationStateV1(
    input: GisMcpConfigurationInputV1
): GisMcpConfigurationStateV1 {
    const authentication = inspectTokenAuthentication(
        input.tokenSha256,
        input.tokenRegistryJson
    );
    const values: Array<[
        Exclude<
            GisMcpConfigurationFieldV1,
            | 'tokenAuthentication'
            | 'allowedOrigins'
            | 'requestsPerMinute'
            | 'globalRequestsPerMinute'
            | 'requestDeadlineMs'
            | 'maxConcurrency'
            | 'maxQueue'
        >,
        string,
    ]> = [
        ['vworldApiKey', input.vworldApiKey],
        ['vworldApiDomain', input.vworldApiDomain],
        ['dataPortalApiKey', input.dataPortalApiKey],
        ['proxyTokenSha256', input.proxyTokenSha256],
        ['allowedHosts', input.allowedHosts],
    ];
    const missing: GisMcpConfigurationFieldV1[] = values
        .filter(([, value]) => value.trim().length === 0)
        .map(([key]) => key);
    if (authentication.missing) missing.push('tokenAuthentication');

    const missingSet = new Set(missing);
    const invalid: GisMcpConfigurationFieldV1[] = values
        .filter(([key, value]) => {
            if (missingSet.has(key)) return false;
            const normalized = value.trim();
            switch (key) {
                case 'vworldApiKey':
                    return !isOpaqueSecret(normalized, 512);
                case 'vworldApiDomain':
                    return !isBareHostname(normalized);
                case 'dataPortalApiKey':
                    return !isOpaqueSecret(normalized, 2_048);
                case 'proxyTokenSha256':
                    return !SHA256_HEX_PATTERN.test(normalized);
                case 'allowedHosts':
                    return !hasValidAllowedHosts(normalized);
            }
        })
        .map(([key]) => key);
    if (!hasValidOptionalAllowedHosts(input.allowedOrigins)) {
        invalid.push('allowedOrigins');
    }
    const numericSettings: Array<[
        Extract<
            GisMcpConfigurationFieldV1,
            | 'requestsPerMinute'
            | 'globalRequestsPerMinute'
            | 'requestDeadlineMs'
            | 'maxConcurrency'
            | 'maxQueue'
        >,
        number,
        number,
        number,
    ]> = [
        ['requestsPerMinute', input.requestsPerMinute, 1, 1_000],
        ['globalRequestsPerMinute', input.globalRequestsPerMinute, 1, 1_000],
        ['requestDeadlineMs', input.requestDeadlineMs, 1, 5 * 60_000],
        ['maxConcurrency', input.maxConcurrency, 1, 16],
        ['maxQueue', input.maxQueue, 0, 100],
    ];
    for (const [key, value, minimum, maximum] of numericSettings) {
        if (!isIntegerInRange(value, minimum, maximum)) invalid.push(key);
    }
    if (authentication.invalid) invalid.push('tokenAuthentication');

    const configured = missing.length === 0 && invalid.length === 0;
    return {
        configured,
        missing,
        invalid,
        authMode: authentication.authMode,
        registeredClientCount: authentication.registeredClientCount,
        registeredTokenCount: authentication.registeredTokenCount,
        providerMode: configured ? 'vworld_and_data_portal' : 'disabled',
    };
}
