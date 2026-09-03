import * as z from 'zod/v4';
import {
    LEGAL_ANSWER_VERSION,
    LEGAL_BLOCKING_UNKNOWN_CONCLUSION_TEXT,
    LEGAL_DISCLAIMER,
    type LegalAnswerV1,
    type LegalResearchPacketV1,
} from './model';
import { assertLegalAnswerV1 } from './validator';

/** LLM 서술 입력의 상한. 패킷 원문과 검색 감사 필드는 이 계약에 포함하지 않는다. */
export const LEGAL_ANSWER_DRAFT_LIMITS = {
    idLength: 120,
    sourceIdLength: 200,
    sourceRefsPerEntry: 16,
    evidenceQuoteLength: 500,
    evidenceQuotesPerEntry: 16,
    factRefsPerApplication: 16,
    conclusionTextLength: 1_500,
    ruleClaimCount: 16,
    ruleClaimTextLength: 1_500,
    ordinanceAnalysisCount: 12,
    ordinanceAnalysisTextLength: 1_500,
    caseSummaryLength: 2_500,
    applicationCount: 12,
    applicationIssueLength: 500,
    applicationInferenceLength: 2_000,
    applicationResultLength: 1_500,
    temporalSummaryLength: 2_000,
    warningCount: 12,
    warningCodeLength: 64,
    warningTextLength: 1_000,
} as const;

const DraftIdSchema = z
    .string()
    .trim()
    .min(1)
    .max(LEGAL_ANSWER_DRAFT_LIMITS.idLength)
    .regex(/^[A-Za-z0-9가-힣][A-Za-z0-9가-힣._:-]*$/)
    .describe('답변 내부에서 항목을 구분하는 짧고 유일한 식별자입니다.');

const SourceIdSchema = z
    .string()
    .trim()
    .min(1)
    .max(LEGAL_ANSWER_DRAFT_LIMITS.sourceIdLength)
    .describe('research packet에 실제 존재하는 sourceId만 그대로 사용합니다.');

const uniqueStringArray = (schema: z.ZodType<string>, max: number) =>
    z.array(schema)
        .max(max)
        .refine((values) => new Set(values).size === values.length, {
            message: '같은 식별자를 중복 참조할 수 없습니다.',
        });

const SourceIdsSchema = uniqueStringArray(
    SourceIdSchema,
    LEGAL_ANSWER_DRAFT_LIMITS.sourceRefsPerEntry
).describe('이 서술을 뒷받침하는 packet sourceId 목록이며 임의 식별자는 금지됩니다.');

const RequiredSourceIdsSchema = SourceIdsSchema
    .min(1)
    .describe('packet에 존재하는 sourceId를 하나 이상 참조해야 합니다.');

const EvidenceQuoteSchema = z
    .object({
        sourceId: SourceIdSchema.describe('인용문이 실제로 포함된 packet sourceId입니다.'),
        quote: z
            .string()
            .trim()
            .min(2)
            .max(LEGAL_ANSWER_DRAFT_LIMITS.evidenceQuoteLength)
            .describe('해당 source의 exactText, 판시사항 또는 판결요지에 그대로 존재하는 짧은 원문 부분문자열입니다.'),
    })
    .strict();

const EvidenceQuotesSchema = z
    .array(EvidenceQuoteSchema)
    .max(LEGAL_ANSWER_DRAFT_LIMITS.evidenceQuotesPerEntry)
    .refine(
        (values) => new Set(values.map((value) => `${value.sourceId}\u0000${value.quote}`)).size
            === values.length,
        { message: '같은 출처와 원문 인용을 중복할 수 없습니다.' }
    )
    .describe('각 인용은 참조 sourceId의 공식 원문에 exact substring으로 존재해야 합니다.');

const RequiredEvidenceQuotesSchema = EvidenceQuotesSchema
    .min(1)
    .describe('서술을 근거에 묶는 공식 원문 인용이 하나 이상 필요합니다.');

