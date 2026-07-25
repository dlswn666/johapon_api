import assert from 'node:assert/strict';
import test from 'node:test';
import {
    assembleLdaregApply,
    selectCanonicalExposSourcePnu,
    validateLdaregReplication,
    type LdaregBranchInput,
} from '../src/services/land-area-sync/ldareg-branch';
import type {
    BuildingUnitCandidate,
    PropertyUnitCandidate,
} from '../src/services/land-area-sync/matcher';

const ANCHOR = '1168010100107360024';
const PROP_ID = '11111111-1111-4111-8111-111111111111';
const PK = '1002003004005';

const property: PropertyUnitCandidate = {
    id: PROP_ID,
    unionId: 'union-1',
    buildingUnitId: null,
    pnu: ANCHOR,
    isDeleted: false,
    dong: null,
    ho: '301',
};

function assemble(
    input: Omit<
        LdaregBranchInput,
        'scopeLadfrlAreas' | 'scopeLadfrlTotal' | 'canonicalSourcePnu'
    > & {
        scopeLadfrlAreas?: LdaregBranchInput['scopeLadfrlAreas'];
        scopeLadfrlTotal?: string;
        canonicalSourcePnu?: string;
    }
) {
    const scopeLadfrlTotal = input.scopeLadfrlTotal ?? '15622.1';
    return assembleLdaregApply({
        ...input,
        canonicalSourcePnu: input.canonicalSourcePnu ?? input.scannedPnus[0],
        scopeLadfrlTotal,
        scopeLadfrlAreas:
            input.scopeLadfrlAreas ??
            [{ pnu: input.scannedPnus[0], area: scopeLadfrlTotal }],
    });
}

function assembleDongFallbackScope(input: {
    exposDongs: [string, string];
    ldaregDongs?: [string, string];
    buildingNames: [string, string];
    agbldgSns: [string, string];
}) {
    const units = [
        {
            floor: '1',
            ho: '101',
            numerator: '8',
            propertyId: PROP_ID,
        },
        {
            floor: '2',
            ho: '201',
            numerator: '9',
            propertyId: '22222222-2222-4222-8222-222222222222',
        },
    ] as const;
    return assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: units.map((unit, index) => ({
                    pnu: ANCHOR,
                    agbldgSn: input.agbldgSns[index],
                    buldNm: input.buildingNames[index],
                    buldDongNm: input.ldaregDongs?.[index] ?? '',
                    buldFloorNm: unit.floor,
                    buldHoNm: unit.ho,
                    buldRoomNm: unit.ho,
                    ldaQotaRate: `${unit.numerator}/100`,
                    clsSeCode: '0',
                })),
                exposRows: units.map((unit, index) => ({
                    mgmBldrgstPk: PK,
                    dongNm: input.exposDongs[index],
                    flrNoNm: unit.floor,
                    hoNm: unit.ho,
                })),
            },
        ],
        buildingUnits: [],
        propertyUnits: units.map((unit) => ({
            id: unit.propertyId,
            unionId: 'union-1',
            buildingUnitId: null,
            pnu: ANCHOR,
            isDeleted: false,
            dong: null,
            ho: unit.ho,
        })),
        scopeLadfrlAreas: [{ pnu: ANCHOR, area: '100' }],
        scopeLadfrlTotal: '100',
    });
}

test('LDAREG 매칭 happy path: 문자열 numeratorText/denominatorText 로 component 를 조립한다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    {
                        pnu: ANCHOR,
                        agbldgSn: '1',
                        buldNm: '가나빌',
                        buldFloorNm: '3층',
                        buldHoNm: '301',
                        ldaQotaRate: '181.7/15622.1',
                        clsSeCode: '0',
                        clsSeCodeNm: '유효',
                    },
                ],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
    });

    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.propertyUnitId, PROP_ID);
    assert.deepEqual(item.expectedTargetPnus, [ANCHOR]);
    assert.equal(item.components.length, 1);
    const c = item.components[0];
    assert.equal(c.sourceState, 'CURRENT');
    assert.equal(c.targetPnu, ANCHOR);
    // ratio.ts 의 문자열 텍스트를 그대로 소비한다(JS float 금지).
    assert.equal(c.ratioNumerator, '181.7');
    assert.equal(c.ratioDenominator, '15622.1');
    assert.equal(c.ratioRaw, '181.7/15622.1');
    assert.equal(c.matchMethod, 'PNU_DONG_HO');
    assert.equal(c.matchedBuildingUnitId, null);
    assert.equal(result.counts.parsedRows, 1);
    assert.deepEqual(result.matchedPropertyUnitIds, [PROP_ID]);
});

