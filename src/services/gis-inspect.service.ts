import axios from 'axios';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import {
    InspectResponse,
    InspectStep,
    KakaoInspectAddress,
} from '../types/gis-inspect.types';
import { buildPnuFromKakaoAddress } from './gis-shared/pnu';
import { maskSecretParams } from './gis-shared/secret-mask';
import { GIS_SHARED_ENDPOINTS, BUILDING_HUB_BASE_URL } from './gis-shared/endpoints';

const logger = createLogger('GIS-INSPECT');

// gis-shared 공용 모듈로 이전됨 (DESIGN §10.6) — 기존 import 경로 호환을 위해 재노출한다.
export { buildPnuFromKakaoAddress, maskSecretParams };

const VWORLD_ADDRESS_URL = 'https://api.vworld.kr/req/address';
const VWORLD_DATA_URL = 'https://api.vworld.kr/req/data';
const VWORLD_NED_BASE = 'https://api.vworld.kr/ned/data';
const VWORLD_BOUNDARY_WFS_URL = 'https://api.vworld.kr/ned/wfs/getCtnlgsSpceWFS';
// 층별개요는 인스펙터 진단 전용이다. GIS_SHARED_ENDPOINTS 에 넣지 않는 이유는
// 그 키 집합(GisSharedEndpointName)이 land-area-sync 의 zero 라벨 계약
// (adapter.ts ZERO_LABEL / EndpointZeroLabel)에 전수로 물려 있어서, 증거 계약을
// 넓히지 않으려면 여기서 base URL 만 재사용하는 편이 맞다. HTTPS 는 그대로 보장된다.
const BLDRGST_FLOOR_OUTLINE_URL = `${BUILDING_HUB_BASE_URL}/getBrFlrOulnInfo`;

/**
 * 건축물대장 허브는 numOfRows 를 무시하고 **한 페이지에 100행**만 준다
 * (2026-09-03 실측: 미아동 1357 삼각산아이원 전유부 totalCount 1,344 → 100행,
 *  층별개요 449 → 100행). pageNo 를 올려가며 전 행을 모은다.
 */
const BLDRGST_SERVER_PAGE_SIZE = 100;
/** 폭주 방지 상한. 100행 × 40 = 4,000행이면 이 구역 최대(1,344)의 3배다. */
const BLDRGST_MAX_PAGES = 40;

const REQUEST_TIMEOUT_MS = 15000;

/** 응답 steps 배열의 고정 순서 */
const STEP_DEFS: Array<{ id: string; name: string; provider: 'VWORLD' | 'DATA_GO_KR' }> = [
    { id: 'geocode', name: '지오코딩 (주소→좌표)', provider: 'VWORLD' },
    { id: 'coord_to_pnu', name: '좌표→PNU (연속지적도 조회)', provider: 'VWORLD' },
    { id: 'reverse_geocode', name: '역지오코딩 (좌표→도로명주소)', provider: 'VWORLD' },
    { id: 'boundary_vworld', name: '필지 경계 — 브이월드 데이터 API (1차 소스)', provider: 'VWORLD' },
    { id: 'boundary_vworld_wfs', name: '필지 경계 — 브이월드 연속지적도 WFS (보조 소스)', provider: 'VWORLD' },
    { id: 'land_registry', name: '토지대장 (ladfrlList)', provider: 'VWORLD' },
    { id: 'land_price', name: '개별공시지가', provider: 'VWORLD' },
    { id: 'apart_price', name: '공동주택가격', provider: 'VWORLD' },
    { id: 'indiv_house_price', name: '개별주택가격', provider: 'VWORLD' },
    { id: 'building_title', name: '건축물대장 표제부', provider: 'DATA_GO_KR' },
    { id: 'building_units', name: '건축물대장 전유부', provider: 'DATA_GO_KR' },
    { id: 'building_floors', name: '건축물대장 층별개요', provider: 'DATA_GO_KR' },
    { id: 'land_share_registry', name: '대지권등록부 (ldaregList)', provider: 'VWORLD' },
    { id: 'building_ho_land_share', name: '집합건물 호별 대지권 (buldHoCoList)', provider: 'VWORLD' },
];

type HttpGet = (
    url: string,
    config: { params: Record<string, unknown>; timeout: number }
) => Promise<{ data: unknown }>;

