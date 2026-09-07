import { request as nodeHttpRequest } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
    createLandAreaSyncAllowedTargetsManifest,
} from '../security/land-area-sync-canary-policy';
import {
    DEVELOPMENT_LAND_AREA_FULL_REFRESH_PROFILE,
    MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_MANIFEST_DIGEST,
    assertDevelopmentLandAreaFullRefreshAllowed,
    developmentLandAreaFullRefreshMarkersEqual,
} from '../security/development-land-area-full-refresh-policy';
import type {
    LandAreaSyncDevelopmentFullRefresh,
    LandAreaSyncCounts,
    LandAreaSyncOutcome,
    LandAreaSyncScopeSnapshot,
    LandAreaSyncScopeState,
    LandAreaSyncStrategy,
} from '../types/land-area-sync-job.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNU_RE = /^[0-9]{19}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/;
const LOCAL_API_ORIGIN = 'http://127.0.0.1:3100';
const RESPONSE_SIZE_LIMIT = 256 * 1024;
const LOCAL_API_REQUEST_TIMEOUT_MS = 60_000;

/**
 * 러너·캡처가 다룰 수 있는 DB 환경. DB 쪽 land_area_sync 승인 manifest CHECK
 * (database_target IN ('development','production')) 와 같은 집합이어야 한다.
 * 승인·digest·allowlist 항목이 전부 이 축으로 격리되므로 환경 간 재사용이 불가능하다.
 */
export const LAND_AREA_SYNC_RUNNER_DATABASE_TARGETS = [
    'development',
    'production',
] as const;

export type LandAreaSyncRunnerDatabaseTarget =
    (typeof LAND_AREA_SYNC_RUNNER_DATABASE_TARGETS)[number];

export function isLandAreaSyncRunnerDatabaseTarget(
    value: unknown
): value is LandAreaSyncRunnerDatabaseTarget {
    return (
        typeof value === 'string' &&
        (
            LAND_AREA_SYNC_RUNNER_DATABASE_TARGETS as readonly string[]
        ).includes(value)
    );
}

export const DEVELOPMENT_TARGET_MANIFEST_VERSION =
    'land-area-development-target-manifest@1';
export const DEVELOPMENT_TARGET_MANIFEST_VERSION_V2 =
    'land-area-development-target-manifest@2';
export const DEVELOPMENT_TARGET_MANIFEST_VERSION_V3 =
    'land-area-development-target-manifest@3';
export const DEVELOPMENT_ACTIVE_PNU_DIGEST_VERSION =
    'land-area-development-active-pnu-digest@1';
export const DEVELOPMENT_DB_APPROVAL_MANIFEST_VERSION =
    'land-area-development-db-approval-manifest@1';
export const DEVELOPMENT_EVIDENCE_MANIFEST_VERSION =
    'land-area-development-evidence-manifest@1';
export const DEVELOPMENT_EVIDENCE_MANIFEST_VERSION_V2 =
    'land-area-development-evidence-manifest@2';
export const DEVELOPMENT_RUN_ARTIFACT_VERSION =
    'land-area-development-run-artifact@2';
export const DEVELOPMENT_PUBLIC_RUN_ARTIFACT_VERSION =
    'land-area-development-public-run-artifact@2';
export const DEVELOPMENT_GIS_JWT_TTL_SECONDS = 10 * 60;
// anchor 재시도: V-World/워커의 일시 실패(job FAILED, 네트워크·5xx·429)는 같은
// anchor 를 새 discovery 로 다시 조회한다. 결정적 결과(REVIEW_REQUIRED, 증거
// 불일치, 차단 issue)는 재시도하지 않는다. 최대 시도 뒤에도 실패하면 기존과
// 같이 러너를 멈춘다 (2026-09-07 삼양동 창 B: 47번째 anchor 의 apply 가
// PROVIDER_PROTOCOL_ERROR 1회로 FAILED 되어 55 anchor 가 미실행으로 남았다).
export const DEVELOPMENT_ANCHOR_MAX_ATTEMPTS = 10;
export const DEVELOPMENT_ANCHOR_RETRY_BASE_DELAY_MS = 2_000;
export const DEVELOPMENT_ANCHOR_RETRY_MAX_DELAY_MS = 15 * 1_000;
export const DEVELOPMENT_API_QUEUE_TIMEOUT_MS = 10 * 60_000;
export const DEVELOPMENT_JOB_POLL_SOFT_TIMEOUT_MS =
    DEVELOPMENT_API_QUEUE_TIMEOUT_MS + 60_000;
export const DEVELOPMENT_ADMISSION_RECONCILIATION_ATTEMPTS = 10;
export const DEVELOPMENT_FULL_REFRESH_ADMISSION_CUTOFF_MS =
    225 * 60_000;

interface DevelopmentTargetManifestCommon {
    databaseTarget: LandAreaSyncRunnerDatabaseTarget;
    unionId: string;
    targetCount: number;
    manifestDigest: string;
    expectedPropertyUnitCount: number;
    expectedUnionActivePropertyUnitCount: number;
    expectedUnionActivePnuCount: number;
}

export interface DevelopmentTargetManifestV1
    extends DevelopmentTargetManifestCommon {
    version: typeof DEVELOPMENT_TARGET_MANIFEST_VERSION;
    pnus: string[];
}

interface DevelopmentScopedTargetManifestCommon
    extends DevelopmentTargetManifestCommon {
    anchors: string[];
    allowedScopePnus: string[];
    scopeDigest: string;
    allowManualOverwrite: true;
}

export interface DevelopmentTargetManifestV2
    extends DevelopmentScopedTargetManifestCommon {
    version: typeof DEVELOPMENT_TARGET_MANIFEST_VERSION_V2;
}

export interface DevelopmentTargetManifestV3
    extends DevelopmentScopedTargetManifestCommon {
    version: typeof DEVELOPMENT_TARGET_MANIFEST_VERSION_V3;
    expectedUnionActivePnus: string[];
    expectedUnionActivePnuDigest: string;
}

export type DevelopmentTargetManifest =
    | DevelopmentTargetManifestV1
    | DevelopmentTargetManifestV2
    | DevelopmentTargetManifestV3;

export interface DevelopmentDbApprovalManifest {
    version: typeof DEVELOPMENT_DB_APPROVAL_MANIFEST_VERSION;
    databaseTarget: LandAreaSyncRunnerDatabaseTarget;
    unionId: string;
    pnus: string[];
    targetCount: number;
    manifestDigest: string;
    enabled: true;
}

type ParcelEvidenceKind =
    | 'BUILDING_REGISTER_COPY'
    | 'BUILDING_REGISTER_TITLE_SECTION'
    | 'API_RELATION_CROSS_CHECK'
    | 'OTHER';
type LandOwnershipEvidenceKind =
    | 'LAND_REGISTER_OR_REGISTRY'
    | 'LAND_LEDGER_COPY'
    | 'OTHER';

export interface ConfirmationEvidence {
    kind: ParcelEvidenceKind | LandOwnershipEvidenceKind;
    ref: string;
}

export interface DevelopmentLegacyEvidenceSourceReferences {
    workbookFileReferenceSha256: string;
    sheet: string;
    cells: string[];
    selectedCellsReferenceSha256: string;
    phase0RunId: string;
    phase0ArtifactReferenceSha256: string;
    phase0ObservationReferenceSha256: string;
    developmentObservationReferenceSha256: string;
}

export type DevelopmentApiCaptureEvidenceSourceReferences =
    | {
          kind: 'DEVELOPMENT_READ_ONLY_API_CAPTURE';
          captureRunId: string;
          snapshotReferenceSha256: string;
      }
    | {
          kind: 'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_CAPTURE';
          captureRunId: string;
          snapshotReferenceSha256: string;
          officialComponentDigest: string;
      }
    | {
          kind:
              'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_PARCEL_CAPTURE';
          captureRunId: string;
          snapshotReferenceSha256: string;
          officialParcelDigest: string;
      }
    | {
          kind: 'DEVELOPMENT_READ_ONLY_VERIFIED_NO_DATA_CAPTURE';
          captureRunId: string;
          snapshotReferenceSha256: string;
          verifiedNoDataEvidenceDigest: string;
      };

export interface DevelopmentEvidenceEntry {
    anchorPnu: string;
    expectedStrategy: LandAreaSyncStrategy;
    expectedScannedPnus: string[];
    expectedPropertyUnitIds: string[];
    expectedProposedLandAreas: Array<{
        propertyUnitId: string;
        landArea: string;
    }>;
    expectedLadfrlAreaEvidence: {
        parcels: Array<{ pnu: string; area: string }>;
        totalArea: string;
    };
    allowedPrestates: Array<{
        propertyUnitId: string;
        landArea: string | null;
        landAreaSource: 'LEGACY_UNKNOWN' | 'MANUAL' | 'LADFRL' | 'LDAREG';
    }>;
    parcelScopeEvidence: ConfirmationEvidence;
    landOwnershipEvidence: ConfirmationEvidence | null;
    allowManualOverwrite: boolean;
    sourceReferences:
        | DevelopmentLegacyEvidenceSourceReferences
        | DevelopmentApiCaptureEvidenceSourceReferences;
}

interface DevelopmentEvidenceManifestCommon {
    databaseTarget: LandAreaSyncRunnerDatabaseTarget;
    unionId: string;
    manifestDigest: string;
    entries: DevelopmentEvidenceEntry[];
}

export interface DevelopmentEvidenceManifestV1
    extends DevelopmentEvidenceManifestCommon {
    version: typeof DEVELOPMENT_EVIDENCE_MANIFEST_VERSION;
}

export interface DevelopmentEvidenceManifestV2
    extends DevelopmentEvidenceManifestCommon {
    version: typeof DEVELOPMENT_EVIDENCE_MANIFEST_VERSION_V2;
}

export type DevelopmentEvidenceManifest =
    | DevelopmentEvidenceManifestV1
    | DevelopmentEvidenceManifestV2;
export interface DevelopmentRunnerEnvironment {
    DEV_API_JWT_SECRET?: string;
    DEV_SUPABASE_URL?: string;
    DEV_SUPABASE_SERVICE_ROLE_KEY?: string;
    JWT_SECRET?: string;
    SUPABASE_URL?: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
    LAND_AREA_SYNC_ENABLED?: string;
    LAND_AREA_SYNC_ALLOWED_TARGETS?: string;
}

export interface LandAreaSyncApiJob {
    jobId: string;
    unionId: string;
    status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
    progress: number;
    landAreaSync: {
        anchorPnu?: string;
        sourceDiscoveryJobId?: string | null;
        developmentFullRefresh?: LandAreaSyncDevelopmentFullRefresh;
        admissionKey?: string;
        workerFinalization?: {
            version?: number;
            finalizedAt?: string;
        };
        scopeState?: LandAreaSyncScopeState;
        scopeSnapshot?: LandAreaSyncScopeSnapshot | null;
        branch?: LandAreaSyncStrategy | null;
        outcome?: LandAreaSyncOutcome | null;
        counts?: Partial<LandAreaSyncCounts>;
        issues?: Array<{
            code?: string;
            propertyUnitId?: string;
            targetPnu?: string;
            dong?: string;
            ho?: string;
        }>;
        issuesTotal?: number;
        issuesTruncated?: boolean;
    } | null;
    createdAt?: string;
    updatedAt?: string;
}

export interface LandAreaSyncApiClient {
    getLatest(unionId: string, pnu: string): Promise<LandAreaSyncApiJob | null>;
    getJob(unionId: string, jobId: string): Promise<LandAreaSyncApiJob>;
    getAdmission?(
        unionId: string,
        admissionKey: string,
        sourceDiscoveryJobId: string | null
    ): Promise<LandAreaSyncApiJob | null>;
    admitDiscovery(
        unionId: string,
        pnu: string,
        admissionKey: string,
        developmentFullRefresh?: LandAreaSyncDevelopmentFullRefresh
    ): Promise<string>;
    confirmDiscovery(
        discoveryJobId: string,
        body: {
            unionId: string;
            admissionKey: string;
            expectedScopeHash: string;
            propertyUnitIds: string[];
            parcelScopeConfirmed: true;
            landOwnershipConfirmed: true | null;
            overwriteManualConfirmed: boolean;
            parcelScopeEvidenceKind: string;
            parcelScopeEvidenceRef: string;
            landOwnershipEvidenceKind: string | null;
            landOwnershipEvidenceRef: string | null;
        }
    ): Promise<string>;
}

export interface DevelopmentActivePropertyUnit {
    id: string;
    pnu: string;
    landArea: string | null;
    landAreaSource: 'LEGACY_UNKNOWN' | 'MANUAL' | 'LADFRL' | 'LDAREG';
    landAreaSyncedAt: string | null;
    landAreaSyncJobId: string | null;
}

export interface DevelopmentAttributedPropertyUnit {
    id: string;
    unionId: string;
    landAreaSyncJobId: string;
}

export const DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES = [
    'land_lots',
    'building_land_lots',
    'buildings',
    'building_units',
    'building_external_refs',
    'building_registry_land_lot_relations',
    'building_land_lot_manual_overrides',
] as const;

export type DevelopmentRelationGisInvariantTable =
    (typeof DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES)[number];

export type DevelopmentRelationGisInvariantRows = Record<
    DevelopmentRelationGisInvariantTable,
    Array<Record<string, unknown>>
>;

export interface DevelopmentReadOnlyPreflightReader {
    readActivePropertyUnits(
        unionId: string
    ): Promise<DevelopmentActivePropertyUnit[]>;
    readPropertyUnitsBySyncJobIds(
        syncJobIds: string[]
    ): Promise<DevelopmentAttributedPropertyUnit[]>;
    /**
     * DEV 전체 갱신에서 relation/GIS projection 7개를 읽기 전용으로 고정한다.
     * rights는 아래의 별도 transition reader로 검증한다. raw row는 메모리에서만
     * digest로 변환하며 artifact에 포함하지 않는다.
     */
    readRelationGisInvariantRows?(input: {
        unionId: string;
        scopePnus: string[];
        propertyUnitIds: string[];
    }): Promise<DevelopmentRelationGisInvariantRows>;
    /** DEV 전체 갱신의 의도된 대지권 write를 별도로 검증하기 위한 union-scoped rows. */
    readPropertyUnitLandRights?(
        unionId: string
    ): Promise<Array<Record<string, unknown>>>;
}

export interface DevelopmentReadOnlySnapshot {
    activePropertyUnitCount: number;
    activePnuCount: number;
    positiveLandAreaCount: number;
    identityDigest: string;
    tupleDigest: string;
    nonTargetTupleDigest: string;
}

export interface DevelopmentWriteAttribution {
    writerJobCount: number;
    attributedPropertyUnitCount: number;
    attributionDigest: string;
}

export interface DevelopmentRelationGisTableInvariant {
    rowCount: number;
    digest: string;
}

export interface DevelopmentRelationGisInvariantSnapshot {
    scopePnuCount: number;
    propertyUnitCount: number;
    tables: Record<
        DevelopmentRelationGisInvariantTable,
        DevelopmentRelationGisTableInvariant
    >;
    aggregateDigest: string;
}

export interface DevelopmentLandRightSnapshot {
    rowCount: number;
    targetRowCount: number;
    activeTargetRowCount: number;
    allRowsDigest: string;
    nonTargetRowsDigest: string;
}

export interface DevelopmentLandRightWriteAttribution {
    changedRowCount: number;
    writerJobCount: number;
    attributedPropertyUnitCount: number;
    attributionDigest: string;
}

export interface DevelopmentRunTargetResult {
    pnu: string;
    admission: 'NEW_DISCOVERY' | 'RESUMED_LATEST' | 'ALREADY_APPLIED';
    discoveryJobId: string | null;
    applyJobId: string | null;
    /** legacy NO_DATA artifact는 validation에서 거부되며 writer가 될 수 없다. */
    writerJobId: string | null;
    status: 'COMPLETED' | 'FAILED';
    strategy: LandAreaSyncStrategy | null;
    scopeState: LandAreaSyncScopeState | null;
    outcome: LandAreaSyncOutcome | null;
    updatedPropertyUnits: number;
    unchangedPropertyUnits: number;
    issueCodes: string[];
}

export interface DevelopmentRunArtifact {
    version: typeof DEVELOPMENT_RUN_ARTIFACT_VERSION;
    databaseTarget: LandAreaSyncRunnerDatabaseTarget;
    unionId: string;
    targetCount: number;
    manifestDigest: string;
    expectedPropertyUnitCount: number;
    observedPropertyUnitCount: number;
    startedAt: string;
    completedAt: string;
    preflight: DevelopmentReadOnlySnapshot | null;
    postflight: DevelopmentReadOnlySnapshot | null;
    relationGisPreflight:
        | DevelopmentRelationGisInvariantSnapshot
        | null;
    relationGisPostflight:
        | DevelopmentRelationGisInvariantSnapshot
        | null;
    landRightPreflight: DevelopmentLandRightSnapshot | null;
    landRightPostflight: DevelopmentLandRightSnapshot | null;
    landRightWriteAttribution:
        | DevelopmentLandRightWriteAttribution
        | null;
    writeAttribution: DevelopmentWriteAttribution | null;
    results: DevelopmentRunTargetResult[];
    gate: {
        status: 'PASS' | 'FAIL';
        failureCode: string | null;
        stoppedBeforePnu: string | null;
    };
}

export interface DevelopmentPublicRunArtifact {
    version: typeof DEVELOPMENT_PUBLIC_RUN_ARTIFACT_VERSION;
    databaseTarget: LandAreaSyncRunnerDatabaseTarget;
    manifestLabel: string;
    aggregateCounts: {
        targetCount: number;
        expectedPropertyUnitCount: number;
        observedPropertyUnitCount: number;
        resultCount: number;
        preflightActivePropertyUnitCount: number | null;
        preflightActivePnuCount: number | null;
        preflightPositiveLandAreaCount: number | null;
        postflightActivePropertyUnitCount: number | null;
        postflightActivePnuCount: number | null;
        postflightPositiveLandAreaCount: number | null;
        writerJobCount: number | null;
        attributedPropertyUnitCount: number | null;
        projectableResultCount: number;
        verifiedNoDataResultCount: number;
        projectablePropertyUnitCount: number;
        verifiedNoDataPropertyUnitCount: number;
    };
    digests: {
        manifestDigest: string;
        preflightIdentityDigest: string | null;
        preflightTupleDigest: string | null;
        preflightNonTargetTupleDigest: string | null;
        postflightIdentityDigest: string | null;
        postflightTupleDigest: string | null;
        postflightNonTargetTupleDigest: string | null;
        writeAttributionDigest: string | null;
    };
    relationGisInvariant: {
        preflight:
            | DevelopmentRelationGisInvariantSnapshot
            | null;
        postflight:
            | DevelopmentRelationGisInvariantSnapshot
            | null;
    };
    landRightTransition: {
        preflight: DevelopmentLandRightSnapshot | null;
        postflight: DevelopmentLandRightSnapshot | null;
        writeAttribution:
            | DevelopmentLandRightWriteAttribution
            | null;
    };
    strategyCounts: {
        LADFRL: number;
        LDAREG: number;
        NONE: number;
    };
    outcomeCounts: {
        APPLIED: number;
        PARTIAL: number;
        NO_DATA: number;
        REVIEW_REQUIRED: number;
        FAILED: number;
        NONE: number;
    };
    gate: {
        status: 'PASS' | 'FAIL';
        failureCode: string | null;
    };
}

function hasExactKeys(
    value: Record<string, unknown>,
    keys: readonly string[]
): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return JSON.stringify(actual) === JSON.stringify(expected);
}

class ControlledRunnerError extends Error {
    constructor(readonly code: string) {
        super(code);
        this.name = 'ControlledRunnerError';
    }
}

class ControlledApiError extends ControlledRunnerError {
    constructor(
        code: string,
        readonly status: number
    ) {
        super(code);
        this.name = 'ControlledApiError';
    }
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ControlledRunnerError(code);
    }
    return value as Record<string, unknown>;
}

function isSortedUnique(values: readonly string[]): boolean {
    return (
        values.length === new Set(values).size &&
        values.every((value, index) => index === 0 || values[index - 1] < value)
    );
}

/**
 * ⚠️ 여기의 databaseTarget 은 실제 환경 축이다(채택 트랙의 DB-미러 namespace
 * 토큰과 다르다). canonical 값이 runtime allowlist(LAND_AREA_SYNC_ALLOWED_TARGETS)
 * 의 `target:union:pnu` 항목과 문자 그대로 대조되므로, 환경이 digest 에 들어가야
 * dev 승인·allowlist 를 운영에 재사용하는 것이 구조적으로 불가능해진다.
 */
function canonicalTargetValue(
    databaseTarget: LandAreaSyncRunnerDatabaseTarget,
    unionId: string,
    pnus: readonly string[]
): string {
    return pnus
        .map((pnu) => `${databaseTarget}:${unionId.toLowerCase()}:${pnu}`)
        .join(',');
}

export function computeDevelopmentTargetDigest(
    databaseTarget: LandAreaSyncRunnerDatabaseTarget,
    unionId: string,
    pnus: readonly string[]
): string {
    return createHash('sha256')
        .update(canonicalTargetValue(databaseTarget, unionId, pnus), 'utf8')
        .digest('hex');
}

export function computeDevelopmentActivePnuDigest(
    databaseTarget: LandAreaSyncRunnerDatabaseTarget,
    unionId: string,
    pnus: readonly string[]
): string {
    return createHash('sha256')
        .update(
            JSON.stringify({
                version: DEVELOPMENT_ACTIVE_PNU_DIGEST_VERSION,
                databaseTarget,
                unionId: unionId.toLowerCase(),
                pnus: [...pnus],
            }),
            'utf8'
        )
        .digest('hex');
}

export function computeDevelopmentTargetV2ManifestDigest(input: {
    databaseTarget: LandAreaSyncRunnerDatabaseTarget;
    unionId: string;
    anchors: readonly string[];
    allowedScopePnus: readonly string[];
    targetCount: number;
    expectedPropertyUnitCount: number;
    expectedUnionActivePropertyUnitCount: number;
    expectedUnionActivePnuCount: number;
    allowManualOverwrite: boolean;
}): string {
    const canonicalManifestIdentity = JSON.stringify({
        version: DEVELOPMENT_TARGET_MANIFEST_VERSION_V2,
        databaseTarget: input.databaseTarget,
        unionId: input.unionId.toLowerCase(),
        anchors: [...input.anchors],
        allowedScopePnus: [...input.allowedScopePnus],
        targetCount: input.targetCount,
        expectedPropertyUnitCount: input.expectedPropertyUnitCount,
        expectedUnionActivePropertyUnitCount:
            input.expectedUnionActivePropertyUnitCount,
        expectedUnionActivePnuCount:
            input.expectedUnionActivePnuCount,
        allowManualOverwrite: input.allowManualOverwrite,
    });
    return createHash('sha256')
        .update(canonicalManifestIdentity, 'utf8')
        .digest('hex');
}