test('미아7 실응답형: 0000 동 sentinel·숫자 층·ratio 없는 0000 placeholder를 분리해 7개 유효 호를 막지 않는다', () => {
    const liveUnits = [
        {
            ho: '201',
            floor: 2,
            numerator: '17.6099',
            propertyId: '11111111-1111-4111-8111-111111111201',
            buildingUnitId:
                '22222222-2222-4222-8222-222222222201',
        },
        {
            ho: '202',
            floor: 2,
            numerator: '25.7503',
            propertyId: '11111111-1111-4111-8111-111111111202',
            buildingUnitId:
                '22222222-2222-4222-8222-222222222202',
        },
        {
            ho: '301',
            floor: 3,
            numerator: '17.6099',
            propertyId: '11111111-1111-4111-8111-111111111301',
            buildingUnitId:
                '22222222-2222-4222-8222-222222222301',
        },
        {
            ho: '302',
            floor: 3,
            numerator: '25.7503',
            propertyId: '11111111-1111-4111-8111-111111111302',
            buildingUnitId:
                '22222222-2222-4222-8222-222222222302',
        },
        {
            ho: '401',
            floor: 4,
            numerator: '17.6099',
            propertyId: '11111111-1111-4111-8111-111111111401',
            buildingUnitId:
                '22222222-2222-4222-8222-222222222401',
        },
        {
            ho: '402',
            floor: 4,
            numerator: '25.7503',
            propertyId: '11111111-1111-4111-8111-111111111402',
            buildingUnitId:
                '22222222-2222-4222-8222-222222222402',
        },
        {
            ho: '501',
            floor: 5,
            numerator: '40.9194',
            propertyId: '11111111-1111-4111-8111-111111111501',
            buildingUnitId:
                '22222222-2222-4222-8222-222222222501',
        },
    ];
    const buildingUnits: BuildingUnitCandidate[] = liveUnits.map(
        (unit) => ({
            id: unit.buildingUnitId,
            buildingId: '33333333-3333-4333-8333-333333333333',
            dong: null,
            floor: null,
            ho: unit.ho,
            registryExternalId: null,
        })
    );
    const propertyUnits: PropertyUnitCandidate[] = liveUnits.map(
        (unit) => ({
            id: unit.propertyId,
            unionId: 'union-1',
            buildingUnitId: unit.buildingUnitId,
            pnu: ANCHOR,
            isDeleted: false,
            dong: null,
            ho: unit.ho,
        })
    );
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    ...liveUnits.map((unit) => ({
                        pnu: ANCHOR,
                        agbldgSn: '1',
                        buldNm: '가나빌',
                        buldDongNm: '0000',
                        buldFloorNm: String(unit.floor),
                        buldHoNm: unit.ho,
                        buldRoomNm: unit.ho,
                        ldaQotaRate: `${unit.numerator}/171`,
                        clsSeCode: '0',
                        clsSeCodeNm: '현재',
                    })),
                    {
                        pnu: ANCHOR,
                        agbldgSn: '1',
                        buldNm: '가나빌',
                        buldDongNm: '0000',
                        buldFloorNm: '0000',
                        buldHoNm: '0000',
                        buldRoomNm: '0000',
                        ldaQotaRate: '',
                        clsSeCode: '0',
                        clsSeCodeNm: '현재',
                    },
                ],
                exposRows: liveUnits.map((unit) => ({
                    mgmBldrgstPk: PK,
                    dongNm: ' ',
                    flrNo: unit.floor,
                    hoNm: unit.ho,
                })),
            },
        ],
        buildingUnits,
        propertyUnits,
        scopeLadfrlTotal: '171',
    });

    assert.equal(result.blocking, false);
    assert.equal(result.items.length, 7);
    assert.equal(result.counts.landRegistryRows, 8);
    assert.equal(result.counts.parsedRows, 7);
    assert.deepEqual(
        result.items.map((item) => item.propertyUnitId).sort(),
        liveUnits.map((unit) => unit.propertyId).sort()
    );
    assert.ok(
        result.items.every(
            (item) =>
                item.components[0].matchMethod === 'BUILDING_UNIT_ID'
        )
    );
    assert.equal(
        result.issues.filter(
            (issue) => issue.code === 'RATIO_PARSE_FAILED'
        ).length,
        1
    );
});

