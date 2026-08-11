import { createHash, randomUUID } from 'node:crypto';
import { parseBylotCnt } from '../services/land-area-sync/bylot';
import { normalizeRegistryManagementPk } from '../services/land-area-sync/registry-pk';
import {
    assembleAttachedPnus,
    buildingHubRowsMatchPnu,
    type AtchJibunRowInput,
} from '../services/gis-shared/pnu';
import type {
    BrAtchJibunRow,
    BrBasisOulnRow,
    BrTitleRow,
    StrictScan,
} from '../types/land-area-sync.types';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNU_RE = /^\d{10}[12]\d{8}$/;
const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;

export const DEVELOPMENT_RELATION_ADOPTION_TARGET_VERSION =
    'development-building-registry-relation-adoption-target@1' as const;
export const DEVELOPMENT_RELATION_ADOPTION_ARTIFACT_VERSION =
    'development-building-registry-relation-adoption-artifact@1' as const;
export const DEVELOPMENT_RELATION_ADOPTION_PUBLIC_ARTIFACT_VERSION =
    'development-building-registry-relation-adoption-public-artifact@1' as const;
export const DEVELOPMENT_RELATION_ADOPTION_MAX_ATTEMPTS = 3;
export const DEVELOPMENT_RELATION_ADOPTION_WRITER_CONTRACT =
    'adopt_development_verified_building_registry_relation_v1@1' as const;
export const DEVELOPMENT_RELATION_ADOPTION_INSPECTOR_CONTRACT =
    'development-building-registry-relation-inspector@1' as const;
export const DEVELOPMENT_RELATION_ADOPTION_PHASE0_ARTIFACT_VERSION =
    'land-area-phase0-capture-artifact@6' as const;

/**
 * 채택 트랙이 쓸 수 있는 DB 환경. DB 쪽 manifest CHECK
 * (20260811120000_generalize_relation_adoption_database_target) 와 같은 집합이어야 한다.
 * 승인은 (database_target, union_id) 로 분리 저장되므로 환경 간 승인이 섞이지 않는다.
 */
export const RELATION_ADOPTION_DATABASE_TARGETS = [
    'development',
    'production',
] as const;

export type RelationAdoptionDatabaseTarget =
    (typeof RELATION_ADOPTION_DATABASE_TARGETS)[number];

export function isRelationAdoptionDatabaseTarget(
    value: unknown
): value is RelationAdoptionDatabaseTarget {
    return (
        typeof value === 'string' &&
        (RELATION_ADOPTION_DATABASE_TARGETS as readonly string[]).includes(value)
    );
}

export interface DevelopmentRelationAdoptionTarget {
    version: typeof DEVELOPMENT_RELATION_ADOPTION_TARGET_VERSION;
    databaseTarget: RelationAdoptionDatabaseTarget;
    unionId: string;
    basePnu: string;
    attachedPnu: string;
    managementPk: string;
    expectedActivePropertyUnitCount: number;
    scopeDigest: string;
    phase0: {
        runId: string;
        artifactVersion: typeof DEVELOPMENT_RELATION_ADOPTION_PHASE0_ARTIFACT_VERSION;
        artifactSha256: string;
        schemaHash: string;
    };
    officialHashes: {
        managementPkHash: string;
        basePnuHash: string;
        attachedPnuHash: string;
        pairsDigest: string;
        titleSchemaHash: string;
        basisSchemaHash: string;
        attachedSchemaHash: string;
    };
    manifestDigest: string;
}

export interface DevelopmentRelationScanAdapter {
    scanTitle(
        pnu: string,
        auth: { serviceKey: string }
    ): Promise<StrictScan<BrTitleRow>>;
    scanBasis(
        pnu: string,
        auth: { serviceKey: string }
    ): Promise<StrictScan<BrBasisOulnRow>>;
    scanAttached(
        pnu: string,
        auth: { serviceKey: string }
    ): Promise<StrictScan<BrAtchJibunRow>>;
}

export interface DevelopmentRelationSnapshot {
    expectedActivePropertyUnitCount: number;
    expectedPropertyUnitDigest: string;
    landAreaApproval: {
        enabled: false;
        stableDigest: string;
    };
    relationAdoptionApproval: {
        rowCount: number;
        enabled: boolean;
        consumedAt: string | null;
        targetDigest: string | null;
        expiresAt: string | null;
    };
    targetRelation: {
        count: number;
        digest: string;
        activeCount: number;
        linkedCount: number;
    };
    hashes: {
        propertyUnits: string;
        propertyOwnerships: string;
        buildingLandLots: string;
        buildings: string;
        buildingUnits: string;
        buildingExternalRefs: string;
        landLots: string;
        landAreaTuples: string;
        landRightRows: string;
        landAreaSyncJobs: string;
        nonTargetRelations: string;
    };
    writeAttribution: DevelopmentRelationWriteAttribution | null;
}

export interface DevelopmentRelationAdoptionReceipt {
    status: 'CREATED' | 'UPDATED' | 'REUSED';
    relationId: string;
    observationId: string;
    buildingId: string;
    operationId: string;
    operationEpoch: number;
    commandId: string;
    syncJobId: string;
    projectionStatus: 'LINKED';
    basePnu: string;
    attachedPnu: string;
    managementPk: string;
    expectedPropertyUnitCount: number;
    expectedPropertyUnitDigest: string;
    targetDigest: string;
    phase0RunId: number;
    phase0ArtifactSha256: string;
    phase0SchemaHash: string;
    phase0PairDigest: string;
    sourceReleaseSha: string;
    landAreaApprovalStableDigest: string;
}

export interface DevelopmentRelationWriteAttribution {
    counts: {
        syncJobs: number;
        operations: number;
        inputPnus: number;
        commands: number;
        observations: number;
        observationPairs: number;
        groupStates: number;
        relations: number;
    };
    digest: string;
    relationProjectionStatuses: string[];
    attributedIdDigest: string;
}

export interface DevelopmentRelationAdoptionDatabase {
    readSnapshot(
        target: DevelopmentRelationAdoptionTarget,
        syncJobId: string | null
    ): Promise<DevelopmentRelationSnapshot>;
    adoptRelation(input: {
        target: DevelopmentRelationAdoptionTarget;
        expectedPropertyUnitDigest: string;
        targetDigest: string;
        sourceReleaseSha: string;
        syncJobId: string;
    }): Promise<DevelopmentRelationAdoptionReceipt>;
}

interface SanitizedOfficialScan {
    title: {
        state: 'COMPLETE';
        totalCount: number;
        pagesFetched: number;
        schemaHash: string;
    };
    basis: {
        state: 'COMPLETE';
        totalCount: number;
        pagesFetched: number;
        schemaHash: string;
    };
    attached: {
        state: 'COMPLETE';
        totalCount: number;
        pagesFetched: number;
        schemaHash: string;
    };
    managementPkHash: string;
    basePnuHash: string;
    attachedPnuHash: string;
    pairsDigest: string;
    totalPairs: 1;
    totalRejected: 0;
    bylotCount: 1;
}