export function computeDevelopmentTargetV3ManifestDigest(input: {
    databaseTarget: LandAreaSyncRunnerDatabaseTarget;
    unionId: string;
    anchors: readonly string[];
    allowedScopePnus: readonly string[];
    expectedUnionActivePnus: readonly string[];
    expectedUnionActivePnuDigest: string;
    targetCount: number;
    expectedPropertyUnitCount: number;
    expectedUnionActivePropertyUnitCount: number;
    expectedUnionActivePnuCount: number;
    allowManualOverwrite: boolean;
}): string {
    const canonicalManifestIdentity = JSON.stringify({
        version: DEVELOPMENT_TARGET_MANIFEST_VERSION_V3,
        databaseTarget: input.databaseTarget,
        unionId: input.unionId.toLowerCase(),
        anchors: [...input.anchors],
        allowedScopePnus: [...input.allowedScopePnus],
        expectedUnionActivePnus: [
            ...input.expectedUnionActivePnus,
        ],
        expectedUnionActivePnuDigest:
            input.expectedUnionActivePnuDigest,
        targetCount: input.targetCount,
        expectedPropertyUnitCount: input.expectedPropertyUnitCount,
        expectedUnionActivePropertyUnitCount:
            input.expectedUnionActivePropertyUnitCount,
        expectedUnionActivePnuCount:
            input.expectedUnionActivePnuCount,
        allowManualOverwrite: input.allowManualOverwrite,
    });
    return createHash('sha256')
        .update(canonicalManifestIdentity, 'utf8')
        .digest('hex');
}

export function developmentTargetExecutionAnchors(
    target: DevelopmentTargetManifest
): string[] {
    return target.version === DEVELOPMENT_TARGET_MANIFEST_VERSION
        ? target.pnus
        : target.anchors;
}

export function developmentTargetAllowedScopePnus(
    target: DevelopmentTargetManifest
): string[] {
    return target.version === DEVELOPMENT_TARGET_MANIFEST_VERSION
        ? target.pnus
        : target.allowedScopePnus;
}

export function developmentTargetExpectedActivePnus(
    target: DevelopmentTargetManifest
): string[] | null {
    if (target.version === DEVELOPMENT_TARGET_MANIFEST_VERSION_V3) {
        return target.expectedUnionActivePnus;
    }
    if (
        target.version === DEVELOPMENT_TARGET_MANIFEST_VERSION &&
        target.targetCount === target.expectedUnionActivePnuCount
    ) {
        return target.pnus;
    }
    return null;
}

export function developmentTargetScopeDigest(
    target: DevelopmentTargetManifest
): string {
    return target.version === DEVELOPMENT_TARGET_MANIFEST_VERSION
        ? target.manifestDigest
        : target.scopeDigest;
}

export function developmentTargetAllowsManualOverwrite(
    target: DevelopmentTargetManifest
): boolean {
    return (
        target.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION &&
        target.allowManualOverwrite
    );
}

export function developmentFullRefreshMarkerForTarget(
    target: DevelopmentTargetManifest
): LandAreaSyncDevelopmentFullRefresh | null {
    if (
        target.version !==
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    ) {
        return null;
    }
    // full-refresh 프로파일은 repo-pinned DEV 전용이다. production v3 target 은
    // 마커를 아예 싣지 않아 service 의 production hard-deny 와 DB dev 전용 가드
    // 2종(assert/revalidate_mia7_development_full_refresh_*)을 구조적으로 피한다.
    // 마커가 없으면 same-run official evidence 는 write-eligible 하지 않다(fail-closed).
    if (target.databaseTarget !== 'development') {
        return null;
    }
    const marker: LandAreaSyncDevelopmentFullRefresh = {
        profile:
            DEVELOPMENT_LAND_AREA_FULL_REFRESH_PROFILE,
        manifestDigest: target.manifestDigest,
        scopeDigest: target.scopeDigest,
    };
    try {
        assertDevelopmentLandAreaFullRefreshAllowed({
            databaseTarget: target.databaseTarget,
            unionId: target.unionId,
            marker,
        });
    } catch {
        throw new ControlledRunnerError(
            'TARGET_FULL_REFRESH_POLICY_MISMATCH'
        );
    }
    return marker;
}

function assertCommonManifest(
    value: Record<string, unknown>,
    expectedVersion: string
): asserts value is Record<string, unknown> & {
    databaseTarget: LandAreaSyncRunnerDatabaseTarget;
    unionId: string;
    pnus: string[];
    targetCount: number;
    manifestDigest: string;
} {
    if (
        value.version !== expectedVersion ||
        !isLandAreaSyncRunnerDatabaseTarget(value.databaseTarget) ||
        typeof value.unionId !== 'string' ||
        !UUID_RE.test(value.unionId) ||
        !Array.isArray(value.pnus) ||
        value.pnus.length === 0 ||
        !value.pnus.every((pnu) => typeof pnu === 'string' && PNU_RE.test(pnu)) ||
        !isSortedUnique(value.pnus as string[]) ||
        !Number.isSafeInteger(value.targetCount) ||
        value.targetCount !== value.pnus.length ||
        typeof value.manifestDigest !== 'string' ||
        !HEX64_RE.test(value.manifestDigest) ||
        value.manifestDigest !==
            computeDevelopmentTargetDigest(
                value.databaseTarget,
                value.unionId,
                value.pnus as string[]
            )
    ) {
        throw new ControlledRunnerError('TARGET_MANIFEST_INVALID');
    }
}

export function parseDevelopmentTargetManifest(
    input: unknown
): DevelopmentTargetManifest {
    const value = asRecord(input, 'TARGET_MANIFEST_INVALID');
    const expectedCountsInvalid =
        !Number.isSafeInteger(value.expectedPropertyUnitCount) ||
        (value.expectedPropertyUnitCount as number) <= 0 ||
        !Number.isSafeInteger(value.expectedUnionActivePropertyUnitCount) ||
        (value.expectedUnionActivePropertyUnitCount as number) <= 0 ||
        !Number.isSafeInteger(value.expectedUnionActivePnuCount) ||
        (value.expectedUnionActivePnuCount as number) <= 0 ||
        (value.expectedUnionActivePnuCount as number) >
            (value.expectedUnionActivePropertyUnitCount as number);
    if (expectedCountsInvalid) {
        throw new ControlledRunnerError('TARGET_MANIFEST_INVALID');
    }

    if (value.version === DEVELOPMENT_TARGET_MANIFEST_VERSION) {
        assertCommonManifest(value, DEVELOPMENT_TARGET_MANIFEST_VERSION);
        if (
            !hasExactKeys(value, [
                'version',
                'databaseTarget',
                'unionId',
                'pnus',
                'targetCount',
                'manifestDigest',
                'expectedPropertyUnitCount',
                'expectedUnionActivePropertyUnitCount',
                'expectedUnionActivePnuCount',
            ])
        ) {
            throw new ControlledRunnerError('TARGET_MANIFEST_INVALID');
        }
        return value as unknown as DevelopmentTargetManifestV1;
    }

    if (value.version === DEVELOPMENT_TARGET_MANIFEST_VERSION_V2) {
        if (
            !hasExactKeys(value, [
                'version',
                'databaseTarget',
                'unionId',
                'anchors',
                'allowedScopePnus',
                'targetCount',
                'scopeDigest',
                'manifestDigest',
                'expectedPropertyUnitCount',
                'expectedUnionActivePropertyUnitCount',
                'expectedUnionActivePnuCount',
                'allowManualOverwrite',
            ]) ||
            !isLandAreaSyncRunnerDatabaseTarget(value.databaseTarget) ||
            typeof value.unionId !== 'string' ||
            !UUID_RE.test(value.unionId) ||
            !Array.isArray(value.anchors) ||
            value.anchors.length === 0 ||
            !value.anchors.every(
                (pnu) =>
                    typeof pnu === 'string' && PNU_RE.test(pnu)
            ) ||
            !isSortedUnique(value.anchors as string[]) ||
            !Array.isArray(value.allowedScopePnus) ||
            value.allowedScopePnus.length === 0 ||
            !value.allowedScopePnus.every(
                (pnu) =>
                    typeof pnu === 'string' && PNU_RE.test(pnu)
            ) ||
            !isSortedUnique(value.allowedScopePnus as string[]) ||
            (value.anchors as string[]).some(
                (anchor) =>
                    !(value.allowedScopePnus as string[]).includes(
                        anchor
                    )
            ) ||
            !Number.isSafeInteger(value.targetCount) ||
            value.targetCount !== value.anchors.length ||
            typeof value.scopeDigest !== 'string' ||
            !HEX64_RE.test(value.scopeDigest) ||
            value.scopeDigest !==
                computeDevelopmentTargetDigest(
                    value.databaseTarget,
                    value.unionId,
                    value.allowedScopePnus as string[]
                ) ||
            typeof value.manifestDigest !== 'string' ||
            !HEX64_RE.test(value.manifestDigest) ||
            value.manifestDigest !==
                computeDevelopmentTargetV2ManifestDigest({
                    databaseTarget: value.databaseTarget,
                    unionId: value.unionId,
                    anchors: value.anchors as string[],
                    allowedScopePnus:
                        value.allowedScopePnus as string[],
                    targetCount: value.targetCount as number,
                    expectedPropertyUnitCount:
                        value.expectedPropertyUnitCount as number,
                    expectedUnionActivePropertyUnitCount:
                        value.expectedUnionActivePropertyUnitCount as number,
                    expectedUnionActivePnuCount:
                        value.expectedUnionActivePnuCount as number,
                    allowManualOverwrite:
                        value.allowManualOverwrite as boolean,
                }) ||
            value.allowManualOverwrite !== true
        ) {
            throw new ControlledRunnerError(
                'TARGET_MANIFEST_INVALID'
            );
        }
        return value as unknown as DevelopmentTargetManifestV2;
    }

    if (
        !hasExactKeys(value, [
            'version',
            'databaseTarget',
            'unionId',
            'anchors',
            'allowedScopePnus',
            'expectedUnionActivePnus',
            'expectedUnionActivePnuDigest',
            'targetCount',
            'scopeDigest',
            'manifestDigest',
            'expectedPropertyUnitCount',
            'expectedUnionActivePropertyUnitCount',
            'expectedUnionActivePnuCount',
            'allowManualOverwrite',
        ]) ||
        value.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION_V3 ||
        !isLandAreaSyncRunnerDatabaseTarget(value.databaseTarget) ||
        typeof value.unionId !== 'string' ||
        !UUID_RE.test(value.unionId) ||
        !Array.isArray(value.anchors) ||
        value.anchors.length === 0 ||
        !value.anchors.every(
            (pnu) => typeof pnu === 'string' && PNU_RE.test(pnu)
        ) ||
        !isSortedUnique(value.anchors as string[]) ||
        !Array.isArray(value.allowedScopePnus) ||
        value.allowedScopePnus.length === 0 ||
        !value.allowedScopePnus.every(
            (pnu) => typeof pnu === 'string' && PNU_RE.test(pnu)
        ) ||
        !isSortedUnique(value.allowedScopePnus as string[]) ||
        !Array.isArray(value.expectedUnionActivePnus) ||
        value.expectedUnionActivePnus.length !==
            value.expectedUnionActivePnuCount ||
        !value.expectedUnionActivePnus.every(
            (pnu) =>
                typeof pnu === 'string' &&
                PNU_RE.test(pnu)
        ) ||
        !isSortedUnique(
            value.expectedUnionActivePnus as string[]
        ) ||
        (value.anchors as string[]).some(
            (anchor) =>
                !(value.allowedScopePnus as string[]).includes(
                    anchor
                )
        ) ||
        typeof value.expectedUnionActivePnuDigest !== 'string' ||
        !HEX64_RE.test(value.expectedUnionActivePnuDigest) ||
        value.expectedUnionActivePnuDigest !==
            computeDevelopmentActivePnuDigest(
                value.databaseTarget as LandAreaSyncRunnerDatabaseTarget,
                value.unionId,
                value.expectedUnionActivePnus as string[]
            ) ||
        !Number.isSafeInteger(value.targetCount) ||
        value.targetCount !== value.anchors.length ||
        typeof value.scopeDigest !== 'string' ||
        !HEX64_RE.test(value.scopeDigest) ||
        value.scopeDigest !==
            computeDevelopmentTargetDigest(
                value.databaseTarget as LandAreaSyncRunnerDatabaseTarget,
                value.unionId,
                value.allowedScopePnus as string[]
            ) ||
        typeof value.manifestDigest !== 'string' ||
        !HEX64_RE.test(value.manifestDigest) ||
        value.manifestDigest !==
            computeDevelopmentTargetV3ManifestDigest({
                databaseTarget:
                    value.databaseTarget as LandAreaSyncRunnerDatabaseTarget,
                unionId: value.unionId,
                anchors: value.anchors as string[],
                allowedScopePnus:
                    value.allowedScopePnus as string[],
                expectedUnionActivePnus:
                    value.expectedUnionActivePnus as string[],
                expectedUnionActivePnuDigest:
                    value.expectedUnionActivePnuDigest as string,
                targetCount: value.targetCount as number,
                expectedPropertyUnitCount:
                    value.expectedPropertyUnitCount as number,
                expectedUnionActivePropertyUnitCount:
                    value.expectedUnionActivePropertyUnitCount as number,
                expectedUnionActivePnuCount:
                    value.expectedUnionActivePnuCount as number,
                allowManualOverwrite:
                    value.allowManualOverwrite as boolean,
            }) ||
        value.allowManualOverwrite !== true
    ) {
        throw new ControlledRunnerError('TARGET_MANIFEST_INVALID');
    }
    return value as unknown as DevelopmentTargetManifestV3;
}

export function parseDevelopmentDbApprovalManifest(
    input: unknown
): DevelopmentDbApprovalManifest {
    const value = asRecord(input, 'DB_APPROVAL_MANIFEST_INVALID');
    try {
        assertCommonManifest(value, DEVELOPMENT_DB_APPROVAL_MANIFEST_VERSION);
    } catch {
        throw new ControlledRunnerError('DB_APPROVAL_MANIFEST_INVALID');
    }
    if (
        !hasExactKeys(value, [
            'version',
            'databaseTarget',
            'unionId',
            'pnus',
            'targetCount',
            'manifestDigest',
            'enabled',
        ]) ||
        value.enabled !== true
    ) {
        throw new ControlledRunnerError('DB_APPROVAL_MANIFEST_DISABLED');
    }
    return value as unknown as DevelopmentDbApprovalManifest;
}

function assertEvidenceRef(
    value: unknown,
    allowedKinds: readonly string[],
    code: string
): asserts value is ConfirmationEvidence {
    const ref = asRecord(value, code);
    if (
        !hasExactKeys(ref, ['kind', 'ref']) ||
        typeof ref.kind !== 'string' ||
        !allowedKinds.includes(ref.kind) ||
        typeof ref.ref !== 'string' ||
        ref.ref.trim() !== ref.ref ||
        ref.ref.length < 1 ||
        ref.ref.length > 200 ||
        /[\r\n]/.test(ref.ref)
    ) {
        throw new ControlledRunnerError(code);
    }
}

function assertPositiveDecimal(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) &&
        Number(value) > 0
    );
}

function parseEvidenceEntry(
    input: unknown,
    manifestVersion:
        | typeof DEVELOPMENT_EVIDENCE_MANIFEST_VERSION
        | typeof DEVELOPMENT_EVIDENCE_MANIFEST_VERSION_V2
): DevelopmentEvidenceEntry {
    const value = asRecord(input, 'EVIDENCE_ENTRY_INVALID');
    const proposed = value.expectedProposedLandAreas;
    const ladfrl = asRecord(
        value.expectedLadfrlAreaEvidence,
        'EVIDENCE_LADFRL_AREA_INVALID'
    );
    const parcels = ladfrl.parcels;
    const sources = asRecord(value.sourceReferences, 'EVIDENCE_SOURCE_INVALID');
    const verifiedNoDataSource =
        manifestVersion ===
            DEVELOPMENT_EVIDENCE_MANIFEST_VERSION_V2 &&
        sources.kind ===
            'DEVELOPMENT_READ_ONLY_VERIFIED_NO_DATA_CAPTURE';
    const allowedPrestates = value.allowedPrestates;
    if (
        !hasExactKeys(value, [
            'anchorPnu',
            'expectedStrategy',
            'expectedScannedPnus',
            'expectedPropertyUnitIds',
            'expectedProposedLandAreas',
            'expectedLadfrlAreaEvidence',
            'allowedPrestates',
            'parcelScopeEvidence',
            'landOwnershipEvidence',
            'allowManualOverwrite',
            'sourceReferences',
        ]) ||
        !hasExactKeys(ladfrl, ['parcels', 'totalArea']) ||
        typeof value.anchorPnu !== 'string' ||
        !PNU_RE.test(value.anchorPnu) ||
        (value.expectedStrategy !== 'LADFRL' &&
            value.expectedStrategy !== 'LDAREG') ||
        !Array.isArray(value.expectedScannedPnus) ||
        value.expectedScannedPnus.length === 0 ||
        !value.expectedScannedPnus.every(
            (pnu) => typeof pnu === 'string' && PNU_RE.test(pnu)
        ) ||
        !isSortedUnique(value.expectedScannedPnus as string[]) ||
        !Array.isArray(value.expectedPropertyUnitIds) ||
        value.expectedPropertyUnitIds.length === 0 ||
        !value.expectedPropertyUnitIds.every(
            (id) => typeof id === 'string' && UUID_RE.test(id)
        ) ||
        !isSortedUnique(value.expectedPropertyUnitIds as string[]) ||
        !Array.isArray(proposed) ||
        (verifiedNoDataSource
            ? proposed.length !== 0
            : proposed.length !==
              value.expectedPropertyUnitIds.length) ||
        !proposed.every((item) => {
            const row = asRecord(item, 'EVIDENCE_PROPOSED_AREA_INVALID');
            return (
                hasExactKeys(row, ['propertyUnitId', 'landArea']) &&
                typeof row.propertyUnitId === 'string' &&
                UUID_RE.test(row.propertyUnitId) &&
                assertPositiveDecimal(row.landArea)
            );
        }) ||
        !Array.isArray(parcels) ||
        parcels.length === 0 ||
        !parcels.every((item) => {
            const row = asRecord(item, 'EVIDENCE_LADFRL_AREA_INVALID');
            return (
                hasExactKeys(row, ['pnu', 'area']) &&
                typeof row.pnu === 'string' &&
                PNU_RE.test(row.pnu) &&
                assertPositiveDecimal(row.area)
            );
        }) ||
        !assertPositiveDecimal(ladfrl.totalArea) ||
        !Array.isArray(allowedPrestates) ||
        allowedPrestates.length === 0 ||
        !allowedPrestates.every((item) => {
            const row = asRecord(item, 'EVIDENCE_PRESTATE_INVALID');
            return (
                hasExactKeys(row, [
                    'propertyUnitId',
                    'landArea',
                    'landAreaSource',
                ]) &&
                typeof row.propertyUnitId === 'string' &&
                UUID_RE.test(row.propertyUnitId) &&
                (row.landArea === null ||
                    (typeof row.landArea === 'string' &&
                        /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(
                            row.landArea
                        ))) &&
                (row.landAreaSource === 'LEGACY_UNKNOWN' ||
                    row.landAreaSource === 'MANUAL' ||
                    row.landAreaSource === 'LADFRL' ||
                    row.landAreaSource === 'LDAREG')
            );
        }) ||
        typeof value.allowManualOverwrite !== 'boolean'
    ) {
        throw new ControlledRunnerError('EVIDENCE_ENTRY_INVALID');
    }

    assertEvidenceRef(
        value.parcelScopeEvidence,
        [
            'BUILDING_REGISTER_COPY',
            'BUILDING_REGISTER_TITLE_SECTION',
            'API_RELATION_CROSS_CHECK',
            'OTHER',
        ],
        'PARCEL_SCOPE_EVIDENCE_INVALID'
    );
    if (value.expectedStrategy === 'LADFRL') {
        assertEvidenceRef(
            value.landOwnershipEvidence,
            ['LAND_REGISTER_OR_REGISTRY', 'LAND_LEDGER_COPY', 'OTHER'],
            'LAND_OWNERSHIP_EVIDENCE_INVALID'
        );
    } else if (value.landOwnershipEvidence !== null) {
        throw new ControlledRunnerError(
            'LDAREG_LAND_OWNERSHIP_EVIDENCE_FORBIDDEN'
        );
    }

    if (manifestVersion === DEVELOPMENT_EVIDENCE_MANIFEST_VERSION) {
        if (
            !hasExactKeys(sources, [
                'workbookFileReferenceSha256',
                'sheet',
                'cells',
                'selectedCellsReferenceSha256',
                'phase0RunId',
                'phase0ArtifactReferenceSha256',
                'phase0ObservationReferenceSha256',
                'developmentObservationReferenceSha256',
            ]) ||
            typeof sources.workbookFileReferenceSha256 !== 'string' ||
            !HEX64_RE.test(sources.workbookFileReferenceSha256) ||
            typeof sources.sheet !== 'string' ||
            sources.sheet.length < 1 ||
            sources.sheet.length > 50 ||
            !Array.isArray(sources.cells) ||
            sources.cells.length === 0 ||
            !sources.cells.every(
                (cell) =>
                    typeof cell === 'string' &&
                    /^[A-Z]{1,3}[1-9][0-9]*$/.test(cell)
            ) ||
            typeof sources.selectedCellsReferenceSha256 !== 'string' ||
            !HEX64_RE.test(sources.selectedCellsReferenceSha256) ||
            typeof sources.phase0RunId !== 'string' ||
            !POSITIVE_INTEGER_RE.test(sources.phase0RunId) ||
            typeof sources.phase0ArtifactReferenceSha256 !== 'string' ||
            !HEX64_RE.test(sources.phase0ArtifactReferenceSha256) ||
            typeof sources.phase0ObservationReferenceSha256 !== 'string' ||
            !HEX64_RE.test(sources.phase0ObservationReferenceSha256) ||
            typeof sources.developmentObservationReferenceSha256 !==
                'string' ||
            !HEX64_RE.test(
                sources.developmentObservationReferenceSha256
            )
        ) {
            throw new ControlledRunnerError('EVIDENCE_SOURCE_INVALID');
        }
    } else if (
        (sources.kind !== 'DEVELOPMENT_READ_ONLY_API_CAPTURE' &&
            sources.kind !==
                'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_CAPTURE' &&
            sources.kind !==
                'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_PARCEL_CAPTURE' &&
            sources.kind !==
                'DEVELOPMENT_READ_ONLY_VERIFIED_NO_DATA_CAPTURE') ||
        !hasExactKeys(
            sources,
            sources.kind ===
                'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_CAPTURE'
                ? [
                      'kind',
                      'captureRunId',
                      'snapshotReferenceSha256',
                      'officialComponentDigest',
                  ]
                : sources.kind ===
                    'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_PARCEL_CAPTURE'
                  ? [
                        'kind',
                        'captureRunId',
                        'snapshotReferenceSha256',
                        'officialParcelDigest',
                    ]
                : sources.kind ===
                    'DEVELOPMENT_READ_ONLY_VERIFIED_NO_DATA_CAPTURE'
                  ? [
                        'kind',
                        'captureRunId',
                        'snapshotReferenceSha256',
                        'verifiedNoDataEvidenceDigest',
                    ]
                : [
                      'kind',
                      'captureRunId',
                      'snapshotReferenceSha256',
                  ]
        ) ||
        typeof sources.captureRunId !== 'string' ||
        !POSITIVE_INTEGER_RE.test(sources.captureRunId) ||
        typeof sources.snapshotReferenceSha256 !== 'string' ||
        !HEX64_RE.test(sources.snapshotReferenceSha256) ||
        (sources.kind ===
            'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_CAPTURE' &&
            (typeof sources.officialComponentDigest !==
                'string' ||
                !HEX64_RE.test(
                    sources.officialComponentDigest
                ))) ||
        (sources.kind ===
            'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_PARCEL_CAPTURE' &&
            (typeof sources.officialParcelDigest !== 'string' ||
                !HEX64_RE.test(sources.officialParcelDigest))) ||
        (sources.kind ===
            'DEVELOPMENT_READ_ONLY_VERIFIED_NO_DATA_CAPTURE' &&
            (typeof sources.verifiedNoDataEvidenceDigest !==
                'string' ||
                !HEX64_RE.test(
                    sources.verifiedNoDataEvidenceDigest
                )))
    ) {
        throw new ControlledRunnerError('EVIDENCE_SOURCE_INVALID');
    }

    const proposedIds = (proposed as Array<Record<string, unknown>>)
        .map((item) => item.propertyUnitId as string)
        .sort();
    if (
        verifiedNoDataSource
            ? proposedIds.length !== 0
            : JSON.stringify(proposedIds) !==
              JSON.stringify(value.expectedPropertyUnitIds)
    ) {
        throw new ControlledRunnerError('EVIDENCE_PROPOSED_MEMBERSHIP_MISMATCH');
    }
    if (verifiedNoDataSource) {
        throw new ControlledRunnerError(
            'EVIDENCE_VERIFIED_NO_DATA_FORBIDDEN'
        );
    }
    const prestateIds = [
        ...new Set(
            (allowedPrestates as Array<Record<string, unknown>>).map(
                (item) => item.propertyUnitId as string
            )
        ),
    ].sort();
    if (
        JSON.stringify(prestateIds) !==
        JSON.stringify(value.expectedPropertyUnitIds)
    ) {
        throw new ControlledRunnerError('EVIDENCE_PRESTATE_MEMBERSHIP_MISMATCH');
    }
    const parcelPnus = (parcels as Array<Record<string, unknown>>)
        .map((item) => item.pnu as string)
        .sort();
    if (
        JSON.stringify(parcelPnus) !==
        JSON.stringify(value.expectedScannedPnus)
    ) {
        throw new ControlledRunnerError('EVIDENCE_LADFRL_SCOPE_MISMATCH');
    }
    return value as unknown as DevelopmentEvidenceEntry;
}

