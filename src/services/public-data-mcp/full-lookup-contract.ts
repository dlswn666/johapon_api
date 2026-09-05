import * as z from 'zod/v4';
import { BUILDING_HUB_BASE_URL } from '../gis-shared/endpoints';

export const LOOKUP_FULL_GIS_PUBLIC_DATA_TOOL_NAME = 'lookup_full_gis_public_data_v1' as const;
export const FULL_GIS_SOURCE_IDS = [
    'geocode', 'coord_to_pnu', 'reverse_geocode',
    'boundary_vworld', 'boundary_vworld_wfs', 'land_registry',
    'land_price', 'apart_price', 'indiv_house_price',
    'building_title', 'building_units', 'building_floors',
    'land_share_registry', 'building_ho_land_share',
] as const;
export type FullGisSourceId = (typeof FULL_GIS_SOURCE_IDS)[number];

const ned = 'https://api.vworld.kr/ned/data';
const address = 'https://api.vworld.kr/req/address';
const data = 'https://api.vworld.kr/req/data';
export const FULL_GIS_SOURCE_META: Record<FullGisSourceId, {
    name: string; provider: string; source: string; attribution: string;
}> = Object.fromEntries([
    ['geocode', '지오코딩 (주소→좌표)', address],
    ['coord_to_pnu', '좌표→PNU', data],
    ['reverse_geocode', '역지오코딩 (좌표→도로명주소)', address],
    ['boundary_vworld', '필지 경계 (Data API)', data],
    ['boundary_vworld_wfs', '필지 경계 (WFS)', 'https://api.vworld.kr/ned/wfs/getCtnlgsSpceWFS'],
    ['land_registry', '토지대장', `${ned}/ladfrlList`],
    ['land_price', '개별공시지가', `${ned}/getIndvdLandPriceAttr`],
    ['apart_price', '공동주택가격', `${ned}/getApartHousingPriceAttr`],
    ['indiv_house_price', '개별주택가격', `${ned}/getIndvdHousingPriceAttr`],
    ['building_title', '건축물대장 표제부', `${BUILDING_HUB_BASE_URL}/getBrTitleInfo`],
    ['building_units', '건축물대장 전유부', `${BUILDING_HUB_BASE_URL}/getBrExposInfo`],
    ['building_floors', '건축물대장 층별개요', `${BUILDING_HUB_BASE_URL}/getBrFlrOulnInfo`],
    ['land_share_registry', '대지권등록부', `${ned}/ldaregList`],
    ['building_ho_land_share', '건물호수조회', `${ned}/buldHoCoList`],
].map(([id, name, source]) => [id, {
    name, source,
    provider: source.startsWith(BUILDING_HUB_BASE_URL) ? '공공데이터포털 건축HUB' : 'VWorld',
    attribution: source.startsWith(BUILDING_HUB_BASE_URL)
        ? '국토교통부 건축HUB 공공데이터포털 자료를 이용했습니다.'
        : '국토교통부 VWorld 공공데이터를 이용했습니다.',
}])) as Record<FullGisSourceId, {
    name: string; provider: string; source: string; attribution: string;
}>;

const pnuSchema = z.string().regex(/^\d{10}[12]\d{8}$/);
const offsetSchema = z.number().int().min(0).max(1_000_000);
export const LookupFullGisPublicDataInputV1Schema = z.object({
    address: z.string().trim().min(1).max(300).optional(),
    pnu: pnuSchema.optional(),
    year: z.number().int().min(2000).max(new Date().getFullYear() + 1).optional(),
    offset: offsetSchema.default(0),
    offsets: z.partialRecord(z.enum(FULL_GIS_SOURCE_IDS), offsetSchema).optional(),
    limit: z.number().int().min(1).max(20).default(10),
    buildingHo: z.string().trim().min(1).max(40).optional(),
}).strict().refine((value) => Boolean(value.address || value.pnu), {
    message: '주소 또는 PNU가 필요합니다.',
});
export type LookupFullGisPublicDataInputV1 = z.infer<typeof LookupFullGisPublicDataInputV1Schema>;

