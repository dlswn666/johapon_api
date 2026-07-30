import assert from 'node:assert/strict';
import test from 'node:test';
import {
    LDAREG_OFFICIAL_CURRENT_SUPERSET_MODE,
    assembleLdaregApply,
    selectCanonicalExposSourcePnu,
    validateLdaregReplication,
    type LdaregBranchInput,
} from '../src/services/land-area-sync/ldareg-branch';
import { sumCurrentNumerators } from '../src/services/land-area-sync/service';
import { providerUnitShapeWitness } from '../src/services/land-area-sync/provider-unit-shape-bridge';
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
    const providerBridgeGate = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'EXPOS_PROVIDER_SHAPE_BRIDGE_GATE'
    ) as { allowed: boolean; bridgeRequiredCount: number };
    assert.deepEqual(providerBridgeGate, {
        ...providerBridgeGate,
        allowed: false,
        bridgeRequiredCount: 0,
    });
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
        0
    );
    assert.ok(
        result.componentMatchDigest.some(
            (entry) =>
                entry.kind ===
                    'LDAREG_NON_APPLICABLE_PLACEHOLDER' &&
                entry.ignoredCount === 1
        )
    );
});

function linkedCandidates(
    units: Array<{
        floor: string | null;
        ho: string;
        propertyId: string;
        buildingUnitId: string;
    }>
): {
    buildingUnits: BuildingUnitCandidate[];
    propertyUnits: PropertyUnitCandidate[];
} {
    return {
        buildingUnits: units.map((unit) => ({
            id: unit.buildingUnitId,
            buildingId:
                '33333333-3333-4333-8333-333333333333',
            dong: null,
            floor: unit.floor,
            ho: unit.ho,
            registryExternalId: null,
        })),
        propertyUnits: units.map((unit) => ({
            id: unit.propertyId,
            unionId: 'union-1',
            buildingUnitId: unit.buildingUnitId,
            pnu: ANCHOR,
            isDeleted: false,
            dong: null,
            ho: unit.ho,
        })),
    };
}

test('runtime 791-2172: exact 지상N(no suffix)↔EXPOS numeric N을 raw unit로 결속하고 live ratio association을 보존한다', () => {
    const units = [
        {
            floor: '3',
            ho: '301',
            numerator: '27.5',
            propertyId: 'PU-2172-301',
            buildingUnitId: 'BU-2172-301',
        },
        {
            floor: '5',
            ho: '501',
            numerator: '17.26',
            propertyId: 'PU-2172-501',
            buildingUnitId: 'BU-2172-501',
        },
        {
            floor: '4',
            ho: '401',
            numerator: '19.9',
            propertyId: 'PU-2172-401',
            buildingUnitId: 'BU-2172-401',
        },
        {
            floor: '2',
            ho: '201',
            numerator: '19.97',
            propertyId: 'PU-2172-201',
            buildingUnitId: 'BU-2172-201',
        },
        {
            floor: '2',
            ho: '202',
            numerator: '16.87',
            propertyId: 'PU-2172-202',
            buildingUnitId: 'BU-2172-202',
        },
    ];
    const candidates = linkedCandidates(
        units.map((unit) => ({ ...unit, floor: null }))
    );
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                // 순서를 뒤집어 ratio/order 기반 연결이 아님을 고정한다.
                ldaregRows: [...units].reverse().map((unit) => ({
                    pnu: ANCHOR,
                    agbldgSn: 'MIA7-2172',
                    buldNm: '월드빌라',
                    // A↔A와 A↔missing 혼합도 동일 단일 동이면 허용한다.
                    buldDongNm:
                        unit.ho === '301'
                            ? '월드빌라'
                            : '0000',
                    buldFloorNm: `지상${unit.floor}`,
                    buldHoNm: unit.ho,
                    buldRoomNm: unit.ho,
                    ldaQotaRate: `${unit.numerator}/121`,
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                })),
                exposRows: units.map((unit) => ({
                    mgmBldrgstPk: PK,
                    dongNm: '월드빌라',
                    flrGbCd: '20',
                    flrNo: Number(unit.floor),
                    hoNm: unit.ho,
                })),
            },
        ],
        ...candidates,
        scopeLadfrlAreas: [{ pnu: ANCHOR, area: '121' }],
        scopeLadfrlTotal: '121',
    });

    assert.equal(result.blocking, false);
    assert.equal(result.items.length, 5);
    const numeratorByProperty = new Map(
        result.items.map((item) => [
            item.propertyUnitId,
            item.components[0].ratioNumerator,
        ])
    );
    assert.deepEqual(
        [...numeratorByProperty.entries()].sort(),
        units
            .map((unit) => [
                unit.propertyId,
                unit.numerator,
            ])
            .sort()
    );
    const gate = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'EXPOS_PROVIDER_SHAPE_BRIDGE_GATE'
    ) as {
        allowed: boolean;
        bridgeRequiredCount: number;
        sourceWitnessUnique: boolean;
        exposWitnessOneToOne: boolean;
    };
    assert.deepEqual(gate, {
        ...gate,
        allowed: true,
        bridgeRequiredCount: 5,
        sourceWitnessUnique: true,
        exposWitnessOneToOne: true,
    });
});

test('runtime provider bridge는 root가 같아도 LDAREG building name이 둘이면 닫힌다', () => {
    const units = [
        {
            floor: '2',
            ho: '201',
            propertyId: 'PU-BUILDING-A',
            buildingUnitId: 'BU-BUILDING-A',
        },
        {
            floor: '3',
            ho: '301',
            propertyId: 'PU-BUILDING-B',
            buildingUnitId: 'BU-BUILDING-B',
        },
    ];
    const candidates = linkedCandidates(
        units.map((unit) => ({ ...unit, floor: null }))
    );
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: units.map((unit, index) => ({
                    pnu: ANCHOR,
                    agbldgSn: 'MIA7-MIXED',
                    buldNm: index === 0 ? 'A동' : 'B동',
                    buldFloorNm: `지상${unit.floor}`,
                    buldHoNm: unit.ho,
                    ldaQotaRate: '50/100',
                    clsSeCode: '0',
                })),
                exposRows: units.map((unit) => ({
                    mgmBldrgstPk: PK,
                    dongNm: '단일동',
                    flrGbCd: '20',
                    flrNo: Number(unit.floor),
                    hoNm: unit.ho,
                })),
            },
        ],
        ...candidates,
        scopeLadfrlAreas: [{ pnu: ANCHOR, area: '100' }],
        scopeLadfrlTotal: '100',
    });
    assert.equal(
        result.replicationEvidence,
        null,
        'provider scope all-row building identity proof가 먼저 차단한다'
    );
    assert.equal(result.blocking, true);
    assert.equal(result.items.length, 0);
});

for (const rawFloors of [
    ['지상2', '지상02'],
    ['지상02', '지상2'],
] as const) {
    test(`runtime provider bridge는 dedup raw member 전수 witness가 다르면 순서와 무관하게 닫힌다 (${rawFloors.join(
        '→'
    )})`, () => {
        const candidates = linkedCandidates([
            {
                floor: null,
                ho: '201',
                propertyId: 'PU-RAW-MEMBER-201',
                buildingUnitId: 'BU-RAW-MEMBER-201',
            },
        ]);
        const result = assemble({
            unionId: 'union-1',
            scannedPnus: [ANCHOR],
            rootIdentity: PK,
            perPnu: [
                {
                    pnu: ANCHOR,
                    ldaregRows: rawFloors.map((floor) => ({
                        pnu: ANCHOR,
                        agbldgSn: 'MIA7-RAW-MEMBER',
                        buldNm: 'MIA7-RAW-MEMBER',
                        buldFloorNm: floor,
                        buldHoNm: '201',
                        buldRoomNm: '201',
                        ldaQotaRate: '20/121',
                        clsSeCode: '0',
                        clsSeCodeNm: '현재',
                    })),
                    exposRows: [
                        {
                            mgmBldrgstPk: PK,
                            flrGbCd: '20',
                            flrNo: 2,
                            hoNm: '201',
                        },
                    ],
                },
            ],
            ...candidates,
            scopeLadfrlAreas: [
                { pnu: ANCHOR, area: '121' },
            ],
            scopeLadfrlTotal: '121',
        });
        const gate = result.componentMatchDigest.find(
            (entry) =>
                (entry as { kind?: string }).kind ===
                'EXPOS_PROVIDER_SHAPE_BRIDGE_GATE'
        ) as {
            allowed: boolean;
            sourceRawWitnessConsistent: boolean;
        };
        assert.equal(
            gate.sourceRawWitnessConsistent,
            false
        );
        assert.equal(gate.allowed, false);
        assert.equal(result.blocking, true);
        assert.equal(result.items.length, 0);
    });
}

