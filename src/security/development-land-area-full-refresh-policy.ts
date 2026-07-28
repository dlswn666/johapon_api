import type { DatabaseTarget } from '../types/database.types';
import type { LandAreaSyncDevelopmentFullRefresh } from '../types/land-area-sync-job.types';

const HEX64_RE = /^[0-9a-f]{64}$/;

export const DEVELOPMENT_LAND_AREA_FULL_REFRESH_PROFILE =
    'DEVELOPMENT_FULL_REFRESH_API_REQUERY_V1' as const;
export const MIA_SEVEN_DEVELOPMENT_UNION_ID =
    '00f48b95-e9bc-4c92-a0e5-6b9a57adcfb9';
export const MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_SCOPE_DIGEST =
    'c661e864d20342519cf7d453454ead53d9279a21c37cdfaa87b8e68f5e2a7eb9';
export const MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_MANIFEST_DIGEST =
    '4235381c31245833b944c09664499f69aedd71282560f42807cb5c379bffa3b3';
/**
 * 미아7 전체 재조회에서 공식 건축물/대지권 endpoint가 모두 명시적 0건인 것으로
 * 관측된 유일한 anchor. 이 예외는 target manifest를 넓히지 않고 current marker와
 * 함께 exact pin한다.
 */
export const MIA_SEVEN_DEVELOPMENT_VERIFIED_NO_DATA_ANCHOR =
    '1130510100107913568';
export const MIA_SEVEN_DEVELOPMENT_VERIFIED_NO_DATA_PROPERTY_UNIT_COUNT =
    7;

export const DEVELOPMENT_LAND_AREA_FULL_REFRESH_DENIED_CODE =
    'DEVELOPMENT_LAND_AREA_FULL_REFRESH_DENIED';
export const DEVELOPMENT_LAND_AREA_FULL_REFRESH_INVALID_CODE =
    'DEVELOPMENT_LAND_AREA_FULL_REFRESH_INVALID';

export class DevelopmentLandAreaFullRefreshError extends Error {
    constructor(
        readonly code:
            | typeof DEVELOPMENT_LAND_AREA_FULL_REFRESH_DENIED_CODE
            | typeof DEVELOPMENT_LAND_AREA_FULL_REFRESH_INVALID_CODE,
        readonly status: 400 | 403,
        message: string
    ) {
        super(message);
        this.name = 'DevelopmentLandAreaFullRefreshError';
    }
}

function hasExactMarkerKeys(value: Record<string, unknown>): boolean {
    return (
        JSON.stringify(Object.keys(value).sort()) ===
        JSON.stringify(
            ['manifestDigest', 'profile', 'scopeDigest'].sort()
        )
    );
}

/** 외부 입력/저장 preview의 full-refresh 표식을 exact shape로 파싱한다. */
export function parseDevelopmentLandAreaFullRefreshMarker(
    value: unknown
): LandAreaSyncDevelopmentFullRefresh | null {
    if (value == null) return null;
    if (
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !hasExactMarkerKeys(value as Record<string, unknown>)
    ) {
        throw new DevelopmentLandAreaFullRefreshError(
            DEVELOPMENT_LAND_AREA_FULL_REFRESH_INVALID_CODE,
            400,
            '개발 전체 대지권 갱신 표식이 올바르지 않습니다.'
        );
    }
    const marker = value as Record<string, unknown>;
    if (
        marker.profile !== DEVELOPMENT_LAND_AREA_FULL_REFRESH_PROFILE ||
        typeof marker.manifestDigest !== 'string' ||
        !HEX64_RE.test(marker.manifestDigest) ||
        typeof marker.scopeDigest !== 'string' ||
        !HEX64_RE.test(marker.scopeDigest)
    ) {
        throw new DevelopmentLandAreaFullRefreshError(
            DEVELOPMENT_LAND_AREA_FULL_REFRESH_INVALID_CODE,
            400,
            '개발 전체 대지권 갱신 표식이 올바르지 않습니다.'
        );
    }
    return {
        profile: DEVELOPMENT_LAND_AREA_FULL_REFRESH_PROFILE,
        manifestDigest: marker.manifestDigest,
        scopeDigest: marker.scopeDigest,
    };
}

/** jsonb key order와 무관하게 canonical marker 필드만 비교한다. */
export function developmentLandAreaFullRefreshMarkersEqual(
    left: unknown,
    right: unknown
): boolean {
    const a = parseDevelopmentLandAreaFullRefreshMarker(left);
    const b = parseDevelopmentLandAreaFullRefreshMarker(right);
    if (a === null || b === null) return a === b;
    return (
        a.profile === b.profile &&
        a.manifestDigest === b.manifestDigest &&
        a.scopeDigest === b.scopeDigest
    );
}

/**
 * 미아7 repo-pinned 전체 갱신만 허용한다. 운영 target은 digest가 같아도 항상 거부한다.
 */
export function assertDevelopmentLandAreaFullRefreshAllowed(input: {
    databaseTarget: DatabaseTarget | undefined;
    unionId: string;
    marker: LandAreaSyncDevelopmentFullRefresh;
}): void {
    if (input.databaseTarget !== 'development') {
        throw new DevelopmentLandAreaFullRefreshError(
            DEVELOPMENT_LAND_AREA_FULL_REFRESH_DENIED_CODE,
            403,
            '개발 전체 대지권 갱신은 운영 환경에서 실행할 수 없습니다.'
        );
    }
    if (
        input.unionId.toLowerCase() !==
            MIA_SEVEN_DEVELOPMENT_UNION_ID ||
        input.marker.profile !==
            DEVELOPMENT_LAND_AREA_FULL_REFRESH_PROFILE ||
        input.marker.manifestDigest !==
            MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_MANIFEST_DIGEST ||
        input.marker.scopeDigest !==
            MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_SCOPE_DIGEST
    ) {
        throw new DevelopmentLandAreaFullRefreshError(
            DEVELOPMENT_LAND_AREA_FULL_REFRESH_DENIED_CODE,
            403,
            'repo에 고정된 미아7 개발 전체 갱신 대상과 일치하지 않습니다.'
        );
    }
}

/**
 * 일반 full-refresh 허용 검증에 더해 공식 무데이터 no-op의 유일한 anchor를 고정한다.
 * 다른 PNU/union/marker/운영 target은 같은 API shape를 반환해도 절대 승격하지 않는다.
 */
export function assertDevelopmentLandAreaVerifiedNoDataAllowed(input: {
    databaseTarget: DatabaseTarget | undefined;
    unionId: string;
    anchorPnu: string;
    marker: LandAreaSyncDevelopmentFullRefresh;
}): void {
    assertDevelopmentLandAreaFullRefreshAllowed(input);
    if (
        input.anchorPnu !==
        MIA_SEVEN_DEVELOPMENT_VERIFIED_NO_DATA_ANCHOR
    ) {
        throw new DevelopmentLandAreaFullRefreshError(
            DEVELOPMENT_LAND_AREA_FULL_REFRESH_DENIED_CODE,
            403,
            'repo에 고정된 미아7 공식 무데이터 대상과 일치하지 않습니다.'
        );
    }
}
