import assert from 'node:assert/strict';
import test from 'node:test';

// gis-inspect.service는 env를 로드하므로 import 전에 필수 env 스텁
Object.assign(process.env, {
    JWT_SECRET: 'test-jwt-secret',
    ALIGO_API_KEY: 'test-aligo-key',
    ALIGO_USER_ID: 'test-aligo-user',
    ALIGO_SENDER_PHONE: '0212345678',
    DEFAULT_SENDER_KEY: 'test-sender-key',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    VWORLD_API_KEY: 'test-vworld-key',
    VWORLD_API_DOMAIN: 'test.example.com',
    DATA_PORTAL_API_KEY: 'test-data-portal-key',
    VWORLD_ATTR_REQUEST_INTERVAL_MS: '0',
});

const serviceModule = import('../src/services/gis-inspect.service');

test('buildPnuFromKakaoAddress: 정상 지번은 19자리 PNU를 만든다', async () => {
    const { buildPnuFromKakaoAddress } = await serviceModule;
    assert.equal(
        buildPnuFromKakaoAddress({
            roadAddress: '서울 강남구 테헤란로 1',
            jibunAddress: '서울 강남구 역삼동 736-24',
            bcode: '1168010100',
            mainNo: '736',
            subNo: '24',
            mountainYn: 'N',
        }),
        '1168010100107360024'
    );
});

test('buildPnuFromKakaoAddress: 산지는 대지구분 2, 부번 없으면 0000', async () => {
    const { buildPnuFromKakaoAddress } = await serviceModule;
    assert.equal(
        buildPnuFromKakaoAddress({
            roadAddress: '',
            jibunAddress: '경기 광명시 광명동 산 12',
            bcode: '4121010100',
            mainNo: '12',
            subNo: '',
            mountainYn: 'Y',
        }),
        '4121010100200120000'
    );
});

test('buildPnuFromKakaoAddress: bcode가 10자리 숫자가 아니면 null', async () => {
    const { buildPnuFromKakaoAddress } = await serviceModule;
    const base = { roadAddress: '', jibunAddress: '', mainNo: '1', subNo: '', mountainYn: 'N' as const };
    assert.equal(buildPnuFromKakaoAddress({ ...base, bcode: '' }), null);
    assert.equal(buildPnuFromKakaoAddress({ ...base, bcode: '12345' }), null);
    assert.equal(buildPnuFromKakaoAddress({ ...base, bcode: '12345abcde' }), null);
});

test('buildPnuFromKakaoAddress: 본번이 없거나 숫자가 아니면 null', async () => {
    const { buildPnuFromKakaoAddress } = await serviceModule;
    const base = { roadAddress: '', jibunAddress: '', bcode: '1168010100', subNo: '', mountainYn: 'N' as const };
    assert.equal(buildPnuFromKakaoAddress({ ...base, mainNo: '' }), null);
    assert.equal(buildPnuFromKakaoAddress({ ...base, mainNo: 'abc' }), null);
});

test('maskSecretParams: key/serviceKey만 마스킹하고 나머지는 유지', async () => {
    const { maskSecretParams } = await serviceModule;
    assert.deepEqual(
        maskSecretParams({ pnu: '123', key: 'secret', serviceKey: 'secret2', format: 'json' }),
        { pnu: '123', key: '***', serviceKey: '***', format: 'json' }
    );
});