for (const placeholderFirst of [false, true]) {
    test(`runtime provider bridge는 ${
        placeholderFirst ? '앞' : '뒤'
    }의 missing placeholder까지 단일 building identity가 아니면 닫힌다`, () => {
        const candidates = linkedCandidates([
            {
                floor: null,
                ho: '201',
                propertyId: 'PU-PLACEHOLDER-201',
                buildingUnitId: 'BU-PLACEHOLDER-201',
            },
        ]);
        const validRow = {
            pnu: ANCHOR,
            agbldgSn: 'MIA7-PLACEHOLDER-A',
            buldNm: 'MIA7-PLACEHOLDER-A',
            buldDongNm: '0000',
            buldFloorNm: '지상2',
            buldHoNm: '201',
            buldRoomNm: '201',
            ldaQotaRate: '20/121',
            clsSeCode: '0',
            clsSeCodeNm: '현재',
        };
        const placeholderRow = {
            pnu: ANCHOR,
            agbldgSn: 'MIA7-PLACEHOLDER-B',
            buldNm: 'MIA7-PLACEHOLDER-B',
            buldDongNm: '0000',
            buldFloorNm: '0000',
            buldHoNm: '0000',
            buldRoomNm: '0000',
            ldaQotaRate: '',
            clsSeCode: '0',
            clsSeCodeNm: '현재',
        };
        const result = assemble({
            unionId: 'union-1',
            scannedPnus: [ANCHOR],
            rootIdentity: PK,
            perPnu: [
                {
                    pnu: ANCHOR,
                    ldaregRows: placeholderFirst
                        ? [placeholderRow, validRow]
                        : [validRow, placeholderRow],
                    exposRows: [
                        {
                            mgmBldrgstPk: PK,
                            flrGbCd: '20',
                            flrNo: 2,
                            hoNm: '201',
                        },
                    ],
                },
            ],
            ...candidates,
            scopeLadfrlAreas: [
                { pnu: ANCHOR, area: '121' },
            ],
            scopeLadfrlTotal: '121',
        });
        assert.equal(
            result.replicationEvidence,
            null,
            'placeholder도 provider scope all-row identity에 포함한다'
        );
        assert.equal(result.blocking, true);
        assert.equal(result.items.length, 0);
    });
}

for (const identityVariant of [
    {
        name: '부지번 building name의 NFKC variant',
        canonical: {
            agbldgSn: '1' as unknown,
            buldNm: 'A' as unknown,
        },
        attached: {
            agbldgSn: '1' as unknown,
            buldNm: 'Ａ' as unknown,
        },
    },
    {
        name: '부지번 aggregate serial의 numeric variant',
        canonical: {
            agbldgSn: '1' as unknown,
            buldNm: 'A' as unknown,
        },
        attached: {
            agbldgSn: 1 as unknown,
            buldNm: 'A' as unknown,
        },
    },
] as const) {
    test(`runtime provider bridge는 ${identityVariant.name}를 exact building identity로 접지 않는다`, () => {
        const sibling = '1168010100107360025';
        const row = (
            pnu: string,
            identity: {
                agbldgSn: unknown;
                buldNm: unknown;
            }
        ) =>
            ({
                pnu,
                agbldgSn: identity.agbldgSn,
                buldNm: identity.buldNm,
                buldFloorNm: '지상2',
                buldHoNm: '201',
                buldRoomNm: '201',
                ldaQotaRate: '20/121',
                clsSeCode: '0',
                clsSeCodeNm: '현재',
            }) as unknown as LdaregBranchInput['perPnu'][number]['ldaregRows'][number];
        const result = assemble({
            unionId: 'union-1',
            scannedPnus: [ANCHOR, sibling],
            rootIdentity: PK,
            perPnu: [
                {
                    pnu: ANCHOR,
                    ldaregRows: [
                        row(
                            ANCHOR,
                            identityVariant.canonical
                        ),
                    ],
                    exposRows: [
                        {
                            mgmBldrgstPk: PK,
                            flrGbCd: '20',
                            flrNo: 2,
                            hoNm: '201',
                        },
                    ],
                },
                {
                    pnu: sibling,
                    ldaregRows: [
                        row(
                            sibling,
                            identityVariant.attached
                        ),
                    ],
                    exposRows: [],
                },
            ],
            ...linkedCandidates([
                {
                    floor: null,
                    ho: '201',
                    propertyId: 'PU-IDENTITY-201',
                    buildingUnitId: 'BU-IDENTITY-201',
                },
            ]),
            scopeLadfrlAreas: [
                { pnu: ANCHOR, area: '60' },
                { pnu: sibling, area: '61' },
            ],
            scopeLadfrlTotal: '121',
        });
        assert.equal(
            result.replicationEvidence,
            null,
            'provider v3 replica key가 대표/부지번 raw string identity variant를 먼저 차단한다'
        );
        assert.equal(result.blocking, true);
        assert.equal(result.items.length, 0);
    });
}

for (const identityVariant of [
    {
        name: 'NFKC로만 같아지는 building name',
        buildingNames: ['A', 'Ａ'] as const,
        aggregateSerials: ['1', '1'] as const,
    },
    {
        name: 'string/number aggregate serial',
        buildingNames: ['A', 'A'] as const,
        aggregateSerials: ['1', 1] as const,
    },
] as const) {
    test(`runtime provider bridge gate는 단일 PNU의 ${identityVariant.name}을 exact identity로 접지 않는다`, () => {
        const units = [
            {
                floor: '2',
                ho: '201',
                propertyId: 'PU-IDENTITY-GATE-201',
                buildingUnitId: 'BU-IDENTITY-GATE-201',
            },
            {
                floor: '3',
                ho: '301',
                propertyId: 'PU-IDENTITY-GATE-301',
                buildingUnitId: 'BU-IDENTITY-GATE-301',
            },
        ] as const;
        const result = assemble({
            unionId: 'union-1',
            scannedPnus: [ANCHOR],
            rootIdentity: PK,
            perPnu: [
                {
                    pnu: ANCHOR,
                    ldaregRows: units.map(
                        (unit, index) =>
                            ({
                                pnu: ANCHOR,
                                agbldgSn:
                                    identityVariant
                                        .aggregateSerials[index],
                                buldNm:
                                    identityVariant
                                        .buildingNames[index],
                                buldFloorNm: `지상${unit.floor}`,
                                buldHoNm: unit.ho,
                                buldRoomNm: unit.ho,
                                ldaQotaRate: '50/100',
                                clsSeCode: '0',
                                clsSeCodeNm: '현재',
                            }) as unknown as LdaregBranchInput['perPnu'][number]['ldaregRows'][number]
                    ),
                    exposRows: units.map((unit) => ({
                        mgmBldrgstPk: PK,
                        flrGbCd: '20',
                        flrNo: Number(unit.floor),
                        hoNm: unit.ho,
                    })),
                },
            ],
            ...linkedCandidates(
                units.map((unit) => ({
                    ...unit,
                    floor: null,
                }))
            ),
            scopeLadfrlAreas: [
                { pnu: ANCHOR, area: '100' },
            ],
            scopeLadfrlTotal: '100',
        });
        assert.equal(
            result.replicationEvidence,
            null,
            'single-PNU raw identity variant도 shared proof에서 차단한다'
        );
        assert.equal(result.blocking, true);
        assert.equal(result.items.length, 0);
    });
}

