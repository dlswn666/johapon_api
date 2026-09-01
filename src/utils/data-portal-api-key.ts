/**
 * 공공데이터포털은 일반 인증키와 URL 인코딩 인증키를 함께 제공한다.
 * HTTP client가 params를 직렬화하기 전에 URL 인코딩 키만 한 번 복원해
 * `%`가 다시 `%25`로 이중 인코딩되는 것을 막는다.
 */
export function normalizeDataPortalApiKey(value: string | null | undefined): string {
    const trimmed = value?.trim() ?? '';
    if (!trimmed || !/%[0-9a-f]{2}/i.test(trimmed)) return trimmed;

    try {
        return decodeURIComponent(trimmed);
    } catch {
        // 잘못된 percent escape가 섞인 값은 시작 단계에서 예외를 만들지 않는다.
        // provider가 기존 값으로 오류를 반환하게 두되, 원문은 로그에 남기지 않는다.
        return trimmed;
    }
}
