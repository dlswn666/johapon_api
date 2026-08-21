/**
 * 대지권 공식자료 단건 transient 조회.
 *
 * SYSTEM_ADMIN 인증은 route middleware가 담당한다. 이 계층은 요청 물건지의 union/PNU와
 * 기준·부속 relation과 service-role read-only scope resolver를 다시 확인한 뒤 NED를
 * 조회한다. DB write/queue/job은 사용하지 않으며 조회 결과도 저장하지 않는다.
 */

import { hash as cryptoHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
    LandRightLadfrlRecord,
    LandRightLdaregRecord,
    LandRightLookupData,
    LandRightLookupParcel,
    LandRightLookupPropertyUnit,
    LandRightLookupScopeResolution,
    LandRightLookupSourceScan,
    LandRightLookupStatus,
} from '../../types/land-right-lookup.types';
import type {
    BrAtchJibunRow,
    BrBasisOulnRow,
    BrTitleRow,
    StrictScan,
} from '../../types/land-area-sync.types';
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
import {
    callParcelScopeResolver,
    computePropertyMembershipHash,
    resolveParcelScopeCompleteness,
    resolveSameRunOfficialReadOnlyComponent,
    type DbScopeResolution,
} from '../land-area-sync/scope';
import {
    BYLOT_SOURCE_POLICY,
    bylotBasisFallbackPlan,
} from '../land-area-sync/bylot';
import {
    isOptionalRegistryManagementPkValid,
    normalizeRegistryManagementPk,
} from '../land-area-sync/registry-pk';
import { buildingHubRowsMatchPnu } from '../gis-shared/pnu';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNU_RE = /^\d{10}[12]\d{8}$/;
const MAX_PUBLIC_SCALAR_LENGTH = 500;
export const MAX_LAND_RIGHT_SCOPE_PNUS = 20;
export const MAX_LAND_RIGHT_RELATION_ROWS = 100;
const SCOPE_EVIDENCE_DIGEST_VERSION =
    'land-right-lookup/scope-evidence@1';
const HEX_64_RE = /^[a-f0-9]{64}$/i;

interface PropertyUnitRow {
    id: unknown;
    union_id: unknown;
    building_unit_id: unknown;
    pnu: unknown;
    property_address_jibun: unknown;
    dong: unknown;
    ho: unknown;
    land_area: unknown;
    land_area_source: unknown;
    is_deleted: unknown;
}