for (const invalidDongCase of [
    {
        name: '양쪽 nonempty 동이 A↔B로 다름',
        ldaregDongs: ['A', 'A'],
        exposDongs: ['B', 'B'],
    },
    {
        name: 'one-sided 방향이 EXPOS_ONLY와 LDAREG_ONLY로 섞임',
        ldaregDongs: ['A', undefined],
        exposDongs: [undefined, 'A'],
    },
    {
        name: 'one-sided가 있는데 전체 nonempty 동이 A/B 둘임',
        ldaregDongs: ['A', undefined],
        exposDongs: ['A', 'B'],
    },
] as const) {
    test(`runtime provider bridge dong parity는 ${invalidDongCase.name}이면 닫힌다`, () => {
        const units = [
            {
                floor: '2',
                ho: '201',
                propertyId: 'PU-DONG-201',
                buildingUnitId: 'BU-DONG-201',
            },
            {
                floor: '3',
                ho: '301',
                propertyId: 'PU-DONG-301',
                buildingUnitId: 'BU-DONG-301',
            },
        ] as const;
        const result = assemble({
            unionId: 'union-1',
            scannedPnus: [ANCHOR],
            rootIdentity: PK,
            perPnu: [
                {
                    pnu: ANCHOR,
                    ldaregRows: units.map(
                        (unit, index) => ({
                            pnu: ANCHOR,
                            agbldgSn: 'MIA7-DONG-PARITY',
                            buldNm: 'MIA7-DONG-PARITY',
                            buldDongNm:
                                invalidDongCase
                                    .ldaregDongs[index],
                            buldFloorNm: `지상${unit.floor}`,
                            buldHoNm: unit.ho,
                            buldRoomNm: unit.ho,
                            ldaQotaRate: '50/100',
                            clsSeCode: '0',
                            clsSeCodeNm: '현재',
                        })
                    ),
                    exposRows: units.map(
                        (unit, index) => ({
                            mgmBldrgstPk: PK,
                            dongNm:
                                invalidDongCase
                                    .exposDongs[index],
                            flrGbCd: '20',
                            flrNo: Number(unit.floor),
                            hoNm: unit.ho,
                        })
                    ),
                },
            ],
            ...linkedCandidates(
                units.map((unit) => ({
                    ...unit,
                    floor: null,
                }))
            ),
            scopeLadfrlAreas: [
                { pnu: ANCHOR, area: '100' },
            ],
            scopeLadfrlTotal: '100',
        });
        const gate = result.componentMatchDigest.find(
            (entry) =>
                (entry as { kind?: string }).kind ===
                'EXPOS_PROVIDER_SHAPE_BRIDGE_GATE'
        ) as {
            allowed: boolean;
            dongCompatible: boolean;
        };
        assert.equal(gate.dongCompatible, false);
        assert.equal(gate.allowed, false);
        assert.equal(result.blocking, true);
        assert.equal(result.items.length, 0);
    });
}

test('runtime provider bridge는 standard exact 소비 뒤 extra residual EXPOS witness가 남으면 닫힌다', () => {
    const candidates = linkedCandidates([
        {
            floor: '1',
            ho: '101',
            propertyId: 'PU-EXACT-101',
            buildingUnitId: 'BU-EXACT-101',
        },
        {
            floor: null,
            ho: 'B1',
            propertyId: 'PU-BRIDGE-B1',
            buildingUnitId: 'BU-BRIDGE-B1',
        },
    ]);
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
                        agbldgSn: 'MIA7-EXTRA-RESIDUAL',
                        buldNm: 'MIA7-EXTRA-RESIDUAL',
                        buldFloorNm: '1',
                        buldHoNm: '101',
                        ldaQotaRate: '60/100',
                        clsSeCode: '0',
                    },
                    {
                        pnu: ANCHOR,
                        agbldgSn: 'MIA7-EXTRA-RESIDUAL',
                        buldNm: 'MIA7-EXTRA-RESIDUAL',
                        buldFloorNm: '지하',
                        buldHoNm: '비1',
                        ldaQotaRate: '40/100',
                        clsSeCode: '0',
                    },
                ],
                exposRows: [
                    {
                        mgmBldrgstPk: PK,
                        flrGbCd: '20',
                        flrNo: 1,
                        hoNm: '101',
                    },
                    {
                        mgmBldrgstPk: PK,
                        flrGbCd: '10',
                        flrNo: 1,
                        hoNm: 'B1',
                    },
                    {
                        mgmBldrgstPk: PK,
                        flrGbCd: '10',
                        flrNo: 1,
                        hoNm: 'B2',
                    },
                ],
            },
        ],
        ...candidates,
        scopeLadfrlAreas: [{ pnu: ANCHOR, area: '100' }],
        scopeLadfrlTotal: '100',
    });
    const gate = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'EXPOS_PROVIDER_SHAPE_BRIDGE_GATE'
    ) as {
        allowed: boolean;
        standardExactOneToOne: boolean;
        exposWitnessOneToOne: boolean;
    };
    assert.equal(gate.standardExactOneToOne, true);
    assert.equal(gate.exposWitnessOneToOne, false);
    assert.equal(gate.allowed, false);
    assert.equal(result.blocking, true);
    assert.deepEqual(
        result.items.map((item) => item.propertyUnitId),
        ['PU-EXACT-101']
    );
});

test('runtime 791-2188: 일반 4호는 기존 exact 경로, B01/B02↔비01/비02만 positive suffix bridge를 사용한다', () => {
    const units = [
        {
            floor: '1',
            ho: '101',
            lFloor: '1',
            lHo: '101',
            numerator: '40',
        },
        {
            floor: '2',
            ho: '201',
            lFloor: '2',
            lHo: '201',
            numerator: '35',
        },
        {
            floor: '3',
            ho: '301',
            lFloor: '3',
            lHo: '301',
            numerator: '45',
        },
        {
            floor: '4',
            ho: '401',
            lFloor: '4',
            lHo: '401',
            numerator: '51.27',
        },
        {
            floor: '1',
            ho: 'B1',
            lFloor: '지하',
            lHo: '비01',
            numerator: '20.18',
        },
        {
            floor: '1',
            ho: 'B2',
            lFloor: '지하',
            lHo: '비02',
            numerator: '29.55',
        },
    ].map((unit, index) => ({
        ...unit,
        propertyId: `PU-2188-${unit.ho}`,
        buildingUnitId: `BU-2188-${unit.ho}`,
        dbFloor: index === 0 ? '1' : null,
    }));
    const candidates = linkedCandidates(
        units.map((unit) => ({
            ...unit,
            floor: unit.dbFloor,
        }))
    );
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: units.map((unit) => ({
                    pnu: ANCHOR,
                    agbldgSn: 'MIA7-2188',
                    buldNm: 'MIA7-2188',
                    // standard FH의 A↔missing과 bridge의 A↔A 혼합 parity.
                    buldDongNm:
                        unit.ho === '201' ? undefined : 'A',
                    buldFloorNm: unit.lFloor,
                    buldHoNm: unit.lHo,
                    buldRoomNm: unit.lHo,
                    ldaQotaRate: `${unit.numerator}/221`,
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                })),
                exposRows: units.map((unit) => ({
                    mgmBldrgstPk: PK,
                    dongNm: 'A',
                    flrGbCd: unit.ho.startsWith('B')
                        ? '10'
                        : '20',
                    flrNo: Number(unit.floor),
                    hoNm: unit.ho.startsWith('B')
                        ? `B0${unit.ho.slice(1)}`
                        : unit.ho,
                })),
            },
        ],
        ...candidates,
        scopeLadfrlAreas: [{ pnu: ANCHOR, area: '221' }],
        scopeLadfrlTotal: '221',
    });

    assert.equal(result.blocking, false);
    assert.equal(result.items.length, 6);
    const gate = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'EXPOS_PROVIDER_SHAPE_BRIDGE_GATE'
    ) as { allowed: boolean; bridgeRequiredCount: number };
    assert.equal(gate.allowed, true);
    assert.equal(gate.bridgeRequiredCount, 2);
    const floorHoGate = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'EXPOS_FLOOR_HO_FALLBACK_GATE'
    ) as { allowed: boolean };
    assert.equal(
        floorHoGate.allowed,
        false,
        'mixed dong은 legacy FH gate가 아니라 provider scope parity gate로 증명한다'
    );
    const numeratorByProperty = new Map(
        result.items.map((item) => [
            item.propertyUnitId,
            item.components[0].ratioNumerator,
        ])
    );
    assert.equal(numeratorByProperty.get('PU-2188-B1'), '20.18');
    assert.equal(numeratorByProperty.get('PU-2188-B2'), '29.55');
});

