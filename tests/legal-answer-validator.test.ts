import assert from 'node:assert/strict';
import test from 'node:test';
import {
    LEGAL_BLOCKING_UNKNOWN_CONCLUSION_TEXT,
    LEGAL_ANSWER_VERSION,
    LEGAL_DISCLAIMER,
    LEGAL_POLICY_VERSION,
    LEGAL_RESEARCH_PACKET_VERSION,
    type CaseReviewCandidateV1,
    type CaseSourceV1,
    type LegalAnswerV1,
    type LegalResearchPacketV1,
} from '../src/services/legal-research/model';
import {
    isPublicOfficialLawUrlV1,
    validateLegalAnswerV1,
    validateLegalResearchPacketV1,
} from '../src/services/legal-research/validator';
import {
    buildCaseSearchQueriesV1,
    buildLegalPlanCoverageAuditV1,
    type LegalResearchPlanV1,
} from '../src/services/legal-research/research-plan';

const retrievedAt = '2026-08-31T09:00:00+09:00';
const packetQuestion = '조합설립 동의 요건은 무엇인가?';
const packetResearchPlan: LegalResearchPlanV1 = {
    issues: [{ issueId: 'ISSUE-1', issue: '조합설립 동의 요건', requestedOutcome: 'vote_threshold' }],
    lawAnchors: [{
        issueIds: ['ISSUE-1'],
        exactName: '도시 및 주거환경정비법',
        lawType: '법률',
        articleLabels: ['제35조'],
        issueTerms: ['조합설립 동의'],
    }],
    ordinanceRequirement: 'required',
    ordinanceAnchors: [{
        issueIds: ['ISSUE-1'],
        exactName: '서울특별시 강남구 도시 및 주거환경정비 조례',
        organizationCode: '11680',
        organizationName: '서울특별시 강남구',
        articleLabels: ['제10조'],
        issueTerms: ['조합설립 동의'],
    }],
    caseQueries: [{
        issueIds: ['ISSUE-1'],
        lawNames: ['도시 및 주거환경정비법'],
        articleLabels: ['제35조'],
        issueTerms: ['조합설립 동의'],
    }],
};
const hash = 'a'.repeat(64);

function makeCase(
    caseSerialId: string,
    decisionDate: string,
    sourceId = `case-${caseSerialId}`
): CaseSourceV1 {
    return {
        sourceId,
        sourceType: 'case',
        official: true,
        title: `판례 ${caseSerialId}`,
        officialUrl: `https://www.law.go.kr/precInfoP.do?precSeq=${caseSerialId}`,
        retrievedAt,
        verificationStatus: 'verified',
        exactTextHash: hash,
        caseSerialId,
        caseName: '조합설립인가처분취소',
        caseNumber: `2026두${caseSerialId}`,
        court: '대법원',
        decisionDate,
        holding: '조합설립 동의 요건을 판시하였다.',
        holdingSource: 'official_holdings',
        reasoningSummary: '현행 조문과 동일한 규정을 해석하였다.',
        referencedProvisions: ['도시정비법 제35조'],
        fullTextVerified: true,
        listingIdentityVerified: true,
        relevance: {
            grade: 'direct',
            matchedIssues: ['조합설립 동의'],
            matchedProvisions: ['도시정비법 제35조'],
            reason: '질문의 쟁점과 참조조문이 직접 일치한다.',
        },
        currentLawFit: 'verified_same_rule',
        useInConclusion: 'direct_support',
    };
}

function makePacket(): LegalResearchPacketV1 {
    const cases = [makeCase('200', '2026-05-01'), makeCase('100', '2025-05-01')];
    return {
        contractVersion: LEGAL_RESEARCH_PACKET_VERSION,
        packetId: 'packet-1',
        question: packetQuestion,
        status: 'complete',
        scope: {
            countryCode: 'KR',
            asOfDate: '2026-08-31',
            eventDate: '2025-01-01',
            eventDateRequired: true,
            localAuthorities: [
                { code: '11680', name: '서울특별시 강남구', level: 'basic' },
            ],
            lawVersionPolicy: 'effective_current_only',
            projectType: 'reconstruction',
            projectStage: 'association_establishment',
        },
        facts: [
            {
                factId: 'fact-1',
                text: '사업지는 서울특별시 강남구이다.',
                origin: 'user',
                verification: 'unverified',
            },
        ],
        laws: [
            {
                sourceId: 'law-1',
                sourceType: 'law',
                official: true,
                title: '도시 및 주거환경정비법',
                officialUrl: 'https://www.law.go.kr/lsInfoP.do?lsiSeq=250000',
                retrievedAt,
                verificationStatus: 'verified',
                exactTextHash: hash,
                lawId: '001234',
                mst: '250000',
                lawType: '법률',
                effectiveFrom: '2024-01-01',
                versionStatus: 'current',
                appliesAsOf: true,
                provision: { article: '제35조', paragraph: '제2항' },
                exactText: '조합을 설립하려는 경우 대통령령으로 정하는 동의를 받아야 한다.',
                supplementalMaterialAudit: {
                    parsedAddendaCount: 0,
                    parsedAppendixCount: 0,
                    matchedAddendaCount: 0,
                    matchedAppendixCount: 0,
                    matchedTextHash: '0'.repeat(64),
                    interpretationStatus: 'keyword_screened_not_legally_interpreted',
                },
            },
        ],
        ordinances: [
            {
                sourceId: 'ordinance-1',
                sourceType: 'ordinance',
                official: true,
                title: '서울특별시 강남구 도시 및 주거환경정비 조례',
                officialUrl: 'https://www.law.go.kr/ordinInfoP.do?ordinSeq=ORD-MST-1',
                retrievedAt,
                verificationStatus: 'verified',
                exactTextHash: hash,
                ordinanceId: 'ORD-1',
                mst: 'ORD-MST-1',
                ordinanceType: '조례',
                localAuthority: { code: '11680', name: '서울특별시 강남구', level: 'basic' },
                jurisdictionMatch: 'exact',
                effectiveFrom: '2024-01-01',
                versionStatus: 'current',
                appliesAsOf: true,
                provision: { article: '제10조' },
                exactText: '정비구역 지정에 필요한 사항을 정한다.',
                supplementalMaterialAudit: {
                    parsedAddendaCount: 0,
                    parsedAppendixCount: 0,
                    matchedAddendaCount: 0,
                    matchedAppendixCount: 0,
                    matchedTextHash: '0'.repeat(64),
                    interpretationStatus: 'keyword_screened_not_legally_interpreted',
                },
            },
        ],
        cases,
        caseReviewCandidates: [],
        lawSearchAudit: {
            target: 'eflaw',
            currentOnlyNw: 3,
            exactLawNameMatched: true,
            exactLawTypeMatched: true,
        },
        ordinanceSearchAudit: {
            required: true,
            performed: true,
            target: 'ordin',
            currentOnlyNw: 1,
        },
        planCoverageAudit: buildLegalPlanCoverageAuditV1(
            packetQuestion,
            packetResearchPlan
        ),
        caseSearchAudit: {
            requestedMax: 12,
            candidateCount: 2,
            qualifiedCount: 2,
            returnedCount: 2,
            target: 'prec',
            listSort: 'ddes',
            resultSort: 'decision_date_desc_case_serial_id_desc',
            lawNameQueries: ['도시 및 주거환경정비법'],
            issueQueries: ['조합설립 동의'],
            executedBodyQueries: ['도시 및 주거환경정비법 조합설립 동의'],
            relevancePolicyVersion: LEGAL_POLICY_VERSION,
            queryRelaxedToFill: false,
            upstreamComplete: true,
            shortfallReason: 'official_results_exhausted',
            exclusions: {
                duplicate: 0,
                fullTextUnavailable: 0,
                identityMismatch: 0,
                irrelevant: 0,
                currentLawMisaligned: 0,
                unofficialUrl: 0,
            },
        },
        caseReviewAudit: {
            requestedMax: 12,
            candidatePoolCount: 2,
            qualifiedCount: 0,
            returnedCount: 0,
            resultSort: 'decision_date_desc_case_serial_id_desc',
            upstreamComplete: true,
            latestScope: 'planned_streams_verified',
            shortfallReason: 'official_results_exhausted',
            paddingApplied: false,
            issues: [{ issueId: 'ISSUE-1', qualifiedCount: 0, returnedCount: 0 }],
        },
        unknowns: [],
        provenance: {
            provider: 'KOREA_LAW_OPEN_API',
            policyVersion: LEGAL_POLICY_VERSION,
            generatedAt: retrievedAt,
        },
    };
}