test('미아7 791-2280/2281 실응답형: base EXPOS 4+attached zero와 basis child root로 linked 물건 4호를 매칭한다', () => {
    const basePnu = '1130510100107912280';
    const attachedPnu = '1130510100107912281';
    const exposChildPk = '2003004005006';
    const buildingId = '33333333-3333-4333-8333-333333333333';
    const units = [
        {
            floor: '4',
            ho: '401',
            numerator: '33.88',
            propertyId: '11111111-1111-4111-8111-111111111401',
            buildingUnitId:
                '22222222-2222-4222-8222-222222222401',
        },
        {
            floor: '3',
            ho: '301',
            numerator: '51.02',
            propertyId: '11111111-1111-4111-8111-111111111301',
            buildingUnitId:
                '22222222-2222-4222-8222-222222222301',
        },
        {
            floor: '2',
            ho: '201',
            numerator: '51.02',
            propertyId: '11111111-1111-4111-8111-111111111201',
            buildingUnitId:
                '22222222-2222-4222-8222-222222222201',
        },
        {
            floor: '1',
            ho: '101',
            numerator: '39.08',
            propertyId: '11111111-1111-4111-8111-111111111101',
            buildingUnitId:
                '22222222-2222-4222-8222-222222222101',
        },
    ];
    const ldaregRows = (pnu: string) => [
        ...units.map((unit) => ({
            pnu,
            // 실응답 계열의 동일 집합건물 일련번호. unit identity는 floor/ho로 분리된다.
            agbldgSn: '1',
            buldNm: '미아동 공동주택',
            buldDongNm: '0000',
            buldFloorNm: unit.floor,
            buldHoNm: unit.ho,
            buldRoomNm: unit.ho,
            ldaQotaRate: `${unit.numerator}/175`,
            clsSeCode: '0',
            clsSeCodeNm: '현재',
        })),
        {
            pnu,
            agbldgSn: '5',
            buldNm: '미아동 공동주택',
            buldDongNm: '0000',
            buldFloorNm: '0000',
            buldHoNm: '0000',
            buldRoomNm: '0000',
            ldaQotaRate: '',
            clsSeCode: '0',
            clsSeCodeNm: '현재',
        },
    ];
    const propertyUnits: Array<
        PropertyUnitCandidate & {
            landArea: string;
            landAreaSource: 'MANUAL';
        }
    > = units.map((unit) => ({
        id: unit.propertyId,
        unionId: 'union-1',
        buildingUnitId: unit.buildingUnitId,
        pnu: basePnu,
        isDeleted: false,
        dong: null,
        ho: unit.ho,
        // pure assemble 입력의 기존 MANUAL DB 상태는 읽거나 덮어쓰지 않는다.
        landArea: unit.ho === '101' ? '8.26' : '1.00',
        landAreaSource: 'MANUAL',
    }));
    const buildingUnits: BuildingUnitCandidate[] = units.map((unit) => ({
        id: unit.buildingUnitId,
        buildingId,
        registryExternalId: null,
        dong: null,
        floor: null,
        ho: unit.ho,
    }));
    const propertyUnitsBefore = structuredClone(propertyUnits);

    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [basePnu, attachedPnu],
        rootIdentity: PK,
        canonicalSourcePnu: basePnu,
        perPnu: [
            {
                pnu: basePnu,
                ldaregRows: ldaregRows(basePnu),
                exposRows: units.map((unit) => ({
                    // raw up 누락: same-run basis child→title self로만 root를 보강한다.
                    mgmBldrgstPk: exposChildPk,
                    dongNm: '청성주택6차',
                    flrNo: Number(unit.floor),
                    hoNm: unit.ho,
                })),
                basisRows: [
                    {
                        mgmBldrgstPk: exposChildPk,
                        mgmUpBldrgstPk: PK,
                    },
                ],
            },
            {
                pnu: attachedPnu,
                ldaregRows: ldaregRows(attachedPnu),
                exposRows: [],
                basisRows: [
                    {
                        mgmBldrgstPk: exposChildPk,
                        mgmUpBldrgstPk: PK,
                    },
                ],
            },
        ],
        buildingUnits,
        propertyUnits,
        scopeLadfrlAreas: [
            { pnu: basePnu, area: '73' },
            { pnu: attachedPnu, area: '102' },
        ],
        scopeLadfrlTotal: '175',
    });

    assert.equal(result.blocking, false);
    assert.equal(result.items.length, 4);
    assert.deepEqual(
        propertyUnits,
        propertyUnitsBefore,
        'pure assemble은 MANUAL landArea/source 및 building link를 mutate하지 않는다'
    );
    assert.ok(
        propertyUnits.every(
            (propertyUnit) =>
                propertyUnit.pnu === basePnu &&
                propertyUnit.landAreaSource === 'MANUAL' &&
                propertyUnit.buildingUnitId !== null
        )
    );
    assert.deepEqual(
        result.matchedPropertyUnitIds.slice().sort(),
        units.map((unit) => unit.propertyId).sort()
    );
    assert.deepEqual(result.counts, {
        landRegistryRows: 10,
        exposureRows: 4,
        parsedRows: 8,
    });
    assert.deepEqual(result.replicationEvidence, {
        canonicalSourcePnu: basePnu,
        comparedPnus: [basePnu, attachedPnu],
        exactReplica: true,
        rowCount: 5,
        rowMultisetDigest:
            result.replicationEvidence?.rowMultisetDigest,
    });
    assert.match(
        result.replicationEvidence?.rowMultisetDigest ?? '',
        /^[0-9a-f]{64}$/
    );
    assert.equal(
        result.issues.filter(
            (issue) => issue.code === 'RATIO_PARSE_FAILED'
        ).length,
        1
    );
    const rootDigest = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'EXPOS_ROOT_RESOLUTION'
    ) as {
        rows: Array<{
            queryPnu: string;
            source: string;
            selfIdentity: string;
            rootIdentity: string;
        }>;
    };
    assert.equal(rootDigest.rows.length, 4);
    assert.ok(
        rootDigest.rows.every(
            (row) =>
                row.queryPnu === basePnu &&
                row.source === 'BASIS_UNIQUE' &&
                row.selfIdentity === exposChildPk &&
                row.rootIdentity === PK
        )
    );
    const fallbackDigest = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'EXPOS_FLOOR_HO_FALLBACK_GATE'
    ) as {
        allowed: boolean;
        exposDongUnique: boolean;
        ldaregDongUnique: boolean;
    };
    assert.equal(fallbackDigest.allowed, true);
    assert.equal(fallbackDigest.exposDongUnique, true);
    assert.equal(fallbackDigest.ldaregDongUnique, true);

    const itemByProperty = new Map(
        result.items.map((item) => [item.propertyUnitId, item])
    );
    for (const unit of units) {
        const item = itemByProperty.get(unit.propertyId);
        assert.ok(item, `${unit.ho}호가 base/attached scope에서 매칭되어야 한다`);
        assert.deepEqual(item.expectedTargetPnus, [basePnu, attachedPnu]);
        assert.equal(item.components.length, 2);
        assert.deepEqual(
            item.components.map((component) => component.targetPnu),
            [basePnu, attachedPnu]
        );
        assert.ok(
            item.components.every(
                (component) =>
                    component.ratioNumerator === unit.numerator &&
                    component.ratioDenominator === '175' &&
                    component.matchMethod === 'BUILDING_UNIT_ID' &&
                    component.matchedBuildingUnitId ===
                        unit.buildingUnitId
            )
        );
        assert.equal(
            new Set(
                item.components.map(
                    (component) => component.sourceIdentity
                )
            ).size,
            1,
            'PNU replica는 동일 logical identity를 공유한다'
        );
    }
});

