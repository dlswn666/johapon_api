import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import {
    DEVELOPMENT_DB_APPROVAL_MANIFEST_VERSION,
    DEVELOPMENT_EVIDENCE_MANIFEST_VERSION,
    DEVELOPMENT_EVIDENCE_MANIFEST_VERSION_V2,
    DEVELOPMENT_GIS_JWT_TTL_SECONDS,
    DEVELOPMENT_JOB_POLL_SOFT_TIMEOUT_MS,
    DEVELOPMENT_PUBLIC_RUN_ARTIFACT_VERSION,
    DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES,
    DEVELOPMENT_RUN_ARTIFACT_VERSION,
    DEVELOPMENT_TARGET_MANIFEST_VERSION,
    DEVELOPMENT_TARGET_MANIFEST_VERSION_V2,
    DEVELOPMENT_TARGET_MANIFEST_VERSION_V3,
    LocalhostDevelopmentLandAreaSyncClient,
    computeDevelopmentTargetDigest,
    computeDevelopmentTargetV2ManifestDigest,
    createDevelopmentGisSystemAdminJwt,
    createDevelopmentPublicRunArtifact,
    developmentFullRefreshMarkerForTarget,
    developmentTargetAllowedScopePnus,
    developmentTargetScopeDigest,
    parseDevelopmentDbApprovalManifest,
    parseDevelopmentEvidenceManifest,
    parseDevelopmentTargetManifest,
    runDevelopmentLandAreaSync,
    validateDevelopmentPublicRunArtifact,
    validateDevelopmentLandRightTransition,
    validateDevelopmentRunArtifact,
    validateDevelopmentRunnerEnvironment,
    validateDevelopmentRunnerManifests,
    type DevelopmentDbApprovalManifest,
    type DevelopmentActivePropertyUnit,
    type DevelopmentEvidenceEntry,
    type DevelopmentEvidenceManifest,
    type DevelopmentReadOnlyPreflightReader,
    type DevelopmentRelationGisInvariantSnapshot,
    type DevelopmentRunArtifact,
    type DevelopmentTargetManifest,
    type DevelopmentTargetManifestV2,
    type DevelopmentTargetManifestV3,
    type LandAreaSyncApiClient,
    type LandAreaSyncApiJob,
    type ObservedDevelopmentLandRight,
} from '../src/operations/development-land-area-sync-runner';
import type { LandAreaSyncScopeSnapshot } from '../src/types/land-area-sync-job.types';

const UNION_ID = '00f48b95-e9bc-4c92-a0e5-6b9a57adcfb9';
const ACTOR_AUTH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROPERTY_UNIT_ID = '5a1a4cbb-c8ad-45a3-ae40-b90665dc949c';
const SECOND_PROPERTY_UNIT_ID =
    '6b2b5dcc-d9be-46b4-bf51-ca17c6ed050d';
const PNU = '1130510100107912166';
const SECOND_PNU = '1130510100107912167';
const DISCOVERY_JOB_ID = '11111111-1111-4111-8111-111111111111';
const APPLY_JOB_ID = '22222222-2222-4222-8222-222222222222';
const CONFIRM_ADMISSION_KEY = '33333333-3333-4333-8333-333333333333';
const SECOND_APPLY_JOB_ID = '44444444-4444-4444-8444-444444444444';
const HASH = 'a'.repeat(64);
const REPRESENTATIVE_EVIDENCE_MANIFEST_URL = new URL(
    '../development-land-area-sync-manifests/mia-seven-representative-evidence-20260725.json',
    import.meta.url
);
const FULL_REFRESH_TARGET_MANIFEST_URL = new URL(
    '../development-land-area-sync-manifests/mia-seven-full-278-official-components-api-readonly-target-20260729.json',
    import.meta.url
);

function sha256Utf8(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function target(pnus = [PNU], expectedPropertyUnitCount = 1): DevelopmentTargetManifest {
    return {
        version: DEVELOPMENT_TARGET_MANIFEST_VERSION,
        databaseTarget: 'development',
        unionId: UNION_ID,
        pnus,
        targetCount: pnus.length,
        manifestDigest: computeDevelopmentTargetDigest(UNION_ID, pnus),
        expectedPropertyUnitCount,
        expectedUnionActivePropertyUnitCount: expectedPropertyUnitCount,
        expectedUnionActivePnuCount: pnus.length,
    };
}

function approval(
    targetManifest: DevelopmentTargetManifest
): DevelopmentDbApprovalManifest {
    const pnus =
        developmentTargetAllowedScopePnus(targetManifest);
    return {
        version: DEVELOPMENT_DB_APPROVAL_MANIFEST_VERSION,
        databaseTarget: 'development',
        unionId: targetManifest.unionId,
        pnus,
        targetCount: pnus.length,
        manifestDigest:
            developmentTargetScopeDigest(targetManifest),
        enabled: true,
    };
}

function targetV2(
    anchors = [PNU],
    allowedScopePnus = [PNU, SECOND_PNU],
    expectedPropertyUnitCount = 1
): DevelopmentTargetManifestV2 {
    const identity = {
        unionId: UNION_ID,
        anchors,
        allowedScopePnus,
        targetCount: anchors.length,
        expectedPropertyUnitCount,
        expectedUnionActivePropertyUnitCount:
            expectedPropertyUnitCount,
        expectedUnionActivePnuCount: 1,
        allowManualOverwrite: true as const,
    };
    return {
        version: DEVELOPMENT_TARGET_MANIFEST_VERSION_V2,
        databaseTarget: 'development',
        ...identity,
        scopeDigest: computeDevelopmentTargetDigest(
            identity.unionId,
            identity.allowedScopePnus
        ),
        manifestDigest:
            computeDevelopmentTargetV2ManifestDigest(identity),
    };
}

function evidenceEntry(
    pnu = PNU,
    propertyUnitId = PROPERTY_UNIT_ID
): DevelopmentEvidenceEntry {
    return {
        anchorPnu: pnu,
        expectedStrategy: 'LADFRL',
        expectedScannedPnus: [pnu],
        expectedPropertyUnitIds: [propertyUnitId],
        expectedProposedLandAreas: [
            { propertyUnitId, landArea: '161' },
        ],
        expectedLadfrlAreaEvidence: {
            parcels: [{ pnu, area: '161' }],
            totalArea: '161',
        },
        allowedPrestates: [
            {
                propertyUnitId,
                landArea: null,
                landAreaSource: 'LEGACY_UNKNOWN',
            },
            {
                propertyUnitId,
                landArea: '161',
                landAreaSource: 'LADFRL',
            },
        ],
        parcelScopeEvidence: {
            kind: 'OTHER',
            ref: `sheet=s;cells=E29,F29;sha256=${HASH}`,
        },
        landOwnershipEvidence: {
            kind: 'OTHER',
            ref: `sheet=s;cells=E29,F29;sha256=${HASH}`,
        },
        allowManualOverwrite: false,
        sourceReferences: {
            workbookFileReferenceSha256: HASH,
            sheet: '미아791',
            cells: ['E29', 'F29'],
            selectedCellsReferenceSha256: HASH,
            phase0RunId: '30105293359',
            phase0ArtifactReferenceSha256: HASH,
            phase0ObservationReferenceSha256: HASH,
            developmentObservationReferenceSha256: HASH,
        },
    };
}

function preflightReader(
    entries: DevelopmentEvidenceEntry[],
    initiallyApplied = false,
    writerJobId = APPLY_JOB_ID,
    applyAfterFirstRead = true
): DevelopmentReadOnlyPreflightReader {
    let reads = 0;
    return {
        async readActivePropertyUnits() {
            reads += 1;
            const applied =
                initiallyApplied ||
                (applyAfterFirstRead && reads > 1);
            return entries.flatMap((entry) =>
                entry.expectedPropertyUnitIds.map((id) => ({
                    id,
                    pnu: entry.anchorPnu,
                    landArea: applied ? '161' : null,
                    landAreaSource: applied
                        ? (entry.expectedStrategy as 'LADFRL')
                        : ('LEGACY_UNKNOWN' as const),
                    landAreaSyncedAt: applied
                        ? '2026-07-25T00:01:00.000Z'
                        : null,
                    landAreaSyncJobId: applied ? writerJobId : null,
                }))
            );
        },
        async readPropertyUnitsBySyncJobIds() {
            return entries.flatMap((entry) =>
                entry.expectedPropertyUnitIds.map((id) => ({
                    id,
                    unionId: UNION_ID,
                    landAreaSyncJobId: writerJobId,
                }))
            );
        },
    };
}

function evidence(
    targetManifest: DevelopmentTargetManifest,
    entries = [evidenceEntry()]
): DevelopmentEvidenceManifest {
    return {
        version: DEVELOPMENT_EVIDENCE_MANIFEST_VERSION,
        databaseTarget: 'development',
        unionId: targetManifest.unionId,
        manifestDigest: targetManifest.manifestDigest,
        entries,
    };
}

function evidenceV2(
    targetManifest: DevelopmentTargetManifest,
    entries: DevelopmentEvidenceEntry[]
): DevelopmentEvidenceManifest {
    return {
        version: DEVELOPMENT_EVIDENCE_MANIFEST_VERSION_V2,
        databaseTarget: 'development',
        unionId: targetManifest.unionId,
        manifestDigest: targetManifest.manifestDigest,
        entries: entries.map((entry) => ({
            ...entry,
            allowManualOverwrite: true,
            sourceReferences: {
                kind: 'DEVELOPMENT_READ_ONLY_API_CAPTURE',
                captureRunId: '30118336235',
                snapshotReferenceSha256: HASH,
            },
        })),
    };
}

function snapshot(
    pnu = PNU,
    propertyUnitId = PROPERTY_UNIT_ID
): LandAreaSyncScopeSnapshot {
    return {
        frozenAt: '2026-07-25T00:00:00.000Z',
        strategy: 'LADFRL',
        scannedPnus: [pnu],
        resolverRootPks: ['root'],
        bylotSourcePolicy: 'TITLE_WITH_BASIS_FALLBACK',
        bylotEvidence: [],
        dbScopeHash: '1'.repeat(64),
        externalScopeDigest: '2'.repeat(64),
        scopeHash: '3'.repeat(64),
        candidatePropertyUnitIds: [propertyUnitId],
        propertyMembershipHash: '4'.repeat(64),
        currentLandTuples: [],
        // PostgreSQL jsonb가 반환하는 key 순서와 같게 의도적으로 반대로 둔다.
        // runner 비교는 객체 key 순서가 아니라 필드 값만 canonical하게 비교해야 한다.
        proposedLandAreas: [{ landArea: '161', propertyUnitId }],
        ladfrlAreaEvidence: {
            version: 'land-area-sync.ladfrl-scope.v1',
            parcels: [{ pnu, area: '161' }],
            totalArea: '161',
        },
        replicationEvidence: null,
        projectionInputDigest: '5'.repeat(64),
        canonicalVersion: 1,
    };
}

function job(
    id: string,
    input: {
        status: LandAreaSyncApiJob['status'];
        scopeState: NonNullable<
            LandAreaSyncApiJob['landAreaSync']
        >['scopeState'];
        outcome: NonNullable<
            LandAreaSyncApiJob['landAreaSync']
        >['outcome'];
        sourceDiscoveryJobId?: string | null;
        scopeSnapshot?: LandAreaSyncScopeSnapshot | null;
        issueCodes?: string[];
        includeWorkerFinalization?: boolean;
        admissionKey?: string;
        issuesTotal?: number;
        issuesTruncated?: boolean;
    }
): LandAreaSyncApiJob {
    return {
        jobId: id,
        unionId: UNION_ID,
        status: input.status,
        progress: input.status === 'PROCESSING' ? 50 : 100,
        landAreaSync: {
            anchorPnu: PNU,
            admissionKey: input.admissionKey ?? id,
            sourceDiscoveryJobId:
                input.sourceDiscoveryJobId === undefined
                    ? null
                    : input.sourceDiscoveryJobId,
            scopeState: input.scopeState,
            scopeSnapshot:
                input.scopeSnapshot === undefined
                    ? snapshot()
                    : input.scopeSnapshot,
            ...((input.includeWorkerFinalization ??
            (input.status !== 'PROCESSING'))
                ? {
                      workerFinalization: {
                          version: 1,
                          finalizedAt: '2026-07-25T00:00:30.000Z',
                      },
                  }
                : {}),
            branch: 'LADFRL',
            outcome: input.outcome,
            counts: {
                updatedPropertyUnits: input.outcome === 'APPLIED' ? 1 : 0,
                unchangedPropertyUnits: 0,
            },
            issues: (input.issueCodes ?? []).map((code) => ({ code })),
            issuesTotal:
                input.issuesTotal ?? input.issueCodes?.length ?? 0,
            issuesTruncated: input.issuesTruncated ?? false,
        },
    };
}

function validRunArtifact(): DevelopmentRunArtifact {
    const identityDigest = '6'.repeat(64);
    const nonTargetTupleDigest = '7'.repeat(64);
    return {
        version: DEVELOPMENT_RUN_ARTIFACT_VERSION,
        databaseTarget: 'development',
        unionId: UNION_ID,
        targetCount: 1,
        manifestDigest: computeDevelopmentTargetDigest(UNION_ID, [PNU]),
        expectedPropertyUnitCount: 1,
        observedPropertyUnitCount: 1,
        startedAt: '2026-07-25T00:00:00.000Z',
        completedAt: '2026-07-25T00:01:00.000Z',
        preflight: {
            activePropertyUnitCount: 1,
            activePnuCount: 1,
            positiveLandAreaCount: 0,
            identityDigest,
            tupleDigest: '8'.repeat(64),
            nonTargetTupleDigest,
        },
        postflight: {
            activePropertyUnitCount: 1,
            activePnuCount: 1,
            positiveLandAreaCount: 1,
            identityDigest,
            tupleDigest: '9'.repeat(64),
            nonTargetTupleDigest,
        },
        relationGisPreflight: null,
        relationGisPostflight: null,
        landRightPreflight: null,
        landRightPostflight: null,
        landRightWriteAttribution: null,
        writeAttribution: {
            writerJobCount: 1,
            attributedPropertyUnitCount: 1,
            attributionDigest: 'b'.repeat(64),
        },
        results: [
            {
                pnu: PNU,
                admission: 'NEW_DISCOVERY',
                discoveryJobId: DISCOVERY_JOB_ID,
                applyJobId: APPLY_JOB_ID,
                writerJobId: APPLY_JOB_ID,
                status: 'COMPLETED',
                strategy: 'LADFRL',
                scopeState: 'SINGLE_PNU_CONFIRMED',
                outcome: 'APPLIED',
                updatedPropertyUnits: 1,
                unchangedPropertyUnits: 0,
                issueCodes: [],
            },
        ],
        gate: {
            status: 'PASS',
            failureCode: null,
            stoppedBeforePnu: null,
        },
    };
}

function fullRefreshRelationGisSnapshot():
    DevelopmentRelationGisInvariantSnapshot {
    const tables = Object.fromEntries(
        DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES.map(
            (table, index) => [
                table,
                {
                    rowCount: index + 1,
                    digest: sha256Utf8(`relation-gis:${table}`),
                },
            ]
        )
    ) as DevelopmentRelationGisInvariantSnapshot['tables'];
    return {
        scopePnuCount: 301,
        propertyUnitCount: 429,
        tables,
        aggregateDigest: sha256Utf8(
            JSON.stringify(
                DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES.map(
                    (table) => ({
                        table,
                        ...tables[table],
                    })
                )
            )
        ),
    };
}

function validFullRefreshRunArtifact(): {
    artifact: DevelopmentRunArtifact;
    targetManifest: DevelopmentTargetManifestV3;
} {
    const targetManifest = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(FULL_REFRESH_TARGET_MANIFEST_URL, 'utf8')
        )
    );
    assert.equal(
        targetManifest.version,
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    );
    if (
        targetManifest.version !==
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    ) {
        throw new Error('v3 full refresh target expected');
    }
    const relationGis = fullRefreshRelationGisSnapshot();
    const rights = {
        rowCount: 0,
        targetRowCount: 0,
        activeTargetRowCount: 0,
        allRowsDigest: sha256Utf8('land-rights:all:empty'),
        nonTargetRowsDigest: sha256Utf8(
            'land-rights:non-target:empty'
        ),
    };
    return {
        targetManifest,
        artifact: {
            version: DEVELOPMENT_RUN_ARTIFACT_VERSION,
            databaseTarget: 'development',
            unionId: targetManifest.unionId,
            targetCount: targetManifest.targetCount,
            manifestDigest: targetManifest.manifestDigest,
            expectedPropertyUnitCount:
                targetManifest.expectedPropertyUnitCount,
            observedPropertyUnitCount:
                targetManifest.expectedPropertyUnitCount,
            startedAt: '2026-07-28T00:00:00.000Z',
            completedAt: '2026-07-28T03:00:00.000Z',
            preflight: {
                activePropertyUnitCount: 429,
                activePnuCount: 299,
                positiveLandAreaCount: 0,
                identityDigest: sha256Utf8(
                    'full-refresh-property-identity'
                ),
                tupleDigest: sha256Utf8(
                    'full-refresh-preflight-tuples'
                ),
                nonTargetTupleDigest: sha256Utf8(
                    'full-refresh-non-target-tuples'
                ),
            },
            postflight: {
                activePropertyUnitCount: 429,
                activePnuCount: 299,
                positiveLandAreaCount: 429,
                identityDigest: sha256Utf8(
                    'full-refresh-property-identity'
                ),
                tupleDigest: sha256Utf8(
                    'full-refresh-postflight-tuples'
                ),
                nonTargetTupleDigest: sha256Utf8(
                    'full-refresh-non-target-tuples'
                ),
            },
            relationGisPreflight: relationGis,
            relationGisPostflight: structuredClone(relationGis),
            landRightPreflight: rights,
            landRightPostflight: { ...rights },
            landRightWriteAttribution: {
                changedRowCount: 0,
                writerJobCount: 0,
                attributedPropertyUnitCount: 0,
                attributionDigest: sha256Utf8(
                    'full-refresh-land-right-attribution-empty'
                ),
            },
            writeAttribution: {
                writerJobCount: 1,
                attributedPropertyUnitCount: 429,
                attributionDigest: sha256Utf8(
                    'full-refresh-property-attribution'
                ),
            },
            results: targetManifest.anchors.map((pnu, index) => ({
                pnu,
                admission: 'NEW_DISCOVERY',
                discoveryJobId: DISCOVERY_JOB_ID,
                applyJobId: APPLY_JOB_ID,
                writerJobId: APPLY_JOB_ID,
                status: 'COMPLETED',
                strategy: 'LADFRL',
                scopeState: 'SINGLE_PNU_CONFIRMED',
                outcome: 'APPLIED',
                updatedPropertyUnits: index < 151 ? 2 : 1,
                unchangedPropertyUnits: 0,
                issueCodes: [],
            })),
            gate: {
                status: 'PASS',
                failureCode: null,
                stoppedBeforePnu: null,
            },
        },
    };
}