export interface DevelopmentRelationAdoptionArtifact {
    version: typeof DEVELOPMENT_RELATION_ADOPTION_ARTIFACT_VERSION;
    databaseTarget: RelationAdoptionDatabaseTarget;
    manifestDigest: string;
    targetDigest: string | null;
    sourceReleaseSha: string;
    syncJobIdHash: string;
    phase0: {
        runId: string;
        artifactVersion: typeof DEVELOPMENT_RELATION_ADOPTION_PHASE0_ARTIFACT_VERSION;
        artifactSha256: string;
        schemaHash: string;
        priorArtifactValidated: true;
    };
    officialScan: SanitizedOfficialScan | null;
    relation: {
        beforeCount: number | null;
        afterCount: number | null;
        beforeDigest: string | null;
        afterDigest: string | null;
        afterActiveCount: number | null;
        afterLinkedCount: number | null;
    };
    invariantHashes: {
        before: DevelopmentRelationSnapshot['hashes'] | null;
        after: DevelopmentRelationSnapshot['hashes'] | null;
    };
    propertyMembership: {
        expectedCount: number;
        beforeCount: number | null;
        afterCount: number | null;
        beforeDigest: string | null;
        afterDigest: string | null;
    };
    landAreaApproval: {
        beforeEnabled: boolean | null;
        afterEnabled: boolean | null;
        beforeStableDigest: string | null;
        afterStableDigest: string | null;
    };
    writeAttribution: DevelopmentRelationWriteAttribution | null;
    dbApproval: {
        preinstalledVerified: boolean;
        consumedVerified: boolean;
    };
    adoptionCall: {
        attempts: number;
        maxAttempts: 3;
        receiptVerified: boolean;
        recoveredAfterAmbiguousError: boolean;
    };
    productionWrites: {
        observedWriteCount: 0;
        verificationBoundary:
            'NO_PRODUCTION_CLIENT_CONSTRUCTED_DEVELOPMENT_PROJECT_REF_PINNED';
    };
    manualDataUsage: {
        sourceReads: 0;
        blockerReads: 0;
        fallbackWrites: 0;
    };
    gate: {
        status: 'PASS' | 'FAIL';
        failureCodes: string[];
    };
}

export interface DevelopmentRelationAdoptionPublicArtifact {
    version: typeof DEVELOPMENT_RELATION_ADOPTION_PUBLIC_ARTIFACT_VERSION;
    databaseTarget: RelationAdoptionDatabaseTarget;
    manifestDigest: string;
    targetDigest: string | null;
    sourceReleaseSha: string;
    syncJobIdHash: string;
    phase0: DevelopmentRelationAdoptionArtifact['phase0'];
    officialScan: SanitizedOfficialScan | null;
    relation: DevelopmentRelationAdoptionArtifact['relation'];
    invariantHashes: DevelopmentRelationAdoptionArtifact['invariantHashes'];
    propertyMembership: DevelopmentRelationAdoptionArtifact['propertyMembership'];
    landAreaApproval: DevelopmentRelationAdoptionArtifact['landAreaApproval'];
    writeAttribution: DevelopmentRelationWriteAttribution | null;
    dbApproval: DevelopmentRelationAdoptionArtifact['dbApproval'];
    adoptionCall: DevelopmentRelationAdoptionArtifact['adoptionCall'];
    productionWrites: DevelopmentRelationAdoptionArtifact['productionWrites'];
    manualDataUsage: DevelopmentRelationAdoptionArtifact['manualDataUsage'];
    gate: DevelopmentRelationAdoptionArtifact['gate'];
}

export interface RunDevelopmentRelationAdoptionInput {
    target: DevelopmentRelationAdoptionTarget;
    sourceReleaseSha: string;
    buildingHubServiceKey: string;
    adapter: DevelopmentRelationScanAdapter;
    database: DevelopmentRelationAdoptionDatabase;
    priorPhase0Validation: {
        artifactSha256: string;
        schemaHash: string;
        managementPkHash: string;
        basePnuHash: string;
        attachedPnuHash: string;
        pairsDigest: string;
    };
    randomUuid?: () => string;
}

class ControlledRelationAdoptionError extends Error {
    constructor(readonly code: string) {
        super(code);
        this.name = 'ControlledRelationAdoptionError';
    }
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ControlledRelationAdoptionError(code);
    }
    return value as Record<string, unknown>;
}

function hasExactKeys(
    value: Record<string, unknown>,
    keys: readonly string[]
): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return JSON.stringify(actual) === JSON.stringify(expected);
}

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) {
            if (record[key] !== undefined) {
                result[key] = canonicalize(record[key]);
            }
        }
        return result;
    }
    return value;
}

