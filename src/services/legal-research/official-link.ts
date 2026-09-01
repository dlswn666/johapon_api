import { LegalOpenApiError } from './errors';

const OFFICIAL_LAW_HOSTS = new Set([
    'law.go.kr',
    'www.law.go.kr',
    'open.law.go.kr',
]);

const SENSITIVE_QUERY_KEYS = new Set([
    'oc',
    'token',
    'access_token',
    'authorization',
    'auth',
    'apikey',
    'api_key',
    'key',
    'servicekey',
    'jwt',
    'signature',
]);

export interface OfficialLinkIdentifierExpectation {
    value: string;
    queryKeys: readonly string[];
}

export interface OfficialLinkExpectation {
    identifiers?: readonly OfficialLinkIdentifierExpectation[];
    requireIdentifier?: boolean;
}

function findValuesByCaseInsensitiveKey(url: URL, keys: readonly string[]): string[] {
    const lowered = new Set(keys.map((key) => key.toLowerCase()));
    const values: string[] = [];
    for (const [key, value] of url.searchParams.entries()) {
        if (lowered.has(key.toLowerCase())) values.push(value);
    }
    return values;
}

function assertExpectedIdentity(url: URL, expectation: OfficialLinkExpectation): void {
    const identifiers = expectation.identifiers ?? [];
    let foundIdentifier = false;

    for (const identifier of identifiers) {
        const expectedValue = identifier.value.trim();
        if (!expectedValue) continue;
        const actualValues = findValuesByCaseInsensitiveKey(url, identifier.queryKeys);
        if (actualValues.length === 0) continue;
        foundIdentifier = true;
        if (actualValues.some((value) => value !== expectedValue)) {
            throw new LegalOpenApiError('SOURCE_MISMATCH');
        }
    }

    if (expectation.requireIdentifier && identifiers.length > 0 && !foundIdentifier) {
        throw new LegalOpenApiError('SOURCE_MISMATCH');
    }
}

/**
 * 법제처 응답 링크를 공개 가능한 HTTPS 링크로 정규화합니다.
 * 임의 하위 도메인, 사용자정보, 비표준 포트와 인증 query는 허용하지 않습니다.
 */
export function sanitizeOfficialLawLink(
    rawLink: string,
    expectation: OfficialLinkExpectation = {},
): string {
    const trimmed = rawLink.trim();
    if (!trimmed) throw new LegalOpenApiError('SOURCE_MISMATCH');

    let url: URL;
    try {
        url = new URL(trimmed, 'https://www.law.go.kr');
    } catch (error) {
        throw new LegalOpenApiError('SOURCE_MISMATCH', { cause: error });
    }

    const hostname = url.hostname.toLowerCase();
    if (!OFFICIAL_LAW_HOSTS.has(hostname)) {
        throw new LegalOpenApiError('SOURCE_MISMATCH');
    }
    if (url.username || url.password || (url.port && url.port !== '443')) {
        throw new LegalOpenApiError('SOURCE_MISMATCH');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new LegalOpenApiError('SOURCE_MISMATCH');
    }

    assertExpectedIdentity(url, expectation);

    url.protocol = 'https:';
    url.hostname = hostname;
    url.port = '';
    for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
            url.searchParams.delete(key);
        }
    }
    return url.toString();
}

export function sanitizeOptionalOfficialLawLink(
    rawLink: string | undefined,
    expectation: OfficialLinkExpectation = {},
): string | undefined {
    if (!rawLink?.trim()) return undefined;
    return sanitizeOfficialLawLink(rawLink, expectation);
}

export function isOfficialLawLink(value: string): boolean {
    try {
        return sanitizeOfficialLawLink(value) === new URL(value).toString();
    } catch {
        return false;
    }
}
