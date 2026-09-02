import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicDataMcpProviderV1 } from '../src/services/public-data-mcp/provider';

const pnu = '1130510100107911982';
const signal = new AbortController().signal;

function provider(overrides: Record<string, unknown> = {}) {
    const gis = {
        async getPNUFromAddress() { return { pnu, x: '127.0', y: '37.5' }; },
        async getParcelBoundary() { return { type: 'Polygon', coordinates: [] } as GeoJSON.Geometry; },
        async getLandRegistryInfo() {
            return { sourcePnu: pnu, area: 10, ownerCount: 2, landCategory: '대' };
        },
        async getOfficialLandPriceRecord() {
            return {
                officialPrice: 123,
                sourcePnu: pnu,
                stdrYear: '2025',
                lastUpdtDt: '2026-01-15',
            };
        },
        async getBuildingDongs() { return []; },
        async getApartmentHousePrices() { return []; },
        async getIndividualHousingPrice() { return null; },
        ...overrides,
    };
    return createPublicDataMcpProviderV1({
        gis,
        landRight: {
            async fetchLdareg() { return { status: 'NO_DATA' as const, records: [] }; },
            async fetchLadfrl() { return { status: 'NO_DATA' as const, records: [] }; },
        },
        vworldAuth: { key: 'secret-canary', domain: 'www.tonghari.kr' },
        now: () => Date.parse('2026-09-03T00:00:00.000Z'),
    });
}

test('provider는 정규화 결과만 반환하고 ambiguous null을 NO_DATA로 확정하지 않는다', async () => {
    const result = await provider().execute(
        'lookup_housing_official_price_v1',
        { pnu, year: 2026, offset: 0, limit: 20 },
        { signal }
    );
    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.code, 'HOUSING_PRICE_INCOMPLETE');
    assert.equal(JSON.stringify(result).includes('secret-canary'), false);
    assert.equal(result.provider, 'VWorld');
    assert.ok(result.source);
    assert.ok(result.asOf);
    assert.ok(result.attribution);
});

test('개별공시지가는 실제 기준연도·원본 PNU·갱신일을 보존한다', async () => {
    const result = await provider().execute(
        'lookup_parcel_public_data_v1',
        { pnu },
        { signal }
    );
    assert.equal(result.status, 'SUCCESS');
    assert.deepEqual(result.data.officialLandPrice, {
        value: 123,
        unit: 'KRW_PER_SQUARE_METER',
        requestedYear: null,
        sourcePnu: pnu,
        stdrYear: '2025',
        lastUpdtDt: '2026-01-15',
    });
});

test('토지대장 PNU·면적·공유인원이 비정상이면 INCOMPLETE source로 닫는다', async () => {
    const result = await provider({
        async getLandRegistryInfo() {
            return {
                sourcePnu: '1130510100100000000',
                area: 0,
                ownerCount: -1,
                landCategory: '대',
            };
        },
    }).execute(
        'lookup_parcel_public_data_v1',
        { pnu },
        { signal }
    );
    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.data.landRegistry, null);
    assert.deepEqual(
        (result.data.sourceStatuses as Record<string, unknown>).landRegistry,
        { status: 'INCOMPLETE', code: 'PROVIDER_RESPONSE_INVALID' }
    );
});

test('건축물대장은 allowlist projection과 offset/limit만 반환한다', async () => {
    const result = await provider({
        async getBuildingDongs() {
            return [{
                registryPk: 'raw-registry-id',
                dongName: '101동',
                dongNameNormalized: '101',
                buildingType: 'APARTMENT' as const,
                housingType: 'APARTMENT' as const,
                buildingName: '테스트아파트',
                mainPurpose: '공동주택',
                floorCount: 10,
                isWelfareFacility: false,
                externalRefs: [{ metadata: { ownerName: 'owner-canary' } }],
                units: [
                    { dong: '101동', ho: '101호', floor: 1, area: 55 },
                    { dong: '101동', ho: '102호', floor: 1, area: 56 },
                ],
            }];
        },
    }).execute(
        'lookup_building_register_v1',
        { pnu, offset: 1, limit: 1 },
        { signal }
    );
    const text = JSON.stringify(result);
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.pagination?.returned, 1);
    assert.equal(text.includes('raw-registry-id'), false);
    assert.equal(text.includes('owner-canary'), false);
    assert.equal(text.includes('metadata'), false);
});

test('대지권은 projector allowlist만 노출하고 두 source NO_DATA를 확정한다', async () => {
    const result = await provider().execute(
        'lookup_land_right_registration_v1',
        { pnu, offset: 0, limit: 1 },
        { signal }
    );
    assert.equal(result.status, 'NO_DATA');
    assert.equal(result.code, 'NO_DATA');
    assert.equal(result.pagination?.returned, 0);
});
