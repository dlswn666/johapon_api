/**
 * 미아7 DEV 전체 재조회 전용 공식 무데이터 판정.
 *
 * 일반/운영/PNU 확장에는 사용하지 않는다. repo-pinned marker+anchor, same-run 공식
 * endpoint 완전성, exact 활성 property membership을 모두 만족할 때만 immutable no-op
 * evidence를 만든다. 현재 land_area/source는 입력에도 없고 판정에도 사용하지 않는다.
 */

import { createHash } from 'node:crypto';
import {
    assertDevelopmentLandAreaVerifiedNoDataAllowed,
    MIA_SEVEN_DEVELOPMENT_VERIFIED_NO_DATA_PROPERTY_UNIT_COUNT,
} from '../../security/development-land-area-full-refresh-policy';
import type {
    LandAreaSyncDevelopmentFullRefresh,
    LandAreaSyncScopeSnapshot,
} from '../../types/land-area-sync-job.types';
import type {
    BrAtchJibunRow,
    BrBasisOulnRow,
    BrExposRow,
    BrTitleRow,
    LadfrlRow,
    LdaregRow,
    StrictScan,
} from '../../types/land-area-sync.types';
import type { DatabaseTarget } from '../../types/database.types';
import type { PropertyUnitCandidate } from './matcher';
import {
    canonicalStableStringify,
    computePropertyMembershipHash,
    type DbScopeResolution,
} from './scope';
import { resolveScopeLadfrlAreas } from './ladfrl-scope';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type VerifiedNoDataEvidence =
    NonNullable<LandAreaSyncScopeSnapshot['verifiedNoDataEvidence']>;
type EndpointEvidence = VerifiedNoDataEvidence['endpointEvidence'][number];

export interface DevelopmentFullRefreshVerifiedNoDataInput {
    databaseTarget: DatabaseTarget | undefined;
    unionId: string;
    anchorPnu: string;
    marker: LandAreaSyncDevelopmentFullRefresh;
    dbScope: DbScopeResolution;
    title: StrictScan<BrTitleRow>;
    basis: StrictScan<BrBasisOulnRow>;
    attached: StrictScan<BrAtchJibunRow>;
    expos: StrictScan<BrExposRow>;
    ladfrl: StrictScan<LadfrlRow>;
    ldareg: StrictScan<LdaregRow>;
    propertyUnits: PropertyUnitCandidate[];
}

export interface DevelopmentFullRefreshVerifiedNoDataResolution {
    evidence: VerifiedNoDataEvidence;
    propertyMembership: Array<{
        propertyUnitId: string;
        pnu: string;
    }>;
    propertyUnitIds: string[];
    ladfrlAreaEvidence: {
        parcels: Array<{ pnu: string; area: string }>;
        totalArea: string;
    };
}

function sha256(value: string): string {
    return createHash('sha256')
        .update(value, 'utf8')
        .digest('hex');
}

function isCompleteZero<T>(
    scan: StrictScan<T>
): scan is Extract<StrictScan<T>, { state: 'COMPLETE_ZERO' }> {
    return (
        scan.state === 'COMPLETE_ZERO' &&
        scan.totalCount === 0 &&
        scan.rows.length === 0 &&
        Number.isSafeInteger(scan.pagesFetched) &&
        scan.pagesFetched >= 1
    );
}

function endpointZero(
    endpoint: EndpointEvidence['endpoint'],
    scan: Extract<
        StrictScan<unknown>,
        { state: 'COMPLETE_ZERO' }
    >
): EndpointEvidence {
    return {
        endpoint,
        state: 'COMPLETE_ZERO',
        totalCount: 0,
        pagesFetched: scan.pagesFetched,
        rowCount: 0,
        rowDigest: sha256(canonicalStableStringify([])),
    };
}

/**
 * 조건 불충족은 null이다. 호출자는 기존 일반 gate를 그대로 실행하므로 공식 행 출현,
 * provider 실패/미완료, membership drift는 자동 no-op으로 우회되지 않는다.
 */
