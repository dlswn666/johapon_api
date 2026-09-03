import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildRenderedLegalAnswerV1,
    renderLegalAnswerV1,
} from '../src/services/legal-research/answer-renderer';
import {
    LEGAL_ANSWER_SECTION_HEADINGS,
    LEGAL_ANSWER_VERSION,
    LEGAL_BLOCKING_UNKNOWN_CONCLUSION_TEXT,
    LEGAL_DISCLAIMER,
    LEGAL_POLICY_VERSION,
    LEGAL_RESEARCH_PACKET_VERSION,
    type CaseReviewCandidateV1,
    type CaseSourceV1,
    type LegalAnswerV1,
    type LegalResearchPacketV1,
} from '../src/services/legal-research/model';
import {
    LegalContractValidationError,
    validateLegalAnswerMarkdownV1,
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

function makeCase(serial: string, date: string): CaseSourceV1 {
    return {
        sourceId: `case-${serial}`,
        sourceType: 'case',
        official: true,
        title: `조합설립인가처분취소 ${serial}`,
        officialUrl: `https://www.law.go.kr/precInfoP.do?precSeq=${serial}`,
        retrievedAt,
        verificationStatus: 'verified',
        exactTextHash: 'c'.repeat(64),
        caseSerialId: serial,
        caseName: '조합설립인가처분취소',
        caseNumber: `2026두${serial}`,
        court: '대법원',
        decisionDate: date,
        holding: '조합설립 동의 요건을 판시하였다.',
        holdingSource: 'official_holdings',
        reasoningSummary: '현행 규정과 동일한 규정을 해석하였다.',
        referencedProvisions: ['도시정비법 제35조'],
        fullTextVerified: true,
        listingIdentityVerified: true,
        relevance: {
            grade: 'direct',
            matchedIssues: ['조합설립 동의'],
            matchedProvisions: ['도시정비법 제35조'],
            reason: '쟁점과 참조조문이 직접 일치한다.',
        },
        currentLawFit: 'verified_same_rule',
        useInConclusion: 'direct_support',
    };
}

function makePacket(): LegalResearchPacketV1 {
    const cases = [makeCase('200', '2026-05-01'), makeCase('100', '2026-05-01')];
    return {
        contractVersion: LEGAL_RESEARCH_PACKET_VERSION,
        packetId: 'packet-render-1',
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
            evidenceQuotes: [{ sourceId: 'law-1', quote: '법정 동의를 받아야 한다.' }],
        },
        scope: structuredClone(packet.scope),
        facts: structuredClone(packet.facts),
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
                analysisId: 'ordinance-1',
                text: '관할 조례의 절차도 확인해야 한다.',
                sourceIds: ['ordinance-1'],
                evidenceQuotes: [{ sourceId: 'ordinance-1', quote: '관할 세부 절차를 정한다.' }],
            },
        ],
        caseSynthesis: {
            candidateCount: packet.caseSearchAudit.candidateCount,
            qualifiedCount: packet.caseSearchAudit.qualifiedCount,
            returnedCount: 2,
            exclusions: structuredClone(packet.caseSearchAudit.exclusions),
            summary: '현행 규정과 동일한 법리를 다룬 직접 관련 판례이다.',
            sourceIds: ['case-200', 'case-100'],
            shortfallReason: 'official_results_exhausted',
            upstreamComplete: true,
            evidenceQuotes: [
                { sourceId: 'case-200', quote: '조합설립 동의 요건을 판시하였다.' },
                { sourceId: 'case-100', quote: '조합설립 동의 요건을 판시하였다.' },
            ],
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
                    { sourceId: 'law-1', quote: '법정 동의를 받아야 한다.' },
                    { sourceId: 'ordinance-1', quote: '관할 세부 절차를 정한다.' },
                    { sourceId: 'case-200', quote: '조합설립 동의 요건을 판시하였다.' },
                ],
                inference: '확인된 관할과 현행 규정을 사실에 적용하였다.',
                result: '법정 동의율을 충족해야 한다.',
                temporalApplicability: 'current_rule_applies',
                confidence: 'high',
            },
        ],
        temporalReview: {
            summary: '사건일은 인용 조문의 시행일 이후이므로 소급 적용 문제가 없다.',
            sourceIds: ['law-1'],
            evidenceQuotes: [{ sourceId: 'law-1', quote: '법정 동의를 받아야 한다.' }],
            historicalLawRequired: false,
        },
        unknowns: [],
        warnings: [],
        sourceIndex: structuredClone([
            ...packet.laws,
            ...packet.ordinances,
            ...packet.cases,
        ]),
        disclaimer: LEGAL_DISCLAIMER,
    };
}

