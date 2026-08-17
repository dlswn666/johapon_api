import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    LandRightLookupNed,
    LandRightLookupRepository,
} from '../src/services/land-right-lookup/transient';
import {
    createSupabaseLandRightLookupRepository,
    LandRightLookupError,
    MAX_LAND_RIGHT_SCOPE_PNUS,
    lookupLandRightTransient,
} from '../src/services/land-right-lookup/transient';
import type { NedFetchResult } from '../src/services/land-right-lookup/ned';

const UNION_ID = '11111111-1111-4111-8111-111111111111';
const PROPERTY_ID = '22222222-2222-4222-8222-222222222222';
const BASE_PNU = '1168010100107360024';
const ATTACHED_PNU = '1168010100107360025';
const SIBLING_PNU = '1168010100107360026';

function relationQueryClient(rows: Record<string, unknown>[]) {
    return {
        from(table: string) {
            assert.equal(table, 'building_registry_land_lot_relations');
            const equals = new Map<string, unknown>();
            const members = new Map<string, unknown[]>();
            let rowLimit = Number.POSITIVE_INFINITY;
            const builder: Record<string, unknown> &
                PromiseLike<{ data: unknown[]; error: null }> = {
                select: () => builder,
                eq: (column: string, value: unknown) => {
                    equals.set(column, value);
                    return builder;
                },
                in: (column: string, values: unknown[]) => {
                    members.set(column, values);
                    return builder;
                },
                limit: (value: number) => {
                    rowLimit = value;
                    return builder;
                },
                abortSignal: () => builder,
                then: (resolve, reject) => {
                    const data = rows
                        .filter((row) =>
                            [...equals].every(
                                ([column, value]) => row[column] === value
                            )
                        )
                        .filter((row) =>
                            [...members].every(([column, values]) =>
                                values.includes(row[column])
                            )
                        )
                        .slice(0, rowLimit);
                    return Promise.resolve({ data, error: null }).then(
                        resolve,
                        reject
                    );
                },
            };
            return builder;
        },
    };
}

const baseProperty = {
    id: PROPERTY_ID,
    union_id: UNION_ID,
    pnu: ATTACHED_PNU,
    property_address_jibun: '서울시 테스트 736-25',
    dong: '101동',
    ho: '201호',
    land_area: null,
    is_deleted: false,
};

function repository(
    overrides: Partial<LandRightLookupRepository> = {}
): LandRightLookupRepository {
    return {
        findPropertyUnit: async () => baseProperty,
        findDirectRelations: async () => [],
        findGroupRelations: async () => [],
        findLandLots: async (_unionId, pnus) =>
            pnus.map((pnu) => ({
                union_id: UNION_ID,
                pnu,
                address: `주소-${pnu.slice(-4)}`,
            })),
        ...overrides,
    };
}

function ned(
    resolve: (
        source: 'ldareg' | 'ladfrl',
        pnu: string
    ) => NedFetchResult
) {
    const calls: Array<{ source: 'ldareg' | 'ladfrl'; pnu: string }> = [];
    const value: LandRightLookupNed = {
        async fetchLdareg(pnu) {
            calls.push({ source: 'ldareg', pnu });
            return resolve('ldareg', pnu);
        },
        async fetchLadfrl(pnu) {
            calls.push({ source: 'ladfrl', pnu });
            return resolve('ladfrl', pnu);
        },
    };
    return { value, calls };
}

const success = (
    source: 'ldareg' | 'ladfrl',
    pnu: string
): NedFetchResult => ({
    status: 'SUCCESS',
    records:
        source === 'ldareg'
            ? [
                  {
                      pnu,
                      agbldgSn: '1',
                      buldDongNm: '101동',
                      buldFloorNm: '2',
                      buldHoNm: '201호',
                      ldaQotaRate: '10/100',
                      ownerName: '응답하면 안 되는 필드',
                  },
              ]
            : [
                  {
                      pnu,
                      lndpclAr: '100',
                      lndcgrCodeNm: '대',
                      ownerName: '응답하면 안 되는 필드',
                  },
              ],
});

