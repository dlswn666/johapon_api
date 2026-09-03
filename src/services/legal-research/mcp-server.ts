import {
    McpServer,
    type AuthInfo,
    type CallToolResult,
    type ServerContext,
} from '@modelcontextprotocol/server';
import {
    LEGAL_ANSWER_POLICY_V1,
    LEGAL_MCP_REQUIRED_SCOPE,
    LEGAL_MCP_SERVER_INSTRUCTIONS,
    LEGAL_MCP_SERVER_NAME,
    LEGAL_MCP_SERVER_VERSION,
    LEGAL_POLICY_RESOURCE_NAME,
    LEGAL_POLICY_RESOURCE_URI,
    LEGAL_RENDER_TOOL_NAME,
    LEGAL_RESEARCH_TOOL_NAME,
    LEGAL_REVIEW_PROMPT_NAME,
    LegalRenderedAnswerStructuredContentSchema,
    LegalRenderToolInputV1Schema,
    LegalResearchPacketStructuredContentSchema,
    LegalResearchToolInputV1Schema,
    LegalReviewPromptArgsSchema,
    buildLegalReviewPromptMessage,
    type LegalResearchToolInputV1,
} from './mcp-policy';
import {
    createLegalPacketProofV1,
    packetProofSubjectV1,
    verifyLegalPacketProofV1,
} from './packet-proof';
import {
    isLegalOpenApiError,
    safeLegalOpenApiMessage,
} from './errors';
import { toKoreanDate } from './clock';
import { LEGAL_RESEARCH_PACKET_MAX_BYTES } from './model';

type MaybePromise<T> = T | Promise<T>;
type JsonObject = Record<string, unknown>;

export const LEGAL_MCP_MAX_PACKET_BYTES = LEGAL_RESEARCH_PACKET_MAX_BYTES;
export const LEGAL_MCP_PACKET_MAX_AGE_MS = 30 * 60 * 1000;
const LEGAL_MCP_PACKET_FUTURE_SKEW_MS = 5 * 60 * 1000;

class LegalMcpPacketTooLargeError extends Error {
    constructor() {
        super('Legal research packet exceeds the transport budget.');
        this.name = 'LegalMcpPacketTooLargeError';
    }
}

class LegalMcpPacketStaleError extends Error {
    constructor() {
        super('Legal research packet is stale or has an invalid research timestamp.');
        this.name = 'LegalMcpPacketStaleError';
    }
}

export interface LegalMcpPrincipal {
    clientId: string;
    scopes: readonly string[];
    tokenId: string;
}

export interface LegalMcpCallContext {
    principal: LegalMcpPrincipal;
    signal: AbortSignal;
}

export interface LegalMcpValidationResult {
    ok: boolean;
    valid: boolean;
    value?: unknown;
    errors?: readonly unknown[];
    issues?: readonly unknown[];
}

/**
 * provider/validator/renderer 구현과 MCP 전송 계층 사이의 최소 경계다.
 *
 * validator는 도메인 validator의 `{ ok, valid, value }` 결과를 그대로 반환할
 * 수 있다. adapter validator는 정규화한 객체/undefined를 반환하거나 유효하지
 * 않을 때 예외를 던져도 된다.
 */
export interface LegalMcpServerDependencies {
    /** 운영에서는 LEGAL_MCP_PACKET_SIGNING_KEY를 전달한다. */
    packetSigningKey: string;
    /** 패킷 freshness 검증용 epoch milliseconds clock. */
    now?: () => number;
    research(
        input: LegalResearchToolInputV1,
        context: LegalMcpCallContext
    ): MaybePromise<unknown>;
    buildAnswer(
        packet: unknown,
        answerDraft: unknown,
        context: LegalMcpCallContext
    ): MaybePromise<unknown>;
    validatePacket(
        packet: unknown
    ): MaybePromise<LegalMcpValidationResult | unknown | void>;
    validateAnswer(
        answer: unknown,
        packet: unknown
    ): MaybePromise<LegalMcpValidationResult | unknown | void>;
    render(
        packet: unknown,
        answer: unknown,
        context: LegalMcpCallContext
    ): MaybePromise<string | { markdown: string }>;
}