test('기준·부속 PNU의 동일 EXPOS replica는 한 후보로 축약하지만 한 PNU 내부 중복은 ambiguity로 차단한다', () => {
    const sibling = '1168010100107360025';
    const ldareg = (pnu: string) => ({
        pnu,
        agbldgSn: '1',
        buldFloorNm: '3층',
        buldHoNm: '301',
        ldaQotaRate: '24.6/364.6',
        clsSeCode: '0',
    });
    const expos = {
        mgmBldrgstPk: PK,
        flrNoNm: '3층',
        hoNm: '301',
    };
    const common = {
        unionId: 'union-1',
        scannedPnus: [ANCHOR, sibling],
        rootIdentity: PK,
        canonicalSourcePnu: ANCHOR,
        buildingUnits: [],
        propertyUnits: [property],
        scopeLadfrlAreas: [
            { pnu: ANCHOR, area: '177.6' },
            { pnu: sibling, area: '187' },
        ],
        scopeLadfrlTotal: '364.6',
    };

    const crossPnuReplica = assemble({
        ...common,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [ldareg(ANCHOR)],
                exposRows: [expos],
            },
            {
                pnu: sibling,
                ldaregRows: [ldareg(sibling)],
                exposRows: [expos],
            },
        ],
    });
    assert.equal(crossPnuReplica.blocking, false);
    assert.equal(crossPnuReplica.items.length, 1);

    const samePnuDuplicate = assemble({
        ...common,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [ldareg(ANCHOR)],
                exposRows: [expos, expos],
            },
            {
                pnu: sibling,
                ldaregRows: [ldareg(sibling)],
                exposRows: [],
            },
        ],
    });
    assert.equal(samePnuDuplicate.blocking, true);
    assert.equal(samePnuDuplicate.items.length, 0);
    assert.ok(
        samePnuDuplicate.issues.some(
            (issue) => issue.code === 'PROPERTY_UNIT_AMBIGUOUS'
        )
    );

    const differentSelfIdentity = assemble({
        ...common,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [ldareg(ANCHOR)],
                exposRows: [
                    {
                        ...expos,
                        mgmUpBldrgstPk: PK,
                        mgmBldrgstPk: '2003004005006',
                    },
                ],
                basisRows: [
                    {
                        mgmBldrgstPk: '2003004005006',
                        mgmUpBldrgstPk: PK,
                    },
                ],
            },
            {
                pnu: sibling,
                ldaregRows: [ldareg(sibling)],
                exposRows: [
                    {
                        ...expos,
                        mgmUpBldrgstPk: PK,
                        mgmBldrgstPk: '2003004005007',
                    },
                ],
                basisRows: [
                    {
                        mgmBldrgstPk: '2003004005007',
                        mgmUpBldrgstPk: PK,
                    },
                ],
            },
        ],
    });
    assert.equal(differentSelfIdentity.blocking, true);
    assert.equal(differentSelfIdentity.items.length, 0);
    assert.ok(
        differentSelfIdentity.issues.some(
            (issue) => issue.code === 'PROPERTY_UNIT_AMBIGUOUS'
        )
    );
});

test('비적용 placeholder가 아닌 CURRENT 비율 파싱 실패는 전체 blocking한다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    {
                        pnu: ANCHOR,
                        agbldgSn: '1',
                        buldFloorNm: '3층',
                        buldHoNm: '301',
                        ldaQotaRate: 'invalid-ratio',
                        clsSeCode: '0',
                        clsSeCodeNm: '현재',
                    },
                ],
                exposRows: [
                    {
                        mgmBldrgstPk: PK,
                        flrNoNm: '3층',
                        hoNm: '301',
                    },
                ],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
    });

    assert.equal(result.blocking, true);
    assert.equal(result.items.length, 0);
    assert.ok(
        result.issues.some(
            (issue) => issue.code === 'RATIO_PARSE_FAILED'
        )
    );
});

test('매칭 실패(후보 없음)는 component 를 만들지 않고 issue 로 남긴다(tuple 보존)', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [{ pnu: ANCHOR, agbldgSn: '9', buldFloorNm: '9층', buldHoNm: '999', ldaQotaRate: '1/2', clsSeCode: '0' }],
                exposRows: [],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
    });
    assert.equal(result.items.length, 0);
    assert.ok(result.issues.length >= 1);
    assert.equal(result.blocking, true, 'nonzero raw를 empty apply payload로 보내지 않는다');
});

test('LDAREG 일부 호실만 EXPOS와 매칭되면 정상 component가 있어도 전체 blocking한다', () => {
    const matchedProperty: PropertyUnitCandidate = {
        ...property,
        ho: '301',
    };
    const unmatchedProperty: PropertyUnitCandidate = {
        ...property,
        id: '11111111-1111-4111-8111-111111111501',
        ho: '501',
    };
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    {
                        pnu: ANCHOR,
                        agbldgSn: '1',
                        buldFloorNm: '3층',
                        buldHoNm: '301',
                        ldaQotaRate: '181.7/15622.1',
                        clsSeCode: '0',
                    },
                    {
                        pnu: ANCHOR,
                        agbldgSn: '2',
                        buldFloorNm: '5층',
                        buldHoNm: '501',
                        ldaQotaRate: '200/15622.1',
                        clsSeCode: '0',
                    },
                ],
                exposRows: [
                    {
                        mgmBldrgstPk: PK,
                        flrNoNm: '3층',
                        hoNm: '301',
                    },
                ],
            },
        ],
        buildingUnits: [],
        propertyUnits: [matchedProperty, unmatchedProperty],
    });

    assert.equal(result.items.length, 1, '매칭된 component는 진단 근거로 보존한다');
    assert.equal(result.items[0].propertyUnitId, matchedProperty.id);
    assert.ok(
        result.issues.some(
            (issue) => issue.code === 'PROPERTY_UNIT_NOT_FOUND'
        )
    );
    assert.equal(
        result.blocking,
        true,
        '부분 매칭 결과는 apply하지 않고 job 전체를 REVIEW로 닫아야 한다'
    );
});