interface PropertyMembershipRow {
    id: unknown;
    union_id: unknown;
    building_unit_id: unknown;
    pnu: unknown;
    is_deleted: unknown;
    dong: unknown;
    ho: unknown;
    land_area: unknown;
    land_area_source: unknown;
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
    findPropertyMembership(
        unionId: string,
        pnus: string[],
        signal?: AbortSignal
    ): Promise<PropertyMembershipRow[]>;
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

export interface LandRightLookupBuildingHub {
    scanTitle(
        pnu: string,
        signal?: AbortSignal
    ): Promise<StrictScan<BrTitleRow>>;
    scanAttached(
        pnu: string,
        signal?: AbortSignal
    ): Promise<StrictScan<BrAtchJibunRow>>;
    scanBasis(
        pnu: string,
        signal?: AbortSignal
    ): Promise<StrictScan<BrBasisOulnRow>>;
}

/**
 * read-only scope resolver와 Building HUB strict adapter를 한 묶음으로 주입한다.
 * 둘 중 하나만 사용할 수 없도록 하여 relation SELECT만으로 확인 후보를 발급하지 않는다.
 */
export interface LandRightLookupScopeConfirmationDeps {
    buildingHub: LandRightLookupBuildingHub;
    callResolver(
        params: {
            p_union_id: string;
            p_anchor_pnu: string;
            p_root_mgm_bldrgst_pks: string[];
        },
        signal?: AbortSignal
    ): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface LandRightLookupDeps {
    repository: LandRightLookupRepository;
    ned?: LandRightLookupNed;
    auth: VworldAuth;
    scopeConfirmation?: LandRightLookupScopeConfirmationDeps;
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
                    'id, union_id, building_unit_id, pnu, property_address_jibun, dong, ho, land_area, land_area_source, is_deleted'
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
            const managementPksByBase = new Map<string, Set<string>>();
            for (const group of groups) {
                const managementPks =
                    managementPksByBase.get(group.basePnu) ?? new Set<string>();
                managementPks.add(group.managementPk);
                managementPksByBase.set(group.basePnu, managementPks);
            }

            const rows: RelationRow[] = [];
            for (const [basePnu, managementPks] of managementPksByBase) {
                let query = client
                    .from('building_registry_land_lot_relations')
                    .select(
                        'union_id, base_pnu, attached_pnu, mgm_bldrgst_pk, projection_status, is_active'
                    )
                    .eq('union_id', unionId)
                    .eq('is_active', true)
                    .eq('base_pnu', basePnu)
                    .in('mgm_bldrgst_pk', [...managementPks])
                    .limit(MAX_LAND_RIGHT_RELATION_ROWS + 1);
                if (signal) query = query.abortSignal(signal);
                const { data, error } = await query;
                if (error) throw databaseReadFailure();
                if (Array.isArray(data)) rows.push(...(data as RelationRow[]));

                // 호출 계층이 limit 초과를 INCOMPLETE로 닫을 수 있도록 sentinel 1행까지만
                // 보존한다. 다른 기준 PNU를 더 읽어도 판정은 달라지지 않는다.
                if (rows.length > MAX_LAND_RIGHT_RELATION_ROWS) {
                    return rows.slice(0, MAX_LAND_RIGHT_RELATION_ROWS + 1);
                }
            }
            return rows;
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

        async findPropertyMembership(unionId, pnus, signal) {
            if (pnus.length === 0) return [];
            let query = client
                .from('property_units')
                .select(
                    'id, union_id, building_unit_id, pnu, is_deleted, dong, ho, land_area, land_area_source'
                )
                .eq('union_id', unionId)
                .eq('is_deleted', false)
                .in('pnu', pnus);
            if (signal) query = query.abortSignal(signal);
            const { data, error } = await query;
            if (error) throw databaseReadFailure();
            return Array.isArray(data)
                ? (data as PropertyMembershipRow[])
                : [];
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

interface OfficialScopeCandidate {
    canonicalBasePnu: string;
    memberPnus: string[];
    resolution: LandRightLookupScopeResolution;
}

type OfficialScopeEvidenceOutcome =
    | { kind: 'CANDIDATE'; candidate: OfficialScopeCandidate }
    | {
          kind: 'HOLD';
          warning:
              | 'SCOPE_CONFIRMATION_EVIDENCE_UNAVAILABLE'
              | 'SCOPE_CONFIRMATION_EVIDENCE_CONFLICT';
      }
    | { kind: 'LIMIT_EXCEEDED' };

interface CanonicalPropertyMembership {
    propertyUnitId: string;
    pnu: string;
    buildingIdentity: string | null;
    dong: string | null;
    ho: string | null;
    landArea: string | null;
    landAreaSource: string | null;
}

function canonicalOptionalDbScalar(
    value: unknown
): { valid: true; value: string | null } | { valid: false } {
    if (value === null || value === undefined) {
        return { valid: true, value: null };
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
        return { valid: false };
    }
    const normalized = String(value).trim();
    if (normalized.length > MAX_PUBLIC_SCALAR_LENGTH) {
        return { valid: false };
    }
    return {
        valid: true,
        value: normalized || null,
    };
}

function normalizeActivePropertyMembership(
    rows: PropertyMembershipRow[],
    unionId: string,
    memberPnus: readonly string[],
    targetPropertyUnitId: string
): CanonicalPropertyMembership[] | null {
    const memberSet = new Set(memberPnus);
    const normalized: CanonicalPropertyMembership[] = [];
    const propertyIds = new Set<string>();
    for (const row of rows) {
        const rowUnionId = nullableString(row.union_id)?.toLowerCase();
        const propertyUnitId = nullableString(row.id)?.toLowerCase();
        const pnu = nullableString(row.pnu);
        const rawBuildingUnitId = nullableString(row.building_unit_id);
        const buildingIdentity = rawBuildingUnitId?.toLowerCase() ?? null;
        const dong = canonicalOptionalDbScalar(row.dong);
        const ho = canonicalOptionalDbScalar(row.ho);
        const landArea = canonicalOptionalDbScalar(row.land_area);
        const landAreaSource = canonicalOptionalDbScalar(
            row.land_area_source
        );
        if (
            rowUnionId !== unionId ||
            row.is_deleted !== false ||
            !propertyUnitId ||
            !UUID_RE.test(propertyUnitId) ||
            !pnu ||
            !PNU_RE.test(pnu) ||
            !memberSet.has(pnu) ||
            (buildingIdentity !== null && !UUID_RE.test(buildingIdentity)) ||
            !dong.valid ||
            !ho.valid ||
            !landArea.valid ||
            !landAreaSource.valid ||
            propertyIds.has(propertyUnitId)
        ) {
            return null;
        }
        propertyIds.add(propertyUnitId);
        normalized.push({
            propertyUnitId,
            pnu,
            buildingIdentity,
            dong: dong.value,
            ho: ho.value,
            landArea: landArea.value,
            landAreaSource: landAreaSource.value,
        });
    }
    normalized.sort((left, right) =>
        left.propertyUnitId.localeCompare(right.propertyUnitId)
    );
    return normalized.length > 0 &&
        normalized.filter(
            (row) => row.propertyUnitId === targetPropertyUnitId
        ).length === 1
        ? normalized
        : null;
}

function normalizeResolverMembership(
    membership: unknown[],
    expectedPnu: string
): Array<{
    propertyUnitId: string;
    pnu: string;
    buildingIdentity: string | null;
}> | null {
    const normalized: Array<{
        propertyUnitId: string;
        pnu: string;
        buildingIdentity: string | null;
    }> = [];
    const propertyIds = new Set<string>();
    for (const raw of membership) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const row = raw as Record<string, unknown>;
        if (
            Object.keys(row).some(
                (key) =>
                    key !== 'propertyUnitId' &&
                    key !== 'pnu' &&
                    key !== 'buildingUnitId'
            )
        ) {
            return null;
        }
        const propertyUnitId = nullableString(
            row.propertyUnitId
        )?.toLowerCase();
        const pnu = nullableString(row.pnu);
        const rawBuildingUnitId = nullableString(row.buildingUnitId);
        const buildingIdentity = rawBuildingUnitId?.toLowerCase() ?? null;
        if (
            !propertyUnitId ||
            !UUID_RE.test(propertyUnitId) ||
            propertyIds.has(propertyUnitId) ||
            pnu !== expectedPnu ||
            (buildingIdentity !== null && !UUID_RE.test(buildingIdentity))
        ) {
            return null;
        }
        propertyIds.add(propertyUnitId);
        normalized.push({ propertyUnitId, pnu, buildingIdentity });
    }
    return normalized.sort((left, right) =>
        left.propertyUnitId.localeCompare(right.propertyUnitId)
    );
}

function strictTitleRoot(
    title: StrictScan<BrTitleRow>
): string | null {
    if (title.state !== 'COMPLETE') return null;
    const selfRoots = new Set<string>();
    const resolverRoots = new Set<string>();
    for (const row of title.rows) {
        const self = normalizeRegistryManagementPk(row.mgmBldrgstPk);
        if (!self || !isOptionalRegistryManagementPkValid(row.mgmUpBldrgstPk)) {
            return null;
        }
        const root =
            normalizeRegistryManagementPk(row.mgmUpBldrgstPk) ?? self;
        selfRoots.add(self);
        resolverRoots.add(root);
    }
    if (
        selfRoots.size !== 1 ||
        resolverRoots.size !== 1 ||
        [...selfRoots][0] !== [...resolverRoots][0]
    ) {
        return null;
    }
    return [...resolverRoots][0];
}

function dbScopeIsExactNoEvidence(
    scope: DbScopeResolution,
    expectedPnu: string,
    rootPk: string
): boolean {
    const normalizedRoots = scope.rootBuildingIdentities
        .map(normalizeRegistryManagementPk)
        .filter((value): value is string => value !== null);
    return (
        scope.dbState === 'NO_EVIDENCE' &&
        !scope.componentTruncated &&
        scope.componentPnus.length === 1 &&
        scope.componentPnus[0] === expectedPnu &&
        scope.linkedBasePnus.length === 0 &&
        scope.linkedPnus.length === 0 &&
        scope.linkedEvidenceKeys.length === 0 &&
        scope.pendingEvidenceKeys.length === 0 &&
        scope.blockingEvidence.length === 0 &&
        scope.openUnresolvedEvidenceKeys.length === 0 &&
        normalizedRoots.length === scope.rootBuildingIdentities.length &&
        normalizedRoots.length === 1 &&
        normalizedRoots[0] === rootPk &&
        HEX_64_RE.test(scope.dbScopeHash)
    );
}

function strictScanSummary<T>(scan: StrictScan<T>): {
    state: 'COMPLETE' | 'COMPLETE_ZERO';
    totalCount: number;
    pagesFetched: number;
} | null {
    return scan.state === 'COMPLETE' || scan.state === 'COMPLETE_ZERO'
        ? {
              state: scan.state,
              totalCount: scan.totalCount,
              pagesFetched: scan.pagesFetched,
          }
        : null;
}

function rawDbScopeContractIsSafe(data: unknown): boolean {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    const row = data as Record<string, unknown>;
    const stringArrays = [
        row.rootBuildingIdentities,
        row.componentPnus,
        row.linkedBasePnus,
        row.linkedPnus,
        row.linkedEvidenceKeys,
        row.pendingEvidenceKeys,
        row.openUnresolvedEvidenceKeys,
    ];
    if (
        typeof row.dbState !== 'string' ||
        typeof row.dbScopeHash !== 'string' ||
        typeof row.componentTruncated !== 'boolean' ||
        !stringArrays.every(
            (value) =>
                Array.isArray(value) &&
                value.every((item) => typeof item === 'string')
        ) ||
        !Array.isArray(row.propertyMembership) ||
        !Array.isArray(row.blockingEvidence)
    ) {
        return false;
    }
    return row.blockingEvidence.every((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return false;
        }
        const evidence = item as Record<string, unknown>;
        return (
            typeof evidence.sourceKind === 'string' &&
            typeof evidence.sourceId === 'string' &&
            typeof evidence.state === 'string' &&
            (evidence.reasonCode === undefined ||
                typeof evidence.reasonCode === 'string')
        );
    });
}

function buildScopeEvidenceDigest(input: {
    anchorPnu: string;
    memberPnus: string[];
    rootPk: string;
    strategy: 'LDAREG' | 'LADFRL';
    initialDbScopeHash: string;
    memberDbScopeHashes: Array<{ pnu: string; dbScopeHash: string }>;
    externalScopeDigest: string;
    officialComponentDigest: string | null;
    membership: CanonicalPropertyMembership[];
    title: StrictScan<BrTitleRow>;
    attached: StrictScan<BrAtchJibunRow>;
    basis?: StrictScan<BrBasisOulnRow>;
}): string {
    const stableMembership = input.membership.map((row) => ({
        propertyUnitId: row.propertyUnitId,
        pnu: row.pnu,
        buildingIdentity: row.buildingIdentity,
        dong: row.dong,
        ho: row.ho,
    }));
    const digest = cryptoHash(
        'sha256',
        JSON.stringify({
            version: SCOPE_EVIDENCE_DIGEST_VERSION,
            anchorPnu: input.anchorPnu,
            memberPnus: [...input.memberPnus].sort(),
            rootPk: input.rootPk,
            strategy: input.strategy,
            initialDbScopeHash: input.initialDbScopeHash.toLowerCase(),
            memberDbScopeHashes: [...input.memberDbScopeHashes]
                .map((entry) => ({
                    pnu: entry.pnu,
                    dbScopeHash: entry.dbScopeHash.toLowerCase(),
                }))
                .sort((left, right) => left.pnu.localeCompare(right.pnu)),
            externalScopeDigest: input.externalScopeDigest.toLowerCase(),
            officialComponentDigest:
                input.officialComponentDigest?.toLowerCase() ?? null,
            propertyMembershipHash:
                computePropertyMembershipHash(stableMembership),
            propertyMembership: stableMembership,
            scans: {
                title: strictScanSummary(input.title),
                attached: strictScanSummary(input.attached),
                basis: input.basis
                    ? strictScanSummary(input.basis)
                    : null,
            },
        }),
        'hex'
    );
    return `sha256:${digest}`;
}

async function resolveScopeForPnu(
    unionId: string,
    pnu: string,
    rootPk: string,
    deps: LandRightLookupScopeConfirmationDeps,
    signal?: AbortSignal
): Promise<DbScopeResolution> {
    return callParcelScopeResolver(
        {
            unionId,
            anchorPnu: pnu,
            rootMgmBldrgstPks: [rootPk],
        },
        {
            callResolver: async (params) => {
                const result = await awaitLookupStep(
                    deps.callResolver(params, signal),
                    signal
                );
                if (
                    result.error === null &&
                    !rawDbScopeContractIsSafe(result.data)
                ) {
                    return {
                        data: null,
                        error: {
                            message: 'scope resolver 응답 계약이 올바르지 않습니다.',
                        },
                    };
                }
                return result;
            },
        }
    );
}

async function resolveOfficialScopeEvidence(
    input: {
        unionId: string;
        propertyUnitId: string;
        propertyPnu: string;
        expectedBuildingUnitId: string | null;
        expectedDong: string | null;
        expectedHo: string | null;
        expectedLandAreaSource: string | null;
    },
    deps: LandRightLookupDeps
): Promise<OfficialScopeEvidenceOutcome> {
    const confirmation = deps.scopeConfirmation;
    if (!confirmation) {
        return {
            kind: 'HOLD',
            warning: 'SCOPE_CONFIRMATION_EVIDENCE_UNAVAILABLE',
        };
    }

    const title = await awaitLookupStep(
        confirmation.buildingHub.scanTitle(input.propertyPnu, deps.signal),
        deps.signal
    );
    const titlePnuExact =
        title.state === 'COMPLETE' &&
        buildingHubRowsMatchPnu(
            title.rows as Array<Record<string, unknown>>,
            input.propertyPnu
        );
    const rootPk = titlePnuExact ? strictTitleRoot(title) : null;
    if (!rootPk) {
        return {
            kind: 'HOLD',
            warning:
                title.state === 'FAILED' || title.state === 'INCOMPLETE'
                    ? 'SCOPE_CONFIRMATION_EVIDENCE_UNAVAILABLE'
                    : 'SCOPE_CONFIRMATION_EVIDENCE_CONFLICT',
        };
    }

    const initialDbScope = await resolveScopeForPnu(
        input.unionId,
        input.propertyPnu,
        rootPk,
        confirmation,
        deps.signal
    );
    if (!dbScopeIsExactNoEvidence(initialDbScope, input.propertyPnu, rootPk)) {
        return {
            kind: 'HOLD',
            warning: 'SCOPE_CONFIRMATION_EVIDENCE_CONFLICT',
        };
    }

    const attached = await awaitLookupStep(
        confirmation.buildingHub.scanAttached(
            input.propertyPnu,
            deps.signal
        ),
        deps.signal
    );
    const policy = BYLOT_SOURCE_POLICY.policy;
    let basis: StrictScan<BrBasisOulnRow> | undefined;
    const basisPlan = bylotBasisFallbackPlan(
        [
            {
                pnu: input.propertyPnu,
                titleRows: title.state === 'COMPLETE' ? title.rows : [],
            },
        ],
        policy
    );
    if (basisPlan.includes(input.propertyPnu)) {
        basis = await awaitLookupStep(
            confirmation.buildingHub.scanBasis(
                input.propertyPnu,
                deps.signal
            ),
            deps.signal
        );
    }

    const baseScan = {
        pnu: input.propertyPnu,
        title,
        attached,
        ...(basis ? { basis } : {}),
    };
    const gate = resolveParcelScopeCompleteness({
        dbScope: initialDbScope,
        baseScans: [baseScan],
        policy,
    });

    let memberPnus: string[];
    let officialComponentDigest: string | null = null;
    if (
        gate.state === 'SINGLE_SCOPE_CONFIRMATION_REQUIRED' &&
        gate.issues.length === 0 &&
        gate.classification.kind === 'CLASSIFIED' &&
        attached.state === 'COMPLETE_ZERO'
    ) {
        memberPnus = [input.propertyPnu];
    } else {
        const component = resolveSameRunOfficialReadOnlyComponent({
            anchorPnu: input.propertyPnu,
            dbScope: initialDbScope,
            baseScans: [baseScan],
            policy,
        });
        if (!component || gate.classification.kind !== 'CLASSIFIED') {
            return {
                kind: 'HOLD',
                warning:
                    gate.state === 'FAILED'
                        ? 'SCOPE_CONFIRMATION_EVIDENCE_UNAVAILABLE'
                        : 'SCOPE_CONFIRMATION_EVIDENCE_CONFLICT',
            };
        }
        memberPnus = [...component.memberPnus].sort();
        officialComponentDigest = component.officialComponentDigest;
    }

    memberPnus = [...new Set(memberPnus)].sort();
    if (
        memberPnus.length === 0 ||
        !memberPnus.includes(input.propertyPnu)
    ) {
        return {
            kind: 'HOLD',
            warning: 'SCOPE_CONFIRMATION_EVIDENCE_CONFLICT',
        };
    }
    if (memberPnus.length > MAX_LAND_RIGHT_SCOPE_PNUS) {
        return { kind: 'LIMIT_EXCEEDED' };
    }

    const rawMembership = await awaitLookupStep(
        deps.repository.findPropertyMembership(
            input.unionId,
            memberPnus,
            deps.signal
        ),
        deps.signal
    );
    const membership = normalizeActivePropertyMembership(
        rawMembership,
        input.unionId,
        memberPnus,
        input.propertyUnitId
    );
    if (!membership) {
        return {
            kind: 'HOLD',
            warning: 'SCOPE_CONFIRMATION_EVIDENCE_CONFLICT',
        };
    }
    const targetMembership = membership.find(
        (row) => row.propertyUnitId === input.propertyUnitId
    );
    if (
        !targetMembership ||
        targetMembership.pnu !== input.propertyPnu ||
        targetMembership.buildingIdentity !== input.expectedBuildingUnitId ||
        targetMembership.dong !== input.expectedDong ||
        targetMembership.ho !== input.expectedHo ||
        targetMembership.landArea !== null ||
        targetMembership.landAreaSource !== input.expectedLandAreaSource
    ) {
        return {
            kind: 'HOLD',
            warning: 'SCOPE_CONFIRMATION_EVIDENCE_CONFLICT',
        };
    }

    const membershipByPnu = new Map<
        string,
        Array<{
            propertyUnitId: string;
            pnu: string;
            buildingIdentity: string | null;
        }>
    >();
    for (const row of membership) {
        const values = membershipByPnu.get(row.pnu) ?? [];
        values.push({
            propertyUnitId: row.propertyUnitId,
            pnu: row.pnu,
            buildingIdentity: row.buildingIdentity,
        });
        membershipByPnu.set(row.pnu, values);
    }

    const initialResolverMembership = normalizeResolverMembership(
        initialDbScope.propertyMembership,
        input.propertyPnu
    );
    if (
        initialResolverMembership === null ||
        computePropertyMembershipHash(initialResolverMembership) !==
            computePropertyMembershipHash(
                membershipByPnu.get(input.propertyPnu) ?? []
            )
    ) {
        return {
            kind: 'HOLD',
            warning: 'SCOPE_CONFIRMATION_EVIDENCE_CONFLICT',
        };
    }

    const memberDbScopeHashes: Array<{
        pnu: string;
        dbScopeHash: string;
    }> = [];
    for (const pnu of memberPnus) {
        const scope = await resolveScopeForPnu(
            input.unionId,
            pnu,
            rootPk,
            confirmation,
            deps.signal
        );
        if (!dbScopeIsExactNoEvidence(scope, pnu, rootPk)) {
            return {
                kind: 'HOLD',
                warning: 'SCOPE_CONFIRMATION_EVIDENCE_CONFLICT',
            };
        }
        const resolverMembership = normalizeResolverMembership(
            scope.propertyMembership,
            pnu
        );
        if (
            resolverMembership === null ||
            computePropertyMembershipHash(resolverMembership) !==
                computePropertyMembershipHash(membershipByPnu.get(pnu) ?? [])
        ) {
            return {
                kind: 'HOLD',
                warning: 'SCOPE_CONFIRMATION_EVIDENCE_CONFLICT',
            };
        }
        if (
            pnu === input.propertyPnu &&
            scope.dbScopeHash.toLowerCase() !==
                initialDbScope.dbScopeHash.toLowerCase()
        ) {
            return {
                kind: 'HOLD',
                warning: 'SCOPE_CONFIRMATION_EVIDENCE_CONFLICT',
            };
        }
        memberDbScopeHashes.push({ pnu, dbScopeHash: scope.dbScopeHash });
    }

    if (
        gate.classification.kind !== 'CLASSIFIED' ||
        !HEX_64_RE.test(gate.externalScopeDigest)
    ) {
        return {
            kind: 'HOLD',
            warning: 'SCOPE_CONFIRMATION_EVIDENCE_CONFLICT',
        };
    }
    const strategy = gate.classification.family;
    if (
        strategy === 'LADFRL' &&
        (memberPnus.length !== 1 || membership.length !== 1)
    ) {
        return {
            kind: 'HOLD',
            warning: 'SCOPE_CONFIRMATION_EVIDENCE_CONFLICT',
        };
    }

    return {
        kind: 'CANDIDATE',
        candidate: {
            canonicalBasePnu: input.propertyPnu,
            memberPnus,
            resolution: {
                state: 'SCOPE_CONFIRMATION_REQUIRED',
                strategy,
                evidenceDigest: buildScopeEvidenceDigest({
                    anchorPnu: input.propertyPnu,
                    memberPnus,
                    rootPk,
                    strategy,
                    initialDbScopeHash: initialDbScope.dbScopeHash,
                    memberDbScopeHashes,
                    externalScopeDigest: gate.externalScopeDigest,
                    officialComponentDigest,
                    membership,
                    title,
                    attached,
                    ...(basis ? { basis } : {}),
                }),
                dbState: 'NO_EVIDENCE',
                reverseLookup: 'UNPROVEN',
                basePnuCount: 1,
                scopePnuCount: memberPnus.length,
                propertyUnitCount: membership.length,
                buildingRootCount: 1,
            },
        },
    };
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
    let officialScopeCandidate: OfficialScopeCandidate | null = null;
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
        try {
            const scopeEvidence = await resolveOfficialScopeEvidence(
                {
                    unionId,
                    propertyUnitId,
                    propertyPnu,
                    expectedBuildingUnitId:
                        nullableString(row.building_unit_id)?.toLowerCase() ??
                        null,
                    expectedDong: propertyUnit.dong,
                    expectedHo: propertyUnit.ho,
                    expectedLandAreaSource: nullableString(
                        row.land_area_source
                    ),
                },
                deps
            );
            if (scopeEvidence.kind === 'LIMIT_EXCEEDED') {
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
            if (scopeEvidence.kind === 'CANDIDATE') {
                officialScopeCandidate = scopeEvidence.candidate;
            } else {
                warnings.add(scopeEvidence.warning);
            }
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
            warnings.add('SCOPE_CONFIRMATION_EVIDENCE_UNAVAILABLE');
        }
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
    if (
        sortedGroupKeys.length === 0 &&
        officialScopeCandidate
    ) {
        const canonicalBasePnu =
            officialScopeCandidate.canonicalBasePnu;
        const orderedPnus = [
            canonicalBasePnu,
            ...officialScopeCandidate.memberPnus.filter(
                (pnu) => pnu !== canonicalBasePnu
            ),
        ];
        for (const pnu of orderedPnus) {
            parcelDrafts.push({
                pnu,
                role:
                    pnu === canonicalBasePnu
                        ? 'BASE'
                        : 'ATTACHED',
                scopeGroup: 'official-group-1',
            });
        }
    } else if (sortedGroupKeys.length === 0) {
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
    const candidateStrategyStatus =
        officialScopeCandidate?.resolution.strategy === 'LDAREG'
            ? ldaregStatus
            : officialScopeCandidate?.resolution.strategy === 'LADFRL'
              ? ladfrlStatus
              : null;
    if (
        officialScopeCandidate &&
        (candidateStrategyStatus !== 'SUCCESS' ||
            ldaregStatus === 'FAILED' ||
            ldaregStatus === 'INCOMPLETE' ||
            ladfrlStatus === 'FAILED' ||
            ladfrlStatus === 'INCOMPLETE')
    ) {
        officialScopeCandidate = null;
        warnings.add('SCOPE_CONFIRMATION_EVIDENCE_UNAVAILABLE');
    } else if (officialScopeCandidate) {
        warnings.add('SCOPE_REVERSE_LOOKUP_UNPROVEN');
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
        ...(officialScopeCandidate
            ? { scopeResolution: officialScopeCandidate.resolution }
            : {}),
        warnings: [...warnings].sort(),
    };
}
