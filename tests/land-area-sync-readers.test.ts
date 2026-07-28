/**
 * LAND_AREA_SYNC read-model 후보 조회 — 오류/0건 구분 (DESIGN §2.2, I4).
 *
 * DB 조회 error 는 fatal 로 throw 하고(→ queue fatal catch → job FAILED), error 없는 진짜
 * 0건만 빈 배열로 반환한다. error 를 빈 결과로 삼키면 "조회 실패"가 "후보 0건"으로 오인돼
 * 잘못된 under-match(NO_CHANGE)로 silently 종결되는 것을 막는다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
    readPropertyUnitCandidates,
    readBuildingUnitCandidates,
    readCurrentLandTuples,
} from '../src/services/land-area-sync/readers';

const UNION = '00000000-0000-4000-a000-0000000000aa';
const PNU = '1168010100107360024';
const PUID = '11111111-1111-4111-8111-111111111111';

/** table 별 `{data,error}` 를 돌려주는 thenable 빌더(readers 는 await 로 소비). */
function readerClient(byTable: Record<string, { data: unknown; error: unknown }>): SupabaseClient {
    return {
        from(table: string) {
            const result = byTable[table] ?? { data: [], error: null };
            const b: Record<string, unknown> = {};
            b.select = () => b;
            b.eq = () => b;
            b.in = () => b;
            b.not = () => b;
            b.then = (resolve: (v: unknown) => void) => resolve(result);
            return b;
        },
    } as unknown as SupabaseClient;
}

interface RecordedFilter {
    table: string;
    method: 'select' | 'eq' | 'in' | 'not';
    args: unknown[];
}

function queuedReaderClient(
    byTable: Record<string, { data: unknown; error: unknown }[]>
): { client: SupabaseClient; filters: RecordedFilter[] } {
    const filters: RecordedFilter[] = [];
    const offsets = new Map<string, number>();
    return {
        filters,
        client: {
            from(table: string) {
                const offset = offsets.get(table) ?? 0;
                offsets.set(table, offset + 1);
                const result = byTable[table]?.[offset] ?? { data: [], error: null };
                const b: Record<string, unknown> = {};
                b.select = (...args: unknown[]) => {
                    filters.push({ table, method: 'select', args });
                    return b;
                };
                for (const method of ['eq', 'in', 'not'] as const) {
                    b[method] = (...args: unknown[]) => {
                        filters.push({ table, method, args });
                        return b;
                    };
                }
                b.then = (resolve: (v: unknown) => void) => resolve(result);
                return b;
            },
        } as unknown as SupabaseClient,
    };
}

const READ_FAILED = /조회 실패/;

// ── readPropertyUnitCandidates ─────────────────────────────────────

test('readPropertyUnitCandidates: DB error 는 throw(빈 결과 삼키지 않음)', async () => {
    const client = readerClient({ property_units: { data: null, error: { message: 'boom' } } });
    await assert.rejects(() => readPropertyUnitCandidates(client, UNION, [PNU]), READ_FAILED);
});

test('readPropertyUnitCandidates: error 없는 진짜 0건은 빈 배열', async () => {
    const client = readerClient({ property_units: { data: [], error: null } });
    assert.deepEqual(await readPropertyUnitCandidates(client, UNION, [PNU]), []);
});

test('readPropertyUnitCandidates: scopePnus 빈 배열이면 조회 없이 빈 배열', async () => {
    const client = readerClient({ property_units: { data: null, error: { message: 'should-not-run' } } });
    assert.deepEqual(await readPropertyUnitCandidates(client, UNION, []), []);
});

// ── readBuildingUnitCandidates(2단 조회) ───────────────────────────

test('readBuildingUnitCandidates: building_land_lots error 는 throw', async () => {
    const client = readerClient({ building_land_lots: { data: null, error: { message: 'boom' } } });
    await assert.rejects(() => readBuildingUnitCandidates(client, UNION, [PNU]), READ_FAILED);
});

test('readBuildingUnitCandidates: building_units error 는 throw(링크 조회는 성공)', async () => {
    const client = readerClient({
        building_land_lots: { data: [{ pnu: PNU, building_id: 'b1' }], error: null },
        building_units: { data: null, error: { message: 'boom' } },
    });
    await assert.rejects(() => readBuildingUnitCandidates(client, UNION, [PNU]), READ_FAILED);
});

test('readBuildingUnitCandidates: 링크 0건은 error 없이 빈 배열(building_units 미조회)', async () => {
    const client = readerClient({ building_land_lots: { data: [], error: null } });
    assert.deepEqual(await readBuildingUnitCandidates(client, UNION, [PNU]), []);
});

test('readBuildingUnitCandidates: property_units 링크 조회 error 도 fail-closed', async () => {
    const client = readerClient({
        building_land_lots: { data: [], error: null },
        property_units: { data: null, error: { message: 'boom' } },
    });
    await assert.rejects(() => readBuildingUnitCandidates(client, UNION, [PNU]), READ_FAILED);
});