test('791-2188 provider bridge는 1~3자리 positive 지하 suffix의 0-padding만 제거한다', () => {
    const expos = (hoNm: string) =>
        providerUnitShapeWitness('EXPOS_UNIT', {
            flrGbCd: '10',
            flrNo: 1,
            hoNm,
        });
    const ldareg = (buldHoNm: string) =>
        providerUnitShapeWitness('LDAREG_UNIT', {
            buldFloorNm: '지하',
            buldHoNm,
        });

    const paddedExpos = expos('B01');
    const paddedLdareg = ldareg('비01');
    assert.deepEqual(paddedExpos, {
        kind: 'PROVIDER_BASEMENT_B_HO',
        token: 'BASEMENT_B_HO:1',
        canonicalFloor: '1',
        canonicalHo: 'B1',
    });
    assert.deepEqual(paddedLdareg, paddedExpos);
    assert.deepEqual(expos('B1'), paddedExpos);
    assert.deepEqual(ldareg('비1'), paddedLdareg);
    assert.notEqual(expos('B01')?.token, ldareg('비02')?.token);

    for (const invalidExpos of [
        'B000',
        'B0001',
        'b01',
        ' B01 ',
        ' B1 ',
        'Ｂ０１',
        'B 01',
        'B01층',
    ]) {
        assert.equal(expos(invalidExpos), null, invalidExpos);
    }
    for (const invalidLdareg of [
        '비000',
        '비0001',
        ' 비01 ',
        ' 비1 ',
        '비０１',
        '비 01',
        '비01층',
    ]) {
        assert.equal(ldareg(invalidLdareg), null, invalidLdareg);
    }
    assert.equal(
        providerUnitShapeWitness('EXPOS_UNIT', {
            flrGbCd: ' 10',
            flrNo: 1,
            hoNm: 'B01',
        }),
        null
    );
    assert.equal(
        providerUnitShapeWitness('EXPOS_UNIT', {
            flrGbCd: '10',
            flrNo: '１',
            hoNm: 'B01',
        }),
        null
    );
    assert.equal(
        providerUnitShapeWitness('LDAREG_UNIT', {
            buldFloorNm: ' 지하 ',
            buldHoNm: '비01',
        }),
        null
    );
});

test('미아7 실측: LDAREG 지하1층 층·호 표기 변형이 EXPOS B0N과 같은 witness로 접힌다', () => {
    // EXPOS는 지하 호를 flrGbCd=10 / flrNo=1 / hoNm=B0N 한 가지로만 주는데,
    // LDAREG는 같은 호를 지번마다 다르게 준다. 2026-07-30 GIS 인스펙터로 원문 확인:
    //   791-2155 · 2267  →  buldFloorNm '지',    buldHoNm '비01'
    //   791-2282         →  buldFloorNm '지',    buldHoNm 'B01'
    //   791-2320         →  buldFloorNm '지1',   buldHoNm '지하01' / '지하02'
    //   791-2343         →  buldFloorNm '지하1', buldHoNm '비01'
    const expos = providerUnitShapeWitness('EXPOS_UNIT', {
        flrGbCd: '10',
        flrNo: 1,
        hoNm: 'B01',
    });
    assert.deepEqual(expos, {
        kind: 'PROVIDER_BASEMENT_B_HO',
        token: 'BASEMENT_B_HO:1',
        canonicalFloor: '1',
        canonicalHo: 'B1',
    });

    for (const buldFloorNm of ['지하', '지', '지층', '지1', '지하1']) {
        for (const buldHoNm of [
            '비01',
            '비1',
            'B01',
            'B1',
            '지하01',
            '지하1',
        ]) {
            assert.deepEqual(
                providerUnitShapeWitness('LDAREG_UNIT', {
                    buldFloorNm,
                    buldHoNm,
                }),
                expos,
                `${buldFloorNm}/${buldHoNm}`
            );
        }
    }

    // suffix가 다르면 같은 호가 아니다.
    assert.notEqual(
        providerUnitShapeWitness('LDAREG_UNIT', {
            buldFloorNm: '지',
            buldHoNm: 'B02',
        })?.token,
        expos?.token
    );
});

test('LDAREG 지하 witness는 지하1층 exact 표기와 positive suffix만 인정한다', () => {
    for (const [buldFloorNm, buldHoNm] of [
        // 지하 2층 이하는 EXPOS 지하1층 witness와 대응시키지 않는다.
        ['지하2', '비01'],
        ['지2', 'B01'],
        ['B2', 'B01'],
        // 실측되지 않은 층 표기는 계속 인정하지 않는다. 2026-07-30 인스펙터로
        // 확인된 것은 '지' / '지1' / '지하1' 세 가지뿐이다.
        ['지하01', 'B01'],
        ['지01', 'B01'],
        ['B1', 'B01'],
        ['B01', '비01'],
        // 원문 공백·전각·접미사는 접지 않는다.
        [' 지 ', '비01'],
        ['지 하', '비01'],
        ['지', ' 비01 '],
        ['지', '비 01'],
        ['지', '비01층'],
        ['지', '비０１'],
        ['지', ' 지하01 '],
        ['지', '지하 01'],
        ['지', '지하01층'],
        // suffix 0 및 4자리 이상은 거부한다.
        ['지', '비000'],
        ['지', 'B0001'],
        ['지', '지하000'],
        ['지', '지하0001'],
        // 지하가 아닌 층 표기는 이 경로로 들어오지 않는다.
        ['1', 'B01'],
        ['지상1', 'B01'],
    ] as const) {
        assert.equal(
            providerUnitShapeWitness('LDAREG_UNIT', {
                buldFloorNm,
                buldHoNm,
            }),
            null,
            `${buldFloorNm}/${buldHoNm}`
        );
    }

    // 기존 791-2191 지층 경로(지/0000)는 그대로 유지된다.
    assert.deepEqual(
        providerUnitShapeWitness('LDAREG_UNIT', {
            buldFloorNm: '지',
            buldHoNm: '0000',
        }),
        {
            kind: 'FLOOR_AS_UNIT_BASEMENT',
            token: 'FLOOR_AS_UNIT_BASEMENT:1',
            canonicalFloor: '1',
            canonicalHo: '지층',
        }
    );
});

