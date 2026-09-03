import {
    LEGAL_POLICY_VERSION,
    MAX_CASE_REVIEW_CANDIDATES,
    MAX_CASE_REVIEW_EXCERPT_CHARS,
    MAX_CASE_REVIEW_MATCHES_PER_CANDIDATE,
    MAX_RELEVANT_CASES,
    type CaseReviewAuditV1,
    type CaseReviewCandidateV1,
    type CaseExclusionCountsV1,
    type CaseSearchAuditV1,
    type CaseShortfallReasonV1,
    type CaseSourceV1,
} from './model';
import { isPublicOfficialLawUrlV1 } from './validator';

export interface CaseSelectionOptionsV1 {
    upstreamComplete: boolean;
    lawNameQueries?: string[];
    issueQueries?: string[];
    executedBodyQueries?: string[];
    relevancePolicyVersion?: string;
}

export interface CaseSelectionResultV1 {
    cases: CaseSourceV1[];
    audit: CaseSearchAuditV1;
}

export interface CaseReviewSelectionOptionsV1 {
    upstreamComplete: boolean;
    candidatePoolCount: number;
    issueIds: string[];
    strictCases?: readonly CaseSourceV1[];
}

export interface CaseReviewSelectionResultV1 {
    candidates: CaseReviewCandidateV1[];
    audit: CaseReviewAuditV1;
}

const CASE_REVIEW_STRONG_TERMS = new Set([
    '대표조합원',
    '공동소유자',
    '공동소유',
    '전자투표',
    '전자적방법',
    '전자의결',
    '의사정족수',
    '의결정족수',
    '총회결의무효',
]);

const CASE_REVIEW_ISSUE_FAMILY_TERMS = new Set([
    '공동소유',
    '공동소유자',
    '공유자',
    '공유',
    '수인',
    '여러명',
    '토지등소유자',
    '대표조합원',
    '대표하는1인',
    '대표하는1명',
    '의결권',
    '의사정족수',
    '의결정족수',
    '정족수',
    '직접출석',
    '서면결의',
    '전자투표',
    '전자적방법',
    '전자의결',
    '투표',
    '표결',
    '총회결의무효',
    '결의무효',
]);

const CASE_REVIEW_JOINT_OWNER_SIGNALS = [
    '공동소유', '공동소유자', '공유자', '대표조합원',
] as const;
const CASE_REVIEW_OWNERSHIP_TERMS = [
    '공동소유', '공동소유자', '공유자', '공유', '수인', '여러명', '토지등소유자',
] as const;
const CASE_REVIEW_REPRESENTATIVE_TERMS = [
    '대표조합원', '대표하는1인', '대표하는1명',
] as const;

export function normalizeCaseReviewTermV1(value: string): string {
    return value
        .normalize('NFKC')
        .replace(/\s+/g, '')
        .toLocaleLowerCase('ko-KR');
}

export function isCaseReviewStrongTermV1(value: string): boolean {
    return CASE_REVIEW_STRONG_TERMS.has(normalizeCaseReviewTermV1(value));
}

export function isCaseReviewIssueFamilyTermV1(value: string): boolean {
    return CASE_REVIEW_ISSUE_FAMILY_TERMS.has(normalizeCaseReviewTermV1(value));
}

export function requiresJointOwnerReviewSignalsV1(
    issueText: string,
    issueTerms: readonly string[]
): boolean {
    const values = [issueText, ...issueTerms].map(normalizeCaseReviewTermV1);
    return CASE_REVIEW_JOINT_OWNER_SIGNALS.some((signal) =>
        values.some((value) => value.includes(normalizeCaseReviewTermV1(signal))));
}

export function hasJointOwnerRepresentativeSignalsV1(excerpt: string): boolean {
    const normalized = normalizeCaseReviewTermV1(excerpt);
    return CASE_REVIEW_OWNERSHIP_TERMS.some((term) =>
        normalized.includes(normalizeCaseReviewTermV1(term)))
        && CASE_REVIEW_REPRESENTATIVE_TERMS.some((term) =>
            normalized.includes(normalizeCaseReviewTermV1(term)));
}

function canonicalReviewArticleV1(value: string): string | null {
    const normalized = normalizeCaseReviewTermV1(value);
    const matched = /^(?:제)?0*(\d+)(?:조)?(?:의0*(\d+))?$/.exec(normalized);
    if (!matched) return null;
    const number = String(Number(matched[1]));
    const branch = matched[2] === undefined ? null : String(Number(matched[2]));
    return branch && branch !== '0' ? `제${number}조의${branch}` : `제${number}조`;
}