test('§10.4: accepted title self의 EXPOS raw up이 higher lineage면 자동 root로 채택하지 않는다', () => {
    const titleSelf = '9001002003005';
    const higherUp = '9001002003004';
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: titleSelf,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    { pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '181.7/15622.1', clsSeCode: '0', clsSeCodeNm: '유효' },
                ],
                exposRows: [
                    {
                        mgmUpBldrgstPk: higherUp,
                        mgmBldrgstPk: titleSelf,
                        flrNoNm: '3층',
                        hoNm: '301',
                    },
                ],
                basisRows: [
                    {
                        mgmBldrgstPk: titleSelf,
                        mgmUpBldrgstPk: higherUp,
                    },
                ],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
    });
    assert.equal(result.blocking, true);
    assert.equal(result.items.length, 0);
    assert.ok(
        result.issues.some(
            (issue) => issue.code === 'LDAREG_IDENTITY_CONFLICT'
        )
    );
});

test('basis exact self→unique root는 raw up이 빠진 EXPOS를 해소하고 provenance를 digest에 고정한다', () => {
    const childPk = '9001002003005';
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    {
                        pnu: ANCHOR,
                        agbldgSn: '1',
                        buldFloorNm: '3층',
                        buldHoNm: '301',
                        ldaQotaRate: '181.7/15622.1',
                        clsSeCode: '0',
                    },
                ],
                exposRows: [
                    {
                        mgmBldrgstPk: childPk,
                        flrNoNm: '3층',
                        hoNm: '301',
                    },
                ],
                basisRows: [
                    {
                        mgmBldrgstPk: childPk,
                        mgmUpBldrgstPk: PK,
                    },
                ],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
    });

    assert.equal(result.blocking, false);
    assert.equal(result.items.length, 1);
    const rootDigest = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'EXPOS_ROOT_RESOLUTION'
    ) as { rows: Array<{ source: string; rootIdentity: string }> };
    assert.deepEqual(
        rootDigest.rows.map((row) => ({
            source: row.source,
            rootIdentity: row.rootIdentity,
        })),
        [{ source: 'BASIS_UNIQUE', rootIdentity: PK }]
    );
});

test('EXPOS raw up이 basis exact parent와 충돌하면 보강하지 않고 전역 차단한다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    {
                        pnu: ANCHOR,
                        agbldgSn: '1',
                        buldFloorNm: '3층',
                        buldHoNm: '301',
                        ldaQotaRate: '181.7/15622.1',
                        clsSeCode: '0',
                    },
                ],
                exposRows: [
                    {
                        mgmBldrgstPk: '9001002003005',
                        mgmUpBldrgstPk: '9001002003999',
                        flrNoNm: '3층',
                        hoNm: '301',
                    },
                ],
                basisRows: [
                    {
                        mgmBldrgstPk: '9001002003005',
                        mgmUpBldrgstPk: PK,
                    },
                ],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
    });

    assert.equal(result.blocking, true);
    assert.equal(result.items.length, 0);
    assert.ok(
        result.issues.some(
            (issue) => issue.code === 'LDAREG_IDENTITY_CONFLICT'
        )
    );
});

test('single-root·양쪽 FH unique·한쪽 dong 누락일 때만 EXPOS floor+ho fallback을 사용한다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    {
                        pnu: ANCHOR,
                        agbldgSn: '1',
                        buldNm: '청성주택6차',
                        buldDongNm: '',
                        buldFloorNm: '1',
                        buldHoNm: '101',
                        buldRoomNm: '101',
                        ldaQotaRate: '8.26/73',
                        clsSeCode: '0',
                    },
                ],
                exposRows: [
                    {
                        mgmBldrgstPk: PK,
                        dongNm: '청성주택6차',
                        flrNoNm: '1',
                        hoNm: '101',
                    },
                ],
            },
        ],
        buildingUnits: [],
        propertyUnits: [
            {
                ...property,
                ho: '101',
            },
        ],
        scopeLadfrlAreas: [{ pnu: ANCHOR, area: '73' }],
        scopeLadfrlTotal: '73',
    });

    assert.equal(result.blocking, false);
    assert.equal(result.items.length, 1);
    const fallbackDigest = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'EXPOS_FLOOR_HO_FALLBACK_GATE'
    ) as { allowed: boolean; fallbackRequiredCount: number };
    assert.deepEqual(
        {
            allowed: fallbackDigest.allowed,
            fallbackRequiredCount: fallbackDigest.fallbackRequiredCount,
        },
        { allowed: true, fallbackRequiredCount: 1 }
    );
});

test('scope EXPOS의 normalized dong token이 둘이면 FH가 각각 유일해도 fallback을 닫는다', () => {
    const result = assembleDongFallbackScope({
        exposDongs: ['A동', 'B동'],
        buildingNames: ['청성주택6차', '청성주택6차'],
        agbldgSns: ['1', '1'],
    });
    assert.equal(result.blocking, true);
    const gate = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'EXPOS_FLOOR_HO_FALLBACK_GATE'
    ) as { allowed: boolean; exposDongUnique: boolean };
    assert.equal(gate.exposDongUnique, false);
    assert.equal(gate.allowed, false);
});

test('EXPOS dong이 없고 LDAREG가 A/B 두 동이면 역방향 multi-dong fallback을 닫는다', () => {
    const result = assembleDongFallbackScope({
        exposDongs: ['', ''],
        ldaregDongs: ['A동', 'B동'],
        buildingNames: ['청성주택6차', '청성주택6차'],
        agbldgSns: ['1', '1'],
    });
    assert.equal(result.blocking, true);
    const gate = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'EXPOS_FLOOR_HO_FALLBACK_GATE'
    ) as {
        allowed: boolean;
        exposDongUnique: boolean;
        ldaregDongUnique: boolean;
    };
    assert.equal(gate.exposDongUnique, true);
    assert.equal(gate.ldaregDongUnique, false);
    assert.equal(gate.allowed, false);
});

