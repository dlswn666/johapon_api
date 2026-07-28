import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEVELOPMENT_LAND_AREA_FULL_REFRESH_PROFILE,
    MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_MANIFEST_DIGEST,
    MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_SCOPE_DIGEST,
    MIA_SEVEN_DEVELOPMENT_UNION_ID,
    MIA_SEVEN_DEVELOPMENT_VERIFIED_NO_DATA_ANCHOR,
} from '../src/security/development-land-area-full-refresh-policy';
import {
    resolveDevelopmentFullRefreshVerifiedNoData,
    type DevelopmentFullRefreshVerifiedNoDataInput,
} from '../src/services/land-area-sync/verified-no-data';
import type {
    BrAtchJibunRow,
    BrBasisOulnRow,
    BrExposRow,
    BrTitleRow,
    LdaregRow,
    StrictScan,
} from '../src/types/land-area-sync.types';

const PROPERTY_IDS = Array.from(
    { length: 7 },
    (_, index) =>
        `00000000-0000-4000-8000-${String(index + 1).padStart(
            12,
            '0'
        )}`
);

function zero<T>(): StrictScan<T> {
    return {
        state: 'COMPLETE_ZERO',
        rows: [],
        totalCount: 0,
        pagesFetched: 1,
    };
}

function baseInput(): DevelopmentFullRefreshVerifiedNoDataInput {
    return {
        databaseTarget: 'development',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        anchorPnu:
            MIA_SEVEN_DEVELOPMENT_VERIFIED_NO_DATA_ANCHOR,
        marker: {
            profile:
                DEVELOPMENT_LAND_AREA_FULL_REFRESH_PROFILE,
            manifestDigest:
                MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_MANIFEST_DIGEST,
            scopeDigest:
                MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_SCOPE_DIGEST,
        },
        dbScope: {
            dbState: 'NO_EVIDENCE',
            rootBuildingIdentities: [],
            componentPnus: [
                MIA_SEVEN_DEVELOPMENT_VERIFIED_NO_DATA_ANCHOR,
            ],
            linkedBasePnus: [],
            linkedPnus: [],
            linkedEvidenceKeys: [],
            pendingEvidenceKeys: [],
            blockingEvidence: [],
            openUnresolvedEvidenceKeys: [],
            componentTruncated: false,
            propertyMembership: [],
            dbScopeHash: 'db-scope-exact-no-evidence',
        },
        title: zero<BrTitleRow>(),
        basis: zero<BrBasisOulnRow>(),
        attached: zero<BrAtchJibunRow>(),
        expos: zero<BrExposRow>(),
        ladfrl: {
            state: 'COMPLETE',
            rows: [
                {
                    pnu: MIA_SEVEN_DEVELOPMENT_VERIFIED_NO_DATA_ANCHOR,
                    lndpclAr: '73.000',
                },
            ],
            totalCount: 1,
            pagesFetched: 1,
        },
        ldareg: zero<LdaregRow>(),
        propertyUnits: PROPERTY_IDS.map((id) => ({
            id,
            unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
            buildingUnitId: null,
            pnu: MIA_SEVEN_DEVELOPMENT_VERIFIED_NO_DATA_ANCHOR,
            isDeleted: false,
        })),
    };
}

test('DEV repo-pinned 3568의 fresh 공식 5 endpoint zero + LADFRL 1행 + exact 7호만 immutable VERIFIED_NO_DATA를 만든다', () => {
    const input = baseInput();
    const resolved =
        resolveDevelopmentFullRefreshVerifiedNoData(input);
    assert.ok(resolved);
    assert.equal(resolved.evidence.kind, 'VERIFIED_NO_DATA');
    assert.equal(resolved.evidence.ladfrlArea, '73');
    assert.equal(resolved.evidence.propertyUnitCount, 7);
    assert.equal(
        resolved.evidence.manifestDigest,
        MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_MANIFEST_DIGEST
    );
    assert.equal(
        resolved.evidence.scopeDigest,
        MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_SCOPE_DIGEST
    );
    assert.deepEqual(
        resolved.evidence.endpointEvidence.map(
            ({ endpoint, state, totalCount, rowCount }) => ({
                endpoint,
                state,
                totalCount,
                rowCount,
            })
        ),
        [
            {
                endpoint: 'TITLE',
                state: 'COMPLETE_ZERO',
                totalCount: 0,
                rowCount: 0,
            },
            {
                endpoint: 'BASIS',
                state: 'COMPLETE_ZERO',
                totalCount: 0,
                rowCount: 0,
            },
            {
                endpoint: 'ATTACHED',
                state: 'COMPLETE_ZERO',
                totalCount: 0,
                rowCount: 0,
            },
            {
                endpoint: 'EXPOS',
                state: 'COMPLETE_ZERO',
                totalCount: 0,
                rowCount: 0,
            },
            {
                endpoint: 'LADFRL',
                state: 'COMPLETE',
                totalCount: 1,
                rowCount: 1,
            },
            {
                endpoint: 'LDAREG',
                state: 'COMPLETE_ZERO',
                totalCount: 0,
                rowCount: 0,
            },
        ]
    );
    assert.deepEqual(
        resolved.propertyUnitIds,
        [...PROPERTY_IDS].sort()
    );
    assert.deepEqual(resolved.ladfrlAreaEvidence, {
        parcels: [
            {
                pnu: MIA_SEVEN_DEVELOPMENT_VERIFIED_NO_DATA_ANCHOR,
                area: '73',
            },
        ],
        totalArea: '73',
    });

    const reordered = baseInput();
    reordered.propertyUnits.reverse();
    assert.equal(
        resolveDevelopmentFullRefreshVerifiedNoData(reordered)
            ?.evidence.evidenceDigest,
        resolved.evidence.evidenceDigest
    );
});

