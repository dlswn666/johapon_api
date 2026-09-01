import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.ALIGO_API_KEY ||= 'test-aligo-key';
process.env.ALIGO_USER_ID ||= 'test-aligo-user';
process.env.ALIGO_SENDER_PHONE ||= '0212345678';
process.env.DEFAULT_SENDER_KEY ||= 'test-sender-key';
process.env.SUPABASE_URL ||= 'https://test-ref.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const gisModule = import('../src/services/gis.service');

/**
 * 건축물대장 페이지네이션 종료 조건 — 재건축 P2 (실호출로 발견)
 *
 * 실측(삼각산아이원, 1,344세대): `numOfRows=1000` 을 보내도 서버는
 * **페이지당 100건 고정**으로 돌려준다. totalCount 는 1344 이고 14페이지까지 있다.
 *
 * 종료 조건에 `pageRows.length < numOfRows` 가 있으면 첫 페이지(100건)에서
 * 바로 멈춰 **1,344건 중 100건만 수집하고 조용히 잘린다.**
 * 요청한 페이지 크기는 서버가 지킨다는 보장이 없으므로 종료 판단에 쓰면 안 된다.
 */
async function shouldStop(
    pageRowCount: number,
    accumulated: number,
    totalCount: number | null,
): Promise<boolean> {
    const { gisService } = await gisModule;
    const svc = gisService as unknown as {
        shouldStopRegistryPaging(p: number, a: number, t: number | null): boolean;
    };
    return svc.shouldStopRegistryPaging(pageRowCount, accumulated, totalCount);
}

test('서버가 요청보다 적게 줘도 멈추지 않는다 (실측: 1000 요청 → 100 수신)', async () => {
    // 1페이지: 100건 받았고 총 1344건 → 계속 받아야 한다
    assert.equal(await shouldStop(100, 100, 1344), false);
    // 13페이지까지: 1300건 → 아직 남았다
    assert.equal(await shouldStop(100, 1300, 1344), false);
});

test('총건수를 다 받으면 멈춘다', async () => {
    assert.equal(await shouldStop(44, 1344, 1344), true);
    assert.equal(await shouldStop(100, 1400, 1344), true);
});

test('빈 페이지면 멈춘다', async () => {
    assert.equal(await shouldStop(0, 100, 1344), true);
    assert.equal(await shouldStop(0, 0, null), true);
});

test('총건수를 모르면 한 페이지만 받고 멈춘다 (무한 루프 방지)', async () => {
    assert.equal(await shouldStop(100, 100, null), true);
});