export class GisInspectService {
    constructor(
        private readonly httpGet: HttpGet = (url, config) => axios.get(url, config)
    ) {}

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private get nedIntervalMs(): number {
        return Math.max(env.VWORLD_ATTR_REQUEST_INTERVAL_MS, 0);
    }

    private stepMeta(id: string) {
        const def = STEP_DEFS.find((d) => d.id === id);
        if (!def) throw new Error(`Unknown inspect step: ${id}`);
        return def;
    }

    /** 외부 API 1회 호출을 InspectStep으로 감싼다 — 실패해도 throw하지 않는다 */
    /**
     * VWorld는 호출량 제한(레이트리밋)에 걸리면 정상 요청에도 본문에
     * INCORRECT_KEY 에러를 돌려준다 (HTTP 200). 재시도·실패 표시 대상으로 판별한다.
     */
    private hasIncorrectKeyBody(data: unknown): boolean {
        if (!data || typeof data !== 'object') return false;
        try {
            return JSON.stringify(data).includes('INCORRECT_KEY');
        } catch {
            return false;
        }
    }

    private async callStep(
        id: string,
        endpoint: string,
        params: Record<string, unknown>
    ): Promise<InspectStep> {
        const meta = this.stepMeta(id);
        const startedAt = Date.now();
        // 레이트리밋 추정 상황에서 연사 증폭을 피하기 위해 재시도는 1회만, 충분히 쉬고 한다
        const maxBodyErrorAttempts = 2;
        const bodyErrorRetryDelayMs = 1500;
        let bodyErrorRetries = 0;

        try {
            let data: unknown;
            for (let attempt = 1; attempt <= maxBodyErrorAttempts; attempt++) {
                const response = await this.httpGet(endpoint, { params, timeout: REQUEST_TIMEOUT_MS });
                data = response.data;
                if (!this.hasIncorrectKeyBody(data)) break;
                if (attempt < maxBodyErrorAttempts) {
                    bodyErrorRetries += 1;
                    logger.warn(`inspect step ${id}: INCORRECT_KEY 응답(레이트리밋 추정) — ${bodyErrorRetryDelayMs}ms 후 재시도`);
                    await this.sleep(bodyErrorRetryDelayMs);
                }
            }

            const requestParams = {
                ...maskSecretParams(params),
                ...(bodyErrorRetries > 0 ? { bodyErrorRetries } : {}),
            };

            if (this.hasIncorrectKeyBody(data)) {
                return {
                    id, name: meta.name, provider: meta.provider, endpoint,
                    requestParams,
                    status: 'ERROR', durationMs: Date.now() - startedAt, rawJson: data,
                    error: 'VWorld 인증키 오류 응답 — 연속 호출 제한(레이트리밋)으로 추정됩니다. 1분 정도 후 다시 검색해 보세요.',
                };
            }

            return {
                id, name: meta.name, provider: meta.provider, endpoint,
                requestParams,
                status: 'SUCCESS', durationMs: Date.now() - startedAt, rawJson: data,
            };
        } catch (error) {
            const err = error as { message?: string; response?: { data?: unknown } };
            logger.warn(`inspect step ${id} failed: ${err?.message}`);
            return {
                id, name: meta.name, provider: meta.provider, endpoint,
                requestParams: maskSecretParams(params),
                status: 'ERROR', durationMs: Date.now() - startedAt,
                rawJson: err?.response?.data ?? null,
                error: err?.message || '알 수 없는 오류',
            };
        }
    }

    /** 경계 API의 HTTP 200 provider 오류 envelope를 성공으로 오판하지 않는다. */
    private hasBoundaryProviderErrorBody(data: unknown): boolean {
        if (typeof data === 'string') {
            return /<(?:\w+:)?(?:ExceptionReport|ServiceExceptionReport|ServiceException)\b/i.test(data);
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) return false;

        const record = data as Record<string, unknown>;
        const response = record.response as { status?: unknown } | undefined;
        if (String(response?.status ?? '').toUpperCase() === 'ERROR') return true;
        if (record.error !== undefined && record.error !== null && record.error !== '') return true;

        return Object.keys(record).some((key) =>
            /^(?:\w+:)?(?:ExceptionReport|ServiceExceptionReport|ServiceException)$/i.test(key)
        );
    }