/** URL·params로 스텁 응답을 돌려주는 가짜 httpGet */
function createStubHttpGet(overrides?: {
    failUrls?: string[];
    geocodeFail?: boolean;
    /** 건축물대장 허브 에뮬레이션 — numOfRows 를 무시하고 100행씩 준다 */
    bldRgst?: { totalCount: number; failPage?: number };
}) {
    const calls: Array<{ url: string; params: Record<string, unknown> }> = [];
    const httpGet = async (url: string, config: { params: Record<string, unknown> }) => {
        calls.push({ url, params: config.params });
        if (overrides?.failUrls?.some((f) => url.includes(f))) {
            throw new Error('stub network error');
        }
        if (url.includes('/req/address') && config.params.request === 'getcoord') {
            if (overrides?.geocodeFail) {
                return { data: { response: { status: 'NOT_FOUND' } } };
            }
            return {
                data: {
                    response: {
                        status: 'OK',
                        result: { crs: 'epsg:4326', point: { x: '127.036', y: '37.500' } },
                    },
                },
            };
        }
        if (url.includes('/req/address')) {
            // getAddress (역지오코딩)
            return { data: { response: { status: 'OK', result: [{ text: '서울 강남구 테헤란로 1' }] } } };
        }
        if (url.includes('/req/data')) {
            return {
                data: {
                    response: {
                        status: 'OK',
                        result: {
                            featureCollection: {
                                features: [{ properties: { pnu: '1168010100107360024' } }],
                            },
                        },
                    },
                },
            };
        }
        if (url.includes('getIndvdLandPriceAttr')) {
            return { data: { indvdLandPrices: { field: [{ pblntfPclnd: '1000000' }] } } };
        }
        if (url.includes('getApartHousingPriceAttr')) {
            // 첫 연도는 빈 응답 → 연도 폴백 검증
            const isFirstYear = String(config.params.stdrYear) === String(new Date().getFullYear());
            if (isFirstYear) return { data: { apartHousingPrices: { field: [] } } };
            return { data: { apartHousingPrices: { field: [{ pblntfPc: '500000000' }] } } };
        }
        if (url.includes('getIndvdHousingPriceAttr')) {
            return { data: { indvdHousingPrices: { field: [{ housePc: '300000000' }] } } };
        }
        if (overrides?.bldRgst && /getBr(TitleInfo|ExposInfo|FlrOulnInfo)/.test(url)) {
            const { totalCount, failPage } = overrides.bldRgst;
            const pageNo = Number(config.params.pageNo);
            if (failPage && pageNo === failPage) throw new Error('stub page error');
            // 서버는 numOfRows 를 무시하고 100행 고정으로 준다
            const start = (pageNo - 1) * 100;
            const rows = Math.max(0, Math.min(100, totalCount - start));
            return {
                data: {
                    response: {
                        header: { resultCode: '00', resultMsg: 'NORMAL SERVICE' },
                        body: {
                            items: { item: Array.from({ length: rows }, (_, i) => ({ rnum: start + i + 1 })) },
                            numOfRows: 100,
                            pageNo,
                            totalCount,
                        },
                    },
                },
            };
        }
        // 나머지 (경계·토지대장·건축물대장·대지권)
        return { data: { stub: url } };
    };
    return { httpGet, calls };
}

const VALID_ADDRESS = {
    roadAddress: '서울 강남구 테헤란로 1',
    jibunAddress: '서울 강남구 역삼동 736-24',
    bcode: '1168010100',
    mainNo: '736',
    subNo: '24',
    mountainYn: 'N' as const,
};

test('inspect: 14개 스텝을 정의 순서대로 반환하고 전부 SUCCESS', async () => {
    const { GisInspectService } = await serviceModule;
    const { httpGet } = createStubHttpGet();
    const result = await new GisInspectService(httpGet).inspect(VALID_ADDRESS);

    assert.equal(result.steps.length, 14);
    assert.deepEqual(
        result.steps.map((s) => s.id),
        [
            'geocode', 'coord_to_pnu', 'reverse_geocode',
            'boundary_vworld', 'boundary_vworld_wfs',
            'land_registry', 'land_price', 'apart_price', 'indiv_house_price',
            'building_title', 'building_units', 'building_floors',
            'land_share_registry', 'building_ho_land_share',
        ]
    );
    assert.ok(result.steps.every((s) => s.status === 'SUCCESS'));
    assert.equal(result.pnu, '1168010100107360024');
    assert.equal(result.pnuSource, 'LOCAL');
});