export const FullGisStepSchema = z.object({
    id: z.enum(FULL_GIS_SOURCE_IDS),
    name: z.string().min(1).max(100),
    provider: z.string().min(1).max(120),
    source: z.string().url().max(500),
    asOf: z.string().min(1).max(80),
    attribution: z.string().min(1).max(500),
    status: z.enum(['SUCCESS', 'PARTIAL', 'NO_DATA', 'FAILED', 'INCOMPLETE', 'SKIPPED']),
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(100).optional(),
    records: z.array(z.record(z.string(), z.unknown())).max(20),
    pagination: z.object({
        offset: offsetSchema,
        limit: z.number().int().min(1).max(20),
        returned: z.number().int().min(0).max(20),
        total: z.number().int().min(0).nullable(),
        hasMore: z.boolean(),
        nextOffset: offsetSchema.nullable(),
    }).strict(),
    warnings: z.array(z.string().min(1).max(160)).max(20),
}).strict().superRefine((step, context) => {
    const page = step.pagination;
    const meta = FULL_GIS_SOURCE_META[step.id];
    if (step.source !== meta.source || step.provider !== meta.provider
        || step.name !== meta.name || step.attribution !== meta.attribution) {
        context.addIssue({ code: 'custom', message: '자료별 고정 출처와 다릅니다.' });
    }
    if (page.returned !== step.records.length || page.returned > page.limit
        || (!page.hasMore && page.nextOffset !== null)
        || (page.hasMore && (page.nextOffset === null || page.nextOffset < page.offset))) {
        context.addIssue({ code: 'custom', message: '자료별 페이지 정보가 반환 행과 다릅니다.' });
    }
    if (step.status === 'NO_DATA' && (page.total !== 0 || page.returned !== 0 || page.hasMore)) {
        context.addIssue({ code: 'custom', message: '무자료 상태에는 명시적 0건이 필요합니다.' });
    }
    if (step.status === 'SKIPPED' && (!step.code || page.returned !== 0)) {
        context.addIssue({ code: 'custom', message: '미호출 사유와 빈 자료가 필요합니다.' });
    }
    if (step.status === 'SUCCESS' && (page.total === null || page.total === 0
        || (page.offset < page.total && page.returned === 0)
        || (page.returned > 0 && page.offset + page.returned > page.total)
        || page.hasMore !== (page.offset + page.returned < page.total)
        || (page.hasMore && page.nextOffset !== page.offset + page.returned))) {
        context.addIssue({ code: 'custom', message: '성공 상태의 페이지 완전성이 올바르지 않습니다.' });
    }
});
export type FullGisStep = z.infer<typeof FullGisStepSchema>;

export const FullGisDataSchema = z.object({
    pnu: pnuSchema.nullable(),
    steps: z.array(FullGisStepSchema).length(14),
    allSourcesQueried: z.boolean(),
    allRecordsReturned: z.boolean(),
    hasMore: z.boolean(),
}).strict().superRefine((value, context) => {
    if (value.steps.some((step, index) => step.id !== FULL_GIS_SOURCE_IDS[index])) {
        context.addIssue({ code: 'custom', message: '14개 조회 항목의 순서가 올바르지 않습니다.' });
    }
    if (value.hasMore !== value.steps.some((step) => step.pagination.hasMore)
        || (value.allSourcesQueried && value.steps.some((step) => step.status === 'SKIPPED'))
        || (value.allRecordsReturned && (!value.allSourcesQueried || value.hasMore
            || value.steps.some((step) => !['SUCCESS', 'NO_DATA'].includes(step.status)
                || step.pagination.offset !== 0)))) {
        context.addIssue({ code: 'custom', message: '전체 조회 완료 표시와 자료별 상태가 다릅니다.' });
    }
});
export type FullGisData = z.infer<typeof FullGisDataSchema>;

export interface FullGisSourceQuery {
    address?: string;
    pnu?: string;
    coordinates?: { longitude: number; latitude: number };
    year: number;
    offset: number;
    limit: number;
    buildingHo?: string;
}

export interface FullGisClient {
    lookup(id: FullGisSourceId, query: FullGisSourceQuery, signal: AbortSignal): Promise<FullGisStep>;
}

export function emptyFullGisStep(
    id: FullGisSourceId,
    query: Pick<FullGisSourceQuery, 'offset' | 'limit'>,
    status: FullGisStep['status'],
    code?: string,
    now: () => number = Date.now,
): FullGisStep {
    return {
        id, ...FULL_GIS_SOURCE_META[id], asOf: new Date(now()).toISOString(),
        status, ...(code ? { code } : {}), records: [], warnings: [],
        pagination: { offset: query.offset, limit: query.limit, returned: 0,
            total: status === 'NO_DATA' ? 0 : null, hasMore: false, nextOffset: null },
    };
}
