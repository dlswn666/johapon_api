/**
 * 대지권 공식자료 단건 transient 조회.
 *
 * SYSTEM_ADMIN 인증은 route middleware가 담당한다. 이 계층은 요청 물건지의 union/PNU와
 * 기준·부속 relation을 read-only로 다시 확인한 뒤 NED를 조회한다. DB write/RPC/queue는
 * 사용하지 않으며 조회 결과도 저장하지 않는다.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
    LandRightLadfrlRecord,
    LandRightLdaregRecord,
    LandRightLookupData,
    LandRightLookupParcel,
    LandRightLookupPropertyUnit,
    LandRightLookupSourceScan,
    LandRightLookupStatus,
} from '../../types/land-right-lookup.types';
import type {
    NedFetchResult,
    NedScanOptions,
    VworldAuth,
} from './ned';
import {
    LandRightLookupBudget,
    landRightNedClient,
    type LandRightLookupTerminalCode,
} from './ned';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNU_RE = /^\d{10}[12]\d{8}$/;
const MAX_PUBLIC_SCALAR_LENGTH = 500;
export const MAX_LAND_RIGHT_SCOPE_PNUS = 20;
export const MAX_LAND_RIGHT_RELATION_ROWS = 100;

interface PropertyUnitRow {
    id: unknown;
    union_id: unknown;
    pnu: unknown;
    property_address_jibun: unknown;
    dong: unknown;
    ho: unknown;
    land_area: unknown;
    is_deleted: unknown;
}

interface RelationRow {
    union_id: unknown;
    base_pnu: unknown;
    attached_pnu: unknown;
    mgm_bldrgst_pk: unknown;
    projection_status: unknown;
    is_active: unknown;
}

interface LandLotRow {
    union_id: unknown;
    pnu: unknown;
    address: unknown;
}

interface RelationGroupSeed {
    basePnu: string;
    managementPk: string;
}

export interface LandRightLookupRepository {
    findPropertyUnit(
        unionId: string,
        propertyUnitId: string,
        signal?: AbortSignal
    ): Promise<PropertyUnitRow | null>;
    findDirectRelations(
        unionId: string,
        pnu: string,
        signal?: AbortSignal
    ): Promise<RelationRow[]>;
    findGroupRelations(
        unionId: string,
        groups: RelationGroupSeed[],
        signal?: AbortSignal
    ): Promise<RelationRow[]>;
    findLandLots(
        unionId: string,
        pnus: string[],
        signal?: AbortSignal
    ): Promise<LandLotRow[]>;
}

export interface LandRightLookupNed {
    fetchLdareg(
        pnu: string,
        auth: VworldAuth,
        options?: NedScanOptions
    ): Promise<NedFetchResult>;
    fetchLadfrl(
        pnu: string,
        auth: VworldAuth,
        options?: NedScanOptions
    ): Promise<NedFetchResult>;
}

export interface LandRightLookupDeps {
    repository: LandRightLookupRepository;
    ned?: LandRightLookupNed;
    auth: VworldAuth;
    signal?: AbortSignal;
}

export class LandRightLookupError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string
    ) {
        super(message);
        this.name = 'LandRightLookupError';
    }
}

function databaseReadFailure(): LandRightLookupError {
    return new LandRightLookupError(
        503,
        'PROPERTY_LOOKUP_FAILED',
        '물건지 범위를 확인할 수 없습니다.'
    );
}

/** Supabase service-role client의 SELECT만 사용하는 repository. */
export function createSupabaseLandRightLookupRepository(
    client: SupabaseClient
): LandRightLookupRepository {
    return {
        async findPropertyUnit(unionId, propertyUnitId, signal) {
            let query = client
                .from('property_units')
                .select(
                    'id, union_id, pnu, property_address_jibun, dong, ho, land_area, is_deleted'
                )
                .eq('id', propertyUnitId)
                .eq('union_id', unionId)
                .eq('is_deleted', false);
            if (signal) query = query.abortSignal(signal);
            const { data, error } = await query.maybeSingle();
            if (error) throw databaseReadFailure();
            return (data as PropertyUnitRow | null) ?? null;
        },

        async findDirectRelations(unionId, pnu, signal) {
            let query = client
                .from('building_registry_land_lot_relations')
                .select(
                    'union_id, base_pnu, attached_pnu, mgm_bldrgst_pk, projection_status, is_active'
                )
                .eq('union_id', unionId)
                .eq('is_active', true)
                .or(`base_pnu.eq.${pnu},attached_pnu.eq.${pnu}`)
                .limit(MAX_LAND_RIGHT_RELATION_ROWS + 1);
            if (signal) query = query.abortSignal(signal);
            const { data, error } = await query;
            if (error) throw databaseReadFailure();
            return Array.isArray(data) ? (data as RelationRow[]) : [];
        },

        async findGroupRelations(unionId, groups, signal) {
            if (groups.length === 0) return [];
            const basePnus = [...new Set(groups.map((group) => group.basePnu))];
            const managementPks = [
                ...new Set(groups.map((group) => group.managementPk)),
            ];
            let query = client
                .from('building_registry_land_lot_relations')
                .select(
                    'union_id, base_pnu, attached_pnu, mgm_bldrgst_pk, projection_status, is_active'
                )
                .eq('union_id', unionId)
                .eq('is_active', true)
                .in('base_pnu', basePnus)
                .in('mgm_bldrgst_pk', managementPks)
                .limit(MAX_LAND_RIGHT_RELATION_ROWS + 1);
            if (signal) query = query.abortSignal(signal);
            const { data, error } = await query;
            if (error) throw databaseReadFailure();
            return Array.isArray(data) ? (data as RelationRow[]) : [];
        },

        async findLandLots(unionId, pnus, signal) {
            if (pnus.length === 0) return [];
            let query = client
                .from('land_lots')
                .select('union_id, pnu, address')
                .eq('union_id', unionId)
                .in('pnu', pnus);
            if (signal) query = query.abortSignal(signal);
            const { data, error } = await query;
            if (error) throw databaseReadFailure();
            return Array.isArray(data) ? (data as LandLotRow[]) : [];
        },
    };
}