    private async callBoundaryStep(
        id: 'boundary_vworld' | 'boundary_vworld_wfs',
        endpoint: string,
        params: Record<string, unknown>
    ): Promise<InspectStep> {
        const step = await this.callStep(id, endpoint, params);
        if (step.status !== 'SUCCESS' || !this.hasBoundaryProviderErrorBody(step.rawJson)) {
            return step;
        }

        return {
            ...step,
            status: 'ERROR',
            error: 'VWorld 경계 API가 오류 응답을 반환했습니다.',
        };
    }

    /** 건축물대장 응답에서 items.item 배열을 꺼낸다 (단건이면 배열로 감싼다) */
    private extractBldRgstItems(raw: unknown): unknown[] {
        const body = (raw as { response?: { body?: { items?: unknown } } })?.response?.body;
        const items = (body as { items?: unknown } | undefined)?.items;
        if (!items || typeof items !== 'object') return [];
        const item = (items as { item?: unknown }).item;
        if (item === undefined || item === null) return [];
        return Array.isArray(item) ? item : [item];
    }

    /** 건축물대장 응답의 totalCount (숫자가 아니면 null) */
    private extractBldRgstTotalCount(raw: unknown): number | null {
        const total = (raw as { response?: { body?: { totalCount?: unknown } } })?.response?.body?.totalCount;
        const n = Number(total);
        return Number.isInteger(n) && n >= 0 ? n : null;
    }

    /**
     * 건축물대장 스텝 — totalCount 를 다 채울 때까지 pageNo 를 올려가며 모은다.
     *
     * 한 페이지로 끝나는 건물은 페이지1 응답을 **그대로** 돌려준다(기존 동작 유지).
     * 두 페이지 이상일 때만 items.item 을 합친 envelope 로 바꾸고, 무엇을 했는지
     * requestParams 에 남긴다. 중간 페이지가 실패하면 부분 데이터를 성공으로
     * 보여주지 않는다 — ERROR 로 내리고 모은 행 수를 함께 알린다.
     */
    private async callBldRgstStep(
        id: string,
        endpoint: string,
        baseParams: Record<string, unknown>
    ): Promise<InspectStep> {
        const startedAt = Date.now();
        const first = await this.callStep(id, endpoint, { ...baseParams, pageNo: 1 });
        if (first.status !== 'SUCCESS') return first;

        const totalCount = this.extractBldRgstTotalCount(first.rawJson);
        const collected = this.extractBldRgstItems(first.rawJson);
        if (totalCount === null || collected.length >= totalCount) return first;

        const neededPages = Math.ceil(totalCount / BLDRGST_SERVER_PAGE_SIZE);
        const lastPage = Math.min(neededPages, BLDRGST_MAX_PAGES);
        let failedPage: { pageNo: number; error?: string } | null = null;

        for (let pageNo = 2; pageNo <= lastPage; pageNo++) {
            const page = await this.callStep(id, endpoint, { ...baseParams, pageNo });
            if (page.status !== 'SUCCESS') {
                failedPage = { pageNo, error: page.error };
                break;
            }
            const rows = this.extractBldRgstItems(page.rawJson);
            if (rows.length === 0) break;
            collected.push(...rows);
        }

        const truncatedByCap = neededPages > BLDRGST_MAX_PAGES;
        const merged = {
            ...(first.rawJson as Record<string, unknown>),
            response: {
                ...((first.rawJson as { response?: Record<string, unknown> })?.response ?? {}),
                body: {
                    ...((first.rawJson as { response?: { body?: Record<string, unknown> } })?.response?.body ?? {}),
                    items: { item: collected },
                    numOfRows: collected.length,
                    pageNo: 1,
                },
            },
        };

        const step: InspectStep = {
            ...first,
            durationMs: Date.now() - startedAt,
            rawJson: merged,
            requestParams: {
                ...first.requestParams,
                pageNo: `1~${lastPage} 병합`,
                serverPageSize: BLDRGST_SERVER_PAGE_SIZE,
                mergedRows: collected.length,
                totalCount,
            },
        };

        if (failedPage) {
            return {
                ...step,
                status: 'ERROR',
                error: `${failedPage.pageNo}페이지 조회 실패로 전체 ${totalCount}행 중 ${collected.length}행만 모았습니다.`
                    + (failedPage.error ? ` (${failedPage.error})` : ''),
            };
        }
        if (truncatedByCap) {
            return {
                ...step,
                status: 'ERROR',
                error: `전체 ${totalCount}행이 페이지 상한(${BLDRGST_MAX_PAGES}페이지)을 넘어 ${collected.length}행까지만 모았습니다.`,
            };
        }
        return step;
    }

