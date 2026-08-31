import assert from 'node:assert/strict';
import test from 'node:test';

// GisService 는 config/env 를 통해 로드되므로 최소 환경 변수를 먼저 채우고
// **동적 import** 로 불러온다 (tests/consent-queue-admission.test.ts 와 같은 관례 —
// 정적 import 는 호이스팅돼 env 설정보다 먼저 평가된다)
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.ALIGO_API_KEY ||= 'test-aligo-key';
process.env.ALIGO_USER_ID ||= 'test-aligo-user';
process.env.ALIGO_SENDER_PHONE ||= '0212345678';
process.env.DEFAULT_SENDER_KEY ||= 'test-sender-key';
process.env.SUPABASE_URL ||= 'https://test-ref.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const gisModule = import('../src/services/gis.service');

/**
 * 재건축 P2 — 건축물대장 수집을 동(棟) 단위로
 *
 * 현행 수집기는 표제부 목록 중 `titleInfoList[0]` 하나만 대표로 삼는다.
 * 아파트 단지처럼 표제부가 동마다 있는 경우 나머지 동이 통째로 버려지고,
 * 첫 표제부가 관리동·경비실이면 단지 전체가 그 유형으로 오분류된다.
 *
 * `composeBuildingDongs` 는 표제부를 전부 순회해 동 배열을 만들고
 * 전유부를 정규화된 동 이름으로 각 동에 귀속시키는 순수 함수다
 * (API 호출과 분리해 테스트 가능하게 뺐다).
 */
interface ComposedDong {
    registryPk: string | null;
    dongName: string | null;
    buildingType: string;
    housingType: string | null;
    buildingName: string | null;
    floorCount: number;
    isWelfareFacility: boolean;
    units: Array<{ dong: string | null; ho: string | null }>;
}

async function compose(titles: unknown[], units: unknown[], pnu: string): Promise<ComposedDong[]> {
    // 모듈은 싱글턴 gisService 만 내보낸다(클래스는 비공개).
    const { gisService } = await gisModule;
    const svc = gisService as unknown as {
        composeBuildingDongs(t: unknown[], u: unknown[], p: string): ComposedDong[];
    };
    return svc.composeBuildingDongs(titles, units, pnu);
}

const PNU = '1111010100100010000';

test('표제부 전체를 순회해 동마다 항목을 만든다', async () => {
    const titles = [
        { mgmBldrgstPk: 'PK-101', dongNm: '101동', mainPurpsCdNm: '아파트', grndFlrCnt: '15' },
        { mgmBldrgstPk: 'PK-102', dongNm: '102동', mainPurpsCdNm: '아파트', grndFlrCnt: '15' },
    ];
    const units = [
        { mgmBldrgstPk: 'PK-101', dongNm: '101동', hoNm: '101호', flrNo: '1', area: '84.9' },
        { mgmBldrgstPk: 'PK-102', dongNm: '102동', hoNm: '201호', flrNo: '2', area: '59.9' },
    ];

    const dongs = await compose(titles, units, PNU);

    assert.equal(dongs.length, 2);
    assert.deepEqual(dongs.map((d) => d.dongName).sort(), ['101동', '102동']);
    assert.equal(dongs[0].units.length, 1);
    assert.equal(dongs[0].registryPk, 'PK-101');
    assert.equal(dongs[0].housingType, 'APARTMENT');
});

test('총괄표제부는 동으로 만들지 않는다', async () => {
    // 단지는 총괄표제부(단지 전체 요약) 행을 함께 돌려준다.
    // 이것을 동으로 만들면 세대 0개짜리 유령 동이 생긴다.
    const titles = [
        { mgmBldrgstPk: 'PK-SUM', regstrKindCdNm: '총괄표제부', mainPurpsCdNm: '아파트' },
        { mgmBldrgstPk: 'PK-101', regstrKindCdNm: '표제부', dongNm: '101동', mainPurpsCdNm: '아파트' },
    ];

    const dongs = await compose(titles, [], PNU);

    assert.equal(dongs.length, 1);
    assert.equal(dongs[0].registryPk, 'PK-101');
});

