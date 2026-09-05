import assert from 'node:assert/strict';
import test from 'node:test';
import { LookupFullGisPublicDataInputV1Schema } from '../src/services/public-data-mcp/full-lookup-contract';

test('전체 조회는 주소/PNU 중 하나와 자료별 bounded offset만 허용한다', () => {
    const schema = LookupFullGisPublicDataInputV1Schema;
    assert.equal(schema.safeParse({}).success, false);
    assert.equal(schema.safeParse({ address: ' ' }).success, false);
    assert.equal(schema.safeParse({ pnu: '1130510100907490004' }).success, false);
    assert.equal(schema.safeParse({ pnu: '1130510100107490004', limit: 21 }).success, false);
    assert.equal(schema.safeParse({ pnu: '1130510100107490004', endpoint: 'https://attacker.test' }).success, false);
    assert.equal(schema.safeParse({ address: '서울특별시 중구 태평로1가 31', offsets: { unknown: 10 } }).success, false);
    assert.equal(schema.safeParse({ address: '서울특별시 중구 태평로1가 31', offsets: { building_floors: -1 } }).success, false);
    const parsed = schema.parse({ pnu: '1130510100107490004', offsets: { building_floors: 100, building_units: 20 } });
    assert.equal(parsed.limit, 10);
    assert.equal(parsed.offset, 0);
    assert.deepEqual(parsed.offsets, { building_floors: 100, building_units: 20 });
});