test('group relation 조회는 (기준 PNU, 관리번호) exact pair를 교차곱 limit과 분리한다', async () => {
    const exactA = {
        union_id: UNION_ID,
        base_pnu: BASE_PNU,
        attached_pnu: ATTACHED_PNU,
        mgm_bldrgst_pk: 'root-a',
        projection_status: 'LINKED',
        is_active: true,
    };
    const exactB = {
        ...exactA,
        base_pnu: SIBLING_PNU,
        attached_pnu: '1168010100107360027',
        mgm_bldrgst_pk: 'root-b',
    };
    const crossProductRows = Array.from({ length: 101 }, (_, index) => ({
        ...exactA,
        attached_pnu: `116801010010737${String(index).padStart(4, '0')}`,
        mgm_bldrgst_pk: 'root-b',
    }));
    const client = relationQueryClient([
        ...crossProductRows,
        exactA,
        exactB,
    ]);
    const lookupRepository = createSupabaseLandRightLookupRepository(
        client as Parameters<typeof createSupabaseLandRightLookupRepository>[0]
    );

    const result = await lookupRepository.findGroupRelations(UNION_ID, [
        { basePnu: BASE_PNU, managementPk: 'root-a' },
        { basePnu: SIBLING_PNU, managementPk: 'root-b' },
    ]);

    assert.deepEqual(result, [exactA, exactB]);
});

test('attached 시작 PNU에서 같은 관리번호의 기준·형제 부속까지만 조회한다', async () => {
    const direct = {
        union_id: UNION_ID,
        base_pnu: BASE_PNU,
        attached_pnu: ATTACHED_PNU,
        mgm_bldrgst_pk: 'root-a',
        projection_status: 'LINKED',
        is_active: true,
    };
    const sibling = {
        ...direct,
        attached_pnu: SIBLING_PNU,
    };
    const unrelated = {
        ...direct,
        base_pnu: '1168010100107360090',
        attached_pnu: '1168010100107360091',
        mgm_bldrgst_pk: 'root-b',
    };
    const official = ned(success);
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository({
                findDirectRelations: async () => [direct],
                findGroupRelations: async () => [direct, sibling, unrelated],
            }),
            ned: official.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );

    assert.equal(result.status, 'SUCCESS');
    assert.deepEqual(
        result.parcels.map(({ pnu, role, scopeGroup }) => ({
            pnu,
            role,
            scopeGroup,
        })),
        [
            { pnu: BASE_PNU, role: 'BASE', scopeGroup: 'group-1' },
            {
                pnu: ATTACHED_PNU,
                role: 'ATTACHED',
                scopeGroup: 'group-1',
            },
            {
                pnu: SIBLING_PNU,
                role: 'ATTACHED',
                scopeGroup: 'group-1',
            },
        ]
    );
    assert.equal(official.calls.length, 6);
    assert.equal(result.sources.ldareg.scans.length, 3);
    assert.ok(result.ldareg.every((row) => !('ownerName' in row)));
    assert.ok(result.ladfrl.every((row) => !('ownerName' in row)));
    assert.doesNotMatch(JSON.stringify(result), /server-only/);
});

test('서로 다른 관리번호 group은 합치지 않고 INCOMPLETE로 표시한다', async () => {
    const relationA = {
        union_id: UNION_ID,
        base_pnu: BASE_PNU,
        attached_pnu: ATTACHED_PNU,
        mgm_bldrgst_pk: 'root-a',
        projection_status: 'LINKED',
        is_active: true,
    };
    const relationB = {
        ...relationA,
        base_pnu: SIBLING_PNU,
        mgm_bldrgst_pk: 'root-b',
    };
    const official = ned(success);
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository({
                findDirectRelations: async () => [relationA, relationB],
                findGroupRelations: async () => [relationA, relationB],
            }),
            ned: official.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );

    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.code, 'PROPERTY_SCOPE_INCOMPLETE');
    assert.ok(result.warnings.includes('MULTIPLE_MANAGEMENT_ROOTS'));
    assert.deepEqual(
        [...new Set(result.parcels.map((parcel) => parcel.scopeGroup))],
        ['group-1', 'group-2']
    );
});