function numberedUuid(prefix: string, index: number): string {
    return `${prefix}-0000-4000-8000-${String(index + 1).padStart(
        12,
        '0'
    )}`;
}

function fullRefreshRuntimeFixture(input: {
    ldaregAnchorIndex?: number;
    parcelAnchorIndex?: number;
} = {}): {
    targetManifest: DevelopmentTargetManifestV3;
    evidenceManifest: DevelopmentEvidenceManifest;
    preRows: DevelopmentActivePropertyUnit[];
    postRows: DevelopmentActivePropertyUnit[];
    writerJobIdByPnu: Map<string, string>;
    terminalByJobId: Map<string, LandAreaSyncApiJob>;
} {
    const parsed = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(FULL_REFRESH_TARGET_MANIFEST_URL, 'utf8')
        )
    );
    assert.equal(
        parsed.version,
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    );
    if (
        parsed.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    ) {
        throw new Error('v3 full refresh target expected');
    }
    const extraPnus = parsed.allowedScopePnus.filter(
        (pnu) => !parsed.anchors.includes(pnu)
    );
    const scannedPnusByAnchor = new Map(
        parsed.anchors.map((anchor, index) => [
            anchor,
            index === 0
                ? [anchor, ...extraPnus].sort()
                : [anchor],
        ])
    );
    const anchorByPnu = new Map<string, string>();
    for (const [anchor, scannedPnus] of scannedPnusByAnchor) {
        for (const pnu of scannedPnus) {
            anchorByPnu.set(pnu, anchor);
        }
    }
    const propertyRowsByAnchor = new Map<
        string,
        Array<{ id: string; pnu: string }>
    >(parsed.anchors.map((anchor) => [anchor, []]));
    let propertyIndex = 0;
    for (const pnu of parsed.expectedUnionActivePnus) {
        const anchor = anchorByPnu.get(pnu);
        assert.ok(anchor, `active PNU ${pnu} component missing`);
        propertyRowsByAnchor.get(anchor!)!.push({
            id: numberedUuid('10000000', propertyIndex),
            pnu,
        });
        propertyIndex += 1;
    }
    while (propertyIndex < parsed.expectedPropertyUnitCount) {
        propertyRowsByAnchor.get(parsed.anchors[0])!.push({
            id: numberedUuid('10000000', propertyIndex),
            pnu: parsed.anchors[0],
        });
        propertyIndex += 1;
    }
    const writerJobIdByPnu = new Map(
        parsed.anchors.map((pnu, index) => [
            pnu,
            numberedUuid('20000000', index),
        ])
    );
    const marker = developmentFullRefreshMarkerForTarget(parsed)!;
    if (
        input.ldaregAnchorIndex !== undefined &&
        input.parcelAnchorIndex !== undefined
    ) {
        assert.notEqual(
            input.ldaregAnchorIndex,
            input.parcelAnchorIndex,
            'LDAREG와 parcel fixture anchor는 분리한다'
        );
    }
    const entries = parsed.anchors.map((anchor, index) => {
        const strategy =
            index === input.ldaregAnchorIndex
                ? ('LDAREG' as const)
                : ('LADFRL' as const);
        const scannedPnus = scannedPnusByAnchor.get(anchor)!;
        const properties = propertyRowsByAnchor
            .get(anchor)!
            .sort((left, right) => left.id.localeCompare(right.id));
        const officialComponentDigest = sha256Utf8(
            `official-component:${anchor}`
        );
        const officialParcelDigest = sha256Utf8(
            `official-parcel:${anchor}`
        );
        return {
            anchorPnu: anchor,
            expectedStrategy: strategy,
            expectedScannedPnus: scannedPnus,
            expectedPropertyUnitIds: properties.map(
                (property) => property.id
            ),
            expectedProposedLandAreas: properties.map(
                (property) => ({
                    propertyUnitId: property.id,
                    landArea: '1',
                })
            ),
            expectedLadfrlAreaEvidence: {
                parcels: scannedPnus.map((pnu) => ({
                    pnu,
                    area: '1',
                })),
                totalArea: String(scannedPnus.length),
            },
            allowedPrestates: properties.map((property) => ({
                propertyUnitId: property.id,
                landArea: null,
                landAreaSource: 'LEGACY_UNKNOWN' as const,
            })),
            parcelScopeEvidence: {
                kind: 'API_RELATION_CROSS_CHECK' as const,
                ref: `capture=${index + 1}`,
            },
            landOwnershipEvidence:
                strategy === 'LADFRL'
                    ? {
                          kind: 'LAND_LEDGER_COPY' as const,
                          ref: `capture=${index + 1}`,
                      }
                    : null,
            allowManualOverwrite: true,
            sourceReferences:
                index === input.parcelAnchorIndex
                    ? {
                          kind:
                              'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_PARCEL_CAPTURE' as const,
                          captureRunId: String(
                              40000000 + index
                          ),
                          snapshotReferenceSha256:
                              sha256Utf8(
                                  `snapshot:${anchor}`
                              ),
                          officialParcelDigest,
                      }
                    : {
                          kind:
                              'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_CAPTURE' as const,
                          captureRunId: String(
                              40000000 + index
                          ),
                          snapshotReferenceSha256:
                              sha256Utf8(
                                  `snapshot:${anchor}`
                              ),
                          officialComponentDigest,
                      },
        } satisfies DevelopmentEvidenceEntry;
    });
    const evidenceManifest: DevelopmentEvidenceManifest = {
        version: DEVELOPMENT_EVIDENCE_MANIFEST_VERSION_V2,
        databaseTarget: 'development',
        unionId: parsed.unionId,
        manifestDigest: parsed.manifestDigest,
        entries,
    };
    const preRows = entries.flatMap((entry) =>
        propertyRowsByAnchor.get(entry.anchorPnu)!.map((property) => ({
            id: property.id,
            pnu: property.pnu,
            landArea: null,
            landAreaSource: 'LEGACY_UNKNOWN' as const,
            landAreaSyncedAt: null,
            landAreaSyncJobId: null,
        }))
    );
    const postRows = entries.flatMap((entry) => {
        const writerJobId = writerJobIdByPnu.get(
            entry.anchorPnu
        )!;
        return propertyRowsByAnchor
            .get(entry.anchorPnu)!
            .map((property) => ({
                id: property.id,
                pnu: property.pnu,
                landArea: '1',
                landAreaSource: entry.expectedStrategy,
                landAreaSyncedAt:
                    '2026-07-28T00:01:00.000Z',
                landAreaSyncJobId: writerJobId,
            }));
    });
    const terminalByJobId = new Map<string, LandAreaSyncApiJob>();
    for (const entry of entries) {
        const writerJobId = writerJobIdByPnu.get(
            entry.anchorPnu
        )!;
        const officialComponentDigest =
            entry.sourceReferences.kind ===
            'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_CAPTURE'
                ? entry.sourceReferences.officialComponentDigest
                : HASH;
        const officialParcelDigest =
            entry.sourceReferences.kind ===
            'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_PARCEL_CAPTURE'
                ? entry.sourceReferences.officialParcelDigest
                : null;
        terminalByJobId.set(writerJobId, {
            jobId: writerJobId,
            unionId: parsed.unionId,
            status: 'COMPLETED',
            progress: 100,
            landAreaSync: {
                anchorPnu: entry.anchorPnu,
                sourceDiscoveryJobId: null,
                developmentFullRefresh: marker,
                admissionKey: writerJobId,
                workerFinalization: {
                    version: 1,
                    finalizedAt: '2026-07-28T00:01:00.000Z',
                },
                scopeState: 'SINGLE_PNU_CONFIRMED',
                scopeSnapshot: {
                    frozenAt: '2026-07-28T00:00:30.000Z',
                    strategy: entry.expectedStrategy,
                    scannedPnus: entry.expectedScannedPnus,
                    ...(officialParcelDigest
                        ? {
                              developmentFullRefreshParcelResolution:
                                  {
                                      source:
                                          'SAME_RUN_OFFICIAL_DEVELOPMENT_PARCEL_SINGLETON',
                                      canonicalPnu:
                                          entry.anchorPnu,
                                      memberPnus:
                                          entry.expectedScannedPnus,
                                      officialParcelDigest,
                                      manifestDigest:
                                          marker.manifestDigest,
                                      scopeDigest:
                                          marker.scopeDigest,
                                  },
                          }
                        : {
                              developmentFullRefreshScopeResolution:
                                  {
                                      source:
                                          'SAME_RUN_OFFICIAL_DEVELOPMENT_FULL_REFRESH',
                                      canonicalBasePnu:
                                          entry.anchorPnu,
                                      memberPnus:
                                          entry.expectedScannedPnus,
                                      managementPk: `management-${entry.anchorPnu}`,
                                      pairCount:
                                          entry
                                              .expectedScannedPnus
                                              .length - 1,
                                      officialComponentDigest,
                                      manifestDigest:
                                          marker.manifestDigest,
                                      scopeDigest:
                                          marker.scopeDigest,
                                  },
                          }),
                    scopeHash: sha256Utf8(
                        `scope:${entry.anchorPnu}`
                    ),
                    candidatePropertyUnitIds:
                        entry.expectedPropertyUnitIds,
                    proposedLandAreas:
                        entry.expectedProposedLandAreas,
                    ladfrlAreaEvidence: {
                        version: 'land-area-sync.ladfrl-scope.v1',
                        ...entry.expectedLadfrlAreaEvidence,
                    },
                } as LandAreaSyncScopeSnapshot,
                branch: entry.expectedStrategy,
                outcome: 'APPLIED',
                counts: {
                    updatedPropertyUnits:
                        entry.expectedPropertyUnitIds.length,
                    unchangedPropertyUnits: 0,
                },
                issues: [],
                issuesTotal: 0,
                issuesTruncated: false,
            },
        });
    }
    return {
        targetManifest: parsed,
        evidenceManifest,
        preRows,
        postRows,
        writerJobIdByPnu,
        terminalByJobId,
    };
}