/**
 * 본법명과 대상 조문이 하나의 직접 인용으로 결합됐는지 확인한다.
 * 중간에는 닫힘기호와 폐쇄형 조사만 허용해 다른 법령의 같은 조문을 빌리지 못하게 한다.
 */
export function containsBoundExactLawArticleCitationV1(
    excerpt: string,
    lawName: string,
    articleLabel: string
): boolean {
    const text = excerpt.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ko-KR');
    const expectedLaw = normalizeCaseReviewTermV1(lawName);
    const expectedArticle = canonicalReviewArticleV1(articleLabel);
    if (!expectedLaw || expectedArticle === null) return false;
    const article = normalizeCaseReviewTermV1(expectedArticle);
    let offset = 0;
    while (offset <= text.length - expectedLaw.length) {
        const index = text.indexOf(expectedLaw, offset);
        if (index < 0) return false;
        offset = index + expectedLaw.length;
        const previous = text[index - 1];
        if (previous !== undefined && /[0-9a-z가-힣]/iu.test(previous)) continue;
        let suffix = text.slice(index + expectedLaw.length)
            .replace(/^[」』)\]]+/u, '');
        if (/^(?:시행령|시행규칙|규칙)/u.test(suffix)) continue;
        const particle = /^(?:으로부터|에서|으로|에게|의|에|은|는|이|가|을|를|과|와|로|상)/u
            .exec(suffix);
        if (particle) suffix = suffix.slice(particle[0].length);
        if (!suffix.startsWith(article)) continue;
        let tail = suffix.slice(article.length);
        if (/^의\d/u.test(tail) || /^\d/u.test(tail)) continue;
        // 대상 조문 뒤의 항·호·목 표시는 같은 조문 인용의 세부 단위다.
        // 반면 `제39조의2`는 별도 가지 조문이므로 위에서 계속 거부한다.
        const subordinateUnits = /^(?:제0*\d+(?:항|호|목)(?:의0*\d+)?)+/u.exec(tail);
        if (subordinateUnits) tail = tail.slice(subordinateUnits[0].length);
        const next = tail[0];
        if (
            next === undefined
            || !/[0-9a-z가-힣]/iu.test(next)
            || /^(?:으로부터|에서|으로|에게|의|에|은|는|이|가|을|를|과|와|로|상)/u
                .test(tail)
        ) return true;
    }
    return false;
}

type ExclusionReason = keyof CaseExclusionCountsV1;

function isIsoDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function compareTextAscending(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

export function canonicalCaseSerialIdV1(value: string): string | null {
    const normalized = value.normalize('NFKC').trim();
    if (!/^\d+$/.test(normalized)) return null;
    return normalized.replace(/^0+(?=\d)/, '');
}

function canonicalCaseNumber(value: string): string {
    return value
        .normalize('NFKC')
        .split(',')[0]
        .replace(/\s+/g, '')
        .toLocaleLowerCase('ko-KR');
}

function canonicalCourtName(value: string): string {
    return value
        .normalize('NFKC')
        .replace(/\s+/g, '')
        .replace(/지방법원$/, '지법')
        .replace(/고등법원$/, '고법')
        .toLocaleLowerCase('ko-KR');
}

function canonicalDecisionIdentity(candidate: Pick<
    CaseSourceV1,
    'caseNumber' | 'court' | 'decisionDate'
>): string {
    return [
        canonicalCaseNumber(candidate.caseNumber),
        canonicalCourtName(candidate.court),
        candidate.decisionDate,
    ].join('|');
}

function isStructurallyEligibleReviewCandidate(candidate: CaseReviewCandidateV1): boolean {
    if (
        candidate.reviewOnly !== true
        || candidate.official !== true
        || candidate.verificationStatus !== 'verified'
        || candidate.fullTextVerified !== true
        || candidate.listingIdentityVerified !== true
        || candidate.useInConclusion !== 'excluded'
        || (candidate.currentLawFit !== 'changed_rule' && candidate.currentLawFit !== 'unknown')
        || !isPublicOfficialLawUrlV1(candidate.officialUrl, 'case')
        || canonicalCaseSerialIdV1(candidate.caseSerialId) === null
        || !isNonEmptyString(candidate.caseName)
        || !isNonEmptyString(candidate.caseNumber)
        || !isNonEmptyString(candidate.court)
        || !isIsoDate(candidate.decisionDate)
        || !isNonEmptyString(candidate.retrievedAt)
        || !/^[0-9a-f]{64}$/i.test(candidate.fullTextHash)
        || candidate.excerptLabel !== '판결문 발췌'
        || !Array.isArray(candidate.issueIds)
        || candidate.issueIds.length === 0
        || candidate.issueIds.length > MAX_CASE_REVIEW_MATCHES_PER_CANDIDATE
        || !candidate.issueIds.every(isNonEmptyString)
        || new Set(candidate.issueIds).size !== candidate.issueIds.length
        || !Array.isArray(candidate.matches)
        || candidate.matches.length === 0
        || candidate.matches.length > MAX_CASE_REVIEW_MATCHES_PER_CANDIDATE
    ) return false;

    const matchIssueIds = candidate.matches.map((match) => match.issueId);
    if (
        new Set(matchIssueIds).size !== matchIssueIds.length
        || candidate.issueIds.length !== matchIssueIds.length
        || candidate.issueIds.some((issueId) => !matchIssueIds.includes(issueId))
    ) return false;

    return candidate.matches.every((match) => {
        if (
            !isNonEmptyString(match.issueId)
            || !isNonEmptyString(match.lawName)
            || !isNonEmptyString(match.issueTerm)
            || !isNonEmptyString(match.lawContextExcerpt)
            || Array.from(match.lawContextExcerpt).length > MAX_CASE_REVIEW_EXCERPT_CHARS
            || !normalizeCaseReviewTermV1(match.lawContextExcerpt)
                .includes(normalizeCaseReviewTermV1(match.lawName))
        ) return false;
        if (match.relevanceBasis === 'exact_law_and_strong_term') {
            return match.articleLabel === undefined
                && isNonEmptyString(match.issueContextExcerpt)
                && Array.from(match.issueContextExcerpt).length
                    <= MAX_CASE_REVIEW_EXCERPT_CHARS
                && normalizeCaseReviewTermV1(match.issueContextExcerpt)
                    .includes(normalizeCaseReviewTermV1(match.issueTerm))
                && isCaseReviewStrongTermV1(match.issueTerm);
        }
        if (match.relevanceBasis === 'exact_law_target_article_and_issue_family') {
            return isNonEmptyString(match.articleLabel)
                && match.issueContextExcerpt === undefined
                && containsBoundExactLawArticleCitationV1(
                    match.lawContextExcerpt,
                    match.lawName,
                    match.articleLabel
                )
                && normalizeCaseReviewTermV1(match.lawContextExcerpt)
                    .includes(normalizeCaseReviewTermV1(match.issueTerm))
                && isCaseReviewIssueFamilyTermV1(match.issueTerm);
        }
        return false;
    });
}

function compareReviewCandidatesLatestFirst(
    left: CaseReviewCandidateV1,
    right: CaseReviewCandidateV1
): number {
    if (left.decisionDate !== right.decisionDate) {
        return left.decisionDate > right.decisionDate ? -1 : 1;
    }
    const serialComparison = compareCaseSerialIdDescendingV1(
        left.caseSerialId,
        right.caseSerialId
    );
    if (serialComparison !== 0) return serialComparison;
    return compareTextAscending(left.officialUrl, right.officialUrl);
}

/** 숫자형 판례일련번호의 자릿수 의미를 보존하면서 내림차순 비교한다. */
export function compareCaseSerialIdDescendingV1(left: string, right: string): number {
    if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
        const normalizedLeft = left.replace(/^0+(?=\d)/, '');
        const normalizedRight = right.replace(/^0+(?=\d)/, '');
        if (normalizedLeft.length !== normalizedRight.length) {
            return normalizedLeft.length > normalizedRight.length ? -1 : 1;
        }
        if (normalizedLeft !== normalizedRight) {
            return normalizedLeft > normalizedRight ? -1 : 1;
        }
        return compareTextAscending(right, left);
    }
    return compareTextAscending(right, left);
}