test('active 기준·부속 relation이 0건이면 공식자료가 있어도 Codex-safe INCOMPLETE다', async () => {
    const official = ned(success);
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository(),
            ned: official.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );

    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.code, 'PROPERTY_SCOPE_INCOMPLETE');
    assert.ok(result.warnings.includes('NO_ACTIVE_BASE_ATTACHED_RELATION'));
    assert.equal(result.ldareg.length, 1);
    assert.equal(result.ladfrl.length, 1);
});

test('request-level cap이 발생하면 앞선 성공 rows도 반환하지 않는다', async () => {
    const capped: LandRightLookupNed = {
        async fetchLdareg(pnu) {
            return success('ldareg', pnu);
        },
        async fetchLadfrl(_pnu, _auth, options) {
            options?.budget?.terminate(
                'LOOKUP_RESPONSE_SIZE_LIMIT_EXCEEDED'
            );
            return {
                status: 'INCOMPLETE',
                records: [],
                code: 'LOOKUP_RESPONSE_SIZE_LIMIT_EXCEEDED',
            };
        },
    };
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository(),
            ned: capped,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );

    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.code, 'LOOKUP_RESPONSE_SIZE_LIMIT_EXCEEDED');
    assert.deepEqual(result.ldareg, []);
    assert.deepEqual(result.ladfrl, []);
    assert.deepEqual(result.sources.ldareg.scans, []);
});

test('overall deadline은 대기 중 repository 단계도 즉시 INCOMPLETE로 중단한다', async () => {
    const controller = new AbortController();
    const never = new Promise<null>(() => undefined);
    const lookup = lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository({
                findPropertyUnit: async () => never,
            }),
            ned: ned(success).value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
            signal: controller.signal,
        }
    );
    controller.abort('LOOKUP_DEADLINE_EXCEEDED');

    const result = await lookup;
    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.code, 'LOOKUP_DEADLINE_EXCEEDED');
    assert.equal(result.propertyUnit.id, PROPERTY_ID);
    assert.deepEqual(result.ldareg, []);
});

test('20 PNU를 넘는 relation scope는 provider 호출 없이 INCOMPLETE로 닫는다', async () => {
    const relations = Array.from(
        { length: MAX_LAND_RIGHT_SCOPE_PNUS },
        (_, index) => ({
            union_id: UNION_ID,
            base_pnu: BASE_PNU,
            attached_pnu: `116801010010736${String(index + 25).padStart(4, '0')}`,
            mgm_bldrgst_pk: 'root-large',
            projection_status: 'LINKED',
            is_active: true,
        })
    );
    const official = ned(success);
    let landLotReads = 0;
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository({
                findDirectRelations: async () => [relations[0]],
                findGroupRelations: async () => relations,
                findLandLots: async () => {
                    landLotReads += 1;
                    return [];
                },
            }),
            ned: official.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );

    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.code, 'PROPERTY_SCOPE_LIMIT_EXCEEDED');
    assert.equal(result.sources.ldareg.scans.length, 0);
    assert.equal(landLotReads, 0);
    assert.equal(official.calls.length, 0);
});

test('relation 조회 실패는 단일 PNU provider 조회로 fallback하지 않는다', async () => {
    const official = ned(success);
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository({
                findDirectRelations: async () => {
                    throw new Error('db unavailable');
                },
            }),
            ned: official.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );

    assert.equal(result.status, 'FAILED');
    assert.equal(result.code, 'PROPERTY_SCOPE_LOOKUP_FAILED');
    assert.equal(result.sources.ldareg.scans.length, 0);
    assert.equal(official.calls.length, 0);
});

