import assert from 'node:assert/strict';
import test from 'node:test';
import * as matcherModule from '../src/services/land-area-sync/matcher';
import {
    matchLdaregUnit,
    type MatchInput,
    type ExposUnitCandidate,
    type BuildingUnitCandidate,
    type PropertyUnitCandidate,
} from '../src/services/land-area-sync/matcher';

const ROOT = 'ROOT-IDENTITY-1';
const PNU = '1111011700100010000';
const UNION = 'union-1';

function expos(over: Partial<ExposUnitCandidate> = {}): ExposUnitCandidate {
    return { dong: '101동', floor: '3층', ho: '302호', rootIdentity: ROOT, ...over };
}
function bu(over: Partial<BuildingUnitCandidate> = {}): BuildingUnitCandidate {
    return { id: 'BU-1', buildingId: 'B-1', dong: '101동', floor: '3층', ho: '302호', registryExternalId: null, ...over };
}
function pu(over: Partial<PropertyUnitCandidate> = {}): PropertyUnitCandidate {
    return { id: 'PU-1', unionId: UNION, buildingUnitId: 'BU-1', pnu: PNU, isDeleted: false, dong: '101동', ho: '302호', ...over };
}
function input(over: Partial<MatchInput> = {}): MatchInput {
    return {
        source: { targetPnu: PNU, dong: '101동', floor: '3층', ho: '302호', registryExternalId: null, expectedPnuScope: [PNU] },
        scopeRootIdentity: ROOT,
        exposUnits: [expos()],
        buildingUnits: [bu()],
        propertyUnits: [pu()],
        unionId: UNION,
        ...over,
    };
}

// ── happy paths ──────────────────────────────────────────────────────

test('registry_external_id exact → property_unit 1건 = MATCHED (§12.4 3→5)', () => {
    const d = matchLdaregUnit(
        input({
            source: { targetPnu: PNU, dong: '101동', floor: '3층', ho: '302호', registryExternalId: 'REG-9', expectedPnuScope: [PNU] },
            buildingUnits: [bu({ id: 'BU-9', registryExternalId: 'REG-9' })],
            propertyUnits: [pu({ id: 'PU-9', buildingUnitId: 'BU-9' })],
        })
    );
    assert.equal(d.kind, 'MATCHED');
    assert.equal(d.kind === 'MATCHED' && d.propertyUnitId, 'PU-9');
    assert.equal(d.kind === 'MATCHED' && d.buildingUnitRef, 'BU-9');
    assert.equal(d.kind === 'MATCHED' && d.via, 'PROPERTY_UNIT_BY_BU');
});

test('외부ID 없음 → normalized tuple로 building_unit 1건 → property 1건 = MATCHED (§12.4 4→5)', () => {
    const d = matchLdaregUnit(input());
    assert.equal(d.kind, 'MATCHED');
    assert.equal(d.kind === 'MATCHED' && d.propertyUnitId, 'PU-1');
    assert.equal(d.kind === 'MATCHED' && d.via, 'PROPERTY_UNIT_BY_BU');
});

test('legacy building_unit의 층 누락은 EXPOS 입증 뒤 호 exact 1건으로 기존 링크를 해소한다', () => {
    const d = matchLdaregUnit(
        input({
            source: {
                targetPnu: PNU,
                dong: null,
                floor: '5',
                ho: '501',
                registryExternalId: null,
                expectedPnuScope: [PNU],
            },
            exposUnits: [
                expos({
                    dong: null,
                    floor: '5',
                    ho: '501',
                }),
            ],
            buildingUnits: [
                bu({
                    id: 'BU-501',
                    dong: null,
                    floor: null,
                    ho: '501',
                }),
            ],
            propertyUnits: [
                pu({
                    id: 'PU-501',
                    buildingUnitId: 'BU-501',
                    dong: null,
                    ho: '501',
                }),
            ],
        })
    );

    assert.equal(d.kind, 'MATCHED');
    assert.equal(d.kind === 'MATCHED' && d.propertyUnitId, 'PU-501');
    assert.equal(d.kind === 'MATCHED' && d.buildingUnitRef, 'BU-501');
    assert.equal(d.kind === 'MATCHED' && d.via, 'PROPERTY_UNIT_BY_BU');
});