test('runtime 791-2191: LDAREG 숫자/0000 및 지/0000을 EXPOS N층·지층 exact tuple로 바꿔 기존 building link를 해소한다', () => {
    const units = [
        {
            floor: '1',
            ho: '지층',
            lFloor: '지',
            numerator: '33.67',
            dbFloor: null,
        },
        {
            floor: '1',
            ho: '1층',
            lFloor: '1',
            numerator: '33.67',
            dbFloor: '1',
        },
        {
            floor: '2',
            ho: '2층',
            lFloor: '2',
            numerator: '33.67',
            dbFloor: null,
        },
    ].map((unit) => ({
        ...unit,
        propertyId: `PU-2191-${unit.ho}`,
        buildingUnitId: `BU-2191-${unit.ho}`,
    }));
    const candidates = linkedCandidates(
        units.map((unit) => ({
            ...unit,
            floor: unit.dbFloor,
        }))
    );
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: units.map((unit) => ({
                    pnu: ANCHOR,
                    agbldgSn: 'MIA7-2191',
                    buldNm: 'MIA7-2191',
                    buldFloorNm: unit.lFloor,
                    buldHoNm: '0000',
                    buldRoomNm: '0000',
                    ldaQotaRate: `${unit.numerator}/101`,
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                })),
                exposRows: units.map((unit) => ({
                    mgmBldrgstPk: PK,
                    flrGbCd:
                        unit.ho === '지층' ? '10' : '20',
                    flrNo: Number(unit.floor),
                    hoNm: unit.ho,
                })),
            },
        ],
        ...candidates,
        scopeLadfrlAreas: [{ pnu: ANCHOR, area: '101' }],
        scopeLadfrlTotal: '101',
    });

    assert.equal(result.blocking, false);
    assert.equal(result.items.length, 3);
    assert.deepEqual(
        result.items.map((item) => item.propertyUnitId).sort(),
        units.map((unit) => unit.propertyId).sort()
    );
    const gate = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'EXPOS_PROVIDER_SHAPE_BRIDGE_GATE'
    ) as { allowed: boolean; bridgeRequiredCount: number };
    assert.equal(gate.allowed, true);
    assert.equal(gate.bridgeRequiredCount, 3);
});

for (const invalidCase of [
    {
        name: '2172 LDAREG에 층 접미사가 붙음',
        denominator: '121',
        ldareg: {
            agbldgSn: 'NEAR-MISS',
            buldNm: 'NEAR-MISS',
            buldFloorNm: '지상2층',
            buldHoNm: '201',
            ldaQotaRate: '20/121',
            clsSeCode: '0',
        },
        expos: {
            flrGbCd: '20',
            flrNo: 2,
            hoNm: '201',
        },
        dbHo: '201',
    },
    {
        name: '2188 B0n과 비0n positive suffix가 다름',
        denominator: '221',
        ldareg: {
            agbldgSn: 'NEAR-MISS',
            buldNm: 'NEAR-MISS',
            buldFloorNm: '지하',
            buldHoNm: '비02',
            ldaQotaRate: '20/221',
            clsSeCode: '0',
        },
        expos: {
            flrGbCd: '10',
            flrNo: 1,
            hoNm: 'B01',
        },
        dbHo: 'B1',
    },
    {
        name: '2188 EXPOS B2 floor가 실측 exact 1이 아님',
        denominator: '221',
        ldareg: {
            agbldgSn: 'NEAR-MISS',
            buldNm: 'NEAR-MISS',
            buldFloorNm: '지하',
            buldHoNm: '비02',
            ldaQotaRate: '20/221',
            clsSeCode: '0',
        },
        expos: {
            flrGbCd: '10',
            flrNo: 2,
            hoNm: 'B02',
        },
        dbHo: 'B2',
    },
    {
        name: '2191 LDAREG basement floor가 exact 지가 아님',
        denominator: '101',
        ldareg: {
            agbldgSn: 'NEAR-MISS',
            buldNm: 'NEAR-MISS',
            buldFloorNm: '지층',
            buldHoNm: '0000',
            ldaQotaRate: '20/101',
            clsSeCode: '0',
        },
        expos: {
            flrGbCd: '10',
            flrNo: 1,
            hoNm: '지층',
        },
        dbHo: '지층',
    },
] as const) {
    test(`runtime provider bridge는 ${invalidCase.name}이면 fail-closed한다`, () => {
        const candidates = linkedCandidates([
            {
                floor: null,
                ho: invalidCase.dbHo,
                propertyId: 'PU-NEAR-MISS',
                buildingUnitId: 'BU-NEAR-MISS',
            },
        ]);
        const result = assemble({
            unionId: 'union-1',
            scannedPnus: [ANCHOR],
            rootIdentity: PK,
            perPnu: [
                {
                    pnu: ANCHOR,
                    ldaregRows: [
                        { pnu: ANCHOR, ...invalidCase.ldareg },
                    ],
                    exposRows: [
                        {
                            mgmBldrgstPk: PK,
                            ...invalidCase.expos,
                        },
                    ],
                },
            ],
            ...candidates,
            scopeLadfrlAreas: [
                {
                    pnu: ANCHOR,
                    area: invalidCase.denominator,
                },
            ],
            scopeLadfrlTotal: invalidCase.denominator,
        });
        assert.equal(result.blocking, true);
        assert.equal(result.items.length, 0);
        assert.ok(
            result.issues.some(
                (issue) =>
                    issue.code === 'PROPERTY_UNIT_NOT_FOUND'
            )
        );
    });
}

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
        result.replicationEvidence?.rowMultisetDigest,
        '1e525d17e850e58dae3f9ae6eaf3c42bb6e6b581c94441dcdd72a448b35d65cc',
        'provider-null 2280 legacy v2 replica digest는 byte-stable해야 한다'
    );
    assert.equal(
        result.issues.filter(
            (issue) => issue.code === 'RATIO_PARSE_FAILED'
        ).length,
        0
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

test('DEV opt-in active-PNU replica는 1→3 동일 호실 property를 PNU별 exact match하고 각 numerator를 한 logical identity로 보존한다', () => {
    const pnuB = '1168010100107360025';
    const pnuC = '1168010100107360026';
    const targetPnus = [ANCHOR, pnuB, pnuC];
    const units = [
        { floor: '1', ho: '101', numerator: '10' },
        { floor: '2', ho: '201', numerator: '20' },
    ];
    const perPnu = targetPnus.map((pnu) => ({
        pnu,
        ldaregRows: units.map((unit, index) => ({
            pnu,
            agbldgSn: String(index + 1),
            buldFloorNm: unit.floor,
            buldHoNm: unit.ho,
            ldaQotaRate: `${unit.numerator}/150`,
            clsSeCode: '0',
        })),
        exposRows: units.map((unit) => ({
            pnu,
            mgmBldrgstPk: PK,
            flrNoNm: unit.floor,
            hoNm: unit.ho,
        })),
    }));
    const propertyUnits = targetPnus.flatMap((pnu, pnuIndex) =>
        units.map((unit, unitIndex) => ({
            id: `property-${pnuIndex}-${unitIndex}`,
            unionId: 'union-1',
            buildingUnitId: `building-unit-${pnuIndex}-${unitIndex}`,
            pnu,
            isDeleted: false,
            dong: null,
            ho: unit.ho,
        }))
    );
    const buildingUnits = targetPnus.flatMap((_pnu, pnuIndex) =>
        units.map((unit, unitIndex) => ({
            id: `building-unit-${pnuIndex}-${unitIndex}`,
            floor: unit.floor,
            ho: unit.ho,
        }))
    );
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: targetPnus,
        rootIdentity: PK,
        perPnu,
        buildingUnits,
        propertyUnits,
        scopeLadfrlAreas: targetPnus.map((pnu) => ({
            pnu,
            area: '50',
        })),
        scopeLadfrlTotal: '150',
        officialPropertyMembershipMode:
            'PER_ACTIVE_PNU_REPLICA',
    });

    assert.equal(result.blocking, false);
    assert.equal(result.items.length, 6);
    assert.deepEqual(
        result.matchedPropertyUnitIds.slice().sort(),
        propertyUnits.map((property) => property.id).sort()
    );
    for (const item of result.items) {
        assert.deepEqual(item.expectedTargetPnus, targetPnus);
        assert.equal(item.components.length, 3);
        assert.equal(
            new Set(
                item.components.map(
                    (component) => component.sourceIdentity
                )
            ).size,
            1
        );
        assert.equal(
            new Set(
                item.components.map(
                    (component) => component.ratioNumerator
                )
            ).size,
            1,
            '동일 numerator를 PNU 개수만큼 별도 권리로 합산하지 않는다'
        );
        assert.deepEqual(
            item.components.map(
                (component) => component.targetPnu
            ),
            targetPnus
        );
        const expectedNumerator = item.components[0].ratioNumerator;
        assert.equal(
            sumCurrentNumerators(item),
            expectedNumerator,
            `1→3 replica projection은 ${expectedNumerator}을 3배 합산하지 않는다`
        );
    }
});