test('VERIFIED_NO_DATA는 PROD·다른 PNU·다른 marker에서 fail-closed한다', () => {
    const production = baseInput();
    production.databaseTarget = 'production';
    assert.equal(
        resolveDevelopmentFullRefreshVerifiedNoData(production),
        null
    );

    const otherPnu = baseInput();
    otherPnu.anchorPnu = '1130510100107913569';
    otherPnu.ladfrl = {
        state: 'COMPLETE',
        rows: [
            {
                pnu: otherPnu.anchorPnu,
                lndpclAr: '73',
            },
        ],
        totalCount: 1,
        pagesFetched: 1,
    };
    for (const propertyUnit of otherPnu.propertyUnits) {
        propertyUnit.pnu = otherPnu.anchorPnu;
    }
    assert.equal(
        resolveDevelopmentFullRefreshVerifiedNoData(otherPnu),
        null
    );

    const forgedMarker = baseInput();
    forgedMarker.marker = {
        ...forgedMarker.marker,
        scopeDigest: '0'.repeat(64),
    };
    assert.equal(
        resolveDevelopmentFullRefreshVerifiedNoData(forgedMarker),
        null
    );
});

test('fresh 공식 데이터 출현·endpoint 불완전·LADFRL 비정상은 no-data 우회가 아니라 기존 일반 gate로 돌아간다', () => {
    const titleAppeared = baseInput();
    titleAppeared.title = {
        state: 'COMPLETE',
        rows: [{ mgmBldrgstPk: '1002003004005' }],
        totalCount: 1,
        pagesFetched: 1,
    };
    assert.equal(
        resolveDevelopmentFullRefreshVerifiedNoData(titleAppeared),
        null
    );

    const failedEndpoint = baseInput();
    failedEndpoint.expos = {
        state: 'FAILED',
        issue: {
            kind: 'HTTP_ERROR',
            endpoint: 'getBrExposInfo',
            message: 'redacted',
            httpStatus: 500,
        },
    };
    assert.equal(
        resolveDevelopmentFullRefreshVerifiedNoData(failedEndpoint),
        null
    );

    const multipleLadfrl = baseInput();
    multipleLadfrl.ladfrl = {
        state: 'COMPLETE',
        rows: [
            {
                pnu: MIA_SEVEN_DEVELOPMENT_VERIFIED_NO_DATA_ANCHOR,
                lndpclAr: '73',
            },
            {
                pnu: MIA_SEVEN_DEVELOPMENT_VERIFIED_NO_DATA_ANCHOR,
                lndpclAr: '74',
            },
        ],
        totalCount: 2,
        pagesFetched: 1,
    };
    assert.equal(
        resolveDevelopmentFullRefreshVerifiedNoData(multipleLadfrl),
        null
    );

    const nonPositiveLadfrl = baseInput();
    nonPositiveLadfrl.ladfrl = {
        state: 'COMPLETE',
        rows: [
            {
                pnu: MIA_SEVEN_DEVELOPMENT_VERIFIED_NO_DATA_ANCHOR,
                lndpclAr: '0',
            },
        ],
        totalCount: 1,
        pagesFetched: 1,
    };
    assert.equal(
        resolveDevelopmentFullRefreshVerifiedNoData(
            nonPositiveLadfrl
        ),
        null
    );
});

test('exact 활성 7호 membership 또는 NO_EVIDENCE DB scope가 흔들리면 VERIFIED_NO_DATA를 만들지 않는다', () => {
    const sixProperties = baseInput();
    sixProperties.propertyUnits.pop();
    assert.equal(
        resolveDevelopmentFullRefreshVerifiedNoData(sixProperties),
        null
    );

    const wrongMembership = baseInput();
    wrongMembership.propertyUnits[0].pnu =
        '1130510100107913569';
    assert.equal(
        resolveDevelopmentFullRefreshVerifiedNoData(wrongMembership),
        null
    );

    const pendingScope = baseInput();
    pendingScope.dbScope.dbState = 'PENDING';
    pendingScope.dbScope.pendingEvidenceKeys = ['pending'];
    assert.equal(
        resolveDevelopmentFullRefreshVerifiedNoData(pendingScope),
        null
    );
});
