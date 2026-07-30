import { createHash, randomUUID } from 'node:crypto';
import {
    DEVELOPMENT_EVIDENCE_MANIFEST_VERSION,
    DEVELOPMENT_EVIDENCE_MANIFEST_VERSION_V2,
    DEVELOPMENT_TARGET_MANIFEST_VERSION,
    DEVELOPMENT_TARGET_MANIFEST_VERSION_V3,
    computeDevelopmentActivePnuDigest,
    developmentFullRefreshMarkerForTarget,
    developmentTargetAllowedScopePnus,
    developmentTargetAllowsManualOverwrite,
    developmentTargetExecutionAnchors,
    developmentTargetExpectedActivePnus,
    type DevelopmentEvidenceEntry,
    type DevelopmentEvidenceManifest,
    type DevelopmentTargetManifest,
} from './development-land-area-sync-runner';
import {
    runLandAreaSyncJob,
    type LandAreaSyncDbDeps,
    type LandAreaSyncDeps,
    type LandAreaSyncScanDeps,
    type LandAreaSyncTerminalInput,
} from '../services/land-area-sync/service';
import type { LandAreaSyncJobRow } from '../services/land-area-sync/repository';
import type {
    LandAreaSyncDevelopmentFullRefresh,
    LandAreaSyncScopeSnapshot,
    LandAreaSyncStrategy,
} from '../types/land-area-sync-job.types';

export const DEVELOPMENT_EVIDENCE_CAPTURE_AUDIT_VERSION =
    'land-area-development-evidence-capture-audit@3' as const;

/** 최초 시도를 포함한 anchor 당 최대 시도 수. */
export const CAPTURE_MAX_ATTEMPTS = 3;
/** 재시도 라운드 사이 고정 지연. 외부 API 가 회복할 시간을 준다. */
export const CAPTURE_RETRY_DELAY_MS = 60_000;
/**
 * 재시도 대상이 targetCount 의 이 비율을 넘으면 API 장애로 보고 재시도를 생략한다.
 * 재시도해도 무용하고 capture 예산만 태우기 때문이다.
 */
export const RETRY_ELIGIBLE_MAX_RATIO = 0.25;

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNU_RE = /^[0-9]{19}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/;
const POSITIVE_DECIMAL_RE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const ALLOWED_LAND_AREA_SOURCES = new Set([
    'LEGACY_UNKNOWN',
    'MANUAL',
    'LADFRL',
    'LDAREG',
]);

export interface DevelopmentEvidenceCaptureReadOnlyDeps {
    scans: LandAreaSyncScanDeps;
    resolveScope: LandAreaSyncDbDeps['resolveScope'];
    readBuildingUnits: LandAreaSyncDbDeps['readBuildingUnits'];
    readPropertyUnits: LandAreaSyncDbDeps['readPropertyUnits'];
    readCurrentLandTuples: LandAreaSyncDbDeps['readCurrentLandTuples'];
    readActivePropertyIdentity(
        unionId: string
    ): Promise<Array<{ id: string; pnu: string }>>;
    now(): Date;
}

export interface DevelopmentEvidenceCaptureAuditEntry {
    anchorPnu: string;
    status: 'CAPTURED' | 'VERIFIED_NO_DATA' | 'FAILED';
    strategy: LandAreaSyncStrategy | null;
    scannedPnuCount: number;
    propertyUnitCount: number;
    snapshotReferenceSha256: string | null;
    applyRpcBlocked: boolean;
    failureCode: string | null;
    terminalScopeState: LandAreaSyncTerminalInput['scopeState'] | null;
    terminalOutcome: LandAreaSyncTerminalInput['outcome'] | null;
    terminalIssueCodes: string[];
    terminalIssuesTotal: number;
    terminalIssuesTruncated: boolean;
    scopeResolutionSource:
        | 'DB_RESOLVER'
        | 'SAME_RUN_OFFICIAL_READ_ONLY'
        | 'SAME_RUN_OFFICIAL_DEVELOPMENT_FULL_REFRESH'
        | 'SAME_RUN_OFFICIAL_DEVELOPMENT_PARCEL_SINGLETON'
        | 'VERIFIED_NO_DATA';
    /** 이 anchor 를 실행한 총 시도 수. 최초 시도가 1 이다. */
    attempts: number;
}

export interface DevelopmentEvidenceCaptureRedactedAggregate {
    CAPTURED: number;
    NO_DATA: number;
    REVIEW: number;
    FAILED: number;
}

export interface DevelopmentEvidenceCaptureRedactedIssueCount {
    code: string;
    count: number;
}