async function runFullRefreshRuntime(input: {
    omitRelationReader?: boolean;
    mutateRelationPost?: boolean;
    ldaregAnchorIndex?: number;
    parcelAnchorIndex?: number;
    wrongLandRightWriter?: boolean;
} = {}): Promise<{
    artifact: DevelopmentRunArtifact;
    targetManifest: DevelopmentTargetManifestV3;
    admissionCount: number;
    latestReadCount: number;
}> {
    const fixture = fullRefreshRuntimeFixture({
        ldaregAnchorIndex: input.ldaregAnchorIndex,
        parcelAnchorIndex: input.parcelAnchorIndex,
    });
    let admissionCount = 0;
    let latestReadCount = 0;
    let activeReadCount = 0;
    let relationReadCount = 0;
    let landRightReadCount = 0;
    let admissionKeyIndex = 0;
    const relationRows = () =>
        Object.fromEntries(
            DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES.map(
                (table) => [table, []]
            )
        ) as Record<
            (typeof DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES)[number],
            Array<Record<string, unknown>>
        >;
    const reader: DevelopmentReadOnlyPreflightReader = {
        async readActivePropertyUnits() {
            activeReadCount += 1;
            return activeReadCount === 1 || admissionCount === 0
                ? fixture.preRows
                : fixture.postRows;
        },
        async readPropertyUnitsBySyncJobIds(jobIds) {
            assert.deepEqual(
                jobIds,
                [...fixture.writerJobIdByPnu.values()].sort()
            );
            return fixture.postRows.map((row) => ({
                id: row.id,
                unionId: fixture.targetManifest.unionId,
                landAreaSyncJobId: row.landAreaSyncJobId!,
            }));
        },
        ...(input.omitRelationReader
            ? {}
            : {
                  async readRelationGisInvariantRows() {
                      relationReadCount += 1;
                      const rows = relationRows();
                      if (
                          input.mutateRelationPost &&
                          relationReadCount > 1
                      ) {
                          rows.buildings = [
                              {
                                  building_id:
                                      'postflight-mutation',
                              },
                          ];
                      }
                      return rows;
                  },
              }),
        async readPropertyUnitLandRights() {
            landRightReadCount += 1;
            if (landRightReadCount === 1) return [];
            const rights: Array<Record<string, unknown>> = [];
            for (const entry of fixture.evidenceManifest.entries) {
                if (entry.expectedStrategy !== 'LDAREG') continue;
                const writerJobId =
                    fixture.writerJobIdByPnu.get(
                        entry.anchorPnu
                    )!;
                for (const propertyUnitId of entry.expectedPropertyUnitIds) {
                    rights.push({
                        union_id:
                            fixture.targetManifest.unionId,
                        property_unit_id: propertyUnitId,
                        target_pnu: entry.expectedScannedPnus[0],
                        lifecycle_status: 'ACTIVE',
                        last_seen_sync_job_id:
                            input.wrongLandRightWriter
                                ? numberedUuid('90000000', 0)
                                : writerJobId,
                        last_evaluated_sync_job_id:
                            input.wrongLandRightWriter
                                ? numberedUuid('90000000', 0)
                                : writerJobId,
                    });
                }
            }
            return rights;
        },
    };
    const marker = developmentFullRefreshMarkerForTarget(
        fixture.targetManifest
    )!;
    const artifact = await runDevelopmentLandAreaSync({
        target: fixture.targetManifest,
        dbApproval: approval(fixture.targetManifest),
        evidence: fixture.evidenceManifest,
        client: {
            async getLatest() {
                latestReadCount += 1;
                return null;
            },
            async getJob(_unionId, jobId) {
                const terminal =
                    fixture.terminalByJobId.get(jobId);
                assert.ok(terminal, `terminal ${jobId} missing`);
                return terminal!;
            },
            async admitDiscovery(
                unionId,
                pnu,
                _admissionKey,
                developmentFullRefresh
            ) {
                admissionCount += 1;
                assert.equal(
                    unionId,
                    fixture.targetManifest.unionId
                );
                assert.deepEqual(
                    developmentFullRefresh,
                    marker
                );
                return fixture.writerJobIdByPnu.get(pnu)!;
            },
            async confirmDiscovery() {
                throw new Error('direct APPLIED fixture must not confirm');
            },
        },
        preflightReader: reader,
        createAdmissionKey: () =>
            numberedUuid(
                '30000000',
                admissionKeyIndex++
            ),
        sleep: async () => undefined,
        now: () => new Date('2026-07-28T00:00:00.000Z'),
    });
    return {
        artifact,
        targetManifest: fixture.targetManifest,
        admissionCount,
        latestReadCount,
    };
}

async function runTwoTargetPartialFailure(input: {
    mutateUnfinalizedTarget?: boolean;
    attributionUnionId?: string;
} = {}): Promise<{
    artifact: DevelopmentRunArtifact;
    targetManifest: DevelopmentTargetManifest;
    activeReads: number;
    attributionReads: number;
}> {
    const targetManifest = target([PNU, SECOND_PNU], 2);
    const evidenceManifest = evidence(targetManifest, [
        evidenceEntry(PNU, PROPERTY_UNIT_ID),
        evidenceEntry(SECOND_PNU, SECOND_PROPERTY_UNIT_ID),
    ]);
    let activeReads = 0;
    let attributionReads = 0;
    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client: {
            async getLatest(_unionId, pnu) {
                if (pnu === SECOND_PNU) {
                    throw new Error('second anchor failed');
                }
                return job(APPLY_JOB_ID, {
                    status: 'PROCESSING',
                    scopeState: 'SINGLE_PNU_CONFIRMED',
                    outcome: null,
                    sourceDiscoveryJobId: DISCOVERY_JOB_ID,
                    includeWorkerFinalization: false,
                });
            },
            async getJob() {
                return job(APPLY_JOB_ID, {
                    status: 'COMPLETED',
                    scopeState: 'SINGLE_PNU_CONFIRMED',
                    outcome: 'APPLIED',
                    sourceDiscoveryJobId: DISCOVERY_JOB_ID,
                });
            },
            async admitDiscovery() {
                throw new Error('호출되면 안 됨');
            },
            async confirmDiscovery() {
                throw new Error('호출되면 안 됨');
            },
        },
        preflightReader: {
            async readActivePropertyUnits() {
                activeReads += 1;
                const isPostflight = activeReads > 1;
                const firstApplied = isPostflight;
                const secondApplied =
                    isPostflight &&
                    input.mutateUnfinalizedTarget === true;
                return [
                    {
                        id: PROPERTY_UNIT_ID,
                        pnu: PNU,
                        landArea: firstApplied ? '161' : null,
                        landAreaSource: firstApplied
                            ? ('LADFRL' as const)
                            : ('LEGACY_UNKNOWN' as const),
                        landAreaSyncedAt: firstApplied
                            ? '2026-07-25T00:01:00.000Z'
                            : null,
                        landAreaSyncJobId: firstApplied
                            ? APPLY_JOB_ID
                            : null,
                    },
                    {
                        id: SECOND_PROPERTY_UNIT_ID,
                        pnu: SECOND_PNU,
                        landArea: secondApplied ? '161' : null,
                        landAreaSource: secondApplied
                            ? ('LADFRL' as const)
                            : ('LEGACY_UNKNOWN' as const),
                        landAreaSyncedAt: secondApplied
                            ? '2026-07-25T00:01:00.000Z'
                            : null,
                        landAreaSyncJobId: secondApplied
                            ? SECOND_APPLY_JOB_ID
                            : null,
                    },
                ];
            },
            async readPropertyUnitsBySyncJobIds(jobIds) {
                attributionReads += 1;
                assert.deepEqual(jobIds, [APPLY_JOB_ID]);
                return [
                    {
                        id: PROPERTY_UNIT_ID,
                        unionId:
                            input.attributionUnionId ?? UNION_ID,
                        landAreaSyncJobId: APPLY_JOB_ID,
                    },
                ];
            },
        },
        sleep: async () => undefined,
    });
    return {
        artifact,
        targetManifest,
        activeReads,
        attributionReads,
    };
}

test('공개 artifact는 집계와 digest allowlist만 남기고 raw 식별자·secret·target 배열을 제거한다', () => {
    const targetManifest = target();
    const fullArtifact = validRunArtifact();
    validateDevelopmentRunArtifact(fullArtifact, targetManifest);
    const secretSentinel = 'never-publish-development-secret';
    const pollutedRuntimeValue = {
        ...fullArtifact,
        rawSecret: secretSentinel,
        targetPnus: [PNU],
        propertyUnitIds: [PROPERTY_UNIT_ID],
    } as DevelopmentRunArtifact;
    const publicArtifact = createDevelopmentPublicRunArtifact(
        pollutedRuntimeValue,
        'mia-seven-representative-20260725'
    );

    assert.equal(
        publicArtifact.version,
        DEVELOPMENT_PUBLIC_RUN_ARTIFACT_VERSION
    );
    assert.deepEqual(Object.keys(publicArtifact).sort(), [
        'aggregateCounts',
        'databaseTarget',
        'digests',
        'gate',
        'landRightTransition',
        'manifestLabel',
        'outcomeCounts',
        'relationGisInvariant',
        'strategyCounts',
        'version',
    ]);
    assert.doesNotThrow(() =>
        validateDevelopmentPublicRunArtifact(
            publicArtifact,
            'mia-seven-representative-20260725'
        )
    );
    assert.deepEqual(publicArtifact.strategyCounts, {
        LADFRL: 1,
        LDAREG: 0,
        NONE: 0,
    });
    assert.deepEqual(publicArtifact.outcomeCounts, {
        APPLIED: 1,
        PARTIAL: 0,
        NO_DATA: 0,
        REVIEW_REQUIRED: 0,
        FAILED: 0,
        NONE: 0,
    });

    const serialized = JSON.stringify(publicArtifact);
    for (const forbiddenValue of [
        UNION_ID,
        PNU,
        PROPERTY_UNIT_ID,
        DISCOVERY_JOB_ID,
        APPLY_JOB_ID,
        secretSentinel,
        fullArtifact.startedAt,
        fullArtifact.completedAt,
    ]) {
        assert.doesNotMatch(serialized, new RegExp(forbiddenValue));
    }
    for (const forbiddenKey of [
        '"unionId"',
        '"pnu"',
        '"pnus"',
        '"jobId"',
        '"writerJobId"',
        '"propertyUnitId"',
        '"propertyUnitIds"',
        '"results"',
        '"targets"',
        '"startedAt"',
        '"completedAt"',
        '"rawSecret"',
    ]) {
        assert.equal(serialized.includes(forbiddenKey), false);
    }
    assert.throws(
        () =>
            validateDevelopmentPublicRunArtifact(
                { ...publicArtifact, unionId: UNION_ID },
                'mia-seven-representative-20260725'
            ),
        /PUBLIC_RUN_ARTIFACT_INVALID/
    );
    assert.throws(
        () =>
            validateDevelopmentPublicRunArtifact(
                {
                    ...publicArtifact,
                    aggregateCounts: {
                        ...publicArtifact.aggregateCounts,
                        writerJobCount: null,
                    },
                },
                'mia-seven-representative-20260725'
        ),
        /PUBLIC_RUN_ARTIFACT_INVALID/
    );

    const identityFailureArtifact: DevelopmentRunArtifact = {
        ...fullArtifact,
        postflight: {
            ...fullArtifact.postflight!,
            identityDigest: '0'.repeat(64),
        },
        gate: {
            status: 'FAIL',
            failureCode: 'POSTFLIGHT_PROPERTY_IDENTITY_CHANGED',
            stoppedBeforePnu: null,
        },
    };
    assert.doesNotThrow(() =>
        validateDevelopmentRunArtifact(
            identityFailureArtifact,
            targetManifest
        )
    );
    assert.throws(
        () =>
            validateDevelopmentRunArtifact(
                {
                    ...identityFailureArtifact,
                    gate: {
                        ...identityFailureArtifact.gate,
                        failureCode: 'UNEXPECTED_RUNNER_ERROR',
                    },
                },
                targetManifest
            ),
        /RUN_ARTIFACT_IDENTITY_CHANGED/
    );
});

test('미아7 전체 재조회 private/public artifact는 공식 278 구성요소·301 조회 PNU·429 물건과 relation/rights 게이트를 고정한다', () => {
    const { artifact, targetManifest } =
        validFullRefreshRunArtifact();
    assert.doesNotThrow(() =>
        validateDevelopmentRunArtifact(artifact, targetManifest)
    );
    const publicArtifact = createDevelopmentPublicRunArtifact(
        artifact,
        'mia-seven-full-278-official-components-api-readonly-20260729'
    );
    assert.doesNotThrow(() =>
        validateDevelopmentPublicRunArtifact(
            publicArtifact,
            'mia-seven-full-278-official-components-api-readonly-20260729'
        )
    );
    assert.equal(publicArtifact.aggregateCounts.targetCount, 278);
    assert.equal(
        publicArtifact.aggregateCounts.expectedPropertyUnitCount,
        429
    );
    assert.equal(
        publicArtifact.relationGisInvariant.preflight
            ?.scopePnuCount,
        301
    );
    assert.deepEqual(publicArtifact.strategyCounts, {
        LADFRL: 278,
        LDAREG: 0,
        NONE: 0,
    });
});

test('미아7 전체 재조회는 VERIFIED_NO_DATA 결과를 PASS로 승격하지 않는다', () => {
    const { artifact, targetManifest } =
        validFullRefreshRunArtifact();
    const forged = structuredClone(artifact);
    forged.results[0] = {
        ...forged.results[0],
        applyJobId: null,
        writerJobId: null,
        strategy: null,
        scopeState: 'LINKED_SCOPE_RESOLVED',
        outcome: 'NO_DATA',
        updatedPropertyUnits: 0,
        unchangedPropertyUnits: 2,
    };
    assert.throws(
        () =>
            validateDevelopmentRunArtifact(forged, targetManifest),
        /RUN_ARTIFACT_RESULT_WRITER_INVALID/
    );
});

