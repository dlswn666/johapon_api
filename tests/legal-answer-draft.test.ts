import assert from 'node:assert/strict';
import test from 'node:test';
import * as z from 'zod/v4';
import {
    LEGAL_ANSWER_DRAFT_LIMITS,
    LegalAnswerDraftV1Schema,
    buildLegalAnswerFromDraftV1,
    type LegalAnswerDraftV1,
} from '../src/services/legal-research/answer-draft';
import {
    LEGAL_ANSWER_VERSION,
    LEGAL_BLOCKING_UNKNOWN_CONCLUSION_TEXT,
    LEGAL_DISCLAIMER,
    LEGAL_POLICY_VERSION,
    LEGAL_RESEARCH_PACKET_VERSION,
    type CaseSourceV1,
    type LegalResearchPacketV1,
} from '../src/services/legal-research/model';
import { LegalContractValidationError } from '../src/services/legal-research/validator';
import {
    buildLegalPlanCoverageAuditV1,
    type LegalResearchPlanV1,
} from '../src/services/legal-research/research-plan';

const retrievedAt = '2026-08-31T09:00:00+09:00';
const packetQuestion = '조합설립 동의 요건은 무엇인가?';
const packetResearchPlan: LegalResearchPlanV1 = {
    issues: [{
        issueId: 'ISSUE-1',
        issue: '조합설립 동의 요건',
        requestedOutcome: 'vote_threshold',
    }],
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

function makeCase(): CaseSourceV1 {
    return {
        sourceId: 'case-300',
        sourceType: 'case',
        official: true,
        title: '조합설립인가처분취소',
        officialUrl: 'https://www.law.go.kr/precInfoP.do?precSeq=300',
        retrievedAt,
        verificationStatus: 'verified',
        exactTextHash: 'c'.repeat(64),
        caseSerialId: '300',
        caseName: '조합설립인가처분취소',
        caseNumber: '2026두300',
        court: '대법원',
        decisionDate: '2026-05-01',
        holding: '조합설립 동의 요건을 판시하였다.',
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
    const legalCase = makeCase();
    return {
        contractVersion: LEGAL_RESEARCH_PACKET_VERSION,
        packetId: 'packet-draft-1',
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
                verification: 'verified',
            },
        ],
        laws: [
            {
                sourceId: 'law-1',
                sourceType: 'law',
                official: true,
                title: '도시 및 주거환경정비법',
                officialUrl: 'https://www.law.go.kr/lsInfoP.do?lsiSeq=LAW-MST-1',
                retrievedAt,
                verificationStatus: 'verified',
                exactTextHash: 'a'.repeat(64),
                lawId: 'LAW-1',
                mst: 'LAW-MST-1',
                lawType: '법률',
                effectiveFrom: '2024-01-01',
                versionStatus: 'current',
                appliesAsOf: true,
                provision: { article: '제35조', paragraph: '제2항' },
                exactText: '법정 동의를 받아야 한다.',
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
                exactTextHash: 'b'.repeat(64),
                ordinanceId: 'ORD-1',
                mst: 'ORD-MST-1',
                ordinanceType: '조례',
                localAuthority: { code: '11680', name: '서울특별시 강남구', level: 'basic' },
                jurisdictionMatch: 'exact',
                effectiveFrom: '2024-01-01',
                versionStatus: 'current',
                appliesAsOf: true,
                provision: { article: '제10조' },
                exactText: '관할 세부 절차를 정한다.',
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
        cases: [legalCase],
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
            candidateCount: 1,
            qualifiedCount: 1,
            returnedCount: 1,
            target: 'prec',
            listSort: 'ddes',
            resultSort: 'decision_date_desc_case_serial_id_desc',
            lawNameQueries: ['도시 및 주거환경정비법'],
            issueQueries: ['조합설립 동의'],
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
        unknowns: [],
        provenance: {
            provider: 'KOREA_LAW_OPEN_API',
            policyVersion: LEGAL_POLICY_VERSION,
            generatedAt: retrievedAt,
        },
    };
}

function makeDraft(): LegalAnswerDraftV1 {
    return {
        conclusion: {
            kind: 'supported',
            text: '현행법상 법정 동의 요건을 충족해야 한다.',
            sourceIds: ['law-1'],
            evidenceQuotes: [{ sourceId: 'law-1', quote: '법정 동의를 받아야 한다.' }],
        },
        ruleClaims: [
            {
                claimId: 'rule-1',
                text: '조합설립에는 법정 동의가 필요하다.',
                sourceIds: ['law-1'],
                evidenceQuotes: [{ sourceId: 'law-1', quote: '법정 동의를 받아야 한다.' }],
            },
        ],
        ordinanceAnalysis: [
            {
                analysisId: 'ordinance-analysis-1',
                text: '관할 조례의 세부 절차를 함께 확인해야 한다.',
                sourceIds: ['ordinance-1'],
                evidenceQuotes: [{ sourceId: 'ordinance-1', quote: '관할 세부 절차를 정한다.' }],
            },
        ],
        caseSummary: '현행 규정과 동일한 법리를 다룬 직접 관련 판례 1건을 확인했다.',
        caseEvidenceQuotes: [{ sourceId: 'case-300', quote: '조합설립 동의 요건을 판시하였다.' }],
        applications: [
            {
                applicationId: 'application-1',
                issue: '동의 요건',
                factIds: ['fact-1'],
                sourceIds: ['law-1', 'ordinance-1', 'case-300'],
                evidenceQuotes: [
                    { sourceId: 'law-1', quote: '법정 동의를 받아야 한다.' },
                    { sourceId: 'ordinance-1', quote: '관할 세부 절차를 정한다.' },
                    { sourceId: 'case-300', quote: '조합설립 동의 요건을 판시하였다.' },
                ],
                inference: '확인된 관할과 현행 규정을 제공 사실에 적용하였다.',
                result: '법정 동의율과 관할 절차를 충족해야 한다.',
                temporalApplicability: 'current_rule_applies',
                confidence: 'high',
            },
        ],
        temporalReview: {
            summary: '사건일은 인용한 법령과 조례의 시행일 이후이다.',
            sourceIds: ['law-1', 'ordinance-1'],
            evidenceQuotes: [
                { sourceId: 'law-1', quote: '법정 동의를 받아야 한다.' },
                { sourceId: 'ordinance-1', quote: '관할 세부 절차를 정한다.' },
            ],
            historicalLawRequired: false,
        },
        warnings: [],
    };
}

test('draft schema는 host가 작성할 8개 서술 필드만 strict하게 허용한다', () => {
    assert.equal(LegalAnswerDraftV1Schema.safeParse(makeDraft()).success, true);

    const immutableRootField = {
        ...makeDraft(),
        packetId: 'host-overwrite',
    };
    assert.equal(LegalAnswerDraftV1Schema.safeParse(immutableRootField).success, false);

    const immutableNestedField = {
        ...makeDraft(),
        conclusion: {
            ...makeDraft().conclusion,
            officialUrl: 'https://example.com',
        },
    };
    assert.equal(LegalAnswerDraftV1Schema.safeParse(immutableNestedField).success, false);
});

test('JSON Schema 설명은 MCP host에 packet 참조와 자동 채움 규칙을 안내한다', () => {
    const jsonSchema = z.toJSONSchema(LegalAnswerDraftV1Schema) as Record<string, unknown>;
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
    const conclusion = properties.conclusion;
    const conclusionProperties = conclusion.properties as Record<string, Record<string, unknown>>;
    const applicationItems = properties.applications.items as Record<string, unknown>;
    const applicationProperties = applicationItems.properties as Record<string, Record<string, unknown>>;

    assert.deepEqual(Object.keys(properties).sort(), [
        'applications',
        'caseEvidenceQuotes',
        'caseSummary',
        'conclusion',
        'ordinanceAnalysis',
        'ruleClaims',
        'temporalReview',
        'warnings',
    ]);
    assert.equal(jsonSchema.additionalProperties, false);
    assert.match(String(properties.caseSummary.description), /최신순/);
    assert.match(String(properties.caseSummary.description), /서버가 자동/);
    assert.match(String(conclusionProperties.kind.description), /blocking/);
    assert.match(String(conclusionProperties.kind.description), /cannot_conclude/);
    assert.match(String(conclusionProperties.sourceIds.description), /packet sourceId/);
    assert.match(String(applicationProperties.factIds.description), /packet의 facts/);
});

test('enum, 문자열 길이, 배열 수와 중복 참조 상한을 명시적으로 거부한다', () => {
    const longConclusion = makeDraft();
    longConclusion.conclusion.text = '가'.repeat(
        LEGAL_ANSWER_DRAFT_LIMITS.conclusionTextLength + 1
    );
    assert.equal(LegalAnswerDraftV1Schema.safeParse(longConclusion).success, false);

    const tooManyClaims = makeDraft();
    tooManyClaims.ruleClaims = Array.from(
        { length: LEGAL_ANSWER_DRAFT_LIMITS.ruleClaimCount + 1 },
        (_, index) => ({
            claimId: `rule-${index + 1}`,
            text: '법률 명제',
            sourceIds: ['law-1'],
            evidenceQuotes: [{ sourceId: 'law-1', quote: '법정 동의를 받아야 한다.' }],
        })
    );
    assert.equal(LegalAnswerDraftV1Schema.safeParse(tooManyClaims).success, false);

    const invalidEnum = {
        ...makeDraft(),
        applications: [{
            ...makeDraft().applications[0],
            confidence: 'certain',
        }],
    };
    assert.equal(LegalAnswerDraftV1Schema.safeParse(invalidEnum).success, false);

    const duplicateSource = makeDraft();
    duplicateSource.conclusion.sourceIds = ['law-1', 'law-1'];
    assert.equal(LegalAnswerDraftV1Schema.safeParse(duplicateSource).success, false);

    const unsupportedFreeText = makeDraft();
    unsupportedFreeText.conclusion.text = '모든 정비사업은 예외 없이 전면 금지된다.';
    unsupportedFreeText.conclusion.evidenceQuotes = [];
    unsupportedFreeText.ruleClaims = [];
    assert.equal(LegalAnswerDraftV1Schema.safeParse(unsupportedFreeText).success, false);
});

test('builder는 패킷 불변 필드와 판례 메타데이터를 서버 packet에서만 채운다', () => {
    const packet = makePacket();
    const draft = makeDraft();
    const answer = buildLegalAnswerFromDraftV1(packet, draft);

    assert.equal(answer.contractVersion, LEGAL_ANSWER_VERSION);
    assert.equal(answer.packetId, packet.packetId);
    assert.equal(answer.status, packet.status);
    assert.deepEqual(answer.scope, packet.scope);
    assert.deepEqual(answer.facts, packet.facts);
    assert.deepEqual(answer.unknowns, packet.unknowns);
    assert.equal(answer.disclaimer, LEGAL_DISCLAIMER);
    assert.deepEqual(
        answer.sourceIndex.map((source) => source.sourceId),
        ['law-1', 'ordinance-1', 'case-300']
    );
    assert.deepEqual(answer.caseSynthesis, {
        returnedCount: 1,
        summary: draft.caseSummary,
        sourceIds: ['case-300'],
        shortfallReason: 'official_results_exhausted',
        upstreamComplete: true,
        evidenceQuotes: draft.caseEvidenceQuotes,
        searchScope: {
            normalizedPlanHash: packet.planCoverageAudit.normalizedPlanHash,
            lawNameQueries: ['도시 및 주거환경정비법'],
            issueQueries: ['조합설립 동의'],
        },
    });
});

test('builder 결과의 패킷 유래 배열과 객체는 원본 packet을 공유하지 않는다', () => {
    const packet = makePacket();
    const answer = buildLegalAnswerFromDraftV1(packet, makeDraft());

    assert.notEqual(answer.scope, packet.scope);
    assert.notEqual(answer.facts, packet.facts);
    assert.notEqual(answer.unknowns, packet.unknowns);
    assert.notEqual(answer.sourceIndex[0], packet.laws[0]);

    answer.scope.localAuthorities[0].name = '변조된 관할';
    answer.facts[0].text = '변조된 사실';
    assert.equal(packet.scope.localAuthorities[0].name, '서울특별시 강남구');
    assert.equal(packet.facts[0].text, '사업지는 서울특별시 강남구이다.');
});

test('존재하지 않는 sourceId와 blocking 상태의 supported·conditional 결론은 validator가 차단한다', () => {
    const badReference = makeDraft();
    badReference.conclusion.sourceIds = ['missing-law'];
    assert.throws(
        () => buildLegalAnswerFromDraftV1(makePacket(), badReference),
        LegalContractValidationError
    );

    const blockedPacket = makePacket();
    blockedPacket.status = 'insufficient_evidence';
    blockedPacket.unknowns = [{
        code: 'SOURCE_MISMATCH',
        text: '공식 원문 식별자가 일치하지 않는다.',
        impact: '결론을 확정할 수 없다.',
        blocking: true,
    }];
    assert.throws(
        () => buildLegalAnswerFromDraftV1(blockedPacket, makeDraft()),
        LegalContractValidationError
    );

    const conditionalDraft = makeDraft();
    conditionalDraft.conclusion.kind = 'conditional';
    assert.throws(
        () => buildLegalAnswerFromDraftV1(blockedPacket, conditionalDraft),
        LegalContractValidationError
    );

    const hiddenAssertionDraft = makeDraft();
    hiddenAssertionDraft.conclusion.kind = 'cannot_conclude';
    hiddenAssertionDraft.conclusion.text = '대표자 지정이 없어도 A의 찬성표는 유효하다.';
    hiddenAssertionDraft.applications[0].result = 'A의 찬성표를 산입해야 한다.';
    const deferredAnswer = buildLegalAnswerFromDraftV1(blockedPacket, hiddenAssertionDraft);

    assert.deepEqual(deferredAnswer.conclusion, {
        kind: 'cannot_conclude',
        text: LEGAL_BLOCKING_UNKNOWN_CONCLUSION_TEXT,
        sourceIds: [],
        evidenceQuotes: [],
    });
    assert.deepEqual(deferredAnswer.applications, []);
    assert.doesNotMatch(JSON.stringify(deferredAnswer), /A의 찬성표/);
});
