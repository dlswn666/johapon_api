import assert from 'node:assert/strict';
import test from 'node:test';
import {
    compareCaseSerialIdDescendingV1,
    selectRelevantCasesV1,
} from '../src/services/legal-research/case-selector';
import type { CaseSourceV1 } from '../src/services/legal-research/model';

function makeCase(caseSerialId: string, decisionDate: string): CaseSourceV1 {
    return {
        sourceId: `case-${caseSerialId}`,
        sourceType: 'case',
        official: true,
        title: `판례 ${caseSerialId}`,
        officialUrl: `https://www.law.go.kr/precInfoP.do?precSeq=${caseSerialId}`,
        retrievedAt: '2026-08-31T09:00:00+09:00',
        verificationStatus: 'verified',
        exactTextHash: 'a'.repeat(64),
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

test('적격 후보 15건은 선고일 최신순 최대 12건만 안정적으로 선택한다', () => {
    const candidates = Array.from({ length: 15 }, (_, index) => {
        const day = String(index + 1).padStart(2, '0');
        return makeCase(String(index + 1), `2026-08-${day}`);
    }).reverse();
    const before = candidates.map((candidate) => candidate.sourceId);

    const result = selectRelevantCasesV1(candidates, {
        upstreamComplete: true,
        lawNameQueries: ['도시 및 주거환경정비법'],
        issueQueries: ['조합설립 동의'],
    });

    assert.deepEqual(
        result.cases.map((candidate) => candidate.decisionDate),
        [
            '2026-08-15',
            '2026-08-14',
            '2026-08-13',
            '2026-08-12',
            '2026-08-11',
            '2026-08-10',
            '2026-08-09',
            '2026-08-08',
            '2026-08-07',
            '2026-08-06',
            '2026-08-05',
            '2026-08-04',
        ]
    );
    assert.equal(result.audit.requestedMax, 12);
    assert.equal(result.audit.candidateCount, 15);
    assert.equal(result.audit.qualifiedCount, 15);
    assert.equal(result.audit.returnedCount, 12);
    assert.equal(result.audit.shortfallReason, null);
    assert.equal(result.audit.queryRelaxedToFill, false);
    assert.deepEqual(candidates.map((candidate) => candidate.sourceId), before);
});

test('동일 선고일은 숫자형 판례일련번호 DESC로 정렬한다', () => {
    const result = selectRelevantCasesV1(
        [
            makeCase('9', '2026-05-01'),
            makeCase('100', '2026-05-01'),
            makeCase('10', '2026-05-01'),
        ],
        { upstreamComplete: true }
    );

    assert.deepEqual(result.cases.map((candidate) => candidate.caseSerialId), ['100', '10', '9']);
    assert.equal(compareCaseSerialIdDescendingV1('100', '99'), -1);
    assert.equal(compareCaseSerialIdDescendingV1('9', '10'), 1);
});

test('적격 판례가 7건이면 실제 7건과 부족 사유를 반환하고 padding하지 않는다', () => {
    const candidates = Array.from({ length: 7 }, (_, index) =>
        makeCase(String(index + 1), `2026-07-0${index + 1}`));
    const result = selectRelevantCasesV1(candidates, { upstreamComplete: true });

    assert.equal(result.cases.length, 7);
    assert.equal(new Set(result.cases.map((candidate) => candidate.caseSerialId)).size, 7);
    assert.equal(result.audit.qualifiedCount, 7);
    assert.equal(result.audit.returnedCount, 7);
    assert.equal(result.audit.shortfallReason, 'official_results_exhausted');
});

test('무관·전문 미확인·구법·비공식·중복 후보를 12건 채우기에 사용하지 않는다', () => {
    const valid = makeCase('500', '2026-05-01');
    const duplicate = { ...makeCase('500', '2026-05-01'), sourceId: 'case-500-duplicate' };
    const noFullText = { ...makeCase('400', '2026-04-01'), fullTextVerified: false };
    const unrelated = {
        ...makeCase('300', '2026-03-01'),
        relevance: {
            grade: 'unrelated' as const,
            matchedIssues: [],
            matchedProvisions: [],
            reason: '질문과 무관하다.',
        },
        useInConclusion: 'excluded' as const,
    };
    const oldRule = {
        ...makeCase('200', '2026-02-01'),
        currentLawFit: 'changed_rule' as const,
        useInConclusion: 'background_only' as const,
    };
    const nonCanonical = {
        ...makeCase('100', '2026-01-01'),
        officialUrl: 'https://www.law.go.kr/판례/(100)',
    };

    const result = selectRelevantCasesV1(
        [noFullText, unrelated, duplicate, oldRule, nonCanonical, valid],
        { upstreamComplete: true }
    );

    assert.deepEqual(result.cases.map((candidate) => candidate.caseSerialId), ['500']);
    assert.equal(result.audit.candidateCount, 6);
    assert.equal(result.audit.qualifiedCount, 1);
    assert.equal(result.audit.returnedCount, 1);
    assert.deepEqual(result.audit.exclusions, {
        duplicate: 1,
        fullTextUnavailable: 1,
        identityMismatch: 0,
        irrelevant: 1,
        currentLawMisaligned: 1,
        unofficialUrl: 1,
    });
    assert.equal(result.audit.shortfallReason, 'full_text_unavailable');
});

test('현행 규정 불일치는 관련성 gate 이후 별도 사유로 기록한다', () => {
    const changedRule = {
        ...makeCase('100', '2026-01-01'),
        currentLawFit: 'changed_rule' as const,
    };
    const result = selectRelevantCasesV1([changedRule], { upstreamComplete: true });

    assert.equal(result.cases.length, 0);
    assert.equal(result.audit.exclusions.currentLawMisaligned, 1);
    assert.equal(result.audit.shortfallReason, 'current_law_misaligned');
});

test('exact 참조와 시행일 이후 선고 proxy는 analogical current_rule_candidate로만 허용한다', () => {
    const candidate = {
        ...makeCase('101', '2026-01-02'),
        relevance: {
            ...makeCase('101', '2026-01-02').relevance,
            grade: 'analogical' as const,
            reason: '버전 ID가 없어 보수적 유추 후보로만 분류한다.',
        },
        currentLawFit: 'current_rule_candidate' as const,
        useInConclusion: 'analogical_support' as const,
    };
    const overstated = {
        ...candidate,
        sourceId: 'case-102',
        caseSerialId: '102',
        officialUrl: 'https://www.law.go.kr/precInfoP.do?precSeq=102',
        relevance: { ...candidate.relevance, grade: 'direct' as const },
        useInConclusion: 'direct_support' as const,
    };
    const result = selectRelevantCasesV1([candidate, overstated], { upstreamComplete: true });

    assert.deepEqual(result.cases.map((legalCase) => legalCase.caseSerialId), ['101']);
    assert.equal(result.audit.exclusions.currentLawMisaligned, 1);
});

test('현행 규정 근거가 unknown이면 보수적으로 제외한다', () => {
    const unknownRule = {
        ...makeCase('103', '2026-01-03'),
        currentLawFit: 'unknown' as const,
        useInConclusion: 'excluded' as const,
    };
    const result = selectRelevantCasesV1([unknownRule], { upstreamComplete: true });

    assert.equal(result.cases.length, 0);
    assert.equal(result.audit.exclusions.currentLawMisaligned, 1);
    assert.equal(result.audit.shortfallReason, 'current_law_misaligned');
});

test('law.go.kr 호스트여도 판례 canonical 상세 링크가 아니면 제외한다', () => {
    const wrongSourceType = {
        ...makeCase('104', '2026-01-04'),
        officialUrl: 'https://www.law.go.kr/lsInfoP.do?lsiSeq=104',
    };
    const result = selectRelevantCasesV1([wrongSourceType], { upstreamComplete: true });

    assert.equal(result.cases.length, 0);
    assert.equal(result.audit.exclusions.unofficialUrl, 1);
});

test('공식 결과 소진과 상류 미완료를 서로 다른 정상 불완전 상태로 표현한다', () => {
    const complete = selectRelevantCasesV1([], { upstreamComplete: true });
    const incomplete = selectRelevantCasesV1([], { upstreamComplete: false });

    assert.equal(complete.audit.shortfallReason, 'official_results_exhausted');
    assert.equal(incomplete.audit.shortfallReason, 'upstream_incomplete');
    assert.equal(complete.cases.length, 0);
    assert.equal(incomplete.cases.length, 0);
});
