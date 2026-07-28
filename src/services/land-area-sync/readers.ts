/**
 * LAND_AREA_SYNC 매칭 후보·현재 land tuple read-model (DESIGN §12.4·§13).
 *
 * matcher(순수)에 주입할 building_unit / property_unit 후보와 현재 property_units land tuple 을
 * union·scope 범위로 조회한다. 전부 inline `.select()` read 이며 write 는 하지 않는다(오직 apply
 * RPC 만 property_units·property_unit_land_rights 를 변경한다 — writer-guard).
 *
 * 오류/0건 구분(§2.2): DB 조회 error 는 fatal 로 throw 한다(→ queue fatal catch → job FAILED).
 * error 를 빈 결과로 삼키면 "조회 실패"가 "후보 0건"으로 오인돼 잘못된 under-match(NO_CHANGE)로
 * silently 종결되므로 금지한다. error 가 없는 진짜 0건만 빈 배열로 반환한다.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { BuildingUnitCandidate, PropertyUnitCandidate } from './matcher';
import type { LandAreaSyncLandTuple } from '../../types/land-area-sync-job.types';

function str(v: unknown): string | null {
    if (v == null) return null;
    const s = String(v);
    return s.length === 0 ? null : s;
}

function uniqueStrings(values: unknown[]): string[] {
    return [
        ...new Set(
            values
                .map(str)
                .filter((value): value is string => value !== null)
        ),
    ];
}

/** 조회 error 를 fatal 로 승격한다(§2.2 — queue fatal catch 가 job 을 FAILED 로 기록). */
function throwReadFailure(what: string, error: { message?: string } | null): never {
    throw Object.assign(new Error(`LAND_AREA_SYNC ${what} 조회 실패`), {
        code: 'LAND_AREA_SYNC_READ_FAILED',
        cause: error ?? undefined,
    });
}

/**
 * union·scope PNU 범위의 활성/비활성 property_unit 후보(matcher 주입용, read-only).
 *
 * PostgREST column aliasing 으로 DB 응답을 matcher 계약 shape 그대로 받는다. 이 기능은
 * property_units.building_unit_id 링크를 절대 write 하지 않는다(매칭된 building_unit 은
 * property_unit_land_rights.matched_building_unit_id 로만 apply RPC 가 기록한다). 여기서는
 * 기존 링크를 읽어 매칭 후보로 넘길 뿐이다.
 */
export async function readPropertyUnitCandidates(
    client: SupabaseClient,
    unionId: string,
    scopePnus: string[]
): Promise<PropertyUnitCandidate[]> {
    if (scopePnus.length === 0) return [];
    const { data, error } = await client
        .from('property_units')
        .select('id, unionId:union_id, buildingUnitId:building_unit_id, pnu, isDeleted:is_deleted, dong, ho')
        .eq('union_id', unionId)
        .in('pnu', scopePnus);
    if (error) throwReadFailure('property_unit 후보', error);
    if (!Array.isArray(data)) return [];
    // DB 응답이 이미 matcher 계약(camelCase) shape 다. 링크 field 를 코드에서 재기록하지 않는다.
    return data as unknown as PropertyUnitCandidate[];
}

function toBuildingUnitCandidate(row: Record<string, unknown>): BuildingUnitCandidate | null {
    const id = str(row.id);
    if (id === null) return null;
    return {
        id,
        buildingId: str(row.building_id),
        dong: str(row.dong),
        floor: row.floor == null ? null : String(row.floor),
        ho: str(row.ho),
        registryExternalId: str(row.registry_external_id),
    };
}

function sameBuildingUnitCandidate(
    left: BuildingUnitCandidate,
    right: BuildingUnitCandidate
): boolean {
    return (
        left.id === right.id &&
        (left.buildingId ?? null) === (right.buildingId ?? null) &&
        (left.dong ?? null) === (right.dong ?? null) &&
        (left.floor ?? null) === (right.floor ?? null) &&
        (left.ho ?? null) === (right.ho ?? null) &&
        (left.registryExternalId ?? null) === (right.registryExternalId ?? null)
    );
}

/**
 * scope 내 building_unit 후보.
 *
 * 탐색 경로를 두 개의 read-only evidence로 제한한다.
 *  1. scope PNU의 building_land_lots → building_id → 같은 building의 units
 *  2. 같은 union·scope PNU의 활성 property_units → 기존 building_unit_id → 해당 unit/building
 *
 * 두 번째 경로는 기존 링크만 읽고 면적/MANUAL provenance는 조회하지 않는다. 응답도 요청한
 * union·PNU·활성 조건 및 도달 가능한 unit/building 집합으로 다시 좁혀, service-role 조회에서
 * 다른 조합의 property row가 후보 경로에 섞이지 않게 한다.
 */