function makeAnswer(packet: LegalResearchPacketV1): LegalAnswerV1 {
    return {
        contractVersion: LEGAL_ANSWER_VERSION,
        packetId: packet.packetId,
        status: packet.status,
        conclusion: {
            kind: 'supported',
            text: '현행법상 법정 동의 요건을 충족해야 한다.',
            sourceIds: ['law-1'],
            evidenceQuotes: [{
                sourceId: 'law-1',
                quote: '조합을 설립하려는 경우 대통령령으로 정하는 동의를 받아야 한다.',
            }],
        },
        scope: structuredClone(packet.scope),
        facts: structuredClone(packet.facts),
        ruleClaims: [
            {
                claimId: 'rule-1',
                text: '조합설립에는 법정 동의가 필요하다.',
                sourceIds: ['law-1'],
                evidenceQuotes: [{ sourceId: 'law-1', quote: '동의를 받아야 한다.' }],
            },
        ],
        ordinanceAnalysis: [
            {
                analysisId: 'ordinance-analysis-1',
                text: '관할 조례가 적용된다.',
                sourceIds: ['ordinance-1'],
                evidenceQuotes: [{ sourceId: 'ordinance-1', quote: '정비구역 지정에 필요한 사항을 정한다.' }],
            },
        ],
        caseSynthesis: {
            candidateCount: packet.caseSearchAudit.candidateCount,
            qualifiedCount: packet.caseSearchAudit.qualifiedCount,
            returnedCount: packet.cases.length,
            exclusions: structuredClone(packet.caseSearchAudit.exclusions),
            summary: '현행 규정과 동일한 법리를 다룬 판례이다.',
            sourceIds: packet.cases.map((legalCase) => legalCase.sourceId),
            shortfallReason: packet.caseSearchAudit.shortfallReason,
            upstreamComplete: packet.caseSearchAudit.upstreamComplete,
            evidenceQuotes: packet.cases.map((legalCase) => ({
                sourceId: legalCase.sourceId,
                quote: '조합설립 동의 요건을 판시하였다.',
            })),
            searchScope: {
                normalizedPlanHash: packet.planCoverageAudit.normalizedPlanHash,
                lawNameQueries: packet.caseSearchAudit.lawNameQueries,
                issueQueries: packet.caseSearchAudit.issueQueries,
            },
        },
        caseReviewCandidates: structuredClone(packet.caseReviewCandidates),
        caseReviewAudit: structuredClone(packet.caseReviewAudit),
        applications: [
            {
                applicationId: 'application-1',
                issue: '동의 요건',
                factIds: ['fact-1'],
                sourceIds: ['law-1', 'ordinance-1', 'case-200'],
                evidenceQuotes: [
                    { sourceId: 'law-1', quote: '동의를 받아야 한다.' },
                    { sourceId: 'ordinance-1', quote: '정비구역 지정에 필요한 사항을 정한다.' },
                    { sourceId: 'case-200', quote: '조합설립 동의 요건을 판시하였다.' },
                ],
                inference: '확인된 관할과 현행 조문을 사실에 적용하였다.',
                result: '법정 동의율을 확인해야 한다.',
                temporalApplicability: 'current_rule_applies',
                confidence: 'medium',
            },
        ],
        temporalReview: {
            summary: '사건일은 인용 현행 조문의 시행일 이후이다.',
            sourceIds: ['law-1'],
            evidenceQuotes: [{ sourceId: 'law-1', quote: '동의를 받아야 한다.' }],
            historicalLawRequired: false,
        },
        unknowns: [],
        warnings: [],
        sourceIndex: structuredClone([...packet.laws, ...packet.ordinances, ...packet.cases]),
        disclaimer: LEGAL_DISCLAIMER,
    };
}

function errorCodes(result: { errors: Array<{ code: string }> }): string[] {
    return result.errors.map((entry) => entry.code);
}

function addReviewCandidate(packet: LegalResearchPacketV1): CaseReviewCandidateV1 {
    const reviewPlan: LegalResearchPlanV1 = {
        ...packetResearchPlan,
        issues: [{
            issueId: 'ISSUE-1',
            issue: '공동소유자의 대표조합원과 표결 자격',
            requestedOutcome: 'eligibility',
        }],
        lawAnchors: [{
            issueIds: ['ISSUE-1'],
            exactName: '도시 및 주거환경정비법',
            lawType: '법률',
            articleLabels: ['제35조'],
            issueTerms: ['공동소유자'],
        }],
        ordinanceRequirement: 'not_required',
        ordinanceAnchors: [],
        caseQueries: [{
            issueIds: ['ISSUE-1'],
            lawNames: ['도시 및 주거환경정비법'],
            articleLabels: ['제35조'],
            issueTerms: ['공동소유자'],
        }],
    };
    packet.question = '공동소유자의 표결 자격은 어떻게 되나?';
    packet.planCoverageAudit = buildLegalPlanCoverageAuditV1(packet.question, reviewPlan);
    const searchQueries = buildCaseSearchQueriesV1(reviewPlan.caseQueries);
    packet.caseSearchAudit.lawNameQueries = searchQueries.lawNameQueries;
    packet.caseSearchAudit.issueQueries = searchQueries.issueQueries;
    packet.caseSearchAudit.executedBodyQueries = searchQueries.executedBodyQueries;
    packet.caseSearchAudit.candidateCount = 3;
    packet.caseSearchAudit.exclusions.currentLawMisaligned = 1;
    packet.caseReviewAudit.candidatePoolCount = 3;
    packet.caseReviewAudit.qualifiedCount = 1;
    packet.caseReviewAudit.returnedCount = 1;
    packet.caseReviewAudit.shortfallReason = 'official_results_exhausted';
    packet.caseReviewAudit.issues = [{
        issueId: 'ISSUE-1',
        qualifiedCount: 1,
        returnedCount: 1,
    }];
    const candidate: CaseReviewCandidateV1 = {
        reviewOnly: true,
        official: true,
        verificationStatus: 'verified',
        caseSerialId: '300',
        caseName: '공동소유자 총회결의무효',
        caseNumber: '2024누300',
        court: '서울고법',
        decisionDate: '2024-05-01',
        officialUrl: 'https://www.law.go.kr/precInfoP.do?precSeq=300',
        retrievedAt,
        fullTextHash: 'c'.repeat(64),
        fullTextVerified: true,
        listingIdentityVerified: true,
        currentLawFit: 'unknown',
        useInConclusion: 'excluded',
        issueIds: ['ISSUE-1'],
        matches: [{
            issueId: 'ISSUE-1',
            lawName: '도시 및 주거환경정비법',
            issueTerm: '공동소유자',
            relevanceBasis: 'exact_law_and_strong_term',
            lawContextExcerpt: '재판부는 현행 도시 및 주거환경정비법의문언과 체계를 바탕으로 관련 규정을 검토하였다.',
            issueContextExcerpt: '재판부는 공동소유자가 대표자를 정하지 않고 표결한 절차의 효력과 각 소유자의 의사표시 방법을 함께 판단하였다. 이어 각 당사자의 주장을 기록과 대조하여 판단 범위를 한정하였다.',
        }],
        excerptLabel: '판결문 발췌',
    };
    packet.caseReviewCandidates = [candidate];
    return candidate;
}

