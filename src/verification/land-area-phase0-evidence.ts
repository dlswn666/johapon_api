import type { HousingOtherPurposeSignal } from '../services/land-area-sync/housing-purpose-signals';
import {
    PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX,
    PROVIDER_UNIT_BRIDGE_BASEMENT_B_HO,
    PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE,
    PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_BASEMENT,
} from '../services/land-area-sync/provider-unit-shape-bridge';

/**
 * Phase 0 v2에서만 쓰는 집합/공동주택 보강 증거다.
 *
 * 전역 주택 분류 allowlist를 넓히지 않고, 승인 manifest의 expectedFamily와
 * 대조할 수 있도록 exact 표제부 pair와 모순 없는 기타용도 신호만 인정한다.
 */
export function hasPhase0GenericLdaregTitleEvidence(
    rows: Array<{
        registryTypeCode?: unknown;
        registryTypeLabel?: unknown;
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
                row.registryTypeLabel === '집합' &&
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
    PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE;
export const PHASE0_FLOOR_AS_UNIT_BASEMENT_SHAPE =
    PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_BASEMENT;
export const PHASE0_PROVIDER_ABOVE_NO_SUFFIX_SHAPE =
    PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX;
export const PHASE0_PROVIDER_BASEMENT_B_HO_SHAPE =
    PROVIDER_UNIT_BRIDGE_BASEMENT_B_HO;

export type Phase0FloorAsUnitShape =
    | typeof PHASE0_FLOOR_AS_UNIT_ABOVE_SHAPE
    | typeof PHASE0_FLOOR_AS_UNIT_BASEMENT_SHAPE
    | typeof PHASE0_PROVIDER_ABOVE_NO_SUFFIX_SHAPE
    | typeof PHASE0_PROVIDER_BASEMENT_B_HO_SHAPE;

export function isPhase0FloorAsUnitShape(
    value: unknown
): value is Phase0FloorAsUnitShape {
    return (
        value === PHASE0_FLOOR_AS_UNIT_ABOVE_SHAPE ||
        value === PHASE0_FLOOR_AS_UNIT_BASEMENT_SHAPE ||
        value === PHASE0_PROVIDER_ABOVE_NO_SUFFIX_SHAPE ||
        value === PHASE0_PROVIDER_BASEMENT_B_HO_SHAPE
    );
}

export function isPhase0LegacyFloorAsUnitShape(
    value: unknown
): value is
    | typeof PHASE0_FLOOR_AS_UNIT_ABOVE_SHAPE
    | typeof PHASE0_FLOOR_AS_UNIT_BASEMENT_SHAPE {
    return (
        value === PHASE0_FLOOR_AS_UNIT_ABOVE_SHAPE ||
        value === PHASE0_FLOOR_AS_UNIT_BASEMENT_SHAPE
    );
}

interface Phase0BridgeCorrelationRecord {
    unitIdentityShape?: unknown;
    unitIdentityHash?: unknown;
    floorHoIdentityHash?: unknown;
    dongIdentityHash?: unknown;
    providerUnitBridgeHash?: unknown;
    providerUnitBridgeKind?: unknown;
}

function exactUniqueHashSet(left: string[], right: string[]): boolean {
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    return (
        left.length > 0 &&
        leftSet.size === left.length &&
        rightSet.size === right.length &&
        leftSet.size === rightSet.size &&
        [...leftSet].every((value) => rightSet.has(value))
    );
}

/**
 * raw identity hash가 다른 exact provider 표기 bridge를 검증한다.
 *
 * producer와 독립 validator가 같은 구조적 계약을 사용한다:
 * - scope EXPOS와 endpoint inventory의 full unit witness가 exact unique set
 * - standard floor-ho exact pair를 먼저 소진하고 남은 양쪽만 bridge로 결속
 * - valid LDAREG와 EXPOS가 누락·extra 없이 최종 unique 1:1
 * - missing placeholder hash는 위 set과 disjoint
 * - bridge hash마다 양 endpoint의 sanitized witness 종류가 exact 같음
 * - 동은 양쪽 exact 같거나, 한쪽만 있을 때 그쪽이 단일 동이어야 함
 * - 호출측이 단일 LDAREG building identity를 별도 증명해야 함
 */
export function hasPhase0ProviderUnitBridgeCorrelation(input: {
    scopeExposRecords: readonly Phase0BridgeCorrelationRecord[];
    exposInventoryRecords: readonly Phase0BridgeCorrelationRecord[];
    validLdaregRecords: readonly Phase0BridgeCorrelationRecord[];
    missingLdaregRecords: readonly Phase0BridgeCorrelationRecord[];
    singleLdaregBuildingIdentity: boolean;
}): boolean {
    const {
        scopeExposRecords,
        exposInventoryRecords,
        validLdaregRecords,
        missingLdaregRecords,
        singleLdaregBuildingIdentity,
    } = input;
    if (
        !singleLdaregBuildingIdentity ||
        scopeExposRecords.length === 0 ||
        exposInventoryRecords.length !== scopeExposRecords.length ||
        validLdaregRecords.length !== scopeExposRecords.length
    ) {
        return false;
    }

    const stringField = (
        record: Phase0BridgeCorrelationRecord,
        field:
            | 'unitIdentityHash'
            | 'floorHoIdentityHash'
            | 'providerUnitBridgeHash'
    ): string | null =>
        typeof record[field] === 'string'
            ? record[field] as string
            : null;
    const scopeUnitHashes = scopeExposRecords.map((record) =>
        stringField(record, 'unitIdentityHash')
    );
    const inventoryUnitHashes = exposInventoryRecords.map(
        (record) => stringField(record, 'unitIdentityHash')
    );
    const recordBindingKey = (
        record: Phase0BridgeCorrelationRecord
    ): string | null => {
        const unitIdentityHash = stringField(
            record,
            'unitIdentityHash'
        );
        const floorHoIdentityHash = stringField(
            record,
            'floorHoIdentityHash'
        );
        const dongIdentityHash =
            typeof record.dongIdentityHash === 'string'
                ? record.dongIdentityHash
                : null;
        const providerUnitBridgeHash = stringField(
            record,
            'providerUnitBridgeHash'
        );
        const providerUnitBridgeKind =
            record.providerUnitBridgeKind;
        const hasProviderHash = providerUnitBridgeHash !== null;
        const hasProviderKind = isPhase0FloorAsUnitShape(
            providerUnitBridgeKind
        );
        if (
            unitIdentityHash === null ||
            floorHoIdentityHash === null ||
            hasProviderHash !== hasProviderKind
        ) {
            return null;
        }
        return JSON.stringify([
            unitIdentityHash,
            floorHoIdentityHash,
            dongIdentityHash,
            providerUnitBridgeHash,
            hasProviderKind ? providerUnitBridgeKind : null,
        ]);
    };
    const scopeBindings = scopeExposRecords.map(recordBindingKey);
    const inventoryBindings =
        exposInventoryRecords.map(recordBindingKey);
    if (
        scopeUnitHashes.some((value) => value === null) ||
        inventoryUnitHashes.some((value) => value === null) ||
        scopeBindings.some((value) => value === null) ||
        inventoryBindings.some((value) => value === null) ||
        !exactUniqueHashSet(
            scopeUnitHashes as string[],
            inventoryUnitHashes as string[]
        ) ||
        !exactUniqueHashSet(
            scopeBindings as string[],
            inventoryBindings as string[]
        )
    ) {
        return false;
    }

    const exposFloorHo = exposInventoryRecords.map((record) =>
        stringField(record, 'floorHoIdentityHash')
    );
    const validFloorHo = validLdaregRecords.map((record) =>
        stringField(record, 'floorHoIdentityHash')
    );
    const missingUnitHashes = missingLdaregRecords.map(
        (record) => stringField(record, 'unitIdentityHash')
    );
    const missingFloorHoHashes = missingLdaregRecords.map(
        (record) => stringField(record, 'floorHoIdentityHash')
    );
    const exposFloorHoSet = new Set(exposFloorHo as string[]);
    if (
        exposFloorHo.some((value) => value === null) ||
        validFloorHo.some((value) => value === null) ||
        missingUnitHashes.some((value) => value === null) ||
        missingFloorHoHashes.some((value) => value === null) ||
        new Set(missingUnitHashes as string[]).size !==
            missingUnitHashes.length ||
        new Set(missingFloorHoHashes as string[]).size !==
            missingFloorHoHashes.length ||
        (missingUnitHashes as string[]).some((value) =>
            new Set(scopeUnitHashes as string[]).has(value)
        ) ||
        (missingFloorHoHashes as string[]).some((value) =>
            exposFloorHoSet.has(value)
        ) ||
        missingLdaregRecords.some(
            (record) =>
                record.providerUnitBridgeHash !== undefined ||
                record.providerUnitBridgeKind !== undefined
        )
    ) {
        return false;
    }

    const remainingExpos = new Set(
        exposInventoryRecords.map((_, index) => index)
    );
    const unmatchedLdareg = new Set(
        validLdaregRecords.map((_, index) => index)
    );
    const pairs: Array<{
        expos: Phase0BridgeCorrelationRecord;
        ldareg: Phase0BridgeCorrelationRecord;
    }> = [];

    // 1) 기존 standard floor+ho exact를 먼저 소진한다.
    const exposFloorHoCounts = new Map<string, number>();
    const validFloorHoCounts = new Map<string, number>();
    for (const hash of exposFloorHo as string[]) {
        exposFloorHoCounts.set(
            hash,
            (exposFloorHoCounts.get(hash) ?? 0) + 1
        );
    }
    for (const hash of validFloorHo as string[]) {
        validFloorHoCounts.set(
            hash,
            (validFloorHoCounts.get(hash) ?? 0) + 1
        );
    }
    for (let index = 0; index < validLdaregRecords.length; index += 1) {
        const sourceHash = validFloorHo[index] as string;
        if (
            exposFloorHoCounts.get(sourceHash) !== 1 ||
            validFloorHoCounts.get(sourceHash) !== 1
        ) {
            continue;
        }
        const matches = [...remainingExpos].filter(
            (exposIndex) =>
                exposFloorHo[exposIndex] === sourceHash
        );
        if (matches.length !== 1) continue;
        const exposIndex = matches[0];
        pairs.push({
            expos: exposInventoryRecords[exposIndex],
            ldareg: validLdaregRecords[index],
        });
        remainingExpos.delete(exposIndex);
        unmatchedLdareg.delete(index);
    }

    // 2) 남은 행만 optional provider witness exact hash+kind로 결속한다.
    let bridgeCount = 0;
    for (const ldaregIndex of [...unmatchedLdareg]) {
        const ldareg = validLdaregRecords[ldaregIndex];
        const sourceBridgeHash = stringField(
            ldareg,
            'providerUnitBridgeHash'
        );
        const sourceBridgeKind =
            ldareg.providerUnitBridgeKind;
        if (
            sourceBridgeHash === null ||
            !isPhase0FloorAsUnitShape(sourceBridgeKind)
        ) {
            return false;
        }
        const matches = [...remainingExpos].filter(
            (exposIndex) => {
                const expos =
                    exposInventoryRecords[exposIndex];
                return (
                    stringField(
                        expos,
                        'providerUnitBridgeHash'
                    ) === sourceBridgeHash &&
                    expos.providerUnitBridgeKind ===
                        sourceBridgeKind
                );
            }
        );
        if (matches.length !== 1) return false;
        const exposIndex = matches[0];
        pairs.push({
            expos: exposInventoryRecords[exposIndex],
            ldareg,
        });
        remainingExpos.delete(exposIndex);
        unmatchedLdareg.delete(ldaregIndex);
        bridgeCount += 1;
    }
    if (
        bridgeCount === 0 ||
        remainingExpos.size !== 0 ||
        unmatchedLdareg.size !== 0 ||
        pairs.length !== validLdaregRecords.length
    ) {
        return false;
    }

    const oneSidedDirections = new Set<string>();
    const oneSidedDongHashes = new Set<string>();
    const allDongHashes = new Set<string>();
    for (const pair of pairs) {
        const exposDong =
            typeof pair.expos.dongIdentityHash === 'string'
                ? pair.expos.dongIdentityHash
                : null;
        const ldaregDong =
            typeof pair.ldareg.dongIdentityHash === 'string'
                ? pair.ldareg.dongIdentityHash
                : null;
        if (exposDong !== null && ldaregDong !== null) {
            if (exposDong !== ldaregDong) return false;
            allDongHashes.add(exposDong);
            continue;
        }
        if (exposDong === null && ldaregDong === null) continue;
        oneSidedDirections.add(
            exposDong !== null ? 'EXPOS_ONLY' : 'LDAREG_ONLY'
        );
        oneSidedDongHashes.add(exposDong ?? ldaregDong!);
        allDongHashes.add(exposDong ?? ldaregDong!);
    }
    return (
        oneSidedDirections.size <= 1 &&
        oneSidedDongHashes.size <= 1 &&
        (oneSidedDongHashes.size === 0 || allDongHashes.size <= 1)
    );
}
