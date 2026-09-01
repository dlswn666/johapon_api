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
 * 건축물대장 일시 오류 재시도 — 재건축 P2 (실호출로 발견)
 *
 * 공공데이터포털이 **간헐적으로 503** 을 준다(실측: 같은 요청을 반복했을 때
 * 200/200/503/200 처럼 섞여 나온다). 그런데 수집기는 어느 한 페이지에서
 * 예외가 나면 `return []` 로 **그때까지 모은 것까지 통째로 버린다.**
 * 1,344세대는 14페이지가 필요하므로 한 번이라도 흔들리면 그 필지의 건물이
 * 통째로 없는 것처럼 처리된다.
 */
async function isRetriable(error: unknown): Promise<boolean> {
    const { gisService } = await gisModule;
    const svc = gisService as unknown as { isRetriableRegistryError(e: unknown): boolean };
    return svc.isRetriableRegistryError(error);
}

test('5xx 는 재시도 대상이다', async () => {
    assert.equal(await isRetriable({ response: { status: 503 } }), true);
    assert.equal(await isRetriable({ response: { status: 500 } }), true);
    assert.equal(await isRetriable({ response: { status: 502 } }), true);
});

test('네트워크 오류도 재시도 대상이다', async () => {
    assert.equal(await isRetriable({ code: 'ECONNRESET' }), true);
    assert.equal(await isRetriable({ code: 'ETIMEDOUT' }), true);
    assert.equal(await isRetriable({ code: 'ECONNABORTED' }), true);
});

test('4xx 는 재시도하지 않는다 (키 오류·잘못된 파라미터는 반복해도 같다)', async () => {
    assert.equal(await isRetriable({ response: { status: 400 } }), false);
    assert.equal(await isRetriable({ response: { status: 401 } }), false);
    assert.equal(await isRetriable({ response: { status: 404 } }), false);
});

test('알 수 없는 오류는 재시도하지 않는다', async () => {
    assert.equal(await isRetriable(new Error('boom')), false);
    assert.equal(await isRetriable(null), false);
});