test('검토용 판례는 공식 전문·identity·이중 anchor와 strict 격리를 검증한다', () => {
    const packet = makePacket();
    addReviewCandidate(packet);
    const valid = validateLegalResearchPacketV1(packet);
    assert.equal(valid.ok, true, JSON.stringify(valid.errors, null, 2));

    const generic = structuredClone(packet);
    generic.caseReviewCandidates[0].matches[0].issueTerm = '대표자';
    generic.caseReviewCandidates[0].matches[0].issueContextExcerpt = '대표자가 문제된다.';
    assert.ok(errorCodes(validateLegalResearchPacketV1(generic))
        .includes('CASE_REVIEW_STRONG_TERM_INVALID'));

    const subordinate = structuredClone(packet);
    subordinate.caseReviewCandidates[0].matches[0].lawContextExcerpt =
        '도시 및 주거환경정비법시행령의 조문만 확인한다.';
    assert.ok(errorCodes(validateLegalResearchPacketV1(subordinate))
        .includes('CASE_REVIEW_LAW_CONTEXT_MISMATCH'));

    const sourceIdInjected = structuredClone(packet) as unknown as Record<string, unknown>;
    (sourceIdInjected.caseReviewCandidates as Array<Record<string, unknown>>)[0].sourceId = 'case-review-300';
    assert.ok(errorCodes(validateLegalResearchPacketV1(sourceIdInjected))
        .includes('CASE_REVIEW_SOURCE_ID_FORBIDDEN'));

    const borrowedArticle = structuredClone(packet);
    borrowedArticle.caseReviewCandidates[0].matches[0] = {
        issueId: 'ISSUE-1',
        lawName: '도시 및 주거환경정비법',
        issueTerm: '공동소유자',
        articleLabel: '제35조',
        relevanceBasis: 'exact_law_target_article_and_issue_family',
        lawContextExcerpt: '도시 및 주거환경정비법을 검토하고 민법 제35조의 공동소유자와 대표조합원을 살폈다.',
    };
    assert.ok(errorCodes(validateLegalResearchPacketV1(borrowedArticle))
        .includes('CASE_REVIEW_DUAL_ANCHOR_INVALID'));

    borrowedArticle.caseReviewCandidates[0].matches[0].lawContextExcerpt =
        '「도시 및 주거환경정비법」 제35조의 공동소유자와 대표조합원을 살폈다.';
    const boundArticle = validateLegalResearchPacketV1(borrowedArticle);
    assert.equal(boundArticle.ok, true, JSON.stringify(boundArticle.errors, null, 2));

    borrowedArticle.caseReviewCandidates[0].matches[0].lawContextExcerpt =
        '도시 및 주거환경정비법 제35조 제1항의 공동소유자와 대표조합원을 살폈다.';
    const boundArticleParagraph = validateLegalResearchPacketV1(borrowedArticle);
    assert.equal(
        boundArticleParagraph.ok,
        true,
        JSON.stringify(boundArticleParagraph.errors, null, 2)
    );
});