function stableStringify(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

function schemaHash(rows: unknown[]): string {
    const tokens = new Set<string>();
    const visit = (value: unknown, path: string, depth: number): void => {
        if (depth > 12) {
            tokens.add(`${path}:DEPTH_LIMIT`);
            return;
        }
        if (value === null) {
            tokens.add(`${path}:null`);
            return;
        }
        if (Array.isArray(value)) {
            tokens.add(`${path}:array`);
            for (const item of value) visit(item, `${path}[]`, depth + 1);
            return;
        }
        if (typeof value === 'object') {
            tokens.add(`${path}:object`);
            for (const key of Object.keys(
                value as Record<string, unknown>
            ).sort()) {
                visit(
                    (value as Record<string, unknown>)[key],
                    `${path}.${key}`,
                    depth + 1
                );
            }
            return;
        }
        tokens.add(`${path}:${typeof value}`);
    };
    for (const row of rows) visit(row, '$', 0);
    return sha256([...tokens].sort().join('\n'));
}

function targetIdentity(
    target: Omit<DevelopmentRelationAdoptionTarget, 'manifestDigest'>
): string {
    return stableStringify({
        ...target,
        unionId: target.unionId.toLowerCase(),
    });
}

export function computeDevelopmentRelationAdoptionManifestDigest(
    target: Omit<DevelopmentRelationAdoptionTarget, 'manifestDigest'>
): string {
    return sha256(targetIdentity(target));
}

export function computeDevelopmentRelationAdoptionExecutionTargetDigest(input: {
    target: DevelopmentRelationAdoptionTarget;
    expectedPropertyUnitDigest: string;
    sourceReleaseSha: string;
}): string {
    if (
        !HEX64_RE.test(input.expectedPropertyUnitDigest) ||
        !HEX40_RE.test(input.sourceReleaseSha)
    ) {
        throw new ControlledRelationAdoptionError(
            'RELATION_EXECUTION_TARGET_DIGEST_INPUT_INVALID'
        );
    }
    return sha256(
        [
            'relation-adoption-target@1',
            // ⚠️ 환경값이 아니다. DB 의
            // private.compute_development_relation_adoption_target_digest_v1 이
            // 해시 입력에 쓰는 namespace 토큰의 미러이며, 그 함수는 IMMUTABLE·무인자라
            // identity 를 읽을 수 없어 일반화 대상에서 의도적으로 제외했다.
            // 여기를 databaseTarget 으로 바꾸면 TS 와 DB 의 target digest 가 갈라져
            // 모든 채택이 digest 불일치로 거부된다.
            'development',
            input.target.unionId.toLowerCase(),
            input.target.basePnu,
            input.target.attachedPnu,
            input.target.managementPk,
            String(input.target.expectedActivePropertyUnitCount),
            input.expectedPropertyUnitDigest,
            input.target.phase0.runId,
            input.target.phase0.artifactVersion,
            input.target.phase0.artifactSha256,
            input.target.phase0.schemaHash,
            input.target.officialHashes.pairsDigest,
            input.sourceReleaseSha,
            [input.target.basePnu, input.target.attachedPnu]
                .sort()
                .join(','),
        ].join('\n')
    );
}

function parsePhase0(value: unknown): DevelopmentRelationAdoptionTarget['phase0'] {
    const phase0 = asRecord(value, 'RELATION_TARGET_INVALID');
    if (
        !hasExactKeys(phase0, [
            'runId',
            'artifactVersion',
            'artifactSha256',
            'schemaHash',
        ]) ||
        typeof phase0.runId !== 'string' ||
        !POSITIVE_INTEGER_RE.test(phase0.runId) ||
        phase0.artifactVersion !==
            DEVELOPMENT_RELATION_ADOPTION_PHASE0_ARTIFACT_VERSION ||
        typeof phase0.artifactSha256 !== 'string' ||
        !HEX64_RE.test(phase0.artifactSha256) ||
        typeof phase0.schemaHash !== 'string' ||
        !HEX64_RE.test(phase0.schemaHash)
    ) {
        throw new ControlledRelationAdoptionError('RELATION_TARGET_INVALID');
    }
    return phase0 as unknown as DevelopmentRelationAdoptionTarget['phase0'];
}

function parseOfficialHashes(
    value: unknown
): DevelopmentRelationAdoptionTarget['officialHashes'] {
    const hashes = asRecord(value, 'RELATION_TARGET_INVALID');
    const keys = [
        'managementPkHash',
        'basePnuHash',
        'attachedPnuHash',
        'pairsDigest',
        'titleSchemaHash',
        'basisSchemaHash',
        'attachedSchemaHash',
    ] as const;
    if (
        !hasExactKeys(hashes, keys) ||
        keys.some(
            (key) =>
                typeof hashes[key] !== 'string' ||
                !HEX64_RE.test(hashes[key] as string)
        )
    ) {
        throw new ControlledRelationAdoptionError('RELATION_TARGET_INVALID');
    }
    return hashes as unknown as DevelopmentRelationAdoptionTarget['officialHashes'];
}

export function parseDevelopmentRelationAdoptionTarget(
    input: unknown
): DevelopmentRelationAdoptionTarget {
    const value = asRecord(input, 'RELATION_TARGET_INVALID');
    if (
        !hasExactKeys(value, [
            'version',
            'databaseTarget',
            'unionId',
            'basePnu',
            'attachedPnu',
            'managementPk',
            'expectedActivePropertyUnitCount',
            'scopeDigest',
            'phase0',
            'officialHashes',
            'manifestDigest',
        ]) ||
        value.version !== DEVELOPMENT_RELATION_ADOPTION_TARGET_VERSION ||
        !isRelationAdoptionDatabaseTarget(value.databaseTarget) ||
        typeof value.unionId !== 'string' ||
        !UUID_RE.test(value.unionId) ||
        value.unionId !== value.unionId.toLowerCase() ||
        typeof value.basePnu !== 'string' ||
        !PNU_RE.test(value.basePnu) ||
        typeof value.attachedPnu !== 'string' ||
        !PNU_RE.test(value.attachedPnu) ||
        value.basePnu === value.attachedPnu ||
        typeof value.managementPk !== 'string' ||
        normalizeRegistryManagementPk(value.managementPk) !==
            value.managementPk ||
        !Number.isSafeInteger(value.expectedActivePropertyUnitCount) ||
        (value.expectedActivePropertyUnitCount as number) <= 0 ||
        typeof value.scopeDigest !== 'string' ||
        !HEX64_RE.test(value.scopeDigest) ||
        typeof value.manifestDigest !== 'string' ||
        !HEX64_RE.test(value.manifestDigest)
    ) {
        throw new ControlledRelationAdoptionError('RELATION_TARGET_INVALID');
    }
    const phase0 = parsePhase0(value.phase0);
    const officialHashes = parseOfficialHashes(value.officialHashes);
    const target = {
        ...value,
        phase0,
        officialHashes,
    } as unknown as DevelopmentRelationAdoptionTarget;
    const { manifestDigest: _manifestDigest, ...identity } = target;
    if (
        target.manifestDigest !==
            computeDevelopmentRelationAdoptionManifestDigest(identity) ||
        target.officialHashes.managementPkHash !==
            sha256(`MGM_BLDRGST_PK\u0000${target.managementPk}`) ||
        target.officialHashes.basePnuHash !==
            sha256(`PNU\u0000${target.basePnu}`) ||
        target.officialHashes.attachedPnuHash !==
            sha256(`PNU\u0000${target.attachedPnu}`)
    ) {
        throw new ControlledRelationAdoptionError('RELATION_TARGET_INVALID');
    }
    return target;
}

function completeRows<T>(
    scan: StrictScan<T>,
    code: string
): { rows: T[]; totalCount: number; pagesFetched: number } {
    if (
        scan.state !== 'COMPLETE' ||
        !Number.isSafeInteger(scan.totalCount) ||
        scan.totalCount <= 0 ||
        scan.rows.length !== scan.totalCount ||
        !Number.isSafeInteger(scan.pagesFetched) ||
        scan.pagesFetched <= 0
    ) {
        throw new ControlledRelationAdoptionError(code);
    }
    return {
        rows: scan.rows,
        totalCount: scan.totalCount,
        pagesFetched: scan.pagesFetched,
    };
}

function toAttachedInput(row: BrAtchJibunRow): AtchJibunRowInput {
    const text = (value: unknown): string =>
        typeof value === 'string' ? value : '';
    return {
        mgmBldrgstPk:
            normalizeRegistryManagementPk(row.mgmBldrgstPk) ?? '',
        sigunguCd: text(row.sigunguCd),
        bjdongCd: text(row.bjdongCd),
        platGbCd: text(row.platGbCd),
        bun: text(row.bun),
        ji: text(row.ji),
        atchSigunguCd: text(row.atchSigunguCd),
        atchBjdongCd: text(row.atchBjdongCd),
        atchPlatGbCd: text(row.atchPlatGbCd),
        atchBun: text(row.atchBun),
        atchJi: text(row.atchJi),
    };
}

function rootManagementPk(
    row: BrTitleRow | BrBasisOulnRow
): string | null {
    const up = normalizeRegistryManagementPk(row.mgmUpBldrgstPk);
    return up && up !== '0'
        ? up
        : normalizeRegistryManagementPk(row.mgmBldrgstPk);
}

function sanitizedPairDigest(input: {
    managementPkHash: string;
    basePnuHash: string;
    attachedPnuHash: string;
}): string {
    return sha256(stableStringify([input]));
}

export async function scanAndValidateDevelopmentOfficialRelation(input: {
    target: DevelopmentRelationAdoptionTarget;
    adapter: DevelopmentRelationScanAdapter;
    serviceKey: string;
}): Promise<SanitizedOfficialScan> {
    const auth = { serviceKey: input.serviceKey };
    // 공공데이터포털 Building HUB는 같은 키의 동시 요청을 간헐적으로
    // 오류 envelope로 반환한다. Phase 0과 동일하게 직렬 조회해 각 strict
    // scan의 자체 재시도 정책과 완전성 판정을 보존한다.
    const titleScan = await input.adapter.scanTitle(
        input.target.basePnu,
        auth
    );
    const basisScan = await input.adapter.scanBasis(
        input.target.basePnu,
        auth
    );
    const attachedScan = await input.adapter.scanAttached(
        input.target.basePnu,
        auth
    );
    const title = completeRows(titleScan, 'OFFICIAL_TITLE_NOT_COMPLETE');
    const basis = completeRows(basisScan, 'OFFICIAL_BASIS_NOT_COMPLETE');
    const attached = completeRows(
        attachedScan,
        'OFFICIAL_ATTACHED_NOT_COMPLETE'
    );
    if (
        !buildingHubRowsMatchPnu(
            title.rows as Array<Record<string, unknown>>,
            input.target.basePnu
        ) ||
        !buildingHubRowsMatchPnu(
            basis.rows as Array<Record<string, unknown>>,
            input.target.basePnu
        )
    ) {
        throw new ControlledRelationAdoptionError(
            'OFFICIAL_BASE_PNU_MISMATCH'
        );
    }
    const roots = new Set(
        [...title.rows, ...basis.rows]
            .map(rootManagementPk)
            .filter((value): value is string => value !== null)
    );
    const registryRows = [...title.rows, ...basis.rows];
    const hasInvalidBylot = registryRows.some((row) => {
        const parsed = parseBylotCnt(row.bylotCnt);
        return !parsed.valid || parsed.count !== 1;
    });
    if (
        roots.size !== 1 ||
        !roots.has(input.target.managementPk) ||
        registryRows.some(
            (row) => rootManagementPk(row) !== input.target.managementPk
        )
        || hasInvalidBylot
    ) {
        throw new ControlledRelationAdoptionError(
            'OFFICIAL_ROOT_OR_BYLOT_MISMATCH'
        );
    }
    const assembled = assembleAttachedPnus(
        attached.rows.map(toAttachedInput)
    );
    if (
        assembled.rejected.length !== 0 ||
        assembled.pairs.length !== 1 ||
        assembled.pairs[0].basePnu !== input.target.basePnu ||
        assembled.pairs[0].attachedPnu !== input.target.attachedPnu ||
        assembled.pairs[0].mgmBldrgstPk !== input.target.managementPk
    ) {
        throw new ControlledRelationAdoptionError(
            'OFFICIAL_ATTACHED_PAIR_MISMATCH'
        );
    }

    const titleSchemaHash = schemaHash(title.rows);
    const basisSchemaHash = schemaHash(basis.rows);
    const attachedSchemaHash = schemaHash(attached.rows);
    const managementPkHash = sha256(
        `MGM_BLDRGST_PK\u0000${input.target.managementPk}`
    );
    const basePnuHash = sha256(`PNU\u0000${input.target.basePnu}`);
    const attachedPnuHash = sha256(
        `PNU\u0000${input.target.attachedPnu}`
    );
    const pairsDigest = sanitizedPairDigest({
        managementPkHash,
        basePnuHash,
        attachedPnuHash,
    });
    if (
        titleSchemaHash !== input.target.officialHashes.titleSchemaHash ||
        basisSchemaHash !== input.target.officialHashes.basisSchemaHash ||
        attachedSchemaHash !==
            input.target.officialHashes.attachedSchemaHash ||
        managementPkHash !==
            input.target.officialHashes.managementPkHash ||
        basePnuHash !== input.target.officialHashes.basePnuHash ||
        attachedPnuHash !== input.target.officialHashes.attachedPnuHash ||
        pairsDigest !== input.target.officialHashes.pairsDigest
    ) {
        throw new ControlledRelationAdoptionError(
            'OFFICIAL_PHASE0_HASH_MISMATCH'
        );
    }
    return {
        title: {
            state: 'COMPLETE',
            totalCount: title.totalCount,
            pagesFetched: title.pagesFetched,
            schemaHash: titleSchemaHash,
        },
        basis: {
            state: 'COMPLETE',
            totalCount: basis.totalCount,
            pagesFetched: basis.pagesFetched,
            schemaHash: basisSchemaHash,
        },
        attached: {
            state: 'COMPLETE',
            totalCount: attached.totalCount,
            pagesFetched: attached.pagesFetched,
            schemaHash: attachedSchemaHash,
        },
        managementPkHash,
        basePnuHash,
        attachedPnuHash,
        pairsDigest,
        totalPairs: 1,
        totalRejected: 0,
        bylotCount: 1,
    };
}

function validateSnapshot(
    target: DevelopmentRelationAdoptionTarget,
    snapshot: DevelopmentRelationSnapshot,
    phase: 'PRE' | 'POST'
): void {
    if (
        snapshot.expectedActivePropertyUnitCount !==
            target.expectedActivePropertyUnitCount ||
        !HEX64_RE.test(snapshot.expectedPropertyUnitDigest) ||
        snapshot.landAreaApproval.enabled !== false ||
        !HEX64_RE.test(snapshot.landAreaApproval.stableDigest) ||
        !Number.isSafeInteger(
            snapshot.relationAdoptionApproval.rowCount
        ) ||
        snapshot.relationAdoptionApproval.rowCount < 0 ||
        snapshot.relationAdoptionApproval.rowCount > 1 ||
        typeof snapshot.relationAdoptionApproval.enabled !== 'boolean' ||
        (snapshot.relationAdoptionApproval.consumedAt !== null &&
            !Number.isFinite(
                Date.parse(
                    snapshot.relationAdoptionApproval.consumedAt
                )
            )) ||
        (snapshot.relationAdoptionApproval.targetDigest !== null &&
            !HEX64_RE.test(
                snapshot.relationAdoptionApproval.targetDigest
            )) ||
        (snapshot.relationAdoptionApproval.expiresAt !== null &&
            !Number.isFinite(
                Date.parse(
                    snapshot.relationAdoptionApproval.expiresAt
                )
            )) ||
        snapshot.targetRelation.count < 0 ||
        snapshot.targetRelation.activeCount < 0 ||
        snapshot.targetRelation.linkedCount < 0 ||
        !HEX64_RE.test(snapshot.targetRelation.digest) ||
        Object.values(snapshot.hashes).some((hash) => !HEX64_RE.test(hash))
    ) {
        throw new ControlledRelationAdoptionError(
            `${phase}FLIGHT_SNAPSHOT_INVALID`
        );
    }
}

function validatePreinstalledApproval(input: {
    snapshot: DevelopmentRelationSnapshot;
    targetDigest: string;
}): void {
    const approval = input.snapshot.relationAdoptionApproval;
    if (
        approval.rowCount !== 1 ||
        approval.enabled !== true ||
        approval.consumedAt !== null ||
        approval.targetDigest !== input.targetDigest ||
        approval.expiresAt === null
    ) {
        throw new ControlledRelationAdoptionError(
            'RELATION_PREINSTALLED_APPROVAL_INVALID'
        );
    }
}

function validateConsumedApproval(input: {
    snapshot: DevelopmentRelationSnapshot;
    targetDigest: string;
}): void {
    const approval = input.snapshot.relationAdoptionApproval;
    if (
        approval.rowCount !== 1 ||
        approval.enabled !== false ||
        approval.consumedAt === null ||
        approval.targetDigest !== input.targetDigest
    ) {
        throw new ControlledRelationAdoptionError(
            'RELATION_APPROVAL_POSTSTATE_INVALID'
        );
    }
}

function validateAdoptionReceipt(input: {
    target: DevelopmentRelationAdoptionTarget;
    receipt: DevelopmentRelationAdoptionReceipt;
    sourceReleaseSha: string;
    syncJobId: string;
    expectedPropertyUnitDigest: string;
    targetDigest: string;
    expectedLandAreaApprovalStableDigest: string;
}): void {
    const { target, receipt } = input;
    if (
        (receipt.status !== 'CREATED' &&
            receipt.status !== 'UPDATED' &&
            receipt.status !== 'REUSED') ||
        !UUID_RE.test(receipt.relationId) ||
        !UUID_RE.test(receipt.observationId) ||
        !UUID_RE.test(receipt.buildingId) ||
        !UUID_RE.test(receipt.operationId) ||
        !Number.isSafeInteger(receipt.operationEpoch) ||
        receipt.operationEpoch <= 0 ||
        !UUID_RE.test(receipt.commandId) ||
        receipt.syncJobId.toLowerCase() !== input.syncJobId ||
        receipt.projectionStatus !== 'LINKED' ||
        receipt.basePnu !== target.basePnu ||
        receipt.attachedPnu !== target.attachedPnu ||
        receipt.managementPk !== target.managementPk ||
        receipt.expectedPropertyUnitCount !==
            target.expectedActivePropertyUnitCount ||
        receipt.expectedPropertyUnitDigest !==
            input.expectedPropertyUnitDigest ||
        receipt.targetDigest !== input.targetDigest ||
        receipt.phase0RunId !== Number(target.phase0.runId) ||
        receipt.phase0ArtifactSha256 !== target.phase0.artifactSha256 ||
        receipt.phase0SchemaHash !== target.phase0.schemaHash ||
        receipt.phase0PairDigest !==
            target.officialHashes.pairsDigest ||
        receipt.sourceReleaseSha !== input.sourceReleaseSha ||
        receipt.landAreaApprovalStableDigest !==
            input.expectedLandAreaApprovalStableDigest
    ) {
        throw new ControlledRelationAdoptionError(
            'RELATION_ADOPTION_RECEIPT_INVALID'
        );
    }
}

function assertUnchangedCore(
    before: DevelopmentRelationSnapshot,
    after: DevelopmentRelationSnapshot
): void {
    const changed = Object.entries(before.hashes)
        .filter(([key]) => key !== 'nonTargetRelations')
        .some(
            ([key, value]) =>
                after.hashes[
                    key as keyof DevelopmentRelationSnapshot['hashes']
                ] !== value
        );
    if (changed) {
        throw new ControlledRelationAdoptionError(
            'FORBIDDEN_CANONICAL_TABLE_CHANGED'
        );
    }
    if (
        before.hashes.nonTargetRelations !==
        after.hashes.nonTargetRelations
    ) {
        throw new ControlledRelationAdoptionError(
            'NON_TARGET_RELATION_CHANGED'
        );
    }
    if (
        before.expectedActivePropertyUnitCount !==
            after.expectedActivePropertyUnitCount ||
        before.expectedPropertyUnitDigest !==
            after.expectedPropertyUnitDigest
    ) {
        throw new ControlledRelationAdoptionError(
            'PROPERTY_MEMBERSHIP_CHANGED'
        );
    }
    if (
        before.landAreaApproval.enabled !== false ||
        after.landAreaApproval.enabled !== false ||
        before.landAreaApproval.stableDigest !==
            after.landAreaApproval.stableDigest
    ) {
        throw new ControlledRelationAdoptionError(
            'LAND_AREA_APPROVAL_BARRIER_CHANGED'
        );
    }
}

function validatePostRelation(
    snapshot: DevelopmentRelationSnapshot
): void {
    if (
        snapshot.targetRelation.count !== 1 ||
        snapshot.targetRelation.activeCount !== 1 ||
        snapshot.targetRelation.linkedCount !== 1
    ) {
        throw new ControlledRelationAdoptionError(
            'POSTFLIGHT_RELATION_NOT_SINGLE_LINKED'
        );
    }
}

function validateAttribution(
    attribution: DevelopmentRelationWriteAttribution
): void {
    const expected = {
        syncJobs: 1,
        operations: 1,
        inputPnus: 1,
        commands: 1,
        observations: 1,
        observationPairs: 1,
        groupStates: 1,
        relations: 1,
    };
    if (
        JSON.stringify(attribution.counts) !== JSON.stringify(expected) ||
        !HEX64_RE.test(attribution.digest) ||
        !HEX64_RE.test(attribution.attributedIdDigest) ||
        JSON.stringify(attribution.relationProjectionStatuses) !==
            JSON.stringify(['LINKED'])
    ) {
        throw new ControlledRelationAdoptionError(
            'WRITE_ATTRIBUTION_INVALID'
        );
    }
}

function failureCode(error: unknown): string {
    if (error instanceof ControlledRelationAdoptionError) {
        return error.code;
    }
    return 'UNEXPECTED_RELATION_ADOPTION_FAILURE';
}

async function adoptRelationWithRetry(input: {
    database: DevelopmentRelationAdoptionDatabase;
    target: DevelopmentRelationAdoptionTarget;
    expectedPropertyUnitDigest: string;
    targetDigest: string;
    sourceReleaseSha: string;
    syncJobId: string;
    expectedLandAreaApprovalStableDigest: string;
    onAttempt: (attempt: number) => void;
}): Promise<DevelopmentRelationAdoptionReceipt> {
    const request = {
        target: input.target,
        expectedPropertyUnitDigest: input.expectedPropertyUnitDigest,
        targetDigest: input.targetDigest,
        sourceReleaseSha: input.sourceReleaseSha,
        syncJobId: input.syncJobId,
    };
    let lastError: unknown = null;
    for (
        let attempt = 1;
        attempt <= DEVELOPMENT_RELATION_ADOPTION_MAX_ATTEMPTS;
        attempt += 1
    ) {
        input.onAttempt(attempt);
        try {
            const receipt = await input.database.adoptRelation(request);
            validateAdoptionReceipt({
                target: input.target,
                receipt,
                sourceReleaseSha: input.sourceReleaseSha,
                syncJobId: input.syncJobId,
                expectedPropertyUnitDigest:
                    input.expectedPropertyUnitDigest,
                targetDigest: input.targetDigest,
                expectedLandAreaApprovalStableDigest:
                    input.expectedLandAreaApprovalStableDigest,
            });
            return receipt;
        } catch (error) {
            lastError = error;
        }
    }
    throw (
        lastError ??
        new ControlledRelationAdoptionError(
            'RELATION_ADOPTION_RETRY_EXHAUSTED'
        )
    );
}

export async function runDevelopmentRelationAdoption(
    input: RunDevelopmentRelationAdoptionInput
): Promise<DevelopmentRelationAdoptionArtifact> {
    if (
        !HEX40_RE.test(input.sourceReleaseSha) ||
        !input.buildingHubServiceKey.trim() ||
        input.buildingHubServiceKey.length > 4096 ||
        input.priorPhase0Validation.artifactSha256 !==
            input.target.phase0.artifactSha256 ||
        input.priorPhase0Validation.schemaHash !==
            input.target.phase0.schemaHash ||
        input.priorPhase0Validation.managementPkHash !==
            input.target.officialHashes.managementPkHash ||
        input.priorPhase0Validation.basePnuHash !==
            input.target.officialHashes.basePnuHash ||
        input.priorPhase0Validation.attachedPnuHash !==
            input.target.officialHashes.attachedPnuHash ||
        input.priorPhase0Validation.pairsDigest !==
            input.target.officialHashes.pairsDigest
    ) {
        throw new ControlledRelationAdoptionError(
            'RELATION_RUN_ENVIRONMENT_INVALID'
        );
    }
    const syncJobId = (input.randomUuid ?? randomUUID)().toLowerCase();
    if (!UUID_RE.test(syncJobId)) {
        throw new ControlledRelationAdoptionError(
            'RELATION_SYNC_JOB_ID_INVALID'
        );
    }
    let officialScan: SanitizedOfficialScan | null = null;
    let before: DevelopmentRelationSnapshot | null = null;
    let after: DevelopmentRelationSnapshot | null = null;
    let receipt: DevelopmentRelationAdoptionReceipt | null = null;
    let writeAttribution: DevelopmentRelationWriteAttribution | null = null;
    let preinstalledApprovalVerified = false;
    let consumedApprovalVerified = false;
    let adoptionCallAttempts = 0;
    let adoptionReceiptVerified = false;
    let executionTargetDigest: string | null = null;
    const failureCodes = new Set<string>();

    try {
        officialScan =
            await scanAndValidateDevelopmentOfficialRelation({
                target: input.target,
                adapter: input.adapter,
                serviceKey: input.buildingHubServiceKey,
            });
        before = await input.database.readSnapshot(input.target, null);
        validateSnapshot(input.target, before, 'PRE');
        executionTargetDigest =
            computeDevelopmentRelationAdoptionExecutionTargetDigest({
                target: input.target,
                expectedPropertyUnitDigest:
                    before.expectedPropertyUnitDigest,
                sourceReleaseSha: input.sourceReleaseSha,
            });
        validatePreinstalledApproval({
            snapshot: before,
            targetDigest: executionTargetDigest,
        });
        preinstalledApprovalVerified = true;

        receipt = await adoptRelationWithRetry({
            database: input.database,
            target: input.target,
            expectedPropertyUnitDigest:
                before.expectedPropertyUnitDigest,
            targetDigest: executionTargetDigest,
            sourceReleaseSha: input.sourceReleaseSha,
            syncJobId,
            expectedLandAreaApprovalStableDigest:
                before.landAreaApproval.stableDigest,
            onAttempt: (attempt) => {
                adoptionCallAttempts = attempt;
            },
        });
        adoptionReceiptVerified = true;
    } catch (error) {
        failureCodes.add(failureCode(error));
    }

    if (before !== null) {
        try {
            after = await input.database.readSnapshot(
                input.target,
                syncJobId
            );
            validateSnapshot(input.target, after, 'POST');
            assertUnchangedCore(before, after);
            if (adoptionCallAttempts > 0) {
                validatePostRelation(after);
                validateConsumedApproval({
                    snapshot: after,
                    targetDigest: executionTargetDigest!,
                });
                consumedApprovalVerified = true;
            }
        } catch (error) {
            failureCodes.add(failureCode(error));
        }
    }
    if (consumedApprovalVerified && after !== null) {
        try {
            const candidateAttribution = after.writeAttribution;
            if (candidateAttribution === null) {
                throw new ControlledRelationAdoptionError(
                    'WRITE_ATTRIBUTION_MISSING'
                );
            }
            validateAttribution(candidateAttribution);
            writeAttribution = candidateAttribution;
        } catch (error) {
            failureCodes.add(failureCode(error));
        }
    }

    if (
        receipt === null ||
        officialScan === null ||
        before === null ||
        after === null ||
        writeAttribution === null ||
        !preinstalledApprovalVerified ||
        !consumedApprovalVerified ||
        !adoptionReceiptVerified
    ) {
        failureCodes.add('RELATION_ADOPTION_INCOMPLETE');
    }

    const sortedFailures = [...failureCodes].sort();
    return {
        version: DEVELOPMENT_RELATION_ADOPTION_ARTIFACT_VERSION,
        databaseTarget: input.target.databaseTarget,
        manifestDigest: input.target.manifestDigest,
        targetDigest: executionTargetDigest,
        sourceReleaseSha: input.sourceReleaseSha,
        syncJobIdHash: sha256(`SYNC_JOB_ID\u0000${syncJobId}`),
        phase0: {
            ...input.target.phase0,
            priorArtifactValidated: true,
        },
        officialScan,
        relation: {
            beforeCount: before?.targetRelation.count ?? null,
            afterCount: after?.targetRelation.count ?? null,
            beforeDigest: before?.targetRelation.digest ?? null,
            afterDigest: after?.targetRelation.digest ?? null,
            afterActiveCount:
                after?.targetRelation.activeCount ?? null,
            afterLinkedCount:
                after?.targetRelation.linkedCount ?? null,
        },
        invariantHashes: {
            before: before?.hashes ?? null,
            after: after?.hashes ?? null,
        },
        propertyMembership: {
            expectedCount:
                input.target.expectedActivePropertyUnitCount,
            beforeCount:
                before?.expectedActivePropertyUnitCount ?? null,
            afterCount:
                after?.expectedActivePropertyUnitCount ?? null,
            beforeDigest:
                before?.expectedPropertyUnitDigest ?? null,
            afterDigest:
                after?.expectedPropertyUnitDigest ?? null,
        },
        landAreaApproval: {
            beforeEnabled:
                before?.landAreaApproval.enabled ?? null,
            afterEnabled:
                after?.landAreaApproval.enabled ?? null,
            beforeStableDigest:
                before?.landAreaApproval.stableDigest ?? null,
            afterStableDigest:
                after?.landAreaApproval.stableDigest ?? null,
        },
        writeAttribution,
        dbApproval: {
            preinstalledVerified: preinstalledApprovalVerified,
            consumedVerified: consumedApprovalVerified,
        },
        adoptionCall: {
            attempts: adoptionCallAttempts,
            maxAttempts:
                DEVELOPMENT_RELATION_ADOPTION_MAX_ATTEMPTS,
            receiptVerified: adoptionReceiptVerified,
            recoveredAfterAmbiguousError:
                adoptionReceiptVerified && adoptionCallAttempts > 1,
        },
        productionWrites: {
            observedWriteCount: 0,
            verificationBoundary:
                'NO_PRODUCTION_CLIENT_CONSTRUCTED_DEVELOPMENT_PROJECT_REF_PINNED',
        },
        manualDataUsage: {
            sourceReads: 0,
            blockerReads: 0,
            fallbackWrites: 0,
        },
        gate: {
            status: sortedFailures.length === 0 ? 'PASS' : 'FAIL',
            failureCodes: sortedFailures,
        },
    };
}

export function validateDevelopmentRelationAdoptionPublicArtifact(input: {
    target: DevelopmentRelationAdoptionTarget;
    expectedSourceReleaseSha: string;
    artifact: unknown;
}): DevelopmentRelationAdoptionPublicArtifact {
    const artifact = asRecord(
        input.artifact,
        'RELATION_PUBLIC_ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(artifact, [
            'version',
            'databaseTarget',
            'manifestDigest',
            'targetDigest',
            'sourceReleaseSha',
            'syncJobIdHash',
            'phase0',
            'officialScan',
            'relation',
            'invariantHashes',
            'propertyMembership',
            'landAreaApproval',
            'writeAttribution',
            'dbApproval',
            'adoptionCall',
            'productionWrites',
            'manualDataUsage',
            'gate',
        ]) ||
        artifact.version !==
            DEVELOPMENT_RELATION_ADOPTION_PUBLIC_ARTIFACT_VERSION ||
        artifact.databaseTarget !== input.target.databaseTarget ||
        artifact.manifestDigest !== input.target.manifestDigest ||
        (artifact.targetDigest !== null &&
            (typeof artifact.targetDigest !== 'string' ||
                !HEX64_RE.test(artifact.targetDigest))) ||
        artifact.sourceReleaseSha !== input.expectedSourceReleaseSha ||
        typeof artifact.syncJobIdHash !== 'string' ||
        !HEX64_RE.test(artifact.syncJobIdHash)
    ) {
        throw new ControlledRelationAdoptionError(
            'RELATION_PUBLIC_ARTIFACT_INVALID'
        );
    }
    const serialized = JSON.stringify(artifact);
    if (
        serialized.includes(input.target.basePnu) ||
        serialized.includes(input.target.attachedPnu) ||
        serialized.includes(input.target.managementPk)
    ) {
        throw new ControlledRelationAdoptionError(
            'RELATION_PUBLIC_ARTIFACT_RAW_IDENTITY_EXPOSED'
        );
    }
    const phase0 = asRecord(
        artifact.phase0,
        'RELATION_PUBLIC_ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(phase0, [
            'runId',
            'artifactVersion',
            'artifactSha256',
            'schemaHash',
            'priorArtifactValidated',
        ]) ||
        phase0.runId !== input.target.phase0.runId ||
        phase0.artifactVersion !==
            input.target.phase0.artifactVersion ||
        phase0.artifactSha256 !== input.target.phase0.artifactSha256 ||
        phase0.schemaHash !== input.target.phase0.schemaHash ||
        phase0.priorArtifactValidated !== true
    ) {
        throw new ControlledRelationAdoptionError(
            'RELATION_PUBLIC_ARTIFACT_INVALID'
        );
    }
    const gate = asRecord(
        artifact.gate,
        'RELATION_PUBLIC_ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(gate, ['status', 'failureCodes']) ||
        (gate.status !== 'PASS' && gate.status !== 'FAIL') ||
        !Array.isArray(gate.failureCodes) ||
        !gate.failureCodes.every(
            (code) =>
                typeof code === 'string' &&
                /^[A-Z][A-Z0-9_]{0,99}$/.test(code)
        ) ||
        gate.failureCodes.length !==
            new Set(gate.failureCodes).size ||
        JSON.stringify(gate.failureCodes) !==
            JSON.stringify([...(gate.failureCodes as string[])].sort()) ||
        (gate.status === 'PASS') !==
            (gate.failureCodes.length === 0)
    ) {
        throw new ControlledRelationAdoptionError(
            'RELATION_PUBLIC_ARTIFACT_INVALID'
        );
    }

    const nullableCountIsValid = (value: unknown): boolean =>
        value === null ||
        (typeof value === 'number' &&
            Number.isSafeInteger(value) &&
            value >= 0);
    const nullableDigestIsValid = (value: unknown): boolean =>
        value === null ||
        (typeof value === 'string' && HEX64_RE.test(value));
    const nullableBooleanIsValid = (value: unknown): boolean =>
        value === null || typeof value === 'boolean';
    const official =
        artifact.officialScan === null
            ? null
            : asRecord(
                  artifact.officialScan,
                  'RELATION_PUBLIC_ARTIFACT_INVALID'
              );
    if (official !== null) {
        if (
            !hasExactKeys(official, [
                'title',
                'basis',
                'attached',
                'managementPkHash',
                'basePnuHash',
                'attachedPnuHash',
                'pairsDigest',
                'totalPairs',
                'totalRejected',
                'bylotCount',
            ]) ||
            official.managementPkHash !==
                input.target.officialHashes.managementPkHash ||
            official.basePnuHash !==
                input.target.officialHashes.basePnuHash ||
            official.attachedPnuHash !==
                input.target.officialHashes.attachedPnuHash ||
            official.pairsDigest !==
                input.target.officialHashes.pairsDigest ||
            official.totalPairs !== 1 ||
            official.totalRejected !== 0 ||
            official.bylotCount !== 1
        ) {
            throw new ControlledRelationAdoptionError(
                'RELATION_PUBLIC_ARTIFACT_INVALID'
            );
        }
        const validateEndpoint = (
            value: unknown,
            expectedSchemaHash: string
        ): void => {
            const endpoint = asRecord(
                value,
                'RELATION_PUBLIC_ARTIFACT_INVALID'
            );
            if (
                !hasExactKeys(endpoint, [
                    'state',
                    'totalCount',
                    'pagesFetched',
                    'schemaHash',
                ]) ||
                endpoint.state !== 'COMPLETE' ||
                typeof endpoint.totalCount !== 'number' ||
                !Number.isSafeInteger(endpoint.totalCount) ||
                endpoint.totalCount <= 0 ||
                typeof endpoint.pagesFetched !== 'number' ||
                !Number.isSafeInteger(endpoint.pagesFetched) ||
                endpoint.pagesFetched <= 0 ||
                endpoint.schemaHash !== expectedSchemaHash
            ) {
                throw new ControlledRelationAdoptionError(
                    'RELATION_PUBLIC_ARTIFACT_INVALID'
                );
            }
        };
        validateEndpoint(
            official.title,
            input.target.officialHashes.titleSchemaHash
        );
        validateEndpoint(
            official.basis,
            input.target.officialHashes.basisSchemaHash
        );
        validateEndpoint(
            official.attached,
            input.target.officialHashes.attachedSchemaHash
        );
    }

    const relation = asRecord(
        artifact.relation,
        'RELATION_PUBLIC_ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(relation, [
            'beforeCount',
            'afterCount',
            'beforeDigest',
            'afterDigest',
            'afterActiveCount',
            'afterLinkedCount',
        ]) ||
        !nullableCountIsValid(relation.beforeCount) ||
        !nullableCountIsValid(relation.afterCount) ||
        !nullableCountIsValid(relation.afterActiveCount) ||
        !nullableCountIsValid(relation.afterLinkedCount) ||
        !nullableDigestIsValid(relation.beforeDigest) ||
        !nullableDigestIsValid(relation.afterDigest) ||
        (relation.beforeCount === null) !==
            (relation.beforeDigest === null) ||
        (relation.afterCount === null) !==
            (relation.afterDigest === null) ||
        (relation.afterCount === null) !==
            (relation.afterActiveCount === null) ||
        (relation.afterCount === null) !==
            (relation.afterLinkedCount === null) ||
        (typeof relation.afterCount === 'number' &&
            ((relation.afterActiveCount as number) >
                relation.afterCount ||
                (relation.afterLinkedCount as number) >
                    relation.afterCount))
    ) {
        throw new ControlledRelationAdoptionError(
            'RELATION_PUBLIC_ARTIFACT_INVALID'
        );
    }

    const membership = asRecord(
        artifact.propertyMembership,
        'RELATION_PUBLIC_ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(membership, [
            'expectedCount',
            'beforeCount',
            'afterCount',
            'beforeDigest',
            'afterDigest',
        ]) ||
        membership.expectedCount !==
            input.target.expectedActivePropertyUnitCount ||
        !nullableCountIsValid(membership.beforeCount) ||
        !nullableCountIsValid(membership.afterCount) ||
        !nullableDigestIsValid(membership.beforeDigest) ||
        !nullableDigestIsValid(membership.afterDigest) ||
        (membership.beforeCount === null) !==
            (membership.beforeDigest === null) ||
        (membership.afterCount === null) !==
            (membership.afterDigest === null)
    ) {
        throw new ControlledRelationAdoptionError(
            'RELATION_PUBLIC_ARTIFACT_INVALID'
        );
    }

    const approval = asRecord(
        artifact.landAreaApproval,
        'RELATION_PUBLIC_ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(approval, [
            'beforeEnabled',
            'afterEnabled',
            'beforeStableDigest',
            'afterStableDigest',
        ]) ||
        !nullableBooleanIsValid(approval.beforeEnabled) ||
        !nullableBooleanIsValid(approval.afterEnabled) ||
        !nullableDigestIsValid(approval.beforeStableDigest) ||
        !nullableDigestIsValid(approval.afterStableDigest) ||
        (approval.beforeEnabled === null) !==
            (approval.beforeStableDigest === null) ||
        (approval.afterEnabled === null) !==
            (approval.afterStableDigest === null)
    ) {
        throw new ControlledRelationAdoptionError(
            'RELATION_PUBLIC_ARTIFACT_INVALID'
        );
    }

    const invariant = asRecord(
        artifact.invariantHashes,
        'RELATION_PUBLIC_ARTIFACT_INVALID'
    );
    if (!hasExactKeys(invariant, ['before', 'after'])) {
        throw new ControlledRelationAdoptionError(
            'RELATION_PUBLIC_ARTIFACT_INVALID'
        );
    }
    const hashKeys = [
        'propertyUnits',
        'propertyOwnerships',
        'buildingLandLots',
        'buildings',
        'buildingUnits',
        'buildingExternalRefs',
        'landLots',
        'landAreaTuples',
        'landRightRows',
        'landAreaSyncJobs',
        'nonTargetRelations',
    ] as const;
    const validateHashSet = (
        value: unknown
    ): Record<string, unknown> | null => {
        if (value === null) return null;
        const hashes = asRecord(
            value,
            'RELATION_PUBLIC_ARTIFACT_INVALID'
        );
        if (
            !hasExactKeys(hashes, hashKeys) ||
            hashKeys.some(
                (key) =>
                    typeof hashes[key] !== 'string' ||
                    !HEX64_RE.test(hashes[key] as string)
            )
        ) {
            throw new ControlledRelationAdoptionError(
                'RELATION_PUBLIC_ARTIFACT_INVALID'
            );
        }
        return hashes;
    };
    const beforeHashes = validateHashSet(invariant.before);
    const afterHashes = validateHashSet(invariant.after);
    const beforeSnapshotPresent = beforeHashes !== null;
    const afterSnapshotPresent = afterHashes !== null;
    if (
        beforeSnapshotPresent !== (relation.beforeCount !== null) ||
        beforeSnapshotPresent !== (membership.beforeCount !== null) ||
        beforeSnapshotPresent !== (approval.beforeEnabled !== null) ||
        afterSnapshotPresent !== (relation.afterCount !== null) ||
        afterSnapshotPresent !== (membership.afterCount !== null) ||
        afterSnapshotPresent !== (approval.afterEnabled !== null)
    ) {
        throw new ControlledRelationAdoptionError(
            'RELATION_PUBLIC_ARTIFACT_INVALID'
        );
    }

    if (artifact.writeAttribution !== null) {
        const attribution = asRecord(
            artifact.writeAttribution,
            'RELATION_PUBLIC_ARTIFACT_INVALID'
        );
        if (
            !hasExactKeys(attribution, [
                'counts',
                'digest',
                'relationProjectionStatuses',
                'attributedIdDigest',
            ]) ||
            typeof attribution.digest !== 'string' ||
            !HEX64_RE.test(attribution.digest) ||
            typeof attribution.attributedIdDigest !== 'string' ||
            !HEX64_RE.test(attribution.attributedIdDigest) ||
            !Array.isArray(
                attribution.relationProjectionStatuses
            ) ||
            !attribution.relationProjectionStatuses.every(
                (status) =>
                    typeof status === 'string' &&
                    /^[A-Z_]{1,50}$/.test(status)
            ) ||
            attribution.relationProjectionStatuses.length !==
                new Set(
                    attribution.relationProjectionStatuses
                ).size ||
            JSON.stringify(
                attribution.relationProjectionStatuses
            ) !==
                JSON.stringify(
                    [
                        ...attribution.relationProjectionStatuses,
                    ].sort()
                )
        ) {
            throw new ControlledRelationAdoptionError(
                'RELATION_PUBLIC_ARTIFACT_INVALID'
            );
        }
        const counts = asRecord(
            attribution.counts,
            'RELATION_PUBLIC_ARTIFACT_INVALID'
        );
        const countKeys = [
            'syncJobs',
            'operations',
            'inputPnus',
            'commands',
            'observations',
            'observationPairs',
            'groupStates',
            'relations',
        ] as const;
        if (
            !hasExactKeys(counts, countKeys) ||
            countKeys.some(
                (key) =>
                    typeof counts[key] !== 'number' ||
                    !Number.isSafeInteger(counts[key]) ||
                    (counts[key] as number) < 0
            )
        ) {
            throw new ControlledRelationAdoptionError(
                'RELATION_PUBLIC_ARTIFACT_INVALID'
            );
        }
    }

    const production = asRecord(
        artifact.productionWrites,
        'RELATION_PUBLIC_ARTIFACT_INVALID'
    );
    const manual = asRecord(
        artifact.manualDataUsage,
        'RELATION_PUBLIC_ARTIFACT_INVALID'
    );
    const dbApproval = asRecord(
        artifact.dbApproval,
        'RELATION_PUBLIC_ARTIFACT_INVALID'
    );
    const adoptionCall = asRecord(
        artifact.adoptionCall,
        'RELATION_PUBLIC_ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(production, [
            'observedWriteCount',
            'verificationBoundary',
        ]) ||
        production.observedWriteCount !== 0 ||
        production.verificationBoundary !==
            'NO_PRODUCTION_CLIENT_CONSTRUCTED_DEVELOPMENT_PROJECT_REF_PINNED' ||
        !hasExactKeys(manual, [
            'sourceReads',
            'blockerReads',
            'fallbackWrites',
        ]) ||
        manual.sourceReads !== 0 ||
        manual.blockerReads !== 0 ||
        manual.fallbackWrites !== 0 ||
        !hasExactKeys(dbApproval, [
            'preinstalledVerified',
            'consumedVerified',
        ]) ||
        typeof dbApproval.preinstalledVerified !== 'boolean' ||
        typeof dbApproval.consumedVerified !== 'boolean' ||
        !hasExactKeys(adoptionCall, [
            'attempts',
            'maxAttempts',
            'receiptVerified',
            'recoveredAfterAmbiguousError',
        ]) ||
        !Number.isSafeInteger(adoptionCall.attempts) ||
        (adoptionCall.attempts as number) < 0 ||
        (adoptionCall.attempts as number) >
            DEVELOPMENT_RELATION_ADOPTION_MAX_ATTEMPTS ||
        adoptionCall.maxAttempts !==
            DEVELOPMENT_RELATION_ADOPTION_MAX_ATTEMPTS ||
        typeof adoptionCall.receiptVerified !== 'boolean' ||
        typeof adoptionCall.recoveredAfterAmbiguousError !==
            'boolean' ||
        adoptionCall.recoveredAfterAmbiguousError !==
            (adoptionCall.receiptVerified === true &&
                (adoptionCall.attempts as number) > 1)
    ) {
        throw new ControlledRelationAdoptionError(
            'RELATION_PUBLIC_ARTIFACT_INVALID'
        );
    }

    if (
        ((adoptionCall.attempts as number) > 0) !==
            (dbApproval.preinstalledVerified === true) ||
        (adoptionCall.receiptVerified === true &&
            ((adoptionCall.attempts as number) < 1 ||
                dbApproval.preinstalledVerified !== true)) ||
        (dbApproval.consumedVerified === true &&
            ((adoptionCall.attempts as number) < 1 ||
                dbApproval.preinstalledVerified !== true)) ||
        (artifact.writeAttribution !== null &&
            dbApproval.consumedVerified !== true)
    ) {
        throw new ControlledRelationAdoptionError(
            'RELATION_PUBLIC_ARTIFACT_INVALID'
        );
    }

    if (
        artifact.targetDigest !== null &&
        (typeof membership.beforeDigest !== 'string' ||
            artifact.targetDigest !==
                computeDevelopmentRelationAdoptionExecutionTargetDigest({
                    target: input.target,
                    expectedPropertyUnitDigest:
                        membership.beforeDigest,
                    sourceReleaseSha:
                        input.expectedSourceReleaseSha,
                }))
    ) {
        throw new ControlledRelationAdoptionError(
            'RELATION_PUBLIC_ARTIFACT_INVALID'
        );
    }
    if (
        ((adoptionCall.attempts as number) > 0 ||
            gate.status === 'PASS') &&
        artifact.targetDigest === null
    ) {
        throw new ControlledRelationAdoptionError(
            'RELATION_PUBLIC_ARTIFACT_INVALID'
        );
    }

    if (gate.status === 'PASS') {
        if (
            official === null ||
            artifact.targetDigest === null ||
            relation.afterCount !== 1 ||
            relation.afterActiveCount !== 1 ||
            relation.afterLinkedCount !== 1 ||
            membership.expectedCount !==
                input.target.expectedActivePropertyUnitCount ||
            membership.beforeCount !== membership.expectedCount ||
            membership.afterCount !== membership.expectedCount ||
            typeof membership.beforeDigest !== 'string' ||
            !HEX64_RE.test(membership.beforeDigest) ||
            membership.afterDigest !== membership.beforeDigest ||
            approval.beforeEnabled !== false ||
            approval.afterEnabled !== false ||
            typeof approval.beforeStableDigest !== 'string' ||
            !HEX64_RE.test(approval.beforeStableDigest) ||
            approval.afterStableDigest !==
                approval.beforeStableDigest ||
            beforeHashes === null ||
            afterHashes === null ||
            stableStringify(beforeHashes) !==
                stableStringify(afterHashes) ||
            dbApproval.preinstalledVerified !== true ||
            dbApproval.consumedVerified !== true ||
            adoptionCall.receiptVerified !== true ||
            (adoptionCall.attempts as number) < 1 ||
            artifact.writeAttribution === null
        ) {
            throw new ControlledRelationAdoptionError(
                'RELATION_PUBLIC_ARTIFACT_PASS_INVALID'
            );
        }
        validateAttribution(
            artifact.writeAttribution as DevelopmentRelationWriteAttribution
        );
    }
    return artifact as unknown as DevelopmentRelationAdoptionPublicArtifact;
}