export function compareCasesLatestFirstV1(left: CaseSourceV1, right: CaseSourceV1): number {
    if (left.decisionDate !== right.decisionDate) {
        return left.decisionDate > right.decisionDate ? -1 : 1;
    }
    const serialComparison = compareCaseSerialIdDescendingV1(
        left.caseSerialId,
        right.caseSerialId
    );
    if (serialComparison !== 0) return serialComparison;
    return compareTextAscending(left.sourceId, right.sourceId);
}

function classifyExclusion(candidate: CaseSourceV1): ExclusionReason | null {
    if (
        candidate.official !== true
        || !isPublicOfficialLawUrlV1(candidate.officialUrl, 'case')
    ) {
        return 'unofficialUrl';
    }
    if (
        candidate.verificationStatus !== 'verified'
        || candidate.fullTextVerified !== true
    ) {
        return 'fullTextUnavailable';
    }
    if (
        candidate.listingIdentityVerified !== true
        || !isNonEmptyString(candidate.caseSerialId)
        || canonicalCaseSerialIdV1(candidate.caseSerialId) === null
        || !isNonEmptyString(candidate.caseNumber)
        || !isNonEmptyString(candidate.court)
        || !isIsoDate(candidate.decisionDate)
    ) {
        return 'identityMismatch';
    }
    if (
        (candidate.relevance.grade !== 'direct' && candidate.relevance.grade !== 'analogical')
        || candidate.relevance.matchedIssues.length === 0
        || candidate.relevance.matchedProvisions.length === 0
        || !candidate.relevance.matchedIssues.every(isNonEmptyString)
        || !candidate.relevance.matchedProvisions.every(isNonEmptyString)
        || !isNonEmptyString(candidate.relevance.reason)
        || !isNonEmptyString(candidate.holding)
        || !isNonEmptyString(candidate.reasoningSummary)
    ) {
        return 'irrelevant';
    }
    const verifiedSameRule = candidate.currentLawFit === 'verified_same_rule';
    const currentRuleCandidate = candidate.currentLawFit === 'current_rule_candidate';
    if (
        (!verifiedSameRule && !currentRuleCandidate)
        || (
            currentRuleCandidate
            && (
                candidate.relevance.grade !== 'analogical'
                || candidate.useInConclusion !== 'analogical_support'
            )
        )
    ) {
        return 'currentLawMisaligned';
    }
    if (
        candidate.useInConclusion !== 'direct_support'
        && candidate.useInConclusion !== 'analogical_support'
    ) {
        return 'irrelevant';
    }
    return null;
}

function emptyExclusions(): CaseExclusionCountsV1 {
    return {
        duplicate: 0,
        fullTextUnavailable: 0,
        identityMismatch: 0,
        irrelevant: 0,
        currentLawMisaligned: 0,
        unofficialUrl: 0,
    };
}

function chooseShortfallReason(
    returnedCount: number,
    upstreamComplete: boolean,
    exclusions: CaseExclusionCountsV1
): CaseShortfallReasonV1 | null {
    if (returnedCount === MAX_RELEVANT_CASES) return null;
    if (!upstreamComplete) return 'upstream_incomplete';
    if (exclusions.fullTextUnavailable > 0) return 'full_text_unavailable';
    if (exclusions.currentLawMisaligned > 0) return 'current_law_misaligned';
    return 'official_results_exhausted';
}

/**
 * 전문·식별자·관련성·현행 규정 동일성 gate를 모두 통과한 판례만 선택한다.
 * 적격 판례가 부족해도 검색 조건을 완화하거나 중복으로 채우지 않는다.
 */
