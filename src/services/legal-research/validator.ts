import {
    LEGAL_ANSWER_SECTION_HEADINGS,
    LEGAL_ANSWER_VERSION,
    LEGAL_BLOCKING_UNKNOWN_CONCLUSION_TEXT,
    LEGAL_DISCLAIMER,
    LEGAL_RESEARCH_PACKET_VERSION,
    MAX_RELEVANT_CASES,
    type CaseSourceV1,
    type LawSourceV1,
    type LegalAnswerV1,
    type LegalResearchPacketV1,
    type LegalSourceV1,
    type OrdinanceSourceV1,
} from './model';
import {
    hashLegalResearchPlanV1,
    LegalResearchPlanV1Schema,
    questionMatchedTermsForIssueV1,
} from './research-plan';

export interface LegalValidationIssueV1 {
    code: string;
    path: string;
    message: string;
}

export interface LegalValidationResultV1<T> {
    ok: boolean;
    valid: boolean;
    value?: T;
    errors: LegalValidationIssueV1[];
    issues: LegalValidationIssueV1[];
}

export class LegalContractValidationError extends Error {
    readonly code = 'LEGAL_CONTRACT_VALIDATION_FAILED';
    readonly issues: LegalValidationIssueV1[];

    constructor(issues: LegalValidationIssueV1[]) {
        super(issues.map((issue) => `${issue.code}(${issue.path})`).join(', '));
        this.name = 'LegalContractValidationError';
        this.issues = issues;
    }
}

const FORBIDDEN_AUTH_QUERY_KEYS = new Set([
    'oc',
    'token',
    'access_token',
    'authorization',
    'apikey',
    'api_key',
    'servicekey',
    'service_key',
]);

