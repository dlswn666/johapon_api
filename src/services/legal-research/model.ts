/**
 * 정비사업 법률 조사와 답변 사이의 순수 도메인 계약이다.
 *
 * provider/MCP 전송 계층과 분리해 fixture만으로 현행성, 관할, 판례 선정,
 * 출처 참조 및 렌더링 규칙을 검증할 수 있게 한다.
 */

import type { LegalResearchPlanV1 } from './research-plan';

export const LEGAL_RESEARCH_PACKET_VERSION = 'LegalResearchPacketV1' as const;
export const LEGAL_ANSWER_VERSION = 'LegalAnswerV1' as const;
export const LEGAL_POLICY_VERSION = 'current-law-policy.v4' as const;
/** MCP packet/proof 전송 전 서버와 domain validator가 함께 적용하는 UTF-8 상한. */
export const LEGAL_RESEARCH_PACKET_MAX_BYTES = 128 * 1024;
/** 사용자가 요청한 "10건 초과" 목록을 제공하기 위한 운영 목표 상한. */
export const MAX_RELEVANT_CASES = 12;
/** 결론·동일 쟁점 근거와 격리해 표시하는 검색상 최신 판례 검토 후보 상한. */
export const MAX_CASE_REVIEW_CANDIDATES = 12;
/** UTF-8 128KiB 전송 예산을 지키기 위한 후보별 쟁점 증거 상한. */
export const MAX_CASE_REVIEW_MATCHES_PER_CANDIDATE = 2;
/** 결론 판례의 공식 판시사항·판결요지 또는 전문 발췌별 문자 상한. */
export const MAX_CASE_SOURCE_TEXT_CHARS = 500;
/** 검토 판례의 법령·쟁점 문맥 exact substring별 문자 상한. */
export const MAX_CASE_REVIEW_EXCERPT_CHARS = 300;

export const LEGAL_DISCLAIMER =
    '이 답변은 국가법령정보센터의 현행 법령·자치법규·판례를 바탕으로 근거와 형식을 검증해 정리한 일반 정보입니다. 이 검증은 LLM이 작성한 법률 해석의 타당성을 자동 보증하지 않으며, 구체적 사건에 대한 법률자문을 대신하지 않습니다.';

/** blocking 미확인 사항이 남은 답변에는 host 서술 대신 이 문장만 사용한다. */
export const LEGAL_BLOCKING_UNKNOWN_CONCLUSION_TEXT =
    '필수 미확인 사항이 해결되지 않아 이 질문의 결론을 확정할 수 없습니다. 미확인 사항을 확인한 뒤 다시 검토해야 합니다.';

export const LEGAL_ANSWER_SECTION_HEADINGS = [
    '## 1. 검토 결론',
    '## 2. 적용 기준일·사건일·관할',
    '## 3. 확인된 사실과 가정',
    '## 4. 현재 시행 법령',
    '## 5. 관할 조례·규칙',
    '## 6. 관련 판례',
    '## 7. 사실에 대한 적용과 판단',
    '## 8. 소급 적용·경과조치 검토',
    '## 9. 미확인 사항과 추가 확인',
    '## 10. 공식 출처',
    '## 11. 유의사항',
] as const;

export type LegalResearchStatusV1 =
    | 'complete'
    | 'partial'
    | 'clarification_required'
    | 'temporal_scope_conflict'
    | 'insufficient_evidence';

export type ProjectTypeV1 =
    | 'redevelopment'
    | 'reconstruction'
    | 'small_scale_renewal'
    | 'other';

export type ProjectStageV1 =
    | 'renewal_plan'
    | 'promotion_committee'
    | 'association_establishment'
    | 'project_implementation'
    | 'management_disposition'
    | 'liquidation'
    | 'other';

export interface LocalAuthorityRefV1 {
    code: string;
    name: string;
    level: 'metropolitan' | 'basic';
}

export interface LegalResearchScopeV1 {
    countryCode: 'KR';
    asOfDate: string;
    eventDate: string | null;
    eventDateRequired: boolean;
    localAuthorities: LocalAuthorityRefV1[];
    lawVersionPolicy: 'effective_current_only';
    projectType?: ProjectTypeV1;
    projectStage?: ProjectStageV1;
}