test('미아7 전체 공개 artifact는 relation/rights 누락 또는 변조 digest를 PASS로 공개하지 않는다', () => {
    const { artifact, targetManifest } =
        validFullRefreshRunArtifact();
    const publicArtifact = createDevelopmentPublicRunArtifact(
        artifact,
        'mia-seven-full-278-official-components-api-readonly-20260729'
    );
    assert.throws(
        () =>
            validateDevelopmentPublicRunArtifact(
                {
                    ...publicArtifact,
                    relationGisInvariant: {
                        ...publicArtifact.relationGisInvariant,
                        preflight: null,
                    },
                },
                'mia-seven-full-278-official-components-api-readonly-20260729'
            ),
        /PUBLIC_RUN_ARTIFACT_INVALID/
    );
    assert.throws(
        () =>
            validateDevelopmentPublicRunArtifact(
                {
                    ...publicArtifact,
                    relationGisInvariant: {
                        ...publicArtifact.relationGisInvariant,
                        preflight: {
                            ...publicArtifact.relationGisInvariant
                                .preflight!,
                            aggregateDigest: '0'.repeat(64),
                        },
                    },
                },
                'mia-seven-full-278-official-components-api-readonly-20260729'
            ),
        /PUBLIC_RUN_ARTIFACT_INVALID/
    );
    assert.throws(
        () =>
            validateDevelopmentPublicRunArtifact(
                {
                    ...publicArtifact,
                    landRightTransition: {
                        preflight: null,
                        postflight: null,
                        writeAttribution: null,
                    },
                },
                'mia-seven-full-278-official-components-api-readonly-20260729'
            ),
        /PUBLIC_RUN_ARTIFACT_INVALID/
    );
    assert.doesNotThrow(() =>
        validateDevelopmentRunArtifact(artifact, targetManifest)
    );
});

test('relation/GIS 변이는 정확한 FAIL code로만 artifact에 남고 PASS 위장은 거부된다', () => {
    const { artifact, targetManifest } =
        validFullRefreshRunArtifact();
    const mutatedPost = structuredClone(
        artifact.relationGisPostflight!
    );
    mutatedPost.tables.buildings = {
        rowCount: mutatedPost.tables.buildings.rowCount + 1,
        digest: sha256Utf8('mutated-buildings'),
    };
    mutatedPost.aggregateDigest = sha256Utf8(
        JSON.stringify(
            DEVELOPMENT_RELATION_GIS_INVARIANT_TABLES.map(
                (table) => ({
                    table,
                    ...mutatedPost.tables[table],
                })
            )
        )
    );
    const passMutation: DevelopmentRunArtifact = {
        ...artifact,
        relationGisPostflight: mutatedPost,
    };
    assert.throws(
        () =>
            validateDevelopmentRunArtifact(
                passMutation,
                targetManifest
            ),
        /RUN_ARTIFACT_RELATION_GIS_CHANGED/
    );
    assert.throws(
        () =>
            createDevelopmentPublicRunArtifact(
                passMutation,
                'mia-seven-full-278-official-components-api-readonly-20260729'
            ),
        /PUBLIC_RUN_ARTIFACT_INVALID/
    );

    const truthfulFailure: DevelopmentRunArtifact = {
        ...passMutation,
        gate: {
            status: 'FAIL',
            failureCode: 'POSTFLIGHT_RELATION_GIS_CHANGED',
            stoppedBeforePnu: null,
        },
    };
    assert.doesNotThrow(() =>
        validateDevelopmentRunArtifact(
            truthfulFailure,
            targetManifest
        )
    );
    assert.doesNotThrow(() =>
        createDevelopmentPublicRunArtifact(
            truthfulFailure,
            'mia-seven-full-278-official-components-api-readonly-20260729'
        )
    );
});

test('비대상 대지권 변이는 정확한 FAIL로만 보존되고 PASS 위장은 거부된다', () => {
    const { artifact, targetManifest } =
        validFullRefreshRunArtifact();
    const passMutation: DevelopmentRunArtifact = {
        ...artifact,
        landRightPostflight: {
            ...artifact.landRightPostflight!,
            allRowsDigest: sha256Utf8(
                'mutated-all-land-right-rows'
            ),
            nonTargetRowsDigest: sha256Utf8(
                'mutated-non-target-land-right-rows'
            ),
        },
    };
    assert.throws(
        () =>
            validateDevelopmentRunArtifact(
                passMutation,
                targetManifest
            ),
        /RUN_ARTIFACT_LAND_RIGHT_NON_TARGET_CHANGED/
    );
    assert.throws(
        () =>
            createDevelopmentPublicRunArtifact(
                passMutation,
                'mia-seven-full-278-official-components-api-readonly-20260729'
            ),
        /PUBLIC_RUN_ARTIFACT_INVALID/
    );

    const truthfulFailure: DevelopmentRunArtifact = {
        ...passMutation,
        gate: {
            status: 'FAIL',
            failureCode:
                'POSTFLIGHT_LAND_RIGHT_NON_TARGET_CHANGED',
            stoppedBeforePnu: null,
        },
    };
    assert.doesNotThrow(() =>
        validateDevelopmentRunArtifact(
            truthfulFailure,
            targetManifest
        )
    );
    assert.doesNotThrow(() =>
        createDevelopmentPublicRunArtifact(
            truthfulFailure,
            'mia-seven-full-278-official-components-api-readonly-20260729'
        )
    );
});

test('전체 재조회는 relation/GIS reader 누락 시 첫 API admission 전에 중단한다', async () => {
    const {
        artifact,
        targetManifest,
        admissionCount,
        latestReadCount,
    } = await runFullRefreshRuntime({
        omitRelationReader: true,
    });
    assert.equal(admissionCount, 0);
    assert.equal(latestReadCount, 0);
    assert.equal(artifact.results.length, 0);
    assert.deepEqual(artifact.gate, {
        status: 'FAIL',
        failureCode: 'PREFLIGHT_RELATION_GIS_READER_MISSING',
        stoppedBeforePnu: targetManifest.anchors[0],
    });
    assert.doesNotThrow(() =>
        validateDevelopmentRunArtifact(artifact, targetManifest)
    );
});

test('전체 재조회 runtime은 relation/GIS postflight 변이를 정확한 FAIL artifact로 만든다', async () => {
    const {
        artifact,
        targetManifest,
        admissionCount,
        latestReadCount,
    } = await runFullRefreshRuntime({
        mutateRelationPost: true,
    });
    assert.equal(admissionCount, targetManifest.targetCount);
    assert.equal(latestReadCount, 0);
    assert.equal(
        artifact.results.length,
        targetManifest.targetCount
    );
    assert.equal(artifact.gate.status, 'FAIL');
    assert.equal(
        artifact.gate.failureCode,
        'POSTFLIGHT_RELATION_GIS_CHANGED'
    );
    assert.notEqual(
        artifact.relationGisPreflight?.aggregateDigest,
        artifact.relationGisPostflight?.aggregateDigest
    );
    assert.doesNotThrow(() =>
        validateDevelopmentRunArtifact(artifact, targetManifest)
    );
    assert.doesNotThrow(() =>
        createDevelopmentPublicRunArtifact(
            artifact,
            'mia-seven-full-278-official-components-api-readonly-20260729'
        )
    );
});

test('전체 재조회 runtime은 별도 공식 parcel digest를 재검증하고 component 위조 없이 PASS한다', async () => {
    const {
        artifact,
        targetManifest,
        admissionCount,
    } = await runFullRefreshRuntime({
        parcelAnchorIndex: 1,
    });
    assert.equal(admissionCount, targetManifest.targetCount);
    assert.deepEqual(artifact.gate, {
        status: 'PASS',
        failureCode: null,
        stoppedBeforePnu: null,
    });
    assert.doesNotThrow(() =>
        validateDevelopmentRunArtifact(
            artifact,
            targetManifest
        )
    );
});

test('전체 재조회 runner는 parcel provenance의 LDAREG·복수 property 위조를 API admission 전에 거부한다', () => {
    const fixture = fullRefreshRuntimeFixture({
        parcelAnchorIndex: 1,
    });
    const parcelIndex =
        fixture.evidenceManifest.entries.findIndex(
            (entry) =>
                'kind' in entry.sourceReferences &&
                entry.sourceReferences.kind ===
                    'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_PARCEL_CAPTURE'
        );
    assert.notEqual(parcelIndex, -1);

    const ldaregForgery = structuredClone(
        fixture.evidenceManifest
    );
    ldaregForgery.entries[parcelIndex].expectedStrategy =
        'LDAREG';
    assert.throws(
        () =>
            validateDevelopmentRunnerManifests(
                fixture.targetManifest,
                approval(fixture.targetManifest),
                ldaregForgery
            ),
        /FULL_REFRESH_PARCEL_EVIDENCE_SHAPE_MISMATCH/
    );

    const multiplePropertyForgery = structuredClone(
        fixture.evidenceManifest
    );
    multiplePropertyForgery.entries[
        parcelIndex
    ].expectedPropertyUnitIds.push(
        multiplePropertyForgery.entries[0]
            .expectedPropertyUnitIds[0]
    );
    multiplePropertyForgery.entries[
        parcelIndex
    ].expectedProposedLandAreas.push({
        ...multiplePropertyForgery.entries[0]
            .expectedProposedLandAreas[0],
    });
    assert.throws(
        () =>
            validateDevelopmentRunnerManifests(
                fixture.targetManifest,
                approval(fixture.targetManifest),
                multiplePropertyForgery
        ),
        /FULL_REFRESH_PARCEL_EVIDENCE_SHAPE_MISMATCH/
    );

    const verifiedNoDataForgery = structuredClone(
        fixture.evidenceManifest
    );
    verifiedNoDataForgery.entries[
        parcelIndex
    ].sourceReferences = {
        kind:
            'DEVELOPMENT_READ_ONLY_VERIFIED_NO_DATA_CAPTURE',
        captureRunId: '40000001',
        snapshotReferenceSha256: 'a'.repeat(64),
        verifiedNoDataEvidenceDigest: 'b'.repeat(64),
    };
    assert.throws(
        () =>
            validateDevelopmentRunnerManifests(
                fixture.targetManifest,
                approval(fixture.targetManifest),
                verifiedNoDataForgery
            ),
        /FULL_REFRESH_VERIFIED_NO_DATA_EVIDENCE_FORBIDDEN/
    );
});

test('전체 재조회 runtime은 LDAREG 권리원장 writer 전이를 attribution하고 PASS한다', async () => {
    const {
        artifact,
        targetManifest,
        admissionCount,
        latestReadCount,
    } = await runFullRefreshRuntime({
        ldaregAnchorIndex: 1,
    });
    assert.equal(admissionCount, targetManifest.targetCount);
    assert.equal(latestReadCount, 0);
    assert.deepEqual(artifact.gate, {
        status: 'PASS',
        failureCode: null,
        stoppedBeforePnu: null,
    });
    assert.deepEqual(artifact.landRightWriteAttribution, {
        changedRowCount: 1,
        writerJobCount: 1,
        attributedPropertyUnitCount: 1,
        attributionDigest:
            artifact.landRightWriteAttribution
                ?.attributionDigest,
    });
    assert.equal(
        artifact.landRightPostflight?.activeTargetRowCount,
        1
    );
    assert.doesNotThrow(() =>
        validateDevelopmentRunArtifact(artifact, targetManifest)
    );
    assert.doesNotThrow(() =>
        createDevelopmentPublicRunArtifact(
            artifact,
            'mia-seven-full-278-official-components-api-readonly-20260729'
        )
    );
});

test('전체 재조회 runtime은 LDAREG 권리원장 writer 불일치를 FAIL로 남기고 공개 failure artifact를 허용한다', async () => {
    const { artifact, targetManifest, admissionCount } =
        await runFullRefreshRuntime({
            ldaregAnchorIndex: 1,
            wrongLandRightWriter: true,
        });
    assert.equal(admissionCount, targetManifest.targetCount);
    assert.equal(artifact.gate.status, 'FAIL');
    assert.equal(
        artifact.gate.failureCode,
        'POSTFLIGHT_LAND_RIGHT_ATTRIBUTION_INVALID'
    );
    assert.equal(artifact.landRightWriteAttribution, null);
    assert.doesNotThrow(() =>
        validateDevelopmentRunArtifact(artifact, targetManifest)
    );
    assert.doesNotThrow(() =>
        createDevelopmentPublicRunArtifact(
            artifact,
            'mia-seven-full-278-official-components-api-readonly-20260729'
        )
    );
});

test('LDAREG synthetic PASS artifact는 권리원장 attribution exact count 없이는 거부된다', () => {
    const { artifact, targetManifest } =
        validFullRefreshRunArtifact();
    const tampered: DevelopmentRunArtifact = {
        ...artifact,
        results: artifact.results.map((result, index) =>
            index === 0
                ? {
                      ...result,
                      strategy: 'LDAREG',
                      updatedPropertyUnits: 1,
                  }
                : result
        ),
    };
    assert.throws(
        () =>
            validateDevelopmentRunArtifact(
                tampered,
                targetManifest
            ),
        /RUN_ARTIFACT_LAND_RIGHT_ATTRIBUTION_INVALID/
    );
    assert.throws(
        () =>
            createDevelopmentPublicRunArtifact(
                tampered,
                'mia-seven-full-278-official-components-api-readonly-20260729'
            ),
        /PUBLIC_RUN_ARTIFACT_INVALID/
    );
});

