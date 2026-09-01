import { renderLegalAnswerV1 } from './answer-renderer';
import { buildLegalAnswerFromDraftV1 } from './answer-draft';
import { LegalOpenApiError } from './errors';
import { LawOpenApiClient } from './law-open-api-client';
import type { LegalAnswerV1, LegalResearchPacketV1 } from './model';
import type { LegalResearchToolInputV1 } from './mcp-policy';
import type { LegalMcpServerDependencies } from './mcp-server';
import { LegalResearchOrchestratorV1 } from './research-orchestrator';
import {
    validateLegalAnswerV1,
    validateLegalResearchPacketV1,
} from './validator';

export interface CreateLegalMcpRuntimeDependenciesOptionsV1 {
    lawApiOc?: string;
    researchDeadlineMs?: number;
    maxConcurrentResearch?: number;
    maxQueuedResearch?: number;
    orchestrator?: {
        research(
            input: LegalResearchToolInputV1,
            signal?: AbortSignal
        ): Promise<LegalResearchPacketV1>;
    };
}

export const LEGAL_MCP_RESEARCH_DEADLINE_MS = 45_000;
export const LEGAL_MCP_MAX_CONCURRENT_RESEARCH = 2;
export const LEGAL_MCP_MAX_QUEUED_RESEARCH = 4;

interface AdmissionWaiter {
    signal: AbortSignal;
    onAbort: () => void;
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
}

class ResearchAdmissionGate {
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
            throw new LegalOpenApiError('RATE_LIMITED');
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

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
        throw new Error('법률 MCP research 운영 상한 설정이 올바르지 않습니다.');
    }
    return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, maximum: number): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > maximum) {
        throw new Error('법률 MCP research 대기열 설정이 올바르지 않습니다.');
    }
    return resolved;
}

/**
 * 법제처 고정-IP provider와 순수 도메인 validator/renderer를 MCP 전송 계층에 연결한다.
 */
export function createLegalMcpRuntimeDependenciesV1(
    options: CreateLegalMcpRuntimeDependenciesOptionsV1 = {}
): Omit<LegalMcpServerDependencies, 'packetSigningKey'> {
    const orchestrator = options.orchestrator ?? new LegalResearchOrchestratorV1({
        provider: new LawOpenApiClient({ oc: options.lawApiOc }),
    });
    const deadlineMs = positiveInteger(
        options.researchDeadlineMs,
        LEGAL_MCP_RESEARCH_DEADLINE_MS,
        5 * 60_000
    );
    const admission = new ResearchAdmissionGate(
        positiveInteger(
            options.maxConcurrentResearch,
            LEGAL_MCP_MAX_CONCURRENT_RESEARCH,
            16
        ),
        nonNegativeInteger(
            options.maxQueuedResearch,
            LEGAL_MCP_MAX_QUEUED_RESEARCH,
            100
        )
    );

    return {
        async research(input, context) {
            const deadlineSignal = AbortSignal.timeout(deadlineMs);
            const signal = AbortSignal.any([context.signal, deadlineSignal]);
            let release: (() => void) | undefined;
            try {
                release = await admission.acquire(signal);
                return await orchestrator.research(input, signal);
            } catch (error) {
                if (deadlineSignal.aborted && !context.signal.aborted) {
                    throw new LegalOpenApiError('UPSTREAM_TIMEOUT');
                }
                throw error;
            } finally {
                release?.();
            }
        },
        validatePacket(packet) {
            return validateLegalResearchPacketV1(packet);
        },
        buildAnswer(packet, answerDraft) {
            return buildLegalAnswerFromDraftV1(
                packet as LegalResearchPacketV1,
                answerDraft
            );
        },
        validateAnswer(answer, packet) {
            return validateLegalAnswerV1(answer, packet);
        },
        render(packet, answer) {
            return renderLegalAnswerV1(
                packet as LegalResearchPacketV1,
                answer as LegalAnswerV1
            );
        },
    };
}
