import {
    createPublicDataMcpProviderV1,
    type PublicDataMcpProviderV1,
} from './provider';
import type {
    PublicDataMcpCallContext,
    PublicDataMcpServerDependencies,
} from './server';
import type {
    PublicDataMcpResultV1,
    PublicDataMcpSafeCode,
    PublicDataMcpToolInput,
    PublicDataMcpToolName,
} from './policy';

export const PUBLIC_DATA_MCP_REQUEST_DEADLINE_MS = 45_000;
export const PUBLIC_DATA_MCP_MAX_CONCURRENT_REQUESTS = 2;
export const PUBLIC_DATA_MCP_MAX_QUEUED_REQUESTS = 4;

export interface CreatePublicDataMcpRuntimeDependenciesOptionsV1 {
    requestDeadlineMs?: number;
    maxConcurrentRequests?: number;
    maxQueuedRequests?: number;
    provider?: PublicDataMcpProviderV1;
    now?: () => number;
}

type RuntimeErrorCode = Extract<
    PublicDataMcpSafeCode,
    | 'RATE_LIMITED'
    | 'REQUEST_ABORTED'
    | 'REQUEST_DEADLINE_EXCEEDED'
    | 'PROVIDER_REQUEST_FAILED'
>;

/** 원본 provider error.message를 보존하지 않는 전송 경계용 오류다. */
export class PublicDataMcpRuntimeError extends Error {
    constructor(readonly code: RuntimeErrorCode) {
        super(code);
        this.name = 'PublicDataMcpRuntimeError';
    }
}

export function isPublicDataMcpRuntimeError(
    error: unknown
): error is PublicDataMcpRuntimeError {
    return error instanceof PublicDataMcpRuntimeError;
}

interface AdmissionWaiter {
    signal: AbortSignal;
    onAbort: () => void;
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
}

class RequestAdmissionGate {
    private active = 0;
    private readonly queue: AdmissionWaiter[] = [];

    constructor(
        private readonly maximumActive: number,
        private readonly maximumQueued: number
    ) {}

    async acquire(signal: AbortSignal): Promise<() => void> {
        signal.throwIfAborted();
        if (this.active < this.maximumActive) {
            this.active += 1;
            return this.releaseHandle();
        }
        if (this.queue.length >= this.maximumQueued) {
            throw new PublicDataMcpRuntimeError('RATE_LIMITED');
        }

        return new Promise<() => void>((resolve, reject) => {
            const waiter: AdmissionWaiter = {
                signal,
                resolve,
                reject,
                onAbort: () => {
                    const index = this.queue.indexOf(waiter);
                    if (index >= 0) this.queue.splice(index, 1);
                    reject(signal.reason);
                },
            };
            signal.addEventListener('abort', waiter.onAbort, { once: true });
            this.queue.push(waiter);
        });
    }

    private releaseHandle(): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.active -= 1;
            this.admitNext();
        };
    }

    private admitNext(): void {
        while (this.queue.length > 0 && this.active < this.maximumActive) {
            const waiter = this.queue.shift()!;
            waiter.signal.removeEventListener('abort', waiter.onAbort);
            if (waiter.signal.aborted) {
                waiter.reject(waiter.signal.reason);
                continue;
            }
            this.active += 1;
            waiter.resolve(this.releaseHandle());
        }
    }
}

function positiveInteger(
    value: number | undefined,
    fallback: number,
    maximum: number
): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
        throw new Error('GIS MCP 요청 운영 상한 설정이 올바르지 않습니다.');
    }
    return resolved;
}

function nonNegativeInteger(
    value: number | undefined,
    fallback: number,
    maximum: number
): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > maximum) {
        throw new Error('GIS MCP 요청 대기열 설정이 올바르지 않습니다.');
    }
    return resolved;
}

/**
 * signal 인자를 지원하지 않는 기존 provider도 deadline 뒤의 rejection이
 * unhandled rejection이 되지 않도록 소비하면서, 호출자에는 즉시 종료를 전달한다.
 */
function awaitWithAbort<T>(
    operation: Promise<T>,
    signal: AbortSignal
): Promise<T> {
    operation.catch(() => undefined);
    if (signal.aborted) return Promise.reject(signal.reason);

    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        operation.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', onAbort);
        });
    });
}

/**
 * 요청 전체 deadline과 프로세스 단위 동시성/대기열 제한을 provider 앞에 둔다.
 * 기본 provider는 env 기반 singleton GIS/NED 구성요소를 내부에서 사용한다.
 */
export function createPublicDataMcpRuntimeDependenciesV1(
    options: CreatePublicDataMcpRuntimeDependenciesOptionsV1 = {}
): PublicDataMcpServerDependencies {
    const now = options.now ?? Date.now;
    const provider = options.provider ?? createPublicDataMcpProviderV1({ now });
    const deadlineMs = positiveInteger(
        options.requestDeadlineMs,
        PUBLIC_DATA_MCP_REQUEST_DEADLINE_MS,
        5 * 60_000
    );
    const admission = new RequestAdmissionGate(
        positiveInteger(
            options.maxConcurrentRequests,
            PUBLIC_DATA_MCP_MAX_CONCURRENT_REQUESTS,
            16
        ),
        nonNegativeInteger(
            options.maxQueuedRequests,
            PUBLIC_DATA_MCP_MAX_QUEUED_REQUESTS,
            100
        )
    );

    return {
        now,
        async execute(
            tool: PublicDataMcpToolName,
            input: PublicDataMcpToolInput,
            context: PublicDataMcpCallContext
        ): Promise<PublicDataMcpResultV1> {
            const deadlineSignal = AbortSignal.timeout(deadlineMs);
            const signal = AbortSignal.any([context.signal, deadlineSignal]);
            let release: (() => void) | undefined;

            try {
                release = await admission.acquire(signal);
                const operation = Promise.resolve(provider.execute(
                    tool,
                    input,
                    { signal }
                ));
                // 호출자 deadline 뒤에도 signal 미지원 provider가 실행 중이면
                // admission slot을 먼저 풀지 않는다. 그렇지 않으면 timeout 요청을
                // 반복해 실제 upstream 동시성 상한을 우회할 수 있다.
                const releaseWhenSettled = release;
                release = undefined;
                void operation.finally(releaseWhenSettled).catch(() => undefined);
                return await awaitWithAbort(operation, signal);
            } catch (error) {
                if (deadlineSignal.aborted && !context.signal.aborted) {
                    throw new PublicDataMcpRuntimeError(
                        'REQUEST_DEADLINE_EXCEEDED'
                    );
                }
                if (context.signal.aborted) {
                    throw new PublicDataMcpRuntimeError('REQUEST_ABORTED');
                }
                if (isPublicDataMcpRuntimeError(error)) throw error;
                throw new PublicDataMcpRuntimeError('PROVIDER_REQUEST_FAILED');
            } finally {
                // provider 시작 전 예외와 admission 대기 중단에만 해당한다.
                release?.();
            }
        },
    };
}
