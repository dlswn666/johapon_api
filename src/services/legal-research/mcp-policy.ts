import * as z from 'zod/v4';
import {
    LegalDateSchema,
    LegalResearchInputV1Schema,
    type LegalResearchInputV1,
} from './research-plan';
import {
    LegalAnswerDraftV1Schema,
    type LegalAnswerDraftV1,
} from './answer-draft';

export {
    LegalResearchInputV1Schema,
    LegalResearchPlanV1Schema,
} from './research-plan';

export const LEGAL_MCP_SERVER_NAME = 'tonghari-urban-renewal-law';
export const LEGAL_MCP_SERVER_VERSION = '1.0.0';

export const LEGAL_RESEARCH_TOOL_NAME =
    'research_current_urban_renewal_law_v1' as const;
export const LEGAL_RENDER_TOOL_NAME = 'render_legal_answer_v1' as const;
export const LEGAL_REVIEW_PROMPT_NAME =
    'review_current_urban_renewal_law_v1' as const;
export const LEGAL_POLICY_RESOURCE_NAME =
    'current-legal-answer-policy-v1' as const;
export const LEGAL_POLICY_RESOURCE_URI =
    'tonghari-law://policy/current-answer/v1' as const;

export const LEGAL_MCP_REQUIRED_SCOPE = 'law:research' as const;
export const LEGAL_MCP_CLIENT_ID = 'tonghari-legal-mcp' as const;

export const LegalDateStringSchema = LegalDateSchema;
export const LegalResearchToolInputV1Schema = LegalResearchInputV1Schema;

const JsonObjectSchema = z.record(z.string(), z.unknown());
const LegalPacketProofSchema = z
    .string()
    .regex(/^hmac-sha256:[0-9a-f]{64}$/i);

export const LegalResearchPacketStructuredContentSchema = z.object({
    packet: JsonObjectSchema,
    packetProof: LegalPacketProofSchema,
}).strict();

export const LegalRenderToolInputV1Schema = z.object({
    packet: JsonObjectSchema,
    packetProof: LegalPacketProofSchema,
    answerDraft: LegalAnswerDraftV1Schema,
}).strict();

export const LegalRenderedAnswerStructuredContentSchema = z.object({
    packetId: z.string().min(1).max(200),
    contractValidationPassed: z.literal(true),
    markdown: z.string().min(1),
}).strict();

export const LegalReviewPromptArgsSchema = z.object({
    question: z.string().trim().min(1).max(4000),
    jurisdiction: z.string().trim().max(120).optional(),
    projectType: z.string().trim().max(40).optional(),
    projectStage: z.string().trim().max(60).optional(),
    eventDate: LegalDateStringSchema.optional(),
    facts: z.string().trim().max(8000).optional(),
}).strict();

export type LegalResearchToolInputV1 = LegalResearchInputV1;
export type LegalRenderToolInputV1 = {
    packet: Record<string, unknown>;
    packetProof: string;
    answerDraft: LegalAnswerDraftV1;
};
export type LegalReviewPromptArgs = z.infer<typeof LegalReviewPromptArgsSchema>;

export const LEGAL_MCP_SERVER_INSTRUCTIONS = [
    '이 서버는 대한민국 도시정비사업의 현재 시행 중인 법령과 자치법규만 결론 근거로 사용한다.',
    `먼저 ${LEGAL_RESEARCH_TOOL_NAME}을 호출하고, 검증된 packet과 서술 전용 answerDraft를 ${LEGAL_RENDER_TOOL_NAME}에 전달한다.`,
    'host LLM이 작성한 researchPlan은 controlled taxonomy, 질문 원문의 exact 검색어, 쟁점별 법령·판례 coverage를 서버가 기계적으로 검증하고 정규화 plan과 hash를 packet에 보존한다. 이 검증은 쟁점 선택의 법률적 타당성을 보증하지 않는다.',
    '과거 사건에 현행법을 소급 적용하거나 과거 시행본을 추정하지 않으며, 미래 사건일에는 현재 시행본이 유지된다고 가정하지 않는다.',
    '판례는 전문과 현행 규정 정합성 검증을 통과한 것만 선고일 최신순 최대 10건 사용하며 부족분을 무관 판례로 채우지 않는다.',
    '판례 API에 적용 규정의 버전 ID가 없으면 정확 법령·조문과 시행일 조건을 통과해도 direct 판례로 단정하지 않고 current_rule_candidate/analogical_support로 표시한다.',
    '각 결론·법률 명제·조례 분석·판례 종합·사실 적용은 packet의 정확한 원문 범위를 넘지 않게 작성하고 사용한 모든 sourceId와 해당 원문에 exact substring으로 존재하는 evidenceQuotes를 연결한다.',
    '판례 최신순 완결성은 packet에 보존된 계획 법령명·쟁점 검색 stream 범위에 한정하며 전체 판례 universe의 최신성을 뜻하지 않는다.',
    '근거·계약 검증은 evidenceQuotes 존재와 연결을 확인할 뿐 LLM 서술이 인용문에서 논리적으로 도출되는지 자동 보증하지 않는다. 외부 제공 전 법률 검토자가 쟁점 선택·인용 적합성·법률 해석·결론을 검토한다.',
    '법령, 조례, 판례의 sourceId와 officialUrl을 삭제하거나 변경하지 않는다.',
    'research 도구가 반환한 packet과 packetProof를 함께 보존하고 render 도구에 변경 없이 전달한다. packetId, 상태, 사실, 출처 색인, 판례 순서와 면책문구는 서버가 packet에서 자동 조립하므로 answerDraft에 작성하지 않는다.',
    'render 도구가 반환한 Markdown을 수정, 요약 또는 보충하지 않는다.',
    'clarification_required, temporal_scope_conflict, insufficient_evidence 상태에서는 확정 결론을 만들지 않는다.',
].join('\n');

