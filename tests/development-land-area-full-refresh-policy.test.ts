import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEVELOPMENT_LAND_AREA_FULL_REFRESH_DENIED_CODE,
    DEVELOPMENT_LAND_AREA_FULL_REFRESH_PROFILE,
    MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_MANIFEST_DIGEST,
    MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_SCOPE_DIGEST,
    MIA_SEVEN_DEVELOPMENT_UNION_ID,
    assertDevelopmentLandAreaFullRefreshAllowed,
    developmentLandAreaFullRefreshMarkersEqual,
    parseDevelopmentLandAreaFullRefreshMarker,
} from '../src/security/development-land-area-full-refresh-policy';

function pinnedMarker() {
    return {
        profile: DEVELOPMENT_LAND_AREA_FULL_REFRESH_PROFILE,
        manifestDigest:
            MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_MANIFEST_DIGEST,
        scopeDigest:
            MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_SCOPE_DIGEST,
    };
}

test('repo-pinned 미아7 DEV 전체 갱신 표식만 허용한다', () => {
    const marker =
        parseDevelopmentLandAreaFullRefreshMarker(pinnedMarker());
    assert.ok(marker);
    assert.doesNotThrow(() =>
        assertDevelopmentLandAreaFullRefreshAllowed({
            databaseTarget: 'development',
            unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
            marker,
        })
    );
});

test('같은 digest라도 production 전체 갱신은 hard deny한다', () => {
    assert.throws(
        () =>
            assertDevelopmentLandAreaFullRefreshAllowed({
                databaseTarget: 'production',
                unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
                marker: pinnedMarker(),
            }),
        (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code ===
                DEVELOPMENT_LAND_AREA_FULL_REFRESH_DENIED_CODE
    );
});

test('표식은 exact key와 pinned digest를 요구한다', () => {
    assert.throws(() =>
        parseDevelopmentLandAreaFullRefreshMarker({
            ...pinnedMarker(),
            unexpected: true,
        })
    );
    assert.throws(() =>
        assertDevelopmentLandAreaFullRefreshAllowed({
            databaseTarget: 'development',
            unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
            marker: {
                ...pinnedMarker(),
                manifestDigest: '0'.repeat(64),
            },
        })
    );
});

test('jsonb key order가 달라도 canonical marker는 동일하다', () => {
    const marker = pinnedMarker();
    assert.equal(
        developmentLandAreaFullRefreshMarkersEqual(
            {
                scopeDigest: marker.scopeDigest,
                profile: marker.profile,
                manifestDigest: marker.manifestDigest,
            },
            marker
        ),
        true
    );
});
