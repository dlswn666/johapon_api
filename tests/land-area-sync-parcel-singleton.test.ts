import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseDevelopmentTargetManifest } from '../src/operations/development-land-area-sync-runner';
import {
    resolveParcelComponentLadfrlCandidates,
    resolveParcelSingletonLadfrlCandidate,
} from '../src/services/land-area-sync/parcel-singleton';

const UNION_ID = '00f48b95-e9bc-4c92-a0e5-6b9a57adcfb9';
const PNU = '1130510100107912150';
const PROPERTY_UNIT_ID =
    'c754f060-e7a3-4799-863d-b6d66ac7c4d6';
const BUILDING_UNIT_ID =
    '1d03a991-38ec-48a1-a405-c09304261c2a';

function input() {
    return {
        unionId: UNION_ID,
        targetPnu: PNU,
        scannedPnus: [PNU],
        membership: [
            {
                propertyUnitId: PROPERTY_UNIT_ID,
                pnu: PNU,
                buildingUnitId: BUILDING_UNIT_ID,
            },
        ],
        propertyUnits: [
            {
                id: PROPERTY_UNIT_ID,
                unionId: UNION_ID,
                buildingUnitId: BUILDING_UNIT_ID,
                pnu: PNU,
                isDeleted: false,
                dong: null,
                ho: null,
            },
        ],
        buildingUnits: [
            {
                id: BUILDING_UNIT_ID,
                buildingId:
                    '22222222-2222-4222-8222-222222222222',
                dong: null,
                floor: null,
                ho: null,
                registryExternalId: null,
            },
            // 같은 building의 legacy 빈 singleton 중복은 호별 identity가 아니므로
            // parcel-level 판정을 바꾸지 않는다.
            {
                id: '33333333-3333-4333-8333-333333333333',
                buildingId:
                    '22222222-2222-4222-8222-222222222222',
                dong: null,
                floor: null,
                ho: null,
                registryExternalId: null,
            },
        ],
    };
}

test('활성 물건 1건과 unit identity 없는 연결은 parcel singleton LADFRL 후보가 된다', () => {
    assert.deepEqual(resolveParcelSingletonLadfrlCandidate(input()), {
        kind: 'ELIGIBLE',
        propertyUnitId: PROPERTY_UNIT_ID,
        basis: 'CLASSIFICATION_CONFLICT_DB_PARCEL_SINGLETON',
    });
});

test('property_unit에 호가 있으면 집합건물 가능성을 배제할 수 없어 거부한다', () => {
    const value = input();
    value.propertyUnits[0].ho = '201';
    assert.deepEqual(resolveParcelSingletonLadfrlCandidate(value), {
        kind: 'REJECTED',
        reason: 'PROPERTY_UNIT_HAS_UNIT_IDENTITY',
    });
});

test('연결 building_unit 하나라도 층·호 identity가 있으면 거부한다', () => {
    const value = input();
    value.buildingUnits[1].floor = '2';
    value.buildingUnits[1].ho = '201';
    assert.deepEqual(resolveParcelSingletonLadfrlCandidate(value), {
        kind: 'REJECTED',
        reason: 'BUILDING_UNIT_HAS_UNIT_IDENTITY',
    });
});

test('활성 property_unit이 둘이면 membership이 하나여도 거부한다', () => {
    const value = input();
    value.propertyUnits.push({
        ...value.propertyUnits[0],
        id: '44444444-4444-4444-8444-444444444444',
    });
    assert.deepEqual(resolveParcelSingletonLadfrlCandidate(value), {
        kind: 'REJECTED',
        reason: 'PROPERTY_UNIT_NOT_SINGLE',
    });
});

test('building_unit 링크가 없는데 scope에 unit 후보가 있으면 거부한다', () => {
    const value = input();
    value.propertyUnits[0].buildingUnitId = null;
    assert.deepEqual(resolveParcelSingletonLadfrlCandidate(value), {
        kind: 'REJECTED',
        reason: 'UNLINKED_BUILDING_UNITS_PRESENT',
    });
});

