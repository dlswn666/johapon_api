/**
 * 주택 유형 분류 (DESIGN §9).
 *
 * 현재 앱의 `building_type`이나 사용자 입력을 쓰지 않고, Building HUB 표제부의
 * (regstrGbCd, mainPurpsCd, mainPurpsCdNm) 공식 pair만으로 판정한다.
 *
 * 핵심 계약:
 *  - allowlist에 있는 exact (대장구분·주용도) pair만 자동 진행을 허용한다.
 *  - `mainPurpsCdNm.includes('주택')` 같은 substring 분류는 금지한다 (DESIGN §9.1).
 *  - 혼재(일반·집합/purpose pair)·빈 코드·code/name 불일치·root 복수는 REVIEW_REQUIRED.
 *  - §9.2 결정표의 분류 관련 전 행을 구현한다(자동 전략 확정은 scope gate와 결합해 결정).
 *  - `02000 공동주택` pair는 부속용도 토큰이 없을 때만 법정 규모 기준(지상 층수·연면적)으로
 *    다세대주택으로 인정한다. 규모 값 누락·파싱 실패는 REVIEW다 (DESIGN §9.2).
 */

import type { LandAreaSyncIssueCode } from '../../types/land-area-sync.types';
import {
    HOUSING_PURPOSE_ALLOWLIST,
    UNSUPPORTED_HOUSING_TYPE_NAMES,
    type HousingCategory,
    type HousingPurposePair,
    type HousingStrategyFamily,
} from './housing-purpose-allowlist.fixture';
import { housingOtherPurposeSignals } from './housing-purpose-signals';

/** 분류 입력. 분류에 필요한 표제부 필드와 root 관리번호 집합만 받는다. */
export interface HousingClassifierInput {
    titleRows: Array<{
        regstrGbCd?: string;
        mainPurpsCd?: string;
        mainPurpsCdNm?: string;
        etcPurps?: string;
        /** 지상 층수. `02000` pair 규모 기준 판정에만 쓴다 (DESIGN §9.2). */
        grndFlrCnt?: string | number;
        /** 연면적 ㎡. `02000` pair 규모 기준 판정에만 쓴다 (DESIGN §9.2). */
        totArea?: string | number;
    }>;
    /** DB resolver·title seed가 확정한 root 관리번호 집합(복수면 REVIEW). */
    rootIdentities: string[];
}

export type ClassificationReason =
    | 'NO_TITLE_ROWS'
    | 'MULTIPLE_ROOT_IDENTITIES'
    | 'MIXED_REGISTER_GB'
    | 'MIXED_PURPOSE_PAIR'
    | 'EMPTY_PURPOSE_CODE_OR_NAME'
    | 'CODE_NAME_MISMATCH'
    | 'REQUIRED_OTHER_PURPOSE_SIGNAL_MISSING'
    | 'CONTRADICTORY_OTHER_PURPOSE_SIGNAL'
    | 'HOUSING_SCALE_EVIDENCE_MISSING'
    | 'HOUSING_SCALE_EXCEEDS_MULTIPLEX_LIMIT'
    | 'UNSUPPORTED_HOUSING_TYPE'
    | 'NON_RESIDENTIAL_OR_MIXED';

export type HousingClassification =
    | { kind: 'CLASSIFIED'; family: HousingStrategyFamily; category: HousingCategory; regstrGbCd: '1' | '2' }
    | { kind: 'REVIEW_REQUIRED'; reason: ClassificationReason; issue: LandAreaSyncIssueCode };