test('활성 물건지가 없는 exact shadow 행 대신 같은 건물의 활성-linked known-field 행을 사용한다', () => {
    const d = matchLdaregUnit(
        input({
            source: {
                targetPnu: PNU,
                dong: null,
                floor: '5',
                ho: '501',
                registryExternalId: null,
                expectedPnuScope: [PNU],
            },
            exposUnits: [
                expos({
                    dong: null,
                    floor: '5',
                    ho: '501',
                }),
            ],
            buildingUnits: [
                bu({
                    id: 'BU-SHADOW',
                    dong: null,
                    floor: '5',
                    ho: '501',
                }),
                bu({
                    id: 'BU-ACTIVE',
                    dong: null,
                    floor: null,
                    ho: '501',
                }),
            ],
            propertyUnits: [
                pu({
                    id: 'PU-ACTIVE',
                    buildingUnitId: 'BU-ACTIVE',
                    dong: null,
                    ho: '501',
                }),
            ],
        })
    );

    assert.equal(d.kind, 'MATCHED');
    assert.equal(
        d.kind === 'MATCHED' && d.propertyUnitId,
        'PU-ACTIVE'
    );
    assert.equal(
        d.kind === 'MATCHED' && d.buildingUnitRef,
        'BU-ACTIVE'
    );
});

test('legacy building_unit known-field 후보가 같은 호로 2건이면 추정하지 않고 충돌 처리한다', () => {
    const d = matchLdaregUnit(
        input({
            source: {
                targetPnu: PNU,
                dong: null,
                floor: '5',
                ho: '501',
                registryExternalId: null,
                expectedPnuScope: [PNU],
            },
            exposUnits: [
                expos({
                    dong: null,
                    floor: '5',
                    ho: '501',
                }),
            ],
            buildingUnits: [
                bu({
                    id: 'BU-501-A',
                    dong: null,
                    floor: null,
                    ho: '501',
                }),
                bu({
                    id: 'BU-501-B',
                    dong: null,
                    floor: null,
                    ho: '501',
                }),
            ],
        })
    );

    assert.equal(d.kind, 'NO_CHANGE');
    assert.equal(
        d.kind === 'NO_CHANGE' && d.stage,
        'NORMALIZED_KNOWN_FIELDS_BU'
    );
    assert.equal(
        d.kind === 'NO_CHANGE' && d.issue,
        'UNIT_NORMALIZATION_COLLISION'
    );
});

test('known-field fallback은 building 범위가 하나로 입증되지 않으면 사용하지 않는다', () => {
    const d = matchLdaregUnit(
        input({
            source: {
                targetPnu: PNU,
                dong: null,
                floor: '5',
                ho: '501',
                registryExternalId: null,
                expectedPnuScope: [PNU],
            },
            exposUnits: [
                expos({
                    dong: null,
                    floor: '5',
                    ho: '501',
                }),
            ],
            buildingUnits: [
                bu({
                    id: 'BU-501',
                    buildingId: 'B-1',
                    dong: null,
                    floor: null,
                    ho: '501',
                }),
                bu({
                    id: 'BU-OTHER',
                    buildingId: 'B-2',
                    dong: null,
                    floor: null,
                    ho: '999',
                }),
            ],
            propertyUnits: [
                pu({
                    id: 'PU-501',
                    buildingUnitId: 'BU-501',
                    dong: null,
                    ho: '501',
                }),
            ],
        })
    );

    assert.equal(d.kind, 'NO_CHANGE');
    assert.equal(
        d.kind === 'NO_CHANGE' && d.stage,
        'PROPERTY_UNIT_FALLBACK'
    );
});

test('building_unit 연결 없음 → PNU scope+tuple+building_unit_id NULL fallback 1건 = MATCHED (§12.4 6)', () => {
    const d = matchLdaregUnit(
        input({
            buildingUnits: [], // building_unit 매치 0 → fallback
            propertyUnits: [pu({ id: 'PU-F', buildingUnitId: null, pnu: PNU })],
        })
    );
    assert.equal(d.kind, 'MATCHED');
    assert.equal(d.kind === 'MATCHED' && d.propertyUnitId, 'PU-F');
    assert.equal(d.kind === 'MATCHED' && d.buildingUnitRef, null);
    assert.equal(d.kind === 'MATCHED' && d.via, 'PROPERTY_UNIT_FALLBACK');
});

// ── 각 단계 0건/2건+ → 무변경 (§12.4 7) ──────────────────────────────

test('1단계 전유부 0건 → 무변경 / NOT_FOUND', () => {
    const d = matchLdaregUnit(input({ exposUnits: [] }));
    assert.equal(d.kind, 'NO_CHANGE');
    assert.equal(d.kind === 'NO_CHANGE' && d.stage, 'EXPOS_EXACT');
    assert.equal(d.kind === 'NO_CHANGE' && d.issue, 'PROPERTY_UNIT_NOT_FOUND');
});