export interface LegalFactV1 {
    factId: string;
    text: string;
    origin: 'user' | 'official_record' | 'assumption';
    verification: 'verified' | 'unverified' | 'disputed';
}

export interface ProvisionLocatorV1 {
    article: string;
    paragraph?: string;
    item?: string;
    subitem?: string;
    addendum?: string;
    appendix?: string;
}

export interface SourceBaseV1 {
    sourceId: string;
    sourceType: 'law' | 'ordinance' | 'case';
    official: boolean;
    title: string;
    officialUrl: string;
    retrievedAt: string;
    verificationStatus: 'verified' | 'unverified' | 'stale' | 'mismatch';
    exactTextHash: string;
}

export interface SupplementalMaterialAuditV1 {
    parsedAddendaCount: number;
    parsedAppendixCount: number;
    matchedAddendaCount: number;
    matchedAppendixCount: number;
    matchedTextHash: string;
    interpretationStatus: 'keyword_screened_not_legally_interpreted';
}

export interface LawSourceV1 extends SourceBaseV1 {
    sourceType: 'law';
    lawId: string;
    mst: string;
    lawType: string;
    promulgationNo?: string;
    promulgatedOn?: string;
    effectiveFrom: string;
    articleEffectiveFrom?: string;
    versionStatus: 'current' | 'future' | 'historical' | 'unknown';
    appliesAsOf: boolean;
    provision: ProvisionLocatorV1;
    exactText: string;
    supplementalMaterialAudit: SupplementalMaterialAuditV1;
}

export interface OrdinanceSourceV1 extends SourceBaseV1 {
    sourceType: 'ordinance';
    ordinanceId: string;
    mst: string;
    ordinanceType: string;
    localAuthority: LocalAuthorityRefV1;
    jurisdictionMatch: 'exact' | 'name_only' | 'mismatch' | 'unknown';
    promulgationNo?: string;
    promulgatedOn?: string;
    effectiveFrom: string;
    articleEffectiveFrom?: string;
    versionStatus: 'current' | 'historical' | 'unknown';
    appliesAsOf: boolean;
    provision: ProvisionLocatorV1;
    exactText: string;
    supplementalMaterialAudit: SupplementalMaterialAuditV1;
}

export type CaseCurrentLawFitV1 =
    | 'verified_same_rule'
    | 'current_rule_candidate'
    | 'changed_rule'
    | 'unknown';

export type CaseUseInConclusionV1 =
    | 'direct_support'
    | 'analogical_support'
    | 'background_only'
    | 'excluded';

export interface CaseRelevanceV1 {
    grade: 'direct' | 'analogical' | 'background' | 'unrelated';
    matchedIssues: string[];
    matchedProvisions: string[];
    reason: string;
}

export interface CaseSourceV1 extends SourceBaseV1 {
    sourceType: 'case';
    caseSerialId: string;
    caseName: string;
    caseNumber: string;
    court: string;
    decisionDate: string;
    disposition?: string;
    holding: string;
    /** holding이 공식 판시사항인지, 판결문에서 그대로 잘라낸 발췌인지 구분한다. */
    holdingSource: 'official_holdings' | 'official_full_text_excerpt';
    reasoningSummary: string;
    referencedProvisions: string[];
    fullTextVerified: boolean;
    listingIdentityVerified: boolean;
    relevance: CaseRelevanceV1;
    currentLawFit: CaseCurrentLawFitV1;
    useInConclusion: CaseUseInConclusionV1;
}

export type CaseReviewRelevanceBasisV1 =
    | 'exact_law_and_strong_term'
    | 'exact_law_target_article_and_issue_family';

export interface CaseReviewMatchV1 {
    issueId: string;
    lawName: string;
    issueTerm: string;
    articleLabel?: string;
    relevanceBasis: CaseReviewRelevanceBasisV1;
    /** 정확한 현행 본법 명칭을 포함하는 짧은 판결문 exact substring. */
    lawContextExcerpt: string;
    /**
     * strong-term 경로에서 쟁점어를 포함하는 별도의 exact substring.
     * 법령명 문맥과 동일한 법률쟁점이라는 의미는 아니며 renderer가 이를 명시한다.
     * 대상 조문+쟁점군 경로는 lawContextExcerpt 하나에 모든 anchor가 있어 생략한다.
     */
    issueContextExcerpt?: string;
}

