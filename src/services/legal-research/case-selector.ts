import {
    LEGAL_POLICY_VERSION,
    MAX_RELEVANT_CASES,
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
    relevancePolicyVersion?: string;
}

export interface CaseSelectionResultV1 {
    cases: CaseSourceV1[];
    audit: CaseSearchAuditV1;
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
        || !isNonEmptyString(candidate.holding)
        || !isNonEmptyString(candidate.reasoningSummary)
    ) {
        return 'fullTextUnavailable';
    }
    if (
        candidate.listingIdentityVerified !== true
        || !isNonEmptyString(candidate.caseSerialId)
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
    for (const candidate of eligible) {
        if (seenSerialIds.has(candidate.caseSerialId)) {
            exclusions.duplicate += 1;
            continue;
        }
        seenSerialIds.add(candidate.caseSerialId);
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
            relevancePolicyVersion: options.relevancePolicyVersion ?? LEGAL_POLICY_VERSION,
            queryRelaxedToFill: false,
            upstreamComplete: options.upstreamComplete,
            shortfallReason,
            exclusions,
        },
    };
}