export function parseDevelopmentEvidenceManifest(
    input: unknown
): DevelopmentEvidenceManifest {
    const value = asRecord(input, 'EVIDENCE_MANIFEST_INVALID');
    const version = value.version;
    if (
        !hasExactKeys(value, [
            'version',
            'databaseTarget',
            'unionId',
            'manifestDigest',
            'entries',
        ]) ||
        (version !== DEVELOPMENT_EVIDENCE_MANIFEST_VERSION &&
            version !== DEVELOPMENT_EVIDENCE_MANIFEST_VERSION_V2) ||
        !isLandAreaSyncRunnerDatabaseTarget(value.databaseTarget) ||
        typeof value.unionId !== 'string' ||
        !UUID_RE.test(value.unionId) ||
        typeof value.manifestDigest !== 'string' ||
        !HEX64_RE.test(value.manifestDigest) ||
        !Array.isArray(value.entries) ||
        value.entries.length === 0
    ) {
        throw new ControlledRunnerError('EVIDENCE_MANIFEST_INVALID');
    }
    return {
        version,
        databaseTarget: value.databaseTarget,
        unionId: value.unionId,
        manifestDigest: value.manifestDigest,
        entries: value.entries.map((entry) =>
            parseEvidenceEntry(entry, version)
        ),
    } as DevelopmentEvidenceManifest;
}

function normalizedUrl(value: string): string {
    return value.trim().replace(/\/+$/, '').toLowerCase();
}

export interface DevelopmentRunnerEnvironmentSelection {
    /** target 환경의 API JWT 서명 비밀. dev=DEV_API_JWT_SECRET, production=JWT_SECRET */
    apiJwtSecret: string;
    /** target 환경의 preflight/postflight 읽기용 Supabase 접속 정보 */
    supabaseUrl: string;
    supabaseServiceRoleKey: string;
}

export function validateDevelopmentRunnerEnvironment(
    input: DevelopmentRunnerEnvironment,
    target: DevelopmentTargetManifest
): DevelopmentRunnerEnvironmentSelection {
    const developmentValues = [
        input.DEV_API_JWT_SECRET,
        input.DEV_SUPABASE_URL,
        input.DEV_SUPABASE_SERVICE_ROLE_KEY,
    ];
    const productionValues = [
        input.JWT_SECRET,
        input.SUPABASE_URL,
        input.SUPABASE_SERVICE_ROLE_KEY,
    ];
    // target 과 무관하게 두 환경 세트가 모두 존재하고 서로 격리되어 있어야 한다.
    // (EC2 컨테이너 계약 — 둘이 같으면 어느 쪽 실행이든 환경 구분이 무의미해진다.)
    if (
        developmentValues.some((value) => !value) ||
        productionValues.some((value) => !value)
    ) {
        throw new ControlledRunnerError('DEVELOPMENT_SERVICE_ENV_MISSING');
    }
    if (
        input.DEV_API_JWT_SECRET === input.JWT_SECRET ||
        normalizedUrl(input.DEV_SUPABASE_URL!) ===
            normalizedUrl(input.SUPABASE_URL!) ||
        input.DEV_SUPABASE_SERVICE_ROLE_KEY ===
            input.SUPABASE_SERVICE_ROLE_KEY
    ) {
        throw new ControlledRunnerError('DEVELOPMENT_ENVIRONMENT_NOT_ISOLATED');
    }
    if (input.LAND_AREA_SYNC_ENABLED !== 'true') {
        throw new ControlledRunnerError('LAND_AREA_SYNC_DISABLED');
    }

    let runtimeManifest;
    try {
        runtimeManifest = createLandAreaSyncAllowedTargetsManifest(
            input.LAND_AREA_SYNC_ALLOWED_TARGETS
        );
    } catch {
        throw new ControlledRunnerError('RUNTIME_ALLOWLIST_INVALID');
    }
    const allowedScopePnus =
        developmentTargetAllowedScopePnus(target);
    const targetCanonical = canonicalTargetValue(
        target.databaseTarget,
        target.unionId,
        allowedScopePnus
    );
    if (
        runtimeManifest.count !== allowedScopePnus.length ||
        runtimeManifest.digest !==
            developmentTargetScopeDigest(target) ||
        runtimeManifest.canonicalValue !== targetCanonical
    ) {
        throw new ControlledRunnerError('RUNTIME_ALLOWLIST_MANIFEST_MISMATCH');
    }

    return target.databaseTarget === 'development'
        ? {
              apiJwtSecret: input.DEV_API_JWT_SECRET!,
              supabaseUrl: input.DEV_SUPABASE_URL!,
              supabaseServiceRoleKey:
                  input.DEV_SUPABASE_SERVICE_ROLE_KEY!,
          }
        : {
              apiJwtSecret: input.JWT_SECRET!,
              supabaseUrl: input.SUPABASE_URL!,
              supabaseServiceRoleKey:
                  input.SUPABASE_SERVICE_ROLE_KEY!,
          };
}

export function validateDevelopmentRunnerManifests(
    target: DevelopmentTargetManifest,
    dbApproval: DevelopmentDbApprovalManifest,
    evidence: DevelopmentEvidenceManifest
): void {
    const developmentFullRefresh =
        developmentFullRefreshMarkerForTarget(target);
    const anchors = developmentTargetExecutionAnchors(target);
    const allowedScopePnus =
        developmentTargetAllowedScopePnus(target);
    if (
        dbApproval.databaseTarget !== target.databaseTarget ||
        dbApproval.unionId.toLowerCase() !== target.unionId.toLowerCase() ||
        dbApproval.targetCount !== allowedScopePnus.length ||
        dbApproval.manifestDigest !==
            developmentTargetScopeDigest(target) ||
        JSON.stringify(dbApproval.pnus) !==
            JSON.stringify(allowedScopePnus)
    ) {
        throw new ControlledRunnerError('DB_APPROVAL_MANIFEST_MISMATCH');
    }
    if (
        evidence.databaseTarget !== target.databaseTarget ||
        evidence.unionId.toLowerCase() !== target.unionId.toLowerCase() ||
        evidence.manifestDigest !== target.manifestDigest
    ) {
        throw new ControlledRunnerError('EVIDENCE_MANIFEST_MISMATCH');
    }
    if (
        (target.version === DEVELOPMENT_TARGET_MANIFEST_VERSION &&
            evidence.version !== DEVELOPMENT_EVIDENCE_MANIFEST_VERSION) ||
        (target.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION &&
            evidence.version !==
                DEVELOPMENT_EVIDENCE_MANIFEST_VERSION_V2)
    ) {
        throw new ControlledRunnerError(
            'EVIDENCE_MANIFEST_VERSION_MISMATCH'
        );
    }
    const hasSameRunOfficialEvidence =
        evidence.entries.some(
            (entry) =>
                'kind' in entry.sourceReferences &&
                (entry.sourceReferences.kind ===
                    'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_CAPTURE' ||
                    entry.sourceReferences.kind ===
                        'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_PARCEL_CAPTURE')
        );
    const verifiedNoDataEntries = evidence.entries.filter(
        (entry) =>
            'kind' in entry.sourceReferences &&
            entry.sourceReferences.kind ===
                'DEVELOPMENT_READ_ONLY_VERIFIED_NO_DATA_CAPTURE'
    );
    if (
        hasSameRunOfficialEvidence &&
        developmentFullRefresh === null
    ) {
        throw new ControlledRunnerError(
            'EVIDENCE_SCOPE_NOT_WRITE_ELIGIBLE'
        );
    }
    if (
        developmentFullRefresh !== null &&
        evidence.entries.some(
            (entry) =>
                !('kind' in entry.sourceReferences) ||
                (entry.sourceReferences.kind !==
                    'DEVELOPMENT_READ_ONLY_API_CAPTURE' &&
                entry.sourceReferences.kind !==
                        'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_CAPTURE' &&
                entry.sourceReferences.kind !==
                        'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_PARCEL_CAPTURE' &&
                entry.sourceReferences.kind !==
                        'DEVELOPMENT_READ_ONLY_VERIFIED_NO_DATA_CAPTURE')
        )
    ) {
        throw new ControlledRunnerError(
            'FULL_REFRESH_EVIDENCE_SOURCE_INVALID'
        );
    }
    if (verifiedNoDataEntries.length > 0) {
        throw new ControlledRunnerError(
            'FULL_REFRESH_VERIFIED_NO_DATA_EVIDENCE_FORBIDDEN'
        );
    }
    const entriesByPnu = new Map(
        evidence.entries.map((entry) => [entry.anchorPnu, entry])
    );
    if (
        entriesByPnu.size !== anchors.length ||
        anchors.some((pnu) => !entriesByPnu.has(pnu))
    ) {
        throw new ControlledRunnerError('EVIDENCE_PNU_COVERAGE_MISMATCH');
    }
    const approvedPnus = new Set(allowedScopePnus);
    const observedScannedPnus = new Set<string>();
    for (const entry of evidence.entries) {
        const isOfficialParcelEvidence =
            'kind' in entry.sourceReferences &&
            entry.sourceReferences.kind ===
                'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_PARCEL_CAPTURE';
        if (
            isOfficialParcelEvidence &&
            (developmentFullRefresh === null ||
                entry.expectedStrategy !== 'LADFRL' ||
                entry.expectedScannedPnus.length !== 1 ||
                entry.expectedScannedPnus[0] !==
                    entry.anchorPnu ||
                entry.expectedPropertyUnitIds.length !== 1 ||
                entry.expectedProposedLandAreas.length !== 1)
        ) {
            throw new ControlledRunnerError(
                'FULL_REFRESH_PARCEL_EVIDENCE_SHAPE_MISMATCH'
            );
        }
        if (entry.expectedScannedPnus.some((pnu) => !approvedPnus.has(pnu))) {
            throw new ControlledRunnerError('EVIDENCE_SCOPE_OUTSIDE_MANIFEST');
        }
        if (
            target.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION &&
            entry.expectedScannedPnus.some((pnu) =>
                observedScannedPnus.has(pnu)
            )
        ) {
            throw new ControlledRunnerError(
                'EVIDENCE_SCANNED_PNU_OVERLAP'
            );
        }
        entry.expectedScannedPnus.forEach((pnu) =>
            observedScannedPnus.add(pnu)
        );
        if (
            target.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION &&
            entry.allowManualOverwrite !== true
        ) {
            throw new ControlledRunnerError(
                'MANUAL_OVERWRITE_EVIDENCE_MISMATCH'
            );
        }
    }
    if (
        target.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION &&
        (observedScannedPnus.size !== allowedScopePnus.length ||
            allowedScopePnus.some(
                (pnu) => !observedScannedPnus.has(pnu)
            ))
    ) {
        throw new ControlledRunnerError(
            'EVIDENCE_SCANNED_PNU_COVERAGE_MISMATCH'
        );
    }
    const allExpectedPropertyUnitIds = evidence.entries.flatMap(
        (entry) => entry.expectedPropertyUnitIds
    );
    const expectedPropertyUnitIds = new Set(
        allExpectedPropertyUnitIds
    );
    if (
        expectedPropertyUnitIds.size !==
        allExpectedPropertyUnitIds.length
    ) {
        throw new ControlledRunnerError(
            'EVIDENCE_PROPERTY_UNIT_ID_OVERLAP'
        );
    }
    if (
        expectedPropertyUnitIds.size !==
        target.expectedPropertyUnitCount
    ) {
        throw new ControlledRunnerError(
            'EXPECTED_PROPERTY_UNIT_COUNT_MISMATCH'
        );
    }
}

export function createDevelopmentGisSystemAdminJwt(
    secret: string,
    actorAuthUserId: string,
    now: Date = new Date(),
    databaseTarget: LandAreaSyncRunnerDatabaseTarget = 'development'
): string {
    if (
        !secret ||
        !UUID_RE.test(actorAuthUserId) ||
        !isLandAreaSyncRunnerDatabaseTarget(databaseTarget)
    ) {
        throw new ControlledRunnerError('JWT_INPUT_INVALID');
    }
    const issuedAt = Math.floor(now.getTime() / 1000);
    // auth.service 의 환경 계약: 서명키(kid)가 환경을 확정하고 claim 은 일치 검증만
    // 한다. dev = kid 'dev' + iss 'tonghari-web-dev' + DEV_API_JWT_SECRET,
    // production = kid 'prod' + iss 'tonghari-web' + JWT_SECRET.
    const development = databaseTarget === 'development';
    return jwt.sign(
        {
            sub: actorAuthUserId.toLowerCase(),
            userId: actorAuthUserId.toLowerCase(),
            unionId: 'system',
            role: 'SYSTEM_ADMIN',
            purpose: 'GIS_SYSTEM_ADMIN',
            databaseTarget,
            iss: development ? 'tonghari-web-dev' : 'tonghari-web',
            aud: 'tonghari-api',
            iat: issuedAt,
            exp: issuedAt + DEVELOPMENT_GIS_JWT_TTL_SECONDS,
            jti: randomUUID(),
        },
        secret,
        {
            algorithm: 'HS256',
            keyid: development ? 'dev' : 'prod',
        }
    );
}

function requireApiJob(value: unknown): LandAreaSyncApiJob {
    const row = asRecord(value, 'API_RESPONSE_INVALID');
    if (
        row.success !== true ||
        typeof row.jobId !== 'string' ||
        !UUID_RE.test(row.jobId) ||
        typeof row.unionId !== 'string' ||
        !UUID_RE.test(row.unionId) ||
        (row.status !== 'PROCESSING' &&
            row.status !== 'COMPLETED' &&
            row.status !== 'FAILED') ||
        typeof row.progress !== 'number' ||
        row.progress < 0 ||
        row.progress > 100
    ) {
        throw new ControlledRunnerError('API_RESPONSE_INVALID');
    }
    return {
        jobId: row.jobId,
        unionId: row.unionId,
        status: row.status,
        progress: row.progress,
        landAreaSync:
            row.landAreaSync && typeof row.landAreaSync === 'object'
                ? (row.landAreaSync as LandAreaSyncApiJob['landAreaSync'])
                : null,
        ...(typeof row.createdAt === 'string' ? { createdAt: row.createdAt } : {}),
        ...(typeof row.updatedAt === 'string' ? { updatedAt: row.updatedAt } : {}),
    };
}