test('LDAREG 권리원장 transition validator는 expected writer와 ACTIVE coverage를 exact 검증한다', () => {
    const entry = {
        ...evidenceEntry(),
        expectedStrategy: 'LDAREG' as const,
        landOwnershipEvidence: null,
    };
    const evidenceManifest = evidence(target(), [entry]);
    const postRow: ObservedDevelopmentLandRight = {
        key: `${PROPERTY_UNIT_ID}:${PNU}`,
        propertyUnitId: PROPERTY_UNIT_ID,
        targetPnu: PNU,
        lifecycleStatus: 'ACTIVE',
        lastSeenSyncJobId: APPLY_JOB_ID,
        lastEvaluatedSyncJobId: APPLY_JOB_ID,
        canonical: '{"active":true}',
    };
    const result = {
        ...validRunArtifact().results[0],
        strategy: 'LDAREG' as const,
    };
    assert.deepEqual(
        validateDevelopmentLandRightTransition({
            preRows: [],
            postRows: [postRow],
            evidence: evidenceManifest,
            results: [result],
        }),
        {
            changedRowCount: 1,
            writerJobCount: 1,
            attributedPropertyUnitCount: 1,
            attributionDigest:
                validateDevelopmentLandRightTransition({
                    preRows: [],
                    postRows: [postRow],
                    evidence: evidenceManifest,
                    results: [result],
                }).attributionDigest,
        }
    );
    assert.throws(
        () =>
            validateDevelopmentLandRightTransition({
                preRows: [],
                postRows: [
                    {
                        ...postRow,
                        lastEvaluatedSyncJobId:
                            SECOND_APPLY_JOB_ID,
                    },
                ],
                evidence: evidenceManifest,
                results: [result],
            }),
        /POSTFLIGHT_LAND_RIGHT_ATTRIBUTION_INVALID/
    );
});

test('대표 evidence reference digest는 문서화된 PII-free canonical preimage와 실제 Phase 0 artifact hash를 고정한다', () => {
    const manifest = parseDevelopmentEvidenceManifest(
        JSON.parse(
            readFileSync(REPRESENTATIVE_EVIDENCE_MANIFEST_URL, 'utf8')
        )
    );
    const sources = manifest.entries[0].sourceReferences;
    assert.equal(
        'workbookFileReferenceSha256' in sources,
        true
    );
    if (!('workbookFileReferenceSha256' in sources)) {
        throw new Error('legacy evidence source expected');
    }
    const selectedCellsPreimage =
        '{"cells":{"E29":"791-2166","F29":"161"},"sheet":"미아791"}';
    const phase0ObservationPreimage =
        '{"landArea":"161","pnu":"1130510100107912166","runId":"30105293359","strategy":"LADFRL"}';
    const developmentObservationPreimage =
        '{"landLotsArea":"161","pnu":"1130510100107912166","propertyUnitId":"5a1a4cbb-c8ad-45a3-ae40-b90665dc949c","unionId":"00f48b95-e9bc-4c92-a0e5-6b9a57adcfb9"}';

    assert.equal(
        sources.selectedCellsReferenceSha256,
        sha256Utf8(selectedCellsPreimage)
    );
    assert.equal(
        sources.phase0ObservationReferenceSha256,
        sha256Utf8(phase0ObservationPreimage)
    );
    assert.equal(
        sources.developmentObservationReferenceSha256,
        sha256Utf8(developmentObservationPreimage)
    );
    assert.equal(
        sources.phase0ArtifactReferenceSha256,
        '63dc038ffb83ef923a1f760f812271d1d27168aa7c8f5105c2f24b00d7ff167b'
    );
});

test('개발 GIS JWT는 kid/dev claims와 정확한 10분 TTL을 고정하고 auth UUID를 sub/userId에 사용한다', () => {
    const secret = 'development-secret-value';
    const now = new Date('2026-07-25T01:02:03.000Z');
    const token = createDevelopmentGisSystemAdminJwt(
        secret,
        ACTOR_AUTH_ID,
        now
    );
    const decoded = jwt.verify(token, secret, {
        algorithms: ['HS256'],
        issuer: 'tonghari-web-dev',
        audience: 'tonghari-api',
        clockTimestamp: Math.floor(now.getTime() / 1000),
        complete: true,
    });
    assert.equal(decoded.header.kid, 'dev');
    assert.equal(decoded.header.alg, 'HS256');
    const payload = decoded.payload as jwt.JwtPayload;
    assert.equal(payload.sub, ACTOR_AUTH_ID);
    assert.equal(payload.userId, ACTOR_AUTH_ID);
    assert.equal(payload.unionId, 'system');
    assert.equal(payload.role, 'SYSTEM_ADMIN');
    assert.equal(payload.purpose, 'GIS_SYSTEM_ADMIN');
    assert.equal(payload.databaseTarget, 'development');
    assert.equal(payload.iss, 'tonghari-web-dev');
    assert.equal(payload.aud, 'tonghari-api');
    assert.equal(
        (payload.exp ?? 0) - (payload.iat ?? 0),
        DEVELOPMENT_GIS_JWT_TTL_SECONDS
    );
});

test('target/DB approval/evidence manifest는 exact union/PNU/count/digest와 1:1 evidence coverage를 요구한다', () => {
    const targetManifest = parseDevelopmentTargetManifest(target());
    const approvalManifest = parseDevelopmentDbApprovalManifest(
        approval(targetManifest)
    );
    const evidenceManifest = parseDevelopmentEvidenceManifest(
        evidence(targetManifest)
    );
    assert.doesNotThrow(() =>
        validateDevelopmentRunnerManifests(
            targetManifest,
            approvalManifest,
            evidenceManifest
        )
    );

    assert.throws(
        () =>
            parseDevelopmentTargetManifest({
                ...targetManifest,
                databaseTarget: 'production',
            }),
        /TARGET_MANIFEST_INVALID/
    );
    assert.throws(
        () =>
            validateDevelopmentRunnerManifests(
                targetManifest,
                {
                    ...approvalManifest,
                    manifestDigest: '0'.repeat(64),
                },
                evidenceManifest
            ),
        /DB_APPROVAL_MANIFEST_MISMATCH/
    );
    assert.throws(
        () =>
            parseDevelopmentEvidenceManifest({
                ...evidenceManifest,
                entries: [
                    {
                        ...evidenceManifest.entries[0],
                        landOwnershipEvidence: null,
                    },
                ],
        }),
        /LAND_OWNERSHIP_EVIDENCE_INVALID/
    );
    assert.throws(
        () =>
            parseDevelopmentEvidenceManifest({
                ...evidenceManifest,
                entries: [
                    {
                        ...evidenceManifest.entries[0],
                        ownerName: '금지된 원문',
                    },
                ],
            }),
        /EVIDENCE_ENTRY_INVALID/
    );
});

test('v2 target은 실행 anchor와 전체 허용 scope를 분리하고 API capture evidence만 결합한다', () => {
    const rawTarget = targetV2();
    const targetManifest =
        parseDevelopmentTargetManifest(rawTarget);
    const linkedEntry: DevelopmentEvidenceEntry = {
        ...evidenceEntry(),
        expectedScannedPnus: [PNU, SECOND_PNU],
        expectedLadfrlAreaEvidence: {
            parcels: [
                { pnu: PNU, area: '80' },
                { pnu: SECOND_PNU, area: '81' },
            ],
            totalArea: '161',
        },
    };
    const evidenceManifest = parseDevelopmentEvidenceManifest(
        evidenceV2(targetManifest, [linkedEntry])
    );
    const approvalManifest = parseDevelopmentDbApprovalManifest(
        approval(targetManifest)
    );

    assert.equal(targetManifest.targetCount, 1);
    assert.deepEqual(
        developmentTargetAllowedScopePnus(targetManifest),
        [PNU, SECOND_PNU]
    );
    assert.equal(
        developmentTargetScopeDigest(targetManifest),
        computeDevelopmentTargetDigest(UNION_ID, [
            PNU,
            SECOND_PNU,
        ])
    );
    assert.notEqual(
        targetManifest.manifestDigest,
        developmentTargetScopeDigest(targetManifest)
    );
    assert.equal(approvalManifest.targetCount, 2);
    assert.equal(
        approvalManifest.manifestDigest,
        developmentTargetScopeDigest(targetManifest)
    );
    assert.equal(
        evidenceManifest.manifestDigest,
        targetManifest.manifestDigest
    );
    assert.doesNotThrow(() =>
        validateDevelopmentRunnerManifests(
            targetManifest,
            approvalManifest,
            evidenceManifest
        )
    );
    assert.throws(
        () =>
            validateDevelopmentRunnerManifests(
                targetManifest,
                {
                    ...approvalManifest,
                    manifestDigest:
                        targetManifest.manifestDigest,
                },
                evidenceManifest
            ),
        /DB_APPROVAL_MANIFEST_MISMATCH/
    );
    assert.throws(
        () =>
            validateDevelopmentRunnerManifests(
                targetManifest,
                approvalManifest,
                {
                    ...evidenceManifest,
                    manifestDigest:
                        targetManifest.scopeDigest,
                }
            ),
        /EVIDENCE_MANIFEST_MISMATCH/
    );
    assert.throws(
        () =>
            parseDevelopmentTargetManifest({
                ...rawTarget,
                pnus: rawTarget.allowedScopePnus,
        }),
        /TARGET_MANIFEST_INVALID/
    );
    const {
        scopeDigest: _omittedScopeDigest,
        ...targetWithoutScopeDigest
    } = rawTarget;
    assert.throws(
        () =>
            parseDevelopmentTargetManifest(
                targetWithoutScopeDigest
            ),
        /TARGET_MANIFEST_INVALID/
    );
    assert.throws(
        () =>
            parseDevelopmentTargetManifest({
                ...rawTarget,
                anchors: [SECOND_PNU],
            }),
        /TARGET_MANIFEST_INVALID/
    );
    assert.throws(
        () =>
            parseDevelopmentTargetManifest({
                ...rawTarget,
                expectedPropertyUnitCount: 2,
            }),
        /TARGET_MANIFEST_INVALID/
    );
    assert.throws(
        () =>
            parseDevelopmentEvidenceManifest({
                ...evidenceManifest,
                version: DEVELOPMENT_EVIDENCE_MANIFEST_VERSION,
            }),
        /EVIDENCE_SOURCE_INVALID/
    );

    const allowedTargets = [PNU, SECOND_PNU]
        .map((pnu) => `development:${UNION_ID}:${pnu}`)
        .join(',');
    assert.doesNotThrow(() =>
        validateDevelopmentRunnerEnvironment(
            {
                DEV_API_JWT_SECRET: 'dev-jwt',
                DEV_SUPABASE_URL:
                    'https://dev.example.supabase.co',
                DEV_SUPABASE_SERVICE_ROLE_KEY: 'dev-service',
                JWT_SECRET: 'prod-jwt',
                SUPABASE_URL:
                    'https://prod.example.supabase.co',
                SUPABASE_SERVICE_ROLE_KEY: 'prod-service',
                LAND_AREA_SYNC_ENABLED: 'true',
                LAND_AREA_SYNC_ALLOWED_TARGETS:
                    allowedTargets,
            },
            targetManifest
        )
    );
});

test('repo-pinned v3 전체 갱신 target만 정책 marker로 승격하고 임의 v3 digest는 거부한다', () => {
    const targetManifest = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(FULL_REFRESH_TARGET_MANIFEST_URL, 'utf8')
        )
    );
    assert.equal(
        targetManifest.version,
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    );
    const marker =
        developmentFullRefreshMarkerForTarget(targetManifest);
    assert.deepEqual(marker, {
        profile: 'DEVELOPMENT_FULL_REFRESH_API_REQUERY_V1',
        manifestDigest:
            'b00f52f97ef20df9f0e7658c84e238044c5eddabce6f1083fa3789776ecf1c24',
        scopeDigest:
            'c661e864d20342519cf7d453454ead53d9279a21c37cdfaa87b8e68f5e2a7eb9',
    });
    assert.throws(
        () =>
            developmentFullRefreshMarkerForTarget({
                ...(targetManifest as DevelopmentTargetManifestV3),
                manifestDigest: '0'.repeat(64),
            }),
        /TARGET_FULL_REFRESH_POLICY_MISMATCH/
    );
});

test('same-run official evidence는 component digest를 필수 commitment로 요구한다', () => {
    const targetManifest = targetV2();
    const raw = evidenceV2(targetManifest, [evidenceEntry()]);
    const sourceReferences = {
        kind: 'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_CAPTURE',
        captureRunId: '30118336235',
        snapshotReferenceSha256: HASH,
        officialComponentDigest: 'b'.repeat(64),
    } as const;
    const sameRun = {
        ...raw,
        entries: [
            {
                ...raw.entries[0],
                sourceReferences,
            },
        ],
    };
    assert.doesNotThrow(() =>
        parseDevelopmentEvidenceManifest(sameRun)
    );
    const {
        officialComponentDigest: _omittedOfficialComponentDigest,
        ...sourceWithoutDigest
    } = sourceReferences;
    assert.throws(
        () =>
            parseDevelopmentEvidenceManifest({
                ...sameRun,
                entries: [
                    {
                        ...sameRun.entries[0],
                        sourceReferences: sourceWithoutDigest,
                    },
                ],
            }),
        /EVIDENCE_SOURCE_INVALID/
    );
});

test('localhost discovery POST는 DEV 전체 갱신 marker를 canonical API body에 포함한다', async () => {
    const targetManifest = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(FULL_REFRESH_TARGET_MANIFEST_URL, 'utf8')
        )
    );
    const marker =
        developmentFullRefreshMarkerForTarget(targetManifest);
    assert.ok(marker);
    let requestBody: unknown = null;
    const client = new LocalhostDevelopmentLandAreaSyncClient(
        'development-secret-value',
        ACTOR_AUTH_ID,
        () => new Date('2026-07-28T00:00:00.000Z'),
        async (_url, init) => {
            requestBody =
                typeof init?.body === 'string'
                    ? JSON.parse(init.body)
                    : null;
            return new Response(
                JSON.stringify({
                    success: true,
                    jobId: DISCOVERY_JOB_ID,
                }),
                {
                    status: 202,
                    headers: {
                        'content-type': 'application/json',
                    },
                }
            );
        }
    );
    await client.admitDiscovery(
        UNION_ID,
        PNU,
        DISCOVERY_JOB_ID,
        marker
    );
    assert.deepEqual(requestBody, {
        unionId: UNION_ID,
        anchorPnu: PNU,
        admissionKey: DISCOVERY_JOB_ID,
        developmentFullRefresh: marker,
    });
});

