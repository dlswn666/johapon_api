import type { DatabaseTarget } from '../types/database.types';
import type { LandAreaSyncDevelopmentFullRefresh } from '../types/land-area-sync-job.types';

const HEX64_RE = /^[0-9a-f]{64}$/;

export const DEVELOPMENT_LAND_AREA_FULL_REFRESH_PROFILE =
    'DEVELOPMENT_FULL_REFRESH_API_REQUERY_V1' as const;
export const MIA_SEVEN_DEVELOPMENT_UNION_ID =
    '00f48b95-e9bc-4c92-a0e5-6b9a57adcfb9';
export const MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_SCOPE_DIGEST =
    'a138f3310593bca21f6f64311e47f525da4eaf28ae4c1d01af855852d0f1a586';
// 2026-08-01 개정: 3568 도로지분 7건은 공식 대지권등록부 원천 부재(3회 실측)로
// 자동화 제외 — expectedPropertyUnitCount 429→422 재정의에 따른 digest 갱신.
export const MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_MANIFEST_DIGEST =
    '17f07208a0192d9e289d0e348b87bd3bd8ce9a2f5ec1396afcb4f5466c44bc9d';

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