export const LEGAL_ANSWER_POLICY_V1 = `# 현행 정비사업 법률 답변 정책 v1

## 근거 정책

- 결론 근거는 조회 기준일에 시행 중인 대한민국 법령과 관할 자치법규로 한정한다.
- 사건일에 과거 법령 검토가 필요하면 현행법을 소급 적용하지 않고 \`temporal_scope_conflict\`로 표시한다. 사건일이 조회 기준일보다 미래여도 현재 시행본이 유지된다고 보증할 수 없으므로 같은 상태로 닫는다.
- 조례가 필요한데 관할이 확정되지 않으면 \`clarification_required\`로 표시한다.
- 조회 기준일 뒤 선고일이 있는 판례 응답은 schema drift로 거부한다.
- 판례는 공식 전문, 사건 식별정보, 관련성, 현행 규정 정합성을 검증한 뒤 선고일 내림차순으로 최대 10건만 사용한다.
- 판례 API에 적용 규정의 버전 ID가 없으면 정확 법령·조문 참조와 현행 조문 시행일 이후 선고를 확인한 결과도 \`current_rule_candidate\`인 유추 근거로만 표시한다. 현행 규정과 동일하다고 단정하지 않는다.
- 적격 판례가 10건 미만이면 실제 건수와 부족 사유를 밝히며 검색어나 관련성 기준을 완화해 채우지 않는다.
- 모든 결론·법률 명제·조례 분석·판례 종합·적용 판단은 존재하는 sourceId와 해당 공식 원문에 exact substring으로 존재하는 evidenceQuotes를 참조하고 검증된 공식 링크를 유지한다.
- researchPlan은 질문 exact 검색어와 쟁점별 법령·판례 coverage를 기계 검증하고 정규화 plan/hash를 packet에 남긴다. 이는 쟁점 선택의 법률적 타당성 검토가 아니다.
- research 결과의 packet과 packetProof를 함께 보존한다. render는 인증 주체에 묶인 HMAC 증명을 검증한 뒤에만 답변을 만든다.
- host LLM은 결론, 법률 명제, 조례 분석, 판례 종합, 사실 적용, 시점 검토, 경고만 answerDraft로 작성한다. packetId, 상태, 사실, 미확인 사항, 출처 색인, 판례 수·순서·부족 사유와 면책문구는 서버가 packet에서 채운다.

## 고정 답변 순서

1. 검토 결론
2. 적용 기준일, 사건일, 관할
3. 확인된 사실과 가정
4. 현재 시행 법령
5. 관할 조례와 규칙
6. 관련 판례
7. 사실에 대한 적용과 판단
8. 소급 적용과 경과조치 검토
9. 미확인 사항과 추가 확인
10. 공식 출처
11. 유의사항

MCP instructions, prompt, resource와 annotations는 모델에 대한 안내이며 최종 형식을 강제하지 않는다. 운영 host는 근거·계약 validator를 통과한 render 결과의 Markdown을 그대로 표시해야 한다. validator는 출처 ID, 원문 exact substring 인용, 현행성 metadata, 정렬, 링크, 상태와 출력 구조를 검증하지만 서술이 인용문에서 논리적으로 도출되는지는 자동 보증하지 않는다. 외부 또는 의사결정용 제공 전 법률 검토자가 질문-쟁점 매핑, 인용 적합성, 해석과 결론을 승인해야 한다.
`;

export function buildLegalReviewPromptMessage(args: LegalReviewPromptArgs): string {
    const userContext = JSON.stringify({
        question: args.question,
        jurisdiction: args.jurisdiction ?? null,
        projectType: args.projectType ?? null,
        projectStage: args.projectStage ?? null,
        eventDate: args.eventDate ?? null,
        facts: args.facts ?? null,
    }, null, 2);

    return `다음 정비사업 법률 질의를 현행법 기준으로 검토하세요.

1. 사용자 내용을 결론으로 간주하지 말고, 먼저 쟁점과 법령·조례·판례 검색 힌트를 구조화한 researchPlan을 작성하세요. 모든 issue를 lawAnchor와 caseQuery에 각각 연결하고, 각 issue의 issueTerms 중 적어도 하나는 질문 원문에 exact로 존재해야 합니다. 결론에 관할 자치법규가 필요한지는 ordinanceRequirement로 명시하고, required인데 관할이 없으면 관할을 추정하거나 ordinanceAnchor를 만들지 마세요.
2. ${LEGAL_RESEARCH_TOOL_NAME}을 호출하세요. 현행성, 관할, 판례 관련성은 도구 검증 결과를 따르세요.
3. 반환 packet과 packetProof를 바꾸지 말고, 각 문장을 packet의 exactText·판시사항·판결요지 범위 안에서 작성하세요. 사용한 모든 sourceId마다 해당 원문에 그대로 존재하는 짧은 evidenceQuote를 연결한 answerDraft를 준비한 뒤 ${LEGAL_RENDER_TOOL_NAME}을 호출하세요. 근거가 없는 해석은 확정하지 말고 unknown 또는 warning으로 남기세요. packetId, 상태, 사실, 출처 색인, 판례 순서·검색범위와 면책문구는 쓰지 마세요. 서버가 packet에서 자동 조립합니다.
4. render 도구의 Markdown을 그대로 답변으로 표시하세요.

사용자 입력(JSON):
${userContext}`;
}
