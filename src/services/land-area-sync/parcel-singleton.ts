/**
 * 건축물 분류가 확정되지 않은 단일 필지의 parcel-level property_unit 판정.
 *
 * 이 경로는 건축물 용도를 추정하지 않는다. 공통 scope gate의 유일한 차단 사유가
 * BUILDING_CLASSIFICATION_CONFLICT이고, DB에 활성 property_unit이 정확히 1건이며
 * 물건과 연결 building_unit 모두 동·층·호·등기 외부 ID가 없는 경우에만
 * LADFRL 후보로 승격한다. 따라서 호별 대지권이 필요한 집합건물은 이 경로를
 * 통과할 수 없다.
 */

import type {
    BuildingUnitCandidate,
    PropertyUnitCandidate,
} from './matcher';

export interface ParcelSingletonLadfrlInput {
    unionId: string;
    targetPnu: string;
    scannedPnus: readonly string[];
    membership: unknown[];
    propertyUnits: readonly PropertyUnitCandidate[];
    buildingUnits: readonly BuildingUnitCandidate[];
}

export type ParcelSingletonLadfrlDecision =
    | {
          kind: 'ELIGIBLE';
          propertyUnitId: string;
          basis: 'CLASSIFICATION_CONFLICT_DB_PARCEL_SINGLETON';
      }
    | {
          kind: 'REJECTED';
          reason:
              | 'SCOPE_NOT_SINGLE'
              | 'MEMBERSHIP_NOT_SINGLE'
              | 'PROPERTY_UNIT_NOT_SINGLE'
              | 'PROPERTY_UNIT_IDENTITY_MISMATCH'
              | 'PROPERTY_UNIT_HAS_UNIT_IDENTITY'
              | 'BUILDING_UNIT_LINK_MISSING'
              | 'BUILDING_UNIT_HAS_UNIT_IDENTITY'
              | 'UNLINKED_BUILDING_UNITS_PRESENT';
      };

export interface ParcelComponentLadfrlTarget {
    propertyUnitId: string;
    targetPnu: string;
}

export interface ParcelComponentLadfrlInput {
    unionId: string;
    canonicalBasePnu: string;
    memberPnus: readonly string[];
    propertyUnits: readonly PropertyUnitCandidate[];
    buildingUnits: readonly BuildingUnitCandidate[];
}

export type ParcelComponentLadfrlDecision =
    | {
          kind: 'ELIGIBLE';
          basis: 'OFFICIAL_COMPONENT_DB_PARCEL_SINGLETONS';
          targets: ParcelComponentLadfrlTarget[];
          queryOnlyPnus: string[];
      }
    | {
          kind: 'REJECTED';
          reason:
              | 'SCOPE_NOT_MULTI'
              | 'CANONICAL_PROPERTY_MISSING'
              | 'PROPERTY_UNIT_SCOPE_MISMATCH'
              | 'PROPERTY_UNIT_ID_DUPLICATED'
              | 'PROPERTY_UNIT_NOT_SINGLE_PER_PNU'
              | 'PROPERTY_UNIT_HAS_UNIT_IDENTITY'
              | 'BUILDING_UNIT_LINK_MISSING'
              | 'BUILDING_UNIT_HAS_UNIT_IDENTITY'
              | 'UNLINKED_BUILDING_UNITS_PRESENT';
      };

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function membershipRows(value: unknown[]): Array<Record<string, unknown>> {
    return value.filter(
        (row): row is Record<string, unknown> =>
            row !== null && typeof row === 'object' && !Array.isArray(row)
    );
}

function hasUnitIdentity(
    unit: Pick<
        BuildingUnitCandidate,
        'dong' | 'floor' | 'ho' | 'registryExternalId'
    >
): boolean {
    return (
        text(unit.dong) !== '' ||
        text(unit.floor) !== '' ||
        text(unit.ho) !== '' ||
        text(unit.registryExternalId) !== ''
    );
}

/**
 * repo-pinned DEV 전체 갱신의 same-run 공식 multi-PNU component를 LADFRL
 * 물건지들로 판정한다.
 *
 * 공식 component 자체는 scope.ts의 title/attached/bylot closure가 먼저 확정한다.
 * 여기서는 현재 활성 property를 다시 읽어 각 property-bearing PNU가 정확히 1건이고
 * 호실 identity가 전혀 없음을 확인한다. property가 없는 부속 PNU는 query-only
 * provenance로만 남기며, canonical base PNU에는 반드시 활성 property가 있어야 한다.
 *
 * MANUAL/land_area/source 값은 입력 계약에 없고 판정에 사용하지 않는다.
 */