test('v2 evidence entry 간 property unit ID 중복은 expected count와 무관하게 fail-close한다', () => {
    const targetManifest = targetV2(
        [PNU, SECOND_PNU],
        [PNU, SECOND_PNU],
        1
    );
    const duplicateEntries = [
        evidenceEntry(PNU, PROPERTY_UNIT_ID),
        evidenceEntry(SECOND_PNU, PROPERTY_UNIT_ID),
    ];
    assert.throws(
        () =>
            validateDevelopmentRunnerManifests(
                targetManifest,
                approval(targetManifest),
                evidenceV2(targetManifest, duplicateEntries)
            ),
        /EVIDENCE_PROPERTY_UNIT_ID_OVERLAP/
    );
});

test('v2 evidence entry 간 scanned PNU 중복은 같은 물리 scope의 중복 실행을 막는다', () => {
    const targetManifest = targetV2(
        [PNU, SECOND_PNU],
        [PNU, SECOND_PNU],
        2
    );
    const firstEntry: DevelopmentEvidenceEntry = {
        ...evidenceEntry(PNU, PROPERTY_UNIT_ID),
        expectedScannedPnus: [PNU, SECOND_PNU],
        expectedLadfrlAreaEvidence: {
            parcels: [
                { pnu: PNU, area: '80' },
                { pnu: SECOND_PNU, area: '81' },
            ],
            totalArea: '161',
        },
    };
    const secondEntry = evidenceEntry(
        SECOND_PNU,
        SECOND_PROPERTY_UNIT_ID
    );
    assert.throws(
        () =>
            validateDevelopmentRunnerManifests(
                targetManifest,
                approval(targetManifest),
                evidenceV2(targetManifest, [
                    firstEntry,
                    secondEntry,
                ])
            ),
        /EVIDENCE_SCANNED_PNU_OVERLAP/
    );
});

test('v2 evidence scanned PNU 합집합은 전체 허용 scope를 exact하게 덮어야 한다', () => {
    const targetManifest = targetV2();
    assert.throws(
        () =>
            validateDevelopmentRunnerManifests(
                targetManifest,
                approval(targetManifest),
                evidenceV2(targetManifest, [evidenceEntry()])
            ),
        /EVIDENCE_SCANNED_PNU_COVERAGE_MISMATCH/
    );
});

test('runtime은 dev service env 격리, exact allowlist, write feature flag를 모두 확인한다', () => {
    const targetManifest = target();
    const allowedTarget = `development:${UNION_ID}:${PNU}`;
    assert.doesNotThrow(() =>
        validateDevelopmentRunnerEnvironment(
            {
                DEV_API_JWT_SECRET: 'dev-jwt',
                DEV_SUPABASE_URL: 'https://dev.example.supabase.co',
                DEV_SUPABASE_SERVICE_ROLE_KEY: 'dev-service',
                JWT_SECRET: 'prod-jwt',
                SUPABASE_URL: 'https://prod.example.supabase.co',
                SUPABASE_SERVICE_ROLE_KEY: 'prod-service',
                LAND_AREA_SYNC_ENABLED: 'true',
                LAND_AREA_SYNC_ALLOWED_TARGETS: allowedTarget,
            },
            targetManifest
        )
    );
    assert.throws(
        () =>
            validateDevelopmentRunnerEnvironment(
                {
                    DEV_API_JWT_SECRET: 'same',
                    DEV_SUPABASE_URL: 'https://dev.example.supabase.co',
                    DEV_SUPABASE_SERVICE_ROLE_KEY: 'dev-service',
                    JWT_SECRET: 'same',
                    SUPABASE_URL: 'https://prod.example.supabase.co',
                    SUPABASE_SERVICE_ROLE_KEY: 'prod-service',
                    LAND_AREA_SYNC_ENABLED: 'true',
                    LAND_AREA_SYNC_ALLOWED_TARGETS: allowedTarget,
                },
                targetManifest
            ),
        /DEVELOPMENT_ENVIRONMENT_NOT_ISOLATED/
    );
    assert.throws(
        () =>
            validateDevelopmentRunnerEnvironment(
                {
                    DEV_API_JWT_SECRET: 'dev-jwt',
                    DEV_SUPABASE_URL: 'https://dev.example.supabase.co',
                    DEV_SUPABASE_SERVICE_ROLE_KEY: 'dev-service',
                    JWT_SECRET: 'prod-jwt',
                    SUPABASE_URL: 'https://prod.example.supabase.co',
                    SUPABASE_SERVICE_ROLE_KEY: 'prod-service',
                    LAND_AREA_SYNC_ENABLED: 'true',
                    LAND_AREA_SYNC_ALLOWED_TARGETS: `${allowedTarget},development:${UNION_ID}:${SECOND_PNU}`,
                },
                targetManifest
            ),
        /RUNTIME_ALLOWLIST_MANIFEST_MISMATCH/
    );
});

test('v2 preflight는 anchor PNU가 아니라 evidence property ID exact 집합으로 부속지번 호실을 검증한다', async () => {
    const targetManifest = targetV2(
        [PNU],
        [PNU, SECOND_PNU],
        1
    );
    const linkedEntry: DevelopmentEvidenceEntry = {
        ...evidenceEntry(),
        expectedScannedPnus: [PNU, SECOND_PNU],
        expectedLadfrlAreaEvidence: {
            parcels: [
                { pnu: PNU, area: '80' },
                { pnu: SECOND_PNU, area: '81' },
            ],
            totalArea: '161',
        },
    };
    const evidenceManifest = evidenceV2(targetManifest, [
        linkedEntry,
    ]);
    const linkedSnapshot: LandAreaSyncScopeSnapshot = {
        ...snapshot(),
        scannedPnus: [PNU, SECOND_PNU],
        ladfrlAreaEvidence: {
            version: 'land-area-sync.ladfrl-scope.v1',
            parcels:
                linkedEntry.expectedLadfrlAreaEvidence.parcels,
            totalArea:
                linkedEntry.expectedLadfrlAreaEvidence.totalArea,
        },
    };
    const terminal = job(APPLY_JOB_ID, {
        status: 'COMPLETED',
        scopeState: 'LINKED_SCOPE_RESOLVED',
        outcome: 'APPLIED',
        scopeSnapshot: linkedSnapshot,
    });
    let latestCalls = 0;
    const activeRow = {
        id: PROPERTY_UNIT_ID,
        pnu: SECOND_PNU,
        landArea: '161',
        landAreaSource: 'LADFRL' as const,
        landAreaSyncedAt: '2026-07-25T00:01:00.000Z',
        landAreaSyncJobId: APPLY_JOB_ID,
    };
    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client: {
            async getLatest() {
                latestCalls += 1;
                return terminal;
            },
            async getJob() {
                throw new Error('호출되면 안 됨');
            },
            async admitDiscovery() {
                throw new Error('호출되면 안 됨');
            },
            async confirmDiscovery() {
                throw new Error('호출되면 안 됨');
            },
        },
        preflightReader: {
            async readActivePropertyUnits() {
                return [activeRow];
            },
            async readPropertyUnitsBySyncJobIds() {
                return [
                    {
                        id: PROPERTY_UNIT_ID,
                        unionId: UNION_ID,
                        landAreaSyncJobId: APPLY_JOB_ID,
                    },
                ];
            },
        },
    });

    assert.equal(
        artifact.gate.status,
        'PASS',
        artifact.gate.failureCode ?? undefined
    );
    assert.equal(
        artifact.manifestDigest,
        targetManifest.manifestDigest
    );
    assert.notEqual(
        artifact.manifestDigest,
        targetManifest.scopeDigest
    );
    assert.doesNotThrow(() =>
        validateDevelopmentRunArtifact(
            artifact,
            targetManifest
        )
    );
    assert.equal(latestCalls, 1);
    assert.deepEqual(
        artifact.results.map((result) => result.pnu),
        [PNU]
    );
});

test('직렬 runner는 discovery terminal을 증거와 exact 대조한 뒤 1회 confirm하고 apply terminal PASS를 만든다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    const calls: string[] = [];
    let discoveryReads = 0;
    let applyReads = 0;
    let confirmBody: Parameters<
        LandAreaSyncApiClient['confirmDiscovery']
    >[1] | null = null;
    const client: LandAreaSyncApiClient = {
        async getLatest() {
            calls.push('latest');
            return null;
        },
        async admitDiscovery() {
            calls.push('admit-discovery');
            return DISCOVERY_JOB_ID;
        },
        async getJob(_unionId, jobId) {
            calls.push(`get:${jobId}`);
            if (jobId === DISCOVERY_JOB_ID) {
                discoveryReads += 1;
                return discoveryReads === 1
                    ? job(DISCOVERY_JOB_ID, {
                          status: 'PROCESSING',
                          scopeState: undefined,
                          outcome: null,
                          scopeSnapshot: null,
                      })
                    : job(DISCOVERY_JOB_ID, {
                          status: 'COMPLETED',
                          scopeState:
                              'SINGLE_SCOPE_CONFIRMATION_REQUIRED',
                          outcome: 'REVIEW_REQUIRED',
                      });
            }
            applyReads += 1;
            return applyReads === 1
                ? job(APPLY_JOB_ID, {
                      status: 'PROCESSING',
                      scopeState: 'SINGLE_SCOPE_CONFIRMATION_REQUIRED',
                      outcome: null,
                      sourceDiscoveryJobId: DISCOVERY_JOB_ID,
                  })
                : job(APPLY_JOB_ID, {
                      status: 'COMPLETED',
                      scopeState: 'SINGLE_PNU_CONFIRMED',
                      outcome: 'APPLIED',
                      sourceDiscoveryJobId: DISCOVERY_JOB_ID,
                  });
        },
        async confirmDiscovery(_discoveryJobId, body) {
            calls.push('confirm');
            confirmBody = body;
            return APPLY_JOB_ID;
        },
    };
    let clock = Date.parse('2026-07-25T00:00:00.000Z');
    const admissionKeys = [DISCOVERY_JOB_ID, APPLY_JOB_ID];
    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client,
        preflightReader: preflightReader(evidenceManifest.entries),
        pollIntervalMs: 100,
        jobTimeoutMs: DEVELOPMENT_JOB_POLL_SOFT_TIMEOUT_MS,
        sleep: async (milliseconds) => {
            clock += milliseconds;
        },
        now: () => new Date(clock),
        createAdmissionKey: () => admissionKeys.shift()!,
    });

    assert.equal(artifact.gate.status, 'PASS');
    assert.equal(artifact.observedPropertyUnitCount, 1);
    assert.equal(
        artifact.preflight?.nonTargetTupleDigest,
        artifact.postflight?.nonTargetTupleDigest
    );
    assert.equal(artifact.writeAttribution?.writerJobCount, 1);
    assert.equal(
        artifact.writeAttribution?.attributedPropertyUnitCount,
        1
    );
    assert.deepEqual(calls, [
        'latest',
        'admit-discovery',
        `get:${DISCOVERY_JOB_ID}`,
        `get:${DISCOVERY_JOB_ID}`,
        'confirm',
        `get:${APPLY_JOB_ID}`,
        `get:${APPLY_JOB_ID}`,
    ]);
    assert.deepEqual(confirmBody, {
        unionId: UNION_ID,
        admissionKey: APPLY_JOB_ID,
        expectedScopeHash: '3'.repeat(64),
        propertyUnitIds: [PROPERTY_UNIT_ID],
        parcelScopeConfirmed: true,
        landOwnershipConfirmed: true,
        overwriteManualConfirmed: false,
        parcelScopeEvidenceKind: 'OTHER',
        parcelScopeEvidenceRef: `sheet=s;cells=E29,F29;sha256=${HASH}`,
        landOwnershipEvidenceKind: 'OTHER',
        landOwnershipEvidenceRef: `sheet=s;cells=E29,F29;sha256=${HASH}`,
    });
    assert.doesNotThrow(() =>
        validateDevelopmentRunArtifact(artifact, targetManifest)
    );
    assert.throws(
        () =>
            validateDevelopmentRunArtifact(
                { ...artifact, authorization: 'forbidden' },
                targetManifest
            ),
        /RUN_ARTIFACT_INVALID/
    );
    assert.throws(
        () =>
            validateDevelopmentRunArtifact(
                {
                    ...artifact,
                    postflight: {
                        ...artifact.postflight!,
                        nonTargetTupleDigest: '0'.repeat(64),
                    },
                },
                targetManifest
            ),
        /RUN_ARTIFACT_NON_TARGET_TUPLE_CHANGED/
    );
});

test('latest FAILED terminal은 재사용하지 않고 새 discovery로 재시도한다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    const failedJobId = '44444444-4444-4444-8444-444444444444';
    const calls: string[] = [];
    const client: LandAreaSyncApiClient = {
        async getLatest() {
            calls.push('latest');
            return job(failedJobId, {
                status: 'FAILED',
                scopeState: 'FAILED',
                outcome: null,
                sourceDiscoveryJobId: DISCOVERY_JOB_ID,
            });
        },
        async admitDiscovery() {
            calls.push('admit-discovery');
            return DISCOVERY_JOB_ID;
        },
        async getJob(_unionId, jobId) {
            calls.push(`get:${jobId}`);
            return job(jobId, {
                status: 'COMPLETED',
                scopeState:
                    jobId === DISCOVERY_JOB_ID
                        ? 'SINGLE_SCOPE_CONFIRMATION_REQUIRED'
                        : 'SINGLE_PNU_CONFIRMED',
                outcome:
                    jobId === DISCOVERY_JOB_ID
                        ? 'REVIEW_REQUIRED'
                        : 'APPLIED',
                sourceDiscoveryJobId:
                    jobId === DISCOVERY_JOB_ID
                        ? null
                        : DISCOVERY_JOB_ID,
            });
        },
        async confirmDiscovery() {
            calls.push('confirm');
            return APPLY_JOB_ID;
        },
    };
    const admissionKeys = [DISCOVERY_JOB_ID, APPLY_JOB_ID];
    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client,
        preflightReader: preflightReader(evidenceManifest.entries),
        sleep: async () => undefined,
        createAdmissionKey: () => admissionKeys.shift()!,
    });

    assert.equal(artifact.gate.status, 'PASS');
    assert.equal(artifact.results[0].admission, 'NEW_DISCOVERY');
    assert.equal(artifact.results[0].discoveryJobId, DISCOVERY_JOB_ID);
    assert.equal(artifact.results[0].applyJobId, APPLY_JOB_ID);
    assert.deepEqual(calls, [
        'latest',
        'admit-discovery',
        `get:${DISCOVERY_JOB_ID}`,
        'confirm',
        `get:${APPLY_JOB_ID}`,
    ]);
});