function nullableString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const normalized = String(value).trim();
    if (!normalized) return null;
    return normalized.slice(0, MAX_PUBLIC_SCALAR_LENGTH);
}

function propertyView(row: PropertyUnitRow): LandRightLookupPropertyUnit {
    return {
        id: nullableString(row.id) ?? '',
        pnu: nullableString(row.pnu),
        address: nullableString(row.property_address_jibun),
        dong: nullableString(row.dong),
        ho: nullableString(row.ho),
    };
}

function terminalFailure(
    propertyUnit: LandRightLookupPropertyUnit,
    code: string,
    parcel?: LandRightLookupParcel
): LandRightLookupData {
    return {
        status: 'FAILED',
        code,
        propertyUnit,
        parcels: parcel ? [parcel] : [],
        ldareg: [],
        ladfrl: [],
        sources: {
            ldareg: { status: 'FAILED', scans: [] },
            ladfrl: { status: 'FAILED', scans: [] },
        },
        warnings: [code],
    };
}

function terminalIncomplete(
    propertyUnit: LandRightLookupPropertyUnit,
    code: string,
    parcel?: LandRightLookupParcel
): LandRightLookupData {
    return {
        status: 'INCOMPLETE',
        code,
        propertyUnit,
        parcels: parcel ? [parcel] : [],
        ldareg: [],
        ladfrl: [],
        sources: {
            ldareg: { status: 'INCOMPLETE', scans: [] },
            ladfrl: { status: 'INCOMPLETE', scans: [] },
        },
        warnings: [code],
    };
}

function lookupAbortCode(
    signal?: AbortSignal
): LandRightLookupTerminalCode | null {
    if (!signal?.aborted) return null;
    return signal.reason === 'LOOKUP_DEADLINE_EXCEEDED'
        ? 'LOOKUP_DEADLINE_EXCEEDED'
        : 'LOOKUP_ABORTED';
}

const REQUEST_TERMINAL_CODES = new Set<LandRightLookupTerminalCode>([
    'LOOKUP_DEADLINE_EXCEEDED',
    'LOOKUP_ABORTED',
    'PROVIDER_TIMEOUT',
    'SCAN_ROW_LIMIT_EXCEEDED',
    'LOOKUP_ROW_LIMIT_EXCEEDED',
    'LOOKUP_RESPONSE_SIZE_LIMIT_EXCEEDED',
]);

function requestTerminalCode(
    result: NedFetchResult
): LandRightLookupTerminalCode | null {
    return result.status === 'INCOMPLETE' &&
        typeof result.code === 'string' &&
        REQUEST_TERMINAL_CODES.has(result.code as LandRightLookupTerminalCode)
        ? (result.code as LandRightLookupTerminalCode)
        : null;
}