test('inspect: 두 VWorld 경계를 독립 호출하고 정확한 Data API·WFS 파라미터를 보낸다', async () => {
    const { GisInspectService } = await serviceModule;
    const { httpGet, calls } = createStubHttpGet();
    const result = await new GisInspectService(httpGet).inspect(VALID_ADDRESS);

    const dataCall = calls.find(
        (call) => call.url === 'https://api.vworld.kr/req/data'
            && call.params.attrFilter === 'pnu:=:1168010100107360024'
    );
    assert.ok(dataCall, 'VWorld Data API 경계 호출 없음');
    assert.equal(dataCall.params.service, 'data');
    assert.equal(dataCall.params.request, 'GetFeature');
    assert.equal(dataCall.params.version, '2.0');
    assert.equal(dataCall.params.data, 'LP_PA_CBND_BUBUN');
    assert.equal(dataCall.params.crs, 'EPSG:4326');
    assert.equal(dataCall.params.geometry, true);
    assert.equal(dataCall.params.attribute, true);
    assert.equal(dataCall.params.size, 1);
    assert.equal(dataCall.params.page, 1);

    const wfsCall = calls.find(
        (call) => call.url === 'https://api.vworld.kr/ned/wfs/getCtnlgsSpceWFS'
    );
    assert.ok(wfsCall, 'VWorld 공식 WFS 경계 호출 없음');
    assert.equal(wfsCall.params.typename, 'dt_d002');
    assert.equal(wfsCall.params.pnu, '1168010100107360024');
    assert.equal(wfsCall.params.maxFeatures, 1);
    assert.equal(wfsCall.params.resultType, 'results');
    assert.equal(wfsCall.params.srsName, 'EPSG:4326');
    assert.equal(wfsCall.params.output, 'application/json');

    assert.equal(
        result.steps.find((step) => step.id === 'boundary_vworld')?.name,
        '필지 경계 — 브이월드 데이터 API (1차 소스)'
    );
    assert.equal(
        result.steps.find((step) => step.id === 'boundary_vworld_wfs')?.name,
        '필지 경계 — 브이월드 연속지적도 WFS (보조 소스)'
    );
    assert.equal(
        calls.some((call) => call.url.includes(['Continuous', 'LandInfoService'].join(''))),
        false
    );
    assert.ok(calls.every((call) => call.url.startsWith('https://')));
});

test('inspect: Data API HTTP 200 ERROR는 해당 경계만 ERROR이고 WFS 비교는 계속한다', async () => {
    const { GisInspectService } = await serviceModule;
    const { httpGet: baseHttpGet, calls } = createStubHttpGet();
    const httpGet = async (
        url: string,
        config: { params: Record<string, unknown>; timeout: number }
    ) => {
        if (url.endsWith('/req/data') && config.params.attrFilter) {
            calls.push({ url, params: config.params });
            return {
                data: {
                    response: {
                        status: 'ERROR',
                        error: { code: 'INVALID_REQUEST' },
                    },
                },
            };
        }
        return baseHttpGet(url, config);
    };

    const result = await new GisInspectService(httpGet).inspect(VALID_ADDRESS);

    assert.equal(result.steps.find((step) => step.id === 'boundary_vworld')?.status, 'ERROR');
    assert.equal(result.steps.find((step) => step.id === 'boundary_vworld_wfs')?.status, 'SUCCESS');
    assert.equal(
        calls.filter((call) => call.url.endsWith('/ned/wfs/getCtnlgsSpceWFS')).length,
        1
    );
});

test('inspect: WFS HTTP 200 exception body는 해당 경계만 ERROR로 판정한다', async () => {
    const { GisInspectService } = await serviceModule;
    const { httpGet: baseHttpGet } = createStubHttpGet();
    const httpGet = async (
        url: string,
        config: { params: Record<string, unknown>; timeout: number }
    ) => {
        if (url.endsWith('/ned/wfs/getCtnlgsSpceWFS')) {
            return {
                data: '<ows:ExceptionReport><ows:Exception /></ows:ExceptionReport>',
            };
        }
        return baseHttpGet(url, config);
    };

    const result = await new GisInspectService(httpGet).inspect(VALID_ADDRESS);

    assert.equal(result.steps.find((step) => step.id === 'boundary_vworld')?.status, 'SUCCESS');
    assert.equal(result.steps.find((step) => step.id === 'boundary_vworld_wfs')?.status, 'ERROR');
});