export function selectRelevantCasesV1(
    candidates: readonly CaseSourceV1[],
    options: CaseSelectionOptionsV1
): CaseSelectionResultV1 {
    const exclusions = emptyExclusions();
    const eligible: CaseSourceV1[] = [];

    for (const candidate of candidates) {
        const exclusion = classifyExclusion(candidate);
        if (exclusion) {
            exclusions[exclusion] += 1;
        } else {
            eligible.push(candidate);
        }
    }

    eligible.sort(compareCasesLatestFirstV1);
    const uniqueEligible: CaseSourceV1[] = [];
    const seenSerialIds = new Set<string>();
    const seenDecisionIdentities = new Set<string>();
    for (const candidate of eligible) {
        const canonicalSerialId = canonicalCaseSerialIdV1(candidate.caseSerialId)!;
        const decisionIdentity = canonicalDecisionIdentity(candidate);
        if (
            seenSerialIds.has(canonicalSerialId)
            || seenDecisionIdentities.has(decisionIdentity)
        ) {
            exclusions.duplicate += 1;
            continue;
        }
        seenSerialIds.add(canonicalSerialId);
        seenDecisionIdentities.add(decisionIdentity);
        uniqueEligible.push(candidate);
    }

    const selected = uniqueEligible.slice(0, MAX_RELEVANT_CASES);
    const shortfallReason = chooseShortfallReason(
        selected.length,
        options.upstreamComplete,
        exclusions
    );

    return {
        cases: selected,
        audit: {
            requestedMax: MAX_RELEVANT_CASES,
            candidateCount: candidates.length,
            qualifiedCount: uniqueEligible.length,
            returnedCount: selected.length,
            target: 'prec',
            listSort: 'ddes',
            resultSort: 'decision_date_desc_case_serial_id_desc',
            lawNameQueries: [...(options.lawNameQueries ?? [])],
            issueQueries: [...(options.issueQueries ?? [])],
            ...(options.executedBodyQueries
                ? { executedBodyQueries: [...options.executedBodyQueries] }
                : {}),
            relevancePolicyVersion: options.relevancePolicyVersion ?? LEGAL_POLICY_VERSION,
            queryRelaxedToFill: false,
            upstreamComplete: options.upstreamComplete,
            shortfallReason,
            exclusions,
        },
    };
}

/**
 * 결론 적격 판례와 분리한 검토용 목록을 선정한다.
 * 검토용 후보는 sourceId가 없고 useInConclusion=excluded로 고정되며,
 * 부족분을 채우기 위한 기준 완화나 중복 허용을 하지 않는다.
 */
export function selectCaseReviewCandidatesV1(
    candidates: readonly CaseReviewCandidateV1[],
    options: CaseReviewSelectionOptionsV1
): CaseReviewSelectionResultV1 {
    const strictSerialIds = new Set(
        (options.strictCases ?? [])
            .map((candidate) => canonicalCaseSerialIdV1(candidate.caseSerialId))
            .filter((value): value is string => value !== null)
    );
    const strictDecisionIdentities = new Set(
        (options.strictCases ?? []).map(canonicalDecisionIdentity)
    );
    const eligible = candidates
        .filter(isStructurallyEligibleReviewCandidate)
        .filter((candidate) => {
            const serialId = canonicalCaseSerialIdV1(candidate.caseSerialId)!;
            return !strictSerialIds.has(serialId)
                && !strictDecisionIdentities.has(canonicalDecisionIdentity(candidate));
        })
        .sort(compareReviewCandidatesLatestFirst);

    const uniqueEligible: CaseReviewCandidateV1[] = [];
    const seenSerialIds = new Set<string>();
    const seenDecisionIdentities = new Set<string>();
    for (const candidate of eligible) {
        const serialId = canonicalCaseSerialIdV1(candidate.caseSerialId)!;
        const decisionIdentity = canonicalDecisionIdentity(candidate);
        if (
            seenSerialIds.has(serialId)
            || seenDecisionIdentities.has(decisionIdentity)
        ) continue;
        seenSerialIds.add(serialId);
        seenDecisionIdentities.add(decisionIdentity);
        uniqueEligible.push(candidate);
    }

    const selected = uniqueEligible.slice(0, MAX_CASE_REVIEW_CANDIDATES);
    const issueIds = [...new Set(options.issueIds)];
    return {
        candidates: selected,
        audit: {
            requestedMax: MAX_CASE_REVIEW_CANDIDATES,
            candidatePoolCount: options.candidatePoolCount,
            qualifiedCount: uniqueEligible.length,
            returnedCount: selected.length,
            resultSort: 'decision_date_desc_case_serial_id_desc',
            upstreamComplete: options.upstreamComplete,
            latestScope: options.upstreamComplete
                ? 'planned_streams_verified'
                : 'reviewed_candidate_pool',
            shortfallReason: selected.length === MAX_CASE_REVIEW_CANDIDATES
                ? null
                : options.upstreamComplete
                    ? 'official_results_exhausted'
                    : 'upstream_incomplete',
            paddingApplied: false,
            issues: issueIds.map((issueId) => ({
                issueId,
                qualifiedCount: uniqueEligible.filter((candidate) =>
                    candidate.issueIds.includes(issueId)).length,
                returnedCount: selected.filter((candidate) =>
                    candidate.issueIds.includes(issueId)).length,
            })),
        },
    };
}
