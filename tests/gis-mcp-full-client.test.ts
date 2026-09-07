import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createFullGisClient, type FullGisHttpRequest, type FullGisHttpResponse,
} from '../src/services/public-data-mcp/full-lookup-client';
import { FULL_GIS_SOURCE_IDS, FULL_GIS_SOURCE_META, FullGisStepSchema, type FullGisSourceId,
    type FullGisSourceQuery } from '../src/services/public-data-mcp/full-lookup-contract';

const pnu = '1130510100107490004';
const signal = new AbortController().signal;
const query: FullGisSourceQuery = { address: '서울특별시 강북구 미아동 749-4', pnu,
    coordinates: { longitude: 127, latitude: 37.5 }, year: 2026, offset: 0, limit: 10 };
const geometry = { type: 'Polygon', coordinates: [[[127, 37.5], [127.001, 37.5],
    [127.001, 37.501], [127, 37.5]]], ownerName: 'owner-canary' };
const featureCollection = { type: 'FeatureCollection', features: [{ type: 'Feature',
    properties: { pnu, ownerName: 'owner-canary' }, geometry }] };
const registryRow = (i = 1) => ({ mgmBldrgstPk: `registry-${i}`, sigunguCd: '11305',
    bjdongCd: '10100', platGbCd: '0', bun: '0749', ji: '0004', dongNm: '101동',
    hoNm: `${i}호`, flrNo: '1', totArea: '120.40', archArea: '60.20', platArea: '70.5',
    area: `${i}.50`, areaExctYn: '', etcPurps: '옥탑 계단실', ownerName: 'owner-canary' });
function buildingPage(items = [registryRow()], totalCount = items.length, pageNo = 1, numOfRows = 100) {
    return { response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE' },
        body: { totalCount, pageNo, numOfRows, items: { item: items } } } };
}
function nedPage(container: string, items: Record<string, unknown>[], totalCount = items.length,
    pageNo = 1, numOfRows = 100, field = container) {
    return { [container]: { [field]: items, totalCount, pageNo, numOfRows, error: '', message: '' } };
}
function fixture(id: FullGisSourceId): unknown {
    if (id === 'geocode') return { response: { status: 'OK', result: { point: { x: '127', y: '37.5' } } } };
    if (id === 'reverse_geocode') return { response: { status: 'OK', result: [{ type: 'road', text: '서울특별시 강북구 테스트로 1', zipcode: '01000', ownerName: 'owner-canary' }] } };
    if (id === 'coord_to_pnu' || id === 'boundary_vworld') return { response: { status: 'OK', result: { featureCollection } } };
    if (id === 'boundary_vworld_wfs') return featureCollection;
    if (id === 'building_title' || id === 'building_units' || id === 'building_floors') return buildingPage();
    if (id === 'land_registry') return nedPage('ladfrlVOList', [{ pnu, lndpclAr: '150.4', cnrsPsnCo: '5', ownerName: 'owner-canary' }]);
    if (id === 'land_share_registry' || id === 'building_ho_land_share') return nedPage('ldaregVOList', [{ pnu, agbldgSn: '1', buldHoNm: '101', ldaQotaRate: '20.3/150.4', lastUpdtDt: '20260901', ownerName: 'owner-canary' }]);
    const [container, price] = id === 'land_price' ? ['indvdLandPrices', 'pblntfPclnd']
        : id === 'apart_price' ? ['apartHousingPrices', 'pblntfPc'] : ['indvdHousingPrices', 'housePc'];
    return nedPage(container, [{ pnu, stdrYear: '2026', stdrMt: '01', [price]: '1230000',
        lastUpdtDt: '20260901', ownerName: 'owner-canary' }], 1, 1, 100, 'field');
}
function client(response: (request: FullGisHttpRequest) => Promise<FullGisHttpResponse> | FullGisHttpResponse) {
    return createFullGisClient({ httpGet: async (request) => response(request), vworldKey: 'vworld-secret-canary',
        vworldDomain: 'www.tonghari.kr', dataPortalKey: 'portal%2Bsecret%3D', intervalMs: 0,
        now: () => Date.parse('2026-09-06T00:00:00Z') });
}

