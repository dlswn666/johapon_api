/** V-World 속성 API 요청 시작 간 기본 간격(ms). */
export const DEFAULT_VWORLD_ATTR_REQUEST_INTERVAL_MS = 300;
/** Node.js setTimeout이 지연값을 1ms로 축소하지 않고 보존하는 최대값. */
export const MAX_VWORLD_ATTR_REQUEST_INTERVAL_MS = 2_147_483_647;

const INTERVAL_ERROR_MESSAGE =
    `VWORLD_ATTR_REQUEST_INTERVAL_MS는 0~${MAX_VWORLD_ATTR_REQUEST_INTERVAL_MS} 범위의 정수(ms)여야 합니다.`;

/**
 * V-World 요청 간격을 fail-closed로 파싱한다.
 *
 * 미설정/빈 문자열만 기본값을 사용한다. 명시적인 0은 허용하지만 음수,
 * 소수, 일부만 숫자인 문자열, 비유한 값, Node.js timer 상한 초과는 거부한다.
 */
export function parseVworldRequestIntervalMs(value: unknown): number {
    if (value === undefined) {
        return DEFAULT_VWORLD_ATTR_REQUEST_INTERVAL_MS;
    }

    if (typeof value === 'string') {
        if (value.trim() === '') {
            return DEFAULT_VWORLD_ATTR_REQUEST_INTERVAL_MS;
        }
        if (!/^\d+$/.test(value)) {
            throw new Error(INTERVAL_ERROR_MESSAGE);
        }
        const parsed = Number(value);
        if (
            !Number.isSafeInteger(parsed) ||
            parsed > MAX_VWORLD_ATTR_REQUEST_INTERVAL_MS
        ) {
            throw new Error(INTERVAL_ERROR_MESSAGE);
        }
        return parsed;
    }

    if (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= MAX_VWORLD_ATTR_REQUEST_INTERVAL_MS
    ) {
        return value;
    }

    throw new Error(INTERVAL_ERROR_MESSAGE);
}