export function toDevelopmentRelationAdoptionPublicArtifact(
    artifact: DevelopmentRelationAdoptionArtifact
): DevelopmentRelationAdoptionPublicArtifact {
    return {
        version: DEVELOPMENT_RELATION_ADOPTION_PUBLIC_ARTIFACT_VERSION,
        databaseTarget: artifact.databaseTarget,
        manifestDigest: artifact.manifestDigest,
        targetDigest: artifact.targetDigest,
        sourceReleaseSha: artifact.sourceReleaseSha,
        syncJobIdHash: artifact.syncJobIdHash,
        phase0: artifact.phase0,
        officialScan: artifact.officialScan,
        relation: artifact.relation,
        invariantHashes: artifact.invariantHashes,
        propertyMembership: artifact.propertyMembership,
        landAreaApproval: artifact.landAreaApproval,
        writeAttribution: artifact.writeAttribution,
        dbApproval: artifact.dbApproval,
        adoptionCall: artifact.adoptionCall,
        productionWrites: artifact.productionWrites,
        manualDataUsage: artifact.manualDataUsage,
        gate: artifact.gate,
    };
}

export function controlledRelationAdoptionFailureCode(
    error: unknown
): string | null {
    return error instanceof ControlledRelationAdoptionError
        ? error.code
        : null;
}
