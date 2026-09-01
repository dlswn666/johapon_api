import assert from 'node:assert/strict';
import test from 'node:test';

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
});

const serviceModule = import('../src/services/gis.service');
const PNU = '1168010100107360024';
const OTHER_PNU = '1168010100107360025';
const DATA_GEOMETRY = {
    type: 'Polygon' as const,
    coordinates: [[[127, 37], [128, 37], [127, 37]]],
};
const WFS_GEOMETRY = {
    type: 'MultiPolygon' as const,
    coordinates: [[[[127, 37], [128, 37], [127, 37]]]],
};

function dataResponse(pnu: string, geometry: unknown = DATA_GEOMETRY): unknown {
    return {
        response: {
            status: 'OK',
            result: {
                featureCollection: {
                    features: [{ properties: { pnu }, geometry }],
                },
            },
        },
    };
}

function wfsResponse(pnu: string, geometry: unknown = WFS_GEOMETRY): unknown {
    return {
        type: 'FeatureCollection',
        features: [{ properties: { pnu }, geometry }],
    };
}

test('경계 파서는 요청 PNU와 정확히 일치하는 geometry만 반환한다', async () => {
    const {
        parseVworldDataParcelBoundary,
        parseVworldWfsParcelBoundary,
    } = await serviceModule;

    assert.deepEqual(parseVworldDataParcelBoundary(dataResponse(PNU), PNU), DATA_GEOMETRY);
    assert.equal(parseVworldDataParcelBoundary(dataResponse(OTHER_PNU), PNU), null);
    assert.equal(parseVworldDataParcelBoundary({ response: { status: 'NOT_FOUND' } }, PNU), null);
    assert.equal(parseVworldDataParcelBoundary({ response: { status: 'ERROR' } }, PNU), null);
    assert.equal(
        parseVworldDataParcelBoundary({ response: { status: 'OK', result: {} } }, PNU),
        null
    );
    assert.deepEqual(parseVworldWfsParcelBoundary(wfsResponse(PNU), PNU), WFS_GEOMETRY);
    assert.equal(parseVworldWfsParcelBoundary(wfsResponse(OTHER_PNU), PNU), null);
    assert.equal(parseVworldWfsParcelBoundary({ features: [] }, PNU), null);
});

test('Data API에서 일치 경계를 찾으면 WFS를 호출하지 않는다', async () => {
    const { GisService } = await serviceModule;
    const calls: Array<{ url: string; params: Record<string, unknown> }> = [];
    const service = new GisService(async (url, config) => {
        calls.push({ url, params: config.params });
        return { data: dataResponse(PNU) };
    });

    const boundary = await service.getParcelBoundary(PNU);

    assert.deepEqual(boundary, DATA_GEOMETRY);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.vworld.kr/req/data');
    assert.deepEqual(
        {
            version: calls[0].params.version,
            crs: calls[0].params.crs,
            attribute: calls[0].params.attribute,
            page: calls[0].params.page,
        },
        { version: '2.0', crs: 'EPSG:4326', attribute: true, page: 1 }
    );
});

test('Data API PNU 불일치 시 공식 WFS로 폴백하고 exact 파라미터를 보낸다', async () => {
    const { GisService } = await serviceModule;
    const calls: Array<{ url: string; params: Record<string, unknown> }> = [];
    const service = new GisService(async (url, config) => {
        calls.push({ url, params: config.params });
        return {
            data: url.endsWith('/req/data')
                ? dataResponse(OTHER_PNU)
                : wfsResponse(PNU),
        };
    });

    const boundary = await service.getParcelBoundary(PNU);

    assert.deepEqual(boundary, WFS_GEOMETRY);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.url.startsWith('https://')));
    const wfsCall = calls[1];
    assert.equal(wfsCall.url, 'https://api.vworld.kr/ned/wfs/getCtnlgsSpceWFS');
    assert.deepEqual(wfsCall.params, {
        key: 'test-vworld-key',
        domain: 'test.example.com',
        typename: 'dt_d002',
        pnu: PNU,
        maxFeatures: 1,
        resultType: 'results',
        srsName: 'EPSG:4326',
        output: 'application/json',
    });
});

test('Data API 전송 오류도 공식 WFS 폴백을 막지 않는다', async () => {
    const { GisService } = await serviceModule;
    const calls: string[] = [];
    const service = new GisService(async (url) => {
        calls.push(url);
        if (url.endsWith('/req/data')) throw new Error('stub transport failure');
        return { data: wfsResponse(PNU) };
    });

    assert.deepEqual(await service.getParcelBoundary(PNU), WFS_GEOMETRY);
    assert.deepEqual(calls, [
        'https://api.vworld.kr/req/data',
        'https://api.vworld.kr/ned/wfs/getCtnlgsSpceWFS',
    ]);
});

test('Data API malformed geometry는 채택하지 않고 공식 WFS로 폴백한다', async () => {
    const { GisService } = await serviceModule;
    const calls: string[] = [];
    const service = new GisService(async (url) => {
        calls.push(url);
        return {
            data: url.endsWith('/req/data')
                ? dataResponse(PNU, { type: 'Point', coordinates: [127, 37] })
                : wfsResponse(PNU),
        };
    });

    assert.deepEqual(await service.getParcelBoundary(PNU), WFS_GEOMETRY);
    assert.deepEqual(calls, [
        'https://api.vworld.kr/req/data',
        'https://api.vworld.kr/ned/wfs/getCtnlgsSpceWFS',
    ]);
});

test('WFS malformed geometry는 경계로 채택하지 않는다', async () => {
    const { GisService } = await serviceModule;
    const malformedGeometries: unknown[] = [
        {},
        [],
        { type: 'Point', coordinates: [127, 37] },
        { type: 'Polygon' },
        { type: 'MultiPolygon', coordinates: null },
    ];

    for (const geometry of malformedGeometries) {
        const service = new GisService(async (url) => ({
            data: url.endsWith('/req/data')
                ? dataResponse(OTHER_PNU)
                : wfsResponse(PNU, geometry),
        }));
        assert.equal(await service.getParcelBoundary(PNU), null);
    }
});

test('두 VWorld 소스가 모두 다른 PNU를 반환하면 경계를 채택하지 않는다', async () => {
    const { GisService } = await serviceModule;
    const service = new GisService(async (url) => ({
        data: url.endsWith('/req/data')
            ? dataResponse(OTHER_PNU)
            : wfsResponse(OTHER_PNU),
    }));

    assert.equal(await service.getParcelBoundary(PNU), null);
});

test('19자리 숫자가 아닌 PNU는 외부 호출 없이 거부한다', async () => {
    const { GisService } = await serviceModule;
    let calls = 0;
    const service = new GisService(async () => {
        calls += 1;
        return { data: dataResponse(PNU) };
    });

    assert.equal(await service.getParcelBoundary('123'), null);
    assert.equal(await service.getParcelBoundary(`${PNU}0`), null);
    assert.equal(calls, 0);
});
