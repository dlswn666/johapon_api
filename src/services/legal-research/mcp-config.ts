export interface LegalMcpConfigurationInputV1 {
    lawApiOc: string;
    tokenSha256: string;
    packetSigningKey: string;
    allowedHosts: string;
}

export interface LegalMcpConfigurationStateV1 {
    configured: boolean;
    missing: Array<keyof LegalMcpConfigurationInputV1>;
    invalid: Array<keyof LegalMcpConfigurationInputV1>;
}

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

function isValidValue(
    key: keyof LegalMcpConfigurationInputV1,
    value: string
): boolean {
    const normalized = value.trim();
    switch (key) {
        case 'lawApiOc':
            // 국가법령정보 공동활용 OC는 account identifier다. query 구분자·공백은 허용하지 않는다.
            return normalized.length >= 3
                && normalized.length <= 200
                && !/[\s&#?]/.test(normalized);
        case 'tokenSha256':
            return /^[0-9a-f]{64}$/i.test(normalized);
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
    const entries = Object.entries(input) as Array<[
        keyof LegalMcpConfigurationInputV1,
        string,
    ]>;
    const missing = entries
        .filter(([, value]) => value.trim().length === 0)
        .map(([key]) => key);
    const missingSet = new Set(missing);
    const invalid = entries
        .filter(([key, value]) => !missingSet.has(key) && !isValidValue(key, value))
        .map(([key]) => key);

    return {
        configured: missing.length === 0 && invalid.length === 0,
        missing,
        invalid,
    };
}