    private skippedStep(id: string, endpoint: string, reason: string): InspectStep {
        const meta = this.stepMeta(id);
        return {
            id, name: meta.name, provider: meta.provider, endpoint,
            requestParams: {}, status: 'SKIPPED', durationMs: 0, rawJson: null, error: reason,
        };
    }

    /** VWorld NED 속성 API 공통 파라미터 */
    private nedParams(extra: Record<string, unknown>): Record<string, unknown> {
        return {
            ...extra,
            format: 'json',
            numOfRows: 1000,
            pageNo: 1,
            key: env.VWORLD_API_KEY,
            domain: env.VWORLD_API_DOMAIN,
        };
    }

    /** 공시가격 API — 연도 폴백(현재→-1→-2). 비어있지 않은 첫 응답을 채택 */
    private async callNedPriceStep(
        id: string,
        endpointPath: string,
        containerKey: string,
        pnu: string
    ): Promise<InspectStep> {
        const meta = this.stepMeta(id);
        const endpoint = `${VWORLD_NED_BASE}/${endpointPath}`;
        const currentYear = new Date().getFullYear();
        const years = [currentYear, currentYear - 1, currentYear - 2].map(String);
        const startedAt = Date.now();

        let lastStep: InspectStep | null = null;
        const triedYears: string[] = [];

        for (const year of years) {
            await this.sleep(this.nedIntervalMs);
            triedYears.push(year);
            const step = await this.callStep(id, endpoint, this.nedParams({ pnu, stdrYear: year }));
            lastStep = step;
            if (step.status === 'ERROR') break;
            const raw = step.rawJson as Record<string, { field?: unknown[] } | undefined> | null;
            const fieldCount = raw?.[containerKey]?.field?.length ?? 0;
            if (fieldCount > 0) break;
        }

        // 시도한 연도 목록을 요청 파라미터에 남긴다
        return {
            ...(lastStep ?? this.skippedStep(id, endpoint, '호출되지 않음')),
            name: meta.name,
            durationMs: Date.now() - startedAt,
            requestParams: { ...(lastStep?.requestParams ?? {}), triedYears },
        };
    }