test('14개 source가 정본 endpoint와 안전 투영으로 연결된다', async () => {
    for (const id of FULL_GIS_SOURCE_IDS) {
        const requests: FullGisHttpRequest[] = [];
        const result = await client((request) => { requests.push(request); return { status: 200, data: fixture(id) }; })
            .lookup(id, query, signal);
        assert.equal(result.status, 'SUCCESS', `${id}: ${result.code}`);
        assert.equal(result.records.length, 1, id);
        assert.equal(FullGisStepSchema.safeParse(result).success, true, id);
        assert.equal(requests[0].url, FULL_GIS_SOURCE_META[id].source);
        assert.equal(requests[0].signal, signal);
        assert.equal(requests[0].maxRedirects, 0);
        assert.equal(requests[0].maxContentLength, 512 * 1024);
        assert.equal(requests[0].timeout, 10_000);
        assert.equal(JSON.stringify(result).includes('canary'), false, id);
        if (id === 'building_title') assert.equal(requests[0].params.serviceKey, 'portal+secret=');
    }
});

test('표제·전유·층별 면적과 빈 제외표시, 분수를 원래 의미대로 보존한다', async () => {
    const title = await client(() => ({ status: 200, data: fixture('building_title') })).lookup('building_title', query, signal);
    assert.equal(title.records[0].totArea, '120.40');
    assert.equal(title.records[0].archArea, '60.20');
    assert.equal(title.records[0].platArea, '70.5');
    assert.equal(title.records[0].area, undefined);
    const floor = await client(() => ({ status: 200, data: fixture('building_floors') })).lookup('building_floors', query, signal);
    assert.equal(floor.records[0].area, '1.50');
    assert.equal(floor.records[0].areaExctYn, '');
    assert.equal(floor.records[0].etcPurps, '옥탑 계단실');
    assert.equal(floor.records[0].totArea, undefined);
    const rights = await client(() => ({ status: 200, data: fixture('building_ho_land_share') })).lookup('building_ho_land_share', query, signal);
    assert.equal(rights.records[0].ldaQotaRate, '20.3/150.4');
    assert.equal(rights.records[0].lastUpdtDt, '20260901');
});

test('건물호수조회는 실제 ldaregVOList envelope와 선택적 buldHoNm을 사용한다', async () => {
    let requested: FullGisHttpRequest | undefined;
    const result = await client((request) => { requested = request; return { status: 200, data: fixture('building_ho_land_share') }; })
        .lookup('building_ho_land_share', { ...query, buildingHo: '101' }, signal);
    assert.equal(result.status, 'SUCCESS');
    assert.equal(requested!.params.buldHoNm, '101');
    assert.ok(result.warnings.includes('SEPARATE_PROVIDER_PERMISSION_APPLIES'));
});

test('주소 PARCEL 무자료 뒤 ROAD를 조회하고 좌표만 반환한다', async () => {
    const types: unknown[] = [];
    const result = await client((request) => {
        types.push(request.params.type);
        return { status: 200, data: request.params.type === 'PARCEL' ? { response: { status: 'NOT_FOUND' } } : fixture('geocode') };
    }).lookup('geocode', query, signal);
    assert.deepEqual(types, ['PARCEL', 'ROAD']);
    assert.deepEqual(result.records, [{ longitude: 127, latitude: 37.5, crs: 'EPSG:4326' }]);
});

test('100행으로 잘리는 건축HUB에서 경계 window와 target page만 조회한다', async () => {
    const pages: number[] = [];
    const result = await client((request) => {
        const page = Number(request.params.pageNo); pages.push(page);
        return { status: 200, data: buildingPage(Array.from({ length: page === 3 ? 50 : 100 },
            (_, index) => registryRow((page - 1) * 100 + index + 1)), 250, page, 1000) };
    }).lookup('building_units', { ...query, offset: 95, limit: 10 }, signal);
    assert.equal(result.status, 'SUCCESS');
    assert.deepEqual(pages, [1, 2]);
    assert.equal(result.records[0].hoNm, '96호');
    assert.equal(result.records[9].hoNm, '105호');
    assert.deepEqual(result.pagination, { offset: 95, limit: 10, returned: 10, total: 250, hasMore: true, nextOffset: 105 });
    pages.length = 0;
    const tail = await client((request) => {
        const page = Number(request.params.pageNo); pages.push(page);
        return { status: 200, data: buildingPage(Array.from({ length: page === 3 ? 50 : 100 },
            (_, index) => registryRow((page - 1) * 100 + index + 1)), 250, page, 1000) };
    }).lookup('building_units', { ...query, offset: 245 }, signal);
    assert.deepEqual(pages, [1, 3]);
    assert.equal(tail.records.length, 5);
    assert.equal(tail.pagination.hasMore, false);
});

test('NED가 더 작은 page size를 명시하면 실제 크기로 다음 window를 조회한다', async () => {
    const pages: number[] = [];
    const result = await client((request) => {
        const page = Number(request.params.pageNo); pages.push(page);
        return { status: 200, data: nedPage('ldaregVOList', Array.from({ length: 20 }, (_, i) => ({
            pnu, agbldgSn: String((page - 1) * 20 + i), buldHoNm: String((page - 1) * 20 + i),
        })), 60, page, 20) };
    }).lookup('land_share_registry', { ...query, offset: 18, limit: 5 }, signal);
    assert.equal(result.status, 'SUCCESS');
    assert.deepEqual(pages, [1, 2]);
    assert.deepEqual(result.records.map((row) => row.buldHoNm), ['18', '19', '20', '21', '22']);
});