class LookupInterruptedError extends Error {
    constructor(readonly code: LandRightLookupTerminalCode) {
        super(code);
        this.name = 'LookupInterruptedError';
    }
}

function awaitLookupStep<T>(
    promise: Promise<T>,
    signal?: AbortSignal
): Promise<T> {
    const initialCode = lookupAbortCode(signal);
    if (initialCode) return Promise.reject(new LookupInterruptedError(initialCode));
    if (!signal) return promise;

    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const onAbort = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(
                new LookupInterruptedError(
                    lookupAbortCode(signal) ?? 'LOOKUP_ABORTED'
                )
            );
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
            return;
        }
        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
            },
            (error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            }
        );
    });
}

function interruptedLookup(
    propertyUnitId: string,
    error: LookupInterruptedError,
    propertyUnit?: LandRightLookupPropertyUnit,
    parcel?: LandRightLookupParcel
): LandRightLookupData {
    return terminalIncomplete(
        propertyUnit ?? {
            id: propertyUnitId,
            pnu: null,
            address: null,
            dong: null,
            ho: null,
        },
        error.code,
        parcel
    );
}

function relationValues(
    row: RelationRow,
    unionId: string
): {
    basePnu: string;
    attachedPnu: string;
    managementPk: string;
    projectionStatus: string;
} | null {
    const rowUnionId = nullableString(row.union_id)?.toLowerCase();
    const basePnu = nullableString(row.base_pnu);
    const attachedPnu = nullableString(row.attached_pnu);
    const managementPk = nullableString(row.mgm_bldrgst_pk);
    const projectionStatus = nullableString(row.projection_status);
    if (
        rowUnionId !== unionId ||
        row.is_active !== true ||
        !basePnu ||
        !attachedPnu ||
        !managementPk ||
        !PNU_RE.test(basePnu) ||
        !PNU_RE.test(attachedPnu) ||
        basePnu === attachedPnu
    ) {
        return null;
    }
    return {
        basePnu,
        attachedPnu,
        managementPk,
        projectionStatus: projectionStatus ?? '',
    };
}

function relationGroupKey(group: RelationGroupSeed): string {
    return `${group.basePnu}\u0000${group.managementPk}`;
}

function aggregateStatus(
    statuses: LandRightLookupStatus[]
): LandRightLookupStatus {
    // 일부 공식자료만 성공해도 관리자가 그 자료를 검토할 수 있다. 다만 실패·불완전은
    // 성공보다 우선해 재조회를 권고하고, 모든 source가 NO_DATA일 때만 전체 NO_DATA다.
    if (statuses.some((status) => status === 'FAILED')) return 'FAILED';
    if (statuses.some((status) => status === 'INCOMPLETE')) {
        return 'INCOMPLETE';
    }
    if (statuses.some((status) => status === 'SUCCESS')) return 'SUCCESS';
    return 'NO_DATA';
}

const LDAREG_FIELDS = [
    'pnu',
    'agbldgSn',
    'buldNm',
    'buldDongNm',
    'buldFloorNm',
    'buldHoNm',
    'buldRoomNm',
    'ldaQotaRate',
    'clsSeCode',
    'clsSeCodeNm',
    'relateLdEmdLiCode',
    'lastUpdtDt',
] as const;

const LADFRL_FIELDS = [
    'pnu',
    'ldCode',
    'ldCodeNm',
    'mnnmSlno',
    'regstrSeCode',
    'regstrSeCodeNm',
    'lndcgrCode',
    'lndcgrCodeNm',
    'lndpclAr',
    'posesnSeCode',
    'posesnSeCodeNm',
    'cnrsPsnCo',
    'ladFrtlSc',
    'ladFrtlScNm',
    'lastUpdtDt',
] as const;

function projectRecord<const T extends readonly string[]>(
    row: Record<string, unknown>,
    fields: T
): Record<T[number], string | null> {
    return Object.fromEntries(
        fields.map((field) => [field, nullableString(row[field])])
    ) as Record<T[number], string | null>;
}

export function projectLdaregRecord(
    row: Record<string, unknown>
): LandRightLdaregRecord {
    return projectRecord(row, LDAREG_FIELDS) as LandRightLdaregRecord;
}

export function projectLadfrlRecord(
    row: Record<string, unknown>
): LandRightLadfrlRecord {
    return projectRecord(row, LADFRL_FIELDS) as LandRightLadfrlRecord;
}