/**
 * 현행 규정 정합성을 통과하지 못해 결론에 쓸 수는 없지만,
 * 정확한 법령명과 질문 쟁점의 이중 앵커를 전문에서 확인한 검토용 판례다.
 * sourceId를 의도적으로 두지 않아 LegalSource/sourceIndex에 삽입할 수 없게 한다.
 */
export interface CaseReviewCandidateV1 {
    reviewOnly: true;
    official: true;
    verificationStatus: 'verified';
    caseSerialId: string;
    caseName: string;
    caseNumber: string;
    court: string;
    decisionDate: string;
    officialUrl: string;
    retrievedAt: string;
    fullTextHash: string;
    fullTextVerified: true;
    listingIdentityVerified: true;
    currentLawFit: 'changed_rule' | 'unknown';
    useInConclusion: 'excluded';
    issueIds: string[];
    matches: CaseReviewMatchV1[];
    excerptLabel: '판결문 발췌';
}

export type LegalSourceV1 = LawSourceV1 | OrdinanceSourceV1 | CaseSourceV1;

export interface LawSearchAuditV1 {
    target: 'eflaw';
    currentOnlyNw: number;
    exactLawNameMatched: boolean;
    exactLawTypeMatched: boolean;
}

export interface OrdinanceSearchAuditV1 {
    required: boolean;
    performed: boolean;
    target: 'ordin';
    currentOnlyNw: number;
}

export interface PlanIssueCoverageV1 {
    issueId: string;
    questionMatchedTerms: string[];
    lawAnchorCount: number;
    ordinanceAnchorCount: number;
    caseQueryCount: number;
}

export interface PlanCoverageAuditV1 {
    normalizedPlan: LegalResearchPlanV1;
    normalizedPlanHash: string;
    reviewStatus: 'mechanically_validated_controlled_taxonomy_not_legal_reviewed';
    allIssuesQuestionMatched: boolean;
    allIssuesLawCovered: boolean;
    allIssuesCaseCovered: boolean;
    issues: PlanIssueCoverageV1[];
}

export type CaseShortfallReasonV1 =
    | 'official_results_exhausted'
    | 'upstream_incomplete'
    | 'full_text_unavailable'
    | 'current_law_misaligned';

export interface CaseExclusionCountsV1 {
    duplicate: number;
    fullTextUnavailable: number;
    identityMismatch: number;
    irrelevant: number;
    currentLawMisaligned: number;
    unofficialUrl: number;
}

export interface CaseSearchAuditV1 {
    requestedMax: number;
    candidateCount: number;
    qualifiedCount: number;
    returnedCount: number;
    target: 'prec';
    listSort: 'ddes';
    resultSort: 'decision_date_desc_case_serial_id_desc';
    lawNameQueries: string[];
    issueQueries: string[];
    /** Additive V1 audit field containing exact provider body queries when case search ran. */
    executedBodyQueries?: string[];
    relevancePolicyVersion: string;
    queryRelaxedToFill: boolean;
    upstreamComplete: boolean;
    shortfallReason: CaseShortfallReasonV1 | null;
    exclusions: CaseExclusionCountsV1;
}

export interface CaseReviewIssueAuditV1 {
    issueId: string;
    qualifiedCount: number;
    returnedCount: number;
}

export interface CaseReviewAuditV1 {
    requestedMax: typeof MAX_CASE_REVIEW_CANDIDATES;
    candidatePoolCount: number;
    qualifiedCount: number;
    returnedCount: number;
    resultSort: 'decision_date_desc_case_serial_id_desc';
    upstreamComplete: boolean;
    latestScope: 'planned_streams_verified' | 'reviewed_candidate_pool';
    shortfallReason: 'official_results_exhausted' | 'upstream_incomplete' | null;
    paddingApplied: false;
    issues: CaseReviewIssueAuditV1[];
}