test('LDAREG nonempty buildingName 집합이 둘이면 FH가 각각 유일해도 fallback을 닫는다', () => {
    const result = assembleDongFallbackScope({
        exposDongs: ['A동', 'A동'],
        buildingNames: ['청성주택6차', '다른건물'],
        agbldgSns: ['1', '1'],
    });
    assert.equal(result.blocking, true);
    const gate = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'EXPOS_FLOOR_HO_FALLBACK_GATE'
    ) as {
        allowed: boolean;
        ldaregBuildingNameUnique: boolean;
        ldaregAgbldgSnUnique: boolean;
    };
    assert.equal(gate.ldaregBuildingNameUnique, false);
    assert.equal(gate.ldaregAgbldgSnUnique, true);
    assert.equal(gate.allowed, false);
});

test('LDAREG nonempty agbldgSn 집합이 둘이면 FH가 각각 유일해도 fallback을 닫는다', () => {
    const result = assembleDongFallbackScope({
        exposDongs: ['A동', 'A동'],
        buildingNames: ['청성주택6차', '청성주택6차'],
        agbldgSns: ['1', '2'],
    });
    assert.equal(result.blocking, true);
    const gate = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'EXPOS_FLOOR_HO_FALLBACK_GATE'
    ) as {
        allowed: boolean;
        ldaregBuildingNameUnique: boolean;
        ldaregAgbldgSnUnique: boolean;
    };
    assert.equal(gate.ldaregBuildingNameUnique, true);
    assert.equal(gate.ldaregAgbldgSnUnique, false);
    assert.equal(gate.allowed, false);
});

test('LDAREG buildingName이 한 건이라도 비어 있으면 FH가 각각 유일해도 fallback을 닫는다', () => {
    const result = assembleDongFallbackScope({
        exposDongs: ['A동', 'A동'],
        buildingNames: ['청성주택6차', ''],
        agbldgSns: ['1', '1'],
    });
    assert.equal(result.blocking, true);
    const gate = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'EXPOS_FLOOR_HO_FALLBACK_GATE'
    ) as {
        allowed: boolean;
        ldaregBuildingNameUnique: boolean;
    };
    assert.equal(gate.ldaregBuildingNameUnique, false);
    assert.equal(gate.allowed, false);
});

test('LDAREG agbldgSn이 한 건이라도 비어 있으면 FH가 각각 유일해도 fallback을 닫는다', () => {
    const result = assembleDongFallbackScope({
        exposDongs: ['A동', 'A동'],
        buildingNames: ['청성주택6차', '청성주택6차'],
        agbldgSns: ['1', ''],
    });
    assert.equal(result.blocking, true);
    const gate = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'EXPOS_FLOOR_HO_FALLBACK_GATE'
    ) as {
        allowed: boolean;
        ldaregAgbldgSnUnique: boolean;
    };
    assert.equal(gate.ldaregAgbldgSnUnique, false);
    assert.equal(gate.allowed, false);
});

test('같은 floor+ho에 LDAREG building/agbldgSn/room이 충돌하면 dong fallback은 닫힌다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    {
                        pnu: ANCHOR,
                        agbldgSn: '1',
                        buldNm: 'A동',
                        buldFloorNm: '3층',
                        buldHoNm: '301',
                        buldRoomNm: '301-A',
                        ldaQotaRate: '10/100',
                        clsSeCode: '0',
                    },
                    {
                        pnu: ANCHOR,
                        agbldgSn: '2',
                        buldNm: 'B동',
                        buldFloorNm: '3층',
                        buldHoNm: '301',
                        buldRoomNm: '301-B',
                        ldaQotaRate: '20/100',
                        clsSeCode: '0',
                    },
                ],
                exposRows: [
                    {
                        mgmBldrgstPk: PK,
                        dongNm: 'A동',
                        flrNoNm: '3층',
                        hoNm: '301',
                    },
                ],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
        scopeLadfrlAreas: [{ pnu: ANCHOR, area: '100' }],
        scopeLadfrlTotal: '100',
    });

    assert.equal(result.blocking, true);
    const fallbackDigest = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'EXPOS_FLOOR_HO_FALLBACK_GATE'
    ) as { allowed: boolean; ldaregMetadataCollision: boolean };
    assert.equal(fallbackDigest.allowed, false);
    assert.equal(fallbackDigest.ldaregMetadataCollision, true);
});

test('I1: FALLBACK identity 는 대표 row 의 정확한 source_record 를 뽑는다(첫 row 오염 회귀 가드)', () => {
    // 같은 PNU 에 서로 다른 두 세대(둘 다 agbldgSn 없음 → FALLBACK). 수정 전에는 find 술어가 항상-true 라
    // 두 record 모두 첫 row 의 source_record(buldNm '동A')를 가져갔다. 수정 후 각자 정확한 row 를 가리킨다.
    const propA: PropertyUnitCandidate = { id: '11111111-1111-4111-8111-1111111111a1', unionId: 'union-1', buildingUnitId: null, pnu: ANCHOR, isDeleted: false, dong: null, ho: '301' };
    const propB: PropertyUnitCandidate = { id: '11111111-1111-4111-8111-1111111111b2', unionId: 'union-1', buildingUnitId: null, pnu: ANCHOR, isDeleted: false, dong: null, ho: '501' };
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    { pnu: ANCHOR, agbldgSn: '', buldNm: '동A', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '100/15000', clsSeCode: '0' },
                    { pnu: ANCHOR, agbldgSn: '', buldNm: '동B', buldFloorNm: '5층', buldHoNm: '501', ldaQotaRate: '200/15000', clsSeCode: '0' },
                ],
                exposRows: [
                    { mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' },
                    { mgmBldrgstPk: PK, flrNoNm: '5층', hoNm: '501' },
                ],
            },
        ],
        buildingUnits: [],
        propertyUnits: [propA, propB],
        scopeLadfrlTotal: '15000',
    });
    assert.equal(result.items.length, 2, '두 세대 모두 매칭');
    const byProp = new Map(result.items.map((i) => [i.propertyUnitId, i.components[0]]));
    const cA = byProp.get(propA.id)!;
    const cB = byProp.get(propB.id)!;
    // 각 component 는 자신의 원본 row 에서 source_record 를 뽑아야 한다(오염 시 둘 다 '동A'/'301').
    assert.equal(cA.sourceRecord.buldNm, '동A');
    assert.equal(cA.sourceRecord.buldHoNm, '301');
    assert.equal(cB.sourceRecord.buldNm, '동B');
    assert.equal(cB.sourceRecord.buldHoNm, '501');
});

