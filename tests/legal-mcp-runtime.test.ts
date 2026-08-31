import assert from 'node:assert/strict';
import test from 'node:test';
import { LegalOpenApiError } from '../src/services/legal-research/errors';
import { createLegalMcpRuntimeDependenciesV1 } from '../src/services/legal-research/mcp-runtime';
import type { LegalResearchPacketV1 } from '../src/services/legal-research/model';
import type { LegalMcpCallContext } from '../src/services/legal-research/mcp-server';

function context(signal: AbortSignal): LegalMcpCallContext {
    return {
        principal: {
            clientId: 'runtime-test',
            scopes: ['law:research'],
            tokenId: 'a'.repeat(64),
        },
        signal,
    };
}

const fakePacket = {} as LegalResearchPacketV1;

test('프로세스 전역 research admission은 동시 실행과 대기열을 제한한다', async () => {
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    let finishFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const startGate = new Promise<void>((resolve) => { firstStarted = resolve; });
    const runtime = createLegalMcpRuntimeDependenciesV1({
        maxConcurrentResearch: 1,
        maxQueuedResearch: 1,
        researchDeadlineMs: 2_000,
        orchestrator: {
            async research() {
                started += 1;
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                if (started === 1) {
                    firstStarted();
                    await firstGate;
                }
                active -= 1;
                return fakePacket;
            },
        },
    });
    const signal = new AbortController().signal;

    const first = Promise.resolve(runtime.research({} as never, context(signal)));
    await startGate;
    const second = Promise.resolve(runtime.research({} as never, context(signal)));
    await assert.rejects(
        Promise.resolve(runtime.research({} as never, context(signal))),
        (error: unknown) => error instanceof LegalOpenApiError
            && error.code === 'RATE_LIMITED'
    );

    assert.equal(started, 1);
    finishFirst();
    await Promise.all([first, second]);
    assert.equal(started, 2);
    assert.equal(maximumActive, 1);
});

test('전체 research deadline은 provider fanout을 취소하고 안전한 timeout 오류로 닫는다', async () => {
    const runtime = createLegalMcpRuntimeDependenciesV1({
        researchDeadlineMs: 10,
        maxConcurrentResearch: 1,
        maxQueuedResearch: 0,
        orchestrator: {
            async research(_input, signal) {
                return new Promise<LegalResearchPacketV1>((_resolve, reject) => {
                    signal?.addEventListener('abort', () => reject(signal.reason), {
                        once: true,
                    });
                });
            },
        },
    });

    // AbortSignal.timeout timer는 unref 상태이므로 테스트 동안 참조 timer를 유지한다.
    const keepAlive = setTimeout(() => undefined, 1_000);
    try {
        await assert.rejects(
            Promise.resolve(runtime.research(
                {} as never,
                context(new AbortController().signal)
            )),
            (error: unknown) => error instanceof LegalOpenApiError
                && error.code === 'UPSTREAM_TIMEOUT'
        );
    } finally {
        clearTimeout(keepAlive);
    }
});