test('NULL/invalid PNU는 4xx 대신 provider 미호출 terminal FAILED다', async () => {
    for (const [pnu, code] of [
        [null, 'PROPERTY_PNU_MISSING'],
        ['invalid-pnu', 'PROPERTY_PNU_INVALID'],
    ] as const) {
        const official = ned(success);
        const result = await lookupLandRightTransient(
            { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
            {
                repository: repository({
                    findPropertyUnit: async () => ({ ...baseProperty, pnu }),
                }),
                ned: official.value,
                auth: { key: 'server-only', domain: 'admin.example.com' },
            }
        );
        assert.equal(result.status, 'FAILED');
        assert.equal(result.code, code);
        assert.equal(result.propertyUnit.pnu, pnu);
        assert.equal(official.calls.length, 0);
    }
});

test('provider 한 축이 실패하면 FAILED지만 성공한 공식자료는 안전 투영해 보여준다', async () => {
    const official = ned((source, pnu) =>
        source === 'ldareg'
            ? { status: 'FAILED', records: [], code: 'TIMEOUT' }
            : success(source, pnu)
    );
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository(),
            ned: official.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );

    assert.equal(result.status, 'FAILED');
    assert.equal(result.sources.ldareg.status, 'FAILED');
    assert.equal(result.sources.ladfrl.status, 'SUCCESS');
    assert.equal(result.ldareg.length, 0);
    assert.equal(result.ladfrl.length, 1);
    assert.ok(result.warnings.includes('LDAREG_FAILED'));
});

test('정상 source가 하나라도 있으면 SUCCESS이고 둘 다 빈 경우만 NO_DATA다', async () => {
    const linkedRelation = {
        union_id: UNION_ID,
        base_pnu: BASE_PNU,
        attached_pnu: ATTACHED_PNU,
        mgm_bldrgst_pk: 'root-a',
        projection_status: 'LINKED',
        is_active: true,
    };
    const linkedRepository = repository({
        findDirectRelations: async () => [linkedRelation],
        findGroupRelations: async () => [linkedRelation],
    });
    const noData: NedFetchResult = { status: 'NO_DATA', records: [] };
    const partial = ned((source, pnu) =>
        source === 'ldareg' ? noData : success(source, pnu)
    );
    const partialResult = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: linkedRepository,
            ned: partial.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );
    assert.equal(partialResult.status, 'SUCCESS');
    assert.equal(partialResult.sources.ldareg.status, 'NO_DATA');
    assert.equal(partialResult.sources.ladfrl.status, 'SUCCESS');

    const empty = ned(() => noData);
    const emptyResult = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: linkedRepository,
            ned: empty.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );
    assert.equal(emptyResult.status, 'NO_DATA');
    assert.equal(emptyResult.ldareg.length, 0);
    assert.equal(emptyResult.ladfrl.length, 0);
});

test('cross-union/삭제 물건지와 기존 양수값은 provider 호출 전에 거부한다', async () => {
    const official = ned(success);
    await assert.rejects(
        () =>
            lookupLandRightTransient(
                { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
                {
                    repository: repository({
                        findPropertyUnit: async () => ({
                            ...baseProperty,
                            union_id:
                                '33333333-3333-4333-8333-333333333333',
                        }),
                    }),
                    ned: official.value,
                    auth: { key: 'server-only', domain: 'admin.example.com' },
                }
            ),
        (error: unknown) =>
            error instanceof LandRightLookupError && error.status === 404
    );

    await assert.rejects(
        () =>
            lookupLandRightTransient(
                { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
                {
                    repository: repository({
                        findPropertyUnit: async () => ({
                            ...baseProperty,
                            land_area: '10.0000',
                        }),
                    }),
                    ned: official.value,
                    auth: { key: 'server-only', domain: 'admin.example.com' },
                }
            ),
        (error: unknown) =>
            error instanceof LandRightLookupError && error.status === 409
    );
    assert.equal(official.calls.length, 0);
});