function toolError(code: string, message: string): CallToolResult {
    return {
        content: [{
            type: 'text',
            text: JSON.stringify({ code, message }),
        }],
        isError: true,
    };
}

function getCallContext(context: ServerContext): LegalMcpCallContext | null {
    const authInfo = context.http?.authInfo;
    const tokenId = authInfo?.extra?.tokenId;
    if (
        !authInfo
        || !authInfo.scopes.includes(LEGAL_MCP_REQUIRED_SCOPE)
        || typeof tokenId !== 'string'
        || !/^[0-9a-f]{64}$/i.test(tokenId)
    ) {
        return null;
    }

    return {
        principal: {
            clientId: authInfo.clientId,
            scopes: [...authInfo.scopes],
            tokenId,
        },
        signal: context.mcpReq.signal,
    };
}

function asJsonObject(value: unknown): JsonObject {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new Error('Value is not JSON serializable.');
    }

    const parsed: unknown = JSON.parse(serialized);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('Value must be a JSON object.');
    }

    return parsed as JsonObject;
}

function asBoundedPacket(value: unknown): JsonObject {
    const packet = asJsonObject(value);
    if (Buffer.byteLength(JSON.stringify(packet), 'utf8') > LEGAL_MCP_MAX_PACKET_BYTES) {
        throw new LegalMcpPacketTooLargeError();
    }
    return packet;
}

function assertFreshPacket(packet: JsonObject, now: number): void {
    const provenance = packet.provenance;
    const scope = packet.scope;
    const generatedAt = provenance !== null && !Array.isArray(provenance)
        && typeof provenance === 'object'
        ? (provenance as JsonObject).generatedAt
        : undefined;
    const asOfDate = scope !== null && !Array.isArray(scope) && typeof scope === 'object'
        ? (scope as JsonObject).asOfDate
        : undefined;
    const generatedAtMs = typeof generatedAt === 'string' ? Date.parse(generatedAt) : Number.NaN;
    const currentDate = new Date(now);
    const age = now - generatedAtMs;

    if (
        !Number.isFinite(now)
        || Number.isNaN(generatedAtMs)
        || age > LEGAL_MCP_PACKET_MAX_AGE_MS
        || age < -LEGAL_MCP_PACKET_FUTURE_SKEW_MS
        || typeof asOfDate !== 'string'
        || asOfDate !== toKoreanDate(currentDate)
    ) {
        throw new LegalMcpPacketStaleError();
    }
}

function isValidationResult(value: unknown): value is LegalMcpValidationResult {
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    return typeof candidate.ok === 'boolean'
        && typeof candidate.valid === 'boolean';
}

function unwrapValidatedValue(
    original: unknown,
    validatorOutput: LegalMcpValidationResult | unknown | void
): unknown {
    if (validatorOutput === undefined) return original;
    if (!isValidationResult(validatorOutput)) return validatorOutput;
    if (validatorOutput.ok !== true || validatorOutput.valid !== true) {
        throw new Error('Evidence and contract validation failed.');
    }
    return validatorOutput.value === undefined
        ? original
        : validatorOutput.value;
}

function packetIdOf(value: JsonObject): string | null {
    return typeof value.packetId === 'string' && value.packetId.length > 0
        ? value.packetId
        : null;
}

function markdownOf(value: string | { markdown: string }): string {
    const markdown = typeof value === 'string' ? value : value.markdown;
    if (typeof markdown !== 'string' || markdown.trim().length === 0) {
        throw new Error('Renderer returned empty Markdown.');
    }
    return markdown;
}

function principalFromAuthInfo(authInfo: AuthInfo): LegalMcpPrincipal {
    const tokenId = authInfo.extra?.tokenId;
    if (typeof tokenId !== 'string' || !/^[0-9a-f]{64}$/i.test(tokenId)) {
        throw new Error('Legal MCP AuthInfo tokenId is missing.');
    }
    return {
        clientId: authInfo.clientId,
        scopes: [...authInfo.scopes],
        tokenId,
    };
}