    async inspect(address: KakaoInspectAddress): Promise<InspectResponse> {
        const t0 = Date.now();
        const byId = new Map<string, InspectStep>();

        // ── 1. 지오코딩: 지번(PARCEL) 우선, 실패 시 도로명(ROAD) 재시도 (기존 파이프라인과 동일)
        const geocodeBase = {
            service: 'address', request: 'getcoord', version: '2.0',
            key: env.VWORLD_API_KEY, format: 'json',
        };
        const parcelAddress = address.jibunAddress || address.roadAddress;
        let geocodeStep = await this.callStep('geocode', VWORLD_ADDRESS_URL, {
            ...geocodeBase, address: parcelAddress, type: 'PARCEL',
        });
        const isGeocodeOk = (s: InspectStep) =>
            s.status === 'SUCCESS' &&
            (s.rawJson as { response?: { status?: string } } | null)?.response?.status === 'OK';
        if (!isGeocodeOk(geocodeStep) && address.roadAddress) {
            const retry = await this.callStep('geocode', VWORLD_ADDRESS_URL, {
                ...geocodeBase, address: address.roadAddress, type: 'ROAD',
            });
            retry.requestParams = { ...retry.requestParams, triedTypes: ['PARCEL', 'ROAD'] };
            geocodeStep = retry;
        }
        byId.set('geocode', geocodeStep);

        const point = (geocodeStep.rawJson as {
            response?: { status?: string; result?: { point?: { x?: string; y?: string } } };
        } | null)?.response;
        const coord =
            point?.status === 'OK' && point.result?.point?.x && point.result?.point?.y
                ? { x: String(point.result.point.x), y: String(point.result.point.y) }
                : null;

        // ── 2·3. 좌표 의존 스텝
        if (coord) {
            byId.set('coord_to_pnu', await this.callStep('coord_to_pnu', VWORLD_DATA_URL, {
                service: 'data', request: 'GetFeature', data: 'LP_PA_CBND_BUBUN',
                key: env.VWORLD_API_KEY, format: 'json', domain: env.VWORLD_API_DOMAIN,
                geomFilter: `POINT(${coord.x} ${coord.y})`, geometry: true, size: 1,
            }));
            byId.set('reverse_geocode', await this.callStep('reverse_geocode', VWORLD_ADDRESS_URL, {
                service: 'address', request: 'getAddress', version: '2.0',
                point: `${coord.x},${coord.y}`, type: 'ROAD',
                key: env.VWORLD_API_KEY, format: 'json',
            }));
        } else {
            byId.set('coord_to_pnu', this.skippedStep('coord_to_pnu', VWORLD_DATA_URL, '지오코딩 좌표를 확보하지 못했습니다.'));
            byId.set('reverse_geocode', this.skippedStep('reverse_geocode', VWORLD_ADDRESS_URL, '지오코딩 좌표를 확보하지 못했습니다.'));
        }

        // ── PNU 확정: 로컬 생성 우선, 실패 시 좌표→PNU 응답에서 추출
        let pnu = buildPnuFromKakaoAddress(address);
        let pnuSource: InspectResponse['pnuSource'] = pnu ? 'LOCAL' : null;
        if (!pnu) {
            const coordPnu = (byId.get('coord_to_pnu')?.rawJson as {
                response?: { result?: { featureCollection?: { features?: Array<{ properties?: { pnu?: string } }> } } };
            } | null)?.response?.result?.featureCollection?.features?.[0]?.properties?.pnu;
            if (coordPnu && String(coordPnu).length === 19) {
                pnu = String(coordPnu);
                pnuSource = 'VWORLD_COORD';
            }
        }

        // ── 4~14. PNU 의존 스텝
        if (!pnu) {
            const reason = '주소에서 PNU를 확보하지 못했습니다.';
            byId.set('boundary_vworld', this.skippedStep('boundary_vworld', VWORLD_DATA_URL, reason));
            byId.set('boundary_vworld_wfs', this.skippedStep('boundary_vworld_wfs', VWORLD_BOUNDARY_WFS_URL, reason));
            byId.set('land_registry', this.skippedStep('land_registry', `${VWORLD_NED_BASE}/ladfrlList`, reason));
            byId.set('land_price', this.skippedStep('land_price', `${VWORLD_NED_BASE}/getIndvdLandPriceAttr`, reason));
            byId.set('apart_price', this.skippedStep('apart_price', `${VWORLD_NED_BASE}/getApartHousingPriceAttr`, reason));
            byId.set('indiv_house_price', this.skippedStep('indiv_house_price', `${VWORLD_NED_BASE}/getIndvdHousingPriceAttr`, reason));
            byId.set('building_title', this.skippedStep('building_title', GIS_SHARED_ENDPOINTS.getBrTitleInfo, reason));
            byId.set('building_units', this.skippedStep('building_units', GIS_SHARED_ENDPOINTS.getBrExposInfo, reason));
            byId.set('building_floors', this.skippedStep('building_floors', BLDRGST_FLOOR_OUTLINE_URL, reason));
            byId.set('land_share_registry', this.skippedStep('land_share_registry', `${VWORLD_NED_BASE}/ldaregList`, reason));
            byId.set('building_ho_land_share', this.skippedStep('building_ho_land_share', `${VWORLD_NED_BASE}/buldHoCoList`, reason));
        } else {
            const sigunguCd = pnu.substring(0, 5);
            const bjdongCd = pnu.substring(5, 10);
            const bun = pnu.substring(11, 15);
            const ji = pnu.substring(15, 19);
            // 건축물대장 공통 파라미터. land-area-sync 의 scanBuildingHub 와 동일하게
            // 맞춘다 — platGbCd·pageNo 를 빼면 전유부 응답이 numOfRows "1" 로 와서
            // 한 행만 돌아온다(2026-07-30 791-2155 실측: totalCount 5, item 1건).
            const bldRgstParams = {
                serviceKey: env.DATA_PORTAL_API_KEY,
                sigunguCd,
                bjdongCd,
                platGbCd: pnu.substring(10, 11) === '2' ? '1' : '0',
                bun,
                ji,
                numOfRows: 1000,
                pageNo: 1,
                _type: 'json',
            };

            // data.go.kr 건축물대장 3종은 병렬 (레이트리밋 없음).
            // 세 스텝 모두 페이지네이션한다 — 서버가 100행에서 자르기 때문에
            // 대단지는 표제부만 온전하고 전유부·층별개요가 조용히 잘려 있었다.
            const dataPortalPromise = Promise.all([
                this.callBldRgstStep(
                    'building_title',
                    GIS_SHARED_ENDPOINTS.getBrTitleInfo,
                    { ...bldRgstParams }
                ),
                this.callBldRgstStep(
                    'building_units',
                    GIS_SHARED_ENDPOINTS.getBrExposInfo,
                    { ...bldRgstParams }
                ),
                // 층별개요 — 표제부 totArea 만으로는 연면적을 검증할 수 없어 함께 받는다.
                // 옥탑 계단실·물탱크실·주차장처럼 연면적 산입에서 빠지는 층이 있고,
                // 그 표시가 areaExctYn 에 안 들어오는 경우가 많다(2026-09-03 미아동 실측:
                // 층 128개 중 areaExctYn 이 채워진 것은 23개뿐, 명백한 제외 6개 층이 공백).
                // 판단은 etcPurps 텍스트와 "층별 area 합 − 제외분 = totArea" 산식으로 한다.
                this.callBldRgstStep(
                    'building_floors',
                    BLDRGST_FLOOR_OUTLINE_URL,
                    { ...bldRgstParams }
                ),
            ]);

            // VWorld는 순차 (NED 호출 전 interval 준수)
            byId.set('boundary_vworld', await this.callBoundaryStep('boundary_vworld', VWORLD_DATA_URL, {
                service: 'data', request: 'GetFeature', version: '2.0', data: 'LP_PA_CBND_BUBUN',
                key: env.VWORLD_API_KEY, format: 'json', domain: env.VWORLD_API_DOMAIN,
                crs: 'EPSG:4326', attrFilter: `pnu:=:${pnu}`,
                geometry: true, attribute: true, size: 1, page: 1,
            }));
            byId.set('boundary_vworld_wfs', await this.callBoundaryStep('boundary_vworld_wfs', VWORLD_BOUNDARY_WFS_URL, {
                key: env.VWORLD_API_KEY, domain: env.VWORLD_API_DOMAIN,
                typename: 'dt_d002', pnu, maxFeatures: 1,
                resultType: 'results', srsName: 'EPSG:4326', output: 'application/json',
            }));

            await this.sleep(this.nedIntervalMs);
            byId.set('land_registry', await this.callStep('land_registry', `${VWORLD_NED_BASE}/ladfrlList`,
                this.nedParams({ pnu })));

            byId.set('land_price', await this.callNedPriceStep('land_price', 'getIndvdLandPriceAttr', 'indvdLandPrices', pnu));
            byId.set('apart_price', await this.callNedPriceStep('apart_price', 'getApartHousingPriceAttr', 'apartHousingPrices', pnu));
            byId.set('indiv_house_price', await this.callNedPriceStep('indiv_house_price', 'getIndvdHousingPriceAttr', 'indvdHousingPrices', pnu));

            await this.sleep(this.nedIntervalMs);
            byId.set('land_share_registry', await this.callStep('land_share_registry', `${VWORLD_NED_BASE}/ldaregList`,
                this.nedParams({ pnu })));

            await this.sleep(this.nedIntervalMs);
            byId.set('building_ho_land_share', await this.callStep('building_ho_land_share', `${VWORLD_NED_BASE}/buldHoCoList`,
                this.nedParams({ pnu })));

            const [titleStep, unitsStep, floorsStep] = await dataPortalPromise;
            byId.set('building_title', titleStep);
            byId.set('building_units', unitsStep);
            byId.set('building_floors', floorsStep);
        }

        return {
            address,
            pnu,
            pnuSource,
            steps: STEP_DEFS.map((d) => byId.get(d.id)!),
            totalDurationMs: Date.now() - t0,
        };
    }
}

export const gisInspectService = new GisInspectService();