test('DEV active-PNU replica는 한 PNU의 호실 누락·중복 room ambiguity를 whole-component blocking한다', () => {
    const pnuB = '1168010100107360025';
    const targetPnus = [ANCHOR, pnuB];
    const perPnu = targetPnus.map((pnu) => ({
        pnu,
        ldaregRows: [
            {
                pnu,
                agbldgSn: '1',
                buldFloorNm: '1',
                buldHoNm: '101',
                ldaQotaRate: '10/100',
                clsSeCode: '0',
            },
            {
                pnu,
                agbldgSn: '2',
                buldFloorNm: '2',
                buldHoNm: '201',
                ldaQotaRate: '20/100',
                clsSeCode: '0',
            },
        ],
        exposRows: [
            {
                pnu,
                mgmBldrgstPk: PK,
                flrNoNm: '1',
                hoNm: '101',
            },
            {
                pnu,
                mgmBldrgstPk: PK,
                flrNoNm: '2',
                hoNm: '201',
            },
        ],
    }));
    const baseProperties: PropertyUnitCandidate[] = [
        {
            id: 'a-101',
            unionId: 'union-1',
            buildingUnitId: null,
            pnu: ANCHOR,
            isDeleted: false,
            ho: '101',
        },
        {
            id: 'a-201',
            unionId: 'union-1',
            buildingUnitId: null,
            pnu: ANCHOR,
            isDeleted: false,
            ho: '201',
        },
        {
            id: 'b-101',
            unionId: 'union-1',
            buildingUnitId: null,
            pnu: pnuB,
            isDeleted: false,
            ho: '101',
        },
    ];
    const run = (propertyUnits: PropertyUnitCandidate[]) =>
        assemble({
            unionId: 'union-1',
            scannedPnus: targetPnus,
            rootIdentity: PK,
            perPnu,
            buildingUnits: [],
            propertyUnits,
            scopeLadfrlAreas: targetPnus.map((pnu) => ({
                pnu,
                area: '50',
            })),
            scopeLadfrlTotal: '100',
            officialPropertyMembershipMode:
                'PER_ACTIVE_PNU_REPLICA',
        });

    const missing = run(baseProperties);
    assert.equal(missing.blocking, true);
    assert.equal(missing.items.length, 0);

    const ambiguous = run([
        ...baseProperties,
        {
            id: 'b-101-duplicate',
            unionId: 'union-1',
            buildingUnitId: null,
            pnu: pnuB,
            isDeleted: false,
            ho: '101',
        },
    ]);
    assert.equal(ambiguous.blocking, true);
    assert.equal(ambiguous.items.length, 0);
});

test('DEV query-only attached + SINGLE cohort도 unmatched active property를 whole-component blocking한다', () => {
    const queryOnlyAttached = '1168010100107360025';
    const targetPnus = [ANCHOR, queryOnlyAttached];
    const perPnu = targetPnus.map((pnu) => ({
        pnu,
        ldaregRows: [
            {
                pnu,
                agbldgSn: '1',
                buldFloorNm: '3',
                buldHoNm: '301',
                ldaQotaRate: '10/100',
                clsSeCode: '0',
            },
        ],
        exposRows:
            pnu === ANCHOR
                ? [
                      {
                          pnu,
                          mgmBldrgstPk: PK,
                          flrNoNm: '3',
                          hoNm: '301',
                      },
                  ]
                : [],
    }));
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: targetPnus,
        rootIdentity: PK,
        perPnu,
        buildingUnits: [],
        propertyUnits: [
            {
                id: 'matched-301',
                unionId: 'union-1',
                buildingUnitId: null,
                pnu: ANCHOR,
                isDeleted: false,
                ho: '301',
            },
            {
                id: 'unmatched-401',
                unionId: 'union-1',
                buildingUnitId: null,
                pnu: ANCHOR,
                isDeleted: false,
                ho: '401',
            },
        ],
        scopeLadfrlAreas: [
            { pnu: ANCHOR, area: '50' },
            { pnu: queryOnlyAttached, area: '50' },
        ],
        scopeLadfrlTotal: '100',
        officialPropertyMembershipMode: 'SINGLE_LOGICAL_SET',
    });

    assert.equal(result.blocking, true);
    assert.ok(
        result.issues.some(
            (issue) => issue.code === 'PROPERTY_UNIT_NOT_FOUND'
        )
    );
});

function buildOfficialCurrentSupersetInput(options?: {
    enableSupersetMode?: boolean;
    additionalPropertyHos?: string[];
    mutateScan?: (
        scan: LdaregBranchInput['perPnu'][number]
    ) => void;
}): LdaregBranchInput {
    const officialRooms = Array.from(
        { length: 11 },
        (_, index) => {
            const floor = String(
                Math.floor(index / 3) + 1
            );
            return {
                floor,
                ho: `${floor}${String(
                    (index % 3) + 1
                ).padStart(2, '0')}`,
            };
        }
    );
    const scan: LdaregBranchInput['perPnu'][number] = {
        pnu: ANCHOR,
        ldaregRows: officialRooms.map((room, index) => ({
            pnu: ANCHOR,
            agbldgSn: String(index + 1),
            buldNm: '공식호실11개',
            buldDongNm: '0000',
            buldFloorNm: room.floor,
            buldHoNm: room.ho,
            buldRoomNm: room.ho,
            ldaQotaRate: `${index + 1}/73`,
            clsSeCode: '0',
            clsSeCodeNm: '현재',
        })),
        exposRows: officialRooms.map((room) => ({
            pnu: ANCHOR,
            mgmBldrgstPk: PK,
            dongNm: '',
            flrNoNm: room.floor,
            hoNm: room.ho,
        })),
    };
    options?.mutateScan?.(scan);
    const activePropertyHos = [
        ...officialRooms
            .slice(0, 9)
            .map((room) => room.ho),
        ...(options?.additionalPropertyHos ?? []),
    ];
    return {
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [scan],
        scopeLadfrlAreas: [
            { pnu: ANCHOR, area: '73' },
        ],
        scopeLadfrlTotal: '73',
        canonicalSourcePnu: ANCHOR,
        buildingUnits: [],
        propertyUnits: activePropertyHos.map(
            (ho, index) => ({
                id: `superset-property-${index}`,
                unionId: 'union-1',
                buildingUnitId: null,
                pnu: ANCHOR,
                isDeleted: false,
                dong: null,
                ho,
            })
        ),
        officialPropertyMembershipMode:
            'SINGLE_LOGICAL_SET',
        ...(options?.enableSupersetMode
            ? {
                  officialCurrentSupersetMode:
                      LDAREG_OFFICIAL_CURRENT_SUPERSET_MODE,
              }
            : {}),
    };
}

