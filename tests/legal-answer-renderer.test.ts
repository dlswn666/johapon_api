import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildRenderedLegalAnswerV1,
    renderLegalAnswerV1,
} from '../src/services/legal-research/answer-renderer';
import {
    LEGAL_ANSWER_SECTION_HEADINGS,
    LEGAL_ANSWER_VERSION,
    LEGAL_DISCLAIMER,
    LEGAL_POLICY_VERSION,
    LEGAL_RESEARCH_PACKET_VERSION,
    type CaseSourceV1,
    type LegalAnswerV1,
    type LegalResearchPacketV1,
} from '../src/services/legal-research/model';
import {
    LegalContractValidationError,
    validateLegalAnswerMarkdownV1,
} from '../src/services/legal-research/validator';
import {
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
            requestedMax: 10,
            candidateCount: 2,
            qualifiedCount: 2,
            returnedCount: 2,
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
            returnedCount: 2,
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
        // 렌더러가 sourceIndex 입력 순서에 의존하지 않는지 확인하기 위해 섞는다.
        sourceIndex: structuredClone([
            packet.cases[1],
            packet.ordinances[0],
            packet.laws[0],
            packet.cases[0],
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
    assert.match(markdown, /반환 판례: 2건 \(최대 10건\)/);
    assert.match(markdown, /조사 상태: complete \(조사 계약 완료\)/);
    assert.match(markdown, /계획된 법령명·쟁점 검색 stream 내 최신순 완결성: 검증됨/);
    assert.match(markdown, /검색계획 hash:/);
    assert.match(markdown, /10건 미만 사유: 관련성 기준을 충족한 공식 검색 결과가 더 없음/);
});

test('판례 섹션은 패킷의 최신순과 caseSerialId DESC 동률 순서를 보존한다', () => {
    const packet = makePacket();
    const markdown = renderLegalAnswerV1(packet, makeAnswer(packet));
    const caseSectionStart = markdown.indexOf('## 6. 관련 판례');
    const applicationSectionStart = markdown.indexOf('## 7. 사실에 대한 적용과 판단');
    const caseSection = markdown.slice(caseSectionStart, applicationSectionStart);

    assert.ok(caseSection.indexOf('조합설립인가처분취소 200') < caseSection.indexOf('조합설립인가처분취소 100'));
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

    const answer = makeAnswer(packet);
    answer.ordinanceAnalysis = [];
    answer.caseSynthesis = {
        returnedCount: 0,
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
    assert.match(markdown.slice(caseStart), /반환 판례: 0건 \(최대 10건\)/);
});

test('partial 패킷은 판례가 10건이어도 최신 10건 완결성 미증명을 숨기지 않는다', () => {
    const packet = makePacket();
    packet.cases = Array.from({ length: 10 }, (_, index) =>
        makeCase(String(900 - index), `2026-08-${String(20 - index).padStart(2, '0')}`));
    packet.status = 'partial';
    packet.caseSearchAudit.candidateCount = 10;
    packet.caseSearchAudit.qualifiedCount = 10;
    packet.caseSearchAudit.returnedCount = 10;
    packet.caseSearchAudit.upstreamComplete = false;
    packet.caseSearchAudit.shortfallReason = null;
    const answer = makeAnswer(packet);
    answer.status = 'partial';
    answer.conclusion.kind = 'conditional';
    answer.caseSynthesis = {
        returnedCount: 10,
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
    assert.match(markdown, /해당 stream의 최신 10건을 증명하지 못함/);
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