test('첫 표제부가 부속건물이어도 동마다 유형을 따로 분류한다', async () => {
    // 현행 titleInfoList[0] 방식이면 단지 전체가 COMMERCIAL 로 오분류된다.
    const titles = [
        { mgmBldrgstPk: 'PK-MGMT', dongNm: '관리동', mainPurpsCdNm: '제1종근린생활시설' },
        { mgmBldrgstPk: 'PK-101', dongNm: '101동', mainPurpsCdNm: '아파트' },
    ];

    const dongs = await compose(titles, [], PNU);

    const mgmt = dongs.find((d) => d.registryPk === 'PK-MGMT');
    const apt = dongs.find((d) => d.registryPk === 'PK-101');
    assert.equal(mgmt?.buildingType, 'COMMERCIAL');
    assert.equal(mgmt?.isWelfareFacility, true);
    assert.equal(apt?.buildingType, 'APARTMENT');
    assert.equal(apt?.isWelfareFacility, false);
});

test('전유부는 정규화된 동 이름으로 귀속된다 (가동 ↔ 가)', async () => {
    const titles = [
        { mgmBldrgstPk: 'PK-A', dongNm: '가동', mainPurpsCdNm: '연립주택' },
        { mgmBldrgstPk: 'PK-B', dongNm: '나동', mainPurpsCdNm: '연립주택' },
    ];
    const units = [
        { dongNm: '가', hoNm: '101' },
        { dongNm: '나동', hoNm: '201' },
    ];

    const dongs = await compose(titles, units, PNU);

    assert.equal(dongs.find((d) => d.registryPk === 'PK-A')?.units.length, 1);
    assert.equal(dongs.find((d) => d.registryPk === 'PK-B')?.units.length, 1);
    assert.equal(dongs.find((d) => d.registryPk === 'PK-A')?.housingType, 'ROW_HOUSE');
});

test('표제부가 1행뿐이면 동 이름과 무관하게 전유부 전량을 귀속시킨다', async () => {
    const titles = [{ mgmBldrgstPk: 'PK-1', mainPurpsCdNm: '다세대주택' }];
    const units = [
        { dongNm: '가', hoNm: '101' },
        { dongNm: '나', hoNm: '102' },
    ];

    const dongs = await compose(titles, units, PNU);

    assert.equal(dongs.length, 1);
    assert.equal(dongs[0].units.length, 2);
    // 다세대는 주택단지가 아니다(§2 7호 마목) → §35④ 트랙
    assert.equal(dongs[0].housingType, 'MULTIPLEX');
});

test('표제부에 없는 동의 전유부는 미배정 동으로 모은다 (임의 배정 금지)', async () => {
    const titles = [
        { mgmBldrgstPk: 'PK-101', dongNm: '101동', mainPurpsCdNm: '아파트' },
        { mgmBldrgstPk: 'PK-102', dongNm: '102동', mainPurpsCdNm: '아파트' },
    ];
    const units = [{ dongNm: '999동', hoNm: '1호' }];

    const dongs = await compose(titles, units, PNU);

    const unassigned = dongs.find((d) => d.registryPk === null);
    assert.ok(unassigned, '미배정 동이 없다');
    assert.equal(unassigned.units.length, 1);
    assert.equal(unassigned.dongName, '999동');
    // 표제부가 있는 두 동에는 세대가 붙지 않아야 한다
    assert.equal(dongs.filter((d) => d.registryPk !== null).every((d) => d.units.length === 0), true);
});

test('표제부가 0건이면 빈 배열을 돌려준다', async () => {
    assert.deepEqual(await compose([], [], PNU), []);
});

test('같은 입력을 두 번 처리해도 동 수와 식별자가 같다 (멱등)', async () => {
    const titles = [{ mgmBldrgstPk: 'PK-101', dongNm: '101동', mainPurpsCdNm: '아파트' }];
    const units = [{ dongNm: '101동', hoNm: '101호' }];

    const first = await compose(titles, units, PNU);
    const second = await compose(titles, units, PNU);

    assert.equal(first.length, second.length);
    assert.deepEqual(
        first.map((d) => d.registryPk),
        second.map((d) => d.registryPk),
    );
});