test('DEV explicit opt-in만 공식 CURRENT 11개/활성 DB 9개 superset을 전수 exact coverage 후 2개 제외한다', () => {
    const withoutOptIn = assembleLdaregApply(
        buildOfficialCurrentSupersetInput()
    );
    assert.equal(
        withoutOptIn.blocking,
        true,
        '일반/운영 경로는 같은 공식 superset을 계속 fail-closed한다'
    );
    assert.ok(
        withoutOptIn.issues.some(
            (issue) =>
                issue.code === 'PROPERTY_UNIT_NOT_FOUND'
        )
    );

    const result = assembleLdaregApply(
        buildOfficialCurrentSupersetInput({
            enableSupersetMode: true,
        })
    );
    assert.equal(result.blocking, false);
    assert.equal(result.items.length, 9);
    assert.equal(result.counts.landRegistryRows, 11);
    assert.equal(
        result.counts.parsedRows,
        9,
        '적용 component로 확정된 CURRENT만 parsedRows에 센다'
    );
    assert.deepEqual(result.issues, []);
    assert.deepEqual(
        result.matchedPropertyUnitIds.slice().sort(),
        Array.from(
            { length: 9 },
            (_, index) => `superset-property-${index}`
        ).sort()
    );
    const gate = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'OFFICIAL_CURRENT_SUPERSET_GATE'
    ) as {
        mode: string;
        activePropertyCount: number;
        matchedCurrentPropertyCount: number;
        ignoredCurrentRowCount: number;
        ignoredCurrentSourceIdentities: string[];
    };
    assert.equal(
        gate.mode,
        LDAREG_OFFICIAL_CURRENT_SUPERSET_MODE
    );
    assert.equal(gate.activePropertyCount, 9);
    assert.equal(gate.matchedCurrentPropertyCount, 9);
    assert.equal(gate.ignoredCurrentRowCount, 2);
    assert.equal(
        gate.ignoredCurrentSourceIdentities.length,
        2
    );
    assert.ok(
        gate.ignoredCurrentSourceIdentities.every(
            (identity) =>
                /^(?:primary|fallback):v2:[0-9a-f]{64}$/.test(
                    identity
                )
        )
    );
});

const unsafeOfficialSupersetVariants: Array<{
    name: string;
    expectedIssue:
        | 'RATIO_PARSE_FAILED'
        | 'PROPERTY_UNIT_NOT_FOUND'
        | 'PROPERTY_UNIT_AMBIGUOUS'
        | 'LDAREG_IDENTITY_CONFLICT';
    mutateScan: NonNullable<
        Parameters<
            typeof buildOfficialCurrentSupersetInput
        >[0]
    >['mutateScan'];
}> = [
    {
        name: '추가 행 ratio invalid',
        expectedIssue: 'RATIO_PARSE_FAILED',
        mutateScan: (scan) => {
            scan.ldaregRows[10] = {
                ...scan.ldaregRows[10],
                ldaQotaRate: 'invalid',
            };
        },
    },
    {
        name: '추가 행 CLOSED',
        expectedIssue: 'PROPERTY_UNIT_NOT_FOUND',
        mutateScan: (scan) => {
            scan.ldaregRows[10] = {
                ...scan.ldaregRows[10],
                clsSeCode: '2',
                clsSeCodeNm: '말소',
            };
        },
    },
    {
        name: '추가 행 EXPOS 미상관',
        expectedIssue: 'PROPERTY_UNIT_NOT_FOUND',
        mutateScan: (scan) => {
            scan.exposRows = scan.exposRows.slice(0, -1);
        },
    },
    {
        name: '추가 행 EXPOS ambiguity',
        expectedIssue: 'PROPERTY_UNIT_AMBIGUOUS',
        mutateScan: (scan) => {
            scan.exposRows.push({
                ...scan.exposRows[10],
            });
        },
    },
    {
        name: '추가 CURRENT logical row 중복',
        expectedIssue: 'LDAREG_IDENTITY_CONFLICT',
        mutateScan: (scan) => {
            scan.ldaregRows.push({
                ...scan.ldaregRows[10],
            });
        },
    },
];

for (const variant of unsafeOfficialSupersetVariants) {
    test(`DEV 공식 superset도 ${variant.name}이면 whole-component blocking한다`, () => {
        const result = assembleLdaregApply(
            buildOfficialCurrentSupersetInput({
                enableSupersetMode: true,
                mutateScan: variant.mutateScan,
            })
        );
        assert.equal(result.blocking, true);
        assert.ok(
            result.issues.some(
                (issue) =>
                    issue.code === variant.expectedIssue
            )
        );
    });
}

test('DEV 공식 superset도 활성 DB 물건지 CURRENT coverage가 하나라도 빠지면 blocking한다', () => {
    const result = assembleLdaregApply(
        buildOfficialCurrentSupersetInput({
            enableSupersetMode: true,
            additionalPropertyHos: ['999'],
        })
    );
    assert.equal(result.blocking, true);
    assert.ok(
        result.issues.some(
            (issue) =>
                issue.code === 'PROPERTY_UNIT_NOT_FOUND'
        )
    );
    const gate = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'OFFICIAL_CURRENT_SUPERSET_GATE'
    ) as {
        activePropertyCount: number;
        matchedCurrentPropertyCount: number;
        ignoredCurrentRowCount: number;
    };
    assert.deepEqual(gate, {
        ...gate,
        activePropertyCount: 10,
        matchedCurrentPropertyCount: 9,
        ignoredCurrentRowCount: 2,
    });
});

test('DEV 공식 superset opt-in은 LDAREG COMPLETE_ZERO를 활성 DB CURRENT coverage로 인정하지 않는다', () => {
    const result = assembleLdaregApply(
        buildOfficialCurrentSupersetInput({
            enableSupersetMode: true,
            mutateScan: (scan) => {
                scan.ldaregRows = [];
            },
        })
    );
    assert.equal(result.blocking, true);
    assert.ok(
        result.issues.some(
            (issue) =>
                issue.code === 'PROPERTY_UNIT_NOT_FOUND'
        )
    );
});

