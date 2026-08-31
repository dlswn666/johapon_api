import assert from 'node:assert/strict';
import test from 'node:test';
import {
    LEGAL_ANSWER_VERSION,
    LEGAL_DISCLAIMER,
    LEGAL_POLICY_VERSION,
    LEGAL_RESEARCH_PACKET_VERSION,
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
            returnedCount: packet.cases.length,
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

test('blocking unknown 또는 과거 법령 필요 상태에서는 supported 결론을 금지한다', () => {
    const packet = makePacket();
    packet.status = 'insufficient_evidence';
    packet.unknowns = [{
        code: 'HISTORICAL_LAW_REQUIRED',
        text: '사건 당시 법령이 필요하다.',
        impact: '결론을 확정할 수 없다.',
        blocking: true,
    }];
    const answer = makeAnswer(packet);
    answer.status = packet.status;
    answer.unknowns = structuredClone(packet.unknowns);
    answer.temporalReview.historicalLawRequired = true;
    const result = validateLegalAnswerV1(answer, packet);
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('UNSUPPORTED_CONCLUSION'));
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
    };
    let answerResult: ReturnType<typeof validateLegalAnswerV1> | undefined;
    assert.doesNotThrow(() => {
        answerResult = validateLegalAnswerV1(malformedAnswer);
    });
    assert.equal(answerResult?.ok, false);
    assert.ok((answerResult?.errors.length ?? 0) > 0);
});
