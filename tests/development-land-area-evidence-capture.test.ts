import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    DEVELOPMENT_EVIDENCE_MANIFEST_VERSION,
    DEVELOPMENT_EVIDENCE_MANIFEST_VERSION_V2,
    DEVELOPMENT_TARGET_MANIFEST_VERSION,
    DEVELOPMENT_TARGET_MANIFEST_VERSION_V2,
    computeDevelopmentTargetDigest,
    computeDevelopmentTargetV2ManifestDigest,
    developmentTargetScopeDigest,
    parseDevelopmentEvidenceManifest,
    parseDevelopmentTargetManifest,
    type DevelopmentTargetManifest,
} from '../src/operations/development-land-area-sync-runner';
import {
    aggregateDevelopmentEvidenceCaptureEntries,
    assertDevelopmentEvidenceCaptureActiveIdentity,
    developmentEvidenceEntryFromSnapshot,
} from '../src/operations/development-land-area-evidence-capture';
import type { LandAreaSyncScopeSnapshot } from '../src/types/land-area-sync-job.types';

const UNION_ID = '00f48b95-e9bc-4c92-a0e5-6b9a57adcfb9';
const PNU = '1130510100107912166';
const ATTACHED_PNU = '1130510100107912167';
const PROPERTY_UNIT_ID =
    '5a1a4cbb-c8ad-45a3-ae40-b90665dc949c';
const MIA_791_2280_TARGET_URL = new URL(
    '../development-land-area-sync-manifests/mia-seven-791-2280-ldareg-api-readonly-target-20260725.json',
    import.meta.url
);
const MIA_AUTO_286_TARGET_URL = new URL(
    '../development-land-area-sync-manifests/mia-seven-auto-286-target-20260725.json',
    import.meta.url
);
const MIA_FULL_299_TARGET_URL = new URL(
    '../development-land-area-sync-manifests/mia-seven-full-299-api-readonly-target-20260728.json',
    import.meta.url
);
const MIA_FULL_299_DELTA = [
    '1130510100107450049',
    '1130510100107450052',
    '1130510100107450076',
    '1130510100107912211',
    '1130510100107912212',
    '1130510100107912213',
    '1130510100107912267',
    '1130510100107912280',
    '1130510100107912320',
    '1130510100107912343',
    '1130510100107912344',
    '1130510100107912474',
    '1130510100107913568',
] as const;

function target(pnus = [PNU]): DevelopmentTargetManifest {
    return {
        version: DEVELOPMENT_TARGET_MANIFEST_VERSION,
        databaseTarget: 'development',
        unionId: UNION_ID,
        pnus,
        targetCount: pnus.length,
        manifestDigest: computeDevelopmentTargetDigest(
            UNION_ID,
            pnus
        ),
        expectedPropertyUnitCount: 1,
        expectedUnionActivePropertyUnitCount: 429,
        expectedUnionActivePnuCount: 299,
    };
}

function snapshot(
    currentSource = 'LEGACY_UNKNOWN',
    currentLandArea = ''
): LandAreaSyncScopeSnapshot {
    return {
        frozenAt: '2026-07-25T00:00:00.000Z',
        strategy: 'LADFRL',
        scannedPnus: [PNU],
        resolverRootPks: ['1010111038'],
        bylotSourcePolicy: 'TITLE_ONLY',
        bylotEvidence: [],
        dbScopeHash: '1'.repeat(64),
        externalScopeDigest: '2'.repeat(64),
        scopeHash: '3'.repeat(64),
        candidatePropertyUnitIds: [PROPERTY_UNIT_ID],
        propertyMembershipHash: '4'.repeat(64),
        currentLandTuples: [
            {
                propertyUnitId: PROPERTY_UNIT_ID,
                landArea: currentLandArea,
                source: currentSource,
            },
        ],
        // jsonb key 순서를 모사해 landArea를 먼저 둔다.
        proposedLandAreas: [
            {
                landArea: '161',
                propertyUnitId: PROPERTY_UNIT_ID,
            },
        ],
        ladfrlAreaEvidence: {
            version: 'land-area-sync.ladfrl-scope.v1',
            parcels: [{ pnu: PNU, area: '161' }],
            totalArea: '161',
        },
        replicationEvidence: null,
        projectionInputDigest: '5'.repeat(64),
        canonicalVersion: 2,
    };
}