test('1단계 전유부 2건+ → 무변경 / AMBIGUOUS', () => {
    const d = matchLdaregUnit(input({ exposUnits: [expos(), expos()] }));
    assert.equal(d.kind, 'NO_CHANGE');
    assert.equal(d.kind === 'NO_CHANGE' && d.stage, 'EXPOS_EXACT');
    assert.equal(d.kind === 'NO_CHANGE' && d.issue, 'PROPERTY_UNIT_AMBIGUOUS');
});

test('assemble가 허용한 경우에만 EXPOS의 dong 누락을 floor+ho exact로 보강한다', () => {
    const withoutGate = matchLdaregUnit(
        input({
            source: {
                targetPnu: PNU,
                dong: null,
                floor: '3층',
                ho: '302호',
                registryExternalId: null,
                expectedPnuScope: [PNU],
            },
            exposUnits: [expos({ dong: '101동' })],
            buildingUnits: [],
            propertyUnits: [
                pu({
                    buildingUnitId: null,
                    dong: '101동',
                }),
            ],
        })
    );
    assert.equal(withoutGate.kind, 'NO_CHANGE');
    assert.equal(
        withoutGate.kind === 'NO_CHANGE' && withoutGate.stage,
        'EXPOS_EXACT'
    );

    const withGate = matchLdaregUnit(
        input({
            source: {
                targetPnu: PNU,
                dong: null,
                floor: '3층',
                ho: '302호',
                registryExternalId: null,
                expectedPnuScope: [PNU],
            },
            exposUnits: [expos({ dong: '101동' })],
            buildingUnits: [],
            propertyUnits: [
                pu({
                    buildingUnitId: null,
                    dong: '101동',
                }),
            ],
            allowExposFloorHoFallback: true,
        })
    );
    assert.equal(withGate.kind, 'MATCHED');
});

test('floor+ho 보강으로 찾은 EXPOS 동을 building_unit 매칭에도 그대로 사용한다', () => {
    const d = matchLdaregUnit(
        input({
            source: {
                targetPnu: PNU,
                dong: null,
                floor: '3층',
                ho: '302호',
                registryExternalId: null,
                expectedPnuScope: [PNU],
            },
            exposUnits: [expos({ dong: '101동' })],
            buildingUnits: [
                bu({
                    id: 'BU-302',
                    dong: '101동',
                    floor: '3층',
                    ho: '302호',
                }),
            ],
            propertyUnits: [
                pu({
                    id: 'PU-302',
                    buildingUnitId: 'BU-302',
                    dong: '101동',
                    ho: '302호',
                }),
            ],
            allowExposFloorHoFallback: true,
        })
    );

    assert.equal(d.kind, 'MATCHED');
    assert.equal(d.kind === 'MATCHED' && d.propertyUnitId, 'PU-302');
    assert.equal(
        d.kind === 'MATCHED' && d.buildingUnitRef,
        'BU-302'
    );
});

test('floor+ho gate가 켜져도 양쪽 dong이 다르면 dong을 버리지 않는다', () => {
    const d = matchLdaregUnit(
        input({
            source: {
                targetPnu: PNU,
                dong: '102동',
                floor: '3층',
                ho: '302호',
                registryExternalId: null,
                expectedPnuScope: [PNU],
            },
            exposUnits: [expos({ dong: '101동' })],
            allowExposFloorHoFallback: true,
        })
    );
    assert.equal(d.kind, 'NO_CHANGE');
    assert.equal(
        d.kind === 'NO_CHANGE' && d.issue,
        'UNIT_NORMALIZATION_COLLISION'
    );
});

test('DFH exact 후보가 있으면 같은 FH의 다른 dong 후보보다 우선한다', () => {
    const d = matchLdaregUnit(
        input({
            exposUnits: [
                expos({ dong: '101동' }),
                expos({ dong: '102동' }),
            ],
            allowExposFloorHoFallback: true,
        })
    );
    assert.equal(d.kind, 'MATCHED');
});

test('2단계 root identity 불일치 → 무변경 / LDAREG_IDENTITY_CONFLICT', () => {
    const d = matchLdaregUnit(input({ scopeRootIdentity: 'OTHER-ROOT' }));
    assert.equal(d.kind, 'NO_CHANGE');
    assert.equal(d.kind === 'NO_CHANGE' && d.stage, 'ROOT_IDENTITY');
    assert.equal(d.kind === 'NO_CHANGE' && d.reason, 'ROOT_MISMATCH');
    assert.equal(d.kind === 'NO_CHANGE' && d.issue, 'LDAREG_IDENTITY_CONFLICT');
});