export function resolveDevelopmentFullRefreshVerifiedNoData(
    input: DevelopmentFullRefreshVerifiedNoDataInput
): DevelopmentFullRefreshVerifiedNoDataResolution | null {
    try {
        assertDevelopmentLandAreaVerifiedNoDataAllowed({
            databaseTarget: input.databaseTarget,
            unionId: input.unionId,
            anchorPnu: input.anchorPnu,
            marker: input.marker,
        });
    } catch {
        return null;
    }

    if (
        input.dbScope.dbState !== 'NO_EVIDENCE' ||
        input.dbScope.componentTruncated ||
        input.dbScope.pendingEvidenceKeys.length > 0 ||
        input.dbScope.blockingEvidence.length > 0 ||
        input.dbScope.openUnresolvedEvidenceKeys.length > 0 ||
        !input.dbScope.dbScopeHash ||
        !isCompleteZero(input.title) ||
        !isCompleteZero(input.basis) ||
        !isCompleteZero(input.attached) ||
        !isCompleteZero(input.expos) ||
        !isCompleteZero(input.ldareg) ||
        input.ladfrl.state !== 'COMPLETE' ||
        input.ladfrl.totalCount !== 1 ||
        input.ladfrl.rows.length !== 1 ||
        !Number.isSafeInteger(input.ladfrl.pagesFetched) ||
        input.ladfrl.pagesFetched < 1
    ) {
        return null;
    }

    const ladfrl = resolveScopeLadfrlAreas(
        [
            {
                pnu: input.anchorPnu,
                rows: input.ladfrl.rows,
            },
        ],
        [input.anchorPnu]
    );
    if (
        !ladfrl.ok ||
        ladfrl.areas.length !== 1 ||
        ladfrl.areas[0].pnu !== input.anchorPnu
    ) {
        return null;
    }

    const active = input.propertyUnits
        .filter((row) => !row.isDeleted)
        .sort((left, right) => left.id.localeCompare(right.id));
    if (
        active.length !==
            MIA_SEVEN_DEVELOPMENT_VERIFIED_NO_DATA_PROPERTY_UNIT_COUNT ||
        active.some(
            (row) =>
                !UUID_RE.test(row.id) ||
                row.unionId.toLowerCase() !==
                    input.unionId.toLowerCase() ||
                row.pnu !== input.anchorPnu
        ) ||
        new Set(active.map((row) => row.id.toLowerCase())).size !==
            active.length
    ) {
        return null;
    }

    const propertyUnitIds = active
        .map((row) => row.id.toLowerCase())
        .sort();
    const propertyMembership = propertyUnitIds.map(
        (propertyUnitId) => ({
            propertyUnitId,
            pnu: input.anchorPnu,
        })
    );
    const propertyMembershipHash =
        computePropertyMembershipHash(propertyMembership);
    const propertyUnitIdsDigest = sha256(
        canonicalStableStringify({
            version:
                'land-area-sync.verified-no-data-property-ids.v1',
            propertyUnitIds,
        })
    );
    const endpointEvidence: EndpointEvidence[] = [
        endpointZero('TITLE', input.title),
        endpointZero('BASIS', input.basis),
        endpointZero('ATTACHED', input.attached),
        endpointZero('EXPOS', input.expos),
        {
            endpoint: 'LADFRL',
            state: 'COMPLETE',
            totalCount: 1,
            pagesFetched: input.ladfrl.pagesFetched,
            rowCount: 1,
            rowDigest: sha256(
                canonicalStableStringify([
                    {
                        pnu: input.anchorPnu,
                        area: ladfrl.areas[0].area,
                    },
                ])
            ),
        },
        endpointZero('LDAREG', input.ldareg),
    ];
    const endpointEvidenceDigest = sha256(
        canonicalStableStringify({
            version:
                'land-area-sync.verified-no-data-endpoints.v1',
            endpointEvidence,
        })
    );
    const evidenceCore = {
        version: 'land-area-sync.verified-no-data.v1' as const,
        kind: 'VERIFIED_NO_DATA' as const,
        reason:
            'OFFICIAL_BUILDING_AND_LDAREG_ENDPOINTS_COMPLETE_ZERO' as const,
        anchorPnu: input.anchorPnu,
        endpointEvidence,
        endpointEvidenceDigest,
        ladfrlArea: ladfrl.areas[0].area,
        propertyUnitCount: propertyUnitIds.length,
        propertyUnitIdsDigest,
        propertyMembershipHash,
        dbScopeHash: input.dbScope.dbScopeHash,
        manifestDigest: input.marker.manifestDigest,
        scopeDigest: input.marker.scopeDigest,
    };
    const evidenceDigest = sha256(
        canonicalStableStringify(evidenceCore)
    );
    return {
        evidence: {
            ...evidenceCore,
            evidenceDigest,
        },
        propertyMembership,
        propertyUnitIds,
        ladfrlAreaEvidence: {
            parcels: ladfrl.areas,
            totalArea: ladfrl.totalArea,
        },
    };
}