test('개별주택가격 여러 행을 첫 행으로 축소하지 않고 기준연도·월·갱신일을 보존한다', async () => {
    const result = await client(() => ({ status: 200, data: nedPage('indvdHousingPrices', [
        { pnu, stdrYear: '2026', stdrMt: '01', housePc: '100', lastUpdtDt: '20260101' },
        { pnu, stdrYear: '2026', stdrMt: '06', housePc: '200', lastUpdtDt: '20260601' },
    ], 2, 1, 100, 'field') })).lookup('indiv_house_price', query, signal);
    assert.equal(result.status, 'SUCCESS');
    assert.deepEqual(result.records.map((row) => row.housePc), ['100', '200']);
    assert.equal(result.records[1].stdrMt, '06');
    assert.equal(result.records[1].lastUpdtDt, '20260601');
});

test('실제 건축HUB 숫자 PK와 공동주택가격의 중복 원본행을 보존한다', async () => {
    const registry = await client(() => ({ status: 200, data: buildingPage([{ ...registryRow(), mgmBldrgstPk: 12345678901234 }]) }))
        .lookup('building_title', query, signal);
    assert.equal(registry.status, 'SUCCESS');
    assert.equal(registry.records[0].mgmBldrgstPk, 12345678901234);
    const duplicate = { pnu, stdrYear: '2026', stdrMt: '01', pblntfPc: '100000', floorNm: '1층', hoNm: '101' };
    const price = await client(() => ({ status: 200, data: nedPage('apartHousingPrices', [duplicate, duplicate], 2, 1, 100, 'field') }))
        .lookup('apart_price', query, signal);
    assert.equal(price.status, 'SUCCESS');
    assert.equal(price.records.length, 2);
    assert.equal(price.records[0].floorNm, '1층');
    assert.equal(price.pagination.total, 2);
    assert.ok(price.warnings.includes('DUPLICATE_SOURCE_ROWS'));
});

test('명시적인 0건만 NO_DATA이고 실패·불완전 envelope는 구분한다', async () => {
    const good = await client(() => ({ status: 200, data: nedPage('ldaregVOList', []) })).lookup('land_share_registry', query, signal);
    assert.equal(good.status, 'NO_DATA');
    assert.equal(good.pagination.total, 0);
    for (const data of [{}, { ldaregVOList: { ldaregVOList: [] } },
        { ldaregVOList: { totalCount: 5, ldaregVOList: [] } },
        { response: { status: 'ERROR', error: { text: 'secret-canary' } } }]) {
        const result = await client(() => ({ status: 200, data })).lookup('land_share_registry', query, signal);
        assert.equal(result.status, 'INCOMPLETE');
        assert.equal(JSON.stringify(result).includes('secret-canary'), false);
    }
    const failed = await client(() => ({ status: 200, data: { ldaregVOList: {
        totalCount: 0, ldaregVOList: [], error: 'provider-secret-canary', message: 'raw-secret-canary',
    } } })).lookup('land_share_registry', query, signal);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.code, 'PROVIDER_ERROR');
    assert.equal(JSON.stringify(failed).includes('canary'), false);
});

test('개별주택가격의 확인된 response 0건 대체 envelope만 NO_DATA로 인정한다', async () => {
    const empty = { pageNo: '1', resultCode: '', totalCount: '0', numOfRows: '100', resultMsg: '' };
    const valid = await client(() => ({ status: 200, data: { response: empty } })).lookup('indiv_house_price', query, signal);
    assert.equal(valid.status, 'NO_DATA');
    for (const malformed of [
        { ...empty, totalCount: '1' }, { ...empty, pageNo: '2' }, { ...empty, numOfRows: '0' },
        { ...empty, resultCode: '12' }, { ...empty, resultMsg: 'secret-canary' },
        { ...empty, error: 'secret-canary' }, { ...empty, field: [{ housePc: 10 }] },
    ]) {
        const result = await client(() => ({ status: 200, data: { response: malformed } })).lookup('indiv_house_price', query, signal);
        assert.equal(result.status, 'INCOMPLETE');
        assert.equal(JSON.stringify(result).includes('canary'), false);
    }
});