function toSourceScans(
    pnus: string[],
    results: NedFetchResult[]
): LandRightLookupSourceScan[] {
    return results.map((result, index) => ({
        pnu: pnus[index],
        status: result.status,
        ...(result.code ? { code: result.code } : {}),
    }));
}

function sourceWarnings(
    source: 'LDAREG' | 'LADFRL',
    results: NedFetchResult[]
): string[] {
    const warnings = new Set<string>();
    for (const result of results) {
        if (result.status === 'FAILED' || result.status === 'INCOMPLETE') {
            warnings.add(`${source}_${result.status}`);
        }
    }
    return [...warnings];
}

/**
 * 한 물건지의 공식자료를 메모리에서만 조회한다. 조회 상태와 원문 투영은 반환하지만 어떠한
 * DB/queue 객체도 생성·갱신하지 않는다.
 */
export async function lookupLandRightTransient(
    input: { unionId: string; propertyUnitId: string },
    deps: LandRightLookupDeps
): Promise<LandRightLookupData> {
    if (!UUID_RE.test(input.unionId) || !UUID_RE.test(input.propertyUnitId)) {
        throw new LandRightLookupError(
            400,
            'INVALID_REQUEST',
            'unionId와 propertyUnitId 형식이 올바르지 않습니다.'
        );
    }
    const unionId = input.unionId.toLowerCase();
    const propertyUnitId = input.propertyUnitId.toLowerCase();

    let row: PropertyUnitRow | null;
    try {
        row = await awaitLookupStep(
            deps.repository.findPropertyUnit(
                unionId,
                propertyUnitId,
                deps.signal
            ),
            deps.signal
        );
    } catch (error) {
        const interrupted = lookupAbortCode(deps.signal);
        if (interrupted) {
            return interruptedLookup(
                propertyUnitId,
                new LookupInterruptedError(interrupted)
            );
        }
        if (error instanceof LookupInterruptedError) {
            return interruptedLookup(propertyUnitId, error);
        }
        throw error;
    }
    if (
        !row ||
        nullableString(row.id)?.toLowerCase() !== propertyUnitId ||
        nullableString(row.union_id)?.toLowerCase() !== unionId ||
        row.is_deleted !== false
    ) {
        throw new LandRightLookupError(
            404,
            'PROPERTY_UNIT_NOT_FOUND',
            '물건지를 찾을 수 없습니다.'
        );
    }
    if (row.land_area !== null && row.land_area !== undefined) {
        throw new LandRightLookupError(
            409,
            'PROPERTY_UNIT_ALREADY_RESOLVED',
            '이미 대지권면적이 입력된 물건지입니다.'
        );
    }

    const propertyUnit = propertyView(row);
    if (propertyUnit.pnu === null) {
        return terminalFailure(propertyUnit, 'PROPERTY_PNU_MISSING');
    }
    if (!PNU_RE.test(propertyUnit.pnu)) {
        return terminalFailure(propertyUnit, 'PROPERTY_PNU_INVALID');
    }
    const propertyPnu = propertyUnit.pnu;

    let rawDirectRelations: RelationRow[];
    try {
        rawDirectRelations = await awaitLookupStep(
            deps.repository.findDirectRelations(
                unionId,
                propertyPnu,
                deps.signal
            ),
            deps.signal
        );
    } catch (error) {
        const interrupted = lookupAbortCode(deps.signal);
        if (interrupted) {
            return interruptedLookup(
                propertyUnitId,
                new LookupInterruptedError(interrupted),
                propertyUnit,
                {
                    pnu: propertyPnu,
                    role: 'UNKNOWN',
                    address: propertyUnit.address,
                    scopeGroup: null,
                }
            );
        }
        if (error instanceof LookupInterruptedError) {
            return interruptedLookup(propertyUnitId, error, propertyUnit, {
                pnu: propertyPnu,
                role: 'UNKNOWN',
                address: propertyUnit.address,
                scopeGroup: null,
            });
        }
        return terminalFailure(propertyUnit, 'PROPERTY_SCOPE_LOOKUP_FAILED', {
            pnu: propertyPnu,
            role: 'UNKNOWN',
            address: propertyUnit.address,
            scopeGroup: null,
        });
    }
    if (rawDirectRelations.length > MAX_LAND_RIGHT_RELATION_ROWS) {
        return terminalIncomplete(
            propertyUnit,
            'PROPERTY_SCOPE_LIMIT_EXCEEDED',
            {
                pnu: propertyPnu,
                role: 'UNKNOWN',
                address: propertyUnit.address,
                scopeGroup: null,
            }
        );
    }

    const warnings = new Set<string>();
    const directRelations = rawDirectRelations
        .map((relation) => relationValues(relation, unionId))
        .filter(
            (relation): relation is NonNullable<typeof relation> =>
                relation !== null &&
                (relation.basePnu === propertyPnu ||
                    relation.attachedPnu === propertyPnu)
        );
    if (directRelations.length !== rawDirectRelations.length) {
        warnings.add('RELATION_SCOPE_INCOMPLETE');
    }
    if (rawDirectRelations.length > 0 && directRelations.length === 0) {
        return terminalFailure(propertyUnit, 'PROPERTY_SCOPE_INVALID', {
            pnu: propertyPnu,
            role: 'UNKNOWN',
            address: propertyUnit.address,
            scopeGroup: null,
        });
    }

    const groupSeeds = [
        ...new Map(
            directRelations.map((relation) => {
                const seed = {
                    basePnu: relation.basePnu,
                    managementPk: relation.managementPk,
                };
                return [relationGroupKey(seed), seed];
            })
        ).values(),
    ];

    let groupRelations = directRelations;
    if (groupSeeds.length > 0) {
        let rawGroupRelations: RelationRow[];
        try {
            rawGroupRelations = await awaitLookupStep(
                deps.repository.findGroupRelations(
                    unionId,
                    groupSeeds,
                    deps.signal
                ),
                deps.signal
            );
        } catch (error) {
            const interrupted = lookupAbortCode(deps.signal);
            if (interrupted) {
                return interruptedLookup(
                    propertyUnitId,
                    new LookupInterruptedError(interrupted),
                    propertyUnit,
                    {
                        pnu: propertyPnu,
                        role: 'UNKNOWN',
                        address: propertyUnit.address,
                        scopeGroup: null,
                    }
                );
            }
            if (error instanceof LookupInterruptedError) {
                return interruptedLookup(
                    propertyUnitId,
                    error,
                    propertyUnit,
                    {
                        pnu: propertyPnu,
                        role: 'UNKNOWN',
                        address: propertyUnit.address,
                        scopeGroup: null,
                    }
                );
            }
            return terminalFailure(
                propertyUnit,
                'PROPERTY_SCOPE_LOOKUP_FAILED',
                {
                    pnu: propertyPnu,
                    role: 'UNKNOWN',
                    address: propertyUnit.address,
                    scopeGroup: null,
                }
            );
        }
        if (rawGroupRelations.length > MAX_LAND_RIGHT_RELATION_ROWS) {
            return terminalIncomplete(
                propertyUnit,
                'PROPERTY_SCOPE_LIMIT_EXCEEDED',
                {
                    pnu: propertyPnu,
                    role: 'UNKNOWN',
                    address: propertyUnit.address,
                    scopeGroup: null,
                }
            );
        }
        const allowedGroupKeys = new Set(groupSeeds.map(relationGroupKey));
        const validExpanded: Array<
            NonNullable<ReturnType<typeof relationValues>>
        > = [];
        for (const rawRelation of rawGroupRelations) {
            const rawBasePnu = nullableString(rawRelation.base_pnu);
            const rawManagementPk = nullableString(
                rawRelation.mgm_bldrgst_pk
            );
            if (!rawBasePnu || !rawManagementPk) {
                warnings.add('RELATION_SCOPE_INCOMPLETE');
                continue;
            }
            const rawKey = relationGroupKey({
                basePnu: rawBasePnu,
                managementPk: rawManagementPk,
            });
            if (!allowedGroupKeys.has(rawKey)) continue;

            const relation = relationValues(rawRelation, unionId);
            if (!relation) {
                warnings.add('RELATION_SCOPE_INCOMPLETE');
                continue;
            }
            validExpanded.push(relation);
        }
        // Supabase의 두 `.in(...)` 조건은 (basePnu, managementPk) 쌍이 아니라
        // 교차곱 후보를 반환할 수 있다. 허용된 exact pair만 남기는 것은 정상적인
        // bounded-closure 처리이며, 다른 pair가 함께 조회됐다는 이유만으로 scope를
        // 불완전 처리하지 않는다.
        const deduped = new Map<string, (typeof validExpanded)[number]>();
        for (const relation of [...directRelations, ...validExpanded]) {
            deduped.set(
                `${relation.basePnu}\u0000${relation.attachedPnu}\u0000${relation.managementPk}`,
                relation
            );
        }
        groupRelations = [...deduped.values()];
    } else {
        warnings.add('NO_ACTIVE_BASE_ATTACHED_RELATION');
    }

    if (
        groupRelations.some(
            (relation) => relation.projectionStatus !== 'LINKED'
        )
    ) {
        warnings.add('RELATION_NOT_LINKED');
    }

    const groupedRelations = new Map<string, typeof groupRelations>();
    for (const relation of groupRelations) {
        const key = relationGroupKey({
            basePnu: relation.basePnu,
            managementPk: relation.managementPk,
        });
        const list = groupedRelations.get(key) ?? [];
        list.push(relation);
        groupedRelations.set(key, list);
    }
    const sortedGroupKeys = [...groupedRelations.keys()].sort();
    if (sortedGroupKeys.length > 1) {
        warnings.add('MULTIPLE_MANAGEMENT_ROOTS');
    }

    const parcelDrafts: Array<
        Omit<LandRightLookupParcel, 'address'>
    > = [];
    if (sortedGroupKeys.length === 0) {
        parcelDrafts.push({
            pnu: propertyPnu,
            role: 'UNKNOWN',
            scopeGroup: null,
        });
    } else {
        sortedGroupKeys.forEach((key, index) => {
            const scopeGroup = `group-${index + 1}`;
            const relations = groupedRelations.get(key) ?? [];
            const basePnus = new Set(relations.map((relation) => relation.basePnu));
            const attachedPnus = new Set(
                relations.map((relation) => relation.attachedPnu)
            );
            const pnus = [...new Set([...basePnus, ...attachedPnus])].sort();
            for (const pnu of pnus) {
                parcelDrafts.push({
                    pnu,
                    role:
                        basePnus.has(pnu) && !attachedPnus.has(pnu)
                            ? 'BASE'
                            : attachedPnus.has(pnu) && !basePnus.has(pnu)
                              ? 'ATTACHED'
                              : 'UNKNOWN',
                    scopeGroup,
                });
            }
        });
    }

    const scanPnus = [
        ...new Set(parcelDrafts.map((parcel) => parcel.pnu)),
    ].sort((left, right) => {
        if (left === propertyPnu) return -1;
        if (right === propertyPnu) return 1;
        return left.localeCompare(right);
    });
    if (scanPnus.length > MAX_LAND_RIGHT_SCOPE_PNUS) {
        return terminalIncomplete(
            propertyUnit,
            'PROPERTY_SCOPE_LIMIT_EXCEEDED',
            {
                pnu: propertyPnu,
                role: 'UNKNOWN',
                address: propertyUnit.address,
                scopeGroup: null,
            }
        );
    }

    let landLots: LandLotRow[];
    try {
        landLots = await awaitLookupStep(
            deps.repository.findLandLots(unionId, scanPnus, deps.signal),
            deps.signal
        );
    } catch (error) {
        const interrupted = lookupAbortCode(deps.signal);
        if (interrupted) {
            return interruptedLookup(
                propertyUnitId,
                new LookupInterruptedError(interrupted),
                propertyUnit,
                {
                    pnu: propertyPnu,
                    role: 'UNKNOWN',
                    address: propertyUnit.address,
                    scopeGroup: null,
                }
            );
        }
        if (error instanceof LookupInterruptedError) {
            return interruptedLookup(propertyUnitId, error, propertyUnit, {
                pnu: propertyPnu,
                role: 'UNKNOWN',
                address: propertyUnit.address,
                scopeGroup: null,
            });
        }
        return terminalFailure(propertyUnit, 'PROPERTY_PNU_LOOKUP_FAILED', {
            pnu: propertyPnu,
            role: 'UNKNOWN',
            address: propertyUnit.address,
            scopeGroup: null,
        });
    }
    const addressByPnu = new Map<string, string | null>();
    for (const landLot of landLots) {
        const rowUnionId = nullableString(landLot.union_id)?.toLowerCase();
        const pnu = nullableString(landLot.pnu);
        if (rowUnionId !== unionId || !pnu || !scanPnus.includes(pnu)) {
            continue;
        }
        addressByPnu.set(pnu, nullableString(landLot.address));
    }
    if (!addressByPnu.has(propertyPnu)) {
        return terminalFailure(propertyUnit, 'PROPERTY_PNU_NOT_FOUND', {
            pnu: propertyPnu,
            role: 'UNKNOWN',
            address: propertyUnit.address,
            scopeGroup: null,
        });
    }

    if (!propertyUnit.address) {
        propertyUnit.address = addressByPnu.get(propertyPnu) ?? null;
    }
    const parcels = parcelDrafts.map((parcel) => ({
        ...parcel,
        address: addressByPnu.get(parcel.pnu) ?? null,
    }));

    const ned = deps.ned ?? landRightNedClient;
    const budget = new LandRightLookupBudget();
    const ldaregResults: NedFetchResult[] = [];
    const ladfrlResults: NedFetchResult[] = [];
    for (const pnu of scanPnus) {
        // provider rate-limit을 존중하도록 두 endpoint와 모든 PNU를 직렬 호출한다.
        try {
            const ldaregResult = await awaitLookupStep(
                ned.fetchLdareg(pnu, deps.auth, {
                    signal: deps.signal,
                    budget,
                }),
                deps.signal
            );
            ldaregResults.push(ldaregResult);
            const ldaregTerminal = requestTerminalCode(ldaregResult);
            if (ldaregTerminal) budget.terminate(ldaregTerminal);
            if (budget.terminalCode) {
                return terminalIncomplete(
                    propertyUnit,
                    budget.terminalCode
                );
            }
            const ladfrlResult = await awaitLookupStep(
                ned.fetchLadfrl(pnu, deps.auth, {
                    signal: deps.signal,
                    budget,
                }),
                deps.signal
            );
            ladfrlResults.push(ladfrlResult);
            const ladfrlTerminal = requestTerminalCode(ladfrlResult);
            if (ladfrlTerminal) budget.terminate(ladfrlTerminal);
            if (budget.terminalCode) {
                return terminalIncomplete(
                    propertyUnit,
                    budget.terminalCode
                );
            }
        } catch (error) {
            const interrupted = lookupAbortCode(deps.signal);
            if (interrupted) {
                return interruptedLookup(
                    propertyUnitId,
                    new LookupInterruptedError(interrupted),
                    propertyUnit
                );
            }
            if (error instanceof LookupInterruptedError) {
                return interruptedLookup(propertyUnitId, error, propertyUnit);
            }
            throw error;
        }
    }

    const ldaregStatus = aggregateStatus(
        ldaregResults.map((result) => result.status)
    );
    const ladfrlStatus = aggregateStatus(
        ladfrlResults.map((result) => result.status)
    );
    let status = aggregateStatus([ldaregStatus, ladfrlStatus]);
    const scopeIncomplete =
        warnings.has('NO_ACTIVE_BASE_ATTACHED_RELATION') ||
        warnings.has('RELATION_SCOPE_INCOMPLETE') ||
        warnings.has('RELATION_NOT_LINKED') ||
        warnings.has('MULTIPLE_MANAGEMENT_ROOTS');
    if (scopeIncomplete && status !== 'FAILED') status = 'INCOMPLETE';

    for (const warning of sourceWarnings('LDAREG', ldaregResults)) {
        warnings.add(warning);
    }
    for (const warning of sourceWarnings('LADFRL', ladfrlResults)) {
        warnings.add(warning);
    }

    const code =
        status === 'FAILED'
            ? 'OFFICIAL_LOOKUP_FAILED'
            : status === 'INCOMPLETE'
              ? scopeIncomplete
                  ? 'PROPERTY_SCOPE_INCOMPLETE'
                  : 'OFFICIAL_LOOKUP_INCOMPLETE'
              : undefined;

    return {
        status,
        ...(code ? { code } : {}),
        propertyUnit,
        parcels,
        ldareg: ldaregResults.flatMap((result) =>
            result.status === 'SUCCESS'
                ? result.records.map(projectLdaregRecord)
                : []
        ),
        ladfrl: ladfrlResults.flatMap((result) =>
            result.status === 'SUCCESS'
                ? result.records.map(projectLadfrlRecord)
                : []
        ),
        sources: {
            ldareg: {
                status: ldaregStatus,
                scans: toSourceScans(scanPnus, ldaregResults),
            },
            ladfrl: {
                status: ladfrlStatus,
                scans: toSourceScans(scanPnus, ladfrlResults),
            },
        },
        warnings: [...warnings].sort(),
    };
}
