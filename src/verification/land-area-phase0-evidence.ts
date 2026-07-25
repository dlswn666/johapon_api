import type { HousingOtherPurposeSignal } from '../services/land-area-sync/housing-purpose-signals';

/**
 * Phase 0 v2에서만 쓰는 집합/공동주택 보강 증거다.
 *
 * 전역 주택 분류 allowlist를 넓히지 않고, 승인 manifest의 expectedFamily와
 * 대조할 수 있도록 exact 표제부 pair와 모순 없는 기타용도 신호만 인정한다.
 */
export function hasPhase0GenericLdaregTitleEvidence(
    rows: Array<{
        registryTypeCode?: unknown;
        mainPurposeCode?: unknown;
        mainPurposeLabel?: unknown;
        otherPurposeSignals?: unknown;
    }>,
    rootIdentityCount: number
): boolean {
    return (
        rootIdentityCount === 1 &&
        rows.length === 1 &&
        rows.every(
            (row) =>
                row.registryTypeCode === '2' &&
                row.mainPurposeCode === '02000' &&
                row.mainPurposeLabel === '공동주택' &&
                Array.isArray(row.otherPurposeSignals) &&
                (row.otherPurposeSignals as HousingOtherPurposeSignal[])
                    .length === 0
        )
    );
}

/**
 * 값 자체를 내보내지 않고 correlation 방식만 나타내는 sanitized witness다.
 * 실제 층 identity는 별도의 domain-separated SHA-256 hash로 고정한다.
 */
export const PHASE0_FLOOR_AS_UNIT_ABOVE_SHAPE =
    'FLOOR_AS_UNIT_ABOVE' as const;
export const PHASE0_FLOOR_AS_UNIT_BASEMENT_SHAPE =
    'FLOOR_AS_UNIT_BASEMENT' as const;

export type Phase0FloorAsUnitShape =
    | typeof PHASE0_FLOOR_AS_UNIT_ABOVE_SHAPE
    | typeof PHASE0_FLOOR_AS_UNIT_BASEMENT_SHAPE;

export function isPhase0FloorAsUnitShape(
    value: unknown
): value is Phase0FloorAsUnitShape {
    return (
        value === PHASE0_FLOOR_AS_UNIT_ABOVE_SHAPE ||
        value === PHASE0_FLOOR_AS_UNIT_BASEMENT_SHAPE
    );
}