test('discovery 증거 불일치는 raw 값을 노출하지 않는 필드별 코드로 쓰기 전 중단한다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    const baseSnapshot = snapshot();
    const cases: Array<{
        name: string;
        scopeSnapshot: LandAreaSyncScopeSnapshot;
        expectedCode: string;
    }> = [
        {
            name: 'property units',
            scopeSnapshot: {
                ...baseSnapshot,
                candidatePropertyUnitIds: [
                    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                ],
            },
            expectedCode: 'JOB_EVIDENCE_PROPERTY_UNITS_MISMATCH',
        },
        {
            name: 'LADFRL total',
            scopeSnapshot: {
                ...baseSnapshot,
                ladfrlAreaEvidence: {
                    ...baseSnapshot.ladfrlAreaEvidence!,
                    totalArea: '162',
                },
            },
            expectedCode: 'JOB_EVIDENCE_LADFRL_TOTAL_MISMATCH',
        },
    ];

    for (const testCase of cases) {
        let confirms = 0;
        const artifact = await runDevelopmentLandAreaSync({
            target: targetManifest,
            dbApproval: approval(targetManifest),
            evidence: evidenceManifest,
            client: {
                async getLatest() {
                    return job(DISCOVERY_JOB_ID, {
                        status: 'COMPLETED',
                        scopeState:
                            'SINGLE_SCOPE_CONFIRMATION_REQUIRED',
                        outcome: 'REVIEW_REQUIRED',
                        scopeSnapshot: testCase.scopeSnapshot,
                    });
                },
                async getJob() {
                    throw new Error('호출되면 안 됨');
                },
                async admitDiscovery() {
                    throw new Error('호출되면 안 됨');
                },
                async confirmDiscovery() {
                    confirms += 1;
                    return APPLY_JOB_ID;
                },
            },
            preflightReader: preflightReader(
                evidenceManifest.entries,
                false,
                APPLY_JOB_ID,
                false
            ),
        });

        assert.equal(
            artifact.gate.failureCode,
            testCase.expectedCode,
            testCase.name
        );
        assert.equal(confirms, 0, testCase.name);
    }
});

test('latest DB COMPLETED라도 receipt 전에는 terminal로 보지 않고 finalized row를 다시 읽는다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    let admissions = 0;
    let exactReads = 0;
    const client: LandAreaSyncApiClient = {
        async getLatest() {
            return job(APPLY_JOB_ID, {
                status: 'COMPLETED',
                scopeState: 'SINGLE_PNU_CONFIRMED',
                outcome: 'APPLIED',
                sourceDiscoveryJobId: DISCOVERY_JOB_ID,
                includeWorkerFinalization: false,
            });
        },
        async getJob() {
            exactReads += 1;
            return job(APPLY_JOB_ID, {
                status: 'COMPLETED',
                scopeState: 'SINGLE_PNU_CONFIRMED',
                outcome: 'APPLIED',
                sourceDiscoveryJobId: DISCOVERY_JOB_ID,
            });
        },
        async admitDiscovery() {
            admissions += 1;
            return DISCOVERY_JOB_ID;
        },
        async confirmDiscovery() {
            admissions += 1;
            return APPLY_JOB_ID;
        },
    };
    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client,
        preflightReader: preflightReader(
            evidenceManifest.entries,
            true
        ),
        sleep: async () => undefined,
    });
    assert.equal(artifact.gate.status, 'PASS');
    assert.equal(artifact.results[0].admission, 'RESUMED_LATEST');
    assert.equal(admissions, 0);
    assert.equal(exactReads, 1);
});

test('APPLIED terminal은 issue 0건만 통과하고 RATIO_PARSE_FAILED는 개수와 무관하게 차단한다', async () => {
    const targetManifest = target();
    const ldaregEntry: DevelopmentEvidenceEntry = {
        ...evidenceEntry(),
        expectedStrategy: 'LDAREG',
        landOwnershipEvidence: null,
        allowedPrestates: [
            {
                propertyUnitId: PROPERTY_UNIT_ID,
                landArea: null,
                landAreaSource: 'LEGACY_UNKNOWN',
            },
            {
                propertyUnitId: PROPERTY_UNIT_ID,
                landArea: '161',
                landAreaSource: 'LDAREG',
            },
        ],
    };
    const evidenceManifest = evidence(targetManifest, [ldaregEntry]);
    const ldaregSnapshot: LandAreaSyncScopeSnapshot = {
        ...snapshot(),
        strategy: 'LDAREG',
    };
    const runWithTerminal = async (terminal: LandAreaSyncApiJob) =>
        runDevelopmentLandAreaSync({
            target: targetManifest,
            dbApproval: approval(targetManifest),
            evidence: evidenceManifest,
            client: {
                async getLatest() {
                    return terminal;
                },
                async getJob() {
                    throw new Error('호출되면 안 됨');
                },
                async admitDiscovery() {
                    throw new Error('호출되면 안 됨');
                },
                async confirmDiscovery() {
                    throw new Error('호출되면 안 됨');
                },
            },
            preflightReader: preflightReader(
                evidenceManifest.entries,
                true
            ),
        });

    const applied = job(APPLY_JOB_ID, {
        status: 'COMPLETED',
        scopeState: 'LINKED_SCOPE_RESOLVED',
        outcome: 'APPLIED',
        scopeSnapshot: ldaregSnapshot,
        issueCodes: [],
    });
    applied.landAreaSync!.branch = 'LDAREG';
    const passArtifact = await runWithTerminal(applied);
    assert.equal(
        passArtifact.gate.status,
        'PASS',
        passArtifact.gate.failureCode ?? undefined
    );
    assert.deepEqual(passArtifact.results[0].issueCodes, []);

    const leakedPlaceholderIssue = job(APPLY_JOB_ID, {
        status: 'COMPLETED',
        scopeState: 'LINKED_SCOPE_RESOLVED',
        outcome: 'APPLIED',
        scopeSnapshot: ldaregSnapshot,
        issueCodes: ['RATIO_PARSE_FAILED'],
    });
    leakedPlaceholderIssue.landAreaSync!.branch = 'LDAREG';
    leakedPlaceholderIssue.landAreaSync!.issues = [
        { code: 'RATIO_PARSE_FAILED', targetPnu: PNU },
    ];
    const leakedIssueArtifact =
        await runWithTerminal(leakedPlaceholderIssue);
    assert.equal(leakedIssueArtifact.gate.status, 'FAIL');
    assert.equal(
        leakedIssueArtifact.gate.failureCode,
        'APPLY_TERMINAL_NOT_PASS'
    );

    const repeatedPlaceholder = job(APPLY_JOB_ID, {
        status: 'COMPLETED',
        scopeState: 'LINKED_SCOPE_RESOLVED',
        outcome: 'APPLIED',
        scopeSnapshot: ldaregSnapshot,
        issueCodes: [
            'RATIO_PARSE_FAILED',
            'RATIO_PARSE_FAILED',
        ],
    });
    repeatedPlaceholder.landAreaSync!.branch = 'LDAREG';
    repeatedPlaceholder.landAreaSync!.issues = [
        { code: 'RATIO_PARSE_FAILED', targetPnu: PNU },
        { code: 'RATIO_PARSE_FAILED', targetPnu: PNU },
    ];
    const repeatedFailArtifact =
        await runWithTerminal(repeatedPlaceholder);
    assert.equal(repeatedFailArtifact.gate.status, 'FAIL');
    assert.equal(
        repeatedFailArtifact.gate.failureCode,
        'APPLY_TERMINAL_NOT_PASS'
    );

    const malformedReview = job(DISCOVERY_JOB_ID, {
        status: 'COMPLETED',
        scopeState: 'REVIEW_REQUIRED',
        outcome: 'REVIEW_REQUIRED',
        scopeSnapshot: ldaregSnapshot,
        issueCodes: ['RATIO_PARSE_FAILED'],
    });
    malformedReview.landAreaSync!.branch = 'LDAREG';
    malformedReview.landAreaSync!.issues = [
        { code: 'RATIO_PARSE_FAILED', targetPnu: PNU },
    ];
    const failArtifact = await runWithTerminal(malformedReview);
    assert.equal(failArtifact.gate.status, 'FAIL');
    assert.equal(
        failArtifact.gate.failureCode,
        'APPLY_TERMINAL_NOT_PASS'
    );
});

test('latest APPLIED도 issues truncation 또는 total 불일치면 PASS하지 않는다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    for (const terminal of [
        job(APPLY_JOB_ID, {
            status: 'COMPLETED',
            scopeState: 'SINGLE_PNU_CONFIRMED',
            outcome: 'APPLIED',
            sourceDiscoveryJobId: DISCOVERY_JOB_ID,
            issueCodes: ['SAFE_INFORMATIONAL'],
            issuesTotal: 2,
            issuesTruncated: true,
        }),
        job(APPLY_JOB_ID, {
            status: 'COMPLETED',
            scopeState: 'SINGLE_PNU_CONFIRMED',
            outcome: 'APPLIED',
            sourceDiscoveryJobId: DISCOVERY_JOB_ID,
            issueCodes: ['SAFE_INFORMATIONAL'],
            issuesTotal: 2,
            issuesTruncated: false,
        }),
    ]) {
        const artifact = await runDevelopmentLandAreaSync({
            target: targetManifest,
            dbApproval: approval(targetManifest),
            evidence: evidenceManifest,
            client: {
                async getLatest() {
                    return terminal;
                },
                async getJob() {
                    throw new Error('호출되면 안 됨');
                },
                async admitDiscovery() {
                    throw new Error('호출되면 안 됨');
                },
                async confirmDiscovery() {
                    throw new Error('호출되면 안 됨');
                },
            },
            preflightReader: preflightReader(
                evidenceManifest.entries,
                true
            ),
        });
        assert.equal(artifact.gate.status, 'FAIL');
        assert.equal(
            artifact.gate.failureCode,
            'APPLY_TERMINAL_ISSUES_INCOMPLETE'
        );
    }
});

test('read-only preflight membership/prestate가 다르면 API admission 전에 FAIL한다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    let apiCalls = 0;
    const client: LandAreaSyncApiClient = {
        async getLatest() {
            apiCalls += 1;
            return null;
        },
        async getJob() {
            apiCalls += 1;
            throw new Error('호출되면 안 됨');
        },
        async admitDiscovery() {
            apiCalls += 1;
            return DISCOVERY_JOB_ID;
        },
        async confirmDiscovery() {
            apiCalls += 1;
            return APPLY_JOB_ID;
        },
    };
    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client,
        preflightReader: {
            async readActivePropertyUnits() {
                return [
                    {
                        id: PROPERTY_UNIT_ID,
                        pnu: PNU,
                        landArea: '999',
                        landAreaSource: 'MANUAL',
                        landAreaSyncedAt: null,
                        landAreaSyncJobId: null,
                    },
                ];
            },
            async readPropertyUnitsBySyncJobIds() {
                throw new Error('호출되면 안 됨');
            },
        },
    });
    assert.equal(artifact.gate.status, 'FAIL');
    assert.equal(
        artifact.gate.failureCode,
        'PREFLIGHT_TARGET_PRESTATE_MISMATCH'
    );
    assert.equal(apiCalls, 0);
    assert.equal(artifact.results.length, 0);
});

test('10분 queue 상한 뒤 적용된 미기록 terminal은 tuple 안전 실패가 기존 timeout을 우선한다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    let clock = Date.parse('2026-07-25T00:00:00.000Z');
    let getJobCalls = 0;
    let terminalObserved = false;
    const client: LandAreaSyncApiClient = {
        async getLatest() {
            return null;
        },
        async admitDiscovery() {
            return DISCOVERY_JOB_ID;
        },
        async getJob() {
            getJobCalls += 1;
            if (getJobCalls < 23) {
                if (getJobCalls % 2 === 0) {
                    throw new Error('일시적 API 조회 실패');
                }
                return job(DISCOVERY_JOB_ID, {
                    status: 'PROCESSING',
                    scopeState: undefined,
                    outcome: null,
                    scopeSnapshot: null,
                });
            }
            terminalObserved = true;
            return job(DISCOVERY_JOB_ID, {
                status: 'COMPLETED',
                scopeState: 'LINKED_SCOPE_RESOLVED',
                outcome: 'APPLIED',
            });
        },
        async confirmDiscovery() {
            throw new Error('호출되면 안 됨');
        },
    };
    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client,
        preflightReader: preflightReader(
            evidenceManifest.entries,
            false,
            DISCOVERY_JOB_ID
        ),
        pollIntervalMs: 30_000,
        jobTimeoutMs: DEVELOPMENT_JOB_POLL_SOFT_TIMEOUT_MS,
        sleep: async (milliseconds) => {
            clock += milliseconds;
        },
        now: () => new Date(clock),
    });

    assert.equal(terminalObserved, true);
    assert.equal(getJobCalls, 23);
    assert.equal(artifact.gate.status, 'FAIL');
    assert.equal(
        artifact.gate.failureCode,
        'POSTFLIGHT_UNFINALIZED_TARGET_TUPLE_CHANGED'
    );
    await assert.rejects(
        runDevelopmentLandAreaSync({
            target: targetManifest,
            dbApproval: approval(targetManifest),
            evidence: evidenceManifest,
            client,
            preflightReader: preflightReader(evidenceManifest.entries),
            jobTimeoutMs: 10 * 60_000,
        }),
        /POLL_CONFIGURATION_INVALID/
    );
});