test('DEV active-PNU replica도 각 PNU의 활성 DB cohort 전수를 exact match한 뒤 공식 CURRENT extra만 1개 제외한다', () => {
    const attachedPnu = '1168010100107360025';
    const targetPnus = [ANCHOR, attachedPnu];
    const officialRooms = [
        { floor: '1', ho: '101', numerator: '10' },
        { floor: '2', ho: '201', numerator: '20' },
        { floor: '3', ho: '301', numerator: '30' },
    ];
    const propertyUnits = targetPnus.flatMap(
        (pnu, pnuIndex) =>
            officialRooms.slice(0, 2).map((room) => ({
                id: `replica-superset-${pnuIndex}-${room.ho}`,
                unionId: 'union-1',
                buildingUnitId: null,
                pnu,
                isDeleted: false,
                dong: null,
                ho: room.ho,
            }))
    );
    const result = assembleLdaregApply({
        unionId: 'union-1',
        scannedPnus: targetPnus,
        rootIdentity: PK,
        perPnu: targetPnus.map((pnu) => ({
            pnu,
            ldaregRows: officialRooms.map(
                (room, index) => ({
                    pnu,
                    agbldgSn: String(index + 1),
                    buldNm: '대표부지번반복',
                    buldFloorNm: room.floor,
                    buldHoNm: room.ho,
                    buldRoomNm: room.ho,
                    ldaQotaRate: `${room.numerator}/100`,
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                })
            ),
            exposRows: officialRooms.map((room) => ({
                pnu,
                mgmBldrgstPk: PK,
                flrNoNm: room.floor,
                hoNm: room.ho,
            })),
        })),
        scopeLadfrlAreas: targetPnus.map((pnu) => ({
            pnu,
            area: '50',
        })),
        scopeLadfrlTotal: '100',
        canonicalSourcePnu: ANCHOR,
        buildingUnits: [],
        propertyUnits,
        officialPropertyMembershipMode:
            'PER_ACTIVE_PNU_REPLICA',
        officialCurrentSupersetMode:
            LDAREG_OFFICIAL_CURRENT_SUPERSET_MODE,
    });
    assert.equal(result.blocking, false);
    assert.equal(result.items.length, 4);
    assert.deepEqual(
        result.matchedPropertyUnitIds.slice().sort(),
        propertyUnits
            .map((propertyUnit) => propertyUnit.id)
            .sort()
    );
    assert.ok(
        result.items.every(
            (item) =>
                item.components.length === 2 &&
                item.components.every(
                    (component, index) =>
                        component.targetPnu ===
                        targetPnus[index]
                )
        )
    );
    const gate = result.componentMatchDigest.find(
        (entry) =>
            (entry as { kind?: string }).kind ===
            'OFFICIAL_CURRENT_SUPERSET_GATE'
    ) as {
        activePropertyCount: number;
        matchedCurrentPropertyCount: number;
        ignoredCurrentRowCount: number;
    };
    assert.deepEqual(gate, {
        ...gate,
        activePropertyCount: 4,
        matchedCurrentPropertyCount: 4,
        ignoredCurrentRowCount: 1,
    });
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
                dong: '청성주택6차',
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

for (const [canonicalFloor, attachedFloor] of [
    ['지상2', '지상02'],
    ['지상02', '지상2'],
] as const) {
    test(`LDAREG replica는 provider witness recognized 상태 변조를 양방향 차단한다 (${canonicalFloor}↔${attachedFloor})`, () => {
        const sibling = '1168010100107360025';
        const row = (pnu: string, floor: string) => ({
            pnu,
            agbldgSn: 'MIA7-REPLICA-SHAPE',
            buldNm: 'MIA7-REPLICA-SHAPE',
            buldFloorNm: floor,
            buldHoNm: '201',
            buldRoomNm: '201',
            ldaQotaRate: '20/121',
            clsSeCode: '0',
            clsSeCodeNm: '현재',
        });
        const replication = validateLdaregReplication(
            [ANCHOR, sibling],
            [
                {
                    pnu: ANCHOR,
                    ldaregRows: [
                        row(ANCHOR, canonicalFloor),
                    ],
                    exposRows: [],
                },
                {
                    pnu: sibling,
                    ldaregRows: [
                        row(sibling, attachedFloor),
                    ],
                    exposRows: [],
                },
            ],
            ANCHOR
        );
        assert.equal(replication.ok, false);

        const result = assemble({
            unionId: 'union-1',
            scannedPnus: [ANCHOR, sibling],
            rootIdentity: PK,
            perPnu: [
                {
                    pnu: ANCHOR,
                    ldaregRows: [
                        row(ANCHOR, canonicalFloor),
                    ],
                    exposRows: [
                        {
                            mgmBldrgstPk: PK,
                            flrGbCd: '20',
                            flrNo: 2,
                            hoNm: '201',
                        },
                    ],
                },
                {
                    pnu: sibling,
                    ldaregRows: [
                        row(sibling, attachedFloor),
                    ],
                    exposRows: [],
                },
            ],
            ...linkedCandidates([
                {
                    floor: null,
                    ho: '201',
                    propertyId: 'PU-REPLICA-SHAPE-201',
                    buildingUnitId:
                        'BU-REPLICA-SHAPE-201',
                },
            ]),
            scopeLadfrlAreas: [
                { pnu: ANCHOR, area: '60' },
                { pnu: sibling, area: '61' },
            ],
            scopeLadfrlTotal: '121',
        });
        assert.equal(result.replicationEvidence, null);
        assert.equal(result.blocking, true);
        assert.equal(result.items.length, 0);
    });
}

for (const variant of [
    {
        name: 'attached standard v2 row의 NFKC building name',
        mutate: (rows: Array<Record<string, unknown>>) => {
            rows[0].buldNm = 'Ａ';
        },
    },
    {
        name: 'attached placeholder의 numeric aggregate serial',
        mutate: (rows: Array<Record<string, unknown>>) => {
            rows[2].agbldgSn = 1;
        },
    },
] as const) {
    test(`mixed standard+bridge replica는 ${variant.name}도 all-row proof에서 차단한다`, () => {
        const sibling = '1168010100107360025';
        const rows = (pnu: string) =>
            [
                {
                    pnu,
                    agbldgSn: '1',
                    buldNm: 'A',
                    buldFloorNm: '1',
                    buldHoNm: '101',
                    buldRoomNm: '101',
                    ldaQotaRate: '60/100',
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                },
                {
                    pnu,
                    agbldgSn: '1',
                    buldNm: 'A',
                    buldFloorNm: '지하',
                    buldHoNm: '비1',
                    buldRoomNm: '비1',
                    ldaQotaRate: '40/100',
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                },
                {
                    pnu,
                    agbldgSn: '1',
                    buldNm: 'A',
                    buldDongNm: '0000',
                    buldFloorNm: '0000',
                    buldHoNm: '0000',
                    buldRoomNm: '0000',
                    ldaQotaRate: '',
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                },
            ] as Array<Record<string, unknown>>;
        const baseRows = rows(ANCHOR);
        const attachedRows = rows(sibling);
        variant.mutate(attachedRows);
        const result = assemble({
            unionId: 'union-1',
            scannedPnus: [ANCHOR, sibling],
            rootIdentity: PK,
            perPnu: [
                {
                    pnu: ANCHOR,
                    ldaregRows:
                        baseRows as LdaregBranchInput['perPnu'][number]['ldaregRows'],
                    exposRows: [
                        {
                            mgmBldrgstPk: PK,
                            flrGbCd: '20',
                            flrNo: 1,
                            hoNm: '101',
                        },
                        {
                            mgmBldrgstPk: PK,
                            flrGbCd: '10',
                            flrNo: 1,
                            hoNm: 'B1',
                        },
                    ],
                },
                {
                    pnu: sibling,
                    ldaregRows:
                        attachedRows as LdaregBranchInput['perPnu'][number]['ldaregRows'],
                    exposRows: [],
                },
            ],
            ...linkedCandidates([
                {
                    floor: '1',
                    ho: '101',
                    propertyId: 'PU-MIXED-PROOF-101',
                    buildingUnitId: 'BU-MIXED-PROOF-101',
                },
                {
                    floor: null,
                    ho: 'B1',
                    propertyId: 'PU-MIXED-PROOF-B1',
                    buildingUnitId: 'BU-MIXED-PROOF-B1',
                },
            ]),
            scopeLadfrlAreas: [
                { pnu: ANCHOR, area: '60' },
                { pnu: sibling, area: '40' },
            ],
            scopeLadfrlTotal: '100',
        });
        assert.equal(result.replicationEvidence, null);
        assert.equal(result.blocking, true);
        assert.equal(result.items.length, 0);
    });
}

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

test('DEV official component만 base EXPOS zero + attached nonzero aggregate를 허용하고 all-zero는 차단한다', () => {
    const attached = '1168010100107360025';
    const attachedOnly = [
        {
            pnu: ANCHOR,
            ldaregRows: [],
            exposRows: [],
        },
        {
            pnu: attached,
            ldaregRows: [],
            exposRows: [
                {
                    pnu: attached,
                    mgmBldrgstPk: PK,
                    flrNoNm: '3',
                    hoNm: '301',
                },
            ],
        },
    ];
    assert.equal(
        selectCanonicalExposSourcePnu(
            [ANCHOR],
            attachedOnly,
            [PK]
        ),
        null,
        'normal/prod 계약은 base EXPOS zero를 계속 차단한다'
    );
    assert.equal(
        selectCanonicalExposSourcePnu(
            [ANCHOR],
            attachedOnly,
            [PK],
            {
                allowComponentWideAggregateForEmptyBase: true,
            }
        ),
        ANCHOR
    );
    assert.equal(
        selectCanonicalExposSourcePnu(
            [ANCHOR],
            attachedOnly.map((scan) => ({
                ...scan,
                exposRows: [],
            })),
            [PK],
            {
                allowComponentWideAggregateForEmptyBase: true,
            }
        ),
        null
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

test('clsSeCode 불명확(ambiguous)이면 LDAREG_IDENTITY_CONFLICT를 남기고 서비스 apply 전 전체 blocking한다', () => {
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
    assert.equal(result.items.length, 1, '진단용 매칭 결과는 보존한다');
    assert.equal(result.items[0].components[0].sourceState, 'CURRENT');
    assert.equal(
        result.blocking,
        true,
        'service의 blocking barrier가 apply items를 사용하기 전에 전체 scope를 차단한다'
    );
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
