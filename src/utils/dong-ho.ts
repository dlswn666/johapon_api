/**
 * 동호수 정규화 — 재건축 P2
 *
 * 정본은 tonghari-web 의 `app/_lib/shared/utils/dong-ho-utils.ts` 다.
 * 이 파일은 그 동작을 그대로 옮긴 것이며 규칙을 새로 만들지 않는다.
 *
 * 동일한 golden 벡터가 세 곳에서 검증된다:
 *   - web:  tests/unit/shared/dongNormalizationGolden.test.ts
 *   - SQL:  scripts/database/dong-normalize.sql
 *   - api:  tests/dong-normalization-golden.test.ts (이 파일)
 *
 * 셋이 어긋나면 분할 dry-run 과 실제 분할이 서로 다른 건물 집합을 고르고,
 * 수집 시 전유부가 엉뚱한 동에 귀속된다. 규칙을 바꾸려면 세 구현과
 * 분할 대상 ID 해시를 한 커밋에서 함께 고친다.
 */

/**
 * 동 번호 정규화 (접두사/접미사 제거 + 지하 표시 통일)
 *
 * @example
 * normalizeDong("101동")        // "101"
 * normalizeDong("가동")          // "가"
 * normalizeDong("제1호")         // "1"
 * normalizeDong("지하1")         // "B1"
 * normalizeDong("지01")          // "B01"
 * normalizeDong("주건축물제1동")  // "주건축물제1"
 * normalizeDong("에이")          // "에이"  (A 와 합치지 않는다)
 * normalizeDong(null)           // null
 */
export function normalizeDong(dong: string | null | undefined): string | null {
    if (!dong) return null;

    let normalized = dong.trim();

    // "제" 접두사 제거 (예: "제1호" -> "1호")
    normalized = normalized.replace(/^제/g, '');

    // "동", "호", "층" 접미사 제거
    normalized = normalized.replace(/(동|호|층)$/g, '');

    // 지하 표시 통일 (비, 지하, 지 → B)
    normalized = normalized.replace(/^비/g, 'B');
    normalized = normalized.replace(/^지하/g, 'B');
    normalized = normalized.replace(/^지(?=\d)/g, 'B');

    return normalized.trim() || null;
}

/**
 * 호수 정규화 (접미사 제거 + 지하층 표시 통일)
 *
 * @example
 * normalizeHo("1001호")  // "1001"
 * normalizeHo("비01")    // "B01"
 * normalizeHo("지하101") // "B101"
 */
export function normalizeHo(ho: string | null | undefined): string | null {
    if (!ho) return null;

    let normalized = ho.trim();

    // "호" 접미사 제거
    normalized = normalized.replace(/호$/g, '');

    // 지하 표시 통일 (비, 지하, 지 → B)
    normalized = normalized.replace(/^비/g, 'B');
    normalized = normalized.replace(/^지하/g, 'B');
    normalized = normalized.replace(/^지(?=\d)/g, 'B');

    return normalized.trim() || null;
}