export function resolveParcelComponentLadfrlCandidates(
    input: ParcelComponentLadfrlInput
): ParcelComponentLadfrlDecision {
    const memberPnus = [...new Set(input.memberPnus)].sort();
    if (
        memberPnus.length <= 1 ||
        memberPnus.length !== input.memberPnus.length ||
        !memberPnus.includes(input.canonicalBasePnu)
    ) {
        return { kind: 'REJECTED', reason: 'SCOPE_NOT_MULTI' };
    }

    const active = input.propertyUnits.filter((row) => !row.isDeleted);
    if (
        active.some(
            (row) =>
                row.unionId !== input.unionId ||
                typeof row.pnu !== 'string' ||
                !memberPnus.includes(row.pnu)
        )
    ) {
        return {
            kind: 'REJECTED',
            reason: 'PROPERTY_UNIT_SCOPE_MISMATCH',
        };
    }
    if (new Set(active.map((row) => row.id)).size !== active.length) {
        return {
            kind: 'REJECTED',
            reason: 'PROPERTY_UNIT_ID_DUPLICATED',
        };
    }

    const activeByPnu = new Map<string, PropertyUnitCandidate[]>();
    for (const property of active) {
        const pnu = property.pnu as string;
        const rows = activeByPnu.get(pnu) ?? [];
        rows.push(property);
        activeByPnu.set(pnu, rows);
    }
    if (!activeByPnu.has(input.canonicalBasePnu)) {
        return {
            kind: 'REJECTED',
            reason: 'CANONICAL_PROPERTY_MISSING',
        };
    }
    if (
        [...activeByPnu.values()].some((properties) => properties.length !== 1)
    ) {
        return {
            kind: 'REJECTED',
            reason: 'PROPERTY_UNIT_NOT_SINGLE_PER_PNU',
        };
    }
    if (
        active.some(
            (property) =>
                text(property.dong) !== '' || text(property.ho) !== ''
        )
    ) {
        return {
            kind: 'REJECTED',
            reason: 'PROPERTY_UNIT_HAS_UNIT_IDENTITY',
        };
    }

    if (
        new Set(input.buildingUnits.map((row) => row.id)).size !==
        input.buildingUnits.length
    ) {
        return {
            kind: 'REJECTED',
            reason: 'BUILDING_UNIT_LINK_MISSING',
        };
    }
    if (input.buildingUnits.some(hasUnitIdentity)) {
        return {
            kind: 'REJECTED',
            reason: 'BUILDING_UNIT_HAS_UNIT_IDENTITY',
        };
    }
    for (const property of active) {
        if (property.buildingUnitId === null) {
            if (input.buildingUnits.length > 0) {
                return {
                    kind: 'REJECTED',
                    reason: 'UNLINKED_BUILDING_UNITS_PRESENT',
                };
            }
            continue;
        }
        if (
            input.buildingUnits.filter(
                (row) => row.id === property.buildingUnitId
            ).length !== 1
        ) {
            return {
                kind: 'REJECTED',
                reason: 'BUILDING_UNIT_LINK_MISSING',
            };
        }
    }

    const targets = active
        .map((property) => ({
            propertyUnitId: property.id,
            targetPnu: property.pnu as string,
        }))
        .sort(
            (left, right) =>
                left.targetPnu.localeCompare(right.targetPnu) ||
                left.propertyUnitId.localeCompare(right.propertyUnitId)
        );
    const propertyPnus = new Set(targets.map((target) => target.targetPnu));
    return {
        kind: 'ELIGIBLE',
        basis: 'OFFICIAL_COMPONENT_DB_PARCEL_SINGLETONS',
        targets,
        queryOnlyPnus: memberPnus.filter((pnu) => !propertyPnus.has(pnu)),
    };
}

export function resolveParcelSingletonLadfrlCandidate(
    input: ParcelSingletonLadfrlInput
): ParcelSingletonLadfrlDecision {
    const scannedPnus = [...new Set(input.scannedPnus)].sort();
    if (
        scannedPnus.length !== 1 ||
        scannedPnus[0] !== input.targetPnu
    ) {
        return { kind: 'REJECTED', reason: 'SCOPE_NOT_SINGLE' };
    }

    const memberIds = [
        ...new Set(
            membershipRows(input.membership)
                .filter(
                    (row) =>
                        text(row.pnu) === input.targetPnu &&
                        text(row.propertyUnitId) !== ''
                )
                .map((row) => text(row.propertyUnitId))
        ),
    ];
    if (memberIds.length !== 1) {
        return {
            kind: 'REJECTED',
            reason: 'MEMBERSHIP_NOT_SINGLE',
        };
    }

    const active = input.propertyUnits.filter(
        (row) =>
            row.unionId === input.unionId &&
            row.pnu === input.targetPnu &&
            row.isDeleted === false
    );
    if (active.length !== 1) {
        return {
            kind: 'REJECTED',
            reason: 'PROPERTY_UNIT_NOT_SINGLE',
        };
    }
    const property = active[0];
    if (property.id !== memberIds[0]) {
        return {
            kind: 'REJECTED',
            reason: 'PROPERTY_UNIT_IDENTITY_MISMATCH',
        };
    }
    if (text(property.dong) !== '' || text(property.ho) !== '') {
        return {
            kind: 'REJECTED',
            reason: 'PROPERTY_UNIT_HAS_UNIT_IDENTITY',
        };
    }

    if (property.buildingUnitId === null) {
        if (input.buildingUnits.length > 0) {
            return {
                kind: 'REJECTED',
                reason: 'UNLINKED_BUILDING_UNITS_PRESENT',
            };
        }
    } else {
        const linked = input.buildingUnits.filter(
            (row) => row.id === property.buildingUnitId
        );
        if (linked.length !== 1) {
            return {
                kind: 'REJECTED',
                reason: 'BUILDING_UNIT_LINK_MISSING',
            };
        }
        if (
            hasUnitIdentity(linked[0]) ||
            input.buildingUnits.some(hasUnitIdentity)
        ) {
            return {
                kind: 'REJECTED',
                reason: 'BUILDING_UNIT_HAS_UNIT_IDENTITY',
            };
        }
    }

    return {
        kind: 'ELIGIBLE',
        propertyUnitId: property.id,
        basis: 'CLASSIFICATION_CONFLICT_DB_PARCEL_SINGLETON',
    };
}