test('I2: 분모가 same-run LADFRL scope 합계와 다르면 전역 blocking한다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [{ pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '100/15000', clsSeCode: '0' }],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
        scopeLadfrlTotal: '20000',
    });
    assert.equal(result.items.length, 0, '불일치 component 는 제외');
    assert.ok(result.issues.some((i) => i.code === 'RATIO_DENOMINATOR_MISMATCH'), 'mismatch issue 기록');
    assert.equal(result.counts.parsedRows, 0);
    assert.equal(result.blocking, true);
});

test('I2: 단일 PNU 분모가 same-run LADFRL scope 합계와 일치하면 정상 조립한다', () => {
    const match = assemble({
        unionId: 'union-1', scannedPnus: [ANCHOR], rootIdentity: PK,
        perPnu: [{ pnu: ANCHOR, ldaregRows: [{ pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '181.7/15622.1', clsSeCode: '0' }], exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }] }],
        buildingUnits: [], propertyUnits: [property],
    });
    assert.equal(match.items.length, 1, '분모 일치 → 조립');
    assert.ok(!match.issues.some((i) => i.code === 'RATIO_DENOMINATOR_MISMATCH'));
    assert.equal(match.blocking, false);
});

test('I2: 실측 177.6+187=364.6을 유일한 분모 기준으로 사용하고 개별 PNU OR 정책을 허용하지 않는다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR, '1168010100107360025'],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [{ pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '24.6/364.6', clsSeCode: '0' }],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
            {
                pnu: '1168010100107360025',
                ldaregRows: [{ pnu: '1168010100107360025', agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '24.6/364.6', clsSeCode: '0' }],
                exposRows: [],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
        scopeLadfrlAreas: [
            { pnu: ANCHOR, area: '177.6' },
            { pnu: '1168010100107360025', area: '187' },
        ],
        scopeLadfrlTotal: '364.6',
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].components.length, 2, 'PNU별 provenance component 보존');
    assert.equal(result.items[0].components[0].ratioNumerator, '24.6');
    assert.equal(
        new Set(result.items[0].components.map((component) => component.sourceIdentity)).size,
        1,
        'target PNU 독립 canonical identity 공유'
    );
    assert.equal(result.blocking, false);
    assert.ok(
        result.componentMatchDigest.some(
            (entry) =>
                JSON.stringify(entry).includes('177.6') &&
                JSON.stringify(entry).includes('187') &&
                JSON.stringify(entry).includes('364.6')
        )
    );
});

test('I2: CURRENT 행의 분모가 섞이면 정상 component가 일부 있어도 job 전체 blocking한다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    { pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '24.6/364.6', clsSeCode: '0' },
                    { pnu: ANCHOR, agbldgSn: '2', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '10/177.6', clsSeCode: '0' },
                ],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
        scopeLadfrlAreas: [{ pnu: ANCHOR, area: '364.6' }],
        scopeLadfrlTotal: '364.6',
    });
    assert.equal(result.blocking, true);
    assert.ok(result.issues.some((issue) => issue.code === 'RATIO_DENOMINATOR_MISMATCH'));
});

test('Phase 0 실측: base expos nonzero+attached expos zero exact replica는 PNU별 provenance를 보존한다', () => {
    const sibling = '1168010100107360025';
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR, sibling],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [{ pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '24.6/364.6', clsSeCode: '0' }],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
            {
                pnu: sibling,
                ldaregRows: [{ pnu: sibling, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '24.6/364.6', clsSeCode: '0' }],
                exposRows: [],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
        scopeLadfrlAreas: [
            { pnu: ANCHOR, area: '177.6' },
            { pnu: sibling, area: '187' },
        ],
        scopeLadfrlTotal: '364.6',
    });
    assert.equal(result.blocking, false);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].components.length, 2);
    assert.deepEqual(
        result.items[0].components.map((component) => component.targetPnu),
        [ANCHOR, sibling]
    );
    assert.equal(
        new Set(result.items[0].components.map((component) => component.sourceIdentity)).size,
        1
    );
});

test('LDAREG replica multiset은 일부 누락·ratio/state 변조·한쪽 duplicate를 모두 차단한다', () => {
    const sibling = '1168010100107360025';
    const row = (pnu: string, over: Record<string, unknown> = {}) => ({
        pnu,
        agbldgSn: '1',
        buldFloorNm: '3층',
        buldHoNm: '301',
        ldaQotaRate: '24.6/364.6',
        clsSeCode: '0',
        clsSeCodeNm: '유효',
        ...over,
    });
    const scan = (attachedRows: ReturnType<typeof row>[]) =>
        validateLdaregReplication(
            [ANCHOR, sibling],
            [
                { pnu: ANCHOR, ldaregRows: [row(ANCHOR)], exposRows: [] },
                { pnu: sibling, ldaregRows: attachedRows, exposRows: [] },
            ],
            ANCHOR
        );

    assert.equal(scan([]).ok, false, '일부 누락');
    assert.equal(scan([row(sibling, { ldaQotaRate: '25/364.6' })]).ok, false, 'ratio 변조');
    assert.equal(scan([row(sibling, { clsSeCode: '2', clsSeCodeNm: '말소' })]).ok, false, 'state 변조');
    assert.equal(scan([row(sibling), row(sibling)]).ok, false, 'multiset 중복 개수 변조');
});

