import type { HousingOtherPurposeSignal } from './housing-purpose-signals';

/**
 * 주택 유형 분류용 공식 (대장구분·주용도) exact pair frozen fixture (DESIGN §9.1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ Phase 0 실측 확정 전 PLACEHOLDER ⚠️
 *
 * 아래 `mainPurpsCd` / `mainPurpsCdNm` / `regstrGbCd` 값은 국토교통부 건축물대장
 * codebook의 표준 코드를 근거로 잠정 기입한 것이다. Phase 0에서 실제 운영 응답으로
 * 코드·명칭 표기(공백·괄호·유사 명칭 등)를 실측 확정하기 전까지는 placeholder이며,
 * 확정 시 이 파일의 상수만 교체한다(코드 로직·env 변경 없음).
 *
 * 확정된 pair만 허용한다. `mainPurpsCdNm.includes('주택')` 같은 substring 분류는
 * 절대 사용하지 않는다 (DESIGN §9.1). 매칭은 (regstrGbCd, mainPurpsCd, mainPurpsCdNm)
 * 세 필드가 정확히 일치할 때만 성립한다.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** 주택 세부 유형 */
export type HousingCategory = 'DETACHED' | 'MULTIFAMILY' | 'MULTIPLEX';

/** 자동 적용 전략 계열 (DESIGN §9.2) */
export type HousingStrategyFamily = 'LADFRL' | 'LDAREG';

/**
 * 부속용도 토큰이 없을 때 법정 규모 기준으로 대체 인정하는 상한 (건축법 시행령 별표1).
 *
 * 두 대용값은 **모두 보수적인 방향**이다. 잘못 거부할 수는 있어도 잘못 승인할 수는 없다.
 *  - `totArea`(연면적)는 지하·비주거를 포함하므로 주택 바닥면적 합계 이상이다.
 *    따라서 660 이하면 주택 부분도 반드시 660 이하다 → 연립주택(660㎡ 초과) 통과 불가.
 *  - `grndFlrCnt`(지상 층수)는 주택으로 쓰는 층수 이상이다.
 *    따라서 4 이하면 주택 층수도 반드시 4 이하다 → 아파트(5개 층 이상) 통과 불가.
 */
export interface HousingScaleFallbackLimit {
    /** 지상 층수 상한(이하). */
    readonly maxGroundFloorCount: number;
    /** 연면적 상한(㎡, 이하). */
    readonly maxTotalFloorAreaSqm: number;
}

/** 공식 (대장구분·주용도) pair 1건 */
export interface HousingPurposePair {
    /** 대장 구분: 1=일반, 2=집합 */
    regstrGbCd: '1' | '2';
    /** 주용도 코드 (Phase 0 placeholder) */
    mainPurpsCd: string;
    /** 주용도 명 (Phase 0 placeholder) */
    mainPurpsCdNm: string;
    /** 기타용도에서 exact-token으로 추가 확인해야 하는 경우의 고정 신호. */
    requiredOtherPurposeSignal?: HousingOtherPurposeSignal;
    /**
     * 위 토큰이 없을 때만 쓰는 법정 규모 기준 대체 근거 (DESIGN §9.2).
     * 토큰이 있으면 규모 검사 없이 통과한다 — 규모 기준은 토큰을 대체하지 않고 보완한다.
     */
    requiredScaleFallback?: HousingScaleFallbackLimit;
    category: HousingCategory;
    family: HousingStrategyFamily;
}

/**
 * 자동 진행이 허용되는 공식 pair allowlist (DESIGN §9.2 결정표 상단 3종).
 * - 단독주택 / 다가구주택: 일반(regstrGbCd=1) → LADFRL 계열
 * - 다세대주택:            집합(regstrGbCd=2) → LDAREG 계열
 */
export const HOUSING_PURPOSE_ALLOWLIST: readonly HousingPurposePair[] = [
    // 단독주택 (일반건축물) — LADFRL
    { regstrGbCd: '1', mainPurpsCd: '01000', mainPurpsCdNm: '단독주택', category: 'DETACHED', family: 'LADFRL' },
    // 다가구주택 (일반건축물) — LADFRL
    { regstrGbCd: '1', mainPurpsCd: '01002', mainPurpsCdNm: '다가구주택', category: 'MULTIFAMILY', family: 'LADFRL' },
    // 다세대주택 (집합건축물) — LDAREG
    { regstrGbCd: '2', mainPurpsCd: '02003', mainPurpsCdNm: '다세대주택', category: 'MULTIPLEX', family: 'LDAREG' },
    // Phase 0 실측: 집합/공동주택 + 기타용도 exact token 다세대주택 — LDAREG
    // 2026-07-30 실측(미아7 791-2282): 부속용도 원문이 주용도와 같은 `공동주택`이어서
    // 토큰 추가 방식이 성립하지 않는다. 토큰이 없을 때만 법정 규모 기준으로 인정한다.
    {
        regstrGbCd: '2',
        mainPurpsCd: '02000',
        mainPurpsCdNm: '공동주택',
        requiredOtherPurposeSignal: 'MULTIPLEX_HOUSE',
        requiredScaleFallback: {
            maxGroundFloorCount: 4,
            maxTotalFloorAreaSqm: 660,
        },
        category: 'MULTIPLEX',
        family: 'LDAREG',
    },
] as const;

/**
 * "인지 가능하지만 v1에서 미지원"인 주택 유형 명칭 (DESIGN §9.2).
 *
 * ⚠️ Phase 0 placeholder — exact 전체 문자열 일치로만 사용한다(substring 아님).
 * 이 목록은 REVIEW 사유를 `UNSUPPORTED_HOUSING_TYPE`로 더 구체화하기 위한 용도일 뿐이며,
 * 어떤 경우에도 자동 적용(allowlist)으로 승격시키지 않는다. 즉 안전한 방향(REVIEW)에서
 * 이유만 세분화한다.
 */
export const UNSUPPORTED_HOUSING_TYPE_NAMES: readonly string[] = [
    '아파트',
    '연립주택',
    '다중주택',
] as const;