const ConclusionSchema = z
    .object({
        kind: z
            .enum(['supported', 'conditional', 'cannot_conclude'])
            .describe('complete이고 blocking 미확인 사항이 없을 때만 supported입니다. blocking 미확인 사항이 있으면 반드시 cannot_conclude를 사용하고, 차단 사유 없는 partial에만 conditional을 사용할 수 있습니다.'),
        text: z
            .string()
            .trim()
            .min(1)
            .max(LEGAL_ANSWER_DRAFT_LIMITS.conclusionTextLength)
            .describe('검토 결과를 먼저 제시하는 간결한 결론 문장입니다. blocking 미확인 사항이 있으면 서버 고정 유보 문장으로 교체됩니다.'),
        sourceIds: SourceIdsSchema.describe('결론을 직접 뒷받침하는 packet sourceId 목록입니다.'),
        evidenceQuotes: EvidenceQuotesSchema.describe('결론을 직접 뒷받침하는 공식 원문 인용입니다.'),
    })
    .strict()
    .superRefine((conclusion, context) => {
        if (conclusion.kind !== 'cannot_conclude' && conclusion.sourceIds.length === 0) {
            context.addIssue({
                code: 'custom',
                path: ['sourceIds'],
                message: 'supported 또는 conditional 결론은 sourceId를 참조해야 합니다.',
            });
        }
        if (conclusion.kind !== 'cannot_conclude' && conclusion.evidenceQuotes.length === 0) {
            context.addIssue({
                code: 'custom',
                path: ['evidenceQuotes'],
                message: 'supported 또는 conditional 결론은 공식 원문 인용이 필요합니다.',
            });
        }
    })
    .describe('결론 종류, 결론 문장, 직접 근거를 함께 작성합니다.');

const RuleClaimSchema = z
    .object({
        claimId: DraftIdSchema.describe('법률 명제의 답변 내부 식별자입니다.'),
        text: z
            .string()
            .trim()
            .min(1)
            .max(LEGAL_ANSWER_DRAFT_LIMITS.ruleClaimTextLength)
            .describe('현행 법령 근거에서 확인되는 법률 명제를 사실과 추론 없이 적습니다.'),
        sourceIds: RequiredSourceIdsSchema.describe('이 명제를 입증하는 packet의 law sourceId만 사용합니다.'),
        evidenceQuotes: RequiredEvidenceQuotesSchema,
    })
    .strict()
    .describe('현행 법령의 법률 명제와 그 sourceId 근거입니다.');

const OrdinanceAnalysisSchema = z
    .object({
        analysisId: DraftIdSchema.describe('조례 분석의 답변 내부 식별자입니다.'),
        text: z
            .string()
            .trim()
            .min(1)
            .max(LEGAL_ANSWER_DRAFT_LIMITS.ordinanceAnalysisTextLength)
            .describe('질문 관할에 exact 일치한 현행 자치법규의 의미를 정리합니다.'),
        sourceIds: RequiredSourceIdsSchema.describe('이 분석에 사용한 packet의 ordinance sourceId만 사용합니다.'),
        evidenceQuotes: RequiredEvidenceQuotesSchema,
    })
    .strict()
    .describe('관할 자치법규 분석과 그 sourceId 근거입니다.');

