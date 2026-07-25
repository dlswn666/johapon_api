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