/**
 * 요청마다 새 인스턴스를 만들어도 같은 공개 surface가 등록되는 순수 factory다.
 */
export function createLegalMcpServer(
    dependencies: LegalMcpServerDependencies
): McpServer {
    const server = new McpServer(
        {
            name: LEGAL_MCP_SERVER_NAME,
            version: LEGAL_MCP_SERVER_VERSION,
        },
        {
            instructions: LEGAL_MCP_SERVER_INSTRUCTIONS,
        }
    );

    server.registerTool(
        LEGAL_RESEARCH_TOOL_NAME,
        {
            title: '현행 정비사업 법률 근거 조사',
            description:
                'host LLM이 작성한 구조화 researchPlan을 검증 가능한 검색 힌트로 사용해 현재 시행 법령, 관할 조례와 관련 최신 판례의 근거 패킷을 만든다. 검색 계획은 현행성, 관할, 판례 관련성 또는 공식 링크를 확정하지 않는다.',
            inputSchema: LegalResearchToolInputV1Schema,
            outputSchema: LegalResearchPacketStructuredContentSchema,
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: true,
            },
        },
        async (input, context): Promise<CallToolResult> => {
            const callContext = getCallContext(context);
            if (!callContext) {
                return toolError(
                    'INSUFFICIENT_SCOPE',
                    `${LEGAL_MCP_REQUIRED_SCOPE} 권한이 필요합니다.`
                );
            }

            try {
                const candidate = await dependencies.research(input, callContext);
                const validated = await dependencies.validatePacket(candidate);
                const packet = asBoundedPacket(
                    unwrapValidatedValue(candidate, validated)
                );
                assertFreshPacket(packet, (dependencies.now ?? Date.now)());
                const packetProof = createLegalPacketProofV1(
                    packet,
                    packetProofSubjectV1(
                        callContext.principal.clientId,
                        callContext.principal.tokenId
                    ),
                    dependencies.packetSigningKey
                );
                const output = { packet, packetProof };

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(output),
                    }],
                    structuredContent: output,
                };
            } catch (error) {
                if (error instanceof LegalMcpPacketTooLargeError) {
                    return toolError(
                        'LEGAL_PACKET_TOO_LARGE',
                        '근거 패킷이 전송 한도를 초과했습니다. 법령·조문 anchor를 쟁점별로 좁혀 다시 조사하세요.'
                    );
                }
                if (error instanceof LegalMcpPacketStaleError) {
                    return toolError(
                        'LEGAL_PACKET_STALE',
                        '근거 패킷의 기준일 또는 생성시각이 현재 조사와 일치하지 않습니다. 다시 조사하세요.'
                    );
                }
                if (isLegalOpenApiError(error)) {
                    return toolError(
                        error.code,
                        safeLegalOpenApiMessage(error.code)
                    );
                }
                return toolError(
                    'LEGAL_RESEARCH_FAILED',
                    '공식 근거 패킷을 안전하게 생성하거나 검증하지 못했습니다.'
                );
            }
        }
    );

    server.registerTool(
        LEGAL_RENDER_TOOL_NAME,
        {
            title: '정형 법률 답변 렌더링',
            description:
                '검증된 LegalResearchPacket과 서술 전용 answerDraft로 LegalAnswer를 서버에서 조립하고 근거·계약 validator에 통과시킨 뒤 고정 순서의 한국어 Markdown으로 렌더링한다. packetId, 상태, 사실, 출처 색인, 판례 수·순서와 면책문구는 packet에서 자동 고정한다. 이 validator는 LLM 법률 해석의 타당성을 자동 보증하지 않는다.',
            inputSchema: LegalRenderToolInputV1Schema,
            outputSchema: LegalRenderedAnswerStructuredContentSchema,
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({ packet: packetInput, packetProof, answerDraft }, context): Promise<CallToolResult> => {
            const callContext = getCallContext(context);
            if (!callContext) {
                return toolError(
                    'INSUFFICIENT_SCOPE',
                    `${LEGAL_MCP_REQUIRED_SCOPE} 권한이 필요합니다.`
                );
            }

            try {
                const proofSubject = packetProofSubjectV1(
                    callContext.principal.clientId,
                    callContext.principal.tokenId
                );
                if (!verifyLegalPacketProofV1(
                    packetInput,
                    packetProof,
                    proofSubject,
                    dependencies.packetSigningKey
                )) {
                    return toolError(
                        'PACKET_PROOF_INVALID',
                        '조사 패킷의 무결성 증명을 확인하지 못했습니다.'
                    );
                }

                const validatedPacket = await dependencies.validatePacket(packetInput);
                const packet = asBoundedPacket(
                    unwrapValidatedValue(packetInput, validatedPacket)
                );
                assertFreshPacket(packet, (dependencies.now ?? Date.now)());
                const answerCandidate = await dependencies.buildAnswer(
                    packet,
                    answerDraft,
                    callContext
                );
                const validatedAnswer = await dependencies.validateAnswer(
                    answerCandidate,
                    packet
                );
                const answer = asJsonObject(
                    unwrapValidatedValue(answerCandidate, validatedAnswer)
                );
                const packetId = packetIdOf(packet);
                const answerPacketId = packetIdOf(answer);

                if (!packetId || !answerPacketId || packetId !== answerPacketId) {
                    return toolError(
                        'PACKET_ANSWER_MISMATCH',
                        'packet과 LegalAnswer의 packetId가 일치해야 합니다.'
                    );
                }

                const markdown = markdownOf(
                    await dependencies.render(packet, answer, callContext)
                );
                const output = {
                    packetId,
                    contractValidationPassed: true as const,
                    markdown,
                };

                return {
                    content: [
                        {
                            type: 'text',
                            text: markdown,
                            annotations: {
                                audience: ['user'],
                                priority: 1,
                            },
                        },
                        {
                            type: 'text',
                            text: JSON.stringify(output),
                            annotations: {
                                audience: ['assistant'],
                                priority: 0,
                            },
                        },
                    ],
                    structuredContent: output,
                };
            } catch (error) {
                if (error instanceof LegalMcpPacketStaleError) {
                    return toolError(
                        'LEGAL_PACKET_STALE',
                        '근거 패킷의 기준일 또는 생성시각이 현재 조사와 일치하지 않습니다. 다시 조사하세요.'
                    );
                }
                return toolError(
                    'LEGAL_RENDER_FAILED',
                    '법률 답변을 안전하게 검증하거나 렌더링하지 못했습니다.'
                );
            }
        }
    );

    server.registerPrompt(
        LEGAL_REVIEW_PROMPT_NAME,
        {
            title: '현행 정비사업 법률 검토',
            description:
                '각 판례 query를 정확히 하나의 issue와 하나의 법령에 연결한 구조화 조사계획을 만든 뒤 근거 조사와 고정 형식 렌더링 도구를 순서대로 호출한다.',
            argsSchema: LegalReviewPromptArgsSchema,
        },
        (args) => ({
            messages: [{
                role: 'user' as const,
                content: {
                    type: 'text' as const,
                    text: buildLegalReviewPromptMessage(args),
                },
            }],
        })
    );

    server.registerResource(
        LEGAL_POLICY_RESOURCE_NAME,
        LEGAL_POLICY_RESOURCE_URI,
        {
            title: '현행 정비사업 법률 답변 정책 v4',
            description: '근거 선별, 상태 판정, 인용과 고정 답변 순서',
            mimeType: 'text/markdown',
            annotations: {
                audience: ['assistant'],
                priority: 1,
                lastModified: '2026-09-03T00:00:00+09:00',
            },
        },
        async (uri) => ({
            contents: [{
                uri: uri.href,
                mimeType: 'text/markdown',
                text: LEGAL_ANSWER_POLICY_V1,
            }],
        })
    );

    return server;
}

/** 테스트와 host adapter가 raw AuthInfo를 전달하지 않고 principal만 만들 때 사용한다. */
export const legalMcpPrincipalFromAuthInfo = principalFromAuthInfo;