const ApplicationSchema = z
    .object({
        applicationId: DraftIdSchema.describe('사실 적용 판단의 답변 내부 식별자입니다.'),
        issue: z
            .string()
            .trim()
            .min(1)
            .max(LEGAL_ANSWER_DRAFT_LIMITS.applicationIssueLength)
            .describe('사실에 적용할 구체적인 법적 쟁점입니다.'),
        factIds: uniqueStringArray(
            DraftIdSchema,
            LEGAL_ANSWER_DRAFT_LIMITS.factRefsPerApplication
        )
            .min(1)
            .describe('research packet의 facts에 실제 존재하는 factId만 사용합니다.'),
        sourceIds: RequiredSourceIdsSchema.describe('적용 판단의 근거가 되는 packet sourceId 목록입니다.'),
        evidenceQuotes: RequiredEvidenceQuotesSchema,
        inference: z
            .string()
            .trim()
            .min(1)
            .max(LEGAL_ANSWER_DRAFT_LIMITS.applicationInferenceLength)
            .describe('사실과 근거 사이의 추론을 결론과 분리해 적습니다.'),
        result: z
            .string()
            .trim()
            .min(1)
            .max(LEGAL_ANSWER_DRAFT_LIMITS.applicationResultLength)
            .describe('해당 쟁점에 대한 적용 결과입니다.'),
        temporalApplicability: z
            .enum([
                'current_rule_applies',
                'historical_review_required',
                'unknown',
            ])
            .describe('사건일과 참조한 조문별 시행일을 비교해 표시합니다. 사건일이 없거나 packet이 temporal_scope_conflict이면 current_rule_applies를 사용하지 않습니다.'),
        confidence: z
            .enum(['high', 'medium', 'low'])
            .describe('확인된 사실과 공식 근거에 따른 정성적 확실성입니다. unverified 또는 disputed fact를 하나라도 참조하면 high를 사용하지 않습니다.'),
    })
    .strict()
    .describe('packet 사실에 공식 근거를 적용한 판단과 추론입니다.');

const TemporalReviewSchema = z
    .object({
        summary: z
            .string()
            .trim()
            .min(1)
            .max(LEGAL_ANSWER_DRAFT_LIMITS.temporalSummaryLength)
            .describe('사건일, 조문별 시행일, 부칙과 경과조치 검토 결과입니다.'),
        sourceIds: SourceIdsSchema.describe('시점 판단에 사용한 packet sourceId 목록입니다.'),
        evidenceQuotes: EvidenceQuotesSchema.describe('시점 판단을 뒷받침하는 공식 원문 인용입니다.'),
        historicalLawRequired: z
            .boolean()
            .describe('사건 당시 시행본을 추가 확인해야 하면 true이며 현행법을 소급 적용하지 않습니다.'),
    })
    .strict()
    .describe('소급 적용 가능성과 과거 법령 추가 확인 필요 여부입니다.');

const WarningSchema = z
    .object({
        code: z
            .string()
            .trim()
            .min(1)
            .max(LEGAL_ANSWER_DRAFT_LIMITS.warningCodeLength)
            .regex(/^[A-Z][A-Z0-9_]*$/)
            .describe('경고를 식별하는 대문자 snake-case 코드입니다.'),
        text: z
            .string()
            .trim()
            .min(1)
            .max(LEGAL_ANSWER_DRAFT_LIMITS.warningTextLength)
            .describe('결론을 읽을 때 함께 확인해야 하는 짧은 경고 문장입니다.'),
    })
    .strict()
    .describe('답변에 함께 표시할 비차단 경고입니다.');

/**
 * Host LLM이 작성할 수 있는 서술 필드만 허용한다.
 * packetId, status, scope, facts, sources, 판례 수 같은 근거 필드는 strict 계약 밖이다.
 */