test('같은 issue·법령의 여러 case query 중 match를 만족하는 후속 query를 인정한다', () => {
    const packet = makePacket();
    addReviewCandidate(packet);
    const basePlan = packet.planCoverageAudit.normalizedPlan;
    const multiQueryPlan: LegalResearchPlanV1 = {
        ...basePlan,
        caseQueries: [
            { ...basePlan.caseQueries[0], issueTerms: ['대표조합원'] },
            { ...basePlan.caseQueries[0], issueTerms: ['공동소유자'] },
        ],
    };
    packet.planCoverageAudit = buildLegalPlanCoverageAuditV1(
        packet.question,
        multiQueryPlan
    );
    const searches = buildCaseSearchQueriesV1(
        packet.planCoverageAudit.normalizedPlan.caseQueries
    );
    packet.caseSearchAudit.lawNameQueries = searches.lawNameQueries;
    packet.caseSearchAudit.issueQueries = searches.issueQueries;
    packet.caseSearchAudit.executedBodyQueries = searches.executedBodyQueries;

    const result = validateLegalResearchPacketV1(packet);
    assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test('전자투표 쟁점은 strong 경로에서도 전자 계열 exact term만 허용한다', () => {
    const packet = makePacket();
    const candidate = addReviewCandidate(packet);
    packet.question = '총회결의무효와 전자투표가 문제되는가?';
    const electronicPlan: LegalResearchPlanV1 = {
        issues: [{
            issueId: 'ISSUE-1',
            issue: '총회 결의 절차와 무효',
            requestedOutcome: 'procedure',
        }],
        lawAnchors: [{
            issueIds: ['ISSUE-1'],
            exactName: '도시 및 주거환경정비법',
            lawType: '법률',
            articleLabels: ['제35조'],
            issueTerms: ['전자투표'],
        }],
        ordinanceRequirement: 'not_required',
        ordinanceAnchors: [],
        caseQueries: [
            {
                issueIds: ['ISSUE-1'],
                lawNames: ['도시 및 주거환경정비법'],
                articleLabels: ['제35조'],
                issueTerms: ['전자투표'],
            },
            {
                issueIds: ['ISSUE-1'],
                lawNames: ['도시 및 주거환경정비법'],
                articleLabels: ['제35조'],
                issueTerms: ['총회결의무효'],
            },
        ],
    };
    packet.planCoverageAudit = buildLegalPlanCoverageAuditV1(
        packet.question,
        electronicPlan
    );
    const searches = buildCaseSearchQueriesV1(
        packet.planCoverageAudit.normalizedPlan.caseQueries
    );
    packet.caseSearchAudit.lawNameQueries = searches.lawNameQueries;
    packet.caseSearchAudit.issueQueries = searches.issueQueries;
    packet.caseSearchAudit.executedBodyQueries = searches.executedBodyQueries;
    candidate.matches[0].issueTerm = '총회결의무효';
    candidate.matches[0].issueContextExcerpt = '이 판결은 총회결의무효 청구의 허용 여부를 판단하였다.';

    const generalStrong = validateLegalResearchPacketV1(packet);
    assert.equal(generalStrong.ok, false);
    assert.ok(errorCodes(generalStrong).includes('CASE_REVIEW_PLAN_MISMATCH'));

    candidate.matches[0].issueTerm = '전자투표';
    candidate.matches[0].issueContextExcerpt = '이 판결은 전자투표 방식의 효력에 관한 주장을 검토하였다.';
    const electronic = validateLegalResearchPacketV1(packet);
    assert.equal(electronic.ok, true, JSON.stringify(electronic.errors, null, 2));
});

test('대표자 단독 query는 공동소유 쟁점군 article fallback을 열지 않는다', () => {
    const packet = makePacket();
    const candidate = addReviewCandidate(packet);
    packet.question = '대표자 선정 절차가 문제되는가?';
    const representativeOnlyPlan: LegalResearchPlanV1 = {
        issues: [{
            issueId: 'ISSUE-1',
            issue: '대표자 선정 절차',
            requestedOutcome: 'procedure',
        }],
        lawAnchors: [{
            issueIds: ['ISSUE-1'],
            exactName: '도시 및 주거환경정비법',
            lawType: '법률',
            articleLabels: ['제35조'],
            issueTerms: ['대표자'],
        }],
        ordinanceRequirement: 'not_required',
        ordinanceAnchors: [],
        caseQueries: [{
            issueIds: ['ISSUE-1'],
            lawNames: ['도시 및 주거환경정비법'],
            articleLabels: ['제35조'],
            issueTerms: ['대표자'],
        }],
    };
    packet.planCoverageAudit = buildLegalPlanCoverageAuditV1(
        packet.question,
        representativeOnlyPlan
    );
    const searches = buildCaseSearchQueriesV1(
        packet.planCoverageAudit.normalizedPlan.caseQueries
    );
    packet.caseSearchAudit.lawNameQueries = searches.lawNameQueries;
    packet.caseSearchAudit.issueQueries = searches.issueQueries;
    packet.caseSearchAudit.executedBodyQueries = searches.executedBodyQueries;
    candidate.matches[0] = {
        issueId: 'ISSUE-1',
        lawName: '도시 및 주거환경정비법',
        issueTerm: '토지등소유자',
        articleLabel: '제35조',
        relevanceBasis: 'exact_law_target_article_and_issue_family',
        lawContextExcerpt: '도시 및 주거환경정비법 제35조의 토지등소유자 범위를 정한다.',
    };

    const result = validateLegalResearchPacketV1(packet);
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('CASE_REVIEW_PLAN_MISMATCH'));
});

test('검토용 판례 식별자와 판결문 발췌 40-gram은 일반 답변 분석 필드로 유출될 수 없다', () => {
    const packet = makePacket();
    const candidate = addReviewCandidate(packet);
    const answer = makeAnswer(packet);
    const valid = validateLegalAnswerV1(answer, packet);
    assert.equal(valid.ok, true, JSON.stringify(valid.errors, null, 2));

    answer.warnings = [{ code: 'REVIEW_LEAK', text: candidate.matches[0].issueContextExcerpt! }];
    const leakedExcerpt = validateLegalAnswerV1(answer, packet);
    assert.ok(errorCodes(leakedExcerpt).includes('CASE_REVIEW_ANALYTICAL_LEAKAGE'));

    answer.warnings = [{
        code: 'REVIEW_PARTIAL_LEAK',
        text: candidate.matches[0].issueContextExcerpt!.slice(8, 88),
    }];
    const leakedPartialExcerpt = validateLegalAnswerV1(answer, packet);
    assert.ok(errorCodes(leakedPartialExcerpt).includes('CASE_REVIEW_ANALYTICAL_LEAKAGE'));
    assert.match(
        leakedPartialExcerpt.errors.find((entry) =>
            entry.code === 'CASE_REVIEW_ANALYTICAL_LEAKAGE')?.message ?? '',
        /판결문 발췌/
    );

    answer.warnings = [{
        code: 'REVIEW_SHORT_TEXT',
        text: candidate.matches[0].issueContextExcerpt!.slice(8, 30),
    }];
    const shortText = validateLegalAnswerV1(answer, packet);
    assert.equal(shortText.ok, true, JSON.stringify(shortText.errors, null, 2));

    answer.warnings = [{ code: 'REVIEW_LEAK', text: `사건번호 ${candidate.caseNumber}` }];
    const leakedNumber = validateLegalAnswerV1(answer, packet);
    assert.ok(errorCodes(leakedNumber).includes('CASE_REVIEW_ANALYTICAL_LEAKAGE'));

    answer.warnings = [{ code: 'REVIEW_LEAK', text: `판례일련번호 ${candidate.caseSerialId}` }];
    const leakedSerial = validateLegalAnswerV1(answer, packet);
    assert.ok(errorCodes(leakedSerial).includes('CASE_REVIEW_ANALYTICAL_LEAKAGE'));

    answer.warnings = [{ code: 'UNRELATED_NUMBER', text: `기준값 ${candidate.caseSerialId}` }];
    const unrelatedNumber = validateLegalAnswerV1(answer, packet);
    assert.equal(unrelatedNumber.ok, true, JSON.stringify(unrelatedNumber.errors, null, 2));
});

test('검토 발췌와 같은 40-gram이 strict 공식 근거에도 있으면 정상 인용을 막지 않는다', () => {
    const packet = makePacket();
    const candidate = addReviewCandidate(packet);
    packet.cases[0].holding += ` ${candidate.matches[0].issueContextExcerpt}`;
    const answer = makeAnswer(packet);
    answer.warnings = [{
        code: 'STRICT_EVIDENCE_QUOTE',
        text: candidate.matches[0].issueContextExcerpt!.slice(8, 88),
    }];

    const result = validateLegalAnswerV1(answer, packet);
    assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test('answer sourceIndex에 검토 발췌를 주입해 n-gram allowlist로 세탁할 수 없다', () => {
    const packet = makePacket();
    const candidate = addReviewCandidate(packet);
    const answer = makeAnswer(packet);
    const strictCase = answer.sourceIndex.find((source) => source.sourceType === 'case');
    assert.ok(strictCase?.sourceType === 'case');
    strictCase.holding += ` ${candidate.matches[0].issueContextExcerpt}`;
    answer.warnings = [{
        code: 'REVIEW_PARTIAL_LEAK',
        text: candidate.matches[0].issueContextExcerpt!.slice(8, 88),
    }];

    const result = validateLegalAnswerV1(answer, packet);
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('CASE_REVIEW_ANALYTICAL_LEAKAGE'));
    assert.ok(errorCodes(result).includes('SOURCE_INDEX_PACKET_MISMATCH'));
});

test('현행 법령, exact 관할, 판례 2건과 공식 링크로 만든 패킷은 유효하다', () => {
    const result = validateLegalResearchPacketV1(makePacket());
    assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test('질문·쟁점·검색계획 provenance hash와 판례 stream 범위를 위조할 수 없다', () => {
    const wrongHash = makePacket();
    wrongHash.planCoverageAudit.normalizedPlanHash = '0'.repeat(64);
    const wrongHashResult = validateLegalResearchPacketV1(wrongHash);
    assert.equal(wrongHashResult.ok, false);
    assert.ok(errorCodes(wrongHashResult).includes('PLAN_HASH_MISMATCH'));

    const wrongQuery = makePacket();
    wrongQuery.caseSearchAudit.issueQueries = ['분양신청'];
    const wrongQueryResult = validateLegalResearchPacketV1(wrongQuery);
    assert.equal(wrongQueryResult.ok, false);
    assert.ok(errorCodes(wrongQueryResult).includes('CASE_QUERY_SCOPE_MISMATCH'));

    const wrongBodyQuery = makePacket();
    wrongBodyQuery.caseSearchAudit.executedBodyQueries = ['조합설립 동의'];
    const wrongBodyQueryResult = validateLegalResearchPacketV1(wrongBodyQuery);
    assert.equal(wrongBodyQueryResult.ok, false);
    assert.ok(errorCodes(wrongBodyQueryResult).includes('CASE_QUERY_SCOPE_MISMATCH'));

    const missingExecutedAudit = makePacket();
    delete missingExecutedAudit.caseSearchAudit.executedBodyQueries;
    const missingExecutedResult = validateLegalResearchPacketV1(missingExecutedAudit);
    assert.equal(missingExecutedResult.ok, false);
    assert.ok(errorCodes(missingExecutedResult).includes('CASE_QUERY_SCOPE_MISMATCH'));

    const orderedExecution = makePacket();
    const twoTermPlan: LegalResearchPlanV1 = {
        ...packetResearchPlan,
        caseQueries: [{
            ...packetResearchPlan.caseQueries[0],
            issueTerms: ['조합설립', '동의'],
        }],
    };
    orderedExecution.planCoverageAudit = buildLegalPlanCoverageAuditV1(
        packetQuestion,
        twoTermPlan
    );
    const expectedExecution = buildCaseSearchQueriesV1(
        orderedExecution.planCoverageAudit.normalizedPlan.caseQueries
    );
    orderedExecution.caseSearchAudit.lawNameQueries = expectedExecution.lawNameQueries;
    orderedExecution.caseSearchAudit.issueQueries = expectedExecution.issueQueries;
    orderedExecution.caseSearchAudit.executedBodyQueries = [
        ...expectedExecution.executedBodyQueries,
    ].reverse();
    const reorderedExecutionResult = validateLegalResearchPacketV1(orderedExecution);
    assert.equal(reorderedExecutionResult.ok, false);
    assert.ok(errorCodes(reorderedExecutionResult).includes('CASE_QUERY_SCOPE_MISMATCH'));
});

test('현재 v4 정책 버전과 판례 감사 집계 보존식을 exact로 강제한다', () => {
    const stalePacketPolicy = makePacket();
    stalePacketPolicy.provenance.policyVersion = 'current-law-policy.v2';
    const stalePacketPolicyResult = validateLegalResearchPacketV1(stalePacketPolicy);
    assert.equal(stalePacketPolicyResult.ok, false);
    assert.ok(errorCodes(stalePacketPolicyResult).includes('POLICY_VERSION_INVALID'));

    const staleCasePolicy = makePacket();
    staleCasePolicy.caseSearchAudit.relevancePolicyVersion = 'current-law-policy.v2';
    const staleCasePolicyResult = validateLegalResearchPacketV1(staleCasePolicy);
    assert.equal(staleCasePolicyResult.ok, false);
    assert.ok(errorCodes(staleCasePolicyResult).includes('CASE_POLICY_VERSION_INVALID'));

    const negativeExclusion = makePacket();
    negativeExclusion.caseSearchAudit.exclusions.irrelevant = -1;
    const negativeExclusionResult = validateLegalResearchPacketV1(negativeExclusion);
    assert.equal(negativeExclusionResult.ok, false);
    assert.ok(errorCodes(negativeExclusionResult).includes('CASE_EXCLUSION_COUNTS_INVALID'));

    const extraExclusion = makePacket();
    Object.assign(extraExclusion.caseSearchAudit.exclusions, { inventedReason: 0 });
    const extraExclusionResult = validateLegalResearchPacketV1(extraExclusion);
    assert.equal(extraExclusionResult.ok, false);
    assert.ok(errorCodes(extraExclusionResult).includes('CASE_EXCLUSION_COUNTS_INVALID'));

    const brokenConservation = makePacket();
    brokenConservation.caseSearchAudit.candidateCount = 3;
    const brokenConservationResult = validateLegalResearchPacketV1(brokenConservation);
    assert.equal(brokenConservationResult.ok, false);
    assert.ok(errorCodes(brokenConservationResult).includes('CASE_AUDIT_CONSERVATION_INVALID'));

    const impossibleReturnedCount = makePacket();
    impossibleReturnedCount.caseSearchAudit.qualifiedCount = 1;
    impossibleReturnedCount.caseSearchAudit.candidateCount = 1;
    const impossibleReturnedResult = validateLegalResearchPacketV1(impossibleReturnedCount);
    assert.equal(impossibleReturnedResult.ok, false);
    assert.ok(errorCodes(impossibleReturnedResult).includes('CASE_AUDIT_COUNT_INVALID'));
});

test('domain validator도 strict 원문 500자와 packet UTF-8 128KiB 한도를 강제한다', () => {
    const longCaseText = makePacket();
    longCaseText.cases[0].holding = '가'.repeat(501);
    assert.ok(errorCodes(validateLegalResearchPacketV1(longCaseText))
        .includes('CASE_TEXT_TOO_LONG'));

    const oversizedPacket = makePacket();
    oversizedPacket.laws[0].exactText = '나'.repeat(50_000);
    assert.ok(errorCodes(validateLegalResearchPacketV1(oversizedPacket))
        .includes('PACKET_SIZE_LIMIT_EXCEEDED'));
});

test('판례일련번호 형식·중복·공식 URL 비교는 같은 canonical 숫자 식별자를 사용한다', () => {
    const canonicalUrl = makePacket();
    canonicalUrl.cases[0].officialUrl = 'https://www.law.go.kr/precInfoP.do?precSeq=000200';
    const canonicalUrlResult = validateLegalResearchPacketV1(canonicalUrl);
    assert.equal(canonicalUrlResult.ok, true, JSON.stringify(canonicalUrlResult.errors, null, 2));

    const invalidIdentifier = makePacket();
    invalidIdentifier.cases[0].caseSerialId = 'case-200';
    invalidIdentifier.cases[0].officialUrl = 'https://www.law.go.kr/precInfoP.do?precSeq=case-200';
    const invalidIdentifierResult = validateLegalResearchPacketV1(invalidIdentifier);
    assert.equal(invalidIdentifierResult.ok, false);
    assert.ok(errorCodes(invalidIdentifierResult).includes('CASE_SERIAL_ID_INVALID'));

    const canonicalDuplicate = makePacket();
    canonicalDuplicate.cases[1] = makeCase('000200', '2025-05-01', 'case-duplicate-200');
    const canonicalDuplicateResult = validateLegalResearchPacketV1(canonicalDuplicate);
    assert.equal(canonicalDuplicateResult.ok, false);
    assert.ok(errorCodes(canonicalDuplicateResult).includes('CASE_PADDING_DETECTED'));

    const decisionIdentityDuplicate = makePacket();
    decisionIdentityDuplicate.cases[0].caseNumber = '2020노486';
    decisionIdentityDuplicate.cases[0].court = '대전지방법원';
    decisionIdentityDuplicate.cases[1].caseNumber = '２０２０노４８６, 2018노3185(병합)';
    decisionIdentityDuplicate.cases[1].court = '대전지법';
    decisionIdentityDuplicate.cases[1].decisionDate =
        decisionIdentityDuplicate.cases[0].decisionDate;
    const decisionIdentityDuplicateResult = validateLegalResearchPacketV1(
        decisionIdentityDuplicate
    );
    assert.equal(decisionIdentityDuplicateResult.ok, false);
    assert.ok(errorCodes(decisionIdentityDuplicateResult).includes('CASE_PADDING_DETECTED'));
});

test('시행예정본과 연혁본은 현재 근거로 수용하지 않는다', () => {
    const future = makePacket();
    future.laws[0].versionStatus = 'future';
    future.laws[0].effectiveFrom = '2027-01-01';
    const futureResult = validateLegalResearchPacketV1(future);
    assert.equal(futureResult.ok, false);
    assert.ok(errorCodes(futureResult).includes('CURRENT_EFFECTIVE_VERSION_REQUIRED'));
    assert.ok(errorCodes(futureResult).includes('FUTURE_VERSION_REJECTED'));

    const historical = makePacket();
    historical.laws[0].versionStatus = 'historical';
    const historicalResult = validateLegalResearchPacketV1(historical);
    assert.equal(historicalResult.ok, false);
    assert.ok(errorCodes(historicalResult).includes('CURRENT_EFFECTIVE_VERSION_REQUIRED'));
});

test('부칙·별표 감사는 파싱/키워드 선별만 허용하고 자동 법률 해석 완료를 허용하지 않는다', () => {
    const overclaimed = makePacket();
    overclaimed.laws[0].supplementalMaterialAudit.interpretationStatus =
        'legally_interpreted' as never;
    const overclaimedResult = validateLegalResearchPacketV1(overclaimed);
    assert.equal(overclaimedResult.ok, false);
    assert.ok(errorCodes(overclaimedResult).includes('SUPPLEMENTAL_INTERPRETATION_OVERCLAIM'));

    const impossibleCount = makePacket();
    impossibleCount.laws[0].supplementalMaterialAudit.matchedAddendaCount = 1;
    const countResult = validateLegalResearchPacketV1(impossibleCount);
    assert.equal(countResult.ok, false);
    assert.ok(errorCodes(countResult).includes('SUPPLEMENTAL_AUDIT_COUNT_MISMATCH'));
});

test('현행 조문 시행 전 사건을 complete 결론으로 소급 적용하지 않는다', () => {
    const invalid = makePacket();
    invalid.scope.eventDate = '2020-01-01';
    const invalidResult = validateLegalResearchPacketV1(invalid);
    assert.equal(invalidResult.ok, false);
    assert.ok(errorCodes(invalidResult).includes('HISTORICAL_LAW_REQUIRED'));

    const closed = makePacket();
    closed.scope.eventDate = '2020-01-01';
    closed.status = 'temporal_scope_conflict';
    closed.unknowns = [{
        code: 'HISTORICAL_LAW_REQUIRED',
        text: '사건 당시 시행본이 필요하다.',
        impact: '현행법만으로 사건 결론을 낼 수 없다.',
        blocking: true,
    }];
    const closedResult = validateLegalResearchPacketV1(closed);
    assert.equal(closedResult.ok, true, JSON.stringify(closedResult.errors, null, 2));
});

test('사건일 확인이 우선인 경우 판례 상류 미완료여도 clarification_required를 허용한다', () => {
    const packet = makePacket();
    packet.scope.eventDate = null;
    packet.status = 'clarification_required';
    packet.caseSearchAudit.upstreamComplete = false;
    packet.caseSearchAudit.shortfallReason = 'upstream_incomplete';
    packet.unknowns = [{
        code: 'EVENT_DATE_REQUIRED',
        text: '전자투표가 이루어진 사건일이 필요하다.',
        impact: '사건 당시 시행법을 확정할 수 없다.',
        blocking: true,
    }];

    const result = validateLegalResearchPacketV1(packet);
    assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test('사건 당시 시행본 확인이 우선인 경우 판례 상류 미완료여도 temporal_scope_conflict를 허용한다', () => {
    const packet = makePacket();
    packet.scope.eventDate = '2020-01-01';
    packet.status = 'temporal_scope_conflict';
    packet.caseSearchAudit.upstreamComplete = false;
    packet.caseSearchAudit.shortfallReason = 'upstream_incomplete';
    packet.unknowns = [{
        code: 'HISTORICAL_LAW_REQUIRED',
        text: '사건 당시 시행본이 필요하다.',
        impact: '현행법만으로 사건 결론을 낼 수 없다.',
        blocking: true,
    }];

    const result = validateLegalResearchPacketV1(packet);
    assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test('판례 상류 미완료 결과를 complete로 반환하면 계속 거부한다', () => {
    const packet = makePacket();
    packet.caseSearchAudit.upstreamComplete = false;
    packet.caseSearchAudit.shortfallReason = 'upstream_incomplete';

    const result = validateLegalResearchPacketV1(packet);
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('CASE_UPSTREAM_STATUS_INVALID'));
});

test('strict 판례 탐색이 완료되어도 검토용 판례 탐색 미완료는 complete일 수 없다', () => {
    const packet = makePacket();
    packet.caseReviewAudit.upstreamComplete = false;
    packet.caseReviewAudit.latestScope = 'reviewed_candidate_pool';
    packet.caseReviewAudit.shortfallReason = 'upstream_incomplete';

    const result = validateLegalResearchPacketV1(packet);
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('CASE_REVIEW_UPSTREAM_STATUS_INVALID'));

    packet.status = 'partial';
    const partial = validateLegalResearchPacketV1(packet);
    assert.equal(partial.ok, true, JSON.stringify(partial.errors, null, 2));
});

test('미래 사건일은 FUTURE_EVENT_DATE 차단 근거와 시간 범위 충돌 상태를 요구한다', () => {
    const invalid = makePacket();
    invalid.scope.eventDate = '2030-01-01';
    const invalidResult = validateLegalResearchPacketV1(invalid);
    assert.equal(invalidResult.ok, false);
    assert.ok(errorCodes(invalidResult).includes('FUTURE_EVENT_DATE'));

    const closed = makePacket();
    closed.scope.eventDate = '2030-01-01';
    closed.status = 'temporal_scope_conflict';
    closed.unknowns = [{
        code: 'FUTURE_EVENT_DATE',
        text: '사건일이 현재 기준일보다 뒤다.',
        impact: '현재 시행본의 미래 유효성을 보증할 수 없다.',
        blocking: true,
    }];
    const closedResult = validateLegalResearchPacketV1(closed);
    assert.equal(closedResult.ok, true, JSON.stringify(closedResult.errors, null, 2));
});

test('조회 기준일 뒤에 선고된 판례는 패킷과 답변 sourceIndex에서 모두 거부한다', () => {
    const packet = makePacket();
    packet.cases[0].decisionDate = '2030-01-01';
    const packetResult = validateLegalResearchPacketV1(packet);
    assert.equal(packetResult.ok, false);
    assert.ok(errorCodes(packetResult).includes('FUTURE_CASE_REJECTED'));

    const validPacket = makePacket();
    const answer = makeAnswer(validPacket);
    answer.sourceIndex.find((source) => source.sourceType === 'case')!.decisionDate =
        '2030-01-01';
    const answerResult = validateLegalAnswerV1(answer, validPacket);
    assert.equal(answerResult.ok, false);
    assert.ok(errorCodes(answerResult).includes('FUTURE_CASE_REJECTED'));
});

test('법령 exact match 실패는 불충분 상태와 blocking unknown으로만 정상 반환된다', () => {
    const closed = makePacket();
    closed.status = 'insufficient_evidence';
    closed.laws = [];
    closed.lawSearchAudit.exactLawNameMatched = false;
    closed.unknowns = [{
        code: 'LAW_NOT_FOUND',
        text: '정확히 일치하는 법령을 확인하지 못했다.',
        impact: '법률 명제를 확정할 수 없다.',
        blocking: true,
    }];
    assert.equal(validateLegalResearchPacketV1(closed).ok, true);

    const open = makePacket();
    open.lawSearchAudit.exactLawTypeMatched = false;
    const openResult = validateLegalResearchPacketV1(open);
    assert.equal(openResult.ok, false);
    assert.ok(errorCodes(openResult).includes('AMBIGUOUS_LAW'));
});

test('자치법규 지자체 코드와 명칭이 질문 관할에 exact 일치해야 한다', () => {
    const packet = makePacket();
    packet.ordinances[0].localAuthority = {
        code: '11740',
        name: '서울특별시 강동구',
        level: 'basic',
    };
    const result = validateLegalResearchPacketV1(packet);
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('ORDINANCE_JURISDICTION_MISMATCH'));
});

test('자치법규 조문별 시행일은 형식을 검증하고 법규 전체 시행일보다 우선한다', () => {
    const invalidDate = makePacket();
    invalidDate.ordinances[0].articleEffectiveFrom = '2026-02-30';
    const invalidDateResult = validateLegalResearchPacketV1(invalidDate);
    assert.equal(invalidDateResult.ok, false);
    assert.ok(errorCodes(invalidDateResult).includes('EFFECTIVE_DATE_INVALID'));

    const futureArticle = makePacket();
    futureArticle.ordinances[0].articleEffectiveFrom = '2027-01-01';
    const futureArticleResult = validateLegalResearchPacketV1(futureArticle);
    assert.equal(futureArticleResult.ok, false);
    assert.ok(errorCodes(futureArticleResult).includes('CURRENT_ORDINANCE_REQUIRED'));
});

test('사건일 비교는 자치법규 articleEffectiveFrom을 controlling date로 사용한다', () => {
    const invalid = makePacket();
    invalid.scope.eventDate = '2025-01-01';
    invalid.ordinances[0].articleEffectiveFrom = '2025-06-01';
    const invalidResult = validateLegalResearchPacketV1(invalid);
    assert.equal(invalidResult.ok, false);
    assert.ok(errorCodes(invalidResult).includes('HISTORICAL_LAW_REQUIRED'));

    const closed = makePacket();
    closed.scope.eventDate = '2025-01-01';
    closed.ordinances[0].articleEffectiveFrom = '2025-06-01';
    closed.status = 'temporal_scope_conflict';
    closed.unknowns = [{
        code: 'HISTORICAL_LAW_REQUIRED',
        text: '사건 당시 시행 자치법규가 필요하다.',
        impact: '현행 조례 조문을 소급 적용할 수 없다.',
        blocking: true,
    }];
    const closedResult = validateLegalResearchPacketV1(closed);
    assert.equal(closedResult.ok, true, JSON.stringify(closedResult.errors, null, 2));
});

test('필수 관할 누락은 clarification_required와 blocking unknown으로 닫는다', () => {
    const packet = makePacket();
    packet.scope.localAuthorities = [];
    packet.ordinances = [];
    packet.ordinanceSearchAudit.performed = false;
    packet.status = 'clarification_required';
    packet.unknowns = [{
        code: 'JURISDICTION_REQUIRED',
        text: '사업지 관할이 필요하다.',
        impact: '적용 조례를 정할 수 없다.',
        blocking: true,
    }];
    const result = validateLegalResearchPacketV1(packet);
    assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test('공개 law.go.kr HTTPS canonical 상세 링크만 허용하고 Open API 인증 URL은 거부한다', () => {
    assert.equal(
        isPublicOfficialLawUrlV1('https://www.law.go.kr/precInfoP.do?precSeq=200'),
        true
    );
    assert.equal(
        isPublicOfficialLawUrlV1('http://www.law.go.kr/precInfoP.do?precSeq=200'),
        false
    );
    assert.equal(isPublicOfficialLawUrlV1('https://open.law.go.kr/LSO/openApi/lawService.do?OC=secret'), false);
    assert.equal(
        isPublicOfficialLawUrlV1('https://www.law.go.kr:443/precInfoP.do?precSeq=200'),
        true
    );

    const rejectedUrls = [
        'https://www.law.go.kr:8443/precInfoP.do?precSeq=200',
        'https://user:password@www.law.go.kr/precInfoP.do?precSeq=200',
        'https://www.law.go.kr/판례/(200)',
        'https://www.law.go.kr/precInfoP.do',
        'https://www.law.go.kr/precInfoP.do?precSeq=200&precSeq=200',
        'https://www.law.go.kr/precInfoP.do?precSeq=200&OC=secret',
        'https://www.law.go.kr/precInfoP.do?PRECSEQ=200',
        'https://www.law.go.kr/precInfoP.do?precSeq=200#result',
    ];
    rejectedUrls.forEach((url) => assert.equal(isPublicOfficialLawUrlV1(url), false, url));

    const packet = makePacket();
    packet.laws[0].officialUrl = 'https://www.law.go.kr/openApi/lawService.do?OC=secret';
    const result = validateLegalResearchPacketV1(packet);
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('NON_PUBLIC_URL_REJECTED'));
});

test('출처 유형별 canonical 경로와 공식 URL 식별자가 source record와 exact 일치해야 한다', () => {
    const wrongPath = makePacket();
    wrongPath.laws[0].officialUrl = 'https://www.law.go.kr/precInfoP.do?precSeq=250000';
    const wrongPathResult = validateLegalResearchPacketV1(wrongPath);
    assert.equal(wrongPathResult.ok, false);
    assert.ok(errorCodes(wrongPathResult).includes('OFFICIAL_URL_SOURCE_TYPE_MISMATCH'));

    const wrongLawId = makePacket();
    wrongLawId.laws[0].officialUrl = 'https://www.law.go.kr/lsInfoP.do?lsiSeq=999999';
    const wrongLawIdResult = validateLegalResearchPacketV1(wrongLawId);
    assert.equal(wrongLawIdResult.ok, false);
    assert.ok(errorCodes(wrongLawIdResult).includes('SOURCE_URL_ID_MISMATCH'));

    const wrongOrdinanceId = makePacket();
    wrongOrdinanceId.ordinances[0].officialUrl =
        'https://www.law.go.kr/ordinInfoP.do?ordinSeq=WRONG-MST';
    const wrongOrdinanceIdResult = validateLegalResearchPacketV1(wrongOrdinanceId);
    assert.equal(wrongOrdinanceIdResult.ok, false);
    assert.ok(errorCodes(wrongOrdinanceIdResult).includes('SOURCE_URL_ID_MISMATCH'));

    const wrongCaseId = makePacket();
    wrongCaseId.cases[0].officialUrl =
        'https://www.law.go.kr/precInfoP.do?precSeq=999';
    const wrongCaseIdResult = validateLegalResearchPacketV1(wrongCaseId);
    assert.equal(wrongCaseIdResult.ok, false);
    assert.ok(errorCodes(wrongCaseIdResult).includes('SOURCE_URL_ID_MISMATCH'));
});

test('판례 relevance.reason과 matchedProvisions는 전문 기반 비어있지 않은 값이어야 한다', () => {
    const emptyReason = makePacket();
    emptyReason.cases[0].relevance.reason = '   ';
    const emptyReasonResult = validateLegalResearchPacketV1(emptyReason);
    assert.equal(emptyReasonResult.ok, false);
    assert.ok(errorCodes(emptyReasonResult).includes('CASE_RELEVANCE_NOT_PROVEN'));

    const emptyProvisions = makePacket();
    emptyProvisions.cases[0].relevance.matchedProvisions = [];
    const emptyProvisionsResult = validateLegalResearchPacketV1(emptyProvisions);
    assert.equal(emptyProvisionsResult.ok, false);
    assert.ok(errorCodes(emptyProvisionsResult).includes('CASE_RELEVANCE_NOT_PROVEN'));

    const changedRule = makePacket();
    changedRule.cases[0].currentLawFit = 'changed_rule';
    const changedRuleResult = validateLegalResearchPacketV1(changedRule);
    assert.equal(changedRuleResult.ok, false);
    assert.ok(errorCodes(changedRuleResult).includes('CASE_CURRENT_LAW_FIT_UNKNOWN'));

    const candidate = makePacket();
    candidate.cases[0].currentLawFit = 'current_rule_candidate';
    candidate.cases[0].relevance.grade = 'analogical';
    candidate.cases[0].useInConclusion = 'analogical_support';
    const candidateResult = validateLegalResearchPacketV1(candidate);
    assert.equal(candidateResult.ok, true, JSON.stringify(candidateResult.errors, null, 2));

    const overstatedCandidate = makePacket();
    overstatedCandidate.cases[0].currentLawFit = 'current_rule_candidate';
    const overstatedResult = validateLegalResearchPacketV1(overstatedCandidate);
    assert.equal(overstatedResult.ok, false);
    assert.ok(errorCodes(overstatedResult).includes('CASE_CURRENT_RULE_CANDIDATE_MISUSED'));
});

test('답변의 모든 법률 명제와 적용 판단은 존재하는 sourceId를 참조해야 한다', () => {
    const packet = makePacket();
    const answer = makeAnswer(packet);
    const valid = validateLegalAnswerV1(answer, packet);
    assert.equal(valid.ok, true, JSON.stringify(valid.errors, null, 2));

    answer.ruleClaims[0].sourceIds = ['missing-law'];
    const invalid = validateLegalAnswerV1(answer, packet);
    assert.equal(invalid.ok, false);
    assert.ok(errorCodes(invalid).includes('SOURCE_REFERENCE_NOT_FOUND'));
});

test('답변의 판례 제외 집계는 JSON key 순서와 무관하게 packet과 exact 일치한다', () => {
    const packet = makePacket();
    const answer = makeAnswer(packet);
    const exclusions = answer.caseSynthesis.exclusions;
    answer.caseSynthesis.exclusions = {
        unofficialUrl: exclusions.unofficialUrl,
        currentLawMisaligned: exclusions.currentLawMisaligned,
        irrelevant: exclusions.irrelevant,
        identityMismatch: exclusions.identityMismatch,
        fullTextUnavailable: exclusions.fullTextUnavailable,
        duplicate: exclusions.duplicate,
    };

    const reordered = validateLegalAnswerV1(answer, packet);
    assert.equal(reordered.ok, true, JSON.stringify(reordered.errors, null, 2));

    answer.caseSynthesis.exclusions.irrelevant = 1;
    const changedValue = validateLegalAnswerV1(answer, packet);
    assert.equal(changedValue.ok, false);
    assert.ok(errorCodes(changedValue).includes('CASE_AUDIT_PACKET_MISMATCH'));
});

test('결론·명제·적용의 인용문은 같은 sourceId의 공식 원문 exact substring이어야 한다', () => {
    const packet = makePacket();
    const answer = makeAnswer(packet);
    answer.conclusion.evidenceQuotes[0].quote = '공식 원문에 없는 전면 금지 문구';

    const result = validateLegalAnswerV1(answer, packet);
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('EVIDENCE_QUOTE_NOT_FOUND'));
});

test('supported 결론은 법률 명제를, 제공 사실은 적용 판단을 최소 한 건 요구한다', () => {
    const packet = makePacket();
    const noRuleClaim = makeAnswer(packet);
    noRuleClaim.ruleClaims = [];
    const noRuleClaimResult = validateLegalAnswerV1(noRuleClaim, packet);
    assert.equal(noRuleClaimResult.ok, false);
    assert.ok(errorCodes(noRuleClaimResult).includes('RULE_CLAIM_REQUIRED'));

    const noApplication = makeAnswer(packet);
    noApplication.applications = [];
    const noApplicationResult = validateLegalAnswerV1(noApplication, packet);
    assert.equal(noApplicationResult.ok, false);
    assert.ok(errorCodes(noApplicationResult).includes('APPLICATION_REQUIRED'));
});

test('판례 후보만으로 확정 결론이나 사실 적용을 만들 수 없다', () => {
    const packet = makePacket();
    packet.cases[0].currentLawFit = 'current_rule_candidate';
    packet.cases[0].relevance.grade = 'analogical';
    packet.cases[0].useInConclusion = 'analogical_support';
    const answer = makeAnswer(packet);
    answer.sourceIndex = [...packet.laws, ...packet.ordinances, ...packet.cases];
    answer.conclusion.sourceIds = [packet.cases[0].sourceId];
    answer.applications[0].sourceIds = [packet.cases[0].sourceId];

    const result = validateLegalAnswerV1(answer, packet);
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('CURRENT_RULE_SOURCE_REQUIRED'));
});

test('blocking unknown이 있으면 supported와 conditional을 모두 금지하고 cannot_conclude만 허용한다', () => {
    const packet = makePacket();
    packet.status = 'insufficient_evidence';
    packet.unknowns = [{
        code: 'MISSING_REPRESENTATIVE_DESIGNATION',
        text: '공동소유자의 대표자 지정 여부가 확인되지 않았다.',
        impact: '전자투표의 유효성을 확정할 수 없다.',
        blocking: true,
    }];
    const answer = makeAnswer(packet);
    answer.status = packet.status;
    answer.unknowns = structuredClone(packet.unknowns);
    const result = validateLegalAnswerV1(answer, packet);
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('BLOCKING_UNKNOWN_REQUIRES_CANNOT_CONCLUDE'));

    answer.conclusion.kind = 'conditional';
    const conditional = validateLegalAnswerV1(answer, packet);
    assert.equal(conditional.ok, false);
    assert.ok(errorCodes(conditional).includes('BLOCKING_UNKNOWN_REQUIRES_CANNOT_CONCLUDE'));

    answer.conclusion.kind = 'cannot_conclude';
    const hiddenAssertion = validateLegalAnswerV1(answer, packet);
    assert.equal(hiddenAssertion.ok, false);
    assert.ok(errorCodes(hiddenAssertion).includes('BLOCKING_UNKNOWN_CONCLUSION_NOT_SERVER_FIXED'));
    assert.ok(errorCodes(hiddenAssertion).includes('BLOCKING_UNKNOWN_APPLICATIONS_FORBIDDEN'));

    answer.conclusion = {
        kind: 'cannot_conclude',
        text: LEGAL_BLOCKING_UNKNOWN_CONCLUSION_TEXT,
        sourceIds: [],
        evidenceQuotes: [],
    };
    answer.applications = [];
    const cannotConclude = validateLegalAnswerV1(answer, packet);
    assert.equal(cannotConclude.ok, true, JSON.stringify(cannotConclude.errors, null, 2));
});

test('packet의 blocking unknown을 답변에서 숨겨도 서버 고정 결론 경계를 우회할 수 없다', () => {
    const packet = makePacket();
    packet.status = 'insufficient_evidence';
    packet.unknowns = [{
        code: 'MISSING_REPRESENTATIVE_DESIGNATION',
        text: '공동소유자의 대표자 지정 여부가 확인되지 않았다.',
        impact: '전자투표의 유효성을 확정할 수 없다.',
        blocking: true,
    }];
    const answer = makeAnswer(packet);
    answer.status = packet.status;
    answer.unknowns = [];
    answer.conclusion.kind = 'cannot_conclude';

    const result = validateLegalAnswerV1(answer, packet);
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('UNKNOWNS_PACKET_MISMATCH'));
    assert.ok(errorCodes(result).includes('BLOCKING_UNKNOWN_CONCLUSION_NOT_SERVER_FIXED'));
    assert.ok(errorCodes(result).includes('BLOCKING_UNKNOWN_APPLICATIONS_FORBIDDEN'));
});

test('temporal_scope_conflict 답변은 적용 판단을 current_rule_applies로 표시할 수 없다', () => {
    const packet = makePacket();
    packet.scope.eventDate = '2020-01-01';
    packet.status = 'temporal_scope_conflict';
    packet.unknowns = [{
        code: 'HISTORICAL_LAW_REQUIRED',
        text: '사건 당시 시행본이 필요하다.',
        impact: '현행 규정을 소급 적용할 수 없다.',
        blocking: true,
    }];
    const answer = makeAnswer(packet);
    answer.status = packet.status;
    answer.scope = structuredClone(packet.scope);
    answer.unknowns = structuredClone(packet.unknowns);
    answer.sourceIndex = structuredClone([
        ...packet.laws,
        ...packet.ordinances,
        ...packet.cases,
    ]);
    answer.conclusion.kind = 'cannot_conclude';
    answer.temporalReview.historicalLawRequired = true;
    answer.applications[0].temporalApplicability = 'current_rule_applies';

    const result = validateLegalAnswerV1(answer, packet);
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('APPLICATION_TEMPORAL_MISMATCH'));
});

test('검증되지 않은 사용자 사실을 참조한 적용 판단은 high confidence를 사용할 수 없다', () => {
    const packet = makePacket();
    packet.facts[0].verification = 'unverified';
    const answer = makeAnswer(packet);
    answer.facts = structuredClone(packet.facts);
    answer.applications[0].confidence = 'high';

    const result = validateLegalAnswerV1(answer, packet);
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('APPLICATION_CONFIDENCE_OVERSTATED'));

    answer.applications[0].confidence = 'medium';
    const conservative = validateLegalAnswerV1(answer, packet);
    assert.equal(conservative.ok, true, JSON.stringify(conservative.errors, null, 2));
});

test('런타임 validator는 손상된 중첩 배열에서도 예외 대신 구조화 오류를 반환한다', () => {
    const malformedPacket = {
        ...makePacket(),
        facts: [null],
        laws: [null],
        cases: [{ sourceType: 'case' }],
        caseReviewCandidates: [{ reviewOnly: true }],
        unknowns: [null],
    };
    let packetResult: ReturnType<typeof validateLegalResearchPacketV1> | undefined;
    assert.doesNotThrow(() => {
        packetResult = validateLegalResearchPacketV1(malformedPacket);
    });
    assert.equal(packetResult?.ok, false);
    assert.ok((packetResult?.errors.length ?? 0) > 0);

    const packet = makePacket();
    const malformedAnswer = {
        ...makeAnswer(packet),
        sourceIndex: [null],
        facts: [null],
        ruleClaims: [null],
        applications: [null],
        caseReviewCandidates: [{ reviewOnly: true }],
    };
    let answerResult: ReturnType<typeof validateLegalAnswerV1> | undefined;
    assert.doesNotThrow(() => {
        answerResult = validateLegalAnswerV1(malformedAnswer);
    });
    assert.equal(answerResult?.ok, false);
    assert.ok((answerResult?.errors.length ?? 0) > 0);
});