export interface DevelopmentEvidenceCaptureAudit {
    version: typeof DEVELOPMENT_EVIDENCE_CAPTURE_AUDIT_VERSION;
    databaseTarget: 'development';
    unionId: string;
    targetCount: number;
    expectedPropertyUnitCount: number;
    activePnuCount: number;
    activePnuDigest: string;
    initialActivePropertyIdentityDigest: string;
    finalActivePropertyIdentityDigest: string;
    activePropertyIdentityStable: boolean;
    resolvedComponentCount: number;
    scannedPnuCount: number;
    sameRunOfficialComponentCount: number;
    sameRunOfficialParcelCount: number;
    verifiedNoDataCount: number;
    manifestDigest: string;
    captureRunId: string;
    capturedAt: string;
    readOnlyGuards: {
        durableSyncJobWrites: 0;
        propertyUnitWriteRpcCalls: 0;
        interceptedApplyRpcCalls: number;
        interceptedSnapshotWrites: number;
        interceptedTerminalWrites: number;
        interceptedFailureWrites: number;
    };
    retry: {
        /** 실제 수행한 재시도 라운드 수. 0..CAPTURE_MAX_ATTEMPTS - 1 */
        rounds: number;
        /** 재시도를 1회 이상 받은 anchor 수 */
        retriedAnchorCount: number;
        /** 재시도로 FAILED 를 벗어난 anchor 수 */
        recoveredAnchorCount: number;
        skipped: 'NONE' | 'TOO_MANY_FAILURES';
    };
    entries: DevelopmentEvidenceCaptureAuditEntry[];
    /**
     * 공개 artifact에서 주소·PNU·물건지 ID 없이 결과 분포만 확인하기 위한 집계다.
     * 상세 entry와 gate는 그대로 유지하며 이 집계가 실패를 성공으로 바꾸지는 않는다.
     */
    redactedAggregate: DevelopmentEvidenceCaptureRedactedAggregate;
    redactedIssueCounts: DevelopmentEvidenceCaptureRedactedIssueCount[];
    capturedEvidence: DevelopmentEvidenceManifest | null;
    capturedEvidencePropertyUnitCount: number;
    capturedEvidenceManifestSha256: string | null;
    evidenceManifestSha256: string | null;
    gate: {
        status: 'PASS' | 'FAIL';
        failureCodes: string[];
    };
    promotionGate: {
        status: 'PASS' | 'BLOCKED';
        writeEligible: boolean;
        failureCodes: string[];
    };
}

export interface DevelopmentEvidenceCaptureResult {
    evidence: DevelopmentEvidenceManifest | null;
    audit: DevelopmentEvidenceCaptureAudit;
}

interface CaptureState {
    snapshot: LandAreaSyncScopeSnapshot | null;
    terminal: LandAreaSyncTerminalInput | null;
    failureMessage: string | null;
    applyRpcBlocked: boolean;
    snapshotWrites: number;
    terminalWrites: number;
    failureWrites: number;
}

interface CaptureOneResult {
    entry: DevelopmentEvidenceEntry | null;
    audit: DevelopmentEvidenceCaptureAuditEntry;
    state: CaptureState;
}

export interface DevelopmentActivePropertyIdentitySnapshot {
    rows: Array<{ id: string; pnu: string }>;
    pnus: string[];
    pnuDigest: string;
    propertyIdentityDigest: string;
}