test('inspect: 요청 파라미터의 key/serviceKey는 마스킹된다', async () => {
    const { GisInspectService } = await serviceModule;
    const { httpGet } = createStubHttpGet();
    const result = await new GisInspectService(httpGet).inspect(VALID_ADDRESS);

    for (const step of result.steps) {
        const params = step.requestParams;
        if ('key' in params) assert.equal(params.key, '***');
        if ('serviceKey' in params) assert.equal(params.serviceKey, '***');
    }
});

test('inspect: 건축물대장 스텝은 land-area-sync 어댑터와 같은 파라미터로 전 행을 요청한다', async () => {
    // 2026-07-30 실측: 인스펙터 전유부 응답이 numOfRows "1" / totalCount "5" 로
    // 와서 7행 중 1행만 보였다. 실제로 동작하는 scanBuildingHub 는 platGbCd 와
    // pageNo 를 함께 보낸다(adapter.ts:365-372, :541). 같은 파라미터를 보낸다.
    const { GisInspectService } = await serviceModule;
    const { httpGet, calls } = createStubHttpGet();
    await new GisInspectService(httpGet).inspect(VALID_ADDRESS);

    for (const endpoint of ['getBrTitleInfo', 'getBrExposInfo', 'getBrFlrOulnInfo']) {
        const call = calls.find((c) => c.url.includes(endpoint));
        assert.ok(call, `${endpoint} 호출 없음`);
        assert.match(call.url, /^https:\/\/apis\.data\.go\.kr\//);
        // PNU 1168010100107360024 → 대지구분 '1' → platGbCd '0'
        assert.equal(call.params.platGbCd, '0', endpoint);
        assert.equal(call.params.pageNo, 1, endpoint);
        assert.equal(call.params.numOfRows, 1000, endpoint);
        assert.equal(call.params.sigunguCd, '11680', endpoint);
        assert.equal(call.params.bjdongCd, '10100', endpoint);
        assert.equal(call.params.bun, '0736', endpoint);
        assert.equal(call.params.ji, '0024', endpoint);
    }
});

test('inspect: 특정 API 실패는 해당 스텝만 ERROR, 나머지는 SUCCESS', async () => {
    const { GisInspectService } = await serviceModule;
    const { httpGet } = createStubHttpGet({ failUrls: ['ladfrlList'] });
    const result = await new GisInspectService(httpGet).inspect(VALID_ADDRESS);

    const landRegistry = result.steps.find((s) => s.id === 'land_registry');
    assert.equal(landRegistry?.status, 'ERROR');
    assert.match(landRegistry?.error ?? '', /stub network error/);
    assert.ok(result.steps.filter((s) => s.status === 'SUCCESS').length >= 11);
});

test('inspect: PNU 확보 실패 시 PNU 의존 스텝은 SKIPPED', async () => {
    const { GisInspectService } = await serviceModule;
    // bcode 불량(로컬 생성 실패) + 지오코딩/좌표 조회 실패 → PNU 없음
    const { httpGet } = createStubHttpGet({ geocodeFail: true });
    const result = await new GisInspectService(httpGet).inspect({
        ...VALID_ADDRESS,
        bcode: '',
    });

    assert.equal(result.pnu, null);
    assert.equal(result.pnuSource, null);
    const skipped = result.steps.filter((s) => s.status === 'SKIPPED').map((s) => s.id);
    for (const id of [
        'boundary_vworld', 'boundary_vworld_wfs', 'land_registry', 'land_price',
        'apart_price', 'indiv_house_price', 'building_title', 'building_units',
        'building_floors', 'land_share_registry', 'building_ho_land_share',
    ]) {
        assert.ok(skipped.includes(id), `${id} should be SKIPPED`);
    }
});

test('inspect: 좌표 없으면 좌표 의존 스텝(coord_to_pnu·reverse_geocode)도 SKIPPED', async () => {
    const { GisInspectService } = await serviceModule;
    const { httpGet } = createStubHttpGet({ geocodeFail: true });
    const result = await new GisInspectService(httpGet).inspect(VALID_ADDRESS);

    assert.equal(result.steps.find((s) => s.id === 'coord_to_pnu')?.status, 'SKIPPED');
    assert.equal(result.steps.find((s) => s.id === 'reverse_geocode')?.status, 'SKIPPED');
    // 로컬 PNU는 살아있으므로 PNU 의존 스텝은 정상 진행
    assert.equal(result.pnuSource, 'LOCAL');
    assert.equal(result.steps.find((s) => s.id === 'land_registry')?.status, 'SUCCESS');
});

test('inspect: 본문 INCORRECT_KEY는 1회 재시도 후 성공하면 SUCCESS로 기록한다', async () => {
    const { GisInspectService } = await serviceModule;
    const { httpGet: baseHttpGet } = createStubHttpGet();
    let ladfrlCalls = 0;
    const httpGet = async (url: string, config: { params: Record<string, unknown>; timeout: number }) => {
        if (url.includes('ladfrlList')) {
            ladfrlCalls += 1;
            if (ladfrlCalls === 1) {
                return {
                    data: { ladfrlVOList: { error: 'INCORRECT_KEY', message: '인증키 정보가 올바르지 않습니다.' } },
                };
            }
        }
        return baseHttpGet(url, config);
    };

    const result = await new GisInspectService(httpGet).inspect(VALID_ADDRESS);
    const step = result.steps.find((s) => s.id === 'land_registry');

    assert.equal(step?.status, 'SUCCESS');
    assert.equal(step?.requestParams.bodyErrorRetries, 1);
    assert.equal(ladfrlCalls, 2);
});

test('inspect: INCORRECT_KEY가 재시도 후에도 지속되면 ERROR로 표시한다', async () => {
    const { GisInspectService } = await serviceModule;
    const { httpGet: baseHttpGet } = createStubHttpGet();
    let ladfrlCalls = 0;
    const flakeBody = { ladfrlVOList: { error: 'INCORRECT_KEY', message: '인증키 정보가 올바르지 않습니다.' } };
    const httpGet = async (url: string, config: { params: Record<string, unknown>; timeout: number }) => {
        if (url.includes('ladfrlList')) {
            ladfrlCalls += 1;
            return { data: flakeBody };
        }
        return baseHttpGet(url, config);
    };

    const result = await new GisInspectService(httpGet).inspect(VALID_ADDRESS);
    const step = result.steps.find((s) => s.id === 'land_registry');

    assert.equal(step?.status, 'ERROR');
    assert.match(step?.error ?? '', /레이트리밋/);
    assert.deepEqual(step?.rawJson, flakeBody);
    assert.equal(ladfrlCalls, 2);
});

test('inspect: 공동주택가격은 빈 연도를 건너뛰고 이전 연도로 폴백한다', async () => {
    const { GisInspectService } = await serviceModule;
    const { httpGet, calls } = createStubHttpGet();
    const result = await new GisInspectService(httpGet).inspect(VALID_ADDRESS);

    const apart = result.steps.find((s) => s.id === 'apart_price');
    assert.equal(apart?.status, 'SUCCESS');
    // 채택된 응답은 비어있지 않은 연도의 것
    const raw = apart?.rawJson as { apartHousingPrices?: { field?: unknown[] } };
    assert.equal(raw?.apartHousingPrices?.field?.length, 1);
    // 두 연도 이상 호출됨
    const apartCalls = calls.filter((c) => c.url.includes('getApartHousingPriceAttr'));
    assert.ok(apartCalls.length >= 2);
});


// ── 건축물대장 페이지네이션 ────────────────────────────────────────
// 2026-09-03 실측: 허브는 numOfRows 를 무시하고 100행씩만 준다.
// 미아동 1357 삼각산아이원 전유부 totalCount 1,344 → 100행, 층별개요 449 → 100행.

function bldRgstStep(steps: Array<{ id: string }>, id: string) {
    return steps.find((s) => s.id === id) as unknown as {
        id: string; status: string; error?: string;
        requestParams: Record<string, unknown>; rawJson: unknown;
    };
}
function rowCount(raw: unknown): number {
    const item = (raw as { response?: { body?: { items?: { item?: unknown } } } })?.response?.body?.items?.item;
    return Array.isArray(item) ? item.length : 0;
}

test('inspect: 건축물대장 100행 초과는 pageNo 를 올려가며 전 행을 모은다', async () => {
    const { GisInspectService } = await serviceModule;
    const { httpGet, calls } = createStubHttpGet({ bldRgst: { totalCount: 1344 } });
    const result = await new GisInspectService(httpGet).inspect(VALID_ADDRESS);

    for (const id of ['building_title', 'building_units', 'building_floors']) {
        const step = bldRgstStep(result.steps, id);
        assert.equal(step.status, 'SUCCESS', id);
        assert.equal(rowCount(step.rawJson), 1344, `${id} 병합 행 수`);
        assert.equal(step.requestParams.mergedRows, 1344, `${id} mergedRows`);
        assert.equal(step.requestParams.totalCount, 1344, `${id} totalCount`);
        assert.equal(step.requestParams.pageNo, '1~14 병합', `${id} pageNo 표기`);
    }
    // 1,344행 = 14페이지 × 3스텝
    const exposCalls = calls.filter((c) => c.url.includes('getBrExposInfo'));
    assert.equal(exposCalls.length, 14);
    assert.deepEqual(exposCalls.map((c) => c.params.pageNo), Array.from({ length: 14 }, (_, i) => i + 1));
});

test('inspect: 한 페이지로 끝나면 응답을 그대로 두고 병합 표시를 붙이지 않는다', async () => {
    const { GisInspectService } = await serviceModule;
    const { httpGet, calls } = createStubHttpGet({ bldRgst: { totalCount: 13 } });
    const result = await new GisInspectService(httpGet).inspect(VALID_ADDRESS);

    const step = bldRgstStep(result.steps, 'building_floors');
    assert.equal(step.status, 'SUCCESS');
    assert.equal(rowCount(step.rawJson), 13);
    assert.equal(step.requestParams.pageNo, 1, '단일 페이지는 pageNo 가 숫자 1 그대로');
    assert.equal(step.requestParams.mergedRows, undefined);
    assert.equal(calls.filter((c) => c.url.includes('getBrFlrOulnInfo')).length, 1);
});

test('inspect: 정확히 100행이면 추가 페이지를 부르지 않는다', async () => {
    const { GisInspectService } = await serviceModule;
    const { httpGet, calls } = createStubHttpGet({ bldRgst: { totalCount: 100 } });
    const result = await new GisInspectService(httpGet).inspect(VALID_ADDRESS);

    assert.equal(bldRgstStep(result.steps, 'building_units').status, 'SUCCESS');
    assert.equal(calls.filter((c) => c.url.includes('getBrExposInfo')).length, 1);
});

test('inspect: 중간 페이지가 실패하면 부분 데이터를 성공으로 보여주지 않는다', async () => {
    const { GisInspectService } = await serviceModule;
    const { httpGet } = createStubHttpGet({ bldRgst: { totalCount: 449, failPage: 3 } });
    const result = await new GisInspectService(httpGet).inspect(VALID_ADDRESS);

    const step = bldRgstStep(result.steps, 'building_floors');
    assert.equal(step.status, 'ERROR');
    assert.match(step.error ?? '', /3페이지 조회 실패/);
    assert.match(step.error ?? '', /449행 중 200행/);
    // 실패해도 그때까지 모은 행은 그대로 보여준다
    assert.equal(rowCount(step.rawJson), 200);
});

test('inspect: 페이지 상한을 넘으면 ERROR 로 알리고 상한까지만 모은다', async () => {
    const { GisInspectService } = await serviceModule;
    const { httpGet, calls } = createStubHttpGet({ bldRgst: { totalCount: 100000 } });
    const result = await new GisInspectService(httpGet).inspect(VALID_ADDRESS);

    const step = bldRgstStep(result.steps, 'building_units');
    assert.equal(step.status, 'ERROR');
    assert.match(step.error ?? '', /페이지 상한\(40페이지\)/);
    assert.equal(rowCount(step.rawJson), 4000);
    assert.equal(calls.filter((c) => c.url.includes('getBrExposInfo')).length, 40);
});
