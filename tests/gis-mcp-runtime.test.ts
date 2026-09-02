import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PublicDataMcpRuntimeError,
    createPublicDataMcpRuntimeDependenciesV1,
} from '../src/services/public-data-mcp/runtime';
import type { PublicDataMcpCallContext } from '../src/services/public-data-mcp/server';

const input = { address: '서울특별시 강북구 미아동 1' };
function context(signal = new AbortController().signal): PublicDataMcpCallContext {
    return {
        principal: { clientId: 'test', scopes: ['gis:read'], tokenId: 'a'.repeat(64) },
        signal,
    };
}

test('요청 admission은 동시 실행과 대기열을 제한한다', async () => {
    let release!: () => void;
    let started = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createPublicDataMcpRuntimeDependenciesV1({
        maxConcurrentRequests: 1,
        maxQueuedRequests: 1,
        requestDeadlineMs: 2_000,
        provider: {
            async execute() {
                started += 1;
                if (started === 1) await gate;
                return {} as never;
            },
        },
    });
    const first = Promise.resolve(runtime.execute('resolve_address_to_pnu_v1', input, context()));
    while (started === 0) await Promise.resolve();
    const second = Promise.resolve(runtime.execute('resolve_address_to_pnu_v1', input, context()));
    await assert.rejects(
        Promise.resolve(runtime.execute('resolve_address_to_pnu_v1', input, context())),
        (error: unknown) => error instanceof PublicDataMcpRuntimeError
            && error.code === 'RATE_LIMITED'
    );
    release();
    await Promise.all([first, second]);
});

test('전체 deadline은 signal 미지원 provider도 안전코드로 종료한다', async () => {
    const runtime = createPublicDataMcpRuntimeDependenciesV1({
        requestDeadlineMs: 10,
        maxConcurrentRequests: 1,
        maxQueuedRequests: 0,
        provider: { execute: () => new Promise(() => undefined) },
    });
    const keepAlive = setTimeout(() => undefined, 1_000);
    try {
        await assert.rejects(
            Promise.resolve(runtime.execute('resolve_address_to_pnu_v1', input, context())),
            (error: unknown) => error instanceof PublicDataMcpRuntimeError
                && error.code === 'REQUEST_DEADLINE_EXCEEDED'
        );
    } finally {
        clearTimeout(keepAlive);
    }
});

test('deadline 뒤에도 실행 중인 provider는 admission slot을 유지한다', async () => {
    let finish!: () => void;
    let started = 0;
    const providerGate = new Promise<void>((resolve) => { finish = resolve; });
    const runtime = createPublicDataMcpRuntimeDependenciesV1({
        requestDeadlineMs: 10,
        maxConcurrentRequests: 1,
        maxQueuedRequests: 0,
        provider: {
            async execute() {
                started += 1;
                await providerGate;
                return {} as never;
            },
        },
    });
    const keepAlive = setTimeout(() => undefined, 1_000);
    try {
        await assert.rejects(
            Promise.resolve(runtime.execute(
                'resolve_address_to_pnu_v1',
                input,
                context()
            )),
            (error: unknown) => error instanceof PublicDataMcpRuntimeError
                && error.code === 'REQUEST_DEADLINE_EXCEEDED'
        );
        await assert.rejects(
            Promise.resolve(runtime.execute(
                'resolve_address_to_pnu_v1',
                input,
                context()
            )),
            (error: unknown) => error instanceof PublicDataMcpRuntimeError
                && error.code === 'RATE_LIMITED'
        );
        assert.equal(started, 1);
    } finally {
        finish();
        clearTimeout(keepAlive);
    }
});

test('provider 원본 오류 메시지는 고정 안전코드로 치환한다', async () => {
    const runtime = createPublicDataMcpRuntimeDependenciesV1({
        provider: { async execute() { throw new Error('api-key-and-stack-canary'); } },
    });
    await assert.rejects(
        Promise.resolve(runtime.execute('resolve_address_to_pnu_v1', input, context())),
        (error: unknown) => error instanceof PublicDataMcpRuntimeError
            && error.code === 'PROVIDER_REQUEST_FAILED'
            && !error.message.includes('canary')
    );
});