function s(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function review(reason: ClassificationReason, issue: LandAreaSyncIssueCode): HousingClassification {
    return { kind: 'REVIEW_REQUIRED', reason, issue };
}

/** pair category별 유일하게 허용되는 기타용도 신호. */
function expectedOtherPurposeSignal(pair: HousingPurposePair) {
    return pair.category === 'DETACHED'
        ? 'DETACHED_HOUSE'
        : pair.category === 'MULTIFAMILY'
          ? 'MULTI_UNIT_HOUSE'
          : 'MULTIPLEX_HOUSE';
}

/**
 * 지상 층수 parser. 공백 제거 후 0 이상 safe integer만 valid하다.
 * 빈 값·null·음수·소수·비숫자·단위 접미사는 invalid이며 절대 0으로 보정하지 않는다.
 */
function parseGroundFloorCount(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!/^[0-9]+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * 연면적 parser. 공백 제거 후 양수 유한 십진수만 valid하다.
 * 0·음수·단위 포함 문자열은 invalid다 — 0은 상한 검사를 그냥 통과해버리므로 거부한다.
 */
function parseTotalFloorArea(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0 ? value : null;
    }
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

type HousingScaleCheck = 'OK' | 'EVIDENCE_MISSING' | 'EXCEEDS_LIMIT';

/**
 * 표제부 rows로 주택 유형을 분류한다 (DESIGN §9.2).
 * 자동 진행이 가능한 CLASSIFIED 또는 사유가 붙은 REVIEW_REQUIRED만 반환한다.
 */
export function classifyHousingType(inputData: HousingClassifierInput): HousingClassification {
    const { titleRows, rootIdentities } = inputData;

    // 분류할 표제부 없음(TITLE_COMPLETE_ZERO) → REVIEW
    if (titleRows.length === 0) {
        return review('NO_TITLE_ROWS', 'BUILDING_CLASSIFICATION_CONFLICT');
    }
    // root 관리번호 여러 개 → REVIEW
    if (new Set(rootIdentities.map((r) => s(r)).filter((r) => r.length > 0)).size > 1) {
        return review('MULTIPLE_ROOT_IDENTITIES', 'BUILDING_CLASSIFICATION_CONFLICT');
    }

    // 각 row 정규화 + 빈 코드·명칭 검사
    const norm = titleRows.map((r) => ({
        regstrGbCd: s(r.regstrGbCd),
        mainPurpsCd: s(r.mainPurpsCd),
        mainPurpsCdNm: s(r.mainPurpsCdNm),
        otherPurposeSignals: housingOtherPurposeSignals(r.etcPurps),
        // 규모 기준은 parser가 판정하므로 raw 값을 그대로 넘긴다.
        grndFlrCnt: r.grndFlrCnt,
        totArea: r.totArea,
    }));
    for (const r of norm) {
        if (!r.regstrGbCd || !r.mainPurpsCd || !r.mainPurpsCdNm) {
            return review('EMPTY_PURPOSE_CODE_OR_NAME', 'BUILDING_CLASSIFICATION_CONFLICT');
        }
    }

    // 일반·집합 혼재
    if (new Set(norm.map((r) => r.regstrGbCd)).size > 1) {
        return review('MIXED_REGISTER_GB', 'BUILDING_CLASSIFICATION_CONFLICT');
    }

    // purpose pair 혼재 — 모든 row가 정확히 같은 (대장구분·코드·명칭) 세트여야 한다
    const distinctPairs = new Set(norm.map((r) => `${r.regstrGbCd}|${r.mainPurpsCd}|${r.mainPurpsCdNm}`));
    if (distinctPairs.size > 1) {
        return review('MIXED_PURPOSE_PAIR', 'BUILDING_CLASSIFICATION_CONFLICT');
    }

    const one = norm[0];

    // allowlist exact (대장구분·코드·명칭) 조회
    const exactPairMatches = HOUSING_PURPOSE_ALLOWLIST.filter(
        (p) => p.regstrGbCd === one.regstrGbCd && p.mainPurpsCd === one.mainPurpsCd && p.mainPurpsCdNm === one.mainPurpsCdNm
    );

    /** 기대 신호 외의 토큰이 하나도 없는지 — 모순 신호 부재. */
    const noContradictorySignal = (pair: HousingPurposePair): boolean =>
        norm.every((row) =>
            row.otherPurposeSignals.every(
                (signal) => signal === expectedOtherPurposeSignal(pair)
            )
        );
    /** 요구 토큰까지 충족하는 기존 신호 경로. */
    const otherPurposeSignalSatisfied = (
        pair: HousingPurposePair
    ): boolean =>
        noContradictorySignal(pair) &&
        norm.every(
            (row) =>
                !pair.requiredOtherPurposeSignal ||
                row.otherPurposeSignals.includes(
                    pair.requiredOtherPurposeSignal
                )
        );
    /**
     * 법정 규모 기준 판정 (DESIGN §9.2). 모든 행이 상한 이내여야 인정한다.
     * 값 누락·파싱 실패는 0으로 보정하거나 다른 필드로 대체하지 않는다.
     */
    const scaleCheck = (pair: HousingPurposePair): HousingScaleCheck => {
        const limit = pair.requiredScaleFallback;
        if (!limit) return 'EVIDENCE_MISSING';
        for (const row of norm) {
            const floors = parseGroundFloorCount(row.grndFlrCnt);
            const area = parseTotalFloorArea(row.totArea);
            if (floors === null || area === null) return 'EVIDENCE_MISSING';
            if (
                floors > limit.maxGroundFloorCount ||
                area > limit.maxTotalFloorAreaSqm
            ) {
                return 'EXCEEDS_LIMIT';
            }
        }
        return 'OK';
    };

    const classified = (pair: HousingPurposePair): HousingClassification => ({
        kind: 'CLASSIFIED',
        family: pair.family,
        category: pair.category,
        regstrGbCd: pair.regstrGbCd,
    });

    // 1) 기존 부속용도 토큰 경로 — 규모 검사 없이 그대로 인정한다(§6.5).
    const signalMatched = exactPairMatches.find(otherPurposeSignalSatisfied);
    if (signalMatched) return classified(signalMatched);

    // 2) 토큰이 없을 때만 법정 규모 기준 대체 경로를 시도한다.
    const scaleMatched = exactPairMatches.find(
        (pair) =>
            pair.requiredScaleFallback !== undefined &&
            noContradictorySignal(pair) &&
            scaleCheck(pair) === 'OK'
    );
    if (scaleMatched) return classified(scaleMatched);

    if (exactPairMatches.length > 0) {
        const pair = exactPairMatches[0];
        // 모순 신호는 규모 기준으로 덮지 않는다 — 먼저 차단한다.
        if (!noContradictorySignal(pair)) {
            return review(
                'CONTRADICTORY_OTHER_PURPOSE_SIGNAL',
                'BUILDING_CLASSIFICATION_CONFLICT'
            );
        }
        if (pair.requiredScaleFallback) {
            return review(
                scaleCheck(pair) === 'EXCEEDS_LIMIT'
                    ? 'HOUSING_SCALE_EXCEEDS_MULTIPLEX_LIMIT'
                    : 'HOUSING_SCALE_EVIDENCE_MISSING',
                'BUILDING_CLASSIFICATION_CONFLICT'
            );
        }
        return review(
            'REQUIRED_OTHER_PURPOSE_SIGNAL_MISSING',
            'BUILDING_CLASSIFICATION_CONFLICT'
        );
    }

    // 인지 가능하지만 미지원(아파트·연립·다중) — exact 명칭 일치로만 사유를 세분화(자동 승격 아님)
    if (UNSUPPORTED_HOUSING_TYPE_NAMES.includes(one.mainPurpsCdNm)) {
        return review('UNSUPPORTED_HOUSING_TYPE', 'UNSUPPORTED_HOUSING_TYPE');
    }

    // code/name 불일치인지(코드는 allowlist에 있으나 명칭·대장구분이 다름) 구체화
    const codeKnown = HOUSING_PURPOSE_ALLOWLIST.some((p) => p.mainPurpsCd === one.mainPurpsCd);
    const nameKnown = HOUSING_PURPOSE_ALLOWLIST.some((p) => p.mainPurpsCdNm === one.mainPurpsCdNm);
    if (codeKnown || nameKnown) {
        return review('CODE_NAME_MISMATCH', 'BUILDING_CLASSIFICATION_CONFLICT');
    }

    // 비주거·복합용도 등 그 외
    return review('NON_RESIDENTIAL_OR_MIXED', 'BUILDING_CLASSIFICATION_CONFLICT');
}