test('3단계 registry_external_id 0건 → 무변경(외부ID 있으면 fallback 안 함)', () => {
    const d = matchLdaregUnit(
        input({
            source: { targetPnu: PNU, dong: '101동', floor: '3층', ho: '302호', registryExternalId: 'REG-MISSING', expectedPnuScope: [PNU] },
            buildingUnits: [bu({ registryExternalId: 'REG-OTHER' })],
        })
    );
    assert.equal(d.kind, 'NO_CHANGE');
    assert.equal(d.kind === 'NO_CHANGE' && d.stage, 'REGISTRY_EXTERNAL_ID');
    assert.equal(d.kind === 'NO_CHANGE' && d.issue, 'PROPERTY_UNIT_NOT_FOUND');
});

test('3단계 registry_external_id 2건+ → 무변경 / AMBIGUOUS', () => {
    const d = matchLdaregUnit(
        input({
            source: { targetPnu: PNU, dong: '101동', floor: '3층', ho: '302호', registryExternalId: 'REG-D', expectedPnuScope: [PNU] },
            buildingUnits: [bu({ id: 'BU-A', registryExternalId: 'REG-D' }), bu({ id: 'BU-B', registryExternalId: 'REG-D' })],
        })
    );
    assert.equal(d.kind, 'NO_CHANGE');
    assert.equal(d.kind === 'NO_CHANGE' && d.stage, 'REGISTRY_EXTERNAL_ID');
    assert.equal(d.kind === 'NO_CHANGE' && d.issue, 'PROPERTY_UNIT_AMBIGUOUS');
});

test('4단계 normalized tuple building_unit 2건+ → 무변경 / UNIT_NORMALIZATION_COLLISION', () => {
    const d = matchLdaregUnit(input({ buildingUnits: [bu({ id: 'BU-A' }), bu({ id: 'BU-B' })] }));
    assert.equal(d.kind, 'NO_CHANGE');
    assert.equal(d.kind === 'NO_CHANGE' && d.stage, 'NORMALIZED_TUPLE_BU');
    assert.equal(d.kind === 'NO_CHANGE' && d.issue, 'UNIT_NORMALIZATION_COLLISION');
});

test('서로 다른 building의 exact tuple은 한쪽만 active-backed여도 충돌을 유지한다', () => {
    const d = matchLdaregUnit(
        input({
            buildingUnits: [
                bu({
                    id: 'BU-ACTIVE',
                    buildingId: 'B-1',
                }),
                bu({
                    id: 'BU-SHADOW',
                    buildingId: 'B-2',
                }),
            ],
            propertyUnits: [
                pu({
                    id: 'PU-ACTIVE',
                    buildingUnitId: 'BU-ACTIVE',
                }),
            ],
        })
    );
    assert.equal(d.kind, 'NO_CHANGE');
    assert.equal(
        d.kind === 'NO_CHANGE' && d.stage,
        'NORMALIZED_TUPLE_BU'
    );
    assert.equal(
        d.kind === 'NO_CHANGE' && d.issue,
        'UNIT_NORMALIZATION_COLLISION'
    );
});

test('5단계 property_unit 0건 → 무변경 / NOT_FOUND', () => {
    const d = matchLdaregUnit(input({ propertyUnits: [] }));
    assert.equal(d.kind, 'NO_CHANGE');
    assert.equal(d.kind === 'NO_CHANGE' && d.stage, 'PROPERTY_UNIT_BY_BU');
    assert.equal(d.kind === 'NO_CHANGE' && d.issue, 'PROPERTY_UNIT_NOT_FOUND');
});

test('5단계 property_unit 2건+ → 무변경 / AMBIGUOUS', () => {
    const d = matchLdaregUnit(input({ propertyUnits: [pu({ id: 'PU-A' }), pu({ id: 'PU-B' })] }));
    assert.equal(d.kind, 'NO_CHANGE');
    assert.equal(d.kind === 'NO_CHANGE' && d.stage, 'PROPERTY_UNIT_BY_BU');
    assert.equal(d.kind === 'NO_CHANGE' && d.issue, 'PROPERTY_UNIT_AMBIGUOUS');
});

test('5단계 is_deleted=true property_unit는 후보에서 제외 → NOT_FOUND', () => {
    const d = matchLdaregUnit(input({ propertyUnits: [pu({ isDeleted: true })] }));
    assert.equal(d.kind, 'NO_CHANGE');
    assert.equal(d.kind === 'NO_CHANGE' && d.issue, 'PROPERTY_UNIT_NOT_FOUND');
});

