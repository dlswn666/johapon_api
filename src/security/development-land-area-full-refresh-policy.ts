import type { DatabaseTarget } from '../types/database.types';
import type { LandAreaSyncDevelopmentFullRefresh } from '../types/land-area-sync-job.types';

const HEX64_RE = /^[0-9a-f]{64}$/;

export const DEVELOPMENT_LAND_AREA_FULL_REFRESH_PROFILE =
    'DEVELOPMENT_FULL_REFRESH_API_REQUERY_V1' as const;
export const MIA_SEVEN_DEVELOPMENT_UNION_ID =
    '00f48b95-e9bc-4c92-a0e5-6b9a57adcfb9';
export const MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_SCOPE_DIGEST =
    '8c87b46f17416cd5aad9aaa242f09ff04aefb4186f74b72370ebb9c1407caa73';
export const MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_MANIFEST_DIGEST =
    '02bf999d970a9f0228a0bc683cc630fb157e5f4becb8576d0f4aa5b4dec1d3db';

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