function targetV2(): DevelopmentTargetManifest {
    const allowedScopePnus = [PNU, ATTACHED_PNU];
    const identity = {
        unionId: UNION_ID,
        anchors: [PNU],
        allowedScopePnus,
        targetCount: 1,
        expectedPropertyUnitCount: 1,
        expectedUnionActivePropertyUnitCount: 429,
        expectedUnionActivePnuCount: 299,
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

test('791-2280 API read-only target은 anchor 1건과 대표·부속지번 allowlist 2건을 고정한다', () => {
    const manifest = parseDevelopmentTargetManifest(
        JSON.parse(readFileSync(MIA_791_2280_TARGET_URL, 'utf8'))
    );
    assert.equal(
        manifest.version,
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V2
    );
    if (
        manifest.version !==
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V2
    ) {
        throw new Error('v2 target expected');
    }
    assert.deepEqual(manifest.anchors, ['1130510100107912280']);
    assert.deepEqual(manifest.allowedScopePnus, [
        '1130510100107912280',
        '1130510100107912281',
    ]);
    assert.equal(manifest.targetCount, 1);
    assert.equal(manifest.expectedPropertyUnitCount, 4);
    assert.equal(manifest.allowManualOverwrite, true);
    assert.equal(
        manifest.scopeDigest,
        computeDevelopmentTargetDigest(
            UNION_ID,
            manifest.allowedScopePnus
        )
    );
    assert.equal(
        manifest.manifestDigest,
        computeDevelopmentTargetV2ManifestDigest(manifest)
    );
    assert.notEqual(
        manifest.manifestDigest,
        developmentTargetScopeDigest(manifest)
    );
});

test('미아7 전체 API 재조회 target은 활성 anchor 299건과 property unit 429건을 고정한다', () => {
    const auto286 = parseDevelopmentTargetManifest(
        JSON.parse(readFileSync(MIA_AUTO_286_TARGET_URL, 'utf8'))
    );
    const full299 = parseDevelopmentTargetManifest(
        JSON.parse(readFileSync(MIA_FULL_299_TARGET_URL, 'utf8'))
    );
    assert.equal(
        full299.version,
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V2
    );
    if (
        auto286.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION ||
        full299.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION_V2
    ) {
        throw new Error('v1 auto286 and v2 full299 expected');
    }

    assert.equal(full299.anchors.length, 299);
    assert.equal(full299.targetCount, 299);
    assert.equal(full299.allowedScopePnus.length, 300);
    assert.equal(full299.expectedPropertyUnitCount, 429);
    assert.equal(full299.expectedUnionActivePropertyUnitCount, 429);
    assert.equal(full299.expectedUnionActivePnuCount, 299);
    assert.equal(full299.allowManualOverwrite, true);
    assert.equal(
        computeDevelopmentTargetDigest(UNION_ID, full299.anchors),
        '638977eb11e2e09afdb949179fe59e7944c2ed4c973fe2695bf0628239a2e219'
    );
    assert.equal(
        full299.scopeDigest,
        computeDevelopmentTargetDigest(
            UNION_ID,
            full299.allowedScopePnus
        )
    );
    assert.equal(
        full299.manifestDigest,
        computeDevelopmentTargetV2ManifestDigest(full299)
    );

    const autoSet = new Set(auto286.pnus);
    assert.equal(
        auto286.pnus.every((pnu) => full299.anchors.includes(pnu)),
        true
    );
    assert.deepEqual(
        full299.anchors.filter((pnu) => !autoSet.has(pnu)),
        [...MIA_FULL_299_DELTA]
    );
    assert.equal(full299.anchors.includes('1130510100107912280'), true);
    assert.equal(full299.anchors.includes('1130510100107912281'), false);
    assert.equal(
        full299.allowedScopePnus.includes('1130510100107912280'),
        true
    );
    assert.equal(
        full299.allowedScopePnus.includes('1130510100107912281'),
        true
    );
    assert.deepEqual(
        full299.allowedScopePnus.filter(
            (pnu) => !full299.anchors.includes(pnu)
        ),
        ['1130510100107912281']
    );
});

test('전체 capture는 실행 직전 DEV 활성 429호·299 PNU가 anchor와 exact 일치해야 한다', () => {
    const full299 = parseDevelopmentTargetManifest(
        JSON.parse(readFileSync(MIA_FULL_299_TARGET_URL, 'utf8'))
    );
    assert.equal(
        full299.version,
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V2
    );
    if (
        full299.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION_V2
    ) {
        throw new Error('v2 full299 expected');
    }
    const rows = Array.from(
        { length: full299.expectedUnionActivePropertyUnitCount },
        (_, index) => ({
            id: `00000000-0000-4000-a000-${String(index + 1).padStart(12, '0')}`,
            pnu: full299.anchors[
                index < full299.anchors.length
                    ? index
                    : index - full299.anchors.length
            ],
        })
    );
    assert.doesNotThrow(() =>
        assertDevelopmentEvidenceCaptureActiveIdentity({
            target: full299,
            rows,
        })
    );

    const sameCountsDifferentPnu = rows.map((row) => ({ ...row }));
    sameCountsDifferentPnu[full299.anchors.length - 1].pnu =
        '1130510100109999999';
    assert.throws(
        () =>
            assertDevelopmentEvidenceCaptureActiveIdentity({
                target: full299,
                rows: sameCountsDifferentPnu,
            }),
        /CAPTURE_UNION_ACTIVE_PNU_SET_MISMATCH/
    );
    assert.throws(
        () =>
            assertDevelopmentEvidenceCaptureActiveIdentity({
                target: full299,
                rows: rows.slice(0, -1),
            }),
        /CAPTURE_UNION_ACTIVE_PROPERTY_SET_MISMATCH/
    );
});

test('read-only audit 집계는 식별자 없이 CAPTURED/NO_DATA/REVIEW/FAILED를 분리한다', () => {
    const base = {
        anchorPnu: PNU,
        strategy: null,
        scannedPnuCount: 0,
        propertyUnitCount: 0,
        snapshotReferenceSha256: null,
        applyRpcBlocked: false,
        failureCode: null,
        terminalScopeState: null,
        terminalOutcome: null,
        terminalIssueCodes: [],
        terminalIssuesTotal: 0,
        terminalIssuesTruncated: false,
    } as const;
    const aggregate = aggregateDevelopmentEvidenceCaptureEntries([
        { ...base, status: 'CAPTURED' },
        {
            ...base,
            status: 'FAILED',
            terminalOutcome: 'NO_DATA',
        },
        {
            ...base,
            status: 'FAILED',
            terminalScopeState: 'REVIEW_REQUIRED',
            terminalOutcome: 'REVIEW_REQUIRED',
        },
        {
            ...base,
            status: 'FAILED',
            terminalScopeState: 'FAILED',
            terminalOutcome: 'FAILED',
        },
    ]);
    assert.deepEqual(aggregate, {
        CAPTURED: 1,
        NO_DATA: 1,
        REVIEW: 1,
        FAILED: 1,
    });
    assert.equal(JSON.stringify(aggregate).includes(PNU), false);
    assert.equal(
        JSON.stringify(aggregate).includes(PROPERTY_UNIT_ID),
        false
    );
});

test('read-only live snapshot은 runner가 재검증하는 strict evidence로 변환된다', () => {
    const targetManifest = target();
    const entry = developmentEvidenceEntryFromSnapshot({
        target: targetManifest,
        captureRunId: '30118336235',
        anchorPnu: PNU,
        snapshot: snapshot(),
    });

    assert.equal(entry.expectedStrategy, 'LADFRL');
    assert.deepEqual(entry.expectedPropertyUnitIds, [
        PROPERTY_UNIT_ID,
    ]);
    assert.deepEqual(entry.allowedPrestates, [
        {
            propertyUnitId: PROPERTY_UNIT_ID,
            landArea: null,
            landAreaSource: 'LEGACY_UNKNOWN',
        },
        {
            propertyUnitId: PROPERTY_UNIT_ID,
            landArea: '161',
            landAreaSource: 'LADFRL',
        },
    ]);
    assert.match(
        entry.parcelScopeEvidence.ref,
        /^captureRun=30118336235;snapshot=[0-9a-f]{64}$/
    );
    assert.doesNotThrow(() =>
        parseDevelopmentEvidenceManifest({
            version: DEVELOPMENT_EVIDENCE_MANIFEST_VERSION,
            databaseTarget: 'development',
            unionId: UNION_ID,
            manifestDigest: targetManifest.manifestDigest,
            entries: [entry],
        })
    );
});

test('자동 capture는 MANUAL prestate를 승인 evidence로 승격하지 않는다', () => {
    assert.throws(
        () =>
            developmentEvidenceEntryFromSnapshot({
                target: target(),
                captureRunId: '30118336235',
                anchorPnu: PNU,
                snapshot: snapshot('MANUAL'),
            }),
        /CAPTURE_MANUAL_PRESTATE_OUTSIDE_AUTO_TARGET/
    );
});

test('v2 API capture는 MANUAL 값을 동시성 guard로 보존하고 API 제안값과 정직한 provenance를 기록한다', () => {
    const targetManifest = targetV2();
    const manualSnapshot: LandAreaSyncScopeSnapshot = {
        ...snapshot('MANUAL', '8.26'),
        strategy: 'LDAREG',
        scannedPnus: [PNU, ATTACHED_PNU],
        proposedLandAreas: [
            {
                propertyUnitId: PROPERTY_UNIT_ID,
                landArea: '39.08',
            },
        ],
        ladfrlAreaEvidence: {
            version: 'land-area-sync.ladfrl-scope.v1',
            parcels: [
                { pnu: PNU, area: '73' },
                { pnu: ATTACHED_PNU, area: '102' },
            ],
            totalArea: '175',
        },
    };
    const entry = developmentEvidenceEntryFromSnapshot({
        target: targetManifest,
        captureRunId: '30118336235',
        anchorPnu: PNU,
        snapshot: manualSnapshot,
    });

    assert.equal(entry.allowManualOverwrite, true);
    assert.deepEqual(entry.allowedPrestates, [
        {
            propertyUnitId: PROPERTY_UNIT_ID,
            landArea: '8.26',
            landAreaSource: 'MANUAL',
        },
        {
            propertyUnitId: PROPERTY_UNIT_ID,
            landArea: '39.08',
            landAreaSource: 'LDAREG',
        },
    ]);
    assert.equal('kind' in entry.sourceReferences, true);
    if (!('kind' in entry.sourceReferences)) {
        throw new Error('API capture provenance expected');
    }
    assert.deepEqual(entry.sourceReferences, {
        kind: 'DEVELOPMENT_READ_ONLY_API_CAPTURE',
        captureRunId: '30118336235',
        snapshotReferenceSha256:
            entry.sourceReferences.snapshotReferenceSha256,
    });
    assert.match(
        entry.sourceReferences.snapshotReferenceSha256,
        /^[0-9a-f]{64}$/
    );
    assert.equal(
        JSON.stringify(entry.sourceReferences).includes(
            'workbookFileReferenceSha256'
        ),
        false
    );
    assert.doesNotThrow(() =>
        parseDevelopmentEvidenceManifest({
            version: DEVELOPMENT_EVIDENCE_MANIFEST_VERSION_V2,
            databaseTarget: 'development',
            unionId: UNION_ID,
            manifestDigest: targetManifest.manifestDigest,
            entries: [entry],
        })
    );
});

test('resolved scope가 승인 target을 벗어나면 capture 단계에서 중단한다', () => {
    const expanded = {
        ...snapshot(),
        scannedPnus: [PNU, '1130510100107912167'],
        ladfrlAreaEvidence: {
            version: 'land-area-sync.ladfrl-scope.v1' as const,
            parcels: [
                { pnu: PNU, area: '161' },
                { pnu: '1130510100107912167', area: '20' },
            ],
            totalArea: '181',
        },
    };
    assert.throws(
        () =>
            developmentEvidenceEntryFromSnapshot({
                target: target(),
                captureRunId: '30118336235',
                anchorPnu: PNU,
                snapshot: expanded,
            }),
        /CAPTURE_SCOPE_OUTSIDE_TARGET/
    );
});