test('페이지 total 변경·중간빈페이지·반복행은 완전한 자료로 반환하지 않는다', async () => {
    for (const failure of ['total', 'empty', 'repeated']) {
        const result = await client((request) => {
            const page = Number(request.params.pageNo);
            const items = page === 2 && failure === 'empty' ? [] : Array.from({ length: 100 }, (_, i) =>
                registryRow(page === 2 && failure !== 'repeated' ? 101 + i : 1 + i));
            return { status: 200, data: buildingPage(items, page === 2 && failure === 'total' ? 201 : 200, page) };
        }).lookup('building_units', { ...query, offset: 100 }, signal);
        assert.equal(result.status, 'INCOMPLETE', failure);
        assert.equal(result.records.length, 0);
    }
});

test('요청 PNU·건축HUB 대지구분·가격 기준연도 불일치는 닫는다', async () => {
    const wrongPnu = await client(() => ({ status: 200, data: nedPage('ldaregVOList', [{ pnu: '1130510100107490005' }]) }))
        .lookup('land_share_registry', query, signal);
    assert.equal(wrongPnu.code, 'ROW_PNU_MISMATCH');
    const wrongLand = await client(() => ({ status: 200, data: buildingPage([{ ...registryRow(), platGbCd: '1' }]) }))
        .lookup('building_title', query, signal);
    assert.equal(wrongLand.code, 'ROW_PNU_MISMATCH');
    const wrongYear = await client(() => ({ status: 200, data: nedPage('indvdHousingPrices', [{ pnu, stdrYear: '2025', housePc: 1 }], 1, 1, 100, 'field') }))
        .lookup('indiv_house_price', query, signal);
    assert.equal(wrongYear.code, 'ROW_YEAR_MISMATCH');
});

test('경계 geometry는 안전 좌표만 유지하고 다른 필지·무한 좌표를 거부한다', async () => {
    const valid = await client(() => ({ status: 200, data: featureCollection })).lookup('boundary_vworld_wfs', query, signal);
    assert.equal(valid.status, 'SUCCESS');
    assert.equal(JSON.stringify(valid).includes('ownerName'), false);
    const mismatch = await client(() => ({ status: 200, data: { ...featureCollection,
        features: [{ properties: { pnu: '1130510100107490005' }, geometry }] } })).lookup('boundary_vworld_wfs', query, signal);
    assert.equal(mismatch.code, 'ROW_PNU_MISMATCH');
    const invalid = await client(() => ({ status: 200, data: { ...featureCollection,
        features: [{ properties: { pnu }, geometry: { type: 'Polygon', coordinates: [[[Infinity, 1]]] } }] } }))
        .lookup('boundary_vworld_wfs', query, signal);
    assert.equal(invalid.code, 'GEOMETRY_INVALID');
});

test('provider 예외/redirect/과대 응답에서 비밀이나 원문을 반환하지 않는다', async () => {
    const cases = [
        () => { throw new Error('serviceKey=secret-canary'); },
        () => ({ status: 302, data: 'https://outside.example/secret-canary' }),
        () => ({ status: 200, data: 'secret-canary'.repeat(100_000) }),
    ];
    for (const handler of cases) {
        const result = await client(handler).lookup('land_registry', query, signal);
        assert.notEqual(result.status, 'SUCCESS');
        assert.equal(JSON.stringify(result).includes('canary'), false);
    }
});

test('허용 필드의 잘못된 중첩값이나 잘리는 긴 문자열을 성공으로 숨기지 않는다', async () => {
    for (const buldNm of [{ ownerName: 'secret-canary' }, 'x'.repeat(301)]) {
        const result = await client(() => ({ status: 200, data: nedPage('ldaregVOList', [{ pnu, buldNm }]) }))
            .lookup('land_share_registry', query, signal);
        assert.equal(result.status, 'INCOMPLETE');
        assert.equal(result.code, 'ROWS_INVALID');
        assert.equal(JSON.stringify(result).includes('secret-canary'), false);
    }
});

test('전역 VWorld gate는 취소 후에도 끝나지 않은 socket을 다음 호출이 추월하지 못한다', async () => {
    let release!: (value: FullGisHttpResponse) => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    const slow = client(() => {
        calls++; started();
        return new Promise<FullGisHttpResponse>((resolve) => { release = resolve; });
    });
    const controller = new AbortController();
    const first = slow.lookup('land_registry', query, controller.signal);
    await startedPromise;
    controller.abort();
    assert.equal((await first).code, 'REQUEST_ABORTED');
    const next = client(() => { calls++; return { status: 200, data: fixture('land_registry') }; })
        .lookup('land_registry', query, signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    release({ status: 200, data: fixture('land_registry') });
    assert.equal((await next).status, 'SUCCESS');
    assert.equal(calls, 2);
});