test('동일한 검증 입력은 byte-identical Markdown과 고정 11개 섹션을 만든다', () => {
    const packet = makePacket();
    const answer = makeAnswer(packet);
    const first = renderLegalAnswerV1(packet, answer);
    const second = renderLegalAnswerV1(packet, structuredClone(answer));

    assert.equal(first, second);
    assert.equal(validateLegalAnswerMarkdownV1(first).ok, true);
    assert.deepEqual(first.match(/^## .+$/gm), [...LEGAL_ANSWER_SECTION_HEADINGS]);
    for (const heading of LEGAL_ANSWER_SECTION_HEADINGS) {
        assert.equal(first.split(heading).length - 1, 1);
    }
});

test('현행 법령·관할 조례·판례의 공식 링크와 실제 반환 건수를 표시한다', () => {
    const packet = makePacket();
    const markdown = renderLegalAnswerV1(packet, makeAnswer(packet));

    assert.match(markdown, /https:\/\/www\.law\.go\.kr\/lsInfoP\.do\?lsiSeq=LAW-MST-1/);
    assert.match(markdown, /https:\/\/www\.law\.go\.kr\/ordinInfoP\.do\?ordinSeq=ORD-MST-1/);
    assert.match(markdown, /https:\/\/www\.law\.go\.kr\/precInfoP\.do\?precSeq=200/);
    assert.match(markdown, /공식 후보 검토: 2건; 검증 적격: 2건; 반환: 2건 \(최대 12건\)/);
    assert.match(markdown, /제외 집계: 전문 미확인 0건/);
    assert.match(markdown, /공식 판시사항: 조합설립 동의 요건을 판시하였다/);
    assert.match(markdown, /조사 상태: complete \(조사 계약 완료\)/);
    assert.match(markdown, /계획된 법령명·쟁점 검색 stream 내 최신순 완결성: 검증됨/);
    assert.match(markdown, /검색계획 hash:/);
    assert.match(markdown, /12건 미만 사유: 관련성 기준을 충족한 공식 검색 결과가 더 없음/);
    assert.match(markdown, /과거 법령 추가 확인 필요: 아니오/);
});

test('사건일 미제공 시 과거 법령 확인 필요 여부를 아니오로 단정하지 않는다', () => {
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

    const answer = makeAnswer(packet);
    answer.status = packet.status;
    answer.scope = structuredClone(packet.scope);
    answer.conclusion = {
        kind: 'cannot_conclude',
        text: LEGAL_BLOCKING_UNKNOWN_CONCLUSION_TEXT,
        sourceIds: [],
        evidenceQuotes: [],
    };
    answer.temporalReview.summary = '사건일은 인용 조문의 시행일 이후이므로 소급 적용 문제가 없다.';
    answer.caseSynthesis.upstreamComplete = false;
    answer.caseSynthesis.shortfallReason = 'upstream_incomplete';
    answer.applications = [];
    answer.unknowns = structuredClone(packet.unknowns);

    const markdown = renderLegalAnswerV1(packet, answer);

    assert.match(markdown, /사건일: 미제공/);
    assert.match(markdown, /사건일이 제공되지 않아 사건 당시 시행본 추가 확인 필요 여부를 판단할 수 없습니다/);
    assert.match(markdown, /과거 법령 추가 확인 필요: 판단 불가 \(사건일 미제공\)/);
    assert.doesNotMatch(markdown, /과거 법령 추가 확인 필요: 아니오/);
    assert.doesNotMatch(markdown, /사건일은 인용 조문의 시행일 이후/);
    assert.doesNotMatch(markdown, /시점 검토 원문 인용/);
});

test('판례 섹션은 패킷의 최신순과 caseSerialId DESC 동률 순서를 보존한다', () => {
    const packet = makePacket();
    const markdown = renderLegalAnswerV1(packet, makeAnswer(packet));
    const caseSectionStart = markdown.indexOf('## 6. 관련 판례');
    const applicationSectionStart = markdown.indexOf('## 7. 사실에 대한 적용과 판단');
    const caseSection = markdown.slice(caseSectionStart, applicationSectionStart);

    assert.ok(caseSection.indexOf('조합설립인가처분취소 200') < caseSection.indexOf('조합설립인가처분취소 100'));
});

test('blocking unknown 답변은 서버 고정 결론과 빈 적용 판단만 렌더링한다', () => {
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
    answer.conclusion = {
        kind: 'cannot_conclude',
        text: LEGAL_BLOCKING_UNKNOWN_CONCLUSION_TEXT,
        sourceIds: [],
        evidenceQuotes: [],
    };
    answer.applications = [];

    const markdown = renderLegalAnswerV1(packet, answer);
    const conclusionStart = markdown.indexOf('## 1. 검토 결론');
    const scopeStart = markdown.indexOf('## 2. 적용 기준일·사건일·관할');
    const applicationStart = markdown.indexOf('## 7. 사실에 대한 적용과 판단');
    const temporalStart = markdown.indexOf('## 8. 소급 적용·경과조치 검토');
    assert.match(markdown.slice(conclusionStart, scopeStart), new RegExp(LEGAL_BLOCKING_UNKNOWN_CONCLUSION_TEXT));
    assert.match(markdown.slice(applicationStart, temporalStart), /해당 없음/);

    answer.conclusion.text = '대표자 지정이 없어도 A의 찬성표는 유효하다.';
    answer.applications = makeAnswer(packet).applications;
    assert.throws(
        () => renderLegalAnswerV1(packet, answer),
        LegalContractValidationError
    );
});

test('동적 문장의 줄바꿈과 가짜 heading은 고정 섹션 구조를 바꾸지 못한다', () => {
    const packet = makePacket();
    const answer = makeAnswer(packet);
    answer.conclusion.text = '결론 문장\n## 99. 삽입 섹션';
    const markdown = renderLegalAnswerV1(packet, answer);

    assert.equal(markdown.match(/^## 99\. 삽입 섹션$/gm), null);
    assert.equal(validateLegalAnswerMarkdownV1(markdown).ok, true);
});

test('빈 선택 섹션도 생략하지 않고 해당 없음 또는 0건으로 명시한다', () => {
    const packet = makePacket();
    packet.ordinances = [];
    packet.ordinanceSearchAudit.required = false;
    packet.cases = [];
    packet.caseSearchAudit.candidateCount = 0;
    packet.caseSearchAudit.qualifiedCount = 0;
    packet.caseSearchAudit.returnedCount = 0;
    packet.caseReviewAudit.candidatePoolCount = 0;

    const answer = makeAnswer(packet);
    answer.ordinanceAnalysis = [];
    answer.caseSynthesis = {
        candidateCount: 0,
        qualifiedCount: 0,
        returnedCount: 0,
        exclusions: structuredClone(packet.caseSearchAudit.exclusions),
        summary: '',
        sourceIds: [],
        shortfallReason: 'official_results_exhausted',
        upstreamComplete: true,
        evidenceQuotes: [],
        searchScope: {
            normalizedPlanHash: packet.planCoverageAudit.normalizedPlanHash,
            lawNameQueries: packet.caseSearchAudit.lawNameQueries,
            issueQueries: packet.caseSearchAudit.issueQueries,
        },
    };
    answer.applications[0].sourceIds = ['law-1'];
    answer.applications[0].evidenceQuotes = [
        { sourceId: 'law-1', quote: '법정 동의를 받아야 한다.' },
    ];
    answer.sourceIndex = structuredClone(packet.laws);
    const markdown = renderLegalAnswerV1(packet, answer);

    const ordinanceStart = markdown.indexOf('## 5. 관할 조례·규칙');
    const caseStart = markdown.indexOf('## 6. 관련 판례');
    assert.match(markdown.slice(ordinanceStart, caseStart), /해당 없음/);
    assert.match(markdown.slice(caseStart), /공식 후보 검토: 0건; 검증 적격: 0건; 반환: 0건 \(최대 12건\)/);
});

test('검토 후보 12개 링크와 전자투표 0건을 결론 근거·출처 색인과 격리해 렌더링한다', () => {
    const packet = makePacket();
    packet.question = '공동소유자의 대표조합원 지정과 전자투표 유효성은?';
    const reviewPlan: LegalResearchPlanV1 = {
        issues: [
            {
                issueId: 'ISSUE-1',
                issue: '공동소유자의 대표조합원 지정',
                requestedOutcome: 'eligibility',
            },
            {
                issueId: 'ISSUE-2',
                issue: '전자투표 방식의 유효성',
                requestedOutcome: 'procedure',
            },
        ],
        lawAnchors: [
            {
                issueIds: ['ISSUE-1'],
                exactName: '도시 및 주거환경정비법',
                lawType: '법률',
                articleLabels: ['제35조'],
                issueTerms: ['공동소유자'],
            },
            {
                issueIds: ['ISSUE-2'],
                exactName: '도시 및 주거환경정비법',
                lawType: '법률',
                articleLabels: ['제35조'],
                issueTerms: ['전자투표'],
            },
        ],
        ordinanceRequirement: 'not_required',
        ordinanceAnchors: [],
        caseQueries: [
            {
                issueIds: ['ISSUE-1'],
                lawNames: ['도시 및 주거환경정비법'],
                articleLabels: ['제35조'],
                issueTerms: ['공동소유자'],
            },
            {
                issueIds: ['ISSUE-2'],
                lawNames: ['도시 및 주거환경정비법'],
                articleLabels: ['제35조'],
                issueTerms: ['전자투표'],
            },
        ],
    };
    packet.planCoverageAudit = buildLegalPlanCoverageAuditV1(packet.question, reviewPlan);
    const searches = buildCaseSearchQueriesV1(
        packet.planCoverageAudit.normalizedPlan.caseQueries
    );
    packet.caseSearchAudit.lawNameQueries = searches.lawNameQueries;
    packet.caseSearchAudit.issueQueries = searches.issueQueries;
    packet.caseSearchAudit.executedBodyQueries = searches.executedBodyQueries;
    const reviewCandidates: CaseReviewCandidateV1[] = Array.from(
        { length: 12 },
        (_, index) => {
            const serial = String(400 - index);
            return {
                reviewOnly: true,
                official: true,
                verificationStatus: 'verified',
                caseSerialId: serial,
                caseName: `공동소유자 검토판례 ${serial}`,
                caseNumber: `2024누${serial}`,
                court: '서울고법',
                decisionDate: `2024-08-${String(20 - index).padStart(2, '0')}`,
                officialUrl: `https://www.law.go.kr/precInfoP.do?precSeq=${serial}`,
                retrievedAt,
                fullTextHash: 'd'.repeat(64),
                fullTextVerified: true,
                listingIdentityVerified: true,
                currentLawFit: 'changed_rule',
                useInConclusion: 'excluded',
                issueIds: ['ISSUE-1'],
                matches: [{
                    issueId: 'ISSUE-1',
                    lawName: '도시 및 주거환경정비법',
                    issueTerm: '공동소유자',
                    relevanceBasis: 'exact_law_and_strong_term',
                    lawContextExcerpt: '도시 및 주거환경정비법의문언을 검토하였다.',
                    issueContextExcerpt: '공동소유자의 대표조합원 지정 주장을 판단하였다.',
                }],
                excerptLabel: '판결문 발췌',
            };
        }
    );
    packet.caseReviewCandidates = reviewCandidates;
    packet.caseSearchAudit.candidateCount = 14;
    packet.caseSearchAudit.exclusions.currentLawMisaligned = 12;
    packet.caseReviewAudit = {
        requestedMax: 12,
        candidatePoolCount: 14,
        qualifiedCount: 12,
        returnedCount: 12,
        resultSort: 'decision_date_desc_case_serial_id_desc',
        upstreamComplete: true,
        latestScope: 'planned_streams_verified',
        shortfallReason: null,
        paddingApplied: false,
        issues: [
            { issueId: 'ISSUE-1', qualifiedCount: 12, returnedCount: 12 },
            { issueId: 'ISSUE-2', qualifiedCount: 0, returnedCount: 0 },
        ],
    };
    const answer = makeAnswer(packet);
    const markdown = renderLegalAnswerV1(packet, answer);

    assert.match(markdown, /검색상 최신 판례 검토 후보 — 결론·동일 쟁점 근거 아님/);
    assert.equal(markdown.match(/검토 \d+\. \[/g)?.length, 12);
    assert.match(markdown, /쟁점별 ISSUE-2: 반환 후보의 저장된 match 기준 0건 \(계획 stream 소진; 후보당 match 상한으로 미평가 가능\)/);
    assert.match(markdown, /두 문맥이 같은 법률쟁점인지 여부 미검증/);
    const sourceIndex = markdown.slice(markdown.indexOf('## 10. 공식 출처 색인'));
    assert.doesNotMatch(sourceIndex, /precSeq=400/);
    assert.doesNotMatch(answer.caseSynthesis.summary, /공동소유자 검토판례/);
});

test('판시사항 대체값은 생성된 판시사항이 아니라 판결문 발췌로 표시한다', () => {
    const packet = makePacket();
    packet.cases[0].holding = '조합설립 동의 요건을 판단한 판결문 문장';
    packet.cases[0].reasoningSummary = packet.cases[0].holding;
    packet.cases[0].holdingSource = 'official_full_text_excerpt';
    const answer = makeAnswer(packet);
    answer.sourceIndex = structuredClone([
        ...packet.laws,
        ...packet.ordinances,
        ...packet.cases,
    ]);
    answer.caseSynthesis.evidenceQuotes[0].quote = packet.cases[0].holding;
    const applicationCaseQuote = answer.applications[0].evidenceQuotes.find(
        (quote) => quote.sourceId === packet.cases[0].sourceId
    );
    assert.ok(applicationCaseQuote);
    applicationCaseQuote.quote = packet.cases[0].holding;

    const markdown = renderLegalAnswerV1(packet, answer);

    assert.match(markdown, /판결문 발췌: 조합설립 동의 요건을 판단한 판결문 문장/);
    assert.doesNotMatch(markdown, /공식 판시사항: 조합설립 동의 요건을 판단한 판결문 문장/);
});

test('partial 패킷은 판례가 12건이어도 최신 12건 완결성 미증명을 숨기지 않는다', () => {
    const packet = makePacket();
    packet.cases = Array.from({ length: 12 }, (_, index) =>
        makeCase(String(900 - index), `2026-08-${String(20 - index).padStart(2, '0')}`));
    packet.status = 'partial';
    packet.caseSearchAudit.candidateCount = 12;
    packet.caseSearchAudit.qualifiedCount = 12;
    packet.caseSearchAudit.returnedCount = 12;
    packet.caseSearchAudit.upstreamComplete = false;
    packet.caseSearchAudit.shortfallReason = null;
    packet.caseReviewAudit.candidatePoolCount = 12;
    const answer = makeAnswer(packet);
    answer.status = 'partial';
    answer.conclusion.kind = 'conditional';
    answer.caseSynthesis = {
        candidateCount: 12,
        qualifiedCount: 12,
        returnedCount: 12,
        exclusions: structuredClone(packet.caseSearchAudit.exclusions),
        summary: '확보된 적격 판례를 최신순으로 정리했다.',
        sourceIds: packet.cases.map((legalCase) => legalCase.sourceId),
        shortfallReason: null,
        upstreamComplete: false,
        evidenceQuotes: packet.cases.map((legalCase) => ({
            sourceId: legalCase.sourceId,
            quote: '조합설립 동의 요건을 판시하였다.',
        })),
        searchScope: {
            normalizedPlanHash: packet.planCoverageAudit.normalizedPlanHash,
            lawNameQueries: packet.caseSearchAudit.lawNameQueries,
            issueQueries: packet.caseSearchAudit.issueQueries,
        },
    };
    answer.applications[0].sourceIds = ['law-1', 'ordinance-1', packet.cases[0].sourceId];
    answer.applications[0].evidenceQuotes = [
        { sourceId: 'law-1', quote: '법정 동의를 받아야 한다.' },
        { sourceId: 'ordinance-1', quote: '관할 세부 절차를 정한다.' },
        { sourceId: packet.cases[0].sourceId, quote: '조합설립 동의 요건을 판시하였다.' },
    ];
    answer.sourceIndex = structuredClone([
        ...packet.laws,
        ...packet.ordinances,
        ...packet.cases,
    ]);

    const markdown = renderLegalAnswerV1(packet, answer);
    assert.match(markdown, /조사 상태: partial \(공식 상류 조회 미완료\)/);
    assert.match(markdown, /최신순 완결성: 미완료/);
    assert.match(markdown, /해당 stream의 최신 12건을 증명하지 못함/);
});

test('검증되지 않은 sourceId 또는 변경된 면책문구는 렌더링 전에 차단한다', () => {
    const packet = makePacket();
    const answer = makeAnswer(packet);
    answer.applications[0].sourceIds = ['unknown-source'];
    answer.disclaimer = '참고용입니다.';

    assert.throws(
        () => renderLegalAnswerV1(packet, answer),
        LegalContractValidationError
    );
});

test('structuredContent용 wrapper는 검증 통과 표식과 같은 Markdown을 반환한다', () => {
    const packet = makePacket();
    const answer = makeAnswer(packet);
    const rendered = buildRenderedLegalAnswerV1(packet, answer);

    assert.equal(rendered.contractValidationPassed, true);
    assert.equal(rendered.markdown, renderLegalAnswerV1(packet, answer));
    assert.equal(rendered.answer.packetId, packet.packetId);
});
