import { createHash, randomUUID } from 'node:crypto';
import {
    DEVELOPMENT_EVIDENCE_MANIFEST_VERSION,
    DEVELOPMENT_EVIDENCE_MANIFEST_VERSION_V2,
    DEVELOPMENT_TARGET_MANIFEST_VERSION,
    developmentTargetAllowedScopePnus,
    developmentTargetAllowsManualOverwrite,
    developmentTargetExecutionAnchors,
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
    LandAreaSyncScopeSnapshot,
    LandAreaSyncStrategy,
} from '../types/land-area-sync-job.types';

export const DEVELOPMENT_EVIDENCE_CAPTURE_AUDIT_VERSION =
    'land-area-development-evidence-capture-audit@1' as const;

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNU_RE = /^[0-9]{19}$/;
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
    status: 'CAPTURED' | 'FAILED';
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
}

export interface DevelopmentEvidenceCaptureRedactedAggregate {
    CAPTURED: number;
    NO_DATA: number;
    REVIEW: number;
    FAILED: number;
}

export interface DevelopmentEvidenceCaptureAudit {
    version: typeof DEVELOPMENT_EVIDENCE_CAPTURE_AUDIT_VERSION;
    databaseTarget: 'development';
    unionId: string;
    targetCount: number;
    expectedPropertyUnitCount: number;
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
    entries: DevelopmentEvidenceCaptureAuditEntry[];
    /**
     * 공개 artifact에서 주소·PNU·물건지 ID 없이 결과 분포만 확인하기 위한 집계다.
     * 상세 entry와 gate는 그대로 유지하며 이 집계가 실패를 성공으로 바꾸지는 않는다.
     */
    redactedAggregate: DevelopmentEvidenceCaptureRedactedAggregate;
    capturedEvidence: DevelopmentEvidenceManifest | null;
    capturedEvidencePropertyUnitCount: number;
    capturedEvidenceManifestSha256: string | null;
    evidenceManifestSha256: string | null;
    gate: {
        status: 'PASS' | 'FAIL';
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
}): void {
    const { target, rows } = input;
    if (
        rows.length !== target.expectedUnionActivePropertyUnitCount ||
        rows.some(
            (row) =>
                !UUID_RE.test(row.id) ||
                !PNU_RE.test(row.pnu)
        ) ||
        new Set(rows.map((row) => row.id)).size !== rows.length
    ) {
        throw new Error('CAPTURE_UNION_ACTIVE_PROPERTY_SET_MISMATCH');
    }
    const activePnus = sortedUnique(rows.map((row) => row.pnu));
    if (activePnus.length !== target.expectedUnionActivePnuCount) {
        throw new Error('CAPTURE_UNION_ACTIVE_PNU_COUNT_MISMATCH');
    }

    const anchors = developmentTargetExecutionAnchors(target);
    if (
        target.targetCount === target.expectedUnionActivePnuCount &&
        (
            anchors.length !== activePnus.length ||
            anchors.some((pnu, index) => pnu !== activePnus[index])
        )
    ) {
        throw new Error('CAPTURE_UNION_ACTIVE_PNU_SET_MISMATCH');
    }
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
        if (entry.status === 'CAPTURED') {
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

function createSyntheticJobRow(
    jobId: string,
    unionId: string,
    anchorPnu: string,
    createdAt: string
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

    const expectedPropertyUnitIds = sortedUnique(
        snapshot.candidatePropertyUnitIds
    );
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
    deps: DevelopmentEvidenceCaptureReadOnlyDeps;
}): Promise<CaptureOneResult> {
    const jobId = randomUUID();
    const createdAt = input.deps.now().toISOString();
    const syntheticJob = createSyntheticJobRow(
        jobId,
        input.target.unionId,
        input.anchorPnu,
        createdAt
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
            status: entry ? 'CAPTURED' : 'FAILED',
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
                deps: input.deps,
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
        (entry) => entry.expectedPropertyUnitIds
    );
    const uniquePropertyUnitIds = new Set(
        capturedPropertyUnitIds
    );
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
    if (input.target.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION) {
        const capturedScannedPnus = entries.flatMap(
            (entry) => entry.expectedScannedPnus
        );
        const uniqueScannedPnus = new Set(
            capturedScannedPnus
        );
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

    return {
        evidence,
        audit: {
            version: DEVELOPMENT_EVIDENCE_CAPTURE_AUDIT_VERSION,
            databaseTarget: 'development',
            unionId: input.target.unionId,
            targetCount: input.target.targetCount,
            expectedPropertyUnitCount:
                input.target.expectedPropertyUnitCount,
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
            entries: results.map((result) => result.audit),
            redactedAggregate:
                aggregateDevelopmentEvidenceCaptureEntries(
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
        },
    };
}