export const LegalAnswerDraftV1Schema = z
    .object({
        conclusion: ConclusionSchema.describe('packet 상태와 근거에 맞는 검토 결론입니다.'),
        ruleClaims: z
            .array(RuleClaimSchema)
            .max(LEGAL_ANSWER_DRAFT_LIMITS.ruleClaimCount)
            .describe('현행 법령에서 확인한 명제 목록입니다.'),
        ordinanceAnalysis: z
            .array(OrdinanceAnalysisSchema)
            .max(LEGAL_ANSWER_DRAFT_LIMITS.ordinanceAnalysisCount)
            .describe('exact 관할 현행 자치법규 분석 목록입니다.'),
        caseSummary: z
            .string()
            .trim()
            .min(1)
            .max(LEGAL_ANSWER_DRAFT_LIMITS.caseSummaryLength)
            .describe('packet cases 전체를 제공된 최신순 그대로 종합합니다. 판례 순서, returnedCount, sourceIds, 부족 사유와 upstream 최신순 완결성은 서버가 자동으로 채웁니다.'),
        caseEvidenceQuotes: EvidenceQuotesSchema.describe('판례 종합에 사용한 판시사항·판결요지의 공식 원문 인용입니다. 판례가 있으면 하나 이상 필요합니다.'),
        applications: z
            .array(ApplicationSchema)
            .max(LEGAL_ANSWER_DRAFT_LIMITS.applicationCount)
            .describe('packet factId와 sourceId를 연결한 사실 적용 판단 목록입니다. blocking 미확인 사항이 있으면 서버가 렌더링 전에 비웁니다.'),
        temporalReview: TemporalReviewSchema.describe('사건일과 시행일을 비교한 시점 검토입니다.'),
        warnings: z
            .array(WarningSchema)
            .max(LEGAL_ANSWER_DRAFT_LIMITS.warningCount)
            .describe('답변에 표시할 비차단 경고 목록입니다.'),
    })
    .strict()
    .superRefine((draft, context) => {
        if (draft.conclusion.kind === 'supported' && draft.ruleClaims.length === 0) {
            context.addIssue({
                code: 'custom',
                path: ['ruleClaims'],
                message: 'supported 결론에는 공식 원문에 묶인 법률 명제가 하나 이상 필요합니다.',
            });
        }
    })
    .describe('Host LLM은 이 서술 필드만 작성하며 packet의 불변 근거 필드는 서버가 채웁니다.');

export type LegalAnswerDraftV1 = z.infer<typeof LegalAnswerDraftV1Schema>;

/**
 * 패킷 불변 필드는 서버 소유 packet에서만 복사하고, LLM draft는 서술 필드로 제한한다.
 */
export function buildLegalAnswerFromDraftV1(
    packet: LegalResearchPacketV1,
    draftInput: unknown
): LegalAnswerV1 {
    const draft = LegalAnswerDraftV1Schema.parse(draftInput);
    const hasBlockingUnknown = packet.unknowns.some((unknown) => unknown.blocking);
    const useServerControlledDeferral = hasBlockingUnknown
        && draft.conclusion.kind === 'cannot_conclude';
    const answer: LegalAnswerV1 = {
        contractVersion: LEGAL_ANSWER_VERSION,
        packetId: packet.packetId,
        status: packet.status,
        conclusion: useServerControlledDeferral
            ? {
                kind: 'cannot_conclude',
                text: LEGAL_BLOCKING_UNKNOWN_CONCLUSION_TEXT,
                sourceIds: [],
                evidenceQuotes: [],
            }
            : draft.conclusion,
        scope: structuredClone(packet.scope),
        facts: structuredClone(packet.facts),
        ruleClaims: draft.ruleClaims,
        ordinanceAnalysis: draft.ordinanceAnalysis,
        caseSynthesis: {
            returnedCount: packet.cases.length,
            summary: packet.cases.length === 0
                ? '검증 조건을 충족한 반환 판례가 없습니다.'
                : draft.caseSummary,
            sourceIds: packet.cases.map((legalCase) => legalCase.sourceId),
            shortfallReason: packet.caseSearchAudit.shortfallReason,
            upstreamComplete: packet.caseSearchAudit.upstreamComplete,
            evidenceQuotes: draft.caseEvidenceQuotes,
            searchScope: {
                normalizedPlanHash: packet.planCoverageAudit.normalizedPlanHash,
                lawNameQueries: structuredClone(packet.caseSearchAudit.lawNameQueries),
                issueQueries: structuredClone(packet.caseSearchAudit.issueQueries),
            },
        },
        applications: useServerControlledDeferral ? [] : draft.applications,
        temporalReview: draft.temporalReview,
        unknowns: structuredClone(packet.unknowns),
        warnings: draft.warnings,
        sourceIndex: structuredClone([
            ...packet.laws,
            ...packet.ordinances,
            ...packet.cases,
        ]),
        disclaimer: LEGAL_DISCLAIMER,
    };
    return assertLegalAnswerV1(answer, packet);
}