export class LocalhostDevelopmentLandAreaSyncClient
    implements LandAreaSyncApiClient
{
    constructor(
        private readonly secret: string,
        private readonly actorAuthUserId: string,
        private readonly now: () => Date = () => new Date(),
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly databaseTarget: LandAreaSyncRunnerDatabaseTarget = 'development'
    ) {}

    private async request(
        path: string,
        init: { method: 'GET' | 'POST'; body?: Record<string, unknown> }
    ): Promise<{ status: number; value: unknown }> {
        const token = createDevelopmentGisSystemAdminJwt(
            this.secret,
            this.actorAuthUserId,
            this.now(),
            this.databaseTarget
        );
        // 2026-08-02: 같은 컨테이너에서 guardian의 node:http health check는 매 run
        // 성공하는 반면 undici fetch 기반 요청은 서버가 요청을 수신·처리(잡 생성
        // 2초 완료)했음에도 응답 수신 전 15초 타임아웃으로 죽는 현상이 11~14차
        // write run에서 결정론적으로 재현됐다. 기본 전송층을 검증된 node:http로
        // 교체한다. 테스트가 fetchImpl을 주입한 경우에만 기존 fetch 경로를 쓴다.
        // 2026-08-03: gisSystemAdminMiddleware가 응답 전에 dev Supabase 조회를
        // await하므로 DB 지연이 15초를 넘으면 "잡은 생성되는데 응답만 유실"
        // 형상이 된다. 지연/유실을 판별하도록 요청 타임아웃을 60초로 올린다.
        if (this.fetchImpl !== fetch) {
            return this.requestViaFetch(path, init, token);
        }
        let response: { status: number; bytes: Buffer };
        try {
            response = await new Promise<{ status: number; bytes: Buffer }>(
                (resolve, reject) => {
                    const bodyText = init.body
                        ? JSON.stringify(init.body)
                        : null;
                    const request = nodeHttpRequest(
                        `${LOCAL_API_ORIGIN}${path}`,
                        {
                            method: init.method,
                            headers: {
                                Accept: 'application/json',
                                Authorization: `Bearer ${token}`,
                                ...(bodyText
                                    ? {
                                          'Content-Type':
                                              'application/json',
                                          'Content-Length': String(
                                              Buffer.byteLength(bodyText)
                                          ),
                                      }
                                    : {}),
                            },
                            timeout: LOCAL_API_REQUEST_TIMEOUT_MS,
                        },
                        (incoming) => {
                            const chunks: Buffer[] = [];
                            let size = 0;
                            incoming.on('data', (chunk: Buffer) => {
                                size += chunk.length;
                                if (size > RESPONSE_SIZE_LIMIT) {
                                    incoming.destroy();
                                    reject(
                                        new ControlledApiError(
                                            'API_RESPONSE_TOO_LARGE',
                                            incoming.statusCode ?? 0
                                        )
                                    );
                                    return;
                                }
                                chunks.push(chunk);
                            });
                            incoming.on('end', () =>
                                resolve({
                                    status: incoming.statusCode ?? 0,
                                    bytes: Buffer.concat(chunks),
                                })
                            );
                            incoming.on('error', () =>
                                reject(
                                    new ControlledApiError(
                                        'API_NETWORK_ERROR',
                                        0
                                    )
                                )
                            );
                        }
                    );
                    request.on('timeout', () => {
                        request.destroy();
                        reject(
                            new ControlledApiError('API_NETWORK_ERROR', 0)
                        );
                    });
                    request.on('error', () =>
                        reject(
                            new ControlledApiError('API_NETWORK_ERROR', 0)
                        )
                    );
                    if (bodyText) {
                        request.write(bodyText);
                    }
                    request.end();
                }
            );
        } catch (error) {
            if (error instanceof ControlledApiError) {
                throw error;
            }
            throw new ControlledApiError('API_NETWORK_ERROR', 0);
        }
        let value: unknown;
        try {
            value = JSON.parse(response.bytes.toString('utf8'));
        } catch {
            throw new ControlledApiError('API_RESPONSE_NOT_JSON', response.status);
        }
        if (response.status < 200 || response.status >= 300) {
            const body = value && typeof value === 'object'
                ? (value as Record<string, unknown>)
                : {};
            const code =
                typeof body.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(body.code)
                    ? body.code
                    : `HTTP_${response.status}`;
            throw new ControlledApiError(code, response.status);
        }
        return { status: response.status, value };
    }

    /** 테스트 전용 경로 — fetchImpl 주입 시 기존 fetch 기반 전송을 유지한다. */
    private async requestViaFetch(
        path: string,
        init: { method: 'GET' | 'POST'; body?: Record<string, unknown> },
        token: string
    ): Promise<{ status: number; value: unknown }> {
        let response: Response;
        try {
            response = await this.fetchImpl(`${LOCAL_API_ORIGIN}${path}`, {
                method: init.method,
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${token}`,
                    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
                },
                ...(init.body ? { body: JSON.stringify(init.body) } : {}),
                redirect: 'error',
                signal: AbortSignal.timeout(LOCAL_API_REQUEST_TIMEOUT_MS),
            });
        } catch {
            throw new ControlledApiError('API_NETWORK_ERROR', 0);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > RESPONSE_SIZE_LIMIT) {
            throw new ControlledApiError('API_RESPONSE_TOO_LARGE', response.status);
        }
        let value: unknown;
        try {
            value = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            throw new ControlledApiError('API_RESPONSE_NOT_JSON', response.status);
        }
        if (!response.ok) {
            const body = value && typeof value === 'object'
                ? (value as Record<string, unknown>)
                : {};
            const code =
                typeof body.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(body.code)
                    ? body.code
                    : `HTTP_${response.status}`;
            throw new ControlledApiError(code, response.status);
        }
        return { status: response.status, value };
    }

    async getLatest(
        unionId: string,
        pnu: string
    ): Promise<LandAreaSyncApiJob | null> {
        try {
            const response = await this.request(
                `/api/gis/land-area-sync/latest?unionId=${encodeURIComponent(
                    unionId
                )}&pnu=${encodeURIComponent(pnu)}`,
                { method: 'GET' }
            );
            return requireApiJob(response.value);
        } catch (error) {
            if (
                error instanceof ControlledApiError &&
                error.status === 404 &&
                error.code === 'JOB_NOT_FOUND'
            ) {
                return null;
            }
            throw error;
        }
    }

    async getJob(unionId: string, jobId: string): Promise<LandAreaSyncApiJob> {
        const response = await this.request(
            `/api/gis/land-area-sync/${encodeURIComponent(
                jobId
            )}?unionId=${encodeURIComponent(unionId)}`,
            { method: 'GET' }
        );
        const job = requireApiJob(response.value);
        if (
            job.jobId.toLowerCase() !== jobId.toLowerCase() ||
            job.unionId.toLowerCase() !== unionId.toLowerCase()
        ) {
            throw new ControlledRunnerError('API_JOB_SCOPE_MISMATCH');
        }
        return job;
    }

    async getAdmission(
        unionId: string,
        admissionKey: string,
        sourceDiscoveryJobId: string | null
    ): Promise<LandAreaSyncApiJob | null> {
        try {
            const response = await this.request(
                `/api/gis/land-area-sync/admissions/${encodeURIComponent(
                    admissionKey
                )}?unionId=${encodeURIComponent(
                    unionId
                )}&sourceDiscoveryJobId=${encodeURIComponent(
                    sourceDiscoveryJobId ?? 'none'
                )}`,
                { method: 'GET' }
            );
            const job = requireApiJob(response.value);
            if (
                job.unionId.toLowerCase() !== unionId.toLowerCase() ||
                job.landAreaSync?.admissionKey?.toLowerCase() !==
                    admissionKey.toLowerCase() ||
                job.landAreaSync?.sourceDiscoveryJobId !==
                    sourceDiscoveryJobId
            ) {
                throw new ControlledRunnerError(
                    'API_ADMISSION_SCOPE_MISMATCH'
                );
            }
            return job;
        } catch (error) {
            if (
                error instanceof ControlledApiError &&
                error.status === 404 &&
                error.code === 'JOB_NOT_FOUND'
            ) {
                return null;
            }
            throw error;
        }
    }

    async admitDiscovery(
        unionId: string,
        pnu: string,
        admissionKey: string,
        developmentFullRefresh?: LandAreaSyncDevelopmentFullRefresh
    ): Promise<string> {
        const response = await this.request('/api/gis/land-area-sync', {
            method: 'POST',
            body: {
                unionId,
                anchorPnu: pnu,
                admissionKey,
                ...(developmentFullRefresh
                    ? { developmentFullRefresh }
                    : {}),
            },
        });
        const value = asRecord(response.value, 'API_RESPONSE_INVALID');
        if (
            response.status !== 202 ||
            value.success !== true ||
            typeof value.jobId !== 'string' ||
            !UUID_RE.test(value.jobId) ||
            value.jobId.toLowerCase() !== admissionKey.toLowerCase()
        ) {
            throw new ControlledRunnerError('API_RESPONSE_INVALID');
        }
        return value.jobId;
    }

    async confirmDiscovery(
        discoveryJobId: string,
        body: Parameters<LandAreaSyncApiClient['confirmDiscovery']>[1]
    ): Promise<string> {
        const response = await this.request(
            `/api/gis/land-area-sync/${encodeURIComponent(
                discoveryJobId
            )}/confirm`,
            { method: 'POST', body }
        );
        const value = asRecord(response.value, 'API_RESPONSE_INVALID');
        if (
            response.status !== 202 ||
            value.success !== true ||
            typeof value.jobId !== 'string' ||
            !UUID_RE.test(value.jobId) ||
            value.sourceDiscoveryJobId !== discoveryJobId
        ) {
            throw new ControlledRunnerError('API_RESPONSE_INVALID');
        }
        return value.jobId;
    }
}

function sortedProposedAreas(
    rows: Array<{ propertyUnitId: string; landArea: string }>
): Array<{ propertyUnitId: string; landArea: string }> {
    return [...rows]
        .sort((a, b) => a.propertyUnitId.localeCompare(b.propertyUnitId))
        .map((row) => ({
            // jsonb와 JSON 파일은 객체 key 순서를 다르게 보존할 수 있으므로
            // 의미 필드를 고정 순서로 재구성한 뒤 비교한다.
            propertyUnitId: row.propertyUnitId,
            landArea: row.landArea,
        }));
}

function isVerifiedNoDataEvidenceEntry(
    evidence: DevelopmentEvidenceEntry
): boolean {
    return (
        'kind' in evidence.sourceReferences &&
        evidence.sourceReferences.kind ===
            'DEVELOPMENT_READ_ONLY_VERIFIED_NO_DATA_CAPTURE'
    );
}

function assertJobEvidenceMatches(
    job: LandAreaSyncApiJob,
    evidence: DevelopmentEvidenceEntry,
    requireDiscovery: boolean,
    developmentFullRefresh:
        | LandAreaSyncDevelopmentFullRefresh
        | null
): LandAreaSyncScopeSnapshot {
    const land = job.landAreaSync;
    const snapshot = land?.scopeSnapshot;
    // 공개 artifact에는 값 자체가 아니라 아래의 유한한 비교 단계 코드만 남긴다.
    // 운영자가 coarse한 mismatch를 재시도하며 추측하지 않고 쓰기 전에 정확히 중단할 수 있다.
    if (!land) {
        throw new ControlledRunnerError('JOB_EVIDENCE_LAND_MISSING');
    }
    if (land.anchorPnu !== evidence.anchorPnu) {
        throw new ControlledRunnerError('JOB_EVIDENCE_ANCHOR_PNU_MISMATCH');
    }
    if (
        !developmentLandAreaFullRefreshMarkersEqual(
            land.developmentFullRefresh,
            developmentFullRefresh
        )
    ) {
        throw new ControlledRunnerError(
            'JOB_EVIDENCE_FULL_REFRESH_MARKER_MISMATCH'
        );
    }
    if (requireDiscovery && land.sourceDiscoveryJobId !== null) {
        throw new ControlledRunnerError(
            'JOB_EVIDENCE_DISCOVERY_LINEAGE_MISMATCH'
        );
    }
    if (!snapshot) {
        throw new ControlledRunnerError('JOB_EVIDENCE_SNAPSHOT_MISSING');
    }
    if (snapshot.strategy !== evidence.expectedStrategy) {
        throw new ControlledRunnerError('JOB_EVIDENCE_STRATEGY_MISMATCH');
    }
    if (
        JSON.stringify(snapshot.scannedPnus) !==
        JSON.stringify(evidence.expectedScannedPnus)
    ) {
        throw new ControlledRunnerError('JOB_EVIDENCE_SCANNED_PNUS_MISMATCH');
    }
    if (
        JSON.stringify(snapshot.candidatePropertyUnitIds) !==
        JSON.stringify(evidence.expectedPropertyUnitIds)
    ) {
        throw new ControlledRunnerError(
            'JOB_EVIDENCE_PROPERTY_UNITS_MISMATCH'
        );
    }
    if (
        JSON.stringify(sortedProposedAreas(snapshot.proposedLandAreas)) !==
        JSON.stringify(
            sortedProposedAreas(evidence.expectedProposedLandAreas)
        )
    ) {
        throw new ControlledRunnerError(
            'JOB_EVIDENCE_PROPOSED_AREAS_MISMATCH'
        );
    }
    if (!snapshot.ladfrlAreaEvidence) {
        throw new ControlledRunnerError('JOB_EVIDENCE_LADFRL_MISSING');
    }
    if (
        JSON.stringify(snapshot.ladfrlAreaEvidence.parcels) !==
        JSON.stringify(evidence.expectedLadfrlAreaEvidence.parcels)
    ) {
        throw new ControlledRunnerError(
            'JOB_EVIDENCE_LADFRL_PARCELS_MISMATCH'
        );
    }
    if (
        snapshot.ladfrlAreaEvidence.totalArea !==
        evidence.expectedLadfrlAreaEvidence.totalArea
    ) {
        throw new ControlledRunnerError(
            'JOB_EVIDENCE_LADFRL_TOTAL_MISMATCH'
        );
    }
    if (!HEX64_RE.test(snapshot.scopeHash)) {
        throw new ControlledRunnerError('JOB_EVIDENCE_SCOPE_HASH_INVALID');
    }
    const sameRunOfficialDigest =
        'kind' in evidence.sourceReferences &&
        evidence.sourceReferences.kind ===
            'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_CAPTURE'
            ? evidence.sourceReferences.officialComponentDigest
            : null;
    const sameRunOfficialEvidence =
        sameRunOfficialDigest !== null;
    const sameRunOfficialParcelDigest =
        'kind' in evidence.sourceReferences &&
        evidence.sourceReferences.kind ===
            'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_PARCEL_CAPTURE'
            ? evidence.sourceReferences.officialParcelDigest
            : null;
    const sameRunOfficialParcelEvidence =
        sameRunOfficialParcelDigest !== null;
    const verifiedNoDataEvidence =
        isVerifiedNoDataEvidenceEntry(evidence);
    if (verifiedNoDataEvidence) {
        throw new ControlledRunnerError(
            'JOB_EVIDENCE_VERIFIED_NO_DATA_FORBIDDEN'
        );
    } else if (sameRunOfficialParcelEvidence) {
        const resolution =
            snapshot.developmentFullRefreshParcelResolution;
        if (
            developmentFullRefresh === null ||
            !resolution ||
            resolution.source !==
                'SAME_RUN_OFFICIAL_DEVELOPMENT_PARCEL_SINGLETON' ||
            resolution.canonicalPnu !== evidence.anchorPnu ||
            JSON.stringify(resolution.memberPnus) !==
                JSON.stringify(evidence.expectedScannedPnus) ||
            resolution.memberPnus.length !== 1 ||
            resolution.memberPnus[0] !== resolution.canonicalPnu ||
            snapshot.strategy !== 'LADFRL' ||
            snapshot.candidatePropertyUnitIds.length !== 1 ||
            !HEX64_RE.test(resolution.officialParcelDigest) ||
            resolution.officialParcelDigest !==
                sameRunOfficialParcelDigest ||
            resolution.manifestDigest !==
                developmentFullRefresh.manifestDigest ||
            resolution.scopeDigest !==
                developmentFullRefresh.scopeDigest ||
            snapshot.developmentFullRefreshScopeResolution !==
                undefined ||
            snapshot.readOnlyScopeResolution !== undefined
        ) {
            throw new ControlledRunnerError(
                'JOB_EVIDENCE_FULL_REFRESH_PARCEL_RESOLUTION_MISMATCH'
            );
        }
    } else if (
        developmentFullRefresh !== null ||
        sameRunOfficialEvidence
    ) {
        const resolution =
            snapshot.developmentFullRefreshScopeResolution;
        if (
            developmentFullRefresh === null ||
            !resolution ||
            resolution.source !==
                'SAME_RUN_OFFICIAL_DEVELOPMENT_FULL_REFRESH' ||
            resolution.canonicalBasePnu !==
                evidence.anchorPnu ||
            JSON.stringify(resolution.memberPnus) !==
                JSON.stringify(evidence.expectedScannedPnus) ||
            typeof resolution.managementPk !== 'string' ||
            resolution.managementPk.length === 0 ||
            resolution.pairCount !==
                resolution.memberPnus.length - 1 ||
            !HEX64_RE.test(
                resolution.officialComponentDigest
            ) ||
            (sameRunOfficialEvidence &&
                resolution.officialComponentDigest !==
                    sameRunOfficialDigest) ||
            resolution.manifestDigest !==
                developmentFullRefresh.manifestDigest ||
            resolution.scopeDigest !==
                developmentFullRefresh.scopeDigest ||
            snapshot.developmentFullRefreshParcelResolution !==
                undefined ||
            snapshot.readOnlyScopeResolution !== undefined
        ) {
            throw new ControlledRunnerError(
                'JOB_EVIDENCE_FULL_REFRESH_SCOPE_RESOLUTION_MISMATCH'
            );
        }
    }
    if (
        !verifiedNoDataEvidence &&
        snapshot.verifiedNoDataEvidence !== undefined
    ) {
        throw new ControlledRunnerError(
            'JOB_EVIDENCE_UNEXPECTED_VERIFIED_NO_DATA'
        );
    }
    if (
        !sameRunOfficialParcelEvidence &&
        snapshot.developmentFullRefreshParcelResolution !==
            undefined
    ) {
        throw new ControlledRunnerError(
            'JOB_EVIDENCE_UNEXPECTED_FULL_REFRESH_PARCEL_RESOLUTION'
        );
    }
    return snapshot;
}

function issueCodes(job: LandAreaSyncApiJob): string[] {
    const codes = (job.landAreaSync?.issues ?? [])
        .map((issue) => issue.code)
        .filter(
            (code): code is string =>
                typeof code === 'string' && /^[A-Z0-9_]{1,100}$/.test(code)
        );
    return [...new Set(codes)].sort();
}

function hasBlockingIssue(job: LandAreaSyncApiJob): boolean {
    const codes = issueCodes(job);
    const blockingPattern =
        /CACHE|CONFLICT|REVIEW|PENDING|UNRESOLVED|BLOCKING|MISMATCH|INCOMPLETE|ERROR|FAILED|RATIO|AMBIGUOUS|NOT_FOUND|CHANGED|DENIED/;
    return codes.some((code) => blockingPattern.test(code));
}

export interface DevelopmentAnchorRetryEvent {
    pnu: string;
    attempt: number;
    failureCode: string;
    nextDelayMs: number;
}

const RETRYABLE_ANCHOR_FAILURE_CODES = new Set([
    'DISCOVERY_OR_APPLY_JOB_FAILED',
    'APPLY_JOB_FAILED',
]);

// 재시도 가능 = 원천/워커 job 이 FAILED 로 끝났거나(scan 단계 provider 오류 등)
// localhost API 왕복이 네트워크·5xx·429 로 깨진 경우. 4xx(인증·검증 거부)와
// 러너 자체의 계약 위반 코드는 재시도해도 같은 결과이므로 즉시 중단한다.
function isRetryableAnchorFailure(error: unknown): boolean {
    if (error instanceof ControlledApiError) {
        return (
            error.status === 0 ||
            error.status === 429 ||
            (error.status >= 500 && error.status <= 599)
        );
    }
    return (
        error instanceof ControlledRunnerError &&
        RETRYABLE_ANCHOR_FAILURE_CODES.has(error.code)
    );
}

function isAmbiguousAdmissionError(error: unknown): boolean {
    return (
        error instanceof ControlledApiError &&
        (error.status === 0 ||
            (error.status >= 500 && error.status <= 599))
    );
}

function hasWorkerFinalization(job: LandAreaSyncApiJob): boolean {
    const receipt = job.landAreaSync?.workerFinalization;
    return (
        receipt?.version === 1 &&
        typeof receipt.finalizedAt === 'string' &&
        !Number.isNaN(Date.parse(receipt.finalizedAt))
    );
}

async function reconcileAmbiguousAdmission(input: {
    client: LandAreaSyncApiClient;
    unionId: string;
    pnu: string;
    admissionKey: string;
    sourceDiscoveryJobId: string | null;
    pollIntervalMs: number;
    maxAttempts: number;
    sleep: (milliseconds: number) => Promise<void>;
    replayAdmission: () => Promise<string>;
    /** 최초 admission 실패 원인 — durable 미발견 시 최종 코드에 보존한다. */
    initiatingError?: unknown;
}): Promise<LandAreaSyncApiJob> {
    // 최초 POST는 동일 admission UUID로 한 번 호출한다. 5xx/timeout이면 latest를
    // 추정하지 않고 exact durable id만 제한된 횟수 조회한다. durable PROCESSING 행을
    // 찾은 경우에만 DB INSERT 뒤 메모리 queue admission 유실을 복구하도록 같은
    // admission UUID/digest POST를 한 번 재전송하고 immutable receipt까지 drain한다.
    for (let attempt = 0; attempt < input.maxAttempts; attempt += 1) {
        await input.sleep(input.pollIntervalMs);
        if (!input.client.getAdmission) {
            throw new ControlledRunnerError(
                'ADMISSION_LOOKUP_UNAVAILABLE'
            );
        }
        let exact: LandAreaSyncApiJob | null = null;
        try {
            exact = await input.client.getAdmission(
                input.unionId,
                input.admissionKey,
                input.sourceDiscoveryJobId
            );
        } catch (error) {
            if (!isAmbiguousAdmissionError(error)) {
                throw error;
            }
            // 일시적 network/5xx만 bounded window 안에서 다시 확인한다.
            continue;
        }
        if (
            exact &&
            exact.landAreaSync?.admissionKey?.toLowerCase() ===
                input.admissionKey.toLowerCase() &&
            exact.landAreaSync?.anchorPnu === input.pnu &&
            (input.sourceDiscoveryJobId === null
                ? exact.landAreaSync?.sourceDiscoveryJobId == null
                : exact.landAreaSync?.sourceDiscoveryJobId ===
                  input.sourceDiscoveryJobId)
        ) {
            if (
                exact.status === 'PROCESSING' &&
                !hasWorkerFinalization(exact)
            ) {
                try {
                    const replayedJobId =
                        await input.replayAdmission();
                    if (
                        replayedJobId.toLowerCase() !==
                        exact.jobId.toLowerCase()
                    ) {
                        throw new ControlledRunnerError(
                            'ADMISSION_REPLAY_JOB_MISMATCH'
                        );
                    }
                } catch (error) {
                    if (!isAmbiguousAdmissionError(error)) {
                        throw error;
                    }
                    // replay response도 유실될 수 있으나 exact durable job은 이미
                    // 확인했으므로 해당 job의 immutable receipt까지 drain한다.
                }
            }
            return exact;
        }
    }
    // 최초 admission 실패의 서버 코드·status를 접미로 보존해 artifact만으로
    // 서버 측 5xx 원인을 특정할 수 있게 한다.
    const initiating = input.initiatingError;
    const initiatingSuffix =
        initiating instanceof ControlledApiError &&
        /^[A-Z0-9_]{1,60}$/.test(initiating.code)
            ? initiating.code === `HTTP_${initiating.status}`
                ? `_${initiating.code}`
                : `_${initiating.code}_${initiating.status}`
            : '';
    throw new ControlledRunnerError(
        `AMBIGUOUS_ADMISSION_NOT_DURABLE${initiatingSuffix}`.slice(
            0,
            100
        )
    );
}

async function pollTerminal(
    client: LandAreaSyncApiClient,
    unionId: string,
    jobId: string,
    initial: LandAreaSyncApiJob | null,
    input: {
        pollIntervalMs: number;
        jobTimeoutMs: number;
        sleep: (milliseconds: number) => Promise<void>;
        nowMs: () => number;
    }
): Promise<{
    job: LandAreaSyncApiJob;
    softDeadlineExceeded: boolean;
}> {
    let current = initial;
    const deadline = input.nowMs() + input.jobTimeoutMs;
    let softDeadlineExceeded = false;
    while (
        current === null ||
        current.status === 'PROCESSING' ||
        !hasWorkerFinalization(current)
    ) {
        if (input.nowMs() >= deadline) {
            // p-queue의 10분 제한은 worker 실행 상한이며 queue 대기 시간은 별도다.
            // deadline 이후에도 durable terminal을 확인할 때까지 drain하여 runner/SSH
            // 종료가 진행 중인 DB write와 operation lock을 분리하지 못하게 한다.
            softDeadlineExceeded = true;
        }
        await input.sleep(input.pollIntervalMs);
        try {
            current = await client.getJob(unionId, jobId);
        } catch {
            // 이미 admission된 job의 terminal을 모르는 상태에서 반환하면 orphan write가
            // 가능하다. API/DB가 복구될 때까지 lock 보유 프로세스가 fail-closed한다.
            current = null;
        }
        if (input.nowMs() >= deadline) {
            softDeadlineExceeded = true;
        }
    }
    return { job: current, softDeadlineExceeded };
}

function resultFromJob(
    pnu: string,
    admission: DevelopmentRunTargetResult['admission'],
    discoveryJobId: string | null,
    applyJobId: string | null,
    job: LandAreaSyncApiJob
): DevelopmentRunTargetResult {
    return {
        pnu,
        admission,
        discoveryJobId,
        applyJobId,
        writerJobId:
            job.landAreaSync?.outcome === 'NO_DATA'
                ? null
                : job.jobId,
        status: job.status === 'FAILED' ? 'FAILED' : 'COMPLETED',
        strategy:
            job.landAreaSync?.outcome === 'NO_DATA'
                ? null
                : job.landAreaSync?.branch ?? null,
        scopeState: job.landAreaSync?.scopeState ?? null,
        outcome: job.landAreaSync?.outcome ?? null,
        updatedPropertyUnits:
            job.landAreaSync?.counts?.updatedPropertyUnits ?? 0,
        unchangedPropertyUnits:
            job.landAreaSync?.counts?.unchangedPropertyUnits ?? 0,
        issueCodes: issueCodes(job),
    };
}

function assertAppliedTerminal(job: LandAreaSyncApiJob): void {
    if (
        job.status !== 'COMPLETED' ||
        !hasWorkerFinalization(job) ||
        job.landAreaSync?.outcome !== 'APPLIED' ||
        job.landAreaSync.scopeState === 'REVIEW_REQUIRED' ||
        job.landAreaSync.scopeState === 'FAILED' ||
        hasBlockingIssue(job)
    ) {
        throw new ControlledRunnerError('APPLY_TERMINAL_NOT_PASS');
    }
    assertCompleteTerminalIssues(
        job,
        'APPLY_TERMINAL_ISSUES_INCOMPLETE'
    );
    if (
        (job.landAreaSync?.issues?.length ?? -1) !== 0 ||
        job.landAreaSync?.issuesTotal !== 0
    ) {
        throw new ControlledRunnerError(
            'APPLY_TERMINAL_NOT_PASS'
        );
    }
}

function assertCompleteTerminalIssues(
    job: LandAreaSyncApiJob,
    failureCode: string
): void {
    const issues = job.landAreaSync?.issues;
    const issuesTotal = job.landAreaSync?.issuesTotal;
    const issuesTruncated = job.landAreaSync?.issuesTruncated;
    if (
        !Array.isArray(issues) ||
        issues.length > 200 ||
        !Number.isSafeInteger(issuesTotal) ||
        (issuesTotal as number) < issues.length ||
        typeof issuesTruncated !== 'boolean' ||
        issuesTruncated !== ((issuesTotal as number) > issues.length) ||
        !issues.every(
            (issue) =>
                issue !== null &&
                typeof issue === 'object' &&
                typeof issue.code === 'string' &&
                /^[A-Z0-9_]{1,100}$/.test(issue.code)
        )
    ) {
        throw new ControlledRunnerError(failureCode);
    }
    // 일반 terminal은 capped shape를 허용하지만 이 canary PASS는 전체 이슈를
    // 관측했을 때만 가능하다.
    if (issuesTruncated || issuesTotal !== issues.length) {
        throw new ControlledRunnerError(failureCode);
    }
}

function canonicalPropertyRows(
    rows: DevelopmentActivePropertyUnit[]
): DevelopmentActivePropertyUnit[] {
    return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

function digestJson(value: unknown): string {
    return createHash('sha256')
        .update(JSON.stringify(value), 'utf8')
        .digest('hex');
}

function canonicalInvariantJson(value: unknown): string {
    if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean'
    ) {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new ControlledRunnerError(
                'RELATION_GIS_INVARIANT_ROW_INVALID'
            );
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value
            .map((item) => canonicalInvariantJson(item))
            .join(',')}]`;
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .sort()
            .map((key) => {
                const item = record[key];
                if (item === undefined) {
                    throw new ControlledRunnerError(
                        'RELATION_GIS_INVARIANT_ROW_INVALID'
                    );
                }
                return `${JSON.stringify(
                    key
                )}:${canonicalInvariantJson(item)}`;
            })
            .join(',')}}`;
    }
    throw new ControlledRunnerError(
        'RELATION_GIS_INVARIANT_ROW_INVALID'
    );
}

async function readDevelopmentRelationGisInvariant(input: {
    reader: DevelopmentReadOnlyPreflightReader;
    target: DevelopmentTargetManifest;
    evidence: DevelopmentEvidenceManifest;
    phase: 'PRE' | 'POST';
}): Promise<DevelopmentRelationGisInvariantSnapshot> {
    const readRows = input.reader.readRelationGisInvariantRows;
    if (!readRows) {
        throw new ControlledRunnerError(
            `${input.phase}FLIGHT_RELATION_GIS_READER_MISSING`
        );
    }
    const scopePnus = developmentTargetAllowedScopePnus(
        input.target
    );
    const propertyUnitIds = [
        ...new Set(
            input.evidence.entries.flatMap(
                (entry) => entry.expectedPropertyUnitIds
            )
        ),
    ].sort();
    if (
        propertyUnitIds.length !==
        input.target.expectedPropertyUnitCount
    ) {
        throw new ControlledRunnerError(
            `${input.phase}FLIGHT_RELATION_GIS_SCOPE_INVALID`
        );
    }
    const rowsByTable = await readRows({
        unionId: input.target.unionId,
        scopePnus: [...scopePnus],
        propertyUnitIds,
    });
    if (
        rowsByTable === null ||
        typeof rowsByTable !== 'object' ||
        !hasExactKeys(
            rowsByTable as Record<string, unknown>,
            DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES
        )
    ) {
        throw new ControlledRunnerError(
            `${input.phase}FLIGHT_RELATION_GIS_SNAPSHOT_INVALID`
        );
    }
    const tables = {} as DevelopmentRelationGisInvariantSnapshot['tables'];
    for (const table of DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES) {
        const rows = rowsByTable[table];
        if (
            !Array.isArray(rows) ||
            rows.length > 10_000 ||
            rows.some(
                (row) =>
                    row === null ||
                    typeof row !== 'object' ||
                    Array.isArray(row)
            )
        ) {
            throw new ControlledRunnerError(
                `${input.phase}FLIGHT_RELATION_GIS_SNAPSHOT_INVALID`
            );
        }
        const canonicalRows = rows
            .map((row) => canonicalInvariantJson(row))
            .sort();
        tables[table] = {
            rowCount: rows.length,
            digest: createHash('sha256')
                .update(
                    canonicalInvariantJson({
                        table,
                        rows: canonicalRows,
                    }),
                    'utf8'
                )
                .digest('hex'),
        };
    }
    const aggregateDigest = digestJson(
        DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES.map(
            (table) => ({
                table,
                ...tables[table],
            })
        )
    );
    return {
        scopePnuCount: scopePnus.length,
        propertyUnitCount: propertyUnitIds.length,
        tables,
        aggregateDigest,
    };
}

export interface ObservedDevelopmentLandRight {
    key: string;
    propertyUnitId: string;
    targetPnu: string;
    lifecycleStatus: 'ACTIVE' | 'STALE_NOT_SEEN' | 'CLOSED';
    lastSeenSyncJobId: string;
    lastEvaluatedSyncJobId: string;
    canonical: string;
}

async function readDevelopmentLandRights(input: {
    reader: DevelopmentReadOnlyPreflightReader;
    target: DevelopmentTargetManifest;
    evidence: DevelopmentEvidenceManifest;
    phase: 'PRE' | 'POST';
}): Promise<{
    summary: DevelopmentLandRightSnapshot;
    rows: ObservedDevelopmentLandRight[];
}> {
    const readRows = input.reader.readPropertyUnitLandRights;
    if (!readRows) {
        throw new ControlledRunnerError(
            `${input.phase}FLIGHT_LAND_RIGHT_READER_MISSING`
        );
    }
    const rawRows = await readRows(input.target.unionId);
    if (!Array.isArray(rawRows) || rawRows.length > 10_000) {
        throw new ControlledRunnerError(
            `${input.phase}FLIGHT_LAND_RIGHT_SNAPSHOT_INVALID`
        );
    }
    const rows = rawRows.map((raw) => {
        if (
            raw === null ||
            typeof raw !== 'object' ||
            Array.isArray(raw)
        ) {
            throw new ControlledRunnerError(
                `${input.phase}FLIGHT_LAND_RIGHT_SNAPSHOT_INVALID`
            );
        }
        const unionId = raw.union_id;
        const propertyUnitId = raw.property_unit_id;
        const targetPnu = raw.target_pnu;
        const lifecycleStatus = raw.lifecycle_status;
        const lastSeenSyncJobId = raw.last_seen_sync_job_id;
        const lastEvaluatedSyncJobId =
            raw.last_evaluated_sync_job_id;
        if (
            unionId !== input.target.unionId ||
            typeof propertyUnitId !== 'string' ||
            !UUID_RE.test(propertyUnitId) ||
            typeof targetPnu !== 'string' ||
            !PNU_RE.test(targetPnu) ||
            (lifecycleStatus !== 'ACTIVE' &&
                lifecycleStatus !== 'STALE_NOT_SEEN' &&
                lifecycleStatus !== 'CLOSED') ||
            typeof lastSeenSyncJobId !== 'string' ||
            !UUID_RE.test(lastSeenSyncJobId) ||
            typeof lastEvaluatedSyncJobId !== 'string' ||
            !UUID_RE.test(lastEvaluatedSyncJobId)
        ) {
            throw new ControlledRunnerError(
                `${input.phase}FLIGHT_LAND_RIGHT_SNAPSHOT_INVALID`
            );
        }
        return {
            key: `${propertyUnitId.toLowerCase()}:${targetPnu}`,
            propertyUnitId: propertyUnitId.toLowerCase(),
            targetPnu,
            lifecycleStatus,
            lastSeenSyncJobId: lastSeenSyncJobId.toLowerCase(),
            lastEvaluatedSyncJobId:
                lastEvaluatedSyncJobId.toLowerCase(),
            canonical: canonicalInvariantJson(raw),
        } satisfies ObservedDevelopmentLandRight;
    });
    rows.sort((left, right) => left.key.localeCompare(right.key));
    if (new Set(rows.map((row) => row.key)).size !== rows.length) {
        throw new ControlledRunnerError(
            `${input.phase}FLIGHT_LAND_RIGHT_SNAPSHOT_INVALID`
        );
    }
    const targetPropertyUnitIds = new Set(
        input.evidence.entries.flatMap(
            (entry) => entry.expectedPropertyUnitIds
        )
    );
    const targetRows = rows.filter((row) =>
        targetPropertyUnitIds.has(row.propertyUnitId)
    );
    const nonTargetRows = rows.filter(
        (row) => !targetPropertyUnitIds.has(row.propertyUnitId)
    );
    return {
        summary: {
            rowCount: rows.length,
            targetRowCount: targetRows.length,
            activeTargetRowCount: targetRows.filter(
                (row) => row.lifecycleStatus === 'ACTIVE'
            ).length,
            allRowsDigest: digestJson(
                rows.map((row) => row.canonical)
            ),
            nonTargetRowsDigest: digestJson(
                nonTargetRows.map((row) => row.canonical)
            ),
        },
        rows,
    };
}

export function validateDevelopmentLandRightTransition(input: {
    preRows: ObservedDevelopmentLandRight[];
    postRows: ObservedDevelopmentLandRight[];
    evidence: DevelopmentEvidenceManifest;
    results: DevelopmentRunTargetResult[];
}): DevelopmentLandRightWriteAttribution {
    const preByKey = new Map(
        input.preRows.map((row) => [row.key, row])
    );
    const postByKey = new Map(
        input.postRows.map((row) => [row.key, row])
    );
    const evidenceByAnchor = new Map(
        input.evidence.entries.map((entry) => [
            entry.anchorPnu,
            entry,
        ])
    );
    const expectedByPropertyId = new Map<
        string,
        {
            strategy: LandAreaSyncStrategy;
            scannedPnus: Set<string>;
            writerJobId: string;
        }
    >();
    const verifiedNoDataPropertyIds = new Set<string>();
    for (const result of input.results) {
        const evidence = evidenceByAnchor.get(result.pnu);
        if (!evidence) {
            throw new ControlledRunnerError(
                'POSTFLIGHT_LAND_RIGHT_ATTRIBUTION_INVALID'
            );
        }
        if (isVerifiedNoDataEvidenceEntry(evidence)) {
            if (
                result.outcome !== 'NO_DATA' ||
                result.writerJobId !== null ||
                result.applyJobId !== null
            ) {
                throw new ControlledRunnerError(
                    'POSTFLIGHT_VERIFIED_NO_DATA_WRITER_DETECTED'
                );
            }
            evidence.expectedPropertyUnitIds.forEach((id) =>
                verifiedNoDataPropertyIds.add(id)
            );
            continue;
        }
        if (
            result.outcome !== 'APPLIED' ||
            result.writerJobId === null
        ) {
            throw new ControlledRunnerError(
                'POSTFLIGHT_LAND_RIGHT_ATTRIBUTION_INVALID'
            );
        }
        for (const propertyUnitId of evidence.expectedPropertyUnitIds) {
            expectedByPropertyId.set(propertyUnitId, {
                strategy: evidence.expectedStrategy,
                scannedPnus: new Set(
                    evidence.expectedScannedPnus
                ),
                writerJobId: result.writerJobId.toLowerCase(),
            });
        }
    }
    const preVerifiedRows = input.preRows
        .filter((row) =>
            verifiedNoDataPropertyIds.has(row.propertyUnitId)
        )
        .map((row) => row.canonical)
        .sort();
    const postVerifiedRows = input.postRows
        .filter((row) =>
            verifiedNoDataPropertyIds.has(row.propertyUnitId)
        )
        .map((row) => row.canonical)
        .sort();
    if (
        JSON.stringify(preVerifiedRows) !==
        JSON.stringify(postVerifiedRows)
    ) {
        throw new ControlledRunnerError(
            'POSTFLIGHT_VERIFIED_NO_DATA_LAND_RIGHT_CHANGED'
        );
    }
    const changedRows: ObservedDevelopmentLandRight[] = [];
    for (const [key, pre] of preByKey) {
        const post = postByKey.get(key);
        if (!post) {
            throw new ControlledRunnerError(
                'POSTFLIGHT_LAND_RIGHT_ROW_DELETED'
            );
        }
        if (pre.canonical !== post.canonical) {
            changedRows.push(post);
        }
    }
    for (const [key, post] of postByKey) {
        if (!preByKey.has(key)) changedRows.push(post);
    }
    for (const row of changedRows) {
        const expected = expectedByPropertyId.get(
            row.propertyUnitId
        );
        if (
            !expected ||
            expected.strategy !== 'LDAREG' ||
            !expected.scannedPnus.has(row.targetPnu) ||
            row.lastEvaluatedSyncJobId !==
                expected.writerJobId ||
            (row.lifecycleStatus === 'ACTIVE' &&
                row.lastSeenSyncJobId !==
                    expected.writerJobId)
        ) {
            throw new ControlledRunnerError(
                'POSTFLIGHT_LAND_RIGHT_ATTRIBUTION_INVALID'
            );
        }
    }
    const ldaregExpected = [
        ...expectedByPropertyId.entries(),
    ].filter(([, expected]) => expected.strategy === 'LDAREG');
    for (const [propertyUnitId, expected] of ldaregExpected) {
        const hasActiveWriterRow = input.postRows.some(
            (row) =>
                row.propertyUnitId === propertyUnitId &&
                row.lifecycleStatus === 'ACTIVE' &&
                expected.scannedPnus.has(row.targetPnu) &&
                row.lastSeenSyncJobId === expected.writerJobId &&
                row.lastEvaluatedSyncJobId ===
                    expected.writerJobId
        );
        if (!hasActiveWriterRow) {
            throw new ControlledRunnerError(
                'POSTFLIGHT_LAND_RIGHT_COVERAGE_MISMATCH'
            );
        }
    }
    const attributedPropertyUnitIds = [
        ...new Set(
            changedRows.map((row) => row.propertyUnitId)
        ),
    ].sort();
    const writerJobIds = [
        ...new Set(
            changedRows.map(
                (row) =>
                    expectedByPropertyId.get(row.propertyUnitId)!
                        .writerJobId
            )
        ),
    ].sort();
    if (
        attributedPropertyUnitIds.length !==
            ldaregExpected.length ||
        writerJobIds.length !==
            new Set(
                ldaregExpected.map(
                    ([, expected]) => expected.writerJobId
                )
            ).size
    ) {
        throw new ControlledRunnerError(
            'POSTFLIGHT_LAND_RIGHT_COVERAGE_MISMATCH'
        );
    }
    return {
        changedRowCount: changedRows.length,
        writerJobCount: writerJobIds.length,
        attributedPropertyUnitCount:
            attributedPropertyUnitIds.length,
        attributionDigest: digestJson(
            changedRows
                .map((row) => ({
                    key: row.key,
                    writerJobId:
                        expectedByPropertyId.get(
                            row.propertyUnitId
                        )!.writerJobId,
                    lifecycleStatus: row.lifecycleStatus,
                }))
                .sort((left, right) =>
                    left.key.localeCompare(right.key)
                )
        ),
    };
}

function isPositiveLandArea(value: string | null): boolean {
    return value !== null && assertPositiveDecimal(value);
}

function canonicalLandTuple(row: DevelopmentActivePropertyUnit) {
    return {
        id: row.id,
        pnu: row.pnu,
        landArea: row.landArea,
        landAreaSource: row.landAreaSource,
        landAreaSyncedAt: row.landAreaSyncedAt,
        landAreaSyncJobId: row.landAreaSyncJobId,
    };
}

async function readAndValidateDevelopmentSnapshot(input: {
    reader: DevelopmentReadOnlyPreflightReader;
    target: DevelopmentTargetManifest;
    evidence: DevelopmentEvidenceManifest;
    phase: 'PRE' | 'POST';
}): Promise<{
    summary: DevelopmentReadOnlySnapshot;
    rows: DevelopmentActivePropertyUnit[];
}> {
    const rows = canonicalPropertyRows(
        await input.reader.readActivePropertyUnits(input.target.unionId)
    );
    if (
        rows.length !== input.target.expectedUnionActivePropertyUnitCount ||
        rows.some(
            (row) =>
                !UUID_RE.test(row.id) ||
                !PNU_RE.test(row.pnu) ||
                (row.landArea !== null &&
                    !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(row.landArea)) ||
                !['LEGACY_UNKNOWN', 'MANUAL', 'LADFRL', 'LDAREG'].includes(
                    row.landAreaSource
                ) ||
                (row.landAreaSyncedAt !== null &&
                    !Number.isFinite(Date.parse(row.landAreaSyncedAt))) ||
                (row.landAreaSyncJobId !== null &&
                    !UUID_RE.test(row.landAreaSyncJobId)) ||
                (['LEGACY_UNKNOWN', 'MANUAL'].includes(row.landAreaSource) &&
                    (row.landAreaSyncedAt !== null ||
                        row.landAreaSyncJobId !== null)) ||
                (['LADFRL', 'LDAREG'].includes(row.landAreaSource) &&
                    (!isPositiveLandArea(row.landArea) ||
                        row.landAreaSyncedAt === null ||
                        row.landAreaSyncJobId === null))
        ) ||
        new Set(rows.map((row) => row.id)).size !== rows.length
    ) {
        throw new ControlledRunnerError(
            `${input.phase}FLIGHT_ACTIVE_PROPERTY_SET_INVALID`
        );
    }
    const activePnus = [
        ...new Set(rows.map((row) => row.pnu)),
    ].sort();
    const activePnuCount = activePnus.length;
    if (activePnuCount !== input.target.expectedUnionActivePnuCount) {
        throw new ControlledRunnerError(
            `${input.phase}FLIGHT_ACTIVE_PNU_COUNT_MISMATCH`
        );
    }
    const expectedActivePnus =
        developmentTargetExpectedActivePnus(input.target);
    if (
        expectedActivePnus !== null &&
        (JSON.stringify(activePnus) !==
            JSON.stringify(expectedActivePnus) ||
            (input.target.version ===
                DEVELOPMENT_TARGET_MANIFEST_VERSION_V3 &&
                computeDevelopmentActivePnuDigest(
                    input.target.databaseTarget,
                    input.target.unionId,
                    activePnus
                ) !==
                    input.target
                        .expectedUnionActivePnuDigest))
    ) {
        throw new ControlledRunnerError(
            `${input.phase}FLIGHT_ACTIVE_PNU_SET_MISMATCH`
        );
    }

    const evidenceByPnu = new Map(
        input.evidence.entries.map((entry) => [entry.anchorPnu, entry])
    );
    for (const pnu of developmentTargetExecutionAnchors(input.target)) {
        const entry = evidenceByPnu.get(pnu)!;
        const expectedIds = new Set(entry.expectedPropertyUnitIds);
        const expectedScannedPnus = new Set(
            entry.expectedScannedPnus
        );
        const scopedRows = rows.filter((row) =>
            expectedIds.has(row.id)
        );
        const scopedIds = scopedRows.map((row) => row.id).sort();
        if (
            JSON.stringify(scopedIds) !==
                JSON.stringify(entry.expectedPropertyUnitIds) ||
            scopedRows.some(
                (row) => !expectedScannedPnus.has(row.pnu)
            )
        ) {
            throw new ControlledRunnerError(
                `${input.phase}FLIGHT_TARGET_MEMBERSHIP_MISMATCH`
            );
        }
        if (input.phase === 'PRE') {
            for (const row of scopedRows) {
                const allowed = entry.allowedPrestates.some(
                    (prestate) =>
                        prestate.propertyUnitId === row.id &&
                        prestate.landArea === row.landArea &&
                        prestate.landAreaSource === row.landAreaSource
                );
                if (!allowed) {
                    throw new ControlledRunnerError(
                        'PREFLIGHT_TARGET_PRESTATE_MISMATCH'
                    );
                }
            }
        }
    }

    const identityRows = rows.map((row) => ({ id: row.id, pnu: row.pnu }));
    const tupleRows = rows.map(canonicalLandTuple);
    const targetPropertyUnitIds = new Set(
        input.evidence.entries.flatMap(
            (entry) => entry.expectedPropertyUnitIds
        )
    );
    const nonTargetTupleRows = tupleRows.filter(
        (row) => !targetPropertyUnitIds.has(row.id)
    );
    const summary: DevelopmentReadOnlySnapshot = {
        activePropertyUnitCount: rows.length,
        activePnuCount,
        positiveLandAreaCount: rows.filter((row) =>
            isPositiveLandArea(row.landArea)
        ).length,
        identityDigest: digestJson(identityRows),
        tupleDigest: digestJson(tupleRows),
        nonTargetTupleDigest: digestJson(nonTargetTupleRows),
    };
    return { summary, rows };
}

function assertExpectedPostflightTransition(input: {
    preRows: DevelopmentActivePropertyUnit[];
    postRows: DevelopmentActivePropertyUnit[];
    evidence: DevelopmentEvidenceManifest;
    results: DevelopmentRunTargetResult[];
}): void {
    const preById = new Map(input.preRows.map((row) => [row.id, row]));
    const evidenceByPropertyId = new Map<
        string,
        {
            entry: DevelopmentEvidenceEntry;
            expectedArea: string | null;
        }
    >();
    for (const entry of input.evidence.entries) {
        const expectedAreas = new Map(
            entry.expectedProposedLandAreas.map((area) => [
                area.propertyUnitId,
                area.landArea,
            ])
        );
        for (const propertyUnitId of entry.expectedPropertyUnitIds) {
            evidenceByPropertyId.set(propertyUnitId, {
                entry,
                expectedArea:
                    expectedAreas.get(propertyUnitId) ?? null,
            });
        }
    }
    const resultByPnu = new Map(
        input.results.map((result) => [result.pnu, result])
    );

    for (const post of input.postRows) {
        const pre = preById.get(post.id);
        if (!pre) {
            throw new ControlledRunnerError(
                'POSTFLIGHT_PROPERTY_IDENTITY_CHANGED'
            );
        }
        const expected = evidenceByPropertyId.get(post.id);
        if (!expected) {
            if (
                JSON.stringify(canonicalLandTuple(pre)) !==
                JSON.stringify(canonicalLandTuple(post))
            ) {
                throw new ControlledRunnerError(
                    'POSTFLIGHT_NON_TARGET_TUPLE_CHANGED'
                );
            }
            continue;
        }

        const result = resultByPnu.get(expected.entry.anchorPnu);
        if (!result) {
            if (
                JSON.stringify(canonicalLandTuple(pre)) !==
                JSON.stringify(canonicalLandTuple(post))
            ) {
                throw new ControlledRunnerError(
                    'POSTFLIGHT_UNFINALIZED_TARGET_TUPLE_CHANGED'
                );
            }
            continue;
        }
        if (isVerifiedNoDataEvidenceEntry(expected.entry)) {
            if (
                result.outcome !== 'NO_DATA' ||
                result.writerJobId !== null ||
                result.applyJobId !== null ||
                JSON.stringify(canonicalLandTuple(pre)) !==
                    JSON.stringify(canonicalLandTuple(post))
            ) {
                throw new ControlledRunnerError(
                    'POSTFLIGHT_VERIFIED_NO_DATA_TUPLE_CHANGED'
                );
            }
            continue;
        }
        if (
            expected.expectedArea === null ||
            result.writerJobId === null
        ) {
            throw new ControlledRunnerError(
                'POSTFLIGHT_TARGET_TUPLE_MISMATCH'
            );
        }
        if (result.admission === 'ALREADY_APPLIED') {
            if (
                JSON.stringify(canonicalLandTuple(pre)) !==
                    JSON.stringify(canonicalLandTuple(post)) ||
                post.landArea !== expected.expectedArea ||
                post.landAreaSource !== expected.entry.expectedStrategy ||
                post.landAreaSyncJobId !== result.writerJobId
            ) {
                throw new ControlledRunnerError(
                    'POSTFLIGHT_ALREADY_APPLIED_TUPLE_CHANGED'
                );
            }
            continue;
        }
        if (
            post.landArea !== expected.expectedArea ||
            post.landAreaSource !== expected.entry.expectedStrategy ||
            post.landAreaSyncJobId !== result.writerJobId ||
            post.landAreaSyncedAt === null ||
            !Number.isFinite(Date.parse(post.landAreaSyncedAt))
        ) {
            throw new ControlledRunnerError(
                'POSTFLIGHT_TARGET_TUPLE_MISMATCH'
            );
        }
    }
}

async function readAndValidateWriteAttribution(input: {
    reader: DevelopmentReadOnlyPreflightReader;
    target: DevelopmentTargetManifest;
    evidence: DevelopmentEvidenceManifest;
    results: DevelopmentRunTargetResult[];
}): Promise<DevelopmentWriteAttribution> {
    const writerJobIds = [
        ...new Set(
            input.results
                .filter(
                    (result) =>
                        result.outcome === 'APPLIED' &&
                        result.writerJobId !== null
                )
                .map((result) => result.writerJobId as string)
        ),
    ].sort();
    if (
        writerJobIds.length === 0 ||
        writerJobIds.some((jobId) => !UUID_RE.test(jobId))
    ) {
        throw new ControlledRunnerError(
            'POSTFLIGHT_WRITE_ATTRIBUTION_INVALID'
        );
    }
    const attributedRows = [
        ...(await input.reader.readPropertyUnitsBySyncJobIds(writerJobIds)),
    ].sort((left, right) => left.id.localeCompare(right.id));
    const expectedWriterByPropertyId = new Map<string, string>();
    const evidenceByPnu = new Map(
        input.evidence.entries.map((entry) => [entry.anchorPnu, entry])
    );
    for (const result of input.results) {
        const entry = evidenceByPnu.get(result.pnu);
        if (!entry) {
            throw new ControlledRunnerError(
                'POSTFLIGHT_WRITE_ATTRIBUTION_INVALID'
            );
        }
        if (isVerifiedNoDataEvidenceEntry(entry)) {
            if (
                result.outcome !== 'NO_DATA' ||
                result.writerJobId !== null
            ) {
                throw new ControlledRunnerError(
                    'POSTFLIGHT_VERIFIED_NO_DATA_WRITER_DETECTED'
                );
            }
            continue;
        }
        if (
            result.outcome !== 'APPLIED' ||
            result.writerJobId === null
        ) {
            throw new ControlledRunnerError(
                'POSTFLIGHT_WRITE_ATTRIBUTION_INVALID'
            );
        }
        for (const propertyUnitId of entry.expectedPropertyUnitIds) {
            expectedWriterByPropertyId.set(
                propertyUnitId,
                result.writerJobId
            );
        }
    }
    if (
        attributedRows.length !== expectedWriterByPropertyId.size ||
        new Set(attributedRows.map((row) => row.id)).size !==
            attributedRows.length ||
        attributedRows.some(
            (row) =>
                !UUID_RE.test(row.id) ||
                !UUID_RE.test(row.unionId) ||
                !UUID_RE.test(row.landAreaSyncJobId) ||
                row.unionId !== input.target.unionId ||
                expectedWriterByPropertyId.get(row.id) !==
                    row.landAreaSyncJobId
        )
    ) {
        throw new ControlledRunnerError(
            'POSTFLIGHT_CROSS_UNION_OR_SCOPE_WRITE_DETECTED'
        );
    }
    return {
        writerJobCount: writerJobIds.length,
        attributedPropertyUnitCount: attributedRows.length,
        attributionDigest: digestJson(
            attributedRows.map((row) => ({
                id: row.id,
                unionId: row.unionId,
                writerJobId: row.landAreaSyncJobId,
            }))
        ),
    };
}

export async function runDevelopmentLandAreaSync(input: {
    target: DevelopmentTargetManifest;
    dbApproval: DevelopmentDbApprovalManifest;
    evidence: DevelopmentEvidenceManifest;
    client: LandAreaSyncApiClient;
    preflightReader: DevelopmentReadOnlyPreflightReader;
    pollIntervalMs?: number;
    jobTimeoutMs?: number;
    admissionReconciliationAttempts?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => Date;
    createAdmissionKey?: () => string;
    anchorMaxAttempts?: number;
    onAnchorRetry?: (event: DevelopmentAnchorRetryEvent) => void;
}): Promise<DevelopmentRunArtifact> {
    validateDevelopmentRunnerManifests(
        input.target,
        input.dbApproval,
        input.evidence
    );
    const developmentFullRefresh =
        developmentFullRefreshMarkerForTarget(input.target);
    const pollIntervalMs = input.pollIntervalMs ?? 3_000;
    const jobTimeoutMs =
        input.jobTimeoutMs ?? DEVELOPMENT_JOB_POLL_SOFT_TIMEOUT_MS;
    const admissionReconciliationAttempts =
        input.admissionReconciliationAttempts ??
        DEVELOPMENT_ADMISSION_RECONCILIATION_ATTEMPTS;
    const anchorMaxAttempts =
        input.anchorMaxAttempts ?? DEVELOPMENT_ANCHOR_MAX_ATTEMPTS;
    if (
        !Number.isSafeInteger(pollIntervalMs) ||
        pollIntervalMs < 100 ||
        pollIntervalMs > 30_000 ||
        !Number.isSafeInteger(jobTimeoutMs) ||
        jobTimeoutMs < DEVELOPMENT_JOB_POLL_SOFT_TIMEOUT_MS ||
        jobTimeoutMs > 30 * 60_000 ||
        !Number.isSafeInteger(admissionReconciliationAttempts) ||
        admissionReconciliationAttempts < 1 ||
        admissionReconciliationAttempts > 100 ||
        !Number.isSafeInteger(anchorMaxAttempts) ||
        anchorMaxAttempts < 1 ||
        anchorMaxAttempts > 100
    ) {
        throw new ControlledRunnerError('POLL_CONFIGURATION_INVALID');
    }
    const sleep =
        input.sleep ??
        ((milliseconds: number) =>
            new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const now = input.now ?? (() => new Date());
    const createAdmissionKey = input.createAdmissionKey ?? randomUUID;
    const startedAt = now().toISOString();
    const startedAtMs = Date.parse(startedAt);
    const results: DevelopmentRunTargetResult[] = [];
    const observedPropertyUnitIds = new Set<string>();
    const evidenceByPnu = new Map(
        input.evidence.entries.map((entry) => [entry.anchorPnu, entry])
    );
    let failureCode: string | null = null;
    let stoppedBeforePnu: string | null = null;
    let preflight: DevelopmentReadOnlySnapshot | null = null;
    let postflight: DevelopmentReadOnlySnapshot | null = null;
    let relationGisPreflight:
        | DevelopmentRelationGisInvariantSnapshot
        | null = null;
    let relationGisPostflight:
        | DevelopmentRelationGisInvariantSnapshot
        | null = null;
    let landRightPreflight: DevelopmentLandRightSnapshot | null =
        null;
    let landRightPostflight: DevelopmentLandRightSnapshot | null =
        null;
    let landRightPreflightRows: ObservedDevelopmentLandRight[] =
        [];
    let landRightWriteAttribution:
        | DevelopmentLandRightWriteAttribution
        | null = null;
    let preflightRows: DevelopmentActivePropertyUnit[] = [];
    let writeAttribution: DevelopmentWriteAttribution | null = null;
    let safetyFailureCode: string | null = null;
    const recordSafetyFailure = (error: unknown): void => {
        if (safetyFailureCode !== null) return;
        safetyFailureCode =
            error instanceof ControlledRunnerError
                ? error.code
                : error instanceof Error &&
                    /^[A-Z0-9_]{1,100}$/.test(error.message)
                  ? error.message
                  : 'POSTFLIGHT_READ_FAILED';
    };
    try {
        const observedPreflight =
            await readAndValidateDevelopmentSnapshot({
                reader: input.preflightReader,
                target: input.target,
                evidence: input.evidence,
                phase: 'PRE',
            });
        preflight = observedPreflight.summary;
        preflightRows = observedPreflight.rows;
        if (developmentFullRefresh !== null) {
            relationGisPreflight =
                await readDevelopmentRelationGisInvariant({
                    reader: input.preflightReader,
                    target: input.target,
                    evidence: input.evidence,
                    phase: 'PRE',
                });
            const observedLandRights =
                await readDevelopmentLandRights({
                    reader: input.preflightReader,
                    target: input.target,
                    evidence: input.evidence,
                    phase: 'PRE',
                });
            landRightPreflight = observedLandRights.summary;
            landRightPreflightRows = observedLandRights.rows;
        }
    } catch (error) {
        // CLI reader의 invariant 실패는 SCREAMING_SNAKE 코드 메시지를 가진 일반
        // Error다. 코드를 보존해야 artifact만으로 실패 지점을 특정할 수 있다.
        failureCode =
            error instanceof ControlledRunnerError
                ? error.code
                : error instanceof Error &&
                    /^[A-Z0-9_]{1,100}$/.test(error.message)
                  ? error.message
                  : 'PREFLIGHT_READ_FAILED';
        stoppedBeforePnu =
            developmentTargetExecutionAnchors(input.target)[0] ?? null;
    }

    const executionAnchors =
        developmentTargetExecutionAnchors(input.target);
    for (const pnu of failureCode === null ? executionAnchors : []) {
        // capture 뒤 남은 approval write window와 guardian emergency budget을
        // 보존한다. 이미 시작한 anchor의 discovery/apply는 exact terminal까지 drain하지만
        // cutoff 뒤에는 다음 anchor를 새로 admission하지 않는다.
        if (
            developmentFullRefresh !== null &&
            now().getTime() - startedAtMs >=
                DEVELOPMENT_FULL_REFRESH_ADMISSION_CUTOFF_MS
        ) {
            failureCode =
                'FULL_REFRESH_ADMISSION_CUTOFF_REACHED';
            stoppedBeforePnu = pnu;
            break;
        }
        const evidence = evidenceByPnu.get(pnu)!;
        // 한 anchor 의 discovery→confirm→apply 한 사이클. 실패는 throw 로 올리고,
        // 아래 재시도 루프가 재시도 가능 여부와 시도 횟수를 판정한다.
        const attemptAnchor = async (): Promise<DevelopmentRunTargetResult> => {
            let admission: DevelopmentRunTargetResult['admission'] =
                'RESUMED_LATEST';
            // 전체 재조회는 이전 latest/APPLIED를 재사용하지 않는다. 매 실행마다 모든
            // 278 official component가 새 discovery를 통해 공식 API를 다시 조회해야 한다.
            let latest =
                developmentFullRefresh === null
                    ? await input.client.getLatest(
                          input.target.unionId,
                          pnu
                      )
                    : null;
            // terminal FAILED job은 재개할 수 없다. 직전 apply가 DB guard 등으로
            // 실패한 뒤 같은 manifest를 재실행하면 새 discovery로 현재 scope/evidence를
            // 다시 고정해야 하며, 실패 job을 poll해 즉시 중단해서는 안 된다.
            if (
                latest?.status === 'FAILED' ||
                latest?.landAreaSync?.scopeState === 'FAILED'
            ) {
                latest = null;
            }
            let discoveryJobId: string | null = null;
            let applyJobId: string | null = null;
            if (!latest) {
                admission = 'NEW_DISCOVERY';
                const discoveryAdmissionKey = createAdmissionKey();
                if (!UUID_RE.test(discoveryAdmissionKey)) {
                    throw new ControlledRunnerError(
                        'ADMISSION_KEY_INVALID'
                    );
                }
                try {
                    discoveryJobId =
                        await input.client.admitDiscovery(
                            input.target.unionId,
                            pnu,
                            discoveryAdmissionKey,
                            developmentFullRefresh ?? undefined
                        );
                } catch (error) {
                    if (!isAmbiguousAdmissionError(error)) {
                        throw error;
                    }
                    latest = await reconcileAmbiguousAdmission({
                        client: input.client,
                        unionId: input.target.unionId,
                        pnu,
                        admissionKey: discoveryAdmissionKey,
                        sourceDiscoveryJobId: null,
                        initiatingError: error,
                        pollIntervalMs,
                        maxAttempts: admissionReconciliationAttempts,
                        sleep,
                        replayAdmission: () =>
                            input.client.admitDiscovery(
                                input.target.unionId,
                                pnu,
                                discoveryAdmissionKey,
                                developmentFullRefresh ?? undefined
                            ),
                    });
                    discoveryJobId = latest.jobId;
                }
            } else if (
                latest.status === 'COMPLETED' &&
                hasWorkerFinalization(latest) &&
                latest.landAreaSync?.outcome === 'APPLIED'
            ) {
                admission = 'ALREADY_APPLIED';
            } else if (
                typeof latest.landAreaSync?.sourceDiscoveryJobId === 'string'
            ) {
                discoveryJobId =
                    latest.landAreaSync.sourceDiscoveryJobId;
                applyJobId = latest.jobId;
            } else {
                discoveryJobId = latest.jobId;
            }

            let polled = await pollTerminal(
                input.client,
                input.target.unionId,
                latest?.jobId ?? discoveryJobId!,
                latest,
                {
                    pollIntervalMs,
                    jobTimeoutMs,
                    sleep,
                    nowMs: () => now().getTime(),
                }
            );
            let terminal = polled.job;
            if (polled.softDeadlineExceeded) {
                throw new ControlledRunnerError(
                    'JOB_POLL_SOFT_TIMEOUT_AFTER_TERMINAL'
                );
            }

            if (
                terminal.status === 'FAILED' ||
                terminal.landAreaSync?.scopeState === 'FAILED'
            ) {
                throw new ControlledRunnerError(
                    'DISCOVERY_OR_APPLY_JOB_FAILED'
                );
            }
            if (isVerifiedNoDataEvidenceEntry(evidence)) {
                throw new ControlledRunnerError(
                    'VERIFIED_NO_DATA_EXECUTION_FORBIDDEN'
                );
            }
            if (
                terminal.landAreaSync?.scopeState ===
                    'SINGLE_SCOPE_CONFIRMATION_REQUIRED' ||
                terminal.landAreaSync?.scopeState ===
                    'MANUAL_OVERWRITE_CONFIRMATION_REQUIRED'
            ) {
                assertCompleteTerminalIssues(
                    terminal,
                    'DISCOVERY_TERMINAL_ISSUES_INCOMPLETE'
                );
                if (hasBlockingIssue(terminal)) {
                    throw new ControlledRunnerError(
                        'DISCOVERY_BLOCKING_ISSUE'
                    );
                }
                const snapshot = assertJobEvidenceMatches(
                    terminal,
                    evidence,
                    true,
                    developmentFullRefresh
                );
                discoveryJobId = terminal.jobId;
                const isManual =
                    terminal.landAreaSync.scopeState ===
                    'MANUAL_OVERWRITE_CONFIRMATION_REQUIRED';
                if (
                    isManual &&
                    !evidence.allowManualOverwrite
                ) {
                    throw new ControlledRunnerError(
                        'MANUAL_OVERWRITE_EVIDENCE_MISMATCH'
                    );
                }
                const ownership =
                    evidence.expectedStrategy === 'LADFRL'
                        ? evidence.landOwnershipEvidence!
                        : null;
                let reconciledApply: LandAreaSyncApiJob | null = null;
                const applyAdmissionKey = createAdmissionKey();
                if (!UUID_RE.test(applyAdmissionKey)) {
                    throw new ControlledRunnerError(
                        'ADMISSION_KEY_INVALID'
                    );
                }
                const confirmationBody: Parameters<
                    LandAreaSyncApiClient['confirmDiscovery']
                >[1] = {
                    unionId: input.target.unionId,
                    admissionKey: applyAdmissionKey,
                    expectedScopeHash: snapshot.scopeHash,
                    propertyUnitIds:
                        snapshot.candidatePropertyUnitIds,
                    parcelScopeConfirmed: true,
                    landOwnershipConfirmed:
                        evidence.expectedStrategy === 'LADFRL'
                            ? true
                            : null,
                    overwriteManualConfirmed: isManual,
                    parcelScopeEvidenceKind:
                        evidence.parcelScopeEvidence.kind,
                    parcelScopeEvidenceRef:
                        evidence.parcelScopeEvidence.ref,
                    landOwnershipEvidenceKind:
                        ownership?.kind ?? null,
                    landOwnershipEvidenceRef:
                        ownership?.ref ?? null,
                };
                try {
                    applyJobId =
                        await input.client.confirmDiscovery(
                            discoveryJobId,
                            confirmationBody
                        );
                } catch (error) {
                    if (!isAmbiguousAdmissionError(error)) {
                        throw error;
                    }
                    reconciledApply =
                        await reconcileAmbiguousAdmission({
                            client: input.client,
                            unionId: input.target.unionId,
                            pnu,
                            admissionKey: applyAdmissionKey,
                            sourceDiscoveryJobId: discoveryJobId,
                            initiatingError: error,
                            pollIntervalMs,
                            maxAttempts: admissionReconciliationAttempts,
                            sleep,
                            replayAdmission: () =>
                                input.client.confirmDiscovery(
                                    discoveryJobId!,
                                    confirmationBody
                                ),
                        });
                    applyJobId = reconciledApply.jobId;
                }
                polled = await pollTerminal(
                    input.client,
                    input.target.unionId,
                    applyJobId,
                    reconciledApply,
                    {
                        pollIntervalMs,
                        jobTimeoutMs,
                        sleep,
                        nowMs: () => now().getTime(),
                    }
                );
                terminal = polled.job;
                if (polled.softDeadlineExceeded) {
                    throw new ControlledRunnerError(
                        'JOB_POLL_SOFT_TIMEOUT_AFTER_TERMINAL'
                    );
                }
                // apply 가 FAILED 로 끝난 것은 원천/워커 실패다(scan 단계 provider
                // 오류 등). REVIEW_REQUIRED 와 구분되는 코드로 던져 재시도 대상이 된다.
                if (
                    terminal.status === 'FAILED' ||
                    terminal.landAreaSync?.scopeState === 'FAILED'
                ) {
                    throw new ControlledRunnerError('APPLY_JOB_FAILED');
                }
            }

            assertAppliedTerminal(terminal);
            assertJobEvidenceMatches(
                terminal,
                evidence,
                false,
                developmentFullRefresh
            );
            return resultFromJob(
                pnu,
                admission,
                discoveryJobId,
                applyJobId,
                terminal
            );
        };

        let attempt = 0;
        let anchorResult: DevelopmentRunTargetResult | null = null;
        while (anchorResult === null) {
            attempt += 1;
            try {
                anchorResult = await attemptAnchor();
            } catch (error) {
                const code =
                    error instanceof ControlledRunnerError
                        ? error.code
                        : 'UNEXPECTED_RUNNER_ERROR';
                if (
                    attempt < anchorMaxAttempts &&
                    isRetryableAnchorFailure(error)
                ) {
                    const nextDelayMs = Math.min(
                        DEVELOPMENT_ANCHOR_RETRY_BASE_DELAY_MS * attempt,
                        DEVELOPMENT_ANCHOR_RETRY_MAX_DELAY_MS
                    );
                    input.onAnchorRetry?.({
                        pnu,
                        attempt,
                        failureCode: code,
                        nextDelayMs,
                    });
                    await sleep(nextDelayMs);
                    // 재시도도 새 admission 이므로 full-refresh cutoff 를 다시 본다.
                    if (
                        developmentFullRefresh !== null &&
                        now().getTime() - startedAtMs >=
                            DEVELOPMENT_FULL_REFRESH_ADMISSION_CUTOFF_MS
                    ) {
                        failureCode =
                            'FULL_REFRESH_ADMISSION_CUTOFF_REACHED';
                        stoppedBeforePnu = pnu;
                        break;
                    }
                    continue;
                }
                // 최대 시도 소진 또는 재시도 불가 실패: 기존과 같이 러너를 멈춘다.
                failureCode = code;
                stoppedBeforePnu = pnu;
                break;
            }
        }
        if (anchorResult === null) {
            break;
        }
        for (const propertyUnitId of evidence.expectedPropertyUnitIds) {
            observedPropertyUnitIds.add(propertyUnitId);
        }
        results.push(anchorResult);
    }

    if (
        failureCode === null &&
        observedPropertyUnitIds.size !== input.target.expectedPropertyUnitCount
    ) {
        failureCode = 'OBSERVED_PROPERTY_UNIT_COUNT_MISMATCH';
    }
    if (
        failureCode === null &&
        results.length !== input.target.targetCount
    ) {
        failureCode = 'TARGET_RESULT_COUNT_MISMATCH';
    }
    if (preflight) {
        if (
            developmentFullRefresh !== null &&
            relationGisPreflight !== null
        ) {
            try {
                relationGisPostflight =
                    await readDevelopmentRelationGisInvariant({
                        reader: input.preflightReader,
                        target: input.target,
                        evidence: input.evidence,
                        phase: 'POST',
                    });
                if (
                    relationGisPreflight.aggregateDigest !==
                        relationGisPostflight.aggregateDigest ||
                    DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES.some(
                        (table) =>
                            relationGisPreflight!.tables[table]
                                .rowCount !==
                                relationGisPostflight!.tables[table]
                                    .rowCount ||
                            relationGisPreflight!.tables[table]
                                .digest !==
                                relationGisPostflight!.tables[table]
                                    .digest
                    )
                ) {
                    throw new ControlledRunnerError(
                        'POSTFLIGHT_RELATION_GIS_CHANGED'
                    );
                }
            } catch (error) {
                recordSafetyFailure(error);
            }
        }
        if (
            developmentFullRefresh !== null &&
            landRightPreflight !== null
        ) {
            try {
                const observedLandRights =
                    await readDevelopmentLandRights({
                        reader: input.preflightReader,
                        target: input.target,
                        evidence: input.evidence,
                        phase: 'POST',
                    });
                landRightPostflight =
                    observedLandRights.summary;
                if (
                    landRightPreflight.nonTargetRowsDigest !==
                    landRightPostflight.nonTargetRowsDigest
                ) {
                    throw new ControlledRunnerError(
                        'POSTFLIGHT_LAND_RIGHT_NON_TARGET_CHANGED'
                    );
                }
                landRightWriteAttribution =
                    validateDevelopmentLandRightTransition({
                        preRows: landRightPreflightRows,
                        postRows: observedLandRights.rows,
                        evidence: input.evidence,
                        results,
                    });
            } catch (error) {
                recordSafetyFailure(error);
            }
        }
        let observedPostflight:
            | Awaited<
                  ReturnType<
                      typeof readAndValidateDevelopmentSnapshot
                  >
              >
            | null = null;
        try {
            observedPostflight =
                await readAndValidateDevelopmentSnapshot({
                    reader: input.preflightReader,
                    target: input.target,
                    evidence: input.evidence,
                    phase: 'POST',
                });
            postflight = observedPostflight.summary;
        } catch (error) {
            recordSafetyFailure(error);
        }
        if (observedPostflight) {
            try {
                if (
                    preflight.identityDigest !==
                    observedPostflight.summary.identityDigest
                ) {
                    throw new ControlledRunnerError(
                        'POSTFLIGHT_PROPERTY_IDENTITY_CHANGED'
                    );
                }
            } catch (error) {
                recordSafetyFailure(error);
            }
            try {
                if (
                    preflight.nonTargetTupleDigest !==
                    observedPostflight.summary.nonTargetTupleDigest
                ) {
                    throw new ControlledRunnerError(
                        'POSTFLIGHT_NON_TARGET_TUPLE_CHANGED'
                    );
                }
            } catch (error) {
                recordSafetyFailure(error);
            }
            try {
                assertExpectedPostflightTransition({
                    preRows: preflightRows,
                    postRows: observedPostflight.rows,
                    evidence: input.evidence,
                    results,
                });
            } catch (error) {
                recordSafetyFailure(error);
            }
        }
        if (results.length > 0) {
            try {
                writeAttribution =
                    await readAndValidateWriteAttribution({
                        reader: input.preflightReader,
                        target: input.target,
                        evidence: input.evidence,
                        results,
                    });
            } catch (error) {
                recordSafetyFailure(error);
            }
        }
    }
    const finalFailureCode = safetyFailureCode ?? failureCode;

    return {
        version: DEVELOPMENT_RUN_ARTIFACT_VERSION,
        databaseTarget: input.target.databaseTarget,
        unionId: input.target.unionId,
        targetCount: input.target.targetCount,
        manifestDigest: input.target.manifestDigest,
        expectedPropertyUnitCount: input.target.expectedPropertyUnitCount,
        observedPropertyUnitCount: observedPropertyUnitIds.size,
        startedAt,
        completedAt: now().toISOString(),
        preflight,
        postflight,
        relationGisPreflight,
        relationGisPostflight,
        landRightPreflight,
        landRightPostflight,
        landRightWriteAttribution,
        writeAttribution,
        results,
        gate: {
            status: finalFailureCode === null ? 'PASS' : 'FAIL',
            failureCode: finalFailureCode,
            stoppedBeforePnu,
        },
    };
}

export function controlledFailureCode(error: unknown): string {
    return error instanceof ControlledRunnerError
        ? error.code
        : 'UNEXPECTED_RUNNER_ERROR';
}

export function validateDevelopmentRunArtifact(
    input: unknown,
    target: DevelopmentTargetManifest
): DevelopmentRunArtifact {
    const value = asRecord(input, 'RUN_ARTIFACT_INVALID');
    const gate = asRecord(value.gate, 'RUN_ARTIFACT_INVALID');
    if (
        !hasExactKeys(value, [
            'version',
            'databaseTarget',
            'unionId',
            'targetCount',
            'manifestDigest',
            'expectedPropertyUnitCount',
            'observedPropertyUnitCount',
            'startedAt',
            'completedAt',
            'preflight',
            'postflight',
            'relationGisPreflight',
            'relationGisPostflight',
            'landRightPreflight',
            'landRightPostflight',
            'landRightWriteAttribution',
            'writeAttribution',
            'results',
            'gate',
        ]) ||
        value.version !== DEVELOPMENT_RUN_ARTIFACT_VERSION ||
        value.databaseTarget !== target.databaseTarget ||
        value.unionId !== target.unionId ||
        value.targetCount !== target.targetCount ||
        value.manifestDigest !== target.manifestDigest ||
        value.expectedPropertyUnitCount !== target.expectedPropertyUnitCount ||
        !Number.isSafeInteger(value.observedPropertyUnitCount) ||
        (value.observedPropertyUnitCount as number) < 0 ||
        (value.observedPropertyUnitCount as number) >
            target.expectedPropertyUnitCount ||
        typeof value.startedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.startedAt)) ||
        typeof value.completedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.completedAt)) ||
        Date.parse(value.completedAt) < Date.parse(value.startedAt) ||
        !Array.isArray(value.results) ||
        !hasExactKeys(gate, [
            'status',
            'failureCode',
            'stoppedBeforePnu',
        ]) ||
        (gate.status !== 'PASS' && gate.status !== 'FAIL') ||
        (gate.failureCode !== null &&
            (typeof gate.failureCode !== 'string' ||
                !/^[A-Z0-9_]{1,100}$/.test(gate.failureCode))) ||
        (gate.stoppedBeforePnu !== null &&
            (typeof gate.stoppedBeforePnu !== 'string' ||
                !PNU_RE.test(gate.stoppedBeforePnu)))
    ) {
        throw new ControlledRunnerError('RUN_ARTIFACT_INVALID');
    }

    const parseSnapshot = (
        snapshotInput: unknown,
        required: boolean
    ): DevelopmentReadOnlySnapshot | null => {
        if (snapshotInput === null) {
            if (required) {
                throw new ControlledRunnerError('RUN_ARTIFACT_SNAPSHOT_INVALID');
            }
            return null;
        }
        const snapshot = asRecord(
            snapshotInput,
            'RUN_ARTIFACT_SNAPSHOT_INVALID'
        );
        if (
            !hasExactKeys(snapshot, [
                'activePropertyUnitCount',
                'activePnuCount',
                'positiveLandAreaCount',
                'identityDigest',
                'tupleDigest',
                'nonTargetTupleDigest',
            ]) ||
            snapshot.activePropertyUnitCount !==
                target.expectedUnionActivePropertyUnitCount ||
            snapshot.activePnuCount !== target.expectedUnionActivePnuCount ||
            !Number.isSafeInteger(snapshot.positiveLandAreaCount) ||
            (snapshot.positiveLandAreaCount as number) < 0 ||
            (snapshot.positiveLandAreaCount as number) >
                target.expectedUnionActivePropertyUnitCount ||
            typeof snapshot.identityDigest !== 'string' ||
            !HEX64_RE.test(snapshot.identityDigest) ||
            typeof snapshot.tupleDigest !== 'string' ||
            !HEX64_RE.test(snapshot.tupleDigest) ||
            typeof snapshot.nonTargetTupleDigest !== 'string' ||
            !HEX64_RE.test(snapshot.nonTargetTupleDigest)
        ) {
            throw new ControlledRunnerError('RUN_ARTIFACT_SNAPSHOT_INVALID');
        }
        return snapshot as unknown as DevelopmentReadOnlySnapshot;
    };
    const preflight = parseSnapshot(value.preflight, gate.status === 'PASS');
    const postflight = parseSnapshot(value.postflight, gate.status === 'PASS');
    const fullRefreshRequired =
        developmentFullRefreshMarkerForTarget(target) !== null;
    const parseRelationGisInvariant = (
        snapshotInput: unknown,
        required: boolean
    ): DevelopmentRelationGisInvariantSnapshot | null => {
        if (snapshotInput === null) {
            if (required) {
                throw new ControlledRunnerError(
                    'RUN_ARTIFACT_RELATION_GIS_INVALID'
                );
            }
            return null;
        }
        if (!fullRefreshRequired) {
            throw new ControlledRunnerError(
                'RUN_ARTIFACT_RELATION_GIS_INVALID'
            );
        }
        const snapshot = asRecord(
            snapshotInput,
            'RUN_ARTIFACT_RELATION_GIS_INVALID'
        );
        const tables = asRecord(
            snapshot.tables,
            'RUN_ARTIFACT_RELATION_GIS_INVALID'
        );
        if (
            !hasExactKeys(snapshot, [
                'scopePnuCount',
                'propertyUnitCount',
                'tables',
                'aggregateDigest',
            ]) ||
            snapshot.scopePnuCount !==
                developmentTargetAllowedScopePnus(target).length ||
            snapshot.propertyUnitCount !==
                target.expectedPropertyUnitCount ||
            typeof snapshot.aggregateDigest !== 'string' ||
            !HEX64_RE.test(snapshot.aggregateDigest) ||
            !hasExactKeys(
                tables,
                DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES
            )
        ) {
            throw new ControlledRunnerError(
                'RUN_ARTIFACT_RELATION_GIS_INVALID'
            );
        }
        for (const table of DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES) {
            const tableInvariant = asRecord(
                tables[table],
                'RUN_ARTIFACT_RELATION_GIS_INVALID'
            );
            if (
                !hasExactKeys(tableInvariant, [
                    'rowCount',
                    'digest',
                ]) ||
                !Number.isSafeInteger(tableInvariant.rowCount) ||
                (tableInvariant.rowCount as number) < 0 ||
                (tableInvariant.rowCount as number) > 10_000 ||
                typeof tableInvariant.digest !== 'string' ||
                !HEX64_RE.test(tableInvariant.digest)
            ) {
                throw new ControlledRunnerError(
                    'RUN_ARTIFACT_RELATION_GIS_INVALID'
                );
            }
        }
        const normalized =
            snapshot as unknown as DevelopmentRelationGisInvariantSnapshot;
        if (
            normalized.aggregateDigest !==
            digestJson(
                DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES.map(
                    (table) => ({
                        table,
                        ...normalized.tables[table],
                    })
                )
            )
        ) {
            throw new ControlledRunnerError(
                'RUN_ARTIFACT_RELATION_GIS_INVALID'
            );
        }
        return normalized;
    };
    const relationGisPreflight = parseRelationGisInvariant(
        value.relationGisPreflight,
        gate.status === 'PASS' && fullRefreshRequired
    );
    const relationGisPostflight = parseRelationGisInvariant(
        value.relationGisPostflight,
        gate.status === 'PASS' && fullRefreshRequired
    );
    const relationGisChanged =
        relationGisPreflight !== null &&
        relationGisPostflight !== null &&
        (relationGisPreflight.aggregateDigest !==
            relationGisPostflight.aggregateDigest ||
            DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES.some(
                (table) =>
                    relationGisPreflight.tables[table].rowCount !==
                        relationGisPostflight.tables[table].rowCount ||
                    relationGisPreflight.tables[table].digest !==
                        relationGisPostflight.tables[table].digest
            ));
    if (
        relationGisChanged &&
        (gate.status !== 'FAIL' ||
            gate.failureCode !==
                'POSTFLIGHT_RELATION_GIS_CHANGED')
    ) {
        throw new ControlledRunnerError(
            'RUN_ARTIFACT_RELATION_GIS_CHANGED'
        );
    }
    const parseLandRightSnapshot = (
        snapshotInput: unknown,
        required: boolean
    ): DevelopmentLandRightSnapshot | null => {
        if (snapshotInput === null) {
            if (required) {
                throw new ControlledRunnerError(
                    'RUN_ARTIFACT_LAND_RIGHT_INVALID'
                );
            }
            return null;
        }
        if (!fullRefreshRequired) {
            throw new ControlledRunnerError(
                'RUN_ARTIFACT_LAND_RIGHT_INVALID'
            );
        }
        const snapshot = asRecord(
            snapshotInput,
            'RUN_ARTIFACT_LAND_RIGHT_INVALID'
        );
        if (
            !hasExactKeys(snapshot, [
                'rowCount',
                'targetRowCount',
                'activeTargetRowCount',
                'allRowsDigest',
                'nonTargetRowsDigest',
            ]) ||
            !Number.isSafeInteger(snapshot.rowCount) ||
            (snapshot.rowCount as number) < 0 ||
            (snapshot.rowCount as number) > 10_000 ||
            !Number.isSafeInteger(snapshot.targetRowCount) ||
            (snapshot.targetRowCount as number) < 0 ||
            (snapshot.targetRowCount as number) >
                (snapshot.rowCount as number) ||
            !Number.isSafeInteger(snapshot.activeTargetRowCount) ||
            (snapshot.activeTargetRowCount as number) < 0 ||
            (snapshot.activeTargetRowCount as number) >
                (snapshot.targetRowCount as number) ||
            typeof snapshot.allRowsDigest !== 'string' ||
            !HEX64_RE.test(snapshot.allRowsDigest) ||
            typeof snapshot.nonTargetRowsDigest !== 'string' ||
            !HEX64_RE.test(snapshot.nonTargetRowsDigest)
        ) {
            throw new ControlledRunnerError(
                'RUN_ARTIFACT_LAND_RIGHT_INVALID'
            );
        }
        return snapshot as unknown as DevelopmentLandRightSnapshot;
    };
    const landRightPreflight = parseLandRightSnapshot(
        value.landRightPreflight,
        gate.status === 'PASS' && fullRefreshRequired
    );
    const landRightPostflight = parseLandRightSnapshot(
        value.landRightPostflight,
        gate.status === 'PASS' && fullRefreshRequired
    );
    let landRightWriteAttribution:
        | DevelopmentLandRightWriteAttribution
        | null = null;
    if (value.landRightWriteAttribution !== null) {
        if (!fullRefreshRequired) {
            throw new ControlledRunnerError(
                'RUN_ARTIFACT_LAND_RIGHT_INVALID'
            );
        }
        const attribution = asRecord(
            value.landRightWriteAttribution,
            'RUN_ARTIFACT_LAND_RIGHT_INVALID'
        );
        if (
            !hasExactKeys(attribution, [
                'changedRowCount',
                'writerJobCount',
                'attributedPropertyUnitCount',
                'attributionDigest',
            ]) ||
            !Number.isSafeInteger(attribution.changedRowCount) ||
            (attribution.changedRowCount as number) < 0 ||
            (attribution.changedRowCount as number) > 10_000 ||
            !Number.isSafeInteger(attribution.writerJobCount) ||
            (attribution.writerJobCount as number) < 0 ||
            (attribution.writerJobCount as number) >
                target.targetCount ||
            !Number.isSafeInteger(
                attribution.attributedPropertyUnitCount
            ) ||
            (attribution.attributedPropertyUnitCount as number) <
                0 ||
            (attribution.attributedPropertyUnitCount as number) >
                target.expectedPropertyUnitCount ||
            typeof attribution.attributionDigest !== 'string' ||
            !HEX64_RE.test(attribution.attributionDigest)
        ) {
            throw new ControlledRunnerError(
                'RUN_ARTIFACT_LAND_RIGHT_INVALID'
            );
        }
        landRightWriteAttribution =
            attribution as unknown as DevelopmentLandRightWriteAttribution;
    }
    if (
        landRightPreflight !== null &&
        landRightPostflight !== null &&
        landRightPreflight.nonTargetRowsDigest !==
            landRightPostflight.nonTargetRowsDigest &&
        (gate.status !== 'FAIL' ||
            !String(gate.failureCode).startsWith(
                'POSTFLIGHT_LAND_RIGHT_'
            ))
    ) {
        throw new ControlledRunnerError(
            'RUN_ARTIFACT_LAND_RIGHT_NON_TARGET_CHANGED'
        );
    }
    const identityChanged =
        preflight !== null &&
        postflight !== null &&
        preflight.identityDigest !== postflight.identityDigest;
    if (
        identityChanged &&
        (gate.status !== 'FAIL' ||
            gate.failureCode !==
                'POSTFLIGHT_PROPERTY_IDENTITY_CHANGED')
    ) {
        throw new ControlledRunnerError('RUN_ARTIFACT_IDENTITY_CHANGED');
    }
    const nonTargetTupleChanged =
        preflight !== null &&
        postflight !== null &&
        preflight.nonTargetTupleDigest !==
            postflight.nonTargetTupleDigest;
    if (
        nonTargetTupleChanged &&
        (gate.status !== 'FAIL' ||
            ![
                'POSTFLIGHT_PROPERTY_IDENTITY_CHANGED',
                'POSTFLIGHT_NON_TARGET_TUPLE_CHANGED',
            ].includes(gate.failureCode as string))
    ) {
        throw new ControlledRunnerError(
            'RUN_ARTIFACT_NON_TARGET_TUPLE_CHANGED'
        );
    }

    let writeAttribution: DevelopmentWriteAttribution | null = null;
    if (value.writeAttribution !== null) {
        const attribution = asRecord(
            value.writeAttribution,
            'RUN_ARTIFACT_WRITE_ATTRIBUTION_INVALID'
        );
        if (
            !hasExactKeys(attribution, [
                'writerJobCount',
                'attributedPropertyUnitCount',
                'attributionDigest',
            ]) ||
            !Number.isSafeInteger(attribution.writerJobCount) ||
            (attribution.writerJobCount as number) < 1 ||
            (attribution.writerJobCount as number) > target.targetCount ||
            !Number.isSafeInteger(
                attribution.attributedPropertyUnitCount
            ) ||
            (attribution.attributedPropertyUnitCount as number) < 1 ||
            (attribution.attributedPropertyUnitCount as number) >
                target.expectedPropertyUnitCount ||
            (attribution.writerJobCount as number) >
                (attribution.attributedPropertyUnitCount as number) ||
            typeof attribution.attributionDigest !== 'string' ||
            !HEX64_RE.test(attribution.attributionDigest)
        ) {
            throw new ControlledRunnerError(
                'RUN_ARTIFACT_WRITE_ATTRIBUTION_INVALID'
            );
        }
        writeAttribution =
            attribution as unknown as DevelopmentWriteAttribution;
    }

    const executionAnchors =
        developmentTargetExecutionAnchors(target);
    const results = value.results.map((item) => {
        const result = asRecord(item, 'RUN_ARTIFACT_INVALID');
        if (
            !hasExactKeys(result, [
                'pnu',
                'admission',
                'discoveryJobId',
                'applyJobId',
                'writerJobId',
                'status',
                'strategy',
                'scopeState',
                'outcome',
                'updatedPropertyUnits',
                'unchangedPropertyUnits',
                'issueCodes',
            ]) ||
            typeof result.pnu !== 'string' ||
            !PNU_RE.test(result.pnu) ||
            !executionAnchors.includes(result.pnu) ||
            !['NEW_DISCOVERY', 'RESUMED_LATEST', 'ALREADY_APPLIED'].includes(
                result.admission as string
            ) ||
            (result.discoveryJobId !== null &&
                (typeof result.discoveryJobId !== 'string' ||
                    !UUID_RE.test(result.discoveryJobId))) ||
            (result.applyJobId !== null &&
                (typeof result.applyJobId !== 'string' ||
                    !UUID_RE.test(result.applyJobId))) ||
            (result.writerJobId !== null &&
                (typeof result.writerJobId !== 'string' ||
                    !UUID_RE.test(result.writerJobId))) ||
            (result.status !== 'COMPLETED' && result.status !== 'FAILED') ||
            (result.strategy !== null &&
                result.strategy !== 'LADFRL' &&
                result.strategy !== 'LDAREG') ||
            (result.scopeState !== null &&
                ![
                    'SINGLE_SCOPE_CONFIRMATION_REQUIRED',
                    'SINGLE_PNU_CONFIRMED',
                    'LINKED_SCOPE_RESOLVED',
                    'MANUAL_OVERWRITE_CONFIRMATION_REQUIRED',
                    'REVIEW_REQUIRED',
                    'FAILED',
                ].includes(result.scopeState as string)) ||
            (result.outcome !== null &&
                ![
                    'APPLIED',
                    'PARTIAL',
                    'NO_DATA',
                    'REVIEW_REQUIRED',
                    'FAILED',
                ].includes(result.outcome as string)) ||
            !Number.isSafeInteger(result.updatedPropertyUnits) ||
            (result.updatedPropertyUnits as number) < 0 ||
            !Number.isSafeInteger(result.unchangedPropertyUnits) ||
            (result.unchangedPropertyUnits as number) < 0 ||
            !Array.isArray(result.issueCodes) ||
            !result.issueCodes.every(
                (code) =>
                    typeof code === 'string' &&
                    /^[A-Z0-9_]{1,100}$/.test(code)
            ) ||
            !isSortedUnique(result.issueCodes as string[])
        ) {
            throw new ControlledRunnerError('RUN_ARTIFACT_INVALID');
        }
        if (
            result.outcome === 'NO_DATA' ||
            result.writerJobId === null
        ) {
            throw new ControlledRunnerError(
                'RUN_ARTIFACT_RESULT_WRITER_INVALID'
            );
        }
        return result as unknown as DevelopmentRunTargetResult;
    });

    if (
        new Set(results.map((result) => result.pnu)).size !== results.length ||
        JSON.stringify(results.map((result) => result.pnu)) !==
            JSON.stringify(executionAnchors.slice(0, results.length))
    ) {
        throw new ControlledRunnerError('RUN_ARTIFACT_TARGET_ORDER_INVALID');
    }
    if (landRightWriteAttribution) {
        const ldaregResults = results.filter(
            (result) =>
                result.strategy === 'LDAREG' &&
                result.outcome === 'APPLIED' &&
                result.writerJobId !== null
        );
        const ldaregWriterJobIds = new Set(
            ldaregResults.map((result) => result.writerJobId)
        );
        const expectedLdaregPropertyUnitCount =
            ldaregResults.reduce(
                (sum, result) =>
                    sum +
                    result.updatedPropertyUnits +
                    result.unchangedPropertyUnits,
                0
            );
        const hasLdaregResults = ldaregWriterJobIds.size > 0;
        if (
            (hasLdaregResults &&
                (landRightWriteAttribution.writerJobCount !==
                    ldaregWriterJobIds.size ||
                    expectedLdaregPropertyUnitCount < 1 ||
                    landRightWriteAttribution
                        .attributedPropertyUnitCount !==
                        expectedLdaregPropertyUnitCount ||
                    landRightWriteAttribution.changedRowCount <
                        landRightWriteAttribution
                            .attributedPropertyUnitCount)) ||
            (!hasLdaregResults &&
                (landRightWriteAttribution.changedRowCount !== 0 ||
                    landRightWriteAttribution.writerJobCount !== 0 ||
                    landRightWriteAttribution
                        .attributedPropertyUnitCount !== 0))
        ) {
            throw new ControlledRunnerError(
                'RUN_ARTIFACT_LAND_RIGHT_ATTRIBUTION_INVALID'
            );
        }
    }
    const verifiedNoDataResults = results.filter(
        (result) => result.outcome === 'NO_DATA'
    );
    const projectableResults = results.filter(
        (result) => result.outcome === 'APPLIED'
    );
    const verifiedNoDataPropertyUnitCount =
        verifiedNoDataResults.reduce(
            (sum, result) =>
                sum +
                result.updatedPropertyUnits +
                result.unchangedPropertyUnits,
            0
        );
    const projectablePropertyUnitCount =
        projectableResults.reduce(
            (sum, result) =>
                sum +
                result.updatedPropertyUnits +
                result.unchangedPropertyUnits,
            0
        );
    if (
        writeAttribution &&
        (writeAttribution.writerJobCount > results.length ||
            writeAttribution.attributedPropertyUnitCount !==
                projectablePropertyUnitCount)
    ) {
        throw new ControlledRunnerError(
            'RUN_ARTIFACT_WRITE_ATTRIBUTION_INVALID'
        );
    }

    if (gate.status === 'PASS') {
        if (
            gate.failureCode !== null ||
            gate.stoppedBeforePnu !== null ||
            value.observedPropertyUnitCount !==
                target.expectedPropertyUnitCount ||
            results.length !== target.targetCount ||
            results.some(
                (result) =>
                    result.status !== 'COMPLETED' ||
                    result.outcome !== 'APPLIED'
            ) ||
            verifiedNoDataResults.length !== 0 ||
            verifiedNoDataPropertyUnitCount !== 0 ||
            projectableResults.length !== results.length ||
            projectablePropertyUnitCount !==
                target.expectedPropertyUnitCount ||
            !preflight ||
            !postflight ||
            (fullRefreshRequired &&
                (!relationGisPreflight ||
                    !relationGisPostflight ||
                    relationGisChanged ||
                    !landRightPreflight ||
                    !landRightPostflight ||
                    !landRightWriteAttribution)) ||
            !writeAttribution
        ) {
            throw new ControlledRunnerError('RUN_ARTIFACT_PASS_INVALID');
        }
    } else if (gate.failureCode === null) {
        throw new ControlledRunnerError('RUN_ARTIFACT_FAIL_INVALID');
    }

    return {
        version: DEVELOPMENT_RUN_ARTIFACT_VERSION,
        databaseTarget: target.databaseTarget,
        unionId: target.unionId,
        targetCount: target.targetCount,
        manifestDigest: target.manifestDigest,
        expectedPropertyUnitCount: target.expectedPropertyUnitCount,
        observedPropertyUnitCount: value.observedPropertyUnitCount as number,
        startedAt: value.startedAt,
        completedAt: value.completedAt,
        preflight,
        postflight,
        relationGisPreflight,
        relationGisPostflight,
        landRightPreflight,
        landRightPostflight,
        landRightWriteAttribution,
        writeAttribution,
        results,
        gate: {
            status: gate.status as 'PASS' | 'FAIL',
            failureCode: gate.failureCode as string | null,
            stoppedBeforePnu: gate.stoppedBeforePnu as string | null,
        },
    };
}

const PUBLIC_MANIFEST_LABEL_RE =
    /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

function countPublicAggregateValues<T extends string>(
    values: Array<T | null>,
    keys: readonly T[]
): Record<T | 'NONE', number> {
    const counts = Object.fromEntries([
        ...keys.map((key) => [key, 0]),
        ['NONE', 0],
    ]) as Record<T | 'NONE', number>;
    for (const value of values) {
        counts[value ?? 'NONE'] += 1;
    }
    return counts;
}

export function createDevelopmentPublicRunArtifact(
    artifact: DevelopmentRunArtifact,
    manifestLabel: string
): DevelopmentPublicRunArtifact {
    const strategyCounts = countPublicAggregateValues(
        artifact.results.map((result) => result.strategy),
        ['LADFRL', 'LDAREG'] as const
    );
    const outcomeCounts = countPublicAggregateValues(
        artifact.results.map((result) => result.outcome),
        [
            'APPLIED',
            'PARTIAL',
            'NO_DATA',
            'REVIEW_REQUIRED',
            'FAILED',
        ] as const
    );
    const projectableResults = artifact.results.filter(
        (result) => result.outcome === 'APPLIED'
    );
    const verifiedNoDataResults = artifact.results.filter(
        (result) => result.outcome === 'NO_DATA'
    );
    return validateDevelopmentPublicRunArtifact(
        {
            version: DEVELOPMENT_PUBLIC_RUN_ARTIFACT_VERSION,
            databaseTarget: artifact.databaseTarget,
            manifestLabel,
            aggregateCounts: {
                targetCount: artifact.targetCount,
                expectedPropertyUnitCount:
                    artifact.expectedPropertyUnitCount,
                observedPropertyUnitCount:
                    artifact.observedPropertyUnitCount,
                resultCount: artifact.results.length,
                preflightActivePropertyUnitCount:
                    artifact.preflight?.activePropertyUnitCount ?? null,
                preflightActivePnuCount:
                    artifact.preflight?.activePnuCount ?? null,
                preflightPositiveLandAreaCount:
                    artifact.preflight?.positiveLandAreaCount ?? null,
                postflightActivePropertyUnitCount:
                    artifact.postflight?.activePropertyUnitCount ?? null,
                postflightActivePnuCount:
                    artifact.postflight?.activePnuCount ?? null,
                postflightPositiveLandAreaCount:
                    artifact.postflight?.positiveLandAreaCount ?? null,
                writerJobCount:
                    artifact.writeAttribution?.writerJobCount ?? null,
                attributedPropertyUnitCount:
                    artifact.writeAttribution
                        ?.attributedPropertyUnitCount ?? null,
                projectableResultCount:
                    projectableResults.length,
                verifiedNoDataResultCount:
                    verifiedNoDataResults.length,
                projectablePropertyUnitCount:
                    projectableResults.reduce(
                        (sum, result) =>
                            sum +
                            result.updatedPropertyUnits +
                            result.unchangedPropertyUnits,
                        0
                    ),
                verifiedNoDataPropertyUnitCount:
                    verifiedNoDataResults.reduce(
                        (sum, result) =>
                            sum +
                            result.updatedPropertyUnits +
                            result.unchangedPropertyUnits,
                        0
                    ),
            },
            digests: {
                manifestDigest: artifact.manifestDigest,
                preflightIdentityDigest:
                    artifact.preflight?.identityDigest ?? null,
                preflightTupleDigest:
                    artifact.preflight?.tupleDigest ?? null,
                preflightNonTargetTupleDigest:
                    artifact.preflight?.nonTargetTupleDigest ?? null,
                postflightIdentityDigest:
                    artifact.postflight?.identityDigest ?? null,
                postflightTupleDigest:
                    artifact.postflight?.tupleDigest ?? null,
                postflightNonTargetTupleDigest:
                    artifact.postflight?.nonTargetTupleDigest ?? null,
                writeAttributionDigest:
                    artifact.writeAttribution?.attributionDigest ?? null,
            },
            relationGisInvariant: {
                preflight: artifact.relationGisPreflight,
                postflight: artifact.relationGisPostflight,
            },
            landRightTransition: {
                preflight: artifact.landRightPreflight,
                postflight: artifact.landRightPostflight,
                writeAttribution:
                    artifact.landRightWriteAttribution,
            },
            strategyCounts,
            outcomeCounts,
            gate: {
                status: artifact.gate.status,
                failureCode: artifact.gate.failureCode,
            },
        },
        manifestLabel,
        // 공개본은 run artifact 가 선언한 target 축으로 검증한다. 기본값
        // 'development' 에 맡기면 production run 은 항상 거부된다(미아7
        // run 31573519967 실패 원인).
        artifact.databaseTarget
    );
}

export function validateDevelopmentPublicRunArtifact(
    input: unknown,
    manifestLabel: string,
    expectedDatabaseTarget: LandAreaSyncRunnerDatabaseTarget = 'development'
): DevelopmentPublicRunArtifact {
    const value = asRecord(input, 'PUBLIC_RUN_ARTIFACT_INVALID');
    const aggregateCounts = asRecord(
        value.aggregateCounts,
        'PUBLIC_RUN_ARTIFACT_INVALID'
    );
    const digests = asRecord(
        value.digests,
        'PUBLIC_RUN_ARTIFACT_INVALID'
    );
    const strategyCounts = asRecord(
        value.strategyCounts,
        'PUBLIC_RUN_ARTIFACT_INVALID'
    );
    const outcomeCounts = asRecord(
        value.outcomeCounts,
        'PUBLIC_RUN_ARTIFACT_INVALID'
    );
    const relationGisInvariant = asRecord(
        value.relationGisInvariant,
        'PUBLIC_RUN_ARTIFACT_INVALID'
    );
    const landRightTransition = asRecord(
        value.landRightTransition,
        'PUBLIC_RUN_ARTIFACT_INVALID'
    );
    const gate = asRecord(value.gate, 'PUBLIC_RUN_ARTIFACT_INVALID');
    const aggregateKeys = [
        'targetCount',
        'expectedPropertyUnitCount',
        'observedPropertyUnitCount',
        'resultCount',
        'preflightActivePropertyUnitCount',
        'preflightActivePnuCount',
        'preflightPositiveLandAreaCount',
        'postflightActivePropertyUnitCount',
        'postflightActivePnuCount',
        'postflightPositiveLandAreaCount',
        'writerJobCount',
        'attributedPropertyUnitCount',
        'projectableResultCount',
        'verifiedNoDataResultCount',
        'projectablePropertyUnitCount',
        'verifiedNoDataPropertyUnitCount',
    ] as const;
    const nullableCountKeys = aggregateKeys.slice(4, 12);
    const digestKeys = [
        'manifestDigest',
        'preflightIdentityDigest',
        'preflightTupleDigest',
        'preflightNonTargetTupleDigest',
        'postflightIdentityDigest',
        'postflightTupleDigest',
        'postflightNonTargetTupleDigest',
        'writeAttributionDigest',
    ] as const;
    const strategyKeys = ['LADFRL', 'LDAREG', 'NONE'] as const;
    const outcomeKeys = [
        'APPLIED',
        'PARTIAL',
        'NO_DATA',
        'REVIEW_REQUIRED',
        'FAILED',
        'NONE',
    ] as const;
    const validNullableCount = (candidate: unknown): boolean =>
        candidate === null ||
        (Number.isSafeInteger(candidate) && (candidate as number) >= 0);
    const validNullableDigest = (candidate: unknown): boolean =>
        candidate === null ||
        (typeof candidate === 'string' && HEX64_RE.test(candidate));

    if (
        !PUBLIC_MANIFEST_LABEL_RE.test(manifestLabel) ||
        !hasExactKeys(value, [
            'version',
            'databaseTarget',
            'manifestLabel',
            'aggregateCounts',
            'digests',
            'relationGisInvariant',
            'landRightTransition',
            'strategyCounts',
            'outcomeCounts',
            'gate',
        ]) ||
        value.version !== DEVELOPMENT_PUBLIC_RUN_ARTIFACT_VERSION ||
        value.databaseTarget !== expectedDatabaseTarget ||
        value.manifestLabel !== manifestLabel ||
        !hasExactKeys(aggregateCounts, aggregateKeys) ||
        ![
            ...aggregateKeys.slice(0, 4),
            ...aggregateKeys.slice(12),
        ].every(
            (key) =>
                Number.isSafeInteger(aggregateCounts[key]) &&
                (aggregateCounts[key] as number) >= 0
        ) ||
        !nullableCountKeys.every((key) =>
            validNullableCount(aggregateCounts[key])
        ) ||
        !hasExactKeys(digests, digestKeys) ||
        typeof digests.manifestDigest !== 'string' ||
        !HEX64_RE.test(digests.manifestDigest) ||
        !digestKeys
            .slice(1)
            .every((key) => validNullableDigest(digests[key])) ||
        !hasExactKeys(strategyCounts, strategyKeys) ||
        !strategyKeys.every(
            (key) =>
                Number.isSafeInteger(strategyCounts[key]) &&
                (strategyCounts[key] as number) >= 0
        ) ||
        !hasExactKeys(outcomeCounts, outcomeKeys) ||
        !outcomeKeys.every(
            (key) =>
                Number.isSafeInteger(outcomeCounts[key]) &&
                (outcomeCounts[key] as number) >= 0
        ) ||
        strategyKeys.reduce(
            (sum, key) => sum + (strategyCounts[key] as number),
            0
        ) !== aggregateCounts.resultCount ||
        outcomeKeys.reduce(
            (sum, key) => sum + (outcomeCounts[key] as number),
            0
        ) !== aggregateCounts.resultCount ||
        !hasExactKeys(gate, ['status', 'failureCode']) ||
        (gate.status !== 'PASS' && gate.status !== 'FAIL') ||
        (gate.failureCode !== null &&
            (typeof gate.failureCode !== 'string' ||
                !/^[A-Z0-9_]{1,100}$/.test(gate.failureCode)))
    ) {
        throw new ControlledRunnerError('PUBLIC_RUN_ARTIFACT_INVALID');
    }
    const parsePublicRelationGisSnapshot = (
        snapshotInput: unknown
    ): DevelopmentRelationGisInvariantSnapshot | null => {
        if (snapshotInput === null) return null;
        const snapshot = asRecord(
            snapshotInput,
            'PUBLIC_RUN_ARTIFACT_INVALID'
        );
        const tables = asRecord(
            snapshot.tables,
            'PUBLIC_RUN_ARTIFACT_INVALID'
        );
        if (
            !hasExactKeys(snapshot, [
                'scopePnuCount',
                'propertyUnitCount',
                'tables',
                'aggregateDigest',
            ]) ||
            !Number.isSafeInteger(snapshot.scopePnuCount) ||
            (snapshot.scopePnuCount as number) < 1 ||
            !Number.isSafeInteger(snapshot.propertyUnitCount) ||
            (snapshot.propertyUnitCount as number) < 1 ||
            !hasExactKeys(
                tables,
                DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES
            ) ||
            typeof snapshot.aggregateDigest !== 'string' ||
            !HEX64_RE.test(snapshot.aggregateDigest)
        ) {
            throw new ControlledRunnerError(
                'PUBLIC_RUN_ARTIFACT_INVALID'
            );
        }
        for (const table of DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES) {
            const tableInvariant = asRecord(
                tables[table],
                'PUBLIC_RUN_ARTIFACT_INVALID'
            );
            if (
                !hasExactKeys(tableInvariant, [
                    'rowCount',
                    'digest',
                ]) ||
                !Number.isSafeInteger(tableInvariant.rowCount) ||
                (tableInvariant.rowCount as number) < 0 ||
                typeof tableInvariant.digest !== 'string' ||
                !HEX64_RE.test(tableInvariant.digest)
            ) {
                throw new ControlledRunnerError(
                    'PUBLIC_RUN_ARTIFACT_INVALID'
                );
            }
        }
        const normalized =
            snapshot as unknown as DevelopmentRelationGisInvariantSnapshot;
        if (
            normalized.aggregateDigest !==
            digestJson(
                DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES.map(
                    (table) => ({
                        table,
                        ...normalized.tables[table],
                    })
                )
            )
        ) {
            throw new ControlledRunnerError(
                'PUBLIC_RUN_ARTIFACT_INVALID'
            );
        }
        return normalized;
    };
    if (
        !hasExactKeys(relationGisInvariant, [
            'preflight',
            'postflight',
        ])
    ) {
        throw new ControlledRunnerError(
            'PUBLIC_RUN_ARTIFACT_INVALID'
        );
    }
    const publicRelationGisPreflight =
        parsePublicRelationGisSnapshot(
            relationGisInvariant.preflight
        );
    const publicRelationGisPostflight =
        parsePublicRelationGisSnapshot(
            relationGisInvariant.postflight
        );
    const publicRelationGisChanged =
        publicRelationGisPreflight !== null &&
        publicRelationGisPostflight !== null &&
        (publicRelationGisPreflight.aggregateDigest !==
            publicRelationGisPostflight.aggregateDigest ||
            DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES.some(
                (table) =>
                    publicRelationGisPreflight.tables[table]
                        .rowCount !==
                        publicRelationGisPostflight.tables[table]
                            .rowCount ||
                    publicRelationGisPreflight.tables[table]
                        .digest !==
                        publicRelationGisPostflight.tables[table]
                            .digest
            ));
    if (
        (publicRelationGisPreflight === null) !==
            (publicRelationGisPostflight === null) ||
        (publicRelationGisChanged &&
            (gate.status !== 'FAIL' ||
                gate.failureCode !==
                    'POSTFLIGHT_RELATION_GIS_CHANGED'))
    ) {
        throw new ControlledRunnerError(
            'PUBLIC_RUN_ARTIFACT_INVALID'
        );
    }
    const parsePublicLandRightSnapshot = (
        snapshotInput: unknown
    ): DevelopmentLandRightSnapshot | null => {
        if (snapshotInput === null) return null;
        const snapshot = asRecord(
            snapshotInput,
            'PUBLIC_RUN_ARTIFACT_INVALID'
        );
        if (
            !hasExactKeys(snapshot, [
                'rowCount',
                'targetRowCount',
                'activeTargetRowCount',
                'allRowsDigest',
                'nonTargetRowsDigest',
            ]) ||
            !Number.isSafeInteger(snapshot.rowCount) ||
            (snapshot.rowCount as number) < 0 ||
            !Number.isSafeInteger(snapshot.targetRowCount) ||
            (snapshot.targetRowCount as number) < 0 ||
            (snapshot.targetRowCount as number) >
                (snapshot.rowCount as number) ||
            !Number.isSafeInteger(snapshot.activeTargetRowCount) ||
            (snapshot.activeTargetRowCount as number) < 0 ||
            (snapshot.activeTargetRowCount as number) >
                (snapshot.targetRowCount as number) ||
            typeof snapshot.allRowsDigest !== 'string' ||
            !HEX64_RE.test(snapshot.allRowsDigest) ||
            typeof snapshot.nonTargetRowsDigest !== 'string' ||
            !HEX64_RE.test(snapshot.nonTargetRowsDigest)
        ) {
            throw new ControlledRunnerError(
                'PUBLIC_RUN_ARTIFACT_INVALID'
            );
        }
        return snapshot as unknown as DevelopmentLandRightSnapshot;
    };
    if (
        !hasExactKeys(landRightTransition, [
            'preflight',
            'postflight',
            'writeAttribution',
        ])
    ) {
        throw new ControlledRunnerError(
            'PUBLIC_RUN_ARTIFACT_INVALID'
        );
    }
    const publicLandRightPreflight =
        parsePublicLandRightSnapshot(
            landRightTransition.preflight
        );
    const publicLandRightPostflight =
        parsePublicLandRightSnapshot(
            landRightTransition.postflight
        );
    let publicLandRightAttribution:
        | DevelopmentLandRightWriteAttribution
        | null = null;
    if (landRightTransition.writeAttribution !== null) {
        const attribution = asRecord(
            landRightTransition.writeAttribution,
            'PUBLIC_RUN_ARTIFACT_INVALID'
        );
        if (
            !hasExactKeys(attribution, [
                'changedRowCount',
                'writerJobCount',
                'attributedPropertyUnitCount',
                'attributionDigest',
            ]) ||
            !Number.isSafeInteger(attribution.changedRowCount) ||
            (attribution.changedRowCount as number) < 0 ||
            !Number.isSafeInteger(attribution.writerJobCount) ||
            (attribution.writerJobCount as number) < 0 ||
            !Number.isSafeInteger(
                attribution.attributedPropertyUnitCount
            ) ||
            (attribution.attributedPropertyUnitCount as number) <
                0 ||
            typeof attribution.attributionDigest !== 'string' ||
            !HEX64_RE.test(attribution.attributionDigest)
        ) {
            throw new ControlledRunnerError(
                'PUBLIC_RUN_ARTIFACT_INVALID'
            );
        }
        publicLandRightAttribution =
            attribution as unknown as DevelopmentLandRightWriteAttribution;
    }
    const landRightFields = [
        publicLandRightPreflight,
        publicLandRightPostflight,
        publicLandRightAttribution,
    ];
    const publicLandRightNonTargetChanged =
        publicLandRightPreflight !== null &&
        publicLandRightPostflight !== null &&
        publicLandRightPreflight.nonTargetRowsDigest !==
            publicLandRightPostflight.nonTargetRowsDigest;
    if (
        (publicLandRightPreflight === null) !==
            (publicLandRightPostflight === null) ||
        (publicLandRightAttribution !== null &&
            (publicLandRightPreflight === null ||
                publicLandRightPostflight === null)) ||
        (publicLandRightNonTargetChanged &&
            (gate.status !== 'FAIL' ||
                !String(gate.failureCode).startsWith(
                    'POSTFLIGHT_LAND_RIGHT_'
                )))
    ) {
        throw new ControlledRunnerError(
            'PUBLIC_RUN_ARTIFACT_INVALID'
        );
    }
    if (
        publicLandRightAttribution !== null &&
        (((strategyCounts.LDAREG as number) > 0 &&
            (publicLandRightAttribution.writerJobCount !==
                (strategyCounts.LDAREG as number) ||
                publicLandRightAttribution
                    .attributedPropertyUnitCount < 1 ||
                publicLandRightAttribution.changedRowCount <
                    publicLandRightAttribution
                        .attributedPropertyUnitCount)) ||
            ((strategyCounts.LDAREG as number) === 0 &&
                (publicLandRightAttribution.changedRowCount !== 0 ||
                    publicLandRightAttribution.writerJobCount !== 0 ||
                    publicLandRightAttribution
                        .attributedPropertyUnitCount !== 0)))
    ) {
        throw new ControlledRunnerError(
            'PUBLIC_RUN_ARTIFACT_INVALID'
        );
    }
    const preflightFields = [
        aggregateCounts.preflightActivePropertyUnitCount,
        aggregateCounts.preflightActivePnuCount,
        aggregateCounts.preflightPositiveLandAreaCount,
        digests.preflightIdentityDigest,
        digests.preflightTupleDigest,
        digests.preflightNonTargetTupleDigest,
    ];
    const postflightFields = [
        aggregateCounts.postflightActivePropertyUnitCount,
        aggregateCounts.postflightActivePnuCount,
        aggregateCounts.postflightPositiveLandAreaCount,
        digests.postflightIdentityDigest,
        digests.postflightTupleDigest,
        digests.postflightNonTargetTupleDigest,
    ];
    const attributionFields = [
        aggregateCounts.writerJobCount,
        aggregateCounts.attributedPropertyUnitCount,
        digests.writeAttributionDigest,
    ];
    const allNullOrAllPresent = (fields: unknown[]): boolean =>
        fields.every((field) => field === null) ||
        fields.every((field) => field !== null);
    if (
        !allNullOrAllPresent(preflightFields) ||
        !allNullOrAllPresent(postflightFields) ||
        !allNullOrAllPresent(attributionFields) ||
        (aggregateCounts.resultCount as number) >
            (aggregateCounts.targetCount as number) ||
        (attributionFields.every((field) => field !== null) &&
            ((aggregateCounts.writerJobCount as number) >
                (aggregateCounts.projectableResultCount as number) ||
                aggregateCounts.attributedPropertyUnitCount !==
                    aggregateCounts.projectablePropertyUnitCount)) ||
        aggregateCounts.projectableResultCount !==
            aggregateCounts.resultCount ||
        aggregateCounts.projectablePropertyUnitCount !==
            aggregateCounts.observedPropertyUnitCount ||
        outcomeCounts.APPLIED !==
            aggregateCounts.projectableResultCount ||
        outcomeCounts.NO_DATA !==
            aggregateCounts.verifiedNoDataResultCount ||
        aggregateCounts.verifiedNoDataResultCount !== 0 ||
        aggregateCounts.verifiedNoDataPropertyUnitCount !== 0 ||
        (gate.status === 'PASS' &&
            (gate.failureCode !== null ||
                aggregateCounts.observedPropertyUnitCount !==
                    aggregateCounts.expectedPropertyUnitCount ||
                aggregateCounts.resultCount !==
                    aggregateCounts.targetCount ||
                outcomeKeys
                    .filter((key) => key !== 'APPLIED')
                    .some((key) => outcomeCounts[key] !== 0) ||
                preflightFields.some((field) => field === null) ||
                postflightFields.some((field) => field === null) ||
                attributionFields.some((field) => field === null) ||
                (manifestLabel ===
                    'mia-seven-full-278-official-components-api-readonly-20260729' &&
                    // 422 = 활성 429 중 3568 도로지분 7건 제외(공식 LDAREG 원천 부재, 2026-08-01 결정)
                    (aggregateCounts.targetCount !== 278 ||
                        aggregateCounts.expectedPropertyUnitCount !==
                            422 ||
                        digests.manifestDigest !==
                            MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_MANIFEST_DIGEST ||
                        publicRelationGisPreflight === null ||
                        publicRelationGisPostflight === null ||
                        publicRelationGisChanged ||
                        publicRelationGisPreflight.scopePnuCount !==
                            300 ||
                        publicRelationGisPreflight.propertyUnitCount !==
                            422 ||
                        publicRelationGisPostflight.scopePnuCount !==
                            300 ||
                        publicRelationGisPostflight.propertyUnitCount !==
                            422 ||
                        landRightFields.some(
                            (field) => field === null
                        ))))) ||
        (gate.status === 'FAIL' && gate.failureCode === null)
    ) {
        throw new ControlledRunnerError('PUBLIC_RUN_ARTIFACT_INVALID');
    }
    return value as unknown as DevelopmentPublicRunArtifact;
}