test('confirmation POST 503은 exact admission id를 복구해 apply terminal까지 drain한다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    let confirmationPosts = 0;
    const networkFailureClient =
        new LocalhostDevelopmentLandAreaSyncClient(
            'development-secret-value',
            ACTOR_AUTH_ID,
            () => new Date('2026-07-25T00:00:00.000Z'),
            async () => {
                confirmationPosts += 1;
                return new Response(
                    JSON.stringify({
                        success: false,
                        code: 'CONFIRMATION_ERROR',
                    }),
                    {
                        status: 503,
                        headers: { 'content-type': 'application/json' },
                    }
                );
            }
        );
    let latestReads = 0;
    let exactReads = 0;
    const client: LandAreaSyncApiClient = {
        async getLatest() {
            latestReads += 1;
            return job(DISCOVERY_JOB_ID, {
                status: 'COMPLETED',
                scopeState:
                    'SINGLE_SCOPE_CONFIRMATION_REQUIRED',
                outcome: 'REVIEW_REQUIRED',
            });
        },
        async getJob(_unionId, jobId) {
            return job(jobId, {
                status: 'COMPLETED',
                scopeState: 'SINGLE_PNU_CONFIRMED',
                outcome: 'APPLIED',
                sourceDiscoveryJobId: DISCOVERY_JOB_ID,
                admissionKey: CONFIRM_ADMISSION_KEY,
            });
        },
        async getAdmission(_unionId, admissionKey) {
            exactReads += 1;
            return job(APPLY_JOB_ID, {
                status: 'PROCESSING',
                scopeState:
                    'SINGLE_SCOPE_CONFIRMATION_REQUIRED',
                outcome: null,
                sourceDiscoveryJobId: DISCOVERY_JOB_ID,
                admissionKey,
            });
        },
        async admitDiscovery() {
            throw new Error('호출되면 안 됨');
        },
        async confirmDiscovery(discoveryJobId, body) {
            return networkFailureClient.confirmDiscovery(
                discoveryJobId,
                body
            );
        },
    };

    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client,
        preflightReader: preflightReader(
            evidenceManifest.entries
        ),
        pollIntervalMs: 100,
        admissionReconciliationAttempts: 2,
        sleep: async () => undefined,
        createAdmissionKey: () => CONFIRM_ADMISSION_KEY,
    });

    assert.equal(latestReads, 1);
    assert.equal(exactReads, 1);
    assert.equal(confirmationPosts, 2, 'same-key replay는 한 번만 수행');
    assert.equal(artifact.gate.status, 'PASS');
    assert.equal(artifact.results[0].applyJobId, APPLY_JOB_ID);
    assert.equal(artifact.results[0].writerJobId, APPLY_JOB_ID);
});

test('localhost client admission 조회는 key와 다른 actual job id를 허용하되 lineage를 exact 검증한다', async () => {
    let requestedUrl = '';
    const client = new LocalhostDevelopmentLandAreaSyncClient(
        'development-secret-value',
        ACTOR_AUTH_ID,
        () => new Date('2026-07-25T00:00:00.000Z'),
        async (url) => {
            requestedUrl = String(url);
            return new Response(
                JSON.stringify({
                    success: true,
                    ...job(APPLY_JOB_ID, {
                        status: 'PROCESSING',
                        scopeState:
                            'SINGLE_SCOPE_CONFIRMATION_REQUIRED',
                        outcome: null,
                        sourceDiscoveryJobId: DISCOVERY_JOB_ID,
                        admissionKey: CONFIRM_ADMISSION_KEY,
                    }),
                }),
                {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }
            );
        }
    );

    const found = await client.getAdmission(
        UNION_ID,
        CONFIRM_ADMISSION_KEY,
        DISCOVERY_JOB_ID
    );
    assert.equal(found?.jobId, APPLY_JOB_ID);
    assert.match(
        requestedUrl,
        new RegExp(
            `/admissions/${CONFIRM_ADMISSION_KEY}\\?unionId=${UNION_ID}&sourceDiscoveryJobId=${DISCOVERY_JOB_ID}`
        )
    );
});

test('discovery POST timeout도 exact admission id만 복구해 terminal 전 반환하지 않는다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    const networkFailureClient =
        new LocalhostDevelopmentLandAreaSyncClient(
            'development-secret-value',
            ACTOR_AUTH_ID,
            () => new Date('2026-07-25T00:00:00.000Z'),
            async () => {
                throw new Error('응답 유실');
            }
        );
    let latestReads = 0;
    let exactReads = 0;
    const client: LandAreaSyncApiClient = {
        async getLatest() {
            latestReads += 1;
            return null;
        },
        async getJob() {
            throw new Error('호출되면 안 됨');
        },
        async getAdmission(_unionId, admissionKey) {
            exactReads += 1;
            return job(DISCOVERY_JOB_ID, {
                status: 'COMPLETED',
                scopeState: 'LINKED_SCOPE_RESOLVED',
                outcome: 'APPLIED',
                admissionKey,
            });
        },
        async admitDiscovery(unionId, pnu, admissionKey) {
            return networkFailureClient.admitDiscovery(
                unionId,
                pnu,
                admissionKey
            );
        },
        async confirmDiscovery() {
            throw new Error('호출되면 안 됨');
        },
    };

    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client,
        preflightReader: preflightReader(
            evidenceManifest.entries,
            false,
            DISCOVERY_JOB_ID
        ),
        pollIntervalMs: 100,
        admissionReconciliationAttempts: 2,
        sleep: async () => undefined,
        createAdmissionKey: () => DISCOVERY_JOB_ID,
    });

    assert.equal(latestReads, 1);
    assert.equal(exactReads, 1);
    assert.equal(artifact.gate.status, 'PASS');
    assert.equal(
        artifact.results[0].discoveryJobId,
        DISCOVERY_JOB_ID
    );
    assert.equal(
        artifact.results[0].writerJobId,
        DISCOVERY_JOB_ID
    );
});

test('POST 5xx 전에 durable admission이 없으면 exact 조회를 유한 횟수만 수행하고 FAIL한다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    let exactReads = 0;
    const failingHttpClient =
        new LocalhostDevelopmentLandAreaSyncClient(
            'development-secret-value',
            ACTOR_AUTH_ID,
            () => new Date('2026-07-25T00:00:00.000Z'),
            async () =>
                new Response('{}', {
                    status: 503,
                    headers: { 'content-type': 'application/json' },
                })
        );
    const client: LandAreaSyncApiClient = {
        async getLatest() {
            return null;
        },
        async getJob() {
            throw new Error('호출되면 안 됨');
        },
        async getAdmission() {
            exactReads += 1;
            return null;
        },
        admitDiscovery: (unionId, pnu, admissionKey) =>
            failingHttpClient.admitDiscovery(
                unionId,
                pnu,
                admissionKey
            ),
        async confirmDiscovery() {
            throw new Error('호출되면 안 됨');
        },
    };

    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client,
        preflightReader: preflightReader(
            evidenceManifest.entries,
            false,
            APPLY_JOB_ID,
            false
        ),
        pollIntervalMs: 100,
        admissionReconciliationAttempts: 2,
        sleep: async () => undefined,
        createAdmissionKey: () => DISCOVERY_JOB_ID,
    });

    assert.equal(exactReads, 2);
    assert.equal(artifact.gate.status, 'FAIL');
    assert.equal(
        artifact.gate.failureCode,
        'AMBIGUOUS_ADMISSION_NOT_DURABLE'
    );
});

test('두 번째 anchor 실패 후에도 postflight를 읽고 성공 subset만 transition·writer 귀속을 검증한다', async () => {
    const {
        artifact,
        targetManifest,
        activeReads,
        attributionReads,
    } = await runTwoTargetPartialFailure();

    assert.equal(activeReads, 2);
    assert.equal(attributionReads, 1);
    assert.equal(artifact.gate.status, 'FAIL');
    assert.equal(artifact.gate.failureCode, 'UNEXPECTED_RUNNER_ERROR');
    assert.equal(artifact.gate.stoppedBeforePnu, SECOND_PNU);
    assert.deepEqual(
        artifact.results.map((result) => result.pnu),
        [PNU]
    );
    assert.equal(artifact.observedPropertyUnitCount, 1);
    assert.equal(artifact.postflight?.positiveLandAreaCount, 1);
    assert.equal(artifact.writeAttribution?.writerJobCount, 1);
    assert.equal(
        artifact.writeAttribution?.attributedPropertyUnitCount,
        1
    );
    assert.doesNotThrow(() =>
        validateDevelopmentRunArtifact(artifact, targetManifest)
    );
    assert.doesNotThrow(() =>
        createDevelopmentPublicRunArtifact(
            artifact,
            'partial-failure-safety-test'
        )
    );
});

test('실패·미실행 anchor tuple 변경은 기존 작업 오류를 안전 postflight 오류로 덮어쓴다', async () => {
    const { artifact, attributionReads } =
        await runTwoTargetPartialFailure({
            mutateUnfinalizedTarget: true,
        });

    assert.equal(attributionReads, 1);
    assert.equal(artifact.gate.status, 'FAIL');
    assert.equal(
        artifact.gate.failureCode,
        'POSTFLIGHT_UNFINALIZED_TARGET_TUPLE_CHANGED'
    );
    assert.equal(
        artifact.writeAttribution?.attributedPropertyUnitCount,
        1
    );
});

test('부분 성공 writer bounded read의 타 조합 행은 기존 작업 오류보다 우선해 FAIL한다', async () => {
    const { artifact, attributionReads } =
        await runTwoTargetPartialFailure({
            attributionUnionId:
                '10f48b95-e9bc-4c92-a0e5-6b9a57adcfb9',
        });

    assert.equal(attributionReads, 1);
    assert.equal(artifact.gate.status, 'FAIL');
    assert.equal(
        artifact.gate.failureCode,
        'POSTFLIGHT_CROSS_UNION_OR_SCOPE_WRITE_DETECTED'
    );
    assert.equal(artifact.writeAttribution, null);
});

test('postflight는 승인 대상 밖의 land area/source/synced/job tuple 변경을 exact 거부한다', async () => {
    const targetManifest = {
        ...target(),
        expectedUnionActivePropertyUnitCount: 2,
        expectedUnionActivePnuCount: 2,
    };
    const evidenceManifest = evidence(targetManifest);
    const nonTargetId = '6a1a4cbb-c8ad-45a3-ae40-b90665dc949c';
    let reads = 0;
    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client: {
            async getLatest() {
                return job(APPLY_JOB_ID, {
                    status: 'COMPLETED',
                    scopeState: 'SINGLE_PNU_CONFIRMED',
                    outcome: 'APPLIED',
                    sourceDiscoveryJobId: DISCOVERY_JOB_ID,
                });
            },
            async getJob() {
                throw new Error('호출되면 안 됨');
            },
            async admitDiscovery() {
                throw new Error('호출되면 안 됨');
            },
            async confirmDiscovery() {
                throw new Error('호출되면 안 됨');
            },
        },
        preflightReader: {
            async readActivePropertyUnits() {
                reads += 1;
                return [
                    {
                        id: PROPERTY_UNIT_ID,
                        pnu: PNU,
                        landArea: '161',
                        landAreaSource: 'LADFRL',
                        landAreaSyncedAt:
                            '2026-07-25T00:01:00.000Z',
                        landAreaSyncJobId: APPLY_JOB_ID,
                    },
                    {
                        id: nonTargetId,
                        pnu: SECOND_PNU,
                        landArea: reads === 1 ? null : '99',
                        landAreaSource: 'LEGACY_UNKNOWN',
                        landAreaSyncedAt: null,
                        landAreaSyncJobId: null,
                    },
                ];
            },
            async readPropertyUnitsBySyncJobIds() {
                throw new Error('호출되면 안 됨');
            },
        },
    });

    assert.equal(artifact.gate.status, 'FAIL');
    assert.equal(
        artifact.gate.failureCode,
        'POSTFLIGHT_NON_TARGET_TUPLE_CHANGED'
    );
    assert.doesNotThrow(() =>
        validateDevelopmentRunArtifact(artifact, targetManifest)
    );
    assert.doesNotThrow(() =>
        createDevelopmentPublicRunArtifact(
            artifact,
            'non-target-safety-failure'
        )
    );
});

test('writer job attribution bounded read는 타 조합 또는 승인 scope 밖 write를 FAIL한다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    const reader = preflightReader(evidenceManifest.entries, true);
    reader.readPropertyUnitsBySyncJobIds = async () => [
        {
            id: PROPERTY_UNIT_ID,
            unionId: '10f48b95-e9bc-4c92-a0e5-6b9a57adcfb9',
            landAreaSyncJobId: APPLY_JOB_ID,
        },
    ];
    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client: {
            async getLatest() {
                return job(APPLY_JOB_ID, {
                    status: 'COMPLETED',
                    scopeState: 'SINGLE_PNU_CONFIRMED',
                    outcome: 'APPLIED',
                    sourceDiscoveryJobId: DISCOVERY_JOB_ID,
                });
            },
            async getJob() {
                throw new Error('호출되면 안 됨');
            },
            async admitDiscovery() {
                throw new Error('호출되면 안 됨');
            },
            async confirmDiscovery() {
                throw new Error('호출되면 안 됨');
            },
        },
        preflightReader: reader,
    });

    assert.equal(artifact.gate.status, 'FAIL');
    assert.equal(
        artifact.gate.failureCode,
        'POSTFLIGHT_CROSS_UNION_OR_SCOPE_WRITE_DETECTED'
    );
});

test('FAILED/review/cache conflict이면 다음 PNU admission을 즉시 중단한다', async () => {
    const targetManifest = target([PNU, SECOND_PNU], 2);
    const secondPropertyUnitId = '6a1a4cbb-c8ad-45a3-ae40-b90665dc949c';
    const latestPnus: string[] = [];
    const client: LandAreaSyncApiClient = {
        async getLatest(_unionId, pnu) {
            latestPnus.push(pnu);
            return job(APPLY_JOB_ID, {
                status: 'COMPLETED',
                scopeState: 'SINGLE_PNU_CONFIRMED',
                outcome: 'APPLIED',
                sourceDiscoveryJobId: DISCOVERY_JOB_ID,
                issueCodes: ['CACHE_CONFLICT'],
            });
        },
        async getJob() {
            throw new Error('호출되면 안 됨');
        },
        async admitDiscovery() {
            throw new Error('호출되면 안 됨');
        },
        async confirmDiscovery() {
            throw new Error('호출되면 안 됨');
        },
    };
    const evidenceManifest = evidence(targetManifest, [
        evidenceEntry(),
        evidenceEntry(SECOND_PNU, secondPropertyUnitId),
    ]);
    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client,
        preflightReader: preflightReader(evidenceManifest.entries),
    });
    assert.equal(artifact.gate.status, 'FAIL');
    assert.equal(
        artifact.gate.failureCode,
        'POSTFLIGHT_UNFINALIZED_TARGET_TUPLE_CHANGED'
    );
    assert.equal(artifact.gate.stoppedBeforePnu, PNU);
    assert.deepEqual(latestPnus, [PNU]);
});