export async function readBuildingUnitCandidates(
    client: SupabaseClient,
    unionId: string,
    scopePnus: string[]
): Promise<BuildingUnitCandidate[]> {
    if (scopePnus.length === 0) return [];
    const exactScopePnus = uniqueStrings(scopePnus);
    if (exactScopePnus.length === 0) return [];
    const scopePnuSet = new Set(exactScopePnus);

    const { data: links, error: linkError } = await client
        .from('building_land_lots')
        .select('pnu, building_id')
        .in('pnu', exactScopePnus);
    if (linkError) throwReadFailure('building_land_lots', linkError);

    const { data: propertyLinks, error: propertyLinkError } = await client
        .from('property_units')
        .select('union_id, pnu, is_deleted, building_unit_id')
        .eq('union_id', unionId)
        .eq('is_deleted', false)
        .in('pnu', exactScopePnus)
        .not('building_unit_id', 'is', null);
    if (propertyLinkError) {
        throwReadFailure('property_unit building_unit 링크', propertyLinkError);
    }

    const buildingIds = new Set(
        Array.isArray(links)
            ? uniqueStrings(
                  links
                      .filter(
                          (row: Record<string, unknown>) =>
                              scopePnuSet.has(str(row.pnu) ?? '')
                      )
                      .map((row: Record<string, unknown>) => row.building_id)
              )
            : []
    );
    const linkedUnitIds = new Set(
        Array.isArray(propertyLinks)
            ? uniqueStrings(
                  propertyLinks
                      .filter(
                          (row: Record<string, unknown>) =>
                              str(row.union_id) === unionId &&
                              row.is_deleted === false &&
                              scopePnuSet.has(str(row.pnu) ?? '')
                      )
                      .map((row: Record<string, unknown>) => row.building_unit_id)
              )
            : []
    );

    const directUnits: BuildingUnitCandidate[] = [];
    if (linkedUnitIds.size > 0) {
        const { data, error } = await client
            .from('building_units')
            .select('id, building_id, dong, floor, ho, registry_external_id')
            .in('id', [...linkedUnitIds]);
        if (error) throwReadFailure('linked building_unit 후보', error);
        if (Array.isArray(data)) {
            for (const row of data as Record<string, unknown>[]) {
                const candidate = toBuildingUnitCandidate(row);
                if (candidate === null || !linkedUnitIds.has(candidate.id)) continue;
                directUnits.push(candidate);
                if (candidate.buildingId) buildingIds.add(candidate.buildingId);
            }
        }
    }

    const buildingUnits: BuildingUnitCandidate[] = [];
    if (buildingIds.size > 0) {
        const { data, error } = await client
            .from('building_units')
            .select('id, building_id, dong, floor, ho, registry_external_id')
            .in('building_id', [...buildingIds]);
        if (error) throwReadFailure('building_unit 후보', error);
        if (Array.isArray(data)) {
            for (const row of data as Record<string, unknown>[]) {
                const candidate = toBuildingUnitCandidate(row);
                if (
                    candidate === null ||
                    !candidate.buildingId ||
                    !buildingIds.has(candidate.buildingId)
                ) {
                    continue;
                }
                buildingUnits.push(candidate);
            }
        }
    }

    const deduped = new Map<string, BuildingUnitCandidate>();
    for (const candidate of [...directUnits, ...buildingUnits]) {
        const previous = deduped.get(candidate.id);
        if (previous && !sameBuildingUnitCandidate(previous, candidate)) {
            throwReadFailure('building_unit 후보 일관성', {
                message: `동일 id의 조회 결과가 충돌함: ${candidate.id}`,
            });
        }
        deduped.set(candidate.id, candidate);
    }
    return [...deduped.values()];
}

/** 현재 property_units land tuple(land_area·source) — 문자열 numeric 으로. */
export async function readCurrentLandTuples(
    client: SupabaseClient,
    unionId: string,
    propertyUnitIds: string[]
): Promise<LandAreaSyncLandTuple[]> {
    if (propertyUnitIds.length === 0) return [];
    const { data, error } = await client
        .from('property_units')
        .select('id, land_area, land_area_source')
        .eq('union_id', unionId)
        .in('id', propertyUnitIds);
    if (error) throwReadFailure('current land tuple', error);
    if (!Array.isArray(data)) return [];
    return data.map((r: Record<string, unknown>) => ({
        propertyUnitId: String(r.id),
        landArea: r.land_area == null ? '' : String(r.land_area),
        source: r.land_area_source == null ? 'LEGACY_UNKNOWN' : String(r.land_area_source),
    }));
}