test('DEV 공식 multi component는 PNU별 no-room singleton만 LADFRL 대상으로 만들고 query-only PNU는 제외한다', () => {
    const attachedPnu = '1130510100107912339';
    const queryOnlyPnu = '1130510100107030130';
    const attachedPropertyId =
        '44444444-4444-4444-8444-444444444444';
    assert.deepEqual(
        resolveParcelComponentLadfrlCandidates({
            unionId: UNION_ID,
            canonicalBasePnu: PNU,
            memberPnus: [queryOnlyPnu, attachedPnu, PNU].sort(),
            propertyUnits: [
                {
                    id: PROPERTY_UNIT_ID,
                    unionId: UNION_ID,
                    buildingUnitId: null,
                    pnu: PNU,
                    isDeleted: false,
                    dong: null,
                    ho: null,
                },
                {
                    id: attachedPropertyId,
                    unionId: UNION_ID,
                    buildingUnitId: null,
                    pnu: attachedPnu,
                    isDeleted: false,
                    dong: null,
                    ho: null,
                },
            ],
            buildingUnits: [],
        }),
        {
            kind: 'ELIGIBLE',
            basis:
                'OFFICIAL_COMPONENT_DB_PARCEL_SINGLETONS',
            targets: [
                {
                    propertyUnitId: PROPERTY_UNIT_ID,
                    targetPnu: PNU,
                },
                {
                    propertyUnitId: attachedPropertyId,
                    targetPnu: attachedPnu,
                },
            ],
            queryOnlyPnus: [queryOnlyPnu],
        }
    );
});

test('DEV 공식 multi component는 canonical 누락·PNU 중복 물건·호실 identity를 fail-closed한다', () => {
    const attachedPnu = '1130510100107912339';
    const property = {
        id: PROPERTY_UNIT_ID,
        unionId: UNION_ID,
        buildingUnitId: null,
        pnu: PNU,
        isDeleted: false,
        dong: null,
        ho: null,
    };
    const common = {
        unionId: UNION_ID,
        canonicalBasePnu: PNU,
        memberPnus: [PNU, attachedPnu],
        buildingUnits: [],
    };

    assert.deepEqual(
        resolveParcelComponentLadfrlCandidates({
            ...common,
            propertyUnits: [
                {
                    ...property,
                    pnu: attachedPnu,
                },
            ],
        }),
        {
            kind: 'REJECTED',
            reason: 'CANONICAL_PROPERTY_MISSING',
        }
    );
    assert.deepEqual(
        resolveParcelComponentLadfrlCandidates({
            ...common,
            propertyUnits: [
                property,
                {
                    ...property,
                    id: '55555555-5555-4555-8555-555555555555',
                },
            ],
        }),
        {
            kind: 'REJECTED',
            reason: 'PROPERTY_UNIT_NOT_SINGLE_PER_PNU',
        }
    );
    assert.deepEqual(
        resolveParcelComponentLadfrlCandidates({
            ...common,
            propertyUnits: [
                {
                    ...property,
                    ho: '101',
                },
            ],
        }),
        {
            kind: 'REJECTED',
            reason: 'PROPERTY_UNIT_HAS_UNIT_IDENTITY',
        }
    );
});

test('미아7 parcel singleton target은 review 210에서 다물건 PNU 8개만 제외한 202건이다', () => {
    const review = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(
                'development-land-area-sync-manifests/mia-seven-review-210-target-20260725.json',
                'utf8'
            )
        )
    );
    const singleton = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(
                'development-land-area-sync-manifests/mia-seven-parcel-singleton-202-target-20260725.json',
                'utf8'
            )
        )
    );
    const excluded = review.pnus.filter(
        (pnu) => !singleton.pnus.includes(pnu)
    );

    assert.equal(review.targetCount, 210);
    assert.equal(singleton.targetCount, 202);
    assert.equal(singleton.expectedPropertyUnitCount, 202);
    assert.deepEqual(excluded, [
        '1130510100107912155',
        '1130510100107912172',
        '1130510100107912173',
        '1130510100107912188',
        '1130510100107912191',
        '1130510100107912282',
        '1130510100107912315',
        '1130510100107912340',
    ]);
});