export function hasStableDevelopmentActivePropertyIdentity(
    initial: DevelopmentActivePropertyIdentitySnapshot,
    final: DevelopmentActivePropertyIdentitySnapshot | null
): boolean {
    return (
        final !== null &&
        final.propertyIdentityDigest ===
            initial.propertyIdentityDigest
    );
}

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .sort()
        .map(
            (key) =>
                `${JSON.stringify(key)}:${canonicalJson(record[key])}`
        )
        .join(',')}}`;
}

function isPositiveDecimal(value: string): boolean {
    return POSITIVE_DECIMAL_RE.test(value) && Number(value) > 0;
}

function asAllowedSource(
    value: string
): 'LEGACY_UNKNOWN' | 'MANUAL' | 'LADFRL' | 'LDAREG' {
    if (!ALLOWED_LAND_AREA_SOURCES.has(value)) {
        throw new Error('CURRENT_LAND_SOURCE_INVALID');
    }
    return value as
        | 'LEGACY_UNKNOWN'
        | 'MANUAL'
        | 'LADFRL'
        | 'LDAREG';
}

function sortedUnique(values: string[]): string[] {
    return [...new Set(values)].sort();
}

export function assertDevelopmentEvidenceCaptureActiveIdentity(input: {
    target: DevelopmentTargetManifest;
    rows: readonly { id: string; pnu: string }[];
}): DevelopmentActivePropertyIdentitySnapshot {
    const { target, rows } = input;
    const canonicalRows = rows
        .map((row) => ({
            id: row.id.toLowerCase(),
            pnu: row.pnu,
        }))
        .sort((left, right) => {
            const idOrder = left.id.localeCompare(right.id);
            return idOrder !== 0
                ? idOrder
                : left.pnu.localeCompare(right.pnu);
        });
    if (
        rows.length !== target.expectedUnionActivePropertyUnitCount ||
        rows.some(
            (row) =>
                !UUID_RE.test(row.id) ||
                !PNU_RE.test(row.pnu)
        ) ||
        new Set(canonicalRows.map((row) => row.id)).size !==
            canonicalRows.length
    ) {
        throw new Error('CAPTURE_UNION_ACTIVE_PROPERTY_SET_MISMATCH');
    }
    const activePnus = sortedUnique(
        canonicalRows.map((row) => row.pnu)
    );
    if (activePnus.length !== target.expectedUnionActivePnuCount) {
        throw new Error('CAPTURE_UNION_ACTIVE_PNU_COUNT_MISMATCH');
    }

    const allowedScopePnuSet = new Set(
        developmentTargetAllowedScopePnus(target)
    );
    const fullUnionCapture =
        target.expectedPropertyUnitCount ===
        target.expectedUnionActivePropertyUnitCount;
    if (
        fullUnionCapture &&
        activePnus.some(
            (pnu) => !allowedScopePnuSet.has(pnu)
        )
    ) {
        throw new Error('CAPTURE_UNION_ACTIVE_PNU_SET_MISMATCH');
    }
    const expectedActivePnus =
        developmentTargetExpectedActivePnus(target);
    if (
        expectedActivePnus !== null &&
        (expectedActivePnus.length !== activePnus.length ||
            expectedActivePnus.some(
                (pnu, index) => pnu !== activePnus[index]
            ))
    ) {
        throw new Error('CAPTURE_UNION_ACTIVE_PNU_SET_MISMATCH');
    }
    const pnuDigest = computeDevelopmentActivePnuDigest(
        target.unionId,
        activePnus
    );
    if (
        target.version === DEVELOPMENT_TARGET_MANIFEST_VERSION_V3 &&
        pnuDigest !== target.expectedUnionActivePnuDigest
    ) {
        throw new Error('CAPTURE_UNION_ACTIVE_PNU_SET_MISMATCH');
    }
    return {
        rows: canonicalRows,
        pnus: activePnus,
        pnuDigest,
        propertyIdentityDigest: sha256(
            canonicalJson({
                version:
                    'land-area-development-active-property-identity@1',
                databaseTarget: 'development',
                unionId: target.unionId.toLowerCase(),
                rows: canonicalRows,
            })
        ),
    };
}

/**
 * 재시도 대상 판정.
 *
 * `audit.status` 는 REVIEW 로 끝난 anchor 에도 'FAILED' 를 넣으므로 그대로 쓰면 안 된다.
 * aggregateDevelopmentEvidenceCaptureEntries 와 동일한 분기를 써서 집계상 FAILED 로
 * 떨어지는 entry, 즉 판정에 도달하지 못한 anchor 만 고른다.
 */
export function isDevelopmentEvidenceCaptureRetryable(
    entry: DevelopmentEvidenceCaptureAuditEntry
): boolean {
    if (
        entry.status === 'VERIFIED_NO_DATA' ||
        entry.status === 'CAPTURED'
    ) {
        return false;
    }
    if (entry.terminalOutcome === 'NO_DATA') return false;
    return !(
        entry.terminalOutcome === 'REVIEW_REQUIRED' ||
        entry.terminalScopeState === 'REVIEW_REQUIRED'
    );
}

export function aggregateDevelopmentEvidenceCaptureEntries(
    entries: readonly DevelopmentEvidenceCaptureAuditEntry[]
): DevelopmentEvidenceCaptureRedactedAggregate {
    const aggregate: DevelopmentEvidenceCaptureRedactedAggregate = {
        CAPTURED: 0,
        NO_DATA: 0,
        REVIEW: 0,
        FAILED: 0,
    };
    for (const entry of entries) {
        if (entry.status === 'VERIFIED_NO_DATA') {
            aggregate.NO_DATA += 1;
        } else if (entry.status === 'CAPTURED') {
            aggregate.CAPTURED += 1;
        } else if (entry.terminalOutcome === 'NO_DATA') {
            aggregate.NO_DATA += 1;
        } else if (
            entry.terminalOutcome === 'REVIEW_REQUIRED' ||
            entry.terminalScopeState === 'REVIEW_REQUIRED'
        ) {
            aggregate.REVIEW += 1;
        } else {
            aggregate.FAILED += 1;
        }
    }
    return aggregate;
}

/**
 * 공개 진단에는 terminal issue code별 발생 건수만 남긴다.
 * PNU·manifest 순번·UUID·면적·snapshot hash는 포함하지 않아 저장소 target과
 * 결합해도 개별 물건지를 역매핑할 수 없다.
 */
export function aggregateDevelopmentEvidenceCaptureIssueCodes(
    entries: readonly DevelopmentEvidenceCaptureAuditEntry[]
): DevelopmentEvidenceCaptureRedactedIssueCount[] {
    const counts = new Map<string, number>();
    for (const entry of entries) {
        for (const code of new Set(entry.terminalIssueCodes)) {
            counts.set(code, (counts.get(code) ?? 0) + 1);
        }
    }
    return [...counts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([code, count]) => ({ code, count }));
}

function createSyntheticJobRow(
    jobId: string,
    unionId: string,
    anchorPnu: string,
    createdAt: string,
    developmentFullRefresh:
        | LandAreaSyncDevelopmentFullRefresh
        | null
): LandAreaSyncJobRow {
    return {
        id: jobId,
        union_id: unionId,
        status: 'PROCESSING',
        progress: 0,
        preview_data: {
            source: 'LAND_AREA_SYNC_READ_ONLY_CAPTURE',
            landAreaSync: {
                schemaVersion: 2,
                anchorPnu,
                sourceDiscoveryJobId: null,
                admissionKey: jobId,
                ...(developmentFullRefresh
                    ? { developmentFullRefresh }
                    : {}),
            },
        },
        created_at: createdAt,
        updated_at: createdAt,
        error_log: null,
    };
}

/**
 * live snapshot을 runner 승인 evidence 한 건으로 변환한다.
 *
 * v1 target은 기존 evidence 형식을 그대로 유지한다. v2 target은 API capture
 * provenance만 기록하여 workbook을 근거로 오인하지 않게 한다. confirm API에는
 * 200자 이하의 비식별 reference만 전달한다.
 */
export function developmentEvidenceEntryFromSnapshot(input: {
    target: DevelopmentTargetManifest;
    captureRunId: string;
    anchorPnu: string;
    snapshot: LandAreaSyncScopeSnapshot;
}): DevelopmentEvidenceEntry {
    const { target, captureRunId, anchorPnu, snapshot } = input;
    if (
        !POSITIVE_INTEGER_RE.test(captureRunId) ||
        !PNU_RE.test(anchorPnu) ||
        snapshot.strategy !== 'LADFRL' &&
            snapshot.strategy !== 'LDAREG'
    ) {
        throw new Error('CAPTURE_INPUT_INVALID');
    }

    const expectedScannedPnus = sortedUnique(snapshot.scannedPnus);
    const officialScopeResolution =
        snapshot.developmentFullRefreshScopeResolution ??
        snapshot.readOnlyScopeResolution;
    const officialParcelResolution =
        snapshot.developmentFullRefreshParcelResolution ?? null;
    if (snapshot.verifiedNoDataEvidence !== undefined) {
        throw new Error(
            'CAPTURE_VERIFIED_NO_DATA_FORBIDDEN'
        );
    }
    const exclusiveResolutionCount = [
        snapshot.developmentFullRefreshScopeResolution,
        snapshot.developmentFullRefreshParcelResolution,
        snapshot.readOnlyScopeResolution,
    ].filter((value) => value !== undefined).length;
    if (
        exclusiveResolutionCount > 1 ||
        (officialParcelResolution !== null &&
            (target.version !==
                DEVELOPMENT_TARGET_MANIFEST_VERSION_V3 ||
                officialParcelResolution.source !==
                    'SAME_RUN_OFFICIAL_DEVELOPMENT_PARCEL_SINGLETON' ||
                officialParcelResolution.canonicalPnu !==
                    anchorPnu ||
                !HEX64_RE.test(
                    officialParcelResolution.officialParcelDigest
                ) ||
                officialParcelResolution.manifestDigest !==
                    target.manifestDigest ||
                officialParcelResolution.scopeDigest !==
                    target.scopeDigest))
    ) {
        throw new Error(
            'CAPTURE_OFFICIAL_PARCEL_RESOLUTION_INVALID'
        );
    }
    const targetPnus = new Set(
        developmentTargetAllowedScopePnus(target)
    );
    if (
        expectedScannedPnus.length === 0 ||
        expectedScannedPnus.some(
            (pnu) => !PNU_RE.test(pnu) || !targetPnus.has(pnu)
        )
    ) {
        throw new Error('CAPTURE_SCOPE_OUTSIDE_TARGET');
    }
    if (
        officialParcelResolution !== null &&
        (officialParcelResolution.memberPnus.length !== 1 ||
            officialParcelResolution.memberPnus[0] !==
                officialParcelResolution.canonicalPnu ||
            officialParcelResolution.memberPnus.length !==
            expectedScannedPnus.length ||
            officialParcelResolution.memberPnus.some(
                (pnu, index) =>
                    pnu !== expectedScannedPnus[index]
            ))
    ) {
        throw new Error(
            'CAPTURE_OFFICIAL_PARCEL_RESOLUTION_INVALID'
        );
    }

    const expectedPropertyUnitIds = sortedUnique(
        snapshot.candidatePropertyUnitIds
    );
    if (
        officialParcelResolution !== null &&
        (snapshot.strategy !== 'LADFRL' ||
            expectedPropertyUnitIds.length !== 1)
    ) {
        throw new Error(
            'CAPTURE_OFFICIAL_PARCEL_RESOLUTION_INVALID'
        );
    }
    const expectedProposedLandAreas = [...snapshot.proposedLandAreas]
        .map((row) => ({
            propertyUnitId: row.propertyUnitId,
            landArea: row.landArea,
        }))
        .sort((a, b) => a.propertyUnitId.localeCompare(b.propertyUnitId));
    if (
        expectedPropertyUnitIds.length === 0 ||
        expectedPropertyUnitIds.some((id) => !UUID_RE.test(id)) ||
        expectedProposedLandAreas.length !==
            expectedPropertyUnitIds.length ||
        expectedProposedLandAreas.some(
            (row, index) =>
                row.propertyUnitId !== expectedPropertyUnitIds[index] ||
                !isPositiveDecimal(row.landArea)
        )
    ) {
        throw new Error('CAPTURE_PROPERTY_PROJECTION_INVALID');
    }

    const expectedLadfrlAreaEvidence =
        snapshot.ladfrlAreaEvidence;
    if (
        !expectedLadfrlAreaEvidence ||
        !isPositiveDecimal(expectedLadfrlAreaEvidence.totalArea) ||
        expectedLadfrlAreaEvidence.parcels.length !==
            expectedScannedPnus.length ||
        expectedLadfrlAreaEvidence.parcels.some(
            (row, index) =>
                row.pnu !== expectedScannedPnus[index] ||
                !isPositiveDecimal(row.area)
        )
    ) {
        throw new Error('CAPTURE_LADFRL_EVIDENCE_INVALID');
    }

    const currentById = new Map(
        snapshot.currentLandTuples.map((row) => [
            row.propertyUnitId,
            row,
        ])
    );
    const proposedById = new Map(
        expectedProposedLandAreas.map((row) => [
            row.propertyUnitId,
            row.landArea,
        ])
    );
    const allowedPrestates: DevelopmentEvidenceEntry['allowedPrestates'] =
        [];
    const allowManualOverwrite =
        developmentTargetAllowsManualOverwrite(target);
    for (const propertyUnitId of expectedPropertyUnitIds) {
        const current = currentById.get(propertyUnitId);
        const proposed = proposedById.get(propertyUnitId);
        if (!current || !proposed) {
            throw new Error('CAPTURE_PRESTATE_MISSING');
        }
        const currentSource = asAllowedSource(current.source);
        if (currentSource === 'MANUAL' && !allowManualOverwrite) {
            throw new Error('CAPTURE_MANUAL_PRESTATE_OUTSIDE_AUTO_TARGET');
        }
        allowedPrestates.push({
            propertyUnitId,
            landArea:
                current.landArea === '' ? null : current.landArea,
            landAreaSource: currentSource,
        });
        if (
            current.landArea !== proposed ||
            currentSource !== snapshot.strategy
        ) {
            allowedPrestates.push({
                propertyUnitId,
                landArea: proposed,
                landAreaSource: snapshot.strategy,
            });
        }
    }

    const snapshotReferenceSha256 = sha256(
        canonicalJson({
            anchorPnu,
            strategy: snapshot.strategy,
            scannedPnus: expectedScannedPnus,
            propertyUnitIds: expectedPropertyUnitIds,
            proposedLandAreas: expectedProposedLandAreas,
            ladfrlAreaEvidence: expectedLadfrlAreaEvidence,
            scopeHash: snapshot.scopeHash,
            dbScopeHash: snapshot.dbScopeHash,
            externalScopeDigest: snapshot.externalScopeDigest,
            projectionInputDigest: snapshot.projectionInputDigest,
            officialComponentDigest:
                officialScopeResolution?.officialComponentDigest ??
                null,
            officialParcelDigest:
                officialParcelResolution?.officialParcelDigest ??
                null,
        })
    );
    const confirmationRef =
        `captureRun=${captureRunId};snapshot=${snapshotReferenceSha256}`;
    const sourceReferences:
        DevelopmentEvidenceEntry['sourceReferences'] =
        target.version === DEVELOPMENT_TARGET_MANIFEST_VERSION
            ? {
                  workbookFileReferenceSha256:
                      target.manifestDigest,
                  sheet: 'LIVE_CAPTURE',
                  cells: ['A1'],
                  selectedCellsReferenceSha256:
                      snapshotReferenceSha256,
                  phase0RunId: captureRunId,
                  phase0ArtifactReferenceSha256:
                      snapshotReferenceSha256,
                  phase0ObservationReferenceSha256:
                      snapshotReferenceSha256,
                  developmentObservationReferenceSha256:
                      snapshotReferenceSha256,
              }
            : officialParcelResolution
              ? {
                    kind:
                        'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_PARCEL_CAPTURE',
                    captureRunId,
                    snapshotReferenceSha256,
                    officialParcelDigest:
                        officialParcelResolution.officialParcelDigest,
                }
              : officialScopeResolution
              ? {
                    kind:
                        'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_CAPTURE',
                    captureRunId,
                    snapshotReferenceSha256,
                    officialComponentDigest:
                        officialScopeResolution.officialComponentDigest,
                }
              : {
                    kind: 'DEVELOPMENT_READ_ONLY_API_CAPTURE',
                    captureRunId,
                    snapshotReferenceSha256,
                };

    return {
        anchorPnu,
        expectedStrategy: snapshot.strategy,
        expectedScannedPnus,
        expectedPropertyUnitIds,
        expectedProposedLandAreas,
        expectedLadfrlAreaEvidence: {
            parcels: expectedLadfrlAreaEvidence.parcels.map((row) => ({
                pnu: row.pnu,
                area: row.area,
            })),
            totalArea: expectedLadfrlAreaEvidence.totalArea,
        },
        allowedPrestates,
        parcelScopeEvidence: {
            kind: 'API_RELATION_CROSS_CHECK',
            ref: confirmationRef,
        },
        landOwnershipEvidence:
            snapshot.strategy === 'LADFRL'
                ? {
                      kind: 'OTHER',
                      ref: confirmationRef,
                  }
                : null,
        allowManualOverwrite,
        sourceReferences,
    };
}

async function captureOne(input: {
    target: DevelopmentTargetManifest;
    captureRunId: string;
    anchorPnu: string;
    developmentFullRefresh:
        | LandAreaSyncDevelopmentFullRefresh
        | null;
    deps: DevelopmentEvidenceCaptureReadOnlyDeps;
    attempt: number;
}): Promise<CaptureOneResult> {
    const jobId = randomUUID();
    const createdAt = input.deps.now().toISOString();
    const syntheticJob = createSyntheticJobRow(
        jobId,
        input.target.unionId,
        input.anchorPnu,
        createdAt,
        input.developmentFullRefresh
    );
    const state: CaptureState = {
        snapshot: null,
        terminal: null,
        failureMessage: null,
        applyRpcBlocked: false,
        snapshotWrites: 0,
        terminalWrites: 0,
        failureWrites: 0,
    };
    const approvedPnus = new Set(
        developmentTargetAllowedScopePnus(input.target)
    );

    const db: LandAreaSyncDbDeps = {
        resolveScope: input.deps.resolveScope,
        readBuildingUnits: input.deps.readBuildingUnits,
        readPropertyUnits: input.deps.readPropertyUnits,
        readCurrentLandTuples: input.deps.readCurrentLandTuples,
        async getScopedJob(requestedJobId, requestedUnionId) {
            return requestedJobId === jobId &&
                requestedUnionId === input.target.unionId
                ? syntheticJob
                : null;
        },
        async freezeScopeSnapshot(
            requestedJobId,
            requestedUnionId,
            patch
        ) {
            if (
                requestedJobId !== jobId ||
                requestedUnionId !== input.target.unionId ||
                state.snapshot !== null
            ) {
                return false;
            }
            state.snapshot = patch.scopeSnapshot;
            state.snapshotWrites += 1;
            return true;
        },
        async writeDiscoveryTerminal(
            requestedJobId,
            requestedUnionId,
            terminal
        ) {
            if (
                requestedJobId !== jobId ||
                requestedUnionId !== input.target.unionId
            ) {
                return false;
            }
            state.terminal = terminal;
            state.terminalWrites += 1;
            return true;
        },
        async markScopedFailed(
            requestedJobId,
            requestedUnionId,
            message
        ) {
            if (
                requestedJobId !== jobId ||
                requestedUnionId !== input.target.unionId
            ) {
                return false;
            }
            state.failureMessage = message;
            state.failureWrites += 1;
            return true;
        },
        async applyRpc() {
            // 읽기 전용 capture에서는 실제 Supabase apply RPC를 주입하지 않는다.
            // LINKED LDAREG discovery가 자동 apply 단계까지 도달해도 여기서 차단한다.
            state.applyRpcBlocked = true;
            return {
                data: null,
                error: {
                    message: 'READ_ONLY_CAPTURE_APPLY_BLOCKED',
                    code: '42501',
                },
            };
        },
    };
    const runDeps: LandAreaSyncDeps = {
        scans: input.deps.scans,
        db,
        now: input.deps.now,
        executionMode: 'READ_ONLY_CAPTURE',
        databaseTarget: 'development',
        assertCanaryScopeAllowed(_unionId, scannedPnus) {
            if (
                scannedPnus.some(
                    (pnu) => !approvedPnus.has(pnu)
                )
            ) {
                throw new Error('CAPTURE_SCOPE_OUTSIDE_TARGET');
            }
        },
    };

    let failureCode: string | null = null;
    let entry: DevelopmentEvidenceEntry | null = null;
    try {
        await runLandAreaSyncJob({
            jobId,
            unionId: input.target.unionId,
            deps: runDeps,
        });
        if (!state.snapshot) {
            failureCode =
                state.terminal?.scopeState === 'REVIEW_REQUIRED'
                    ? 'CAPTURE_REVIEW_REQUIRED'
                    : state.terminal?.scopeState === 'FAILED'
                      ? 'CAPTURE_DISCOVERY_FAILED'
                      : 'CAPTURE_SNAPSHOT_MISSING';
        } else {
            entry = developmentEvidenceEntryFromSnapshot({
                target: input.target,
                captureRunId: input.captureRunId,
                anchorPnu: input.anchorPnu,
                snapshot: state.snapshot,
            });
        }
    } catch (error) {
        failureCode =
            error instanceof Error &&
            /^[A-Z0-9_]{1,100}$/.test(error.message)
                ? error.message
                : 'CAPTURE_UNEXPECTED_ERROR';
    }

    const snapshotReferenceSha256 = state.snapshot
        ? sha256(canonicalJson(state.snapshot))
        : null;
    return {
        entry,
        state,
        audit: {
            anchorPnu: input.anchorPnu,
            status: entry
                ? state.snapshot?.verifiedNoDataEvidence
                    ? 'VERIFIED_NO_DATA'
                    : 'CAPTURED'
                : 'FAILED',
            strategy: state.snapshot?.strategy ?? null,
            scannedPnuCount:
                state.snapshot?.scannedPnus.length ?? 0,
            propertyUnitCount:
                state.snapshot?.candidatePropertyUnitIds.length ?? 0,
            snapshotReferenceSha256,
            applyRpcBlocked: state.applyRpcBlocked,
            failureCode,
            terminalScopeState:
                state.terminal?.scopeState ?? null,
            terminalOutcome: state.terminal?.outcome ?? null,
            terminalIssueCodes: sortedUnique(
                state.terminal?.issues.map((issue) => issue.code) ??
                    []
            ),
            terminalIssuesTotal:
                state.terminal?.issuesTotal ?? 0,
            terminalIssuesTruncated:
                state.terminal?.issuesTruncated ?? false,
            scopeResolutionSource:
                state.snapshot?.verifiedNoDataEvidence
                    ? 'VERIFIED_NO_DATA'
                    : state.snapshot
                    ?.developmentFullRefreshParcelResolution
                    ?.source ??
                state.snapshot
                    ?.developmentFullRefreshScopeResolution
                    ?.source ??
                state.snapshot?.readOnlyScopeResolution?.source ??
                'DB_RESOLVER',
            attempts: input.attempt,
        },
    };
}

export async function captureDevelopmentLandAreaEvidence(input: {
    target: DevelopmentTargetManifest;
    captureRunId: string;
    deps: DevelopmentEvidenceCaptureReadOnlyDeps;
    concurrency?: number;
    onProgress?: (completed: number, total: number) => void;
}): Promise<DevelopmentEvidenceCaptureResult> {
    const concurrency = input.concurrency ?? 2;
    if (
        input.target.databaseTarget !== 'development' ||
        !POSITIVE_INTEGER_RE.test(input.captureRunId) ||
        !Number.isSafeInteger(concurrency) ||
        concurrency < 1 ||
        concurrency > 4
    ) {
        throw new Error('CAPTURE_INPUT_INVALID');
    }

    const executionAnchors =
        developmentTargetExecutionAnchors(input.target);
    let developmentFullRefresh:
        | LandAreaSyncDevelopmentFullRefresh
        | null = null;
    try {
        developmentFullRefresh =
            developmentFullRefreshMarkerForTarget(input.target);
    } catch {
        // repo-pinned DEV 전체 갱신 target이 아니면 기존 read-only capture로만
        // 실행한다. promotion gate는 아래에서 write 승격을 차단한다.
        developmentFullRefresh = null;
    }
    const initialActiveIdentity =
        assertDevelopmentEvidenceCaptureActiveIdentity({
        target: input.target,
        rows: await input.deps.readActivePropertyIdentity(
            input.target.unionId
        ),
    });
    const results = new Array<CaptureOneResult>(
        executionAnchors.length
    );
    let nextIndex = 0;
    let completed = 0;
    const worker = async () => {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= executionAnchors.length) return;
            results[index] = await captureOne({
                target: input.target,
                captureRunId: input.captureRunId,
                anchorPnu: executionAnchors[index],
                developmentFullRefresh,
                deps: input.deps,
                attempt: 1,
            });
            completed += 1;
            input.onProgress?.(completed, executionAnchors.length);
        }
    };
    await Promise.all(
        Array.from(
            { length: Math.min(concurrency, executionAnchors.length) },
            () => worker()
        )
    );

    const failureCodes = sortedUnique(
        results
            .map((result) => result.audit.failureCode)
            .filter((value): value is string => value !== null)
    );
    const entries = results
        .map((result) => result.entry)
        .filter(
            (entry): entry is DevelopmentEvidenceEntry =>
                entry !== null
        );
    const capturedPropertyUnitIds = entries.flatMap(
        (entry) =>
            entry.expectedPropertyUnitIds.map((id) =>
                id.toLowerCase()
            )
    );
    const uniquePropertyUnitIds = new Set(
        capturedPropertyUnitIds
    );
    const initialActivePropertyUnitIds =
        initialActiveIdentity.rows.map((row) => row.id);
    const initialPnuByPropertyUnitId = new Map(
        initialActiveIdentity.rows.map((row) => [
            row.id,
            row.pnu,
        ])
    );
    const capturedPropertyUnitIdsSorted = [
        ...uniquePropertyUnitIds,
    ].sort();
    const capturedScannedPnus = entries.flatMap(
        (entry) => entry.expectedScannedPnus
    );
    const uniqueScannedPnus = new Set(capturedScannedPnus);
    const sameRunOfficialComponentCount = results.filter(
        (result) =>
            result.audit.scopeResolutionSource ===
                'SAME_RUN_OFFICIAL_READ_ONLY' ||
            result.audit.scopeResolutionSource ===
                'SAME_RUN_OFFICIAL_DEVELOPMENT_FULL_REFRESH'
    ).length;
    const sameRunOfficialParcelCount = results.filter(
        (result) =>
            result.audit.scopeResolutionSource ===
            'SAME_RUN_OFFICIAL_DEVELOPMENT_PARCEL_SINGLETON'
    ).length;
    const verifiedNoDataCount = results.filter(
        (result) =>
            result.audit.scopeResolutionSource ===
            'VERIFIED_NO_DATA'
    ).length;
    if (entries.length !== input.target.targetCount) {
        failureCodes.push('CAPTURE_TARGET_COVERAGE_MISMATCH');
    }
    if (
        uniquePropertyUnitIds.size !==
        input.target.expectedPropertyUnitCount
    ) {
        failureCodes.push(
            'CAPTURE_PROPERTY_UNIT_COUNT_MISMATCH'
        );
    }
    if (
        uniquePropertyUnitIds.size !==
        capturedPropertyUnitIds.length
    ) {
        failureCodes.push(
            'CAPTURE_PROPERTY_UNIT_ID_OVERLAP'
        );
    }
    const capturedIdentityOutsideInitialSnapshot = entries.some(
        (entry) => {
            const scannedPnus = new Set(
                entry.expectedScannedPnus
            );
            return entry.expectedPropertyUnitIds.some(
                (propertyUnitId) => {
                    const initialPnu =
                        initialPnuByPropertyUnitId.get(
                            propertyUnitId.toLowerCase()
                        );
                    return (
                        initialPnu === undefined ||
                        !scannedPnus.has(initialPnu)
                    );
                }
            );
        }
    );
    if (capturedIdentityOutsideInitialSnapshot) {
        failureCodes.push(
            'CAPTURE_PROPERTY_UNIT_IDENTITY_MISMATCH'
        );
    }
    if (
        input.target.expectedPropertyUnitCount ===
            input.target.expectedUnionActivePropertyUnitCount &&
        JSON.stringify(capturedPropertyUnitIdsSorted) !==
            JSON.stringify(initialActivePropertyUnitIds)
    ) {
        failureCodes.push(
            'CAPTURE_PROPERTY_UNIT_SET_MISMATCH'
        );
    }
    if (input.target.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION) {
        const allowedScopePnus =
            developmentTargetAllowedScopePnus(input.target);
        if (
            uniqueScannedPnus.size !==
            capturedScannedPnus.length
        ) {
            failureCodes.push(
                'CAPTURE_SCANNED_PNU_OVERLAP'
            );
        }
        if (
            uniqueScannedPnus.size !== allowedScopePnus.length ||
            allowedScopePnus.some(
                (pnu) => !uniqueScannedPnus.has(pnu)
            )
        ) {
            failureCodes.push(
                'CAPTURE_SCANNED_PNU_COVERAGE_MISMATCH'
            );
        }
    }

    let finalActiveIdentity:
        | DevelopmentActivePropertyIdentitySnapshot
        | null = null;
    try {
        finalActiveIdentity =
            assertDevelopmentEvidenceCaptureActiveIdentity({
                target: input.target,
                rows: await input.deps.readActivePropertyIdentity(
                    input.target.unionId
                ),
            });
    } catch (error) {
        failureCodes.push(
            error instanceof Error &&
                /^[A-Z0-9_]{1,100}$/.test(error.message)
                ? error.message
                : 'CAPTURE_FINAL_ACTIVE_IDENTITY_READ_FAILED'
        );
    }
    const activePropertyIdentityStable =
        hasStableDevelopmentActivePropertyIdentity(
            initialActiveIdentity,
            finalActiveIdentity
        );
    if (!activePropertyIdentityStable) {
        failureCodes.push(
            'CAPTURE_UNION_ACTIVE_PROPERTY_SET_CHANGED'
        );
    }

    const capturedEvidence = {
        version:
            input.target.version ===
            DEVELOPMENT_TARGET_MANIFEST_VERSION
                ? DEVELOPMENT_EVIDENCE_MANIFEST_VERSION
                : DEVELOPMENT_EVIDENCE_MANIFEST_VERSION_V2,
        databaseTarget: 'development',
        unionId: input.target.unionId,
        manifestDigest: input.target.manifestDigest,
        entries,
    } as DevelopmentEvidenceManifest;
    const capturedEvidenceManifestSha256 = sha256(
        `${JSON.stringify(capturedEvidence, null, 2)}\n`
    );
    const evidence: DevelopmentEvidenceManifest | null =
        failureCodes.length === 0
            ? capturedEvidence
            : null;
    const evidenceManifestSha256 = evidence
        ? sha256(`${JSON.stringify(evidence, null, 2)}\n`)
        : null;
    const fullRefreshWriteEligible =
        developmentFullRefresh !== null;
    const sameRunOfficialWriteEligible =
        isDevelopmentEvidenceCapturePromotionEligible({
            fullRefreshWriteEligible,
            targetCount: input.target.targetCount,
            sameRunOfficialComponentCount,
            sameRunOfficialParcelCount,
            verifiedNoDataCount,
        });

    return {
        evidence,
        audit: {
            version: DEVELOPMENT_EVIDENCE_CAPTURE_AUDIT_VERSION,
            databaseTarget: 'development',
            unionId: input.target.unionId,
            targetCount: input.target.targetCount,
            expectedPropertyUnitCount:
                input.target.expectedPropertyUnitCount,
            activePnuCount:
                input.target.expectedUnionActivePnuCount,
            activePnuDigest: initialActiveIdentity.pnuDigest,
            initialActivePropertyIdentityDigest:
                initialActiveIdentity.propertyIdentityDigest,
            finalActivePropertyIdentityDigest:
                finalActiveIdentity?.propertyIdentityDigest ??
                '0'.repeat(64),
            activePropertyIdentityStable,
            resolvedComponentCount:
                input.target.targetCount,
            scannedPnuCount: uniqueScannedPnus.size,
            sameRunOfficialComponentCount,
            sameRunOfficialParcelCount,
            verifiedNoDataCount,
            manifestDigest: input.target.manifestDigest,
            captureRunId: input.captureRunId,
            capturedAt: input.deps.now().toISOString(),
            readOnlyGuards: {
                durableSyncJobWrites: 0,
                propertyUnitWriteRpcCalls: 0,
                interceptedApplyRpcCalls: results.filter(
                    (result) => result.state.applyRpcBlocked
                ).length,
                interceptedSnapshotWrites: results.reduce(
                    (sum, result) =>
                        sum + result.state.snapshotWrites,
                    0
                ),
                interceptedTerminalWrites: results.reduce(
                    (sum, result) =>
                        sum + result.state.terminalWrites,
                    0
                ),
                interceptedFailureWrites: results.reduce(
                    (sum, result) =>
                        sum + result.state.failureWrites,
                    0
                ),
            },
            retry: {
                rounds: 0,
                retriedAnchorCount: 0,
                recoveredAnchorCount: 0,
                skipped: 'NONE',
            },
            entries: results.map((result) => result.audit),
            redactedAggregate:
                aggregateDevelopmentEvidenceCaptureEntries(
                    results.map((result) => result.audit)
                ),
            redactedIssueCounts:
                aggregateDevelopmentEvidenceCaptureIssueCodes(
                    results.map((result) => result.audit)
                ),
            capturedEvidence,
            capturedEvidencePropertyUnitCount:
                uniquePropertyUnitIds.size,
            capturedEvidenceManifestSha256,
            evidenceManifestSha256,
            gate: {
                status:
                    failureCodes.length === 0 ? 'PASS' : 'FAIL',
                failureCodes: sortedUnique(failureCodes),
            },
            promotionGate: {
                status:
                    sameRunOfficialWriteEligible
                        ? 'PASS'
                        : 'BLOCKED',
                writeEligible:
                    sameRunOfficialWriteEligible,
                failureCodes:
                    sameRunOfficialWriteEligible
                        ? []
                        : fullRefreshWriteEligible
                          ? [
                                'SAME_RUN_OFFICIAL_COVERAGE_MISMATCH',
                            ]
                          : sameRunOfficialComponentCount > 0 ||
                              sameRunOfficialParcelCount > 0 ||
                              verifiedNoDataCount > 0
                            ? [
                                  'SAME_RUN_OFFICIAL_SCOPE_NOT_DB_REVALIDATABLE',
                              ]
                            : [],
            },
        },
    };
}

export function isDevelopmentEvidenceCapturePromotionEligible(input: {
    fullRefreshWriteEligible: boolean;
    targetCount: number;
    sameRunOfficialComponentCount: number;
    sameRunOfficialParcelCount: number;
    verifiedNoDataCount: number;
}): boolean {
    const counts = [
        input.targetCount,
        input.sameRunOfficialComponentCount,
        input.sameRunOfficialParcelCount,
        input.verifiedNoDataCount,
    ];
    if (
        counts.some(
            (value) =>
                !Number.isSafeInteger(value) || value < 0
        ) ||
        input.targetCount < 1
    ) {
        return false;
    }
    return input.fullRefreshWriteEligible
        ? input.verifiedNoDataCount === 0 &&
              input.sameRunOfficialComponentCount +
                  input.sameRunOfficialParcelCount ===
                  input.targetCount
        : input.sameRunOfficialComponentCount === 0 &&
              input.sameRunOfficialParcelCount === 0 &&
              input.verifiedNoDataCount === 0;
}