test('5단계 wrong union/null·out-of-scope PNU 링크는 active-backed 근거가 아니다', () => {
    const d = matchLdaregUnit(
        input({
            propertyUnits: [
                pu({ id: 'PU-WRONG-UNION', unionId: 'other-union' }),
                pu({ id: 'PU-NULL-PNU', pnu: null }),
                pu({ id: 'PU-OUT-OF-SCOPE', pnu: 'OTHER-PNU' }),
                pu({ id: 'PU-DELETED', isDeleted: true }),
            ],
        })
    );
    assert.equal(d.kind, 'NO_CHANGE');
    assert.equal(
        d.kind === 'NO_CHANGE' && d.stage,
        'PROPERTY_UNIT_BY_BU'
    );
    assert.equal(
        d.kind === 'NO_CHANGE' && d.issue,
        'PROPERTY_UNIT_NOT_FOUND'
    );
});

test('6단계 fallback 0건 → NOT_FOUND (PNU scope 벗어난 pnu 제외)', () => {
    const d = matchLdaregUnit(
        input({
            buildingUnits: [],
            propertyUnits: [pu({ id: 'PU-F', buildingUnitId: null, pnu: 'OTHER-PNU' })],
        })
    );
    assert.equal(d.kind, 'NO_CHANGE');
    assert.equal(d.kind === 'NO_CHANGE' && d.stage, 'PROPERTY_UNIT_FALLBACK');
    assert.equal(d.kind === 'NO_CHANGE' && d.issue, 'PROPERTY_UNIT_NOT_FOUND');
});

test('6단계 fallback 2건+ → AMBIGUOUS', () => {
    const d = matchLdaregUnit(
        input({
            buildingUnits: [],
            propertyUnits: [
                pu({ id: 'PU-A', buildingUnitId: null, pnu: PNU }),
                pu({ id: 'PU-B', buildingUnitId: null, pnu: PNU }),
            ],
        })
    );
    assert.equal(d.kind, 'NO_CHANGE');
    assert.equal(d.kind === 'NO_CHANGE' && d.stage, 'PROPERTY_UNIT_FALLBACK');
    assert.equal(d.kind === 'NO_CHANGE' && d.issue, 'PROPERTY_UNIT_AMBIGUOUS');
});

// ── exact normalizer만 사용, fuzzy 경로 없음 ─────────────────────────

test('정규화 등가(제101동·0302호 등)는 exact match, fuzzy 아님', () => {
    // 동 `제101동`↔`101`, 호 `0302호`↔`302`는 허용 변환으로 정확히 수렴한다.
    // 층 `3층`은 양측 동일(§12.3은 `층` 접미사 제거를 허용하지 않으므로 일관되게 유지).
    const d = matchLdaregUnit(
        input({
            source: { targetPnu: PNU, dong: '제101동', floor: '3층', ho: '0302호', registryExternalId: null, expectedPnuScope: [PNU] },
            exposUnits: [expos({ dong: '101', floor: '3층', ho: '302' })],
            buildingUnits: [bu({ dong: '101', floor: '3층', ho: '302' })],
        })
    );
    assert.equal(d.kind, 'MATCHED'); // 정규화 후 정확 일치
});

test('near-miss(호 다름)는 절대 매칭하지 않음 = fuzzy 경로 부재', () => {
    const d = matchLdaregUnit(
        input({
            source: { targetPnu: PNU, dong: '101동', floor: '3층', ho: '303호', registryExternalId: null, expectedPnuScope: [PNU] },
            exposUnits: [expos({ ho: '302호' })],
        })
    );
    assert.equal(d.kind, 'NO_CHANGE'); // 근사 매칭 없음
});

test('matcher 모듈에 fuzzy 경로가 존재하지 않음', () => {
    const names = Object.keys(matcherModule);
    assert.equal(
        names.some((n) => /fuzzy|score|similar|distance/i.test(n)),
        false
    );
});

// ── writer-guard: 순수 함수, 입력 배열·후보 무변경(INSERT 없음) ───────

test('matcher는 순수 함수 — 입력 후보 배열을 변형하지 않음', () => {
    const inp = input();
    const beforeBu = inp.buildingUnits.length;
    const beforePu = inp.propertyUnits.length;
    const beforeExpos = inp.exposUnits.length;
    matchLdaregUnit(inp);
    assert.equal(inp.buildingUnits.length, beforeBu);
    assert.equal(inp.propertyUnits.length, beforePu);
    assert.equal(inp.exposUnits.length, beforeExpos);
});
