import assert from 'node:assert/strict';
import test from 'node:test';
import { closeServerAndMcpWithHardTimeoutV1 } from '../src/utils/graceful-shutdown';

test('HTTP와 MCP가 닫히면 hard timeout 전에 정상 종료 결과를 반환한다', async () => {
    let idleCloseCount = 0;
    let forceCloseCount = 0;
    const result = await closeServerAndMcpWithHardTimeoutV1({
        server: {
            close(callback) {
                callback();
                return this as never;
            },
            closeIdleConnections() {
                idleCloseCount += 1;
            },
            closeAllConnections() {
                forceCloseCount += 1;
            },
        },
        closeMcp: async () => undefined,
        timeoutMs: 100,
    });

    assert.equal(result.forced, false);
    assert.equal(result.results?.every((entry) => entry.status === 'fulfilled'), true);
    assert.equal(idleCloseCount, 1);
    assert.equal(forceCloseCount, 0);
});

test('HTTP 또는 MCP 종료가 멈추면 hard timeout이 열린 연결을 강제로 닫는다', async () => {
    let idleCloseCount = 0;
    let forceCloseCount = 0;
    let forceHookCount = 0;
    const never = new Promise<void>(() => undefined);
    const result = await closeServerAndMcpWithHardTimeoutV1({
        server: {
            close() {
                return this as never;
            },
            closeIdleConnections() {
                idleCloseCount += 1;
            },
            closeAllConnections() {
                forceCloseCount += 1;
            },
        },
        closeMcp: () => never,
        timeoutMs: 10,
        onForceClose: () => {
            forceHookCount += 1;
        },
    });

    assert.deepEqual(result, { forced: true, results: null });
    assert.equal(idleCloseCount, 1);
    assert.equal(forceCloseCount, 1);
    assert.equal(forceHookCount, 1);
});