const CANONICAL_OFFICIAL_SOURCE_ROUTES = {
    law: { path: '/lsInfoP.do', idQuery: 'lsiSeq' },
    ordinance: { path: '/ordinInfoP.do', idQuery: 'ordinSeq' },
    case: { path: '/precInfoP.do', idQuery: 'precSeq' },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isIsoDateTime(value: unknown): value is string {
    return typeof value === 'string'
        && /^\d{4}-\d{2}-\d{2}T/.test(value)
        && !Number.isNaN(Date.parse(value));
}

function issue(
    issues: LegalValidationIssueV1[],
    code: string,
    path: string,
    message: string
): void {
    issues.push({ code, path, message });
}

function finish<T>(value: T | undefined, issues: LegalValidationIssueV1[]): LegalValidationResultV1<T> {
    const ok = issues.length === 0;
    return {
        ok,
        valid: ok,
        ...(ok && value !== undefined ? { value } : {}),
        errors: issues,
        issues,
    };
}

function compareTextAscending(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

function compareCaseSerialDescending(left: string, right: string): number {
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

function compareCases(left: CaseSourceV1, right: CaseSourceV1): number {
    if (left.decisionDate !== right.decisionDate) {
        return left.decisionDate > right.decisionDate ? -1 : 1;
    }
    return compareCaseSerialDescending(left.caseSerialId, right.caseSerialId);
}

export function inspectPublicOfficialLawUrlV1(
    value: unknown,
    expectedSourceType?: LegalSourceV1['sourceType']
): LegalValidationIssueV1 | null {
    if (!isNonEmptyString(value)) {
        return {
            code: 'OFFICIAL_URL_REQUIRED',
            path: '',
            message: '공식 URL이 필요합니다.',
        };
    }

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return {
            code: 'OFFICIAL_URL_REQUIRED',
            path: '',
            message: '공식 URL 형식이 올바르지 않습니다.',
        };
    }

    if (parsed.protocol !== 'https:') {
        return {
            code: 'NON_PUBLIC_URL_REJECTED',
            path: '',
            message: '공식 URL은 HTTPS여야 합니다.',
        };
    }
    if (parsed.hostname !== 'law.go.kr' && parsed.hostname !== 'www.law.go.kr') {
        return {
            code: 'NON_PUBLIC_URL_REJECTED',
            path: '',
            message: '공식 URL은 law.go.kr 공개 페이지여야 합니다.',
        };
    }
    if (parsed.username || parsed.password) {
        return {
            code: 'NON_PUBLIC_URL_REJECTED',
            path: '',
            message: '공식 URL에 인증 정보가 포함될 수 없습니다.',
        };
    }
    if (parsed.port !== '') {
        return {
            code: 'NON_PUBLIC_URL_REJECTED',
            path: '',
            message: '공식 URL은 HTTPS 기본 포트만 사용할 수 있습니다.',
        };
    }
    if (parsed.hash !== '') {
        return {
            code: 'NON_PUBLIC_URL_REJECTED',
            path: '',
            message: '공식 URL에 fragment를 포함할 수 없습니다.',
        };
    }

    const routeEntry = Object.entries(CANONICAL_OFFICIAL_SOURCE_ROUTES).find(
        ([, route]) => route.path === parsed.pathname
    ) as [LegalSourceV1['sourceType'], { path: string; idQuery: string }] | undefined;
    if (!routeEntry) {
        return {
            code: 'NON_PUBLIC_URL_REJECTED',
            path: '',
            message: '법령·자치법규·판례의 canonical 공개 상세 경로가 필요합니다.',
        };
    }
    const [actualSourceType, route] = routeEntry;
    if (expectedSourceType && actualSourceType !== expectedSourceType) {
        return {
            code: 'OFFICIAL_URL_SOURCE_TYPE_MISMATCH',
            path: '',
            message: '출처 유형과 canonical 공개 상세 경로가 일치하지 않습니다.',
        };
    }

    const identifierValues = parsed.searchParams.getAll(route.idQuery);
    if (identifierValues.length === 0 || identifierValues[0].trim() === '') {
        return {
            code: 'OFFICIAL_URL_IDENTIFIER_REQUIRED',
            path: '',
            message: `공식 URL에 단일 ${route.idQuery} 식별자가 필요합니다.`,
        };
    }
    if (identifierValues.length !== 1) {
        return {
            code: 'OFFICIAL_URL_IDENTIFIER_DUPLICATE',
            path: '',
            message: `공식 URL의 ${route.idQuery} 식별자는 정확히 한 번만 허용됩니다.`,
        };
    }

    const queryEntries = [...parsed.searchParams.entries()];
    if (queryEntries.length !== 1 || queryEntries[0][0] !== route.idQuery) {
        const containsAuthQuery = queryEntries.some(([key]) =>
            FORBIDDEN_AUTH_QUERY_KEYS.has(key.toLowerCase()));
        return {
            code: 'NON_PUBLIC_URL_REJECTED',
            path: '',
            message: containsAuthQuery
                ? '공식 URL에 인증 쿼리 값을 포함할 수 없습니다.'
                : `공식 URL에는 ${route.idQuery} 식별자만 허용됩니다.`,
        };
    }
    return null;
}

export function isPublicOfficialLawUrlV1(
    value: unknown,
    expectedSourceType?: LegalSourceV1['sourceType']
): value is string {
    return inspectPublicOfficialLawUrlV1(value, expectedSourceType) === null;
}

function readCanonicalIdentifier(
    url: string,
    sourceType: LegalSourceV1['sourceType']
): string | null {
    return new URL(url).searchParams.get(
        CANONICAL_OFFICIAL_SOURCE_ROUTES[sourceType].idQuery
    );
}

function validateCommonSource(
    value: unknown,
    path: string,
    expectedType: LegalSourceV1['sourceType'],
    issues: LegalValidationIssueV1[]
): value is Record<string, unknown> {
    if (!isRecord(value)) {
        issue(issues, 'SOURCE_SHAPE_INVALID', path, '출처가 객체가 아닙니다.');
        return false;
    }
    if (!isNonEmptyString(value.sourceId)) {
        issue(issues, 'SOURCE_ID_REQUIRED', `${path}.sourceId`, 'sourceId가 필요합니다.');
    }
    if (value.sourceType !== expectedType) {
        issue(issues, 'SOURCE_TYPE_INVALID', `${path}.sourceType`, '출처 유형이 배열과 일치하지 않습니다.');
    }
    if (value.official !== true) {
        issue(issues, 'OFFICIAL_SOURCE_REQUIRED', `${path}.official`, '공식 출처만 사용할 수 있습니다.');
    }
    if (!isNonEmptyString(value.title)) {
        issue(issues, 'SOURCE_TITLE_REQUIRED', `${path}.title`, '출처 제목이 필요합니다.');
    }
    const urlIssue = inspectPublicOfficialLawUrlV1(value.officialUrl, expectedType);
    if (urlIssue) {
        issue(issues, urlIssue.code, `${path}.officialUrl`, urlIssue.message);
    }
    if (!isIsoDateTime(value.retrievedAt)) {
        issue(issues, 'RETRIEVED_AT_INVALID', `${path}.retrievedAt`, '조회시각은 ISO date-time이어야 합니다.');
    }
    if (value.verificationStatus !== 'verified') {
        issue(issues, 'SOURCE_NOT_VERIFIED', `${path}.verificationStatus`, '검증된 출처만 결론 근거로 사용할 수 있습니다.');
    }
    if (typeof value.exactTextHash !== 'string' || !/^[0-9a-f]{64}$/i.test(value.exactTextHash)) {
        issue(issues, 'EXACT_TEXT_HASH_INVALID', `${path}.exactTextHash`, '원문 SHA-256 해시가 필요합니다.');
    }
    return true;
}

function validateLawSource(
    value: unknown,
    path: string,
    asOfDate: string | null,
    issues: LegalValidationIssueV1[]
): value is LawSourceV1 {
    if (!validateCommonSource(value, path, 'law', issues)) return false;
    const law = value as unknown as LawSourceV1;
    for (const [key, field] of [
        ['lawId', law.lawId],
        ['mst', law.mst],
        ['lawType', law.lawType],
        ['exactText', law.exactText],
    ] as const) {
        if (!isNonEmptyString(field)) {
            issue(issues, 'LAW_FIELD_REQUIRED', `${path}.${key}`, `${key}가 필요합니다.`);
        }
    }
    if (!isIsoDate(law.effectiveFrom)) {
        issue(issues, 'EFFECTIVE_DATE_INVALID', `${path}.effectiveFrom`, '시행일이 올바르지 않습니다.');
    }
    if (law.articleEffectiveFrom !== undefined && !isIsoDate(law.articleEffectiveFrom)) {
        issue(issues, 'EFFECTIVE_DATE_INVALID', `${path}.articleEffectiveFrom`, '조문별 시행일이 올바르지 않습니다.');
    }
    if (law.versionStatus !== 'current' || law.appliesAsOf !== true) {
        issue(issues, 'CURRENT_EFFECTIVE_VERSION_REQUIRED', path, '현재 시행본만 사용할 수 있습니다.');
    }
    const controllingDate = law.articleEffectiveFrom ?? law.effectiveFrom;
    if (asOfDate && isIsoDate(controllingDate) && controllingDate > asOfDate) {
        issue(issues, 'FUTURE_VERSION_REJECTED', path, '기준일 뒤에 시행되는 법령을 사용할 수 없습니다.');
    }
    if (!isRecord(law.provision) || !isNonEmptyString(law.provision.article)) {
        issue(issues, 'PROVISION_LOCATOR_REQUIRED', `${path}.provision`, '조문 위치가 필요합니다.');
    }
    const supplementalAudit = law.supplementalMaterialAudit;
    if (!isRecord(supplementalAudit)) {
        issue(
            issues,
            'SUPPLEMENTAL_AUDIT_REQUIRED',
            `${path}.supplementalMaterialAudit`,
            'API 응답에서 파싱한 부칙·별표의 보수적 감사 정보가 필요합니다.'
        );
    } else {
        const counts = [
            supplementalAudit.parsedAddendaCount,
            supplementalAudit.parsedAppendixCount,
            supplementalAudit.matchedAddendaCount,
            supplementalAudit.matchedAppendixCount,
        ];
        if (!counts.every((count) => Number.isSafeInteger(count) && Number(count) >= 0)) {
            issue(
                issues,
                'SUPPLEMENTAL_AUDIT_COUNT_INVALID',
                `${path}.supplementalMaterialAudit`,
                '부칙·별표 파싱 및 키워드 일치 건수는 0 이상의 정수여야 합니다.'
            );
        }
        if (
            Number(supplementalAudit.matchedAddendaCount)
                > Number(supplementalAudit.parsedAddendaCount)
            || Number(supplementalAudit.matchedAppendixCount)
                > Number(supplementalAudit.parsedAppendixCount)
        ) {
            issue(
                issues,
                'SUPPLEMENTAL_AUDIT_COUNT_MISMATCH',
                `${path}.supplementalMaterialAudit`,
                '키워드 일치 건수는 파싱 건수를 넘을 수 없습니다.'
            );
        }
        if (
            typeof supplementalAudit.matchedTextHash !== 'string'
            || !/^[0-9a-f]{64}$/i.test(supplementalAudit.matchedTextHash)
        ) {
            issue(
                issues,
                'SUPPLEMENTAL_AUDIT_HASH_INVALID',
                `${path}.supplementalMaterialAudit.matchedTextHash`,
                '일치한 부칙·별표 원문의 SHA-256 해시가 필요합니다.'
            );
        }
        if (
            supplementalAudit.interpretationStatus
                !== 'keyword_screened_not_legally_interpreted'
        ) {
            issue(
                issues,
                'SUPPLEMENTAL_INTERPRETATION_OVERCLAIM',
                `${path}.supplementalMaterialAudit.interpretationStatus`,
                '키워드 선별은 법률 해석 검증으로 표시할 수 없습니다.'
            );
        }
    }

    if (isPublicOfficialLawUrlV1(law.officialUrl, 'law')) {
        const linkedMst = readCanonicalIdentifier(law.officialUrl, 'law');
        if (linkedMst !== law.mst) {
            issue(issues, 'SOURCE_URL_ID_MISMATCH', `${path}.officialUrl`, '공식 URL의 법령 식별자가 MST와 다릅니다.');
        }
    }
    return true;
}

function validateOrdinanceSource(
    value: unknown,
    path: string,
    asOfDate: string | null,
    scopeAuthorities: Array<{ code: string; name: string }>,
    issues: LegalValidationIssueV1[]
): value is OrdinanceSourceV1 {
    if (!validateCommonSource(value, path, 'ordinance', issues)) return false;
    const ordinance = value as unknown as OrdinanceSourceV1;
    for (const [key, field] of [
        ['ordinanceId', ordinance.ordinanceId],
        ['mst', ordinance.mst],
        ['ordinanceType', ordinance.ordinanceType],
        ['exactText', ordinance.exactText],
    ] as const) {
        if (!isNonEmptyString(field)) {
            issue(issues, 'ORDINANCE_FIELD_REQUIRED', `${path}.${key}`, `${key}가 필요합니다.`);
        }
    }
    if (!isIsoDate(ordinance.effectiveFrom)) {
        issue(issues, 'EFFECTIVE_DATE_INVALID', `${path}.effectiveFrom`, '시행일이 올바르지 않습니다.');
    }
    if (ordinance.articleEffectiveFrom !== undefined && !isIsoDate(ordinance.articleEffectiveFrom)) {
        issue(issues, 'EFFECTIVE_DATE_INVALID', `${path}.articleEffectiveFrom`, '조문별 시행일이 올바르지 않습니다.');
    }
    const controllingDate = ordinance.articleEffectiveFrom ?? ordinance.effectiveFrom;
    if (
        ordinance.versionStatus !== 'current'
        || ordinance.appliesAsOf !== true
        || (asOfDate !== null && isIsoDate(controllingDate) && controllingDate > asOfDate)
    ) {
        issue(issues, 'CURRENT_ORDINANCE_REQUIRED', path, '현재 시행 중인 자치법규만 사용할 수 있습니다.');
    }
    if (!isRecord(ordinance.localAuthority)) {
        issue(issues, 'JURISDICTION_REQUIRED', `${path}.localAuthority`, '자치법규 관할 정보가 필요합니다.');
    } else {
        const exactMatch = scopeAuthorities.some(
            (authority) => authority.code === ordinance.localAuthority.code
                && authority.name === ordinance.localAuthority.name
        );
        if (ordinance.jurisdictionMatch !== 'exact' || !exactMatch) {
            issue(
                issues,
                'ORDINANCE_JURISDICTION_MISMATCH',
                `${path}.localAuthority`,
                '질문 관할의 코드와 명칭이 모두 일치해야 합니다.'
            );
        }
    }
    if (!isRecord(ordinance.provision) || !isNonEmptyString(ordinance.provision.article)) {
        issue(issues, 'PROVISION_LOCATOR_REQUIRED', `${path}.provision`, '조문 위치가 필요합니다.');
    }
    const supplementalAudit = ordinance.supplementalMaterialAudit;
    if (!isRecord(supplementalAudit)) {
        issue(
            issues,
            'SUPPLEMENTAL_AUDIT_REQUIRED',
            `${path}.supplementalMaterialAudit`,
            'API 응답에서 파싱한 부칙·별표의 보수적 감사 정보가 필요합니다.'
        );
    } else {
        const counts = [
            supplementalAudit.parsedAddendaCount,
            supplementalAudit.parsedAppendixCount,
            supplementalAudit.matchedAddendaCount,
            supplementalAudit.matchedAppendixCount,
        ];
        if (!counts.every((count) => Number.isSafeInteger(count) && Number(count) >= 0)) {
            issue(issues, 'SUPPLEMENTAL_AUDIT_COUNT_INVALID', `${path}.supplementalMaterialAudit`, '부칙·별표 감사 건수가 올바르지 않습니다.');
        }
        if (
            Number(supplementalAudit.matchedAddendaCount)
                > Number(supplementalAudit.parsedAddendaCount)
            || Number(supplementalAudit.matchedAppendixCount)
                > Number(supplementalAudit.parsedAppendixCount)
        ) {
            issue(issues, 'SUPPLEMENTAL_AUDIT_COUNT_MISMATCH', `${path}.supplementalMaterialAudit`, '키워드 일치 건수는 파싱 건수를 넘을 수 없습니다.');
        }
        if (
            typeof supplementalAudit.matchedTextHash !== 'string'
            || !/^[0-9a-f]{64}$/i.test(supplementalAudit.matchedTextHash)
        ) {
            issue(issues, 'SUPPLEMENTAL_AUDIT_HASH_INVALID', `${path}.supplementalMaterialAudit.matchedTextHash`, '일치한 부칙·별표 원문의 SHA-256 해시가 필요합니다.');
        }
        if (supplementalAudit.interpretationStatus !== 'keyword_screened_not_legally_interpreted') {
            issue(issues, 'SUPPLEMENTAL_INTERPRETATION_OVERCLAIM', `${path}.supplementalMaterialAudit.interpretationStatus`, '키워드 선별은 법률 해석 검증으로 표시할 수 없습니다.');
        }
    }
    if (isPublicOfficialLawUrlV1(ordinance.officialUrl, 'ordinance')) {
        const linkedId = readCanonicalIdentifier(ordinance.officialUrl, 'ordinance');
        if (linkedId !== ordinance.mst) {
            issue(issues, 'SOURCE_URL_ID_MISMATCH', `${path}.officialUrl`, '공식 URL의 자치법규 식별자가 다릅니다.');
        }
    }
    return true;
}

function validateCaseSource(
    value: unknown,
    path: string,
    asOfDate: string | null,
    issues: LegalValidationIssueV1[]
): value is CaseSourceV1 {
    if (!validateCommonSource(value, path, 'case', issues)) return false;
    const legalCase = value as unknown as CaseSourceV1;
    for (const [key, field] of [
        ['caseSerialId', legalCase.caseSerialId],
        ['caseName', legalCase.caseName],
        ['caseNumber', legalCase.caseNumber],
        ['court', legalCase.court],
        ['holding', legalCase.holding],
        ['reasoningSummary', legalCase.reasoningSummary],
    ] as const) {
        if (!isNonEmptyString(field)) {
            issue(issues, 'CASE_FIELD_REQUIRED', `${path}.${key}`, `${key}가 필요합니다.`);
        }
    }
    if (!isIsoDate(legalCase.decisionDate)) {
        issue(issues, 'CASE_DECISION_DATE_INVALID', `${path}.decisionDate`, '선고일이 올바르지 않습니다.');
    } else if (asOfDate !== null && legalCase.decisionDate > asOfDate) {
        issue(issues, 'FUTURE_CASE_REJECTED', `${path}.decisionDate`, '조회 기준일 뒤의 판례는 반환할 수 없습니다.');
    }
    if (legalCase.fullTextVerified !== true) {
        issue(issues, 'CASE_FULL_TEXT_REQUIRED', `${path}.fullTextVerified`, '판례 전문 검증이 필요합니다.');
    }
    if (legalCase.listingIdentityVerified !== true) {
        issue(issues, 'CASE_IDENTITY_MISMATCH', `${path}.listingIdentityVerified`, '목록과 전문의 사건 식별자가 일치해야 합니다.');
    }
    if (
        !isRecord(legalCase.relevance)
        || (legalCase.relevance.grade !== 'direct' && legalCase.relevance.grade !== 'analogical')
        || !Array.isArray(legalCase.relevance.matchedIssues)
        || legalCase.relevance.matchedIssues.length === 0
        || !legalCase.relevance.matchedIssues.every(isNonEmptyString)
        || !Array.isArray(legalCase.relevance.matchedProvisions)
        || legalCase.relevance.matchedProvisions.length === 0
        || !legalCase.relevance.matchedProvisions.every(isNonEmptyString)
        || !isNonEmptyString(legalCase.relevance.reason)
    ) {
        issue(issues, 'CASE_RELEVANCE_NOT_PROVEN', `${path}.relevance`, '전문 기반 관련성 근거가 필요합니다.');
    }
    const verifiedSameRule = legalCase.currentLawFit === 'verified_same_rule';
    const currentRuleCandidate = legalCase.currentLawFit === 'current_rule_candidate';
    if (!verifiedSameRule && !currentRuleCandidate) {
        issue(issues, 'CASE_CURRENT_LAW_FIT_UNKNOWN', `${path}.currentLawFit`, '현행 규정과의 정합성을 확인한 판례 후보만 반환할 수 있습니다.');
    }
    if (currentRuleCandidate && legalCase.relevance?.grade !== 'analogical') {
        issue(issues, 'CASE_CURRENT_RULE_CANDIDATE_MISUSED', `${path}.relevance.grade`, '규정 버전 ID가 없는 판례 후보는 유추 근거로만 표시해야 합니다.');
    }
    if (
        (verifiedSameRule
            && legalCase.useInConclusion !== 'direct_support'
            && legalCase.useInConclusion !== 'analogical_support')
        || (currentRuleCandidate && legalCase.useInConclusion !== 'analogical_support')
        || (!verifiedSameRule && !currentRuleCandidate)
    ) {
        issue(issues, 'CASE_BACKGROUND_NOT_RETURNABLE', `${path}.useInConclusion`, '배경용·제외 판례는 반환 목록에 포함할 수 없습니다.');
    }
    if (!Array.isArray(legalCase.referencedProvisions) || !legalCase.referencedProvisions.every(isNonEmptyString)) {
        issue(issues, 'CASE_REFERENCED_PROVISIONS_INVALID', `${path}.referencedProvisions`, '참조조문 목록이 올바르지 않습니다.');
    }
    if (isPublicOfficialLawUrlV1(legalCase.officialUrl, 'case')) {
        const linkedId = readCanonicalIdentifier(legalCase.officialUrl, 'case');
        if (linkedId !== legalCase.caseSerialId) {
            issue(issues, 'SOURCE_URL_ID_MISMATCH', `${path}.officialUrl`, '공식 URL의 판례일련번호가 다릅니다.');
        }
    }
    return true;
}

function sourceIdsFromPacket(packet: LegalResearchPacketV1): string[] {
    return [...packet.laws, ...packet.ordinances, ...packet.cases].map((source) => source.sourceId);
}

function validateUniqueSourceIds(sources: unknown[], issues: LegalValidationIssueV1[]): void {
    const seen = new Set<string>();
    sources.forEach((source, index) => {
        if (!isRecord(source) || !isNonEmptyString(source.sourceId)) return;
        if (seen.has(source.sourceId)) {
            issue(issues, 'DUPLICATE_SOURCE_ID', `sources[${index}].sourceId`, 'sourceId는 패킷 안에서 유일해야 합니다.');
        }
        seen.add(source.sourceId);
    });
}

function hasBlockingUnknown(packet: Pick<LegalResearchPacketV1, 'unknowns'>, code?: string): boolean {
    return Array.isArray(packet.unknowns) && packet.unknowns.some(
        (unknown) => isRecord(unknown)
            && unknown.blocking === true
            && (code === undefined || unknown.code === code)
    );
}

function validateScopeShape(value: unknown, path: string, issues: LegalValidationIssueV1[]): value is LegalResearchPacketV1['scope'] {
    if (!isRecord(value)) {
        issue(issues, 'SCOPE_REQUIRED', path, '검토 범위가 필요합니다.');
        return false;
    }
    if (value.countryCode !== 'KR') {
        issue(issues, 'COUNTRY_CODE_INVALID', `${path}.countryCode`, '대한민국 법률 검토만 지원합니다.');
    }
    if (!isIsoDate(value.asOfDate)) {
        issue(issues, 'AS_OF_DATE_INVALID', `${path}.asOfDate`, '기준일이 올바르지 않습니다.');
    }
    if (value.eventDate !== null && !isIsoDate(value.eventDate)) {
        issue(issues, 'EVENT_DATE_INVALID', `${path}.eventDate`, '사건일이 올바르지 않습니다.');
    }
    if (typeof value.eventDateRequired !== 'boolean') {
        issue(issues, 'EVENT_DATE_POLICY_REQUIRED', `${path}.eventDateRequired`, '사건일 필요 여부가 필요합니다.');
    }
    if (value.lawVersionPolicy !== 'effective_current_only') {
        issue(issues, 'CURRENT_EFFECTIVE_VERSION_REQUIRED', `${path}.lawVersionPolicy`, '현행법 전용 정책이어야 합니다.');
    }
    if (!Array.isArray(value.localAuthorities)) {
        issue(issues, 'JURISDICTION_SHAPE_INVALID', `${path}.localAuthorities`, '관할 목록이 필요합니다.');
    } else {
        value.localAuthorities.forEach((authority, index) => {
            if (
                !isRecord(authority)
                || !isNonEmptyString(authority.code)
                || !isNonEmptyString(authority.name)
                || (authority.level !== 'metropolitan' && authority.level !== 'basic')
            ) {
                issue(issues, 'JURISDICTION_SHAPE_INVALID', `${path}.localAuthorities[${index}]`, '관할 코드·명칭·단계가 필요합니다.');
            }
        });
    }
    return true;
}

export function validateLegalResearchPacketV1(input: unknown): LegalValidationResultV1<LegalResearchPacketV1> {
    const issues: LegalValidationIssueV1[] = [];
    if (!isRecord(input)) {
        issue(issues, 'PACKET_SHAPE_INVALID', '$', 'LegalResearchPacketV1 객체가 필요합니다.');
        return finish<LegalResearchPacketV1>(undefined, issues);
    }
    const packet = input as unknown as LegalResearchPacketV1;
    if (packet.contractVersion !== LEGAL_RESEARCH_PACKET_VERSION) {
        issue(issues, 'PACKET_VERSION_INVALID', '$.contractVersion', '지원하지 않는 패킷 버전입니다.');
    }
    if (!isNonEmptyString(packet.packetId)) {
        issue(issues, 'PACKET_ID_REQUIRED', '$.packetId', 'packetId가 필요합니다.');
    }
    if (!isNonEmptyString(packet.question)) {
        issue(issues, 'QUESTION_REQUIRED', '$.question', '질의 원문이 필요합니다.');
    }
    const validStatuses = new Set([
        'complete',
        'partial',
        'clarification_required',
        'temporal_scope_conflict',
        'insufficient_evidence',
    ]);
    if (!validStatuses.has(packet.status)) {
        issue(issues, 'STATUS_INVALID', '$.status', '도메인 상태가 올바르지 않습니다.');
    }

    const scopeValid = validateScopeShape(packet.scope, '$.scope', issues);
    const asOfDate = scopeValid && isIsoDate(packet.scope.asOfDate) ? packet.scope.asOfDate : null;
    const authorities = scopeValid && Array.isArray(packet.scope.localAuthorities)
        ? packet.scope.localAuthorities.filter(
            (authority): authority is LegalResearchPacketV1['scope']['localAuthorities'][number] =>
                isRecord(authority) && isNonEmptyString(authority.code) && isNonEmptyString(authority.name)
        )
        : [];

    const laws = Array.isArray(packet.laws) ? packet.laws : [];
    const ordinances = Array.isArray(packet.ordinances) ? packet.ordinances : [];
    const cases = Array.isArray(packet.cases) ? packet.cases : [];
    if (!Array.isArray(packet.laws)) issue(issues, 'LAWS_ARRAY_REQUIRED', '$.laws', '법령 배열이 필요합니다.');
    if (!Array.isArray(packet.ordinances)) issue(issues, 'ORDINANCES_ARRAY_REQUIRED', '$.ordinances', '자치법규 배열이 필요합니다.');
    if (!Array.isArray(packet.cases)) issue(issues, 'CASES_ARRAY_REQUIRED', '$.cases', '판례 배열이 필요합니다.');

    laws.forEach((law, index) => validateLawSource(law, `$.laws[${index}]`, asOfDate, issues));
    ordinances.forEach((ordinance, index) =>
        validateOrdinanceSource(ordinance, `$.ordinances[${index}]`, asOfDate, authorities, issues));
    cases.forEach((legalCase, index) =>
        validateCaseSource(legalCase, `$.cases[${index}]`, asOfDate, issues));
    validateUniqueSourceIds([...laws, ...ordinances, ...cases], issues);
    const safeLaws = laws.filter(isRecord) as unknown as LawSourceV1[];
    const safeOrdinances = ordinances.filter(isRecord) as unknown as OrdinanceSourceV1[];
    const safeCases = cases.filter(isRecord) as unknown as CaseSourceV1[];

    if (packet.status === 'complete' && laws.length === 0) {
        issue(issues, 'LAW_NOT_FOUND', '$.laws', '완료 답변에는 최소 한 개의 현행 법령 근거가 필요합니다.');
    }
    if (!isRecord(packet.lawSearchAudit)) {
        issue(issues, 'LAW_SEARCH_AUDIT_REQUIRED', '$.lawSearchAudit', '법령 검색 감사 정보가 필요합니다.');
    } else {
        if (packet.lawSearchAudit.target !== 'eflaw' || packet.lawSearchAudit.currentOnlyNw !== 3) {
            issue(issues, 'CURRENT_EFFECTIVE_VERSION_REQUIRED', '$.lawSearchAudit', 'target=eflaw, nw=3만 허용됩니다.');
        }
        if (!packet.lawSearchAudit.exactLawNameMatched || !packet.lawSearchAudit.exactLawTypeMatched) {
            const failClosedStatus = packet.status === 'insufficient_evidence'
                || packet.status === 'clarification_required';
            const hasExpectedUnknown = hasBlockingUnknown(packet, 'LAW_NOT_FOUND')
                || hasBlockingUnknown(packet, 'AMBIGUOUS_LAW');
            if (!failClosedStatus || !hasExpectedUnknown) {
                issue(
                    issues,
                    'AMBIGUOUS_LAW',
                    '$.lawSearchAudit',
                    '불일치 시 결론을 닫고 LAW_NOT_FOUND 또는 AMBIGUOUS_LAW를 기록해야 합니다.'
                );
            }
        }
    }

    if (!isRecord(packet.ordinanceSearchAudit)) {
        issue(issues, 'ORDINANCE_SEARCH_AUDIT_REQUIRED', '$.ordinanceSearchAudit', '자치법규 검색 감사 정보가 필요합니다.');
    } else {
        const audit = packet.ordinanceSearchAudit;
        if (audit.target !== 'ordin' || audit.currentOnlyNw !== 1) {
            issue(issues, 'CURRENT_ORDINANCE_REQUIRED', '$.ordinanceSearchAudit', 'target=ordin, nw=1만 허용됩니다.');
        }
        if (audit.required && authorities.length === 0) {
            if (packet.status !== 'clarification_required' || !hasBlockingUnknown(packet, 'JURISDICTION_REQUIRED')) {
                issue(issues, 'JURISDICTION_REQUIRED', '$.scope.localAuthorities', '필수 관할이 없으면 clarification_required로 닫아야 합니다.');
            }
        } else if (audit.required && !audit.performed) {
            issue(issues, 'ORDINANCE_SEARCH_REQUIRED', '$.ordinanceSearchAudit.performed', '필수 자치법규 검색을 수행해야 합니다.');
        }
        if (!audit.performed && ordinances.length > 0) {
            issue(issues, 'ORDINANCE_SEARCH_AUDIT_MISMATCH', '$.ordinances', '검색 미수행 상태에서 자치법규를 반환할 수 없습니다.');
        }
    }

    let auditedPlan: ReturnType<typeof LegalResearchPlanV1Schema.parse> | null = null;
    if (!isRecord(packet.planCoverageAudit)) {
        issue(issues, 'PLAN_COVERAGE_AUDIT_REQUIRED', '$.planCoverageAudit', '질문과 조사계획의 커버리지 감사 정보가 필요합니다.');
    } else {
        const audit = packet.planCoverageAudit;
        const parsedPlan = LegalResearchPlanV1Schema.safeParse(audit.normalizedPlan);
        if (!parsedPlan.success) {
            issue(issues, 'PLAN_INVALID', '$.planCoverageAudit.normalizedPlan', '감사 가능한 정규화 조사계획이 필요합니다.');
        } else {
            auditedPlan = parsedPlan.data;
            const expectedHash = hashLegalResearchPlanV1(auditedPlan);
            if (audit.normalizedPlanHash !== expectedHash) {
                issue(issues, 'PLAN_HASH_MISMATCH', '$.planCoverageAudit.normalizedPlanHash', '정규화 조사계획 hash가 일치하지 않습니다.');
            }
            if (
                audit.reviewStatus
                !== 'mechanically_validated_controlled_taxonomy_not_legal_reviewed'
            ) {
                issue(issues, 'PLAN_REVIEW_STATUS_INVALID', '$.planCoverageAudit.reviewStatus', '기계적 커버리지와 법률가 검토 상태를 구분해야 합니다.');
            }
            const expectedCoverage = auditedPlan.issues.map((planIssue) => ({
                issueId: planIssue.issueId,
                questionMatchedTerms: questionMatchedTermsForIssueV1(
                    packet.question,
                    auditedPlan!,
                    planIssue.issueId
                ),
                lawAnchorCount: auditedPlan!.lawAnchors.filter((anchor) =>
                    anchor.issueIds.includes(planIssue.issueId)).length,
                ordinanceAnchorCount: auditedPlan!.ordinanceAnchors.filter((anchor) =>
                    anchor.issueIds.includes(planIssue.issueId)).length,
                caseQueryCount: auditedPlan!.caseQueries.filter((query) =>
                    query.issueIds.includes(planIssue.issueId)).length,
            }));
            if (JSON.stringify(audit.issues) !== JSON.stringify(expectedCoverage)) {
                issue(issues, 'PLAN_COVERAGE_MISMATCH', '$.planCoverageAudit.issues', '질문·쟁점·검색계획 커버리지 감사 결과가 일치하지 않습니다.');
            }
            const allQuestionMatched = expectedCoverage.every((entry) =>
                entry.questionMatchedTerms.length > 0);
            const allLawCovered = expectedCoverage.every((entry) =>
                entry.lawAnchorCount > 0);
            const allCasesCovered = expectedCoverage.every((entry) =>
                entry.caseQueryCount > 0);
            if (
                audit.allIssuesQuestionMatched !== allQuestionMatched
                || audit.allIssuesLawCovered !== allLawCovered
                || audit.allIssuesCaseCovered !== allCasesCovered
                || !allQuestionMatched
                || !allLawCovered
                || !allCasesCovered
            ) {
                issue(issues, 'PLAN_COVERAGE_INCOMPLETE', '$.planCoverageAudit', '모든 쟁점은 질문 exact 검색어, 현행 법령 anchor와 판례 query로 커버되어야 합니다.');
            }
        }
    }

    if (!isRecord(packet.caseSearchAudit)) {
        issue(issues, 'CASE_SEARCH_AUDIT_REQUIRED', '$.caseSearchAudit', '판례 검색 감사 정보가 필요합니다.');
    } else {
        const audit = packet.caseSearchAudit;
        if (audit.target !== 'prec' || audit.listSort !== 'ddes') {
            issue(issues, 'CASE_PROVIDER_POLICY_INVALID', '$.caseSearchAudit', 'target=prec, sort=ddes가 필요합니다.');
        }
        if (audit.resultSort !== 'decision_date_desc_case_serial_id_desc') {
            issue(issues, 'CASE_ORDER_INVALID', '$.caseSearchAudit.resultSort', '판례 정렬 계약이 올바르지 않습니다.');
        }
        if (audit.requestedMax !== MAX_RELEVANT_CASES) {
            issue(issues, 'CASE_MAX_POLICY_INVALID', '$.caseSearchAudit.requestedMax', `최대 반환 수는 ${MAX_RELEVANT_CASES}로 고정됩니다.`);
        }
        if (audit.queryRelaxedToFill !== false) {
            issue(issues, 'CASE_PADDING_DETECTED', '$.caseSearchAudit.queryRelaxedToFill', `${MAX_RELEVANT_CASES}건을 채우기 위한 검색 완화는 금지됩니다.`);
        }
        if (auditedPlan) {
            const expectedLawQueries = [...new Set(
                auditedPlan.caseQueries.flatMap((query) => query.lawNames)
            )];
            const expectedIssueQueries = [...new Set(
                auditedPlan.caseQueries.flatMap((query) => query.issueTerms)
            )];
            if (
                !Array.isArray(audit.lawNameQueries)
                || !sameStringSet(audit.lawNameQueries, expectedLawQueries)
                || !Array.isArray(audit.issueQueries)
                || !sameStringSet(audit.issueQueries, expectedIssueQueries)
            ) {
                issue(issues, 'CASE_QUERY_SCOPE_MISMATCH', '$.caseSearchAudit', '판례 검색 stream은 감사된 조사계획과 정확히 일치해야 합니다.');
            }
        }
        for (const key of ['candidateCount', 'qualifiedCount', 'returnedCount'] as const) {
            if (!Number.isInteger(audit[key]) || audit[key] < 0) {
                issue(issues, 'CASE_AUDIT_COUNT_INVALID', `$.caseSearchAudit.${key}`, '검색 수량은 0 이상의 정수여야 합니다.');
            }
        }
        if (
            Number.isInteger(audit.candidateCount)
            && Number.isInteger(audit.qualifiedCount)
            && Number.isInteger(audit.returnedCount)
        ) {
            if (audit.candidateCount < audit.qualifiedCount || audit.qualifiedCount < audit.returnedCount) {
                issue(issues, 'CASE_AUDIT_COUNT_INVALID', '$.caseSearchAudit', 'candidate >= qualified >= returned여야 합니다.');
            }
            if (audit.returnedCount !== cases.length) {
                issue(issues, 'CASE_RETURNED_COUNT_MISMATCH', '$.caseSearchAudit.returnedCount', 'returnedCount와 실제 판례 수가 다릅니다.');
            }
            if (audit.returnedCount !== Math.min(audit.qualifiedCount, MAX_RELEVANT_CASES)) {
                issue(issues, 'CASE_PADDING_DETECTED', '$.caseSearchAudit', `적격 판례는 최대 ${MAX_RELEVANT_CASES}건까지 빠짐없이 반환해야 합니다.`);
            }
        }
        if (cases.length > MAX_RELEVANT_CASES) {
            issue(issues, 'CASE_LIMIT_EXCEEDED', '$.cases', `판례는 최대 ${MAX_RELEVANT_CASES}건만 반환할 수 있습니다.`);
        }
        if (cases.length < MAX_RELEVANT_CASES && audit.shortfallReason === null) {
            issue(issues, 'CASE_SHORTFALL_REASON_REQUIRED', '$.caseSearchAudit.shortfallReason', `${MAX_RELEVANT_CASES}건 미만이면 부족 사유가 필요합니다.`);
        }
        if (cases.length === MAX_RELEVANT_CASES && audit.shortfallReason !== null) {
            issue(issues, 'CASE_SHORTFALL_REASON_INVALID', '$.caseSearchAudit.shortfallReason', `${MAX_RELEVANT_CASES}건 반환 시 부족 사유가 없어야 합니다.`);
        }
        if (
            !audit.upstreamComplete
            && cases.length < MAX_RELEVANT_CASES
            && audit.shortfallReason !== 'upstream_incomplete'
        ) {
            issue(issues, 'CASE_UPSTREAM_STATE_MISMATCH', '$.caseSearchAudit.shortfallReason', '상류 미완료 상태를 명시해야 합니다.');
        }
        if (audit.upstreamComplete && audit.shortfallReason === 'upstream_incomplete') {
            issue(issues, 'CASE_UPSTREAM_STATE_MISMATCH', '$.caseSearchAudit.shortfallReason', '공식 결과 소진과 상류 미완료를 구분해야 합니다.');
        }
        if (
            !audit.upstreamComplete
            && packet.status === 'complete'
        ) {
            issue(issues, 'CASE_UPSTREAM_STATUS_INVALID', '$.status', '상류 미완료 결과는 complete일 수 없습니다.');
        }
    }

    const seenCases = new Set<string>();
    safeCases.forEach((legalCase, index) => {
        if (!isNonEmptyString(legalCase.caseSerialId) || !isIsoDate(legalCase.decisionDate)) return;
        if (seenCases.has(legalCase.caseSerialId)) {
            issue(issues, 'CASE_PADDING_DETECTED', `$.cases[${index}].caseSerialId`, '중복 판례를 반환할 수 없습니다.');
        }
        seenCases.add(legalCase.caseSerialId);
        const previous = safeCases[index - 1];
        if (
            index > 0
            && previous
            && isNonEmptyString(previous.caseSerialId)
            && isIsoDate(previous.decisionDate)
            && compareCases(previous, legalCase) > 0
        ) {
            issue(issues, 'CASE_ORDER_INVALID', `$.cases[${index}]`, '선고일 내림차순, 동률 판례일련번호 내림차순이어야 합니다.');
        }
    });

    if (!Array.isArray(packet.facts)) {
        issue(issues, 'FACTS_ARRAY_REQUIRED', '$.facts', '사실 목록이 필요합니다.');
    }
    if (!Array.isArray(packet.unknowns)) {
        issue(issues, 'UNKNOWNS_ARRAY_REQUIRED', '$.unknowns', '미확인 사항 목록이 필요합니다.');
    } else if (packet.status === 'complete' && hasBlockingUnknown(packet)) {
        issue(issues, 'BLOCKING_UNKNOWN_REQUIRES_NON_COMPLETE', '$.unknowns', 'blocking 미확인 사항이 있으면 complete일 수 없습니다.');
    }

    if (scopeValid) {
        if (packet.scope.eventDateRequired && packet.scope.eventDate === null) {
            if (packet.status !== 'clarification_required' || !hasBlockingUnknown(packet, 'EVENT_DATE_REQUIRED')) {
                issue(issues, 'EVENT_DATE_REQUIRED', '$.scope.eventDate', '사건일이 필요하면 clarification_required로 닫아야 합니다.');
            }
        }
        if (packet.scope.eventDate !== null && isIsoDate(packet.scope.eventDate)) {
            if (packet.scope.eventDate > packet.scope.asOfDate) {
                const statusClosed = packet.status === 'temporal_scope_conflict'
                    || packet.status === 'insufficient_evidence';
                if (!statusClosed || !hasBlockingUnknown(packet, 'FUTURE_EVENT_DATE')) {
                    issue(
                        issues,
                        'FUTURE_EVENT_DATE',
                        '$.scope.eventDate',
                        '미래 사건일에는 현재 시행본이 유지된다고 보증할 수 없습니다.'
                    );
                }
            }
            const historicalLawRequired = [...safeLaws, ...safeOrdinances].some((source) => {
                const controllingDate = source.sourceType === 'law'
                    ? source.articleEffectiveFrom ?? source.effectiveFrom
                    : source.articleEffectiveFrom ?? source.effectiveFrom;
                return isIsoDate(controllingDate) && packet.scope.eventDate !== null
                    && packet.scope.eventDate < controllingDate;
            });
            if (historicalLawRequired) {
                const statusClosed = packet.status === 'temporal_scope_conflict'
                    || packet.status === 'insufficient_evidence';
                if (!statusClosed || !hasBlockingUnknown(packet, 'HISTORICAL_LAW_REQUIRED')) {
                    issue(
                        issues,
                        'HISTORICAL_LAW_REQUIRED',
                        '$.scope.eventDate',
                        '현행 규정 시행 전 사건에 현행법을 소급 적용할 수 없습니다.'
                    );
                }
            }
        }
    }

    if (!isRecord(packet.provenance)) {
        issue(issues, 'PROVENANCE_REQUIRED', '$.provenance', 'provenance가 필요합니다.');
    } else {
        if (packet.provenance.provider !== 'KOREA_LAW_OPEN_API') {
            issue(issues, 'PROVIDER_INVALID', '$.provenance.provider', '공식 법령 provider가 필요합니다.');
        }
        if (!isIsoDateTime(packet.provenance.generatedAt)) {
            issue(issues, 'GENERATED_AT_INVALID', '$.provenance.generatedAt', '생성시각은 ISO date-time이어야 합니다.');
        }
    }

    return finish(packet, issues);
}

function validateSourceReferences(
    sourceIds: unknown,
    path: string,
    availableSources: Map<string, LegalSourceV1>,
    issues: LegalValidationIssueV1[],
    allowedType?: LegalSourceV1['sourceType']
): void {
    if (!Array.isArray(sourceIds) || sourceIds.length === 0 || !sourceIds.every(isNonEmptyString)) {
        issue(issues, 'SOURCE_REFERENCE_REQUIRED', path, '최소 한 개의 sourceId 참조가 필요합니다.');
        return;
    }
    if (new Set(sourceIds).size !== sourceIds.length) {
        issue(issues, 'DUPLICATE_SOURCE_REFERENCE', path, '같은 sourceId를 중복 참조할 수 없습니다.');
    }
    sourceIds.forEach((sourceId, index) => {
        const source = availableSources.get(sourceId);
        if (!source) {
            issue(issues, 'SOURCE_REFERENCE_NOT_FOUND', `${path}[${index}]`, '존재하지 않는 sourceId입니다.');
        } else if (allowedType && source.sourceType !== allowedType) {
            issue(issues, 'SOURCE_REFERENCE_TYPE_INVALID', `${path}[${index}]`, '해당 분석에 맞지 않는 출처 유형입니다.');
        }
    });
}

function sourceContainsEvidenceQuote(source: LegalSourceV1, quote: string): boolean {
    if (source.sourceType === 'law' || source.sourceType === 'ordinance') {
        return source.exactText.includes(quote);
    }
    return source.holding.includes(quote) || source.reasoningSummary.includes(quote);
}

function validateEvidenceQuotes(
    value: unknown,
    path: string,
    sourceIds: unknown,
    availableSources: Map<string, LegalSourceV1>,
    issues: LegalValidationIssueV1[],
    options: {
        required: boolean;
        allowedType?: LegalSourceV1['sourceType'];
        coverEverySource?: boolean;
    }
): void {
    if (!Array.isArray(value)) {
        issue(issues, 'EVIDENCE_QUOTES_REQUIRED', path, '공식 원문 인용 배열이 필요합니다.');
        return;
    }
    if (options.required && value.length === 0) {
        issue(issues, 'EVIDENCE_QUOTE_REQUIRED', path, '공식 원문 인용이 하나 이상 필요합니다.');
        return;
    }
    const referencedIds = Array.isArray(sourceIds)
        ? new Set(sourceIds.filter(isNonEmptyString))
        : new Set<string>();
    const quotedSourceIds = new Set<string>();
    const seen = new Set<string>();
    value.forEach((entry, index) => {
        if (
            !isRecord(entry)
            || !isNonEmptyString(entry.sourceId)
            || !isNonEmptyString(entry.quote)
            || entry.quote.length > 500
        ) {
            issue(issues, 'EVIDENCE_QUOTE_INVALID', `${path}[${index}]`, 'sourceId와 제한 길이 안의 원문 인용이 필요합니다.');
            return;
        }
        const key = `${entry.sourceId}\u0000${entry.quote}`;
        if (seen.has(key)) {
            issue(issues, 'DUPLICATE_EVIDENCE_QUOTE', `${path}[${index}]`, '같은 공식 원문 인용을 중복할 수 없습니다.');
        }
        seen.add(key);
        if (!referencedIds.has(entry.sourceId)) {
            issue(issues, 'EVIDENCE_SOURCE_NOT_REFERENCED', `${path}[${index}].sourceId`, '원문 인용 sourceId는 같은 서술의 sourceIds에 포함되어야 합니다.');
            return;
        }
        const source = availableSources.get(entry.sourceId);
        if (!source) {
            issue(issues, 'SOURCE_REFERENCE_NOT_FOUND', `${path}[${index}].sourceId`, '존재하지 않는 원문 인용 sourceId입니다.');
            return;
        }
        if (options.allowedType && source.sourceType !== options.allowedType) {
            issue(issues, 'EVIDENCE_SOURCE_TYPE_INVALID', `${path}[${index}].sourceId`, '해당 서술에 맞지 않는 원문 출처 유형입니다.');
            return;
        }
        if (!sourceContainsEvidenceQuote(source, entry.quote)) {
            issue(issues, 'EVIDENCE_QUOTE_NOT_FOUND', `${path}[${index}].quote`, '인용문이 해당 공식 출처 원문에 exact substring으로 존재하지 않습니다.');
            return;
        }
        quotedSourceIds.add(entry.sourceId);
    });
    if (options.coverEverySource) {
        for (const sourceId of referencedIds) {
            if (!quotedSourceIds.has(sourceId)) {
                issue(issues, 'EVIDENCE_SOURCE_NOT_COVERED', path, `참조 출처 ${sourceId}의 공식 원문 인용이 필요합니다.`);
            }
        }
    }
}

function sameStringSet(left: string[], right: string[]): boolean {
    return left.length === right.length
        && [...left].sort(compareTextAscending).every(
            (value, index) => value === [...right].sort(compareTextAscending)[index]
        );
}

export function validateLegalAnswerV1(
    input: unknown,
    packetInput?: unknown
): LegalValidationResultV1<LegalAnswerV1> {
    const issues: LegalValidationIssueV1[] = [];
    if (!isRecord(input)) {
        issue(issues, 'ANSWER_SHAPE_INVALID', '$', 'LegalAnswerV1 객체가 필요합니다.');
        return finish<LegalAnswerV1>(undefined, issues);
    }
    const answer = input as unknown as LegalAnswerV1;
    const answerBlockingUnknown = Array.isArray(answer.unknowns)
        && answer.unknowns.some((unknown) => isRecord(unknown) && unknown.blocking === true);
    const packetBlockingUnknown = isRecord(packetInput)
        && Array.isArray(packetInput.unknowns)
        && packetInput.unknowns.some((unknown) => isRecord(unknown) && unknown.blocking === true);
    const blockingUnknown = answerBlockingUnknown || packetBlockingUnknown;
    if (answer.contractVersion !== LEGAL_ANSWER_VERSION) {
        issue(issues, 'ANSWER_VERSION_INVALID', '$.contractVersion', '지원하지 않는 답변 버전입니다.');
    }
    if (!isNonEmptyString(answer.packetId)) {
        issue(issues, 'PACKET_ID_REQUIRED', '$.packetId', 'packetId가 필요합니다.');
    }
    if (![
        'complete',
        'partial',
        'clarification_required',
        'temporal_scope_conflict',
        'insufficient_evidence',
    ].includes(answer.status)) {
        issue(issues, 'STATUS_INVALID', '$.status', '도메인 상태가 올바르지 않습니다.');
    }
    validateScopeShape(answer.scope, '$.scope', issues);
    if (!isRecord(answer.conclusion) || !isNonEmptyString(answer.conclusion.text)) {
        issue(issues, 'CONCLUSION_REQUIRED', '$.conclusion', '결론 문장이 필요합니다.');
    } else if (!['supported', 'conditional', 'cannot_conclude'].includes(answer.conclusion.kind)) {
        issue(issues, 'CONCLUSION_KIND_INVALID', '$.conclusion.kind', '결론 종류가 올바르지 않습니다.');
    }

    const sourceValues = Array.isArray(answer.sourceIndex) ? answer.sourceIndex : [];
    if (!Array.isArray(answer.sourceIndex)) {
        issue(issues, 'SOURCE_INDEX_REQUIRED', '$.sourceIndex', '출처 색인이 필요합니다.');
    }
    const asOfDate = isRecord(answer.scope) && isIsoDate(answer.scope.asOfDate)
        ? answer.scope.asOfDate
        : null;
    const answerEventDate = isRecord(answer.scope) && isIsoDate(answer.scope.eventDate)
        ? answer.scope.eventDate
        : null;
    const authorities = isRecord(answer.scope) && Array.isArray(answer.scope.localAuthorities)
        ? answer.scope.localAuthorities.filter(
            (authority): authority is LegalAnswerV1['scope']['localAuthorities'][number] =>
                isRecord(authority) && isNonEmptyString(authority.code) && isNonEmptyString(authority.name)
        )
        : [];
    sourceValues.forEach((source, index) => {
        if (!isRecord(source)) {
            issue(issues, 'SOURCE_SHAPE_INVALID', `$.sourceIndex[${index}]`, '출처가 객체가 아닙니다.');
        } else if (source.sourceType === 'law') {
            validateLawSource(source, `$.sourceIndex[${index}]`, asOfDate, issues);
        } else if (source.sourceType === 'ordinance') {
            validateOrdinanceSource(source, `$.sourceIndex[${index}]`, asOfDate, authorities, issues);
        } else if (source.sourceType === 'case') {
            validateCaseSource(source, `$.sourceIndex[${index}]`, asOfDate, issues);
        } else {
            issue(issues, 'SOURCE_TYPE_INVALID', `$.sourceIndex[${index}].sourceType`, '출처 유형이 올바르지 않습니다.');
        }
    });
    validateUniqueSourceIds(sourceValues, issues);
    const sources = sourceValues.filter(isRecord) as unknown as LegalSourceV1[];
    const sourceMap = new Map(sources.map((source) => [source.sourceId, source]));

    if (isRecord(answer.conclusion)) {
        if (answer.conclusion.kind === 'cannot_conclude') {
            if (!Array.isArray(answer.conclusion.sourceIds)) {
                issue(issues, 'SOURCE_REFERENCE_REQUIRED', '$.conclusion.sourceIds', '결론 sourceId 목록이 필요합니다.');
            } else if (answer.conclusion.sourceIds.length > 0) {
                validateSourceReferences(answer.conclusion.sourceIds, '$.conclusion.sourceIds', sourceMap, issues);
            }
        } else {
            validateSourceReferences(answer.conclusion.sourceIds, '$.conclusion.sourceIds', sourceMap, issues);
            const hasCurrentRuleSource = Array.isArray(answer.conclusion.sourceIds)
                && answer.conclusion.sourceIds.some((sourceId) => {
                    const source = sourceMap.get(sourceId);
                    return source?.sourceType === 'law' || source?.sourceType === 'ordinance';
                });
            if (!hasCurrentRuleSource) {
                issue(
                    issues,
                    'CURRENT_RULE_SOURCE_REQUIRED',
                    '$.conclusion.sourceIds',
                    '확정·조건부 결론에는 현행 법령 또는 자치법규 근거가 필요합니다.'
                );
            }
        }
        const conclusionSources = Array.isArray(answer.conclusion.sourceIds)
            ? answer.conclusion.sourceIds
            : [];
        validateEvidenceQuotes(
            answer.conclusion.evidenceQuotes,
            '$.conclusion.evidenceQuotes',
            conclusionSources,
            sourceMap,
            issues,
            {
                required: answer.conclusion.kind !== 'cannot_conclude',
                coverEverySource: conclusionSources.length > 0,
            }
        );
    }

    if (!Array.isArray(answer.facts)) {
        issue(issues, 'FACTS_ARRAY_REQUIRED', '$.facts', '사실 목록이 필요합니다.');
    }
    const safeFacts = Array.isArray(answer.facts)
        ? answer.facts.filter(isRecord) as unknown as LegalAnswerV1['facts']
        : [];
    const factIds = new Set(
        safeFacts.map((fact) => fact.factId).filter(isNonEmptyString)
    );
    const factMap = new Map(
        safeFacts
            .filter((fact) => isNonEmptyString(fact.factId))
            .map((fact) => [fact.factId, fact] as const)
    );
    if (safeFacts.length === answer.facts?.length && factIds.size !== safeFacts.length) {
        issue(issues, 'DUPLICATE_FACT_ID', '$.facts', 'factId는 답변 안에서 유일해야 합니다.');
    }

    if (!Array.isArray(answer.ruleClaims)) {
        issue(issues, 'RULE_CLAIMS_ARRAY_REQUIRED', '$.ruleClaims', '법률 명제 목록이 필요합니다.');
    } else {
        if (
            answer.ruleClaims.length === 0
            && (answer.status === 'complete' || answer.conclusion?.kind === 'supported')
        ) {
            issue(issues, 'RULE_CLAIM_REQUIRED', '$.ruleClaims', '완료·확정 결론에는 공식 원문에 묶인 법률 명제가 필요합니다.');
        }
        answer.ruleClaims.forEach((claim, index) => {
            if (!isRecord(claim) || !isNonEmptyString(claim.text)) {
                issue(issues, 'RULE_CLAIM_INVALID', `$.ruleClaims[${index}]`, '법률 명제가 올바르지 않습니다.');
                return;
            }
            validateSourceReferences(claim.sourceIds, `$.ruleClaims[${index}].sourceIds`, sourceMap, issues, 'law');
            validateEvidenceQuotes(
                claim.evidenceQuotes,
                `$.ruleClaims[${index}].evidenceQuotes`,
                claim.sourceIds,
                sourceMap,
                issues,
                { required: true, allowedType: 'law', coverEverySource: true }
            );
        });
    }

    if (!Array.isArray(answer.ordinanceAnalysis)) {
        issue(issues, 'ORDINANCE_ANALYSIS_ARRAY_REQUIRED', '$.ordinanceAnalysis', '자치법규 분석 목록이 필요합니다.');
    } else {
        answer.ordinanceAnalysis.forEach((analysis, index) => {
            if (!isRecord(analysis) || !isNonEmptyString(analysis.text)) {
                issue(issues, 'ORDINANCE_ANALYSIS_INVALID', `$.ordinanceAnalysis[${index}]`, '자치법규 분석이 올바르지 않습니다.');
                return;
            }
            validateSourceReferences(
                analysis.sourceIds,
                `$.ordinanceAnalysis[${index}].sourceIds`,
                sourceMap,
                issues,
                'ordinance'
            );
            validateEvidenceQuotes(
                analysis.evidenceQuotes,
                `$.ordinanceAnalysis[${index}].evidenceQuotes`,
                analysis.sourceIds,
                sourceMap,
                issues,
                { required: true, allowedType: 'ordinance', coverEverySource: true }
            );
        });
    }

    if (!isRecord(answer.caseSynthesis)) {
        issue(issues, 'CASE_SYNTHESIS_REQUIRED', '$.caseSynthesis', '판례 종합이 필요합니다.');
    } else {
        if (typeof answer.caseSynthesis.upstreamComplete !== 'boolean') {
            issue(issues, 'CASE_UPSTREAM_COMPLETENESS_REQUIRED', '$.caseSynthesis.upstreamComplete', '최신순 판례 탐색 완결성 표시가 필요합니다.');
        }
        if (
            !isRecord(answer.caseSynthesis.searchScope)
            || !isNonEmptyString(answer.caseSynthesis.searchScope.normalizedPlanHash)
            || !/^[0-9a-f]{64}$/.test(String(answer.caseSynthesis.searchScope.normalizedPlanHash))
            || !Array.isArray(answer.caseSynthesis.searchScope.lawNameQueries)
            || !answer.caseSynthesis.searchScope.lawNameQueries.every(isNonEmptyString)
            || !Array.isArray(answer.caseSynthesis.searchScope.issueQueries)
            || !answer.caseSynthesis.searchScope.issueQueries.every(isNonEmptyString)
        ) {
            issue(issues, 'CASE_SEARCH_SCOPE_REQUIRED', '$.caseSynthesis.searchScope', '판례 최신성 주장의 조사계획 hash와 검색 stream 범위가 필요합니다.');
        }
        const caseSourceIds = Array.isArray(answer.caseSynthesis.sourceIds)
            ? answer.caseSynthesis.sourceIds
            : [];
        if (answer.caseSynthesis.returnedCount !== caseSourceIds.length) {
            issue(issues, 'CASE_RETURNED_COUNT_MISMATCH', '$.caseSynthesis.returnedCount', '표시 판례 수와 sourceIds 수가 다릅니다.');
        }
        if (caseSourceIds.length > MAX_RELEVANT_CASES) {
            issue(issues, 'CASE_LIMIT_EXCEEDED', '$.caseSynthesis.sourceIds', `판례는 최대 ${MAX_RELEVANT_CASES}건만 표시할 수 있습니다.`);
        }
        if (caseSourceIds.length === 0) {
            if (answer.caseSynthesis.returnedCount !== 0) {
                issue(issues, 'CASE_RETURNED_COUNT_MISMATCH', '$.caseSynthesis', '판례 0건 표기가 일치하지 않습니다.');
            }
        } else {
            validateSourceReferences(caseSourceIds, '$.caseSynthesis.sourceIds', sourceMap, issues, 'case');
            if (!isNonEmptyString(answer.caseSynthesis.summary)) {
                issue(issues, 'CASE_SYNTHESIS_SUMMARY_REQUIRED', '$.caseSynthesis.summary', '판례가 있으면 종합 설명이 필요합니다.');
            }
            const orderedCases = caseSourceIds
                .map((sourceId) => sourceMap.get(sourceId))
                .filter((source): source is CaseSourceV1 => source?.sourceType === 'case');
            for (let index = 1; index < orderedCases.length; index++) {
                if (compareCases(orderedCases[index - 1], orderedCases[index]) > 0) {
                    issue(issues, 'CASE_ORDER_INVALID', `$.caseSynthesis.sourceIds[${index}]`, '판례 종합은 최신순이어야 합니다.');
                }
            }
        }
        validateEvidenceQuotes(
            answer.caseSynthesis.evidenceQuotes,
            '$.caseSynthesis.evidenceQuotes',
            caseSourceIds,
            sourceMap,
            issues,
            { required: caseSourceIds.length > 0, allowedType: 'case', coverEverySource: true }
        );
        if (caseSourceIds.length < MAX_RELEVANT_CASES && answer.caseSynthesis.shortfallReason === null) {
            issue(issues, 'CASE_SHORTFALL_REASON_REQUIRED', '$.caseSynthesis.shortfallReason', `${MAX_RELEVANT_CASES}건 미만이면 부족 사유가 필요합니다.`);
        }
        if (caseSourceIds.length === MAX_RELEVANT_CASES && answer.caseSynthesis.shortfallReason !== null) {
            issue(issues, 'CASE_SHORTFALL_REASON_INVALID', '$.caseSynthesis.shortfallReason', `${MAX_RELEVANT_CASES}건이면 부족 사유가 없어야 합니다.`);
        }
    }

    if (!Array.isArray(answer.applications)) {
        issue(issues, 'APPLICATIONS_ARRAY_REQUIRED', '$.applications', '적용 판단 목록이 필요합니다.');
    } else {
        if (blockingUnknown && answer.applications.length > 0) {
            issue(
                issues,
                'BLOCKING_UNKNOWN_APPLICATIONS_FORBIDDEN',
                '$.applications',
                'blocking 미확인 사항이 있으면 사실 적용 판단을 렌더링할 수 없습니다.'
            );
        } else if (!blockingUnknown && safeFacts.length > 0 && answer.applications.length === 0) {
            issue(issues, 'APPLICATION_REQUIRED', '$.applications', '제공 사실이 있으면 적어도 하나의 근거 기반 적용 판단이 필요합니다.');
        }
        answer.applications.forEach((application, index) => {
            if (!isRecord(application) || !isNonEmptyString(application.inference) || !isNonEmptyString(application.result)) {
                issue(issues, 'APPLICATION_INVALID', `$.applications[${index}]`, '적용 판단이 올바르지 않습니다.');
                return;
            }
            validateSourceReferences(application.sourceIds, `$.applications[${index}].sourceIds`, sourceMap, issues);
            validateEvidenceQuotes(
                application.evidenceQuotes,
                `$.applications[${index}].evidenceQuotes`,
                application.sourceIds,
                sourceMap,
                issues,
                { required: true, coverEverySource: true }
            );
            if (
                Array.isArray(application.sourceIds)
                && !application.sourceIds.some((sourceId) => {
                    const source = sourceMap.get(sourceId);
                    return source?.sourceType === 'law' || source?.sourceType === 'ordinance';
                })
            ) {
                issue(
                    issues,
                    'CURRENT_RULE_SOURCE_REQUIRED',
                    `$.applications[${index}].sourceIds`,
                    '사실 적용 판단에는 현행 법령 또는 자치법규 근거가 필요합니다.'
                );
            }
            if (!Array.isArray(application.factIds) || !application.factIds.every(isNonEmptyString)) {
                issue(issues, 'FACT_REFERENCE_REQUIRED', `$.applications[${index}].factIds`, '사실 참조 목록이 필요합니다.');
            } else {
                application.factIds.forEach((factId, factIndex) => {
                    if (!factIds.has(factId)) {
                        issue(issues, 'FACT_REFERENCE_NOT_FOUND', `$.applications[${index}].factIds[${factIndex}]`, '존재하지 않는 factId입니다.');
                    }
                });
            }

            const applicationSources = Array.isArray(application.sourceIds)
                ? application.sourceIds
                    .map((sourceId) => sourceMap.get(sourceId))
                    .filter((source): source is LegalSourceV1 => Boolean(source))
                : [];
            const applicationRuleSources = applicationSources.filter(
                (source): source is LawSourceV1 | OrdinanceSourceV1 =>
                    source.sourceType === 'law' || source.sourceType === 'ordinance'
            );
            const applicationNeedsHistoricalRule = answerEventDate !== null
                && applicationRuleSources.some((source) => {
                    const controllingDate = source.articleEffectiveFrom ?? source.effectiveFrom;
                    return isIsoDate(controllingDate) && answerEventDate < controllingDate;
                });
            const packetHasHistoricalBlock = answer.status === 'temporal_scope_conflict'
                || (Array.isArray(answer.unknowns) && answer.unknowns.some((unknown) =>
                    isRecord(unknown)
                    && unknown.code === 'HISTORICAL_LAW_REQUIRED'
                    && unknown.blocking === true));
            if (![
                'current_rule_applies',
                'historical_review_required',
                'unknown',
            ].includes(application.temporalApplicability)) {
                issue(issues, 'APPLICATION_TEMPORAL_STATUS_INVALID', `$.applications[${index}].temporalApplicability`, '사실 적용의 시점 상태가 올바르지 않습니다.');
            } else if (
                application.temporalApplicability === 'current_rule_applies'
                && (
                    answerEventDate === null
                    || applicationNeedsHistoricalRule
                    || packetHasHistoricalBlock
                )
            ) {
                issue(issues, 'APPLICATION_TEMPORAL_MISMATCH', `$.applications[${index}].temporalApplicability`, '사건일이 없거나 과거 시행본 검토가 필요하면 현행 규정 적용으로 표시할 수 없습니다.');
            }

            if (!['high', 'medium', 'low'].includes(application.confidence)) {
                issue(issues, 'APPLICATION_CONFIDENCE_INVALID', `$.applications[${index}].confidence`, '사실 적용의 confidence가 올바르지 않습니다.');
            } else if (
                application.confidence === 'high'
                && Array.isArray(application.factIds)
                && application.factIds.some((factId) =>
                    factMap.get(factId)?.verification !== 'verified')
            ) {
                issue(issues, 'APPLICATION_CONFIDENCE_OVERSTATED', `$.applications[${index}].confidence`, '검증되지 않거나 다툼 있는 사실을 참조하면 high confidence를 사용할 수 없습니다.');
            }
        });
    }

    if (!isRecord(answer.temporalReview) || !isNonEmptyString(answer.temporalReview.summary)) {
        issue(issues, 'TEMPORAL_REVIEW_REQUIRED', '$.temporalReview', '소급 적용·경과조치 검토가 필요합니다.');
    } else if (!Array.isArray(answer.temporalReview.sourceIds)) {
        issue(issues, 'SOURCE_REFERENCE_REQUIRED', '$.temporalReview.sourceIds', '시점 검토 sourceId 목록이 필요합니다.');
    } else if (answer.temporalReview.sourceIds.length > 0) {
        validateSourceReferences(answer.temporalReview.sourceIds, '$.temporalReview.sourceIds', sourceMap, issues);
    }
    if (isRecord(answer.temporalReview)) {
        const temporalSourceIds = Array.isArray(answer.temporalReview.sourceIds)
            ? answer.temporalReview.sourceIds
            : [];
        validateEvidenceQuotes(
            answer.temporalReview.evidenceQuotes,
            '$.temporalReview.evidenceQuotes',
            temporalSourceIds,
            sourceMap,
            issues,
            { required: temporalSourceIds.length > 0, coverEverySource: true }
        );
    }
    if (!Array.isArray(answer.unknowns)) {
        issue(issues, 'UNKNOWNS_ARRAY_REQUIRED', '$.unknowns', '미확인 사항 목록이 필요합니다.');
    }
    if (!Array.isArray(answer.warnings)) {
        issue(issues, 'WARNINGS_ARRAY_REQUIRED', '$.warnings', '경고 목록이 필요합니다.');
    }
    if (answer.disclaimer !== LEGAL_DISCLAIMER) {
        issue(issues, 'DISCLAIMER_INVALID', '$.disclaimer', '고정 면책문구가 변경되었습니다.');
    }

    const historicalReviewRequired = isRecord(answer.temporalReview)
        && answer.temporalReview.historicalLawRequired === true;
    const historicalReviewActuallyRequired = answerEventDate !== null && sources.some((source) => {
        if (source.sourceType === 'case') return false;
        const controllingDate = source.sourceType === 'law'
            ? source.articleEffectiveFrom ?? source.effectiveFrom
            : source.articleEffectiveFrom ?? source.effectiveFrom;
        return isIsoDate(controllingDate) && answerEventDate < controllingDate;
    });
    if (
        isRecord(answer.temporalReview)
        && answer.temporalReview.historicalLawRequired !== historicalReviewActuallyRequired
    ) {
        issue(issues, 'TEMPORAL_REVIEW_MISMATCH', '$.temporalReview.historicalLawRequired', '사건일과 근거 시행일의 비교 결과가 일치하지 않습니다.');
    }
    if (isRecord(answer.conclusion) && blockingUnknown
        && answer.conclusion.kind !== 'cannot_conclude') {
        issue(
            issues,
            'BLOCKING_UNKNOWN_REQUIRES_CANNOT_CONCLUDE',
            '$.conclusion.kind',
            'blocking 미확인 사항이 있으면 cannot_conclude 결론만 사용할 수 있습니다.'
        );
    }
    if (
        isRecord(answer.conclusion)
        && blockingUnknown
        && answer.conclusion.kind === 'cannot_conclude'
        && (
            answer.conclusion.text !== LEGAL_BLOCKING_UNKNOWN_CONCLUSION_TEXT
            || !Array.isArray(answer.conclusion.sourceIds)
            || answer.conclusion.sourceIds.length !== 0
            || !Array.isArray(answer.conclusion.evidenceQuotes)
            || answer.conclusion.evidenceQuotes.length !== 0
        )
    ) {
        issue(
            issues,
            'BLOCKING_UNKNOWN_CONCLUSION_NOT_SERVER_FIXED',
            '$.conclusion',
            'blocking 미확인 사항이 있으면 서버 고정 유보 결론만 렌더링할 수 있습니다.'
        );
    }
    if (
        isRecord(answer.conclusion)
        && answer.conclusion.kind === 'supported'
        && (
            answer.status !== 'complete'
            || historicalReviewRequired
            || historicalReviewActuallyRequired
            || (Array.isArray(answer.applications) && answer.applications.some(
                (application) => !isRecord(application)
                    || application.temporalApplicability !== 'current_rule_applies'
            ))
        )
    ) {
        issue(issues, 'UNSUPPORTED_CONCLUSION', '$.conclusion.kind', '확정 조건을 충족하지 못하면 supported 결론을 만들 수 없습니다.');
    }

    if (packetInput !== undefined) {
        const packetResult = validateLegalResearchPacketV1(packetInput);
        if (!packetResult.ok || !packetResult.value) {
            packetResult.errors.forEach((packetIssue) =>
                issue(issues, 'PACKET_INVALID', `packet:${packetIssue.path}`, packetIssue.message));
        } else {
            const packet = packetResult.value;
            if (answer.packetId !== packet.packetId) {
                issue(issues, 'PACKET_ID_MISMATCH', '$.packetId', '답변과 근거 패킷의 packetId가 다릅니다.');
            }
            if (answer.status !== packet.status) {
                issue(issues, 'STATUS_MISMATCH', '$.status', '답변과 근거 패킷의 상태가 다릅니다.');
            }
            if (JSON.stringify(answer.unknowns) !== JSON.stringify(packet.unknowns)) {
                issue(issues, 'UNKNOWNS_PACKET_MISMATCH', '$.unknowns', '답변의 미확인 사항은 패킷과 정확히 일치해야 합니다.');
            }
            if (JSON.stringify(answer.scope) !== JSON.stringify(packet.scope)) {
                issue(issues, 'SCOPE_MISMATCH', '$.scope', '답변과 근거 패킷의 범위가 다릅니다.');
            }
            const answerSourceIds = sources.map((source) => source.sourceId);
            const packetSourceIds = sourceIdsFromPacket(packet);
            if (!sameStringSet(answerSourceIds, packetSourceIds)) {
                issue(issues, 'SOURCE_INDEX_PACKET_MISMATCH', '$.sourceIndex', '답변 출처 색인은 패킷 출처와 정확히 일치해야 합니다.');
            }
            const packetById = new Map(
                [...packet.laws, ...packet.ordinances, ...packet.cases]
                    .map((source) => [source.sourceId, source] as const)
            );
            sources.forEach((source, index) => {
                const packetSource = packetById.get(source.sourceId);
                if (
                    packetSource
                    && (
                        packetSource.sourceType !== source.sourceType
                        || packetSource.officialUrl !== source.officialUrl
                        || packetSource.exactTextHash !== source.exactTextHash
                    )
                ) {
                    issue(issues, 'SOURCE_INDEX_PACKET_MISMATCH', `$.sourceIndex[${index}]`, '패킷 출처의 식별 정보가 변경되었습니다.');
                }
            });
            const expectedCaseIds = packet.cases.map((legalCase) => legalCase.sourceId);
            const answerCaseIds = Array.isArray(answer.caseSynthesis?.sourceIds)
                ? answer.caseSynthesis.sourceIds
                : [];
            if (
                expectedCaseIds.length !== answerCaseIds.length
                || expectedCaseIds.some((sourceId, index) => answerCaseIds[index] !== sourceId)
            ) {
                issue(issues, 'CASE_SYNTHESIS_PACKET_MISMATCH', '$.caseSynthesis.sourceIds', '판례 순서는 패킷의 최신순 결과와 같아야 합니다.');
            }
            if (answer.caseSynthesis?.shortfallReason !== packet.caseSearchAudit.shortfallReason) {
                issue(issues, 'CASE_SHORTFALL_REASON_MISMATCH', '$.caseSynthesis.shortfallReason', '판례 부족 사유가 패킷과 다릅니다.');
            }
            if (answer.caseSynthesis?.upstreamComplete !== packet.caseSearchAudit.upstreamComplete) {
                issue(issues, 'CASE_UPSTREAM_COMPLETENESS_MISMATCH', '$.caseSynthesis.upstreamComplete', '판례 최신순 완결성은 패킷 검색 감사와 같아야 합니다.');
            }
            const expectedSearchScope = {
                normalizedPlanHash: packet.planCoverageAudit.normalizedPlanHash,
                lawNameQueries: packet.caseSearchAudit.lawNameQueries,
                issueQueries: packet.caseSearchAudit.issueQueries,
            };
            if (JSON.stringify(answer.caseSynthesis?.searchScope) !== JSON.stringify(expectedSearchScope)) {
                issue(issues, 'CASE_SEARCH_SCOPE_MISMATCH', '$.caseSynthesis.searchScope', '판례 최신성 검색 범위는 패킷의 감사된 stream과 같아야 합니다.');
            }
        }
    }

    return finish(answer, issues);
}

export function validateLegalAnswerMarkdownV1(markdown: unknown): LegalValidationResultV1<string> {
    const issues: LegalValidationIssueV1[] = [];
    if (typeof markdown !== 'string' || markdown.length === 0) {
        issue(issues, 'MARKDOWN_REQUIRED', '$', '답변 Markdown이 필요합니다.');
        return finish<string>(undefined, issues);
    }

    let previousIndex = -1;
    for (const heading of LEGAL_ANSWER_SECTION_HEADINGS) {
        const firstIndex = markdown.indexOf(heading);
        const lastIndex = markdown.lastIndexOf(heading);
        if (firstIndex === -1 || firstIndex !== lastIndex || firstIndex <= previousIndex) {
            issue(issues, 'ANSWER_SECTION_ORDER_INVALID', '$', `${heading} 섹션이 정확히 한 번, 고정 순서로 필요합니다.`);
        }
        previousIndex = firstIndex;
    }
    const renderedH2s = markdown.match(/^## .+$/gm) ?? [];
    if (
        renderedH2s.length !== LEGAL_ANSWER_SECTION_HEADINGS.length
        || renderedH2s.some((heading, index) => heading !== LEGAL_ANSWER_SECTION_HEADINGS[index])
    ) {
        issue(issues, 'ANSWER_SECTION_ORDER_INVALID', '$', '정의되지 않은 2단계 섹션을 추가하거나 생략할 수 없습니다.');
    }
    if (!markdown.includes(LEGAL_DISCLAIMER)) {
        issue(issues, 'DISCLAIMER_INVALID', '$', '고정 면책문구가 필요합니다.');
    }
    return finish(markdown, issues);
}

export function assertLegalResearchPacketV1(input: unknown): LegalResearchPacketV1 {
    const result = validateLegalResearchPacketV1(input);
    if (!result.ok || !result.value) throw new LegalContractValidationError(result.errors);
    return result.value;
}

export function assertLegalAnswerV1(input: unknown, packetInput?: unknown): LegalAnswerV1 {
    const result = validateLegalAnswerV1(input, packetInput);
    if (!result.ok || !result.value) throw new LegalContractValidationError(result.errors);
    return result.value;
}
