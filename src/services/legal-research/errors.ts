export type LegalOpenApiErrorCode =
    | 'AUTH'
    | 'IP_NOT_REGISTERED'
    | 'RATE_LIMITED'
    | 'UPSTREAM_TIMEOUT'
    | 'UPSTREAM_UNAVAILABLE'
    | 'CASE_DETAIL_NOT_FOUND'
    | 'RESPONSE_TOO_LARGE'
    | 'SCHEMA_DRIFT'
    | 'SOURCE_MISMATCH'
    | 'INVALID_REQUEST';

const SAFE_ERROR_MESSAGES: Record<LegalOpenApiErrorCode, string> = {
    AUTH: '법령정보 제공자 인증에 실패했습니다.',
    IP_NOT_REGISTERED: '법령정보 제공자에 등록된 호출 IP를 확인해야 합니다.',
    RATE_LIMITED: '법령정보 제공자의 호출 제한에 도달했습니다.',
    UPSTREAM_TIMEOUT: '법령정보 제공자가 제한 시간 안에 응답하지 않았습니다.',
    UPSTREAM_UNAVAILABLE: '법령정보 제공자를 일시적으로 사용할 수 없습니다.',
    CASE_DETAIL_NOT_FOUND: '판례 목록 항목의 상세 원문을 제공자가 반환하지 않았습니다.',
    RESPONSE_TOO_LARGE: '법령정보 제공자의 응답이 허용 크기를 초과했습니다.',
    SCHEMA_DRIFT: '법령정보 제공자의 응답 형식을 검증할 수 없습니다.',
    SOURCE_MISMATCH: '법령정보 출처의 식별자가 요청한 자료와 일치하지 않습니다.',
    INVALID_REQUEST: '법령정보 조회 요청이 올바르지 않습니다.',
};

const RETRYABLE_CODES = new Set<LegalOpenApiErrorCode>([
    'RATE_LIMITED',
    'UPSTREAM_TIMEOUT',
    'UPSTREAM_UNAVAILABLE',
]);

/**
 * 외부 응답, 요청 URL, OC 같은 인증값을 message에 포함하지 않는 provider 오류입니다.
 */
export class LegalOpenApiError extends Error {
    readonly retryable: boolean;

    constructor(
        readonly code: LegalOpenApiErrorCode,
        options: { retryable?: boolean; cause?: unknown } = {},
    ) {
        // upstream Error는 axios config/query에 OC나 질의 원문을 포함할 수 있어 보관하지 않는다.
        super(SAFE_ERROR_MESSAGES[code]);
        this.name = 'LegalOpenApiError';
        this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
    }
}

export function isLegalOpenApiError(error: unknown): error is LegalOpenApiError {
    return error instanceof LegalOpenApiError;
}

/** 운영 응답에 사용할 수 있는 고정 메시지만 반환합니다. */
export function safeLegalOpenApiMessage(code: LegalOpenApiErrorCode): string {
    return SAFE_ERROR_MESSAGES[code];
}