export interface LegalUnknownV1 {
    code: string;
    text: string;
    impact: string;
    blocking: boolean;
}

export interface LegalResearchProvenanceV1 {
    provider: 'KOREA_LAW_OPEN_API';
    policyVersion: typeof LEGAL_POLICY_VERSION;
    generatedAt: string;
}

export interface LegalResearchPacketV1 {
    contractVersion: typeof LEGAL_RESEARCH_PACKET_VERSION;
    packetId: string;
    question: string;
    status: LegalResearchStatusV1;
    scope: LegalResearchScopeV1;
    facts: LegalFactV1[];
    laws: LawSourceV1[];
    ordinances: OrdinanceSourceV1[];
    cases: CaseSourceV1[];
    caseReviewCandidates: CaseReviewCandidateV1[];
    lawSearchAudit: LawSearchAuditV1;
    ordinanceSearchAudit: OrdinanceSearchAuditV1;
    planCoverageAudit: PlanCoverageAuditV1;
    caseSearchAudit: CaseSearchAuditV1;
    caseReviewAudit: CaseReviewAuditV1;
    unknowns: LegalUnknownV1[];
    provenance: LegalResearchProvenanceV1;
}

export type LegalConclusionKindV1 = 'supported' | 'conditional' | 'cannot_conclude';

export interface LegalEvidenceQuoteV1 {
    sourceId: string;
    quote: string;
}

export interface LegalConclusionV1 {
    kind: LegalConclusionKindV1;
    text: string;
    sourceIds: string[];
    evidenceQuotes: LegalEvidenceQuoteV1[];
}

export interface LegalRuleClaimV1 {
    claimId: string;
    text: string;
    sourceIds: string[];
    evidenceQuotes: LegalEvidenceQuoteV1[];
}

export interface LegalOrdinanceAnalysisV1 {
    analysisId: string;
    text: string;
    sourceIds: string[];
    evidenceQuotes: LegalEvidenceQuoteV1[];
}

export interface LegalCaseSynthesisV1 {
    candidateCount: number;
    qualifiedCount: number;
    returnedCount: number;
    exclusions: CaseExclusionCountsV1;
    summary: string;
    sourceIds: string[];
    shortfallReason: CaseShortfallReasonV1 | null;
    upstreamComplete: boolean;
    evidenceQuotes: LegalEvidenceQuoteV1[];
    searchScope: {
        normalizedPlanHash: string;
        lawNameQueries: string[];
        issueQueries: string[];
    };
}

export interface LegalApplicationV1 {
    applicationId: string;
    issue: string;
    factIds: string[];
    sourceIds: string[];
    evidenceQuotes: LegalEvidenceQuoteV1[];
    inference: string;
    result: string;
    temporalApplicability: 'current_rule_applies' | 'historical_review_required' | 'unknown';
    confidence: 'high' | 'medium' | 'low';
}

export interface LegalTemporalReviewV1 {
    summary: string;
    sourceIds: string[];
    evidenceQuotes: LegalEvidenceQuoteV1[];
    historicalLawRequired: boolean;
}

export interface LegalWarningV1 {
    code: string;
    text: string;
}

export interface LegalAnswerV1 {
    contractVersion: typeof LEGAL_ANSWER_VERSION;
    packetId: string;
    status: LegalResearchStatusV1;
    conclusion: LegalConclusionV1;
    scope: LegalResearchScopeV1;
    facts: LegalFactV1[];
    ruleClaims: LegalRuleClaimV1[];
    ordinanceAnalysis: LegalOrdinanceAnalysisV1[];
    caseSynthesis: LegalCaseSynthesisV1;
    caseReviewCandidates: CaseReviewCandidateV1[];
    caseReviewAudit: CaseReviewAuditV1;
    applications: LegalApplicationV1[];
    temporalReview: LegalTemporalReviewV1;
    unknowns: LegalUnknownV1[];
    warnings: LegalWarningV1[];
    sourceIndex: LegalSourceV1[];
    disclaimer: string;
}

export interface RenderedLegalAnswerV1 {
    answer: LegalAnswerV1;
    contractValidationPassed: true;
    markdown: string;
}