test('canonical expos source는 linked base의 nonzero exact dataset만 허용하고 attached zero는 무시한다', () => {
    const sibling = '1168010100107360025';
    const perPnu = [
        {
            pnu: ANCHOR,
            ldaregRows: [],
            exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
        },
        { pnu: sibling, ldaregRows: [], exposRows: [] },
    ];
    assert.equal(
        selectCanonicalExposSourcePnu([ANCHOR], perPnu, [PK]),
        ANCHOR
    );
    assert.equal(
        selectCanonicalExposSourcePnu([sibling], perPnu, [PK]),
        null
    );
    assert.equal(
        selectCanonicalExposSourcePnu(
            [ANCHOR, sibling],
            perPnu,
            [PK]
        ),
        null,
        '두 번째 base의 expos zero를 attached zero처럼 무시하지 않는다'
    );
});

test('all-PNU LDAREG COMPLETE_ZERO는 active scope property별 empty component item을 만든다', () => {
    const sibling = '1168010100107360025';
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR, sibling],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
            { pnu: sibling, ldaregRows: [], exposRows: [] },
        ],
        buildingUnits: [],
        propertyUnits: [property],
        scopeLadfrlAreas: [
            { pnu: ANCHOR, area: '177.6' },
            { pnu: sibling, area: '187' },
        ],
        scopeLadfrlTotal: '364.6',
    });
    assert.equal(result.blocking, false);
    assert.equal(result.replicationEvidence?.rowCount, 0);
    assert.deepEqual(result.items, [
        {
            propertyUnitId: PROP_ID,
            expectedTargetPnus: [ANCHOR, sibling],
            components: [],
        },
    ]);
});

test('같은 property에 서로 다른 CURRENT sourceIdentity 2개가 매칭되면 apply 전에 전역 blocking한다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    { pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '10/100', clsSeCode: '0' },
                    { pnu: ANCHOR, agbldgSn: '2', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '20/100', clsSeCode: '0' },
                ],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
        scopeLadfrlAreas: [{ pnu: ANCHOR, area: '100' }],
        scopeLadfrlTotal: '100',
    });
    assert.equal(result.blocking, true);
    assert.ok(result.issues.some((issue) => issue.code === 'LDAREG_IDENTITY_CONFLICT'));
});

test('같은 property에 CURRENT와 다른 CLOSED identity가 함께 매칭돼도 API에서 전역 blocking한다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    { pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '10/100', clsSeCode: '0' },
                    { pnu: ANCHOR, agbldgSn: '2', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '10/100', clsSeCode: '2', clsSeCodeNm: '말소' },
                ],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
        scopeLadfrlAreas: [{ pnu: ANCHOR, area: '100' }],
        scopeLadfrlTotal: '100',
    });
    assert.equal(result.blocking, true);
    assert.ok(result.issues.some((issue) => issue.code === 'LDAREG_IDENTITY_CONFLICT'));
});

test('dedup identity payload conflict는 정상 row가 남아도 partial apply하지 않고 전역 blocking한다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    // agbldgSn 없음 + 같은 immutable tuple, ratio만 달라 같은 fallback identity conflict.
                    { pnu: ANCHOR, agbldgSn: '', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '10/100', clsSeCode: '0' },
                    { pnu: ANCHOR, agbldgSn: '', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '20/100', clsSeCode: '0' },
                    // 별도 정상 row가 있어도 partial apply 금지.
                    { pnu: ANCHOR, agbldgSn: '3', buldFloorNm: '5층', buldHoNm: '501', ldaQotaRate: '30/100', clsSeCode: '0' },
                ],
                exposRows: [
                    { mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' },
                    { mgmBldrgstPk: PK, flrNoNm: '5층', hoNm: '501' },
                ],
            },
        ],
        buildingUnits: [],
        propertyUnits: [
            property,
            {
                ...property,
                id: '22222222-2222-4222-8222-222222222222',
                ho: '501',
            },
        ],
        scopeLadfrlAreas: [{ pnu: ANCHOR, area: '100' }],
        scopeLadfrlTotal: '100',
    });
    assert.equal(result.blocking, true);
    assert.ok(result.issues.some((issue) => issue.code === 'LDAREG_IDENTITY_CONFLICT'));
});

test('원장 승격: clsSeCode 불명확(ambiguous)이면 CURRENT 유지하되 LDAREG_IDENTITY_CONFLICT issue 1건을 남긴다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                // clsSeCode 'X7' / clsSeCodeNm 'ZZZ' → mapClsSeCodeToSourceState ambiguous=true (CURRENT 유지).
                ldaregRows: [{ pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '181.7/15622.1', clsSeCode: 'X7', clsSeCodeNm: 'ZZZ' }],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
    });
    assert.equal(result.items.length, 1, 'ambiguous 여도 CURRENT 로 유지·적용');
    assert.equal(result.items[0].components[0].sourceState, 'CURRENT');
    assert.ok(result.issues.some((i) => i.code === 'LDAREG_IDENTITY_CONFLICT'), 'ambiguous 표시 issue 1건');
});

test('CLOSED(명시 말소)는 retiredReason 을 가진 CLOSED component 로 만든다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [{ pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '181.7/15622.1', clsSeCode: '2', clsSeCodeNm: '말소' }],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
    });
    assert.equal(result.items.length, 1);
    const c = result.items[0].components[0];
    assert.equal(c.sourceState, 'CLOSED');
    assert.ok(c.retiredReason && c.retiredReason.length > 0);
});