test('readBuildingUnitCandidates: building_land_lots가 없어도 scoped active property 링크로 후보를 찾는다', async () => {
    const { client, filters } = queuedReaderClient({
        building_land_lots: [{ data: [], error: null }],
        property_units: [
            {
                data: [
                    {
                        union_id: UNION,
                        pnu: PNU,
                        is_deleted: false,
                        building_unit_id: 'bu1',
                    },
                    {
                        union_id: '00000000-0000-4000-a000-0000000000bb',
                        pnu: PNU,
                        is_deleted: false,
                        building_unit_id: 'foreign',
                    },
                    {
                        union_id: UNION,
                        pnu: PNU,
                        is_deleted: true,
                        building_unit_id: 'deleted',
                    },
                ],
                error: null,
            },
        ],
        building_units: [
            {
                data: [
                    {
                        id: 'bu1',
                        building_id: 'b1',
                        dong: '0000',
                        floor: '1',
                        ho: '101',
                        registry_external_id: 'registry-1',
                    },
                    {
                        id: 'foreign',
                        building_id: 'foreign-building',
                        ho: '999',
                    },
                ],
                error: null,
            },
            {
                data: [
                    {
                        id: 'bu1',
                        building_id: 'b1',
                        dong: '0000',
                        floor: '1',
                        ho: '101',
                        registry_external_id: 'registry-1',
                    },
                    {
                        id: 'bu2',
                        building_id: 'b1',
                        dong: '0000',
                        floor: '2',
                        ho: '201',
                        registry_external_id: 'registry-2',
                    },
                    {
                        id: 'other',
                        building_id: 'unreachable-building',
                        ho: '301',
                    },
                ],
                error: null,
            },
        ],
    });

    assert.deepEqual(await readBuildingUnitCandidates(client, UNION, [PNU]), [
        {
            id: 'bu1',
            buildingId: 'b1',
            dong: '0000',
            floor: '1',
            ho: '101',
            registryExternalId: 'registry-1',
        },
        {
            id: 'bu2',
            buildingId: 'b1',
            dong: '0000',
            floor: '2',
            ho: '201',
            registryExternalId: 'registry-2',
        },
    ]);
    assert.deepEqual(
        filters.filter(
            (filter) =>
                filter.table === 'property_units' &&
                filter.method !== 'select'
        ),
        [
            { table: 'property_units', method: 'eq', args: ['union_id', UNION] },
            { table: 'property_units', method: 'eq', args: ['is_deleted', false] },
            { table: 'property_units', method: 'in', args: ['pnu', [PNU]] },
            {
                table: 'property_units',
                method: 'not',
                args: ['building_unit_id', 'is', null],
            },
        ]
    );
    assert.deepEqual(
        filters.find(
            (filter) =>
                filter.table === 'property_units' &&
                filter.method === 'select'
        )?.args,
        ['union_id, pnu, is_deleted, building_unit_id']
    );
    assert.equal(
        filters.some(
            (filter) =>
                filter.table === 'building_units' &&
                filter.method === 'in' &&
                filter.args[0] === 'id' &&
                JSON.stringify(filter.args[1]) === JSON.stringify(['bu1'])
        ),
        true
    );
});

test('readBuildingUnitCandidates: 두 경로의 동일 unit은 정확히 한 번만 반환한다', async () => {
    const row = {
        id: 'bu1',
        building_id: 'b1',
        dong: '0000',
        floor: '1',
        ho: '101',
        registry_external_id: 'registry-1',
    };
    const { client } = queuedReaderClient({
        building_land_lots: [{ data: [{ pnu: PNU, building_id: 'b1' }], error: null }],
        property_units: [
            {
                data: [
                    {
                        union_id: UNION,
                        pnu: PNU,
                        is_deleted: false,
                        building_unit_id: 'bu1',
                    },
                ],
                error: null,
            },
        ],
        building_units: [
            { data: [row], error: null },
            { data: [row], error: null },
        ],
    });

    const candidates = await readBuildingUnitCandidates(client, UNION, [PNU, PNU]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.id, 'bu1');
});

test('readBuildingUnitCandidates: 두 read 사이 동일 id 내용이 바뀌면 fail-closed', async () => {
    const { client } = queuedReaderClient({
        building_land_lots: [{ data: [{ pnu: PNU, building_id: 'b1' }], error: null }],
        property_units: [
            {
                data: [
                    {
                        union_id: UNION,
                        pnu: PNU,
                        is_deleted: false,
                        building_unit_id: 'bu1',
                    },
                ],
                error: null,
            },
        ],
        building_units: [
            {
                data: [{ id: 'bu1', building_id: 'b1', floor: '1', ho: '101' }],
                error: null,
            },
            {
                data: [{ id: 'bu1', building_id: 'b1', floor: '2', ho: '201' }],
                error: null,
            },
        ],
    });

    await assert.rejects(() => readBuildingUnitCandidates(client, UNION, [PNU]), READ_FAILED);
});

// ── readCurrentLandTuples ──────────────────────────────────────────

test('readCurrentLandTuples: DB error 는 throw', async () => {
    const client = readerClient({ property_units: { data: null, error: { message: 'boom' } } });
    await assert.rejects(() => readCurrentLandTuples(client, UNION, [PUID]), READ_FAILED);
});

test('readCurrentLandTuples: error 없는 0건은 빈 배열', async () => {
    const client = readerClient({ property_units: { data: [], error: null } });
    assert.deepEqual(await readCurrentLandTuples(client, UNION, [PUID]), []);
});
