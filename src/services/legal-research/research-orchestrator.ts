import { createHash, randomUUID } from 'node:crypto';
import {
    compareCaseSerialIdDescendingV1,
    selectRelevantCasesV1,
} from './case-selector';
import {
    type LegalResearchClock,
    systemLegalResearchClock,
    toKoreanDate,
} from './clock';
import { LegalOpenApiError, isLegalOpenApiError } from './errors';
import { LawOpenApiClient } from './law-open-api-client';
import {
    LEGAL_POLICY_VERSION,
    LEGAL_RESEARCH_PACKET_VERSION,
    type CaseSourceV1,
    type LawSourceV1,
    type LegalResearchPacketV1,
    type LegalUnknownV1,
    type LocalAuthorityRefV1,
    type OrdinanceSourceV1,
    type SupplementalMaterialAuditV1,
} from './model';
import type {
    CaseDetail,
    CaseSummary,
    CurrentLawDetail,
    CurrentLawSummary,
    CurrentOrdinanceDetail,
    CurrentOrdinanceSummary,
    LawArticle,
    ProviderSearchPage,
    SearchCasesInput,
} from './provider-types';
import {
    buildLegalPlanCoverageAuditV1,
    type LegalResearchInputV1,
} from './research-plan';
import { assertLegalResearchPacketV1 } from './validator';

const MAX_CASE_QUERY_STREAMS = 24;
const CASE_LIST_PAGE_SIZE = 100;
const MAX_CASE_SEARCH_REQUESTS = 48;
const MAX_CASE_DETAIL_CANDIDATES = 120;
const CASE_DETAIL_BATCH_SIZE = 4;

export interface LegalResearchProviderV1 {
    searchCurrentLaws(input: {
        query: string;
        searchScope?: 1 | 2;
        page?: number;
    }, signal?: AbortSignal): Promise<ProviderSearchPage<CurrentLawSummary>>;
    getCurrentLawDetail(
        input:
            | { lawId: string; mst?: never; effectiveDate?: never }
            | { mst: string; effectiveDate: string; lawId?: never },
        signal?: AbortSignal
    ): Promise<CurrentLawDetail>;
    searchCurrentOrdinances(input: {
        query: string;
        org: string;
        sborg?: string;
        searchScope?: 1 | 2;
        page?: number;
    }, signal?: AbortSignal): Promise<ProviderSearchPage<CurrentOrdinanceSummary>>;
    getCurrentOrdinanceDetail(
        input:
            | { ordinanceId: string; mst?: never }
            | { mst: string; ordinanceId?: never },
        signal?: AbortSignal
    ): Promise<CurrentOrdinanceDetail>;
    searchCases(input: SearchCasesInput, signal?: AbortSignal): Promise<ProviderSearchPage<CaseSummary>>;
    getCaseDetail(input: { caseSerialId: string }, signal?: AbortSignal): Promise<CaseDetail>;
}

export interface LegalResearchOrchestratorOptionsV1 {
    provider?: LegalResearchProviderV1;
    clock?: LegalResearchClock;
    packetId?: () => string;
}

interface ResolvedLawAnchor {
    exactName: string;
    articleLabels: string[];
    issueTerms: string[];
    sources: LawSourceV1[];
}

interface CaseSearchStreamState {
    input: Omit<SearchCasesInput, 'page'>;
    nextPage: number;
    totalCount: number;
    fetchedCount: number;
    exhausted: boolean;
    /** API sort=ddes에서 다음 page가 넘을 수 없는 직전 page의 최저 선고일. */
    oldestFetchedDate: string | null;
    seenCaseSerialIds: Set<string>;
}

function hashText(value: string): string {
    const hash = createHash('sha256');
    hash.write(value, 'utf8');
    return hash.digest('hex');
}

function normalizeDate(value: string | undefined): string | null {
    if (!value) return null;
    const compact = value.replace(/[^0-9]/g, '');
    if (!/^\d{8}$/.test(compact)) return null;
    const normalized = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
    const parsed = new Date(`${normalized}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === normalized
        ? normalized
        : null;
}

function compactText(value: string): string {
    return value
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase('ko-KR');
}

function includesTerm(haystack: string, term: string): boolean {
    return compactText(haystack).includes(compactText(term));
}

function exactLegalToken(left: string | undefined, right: string): boolean {
    return typeof left === 'string' && compactText(left) === compactText(right);
}

function canonicalArticleLabel(value: string): string | null {
    const normalized = value.normalize('NFKC').replace(/\s+/g, '');
    const matched = /^(?:제)?0*(\d+)(?:조)?(?:의0*(\d+))?$/.exec(normalized);
    if (!matched) return null;
    const articleNumber = String(Number(matched[1]));
    const branchNumber = matched[2] === undefined ? null : String(Number(matched[2]));
    return branchNumber && branchNumber !== '0'
        ? `제${articleNumber}조의${branchNumber}`
        : `제${articleNumber}조`;
}

function extractArticleLabels(value: string): string[] {
    const normalized = value.normalize('NFKC');
    const labels: string[] = [];
    const pattern = /제\s*0*(\d+)\s*조(?:\s*의\s*0*(\d+))?/g;
    for (const matched of normalized.matchAll(pattern)) {
        const articleNumber = String(Number(matched[1]));
        const branchNumber = matched[2] === undefined ? null : String(Number(matched[2]));
        labels.push(
            branchNumber && branchNumber !== '0'
                ? `제${articleNumber}조의${branchNumber}`
                : `제${articleNumber}조`
        );
    }
    return unique(labels);
}

function referenceClauses(value: string): string[] {
    return value
        .normalize('NFKC')
        .split(/[\n;,，]+/)
        .map(compactText)
        .filter(Boolean);
}

/**
 * 참조조문의 같은 절 안에서 정확한 법령명과 정확한 조문 토큰을 함께 확인한다.
 * `제35조`는 `제35조의2`와 다르고, 본법 명칭은 `본법 시행령`과 다르다.
 */
function exactReferenceArticles(
    referenceProvisions: string,
    lawName: string
): string[] {
    const normalizedLawName = compactText(lawName);
    const matchedLabels: string[] = [];

    for (const clause of referenceClauses(referenceProvisions)) {
        let offset = 0;
        while (offset <= clause.length - normalizedLawName.length) {
            const index = clause.indexOf(normalizedLawName, offset);
            if (index < 0) break;
            offset = index + normalizedLawName.length;

            const prefix = clause.slice(0, index).trimEnd();
            const semanticPrefix = prefix.replace(/[「『(\[]+\s*$/, '').trimEnd();
            const previous = prefix.at(-1);
            const startsOnBoundary = previous === undefined
                || !/[0-9a-z가-힣]/i.test(previous);
            const isHistoricalQualifier = /(?:^|[\s(\[「『])(?:구|종전)(?:법)?(?:인|의)?[)\]」』]?\s*$/u
                .test(prefix)
                || /(?:^|\s)(?:구|종전)(?:법)?(?:인|의)?$/u.test(semanticPrefix)
                || /(?:^|\s)(?:(?:일부|전부)?개정(?:되기)?|폐지(?:되기)?)\s*(?:전|이전)(?:의)?$/u
                    .test(semanticPrefix);

            let suffix = clause.slice(index + normalizedLawName.length).trimStart();
            suffix = suffix.replace(/^[」』)\]]+\s*/, '');
            const endsOnBoundary = suffix === '' || /^제\s*\d+\s*조/u.test(suffix);
            if (!startsOnBoundary || isHistoricalQualifier || !endsOnBoundary) continue;

            matchedLabels.push(...extractArticleLabels(suffix));
        }
    }
    return unique(matchedLabels);
}

function unique<T>(items: readonly T[]): T[] {
    return [...new Set(items)];
}

function articleLabel(article: LawArticle): string {
    const rawNumber = article.articleNumber.normalize('NFKC').replace(/\s+/g, '').replace(/^0+/, '') || '0';
    const rawBranch = article.branchNumber
        ?.normalize('NFKC')
        .replace(/\s+/g, '')
        .replace(/^0+/, '');
    return rawBranch && rawBranch !== '0'
        ? `제${rawNumber}조의${rawBranch}`
        : `제${rawNumber}조`;
}

function articleText(article: LawArticle): string {
    const lines = [article.content];
    for (const paragraph of article.paragraphs) {
        lines.push([paragraph.number, paragraph.content].filter(Boolean).join(' '));
        for (const item of paragraph.items) {
            lines.push([item.number, item.content].filter(Boolean).join(' '));
            for (const subItem of item.subItems) {
                lines.push([subItem.number, subItem.content].filter(Boolean).join(' '));
            }
        }
    }
    return lines.filter(Boolean).join('\n').trim();
}

function supplementalMaterialAudit(
    detail: Pick<CurrentLawDetail, 'addenda' | 'appendices'>,
    selectedArticles: readonly LawArticle[],
    issueTerms: readonly string[]
): SupplementalMaterialAuditV1 {
    const selectors = unique([
        ...selectedArticles.map(articleLabel),
        ...issueTerms,
    ]).filter(Boolean);
    const addendaTexts = detail.addenda.map((addendum) => [
        addendum.promulgationDate,
        addendum.promulgationNo,
        addendum.content,
    ].filter(Boolean).join('\n'));
    const appendixTexts = detail.appendices.map((appendix) => [
        appendix.number,
        appendix.branchNumber,
        appendix.kind,
        appendix.title,
        appendix.content,
        appendix.effectiveDate,
    ].filter(Boolean).join('\n'));
    const matchedAddenda = addendaTexts.filter((text) =>
        selectors.some((selector) => includesTerm(text, selector)));
    const matchedAppendices = appendixTexts.filter((text) =>
        selectors.some((selector) => includesTerm(text, selector)));

    return {
        parsedAddendaCount: detail.addenda.length,
        parsedAppendixCount: detail.appendices.length,
        matchedAddendaCount: matchedAddenda.length,
        matchedAppendixCount: matchedAppendices.length,
        matchedTextHash: hashText([...matchedAddenda, ...matchedAppendices].join('\n')),
        // 코드가 수행한 것은 키워드 선별뿐이며 경과조치·별표의 법적 의미를 단정하지 않는다.
        interpretationStatus: 'keyword_screened_not_legally_interpreted',
    };
}

function selectArticles(
    articles: readonly LawArticle[],
    requestedLabels: readonly string[],
    issueTerms: readonly string[]
): LawArticle[] {
    const realArticles = articles.filter((article) => article.isArticle && article.articleNumber);
    const hasIssueTerm = (article: LawArticle): boolean => {
        const searchable = `${article.title ?? ''}\n${articleText(article)}`;
        return issueTerms.some((term) => includesTerm(searchable, term));
    };
    if (requestedLabels.length > 0) {
        const requested = new Set(
            requestedLabels
                .map(canonicalArticleLabel)
                .filter((label): label is string => label !== null)
        );
        return realArticles.filter((article) =>
            requested.has(articleLabel(article)) && hasIssueTerm(article));
    }
    return realArticles
        .filter(hasIssueTerm)
        .slice(0, 12);
}

function lawPublicUrl(mst: string): string {
    return `https://www.law.go.kr/lsInfoP.do?lsiSeq=${encodeURIComponent(mst)}`;
}

function ordinancePublicUrl(mst: string): string {
    return `https://www.law.go.kr/ordinInfoP.do?ordinSeq=${encodeURIComponent(mst)}`;
}

function casePublicUrl(caseSerialId: string): string {
    return `https://www.law.go.kr/precInfoP.do?precSeq=${encodeURIComponent(caseSerialId)}`;
}

function compareProviderCases(left: CaseSummary, right: CaseSummary): number {
    const leftDate = normalizeDate(left.decisionDate) ?? '';
    const rightDate = normalizeDate(right.decisionDate) ?? '';
    if (leftDate !== rightDate) return leftDate > rightDate ? -1 : 1;
    return compareCaseSerialIdDescendingV1(left.caseSerialId, right.caseSerialId);
}

function assertCasePageOrder(
    page: ProviderSearchPage<CaseSummary>,
    requestedPage: number,
    asOfDate: string,
    previousOldestDate: string | null = null
): void {
    if (page.page !== requestedPage || page.items.length > CASE_LIST_PAGE_SIZE) {
        throw new LegalOpenApiError('SCHEMA_DRIFT');
    }
    if (new Set(page.items.map((item) => item.caseSerialId)).size !== page.items.length) {
        throw new LegalOpenApiError('SCHEMA_DRIFT');
    }
    const dates = page.items.map((item) => normalizeDate(item.decisionDate));
    if (dates.some((date) => date !== null && date > asOfDate)) {
        // 조회 기준일 뒤의 선고일은 현재 시점의 판례 목록으로 신뢰할 수 없다.
        throw new LegalOpenApiError('SCHEMA_DRIFT');
    }
    for (let index = 1; index < dates.length; index += 1) {
        const previous = dates[index - 1];
        const current = dates[index];
        if (previous !== null && current !== null && previous < current) {
            throw new LegalOpenApiError('SCHEMA_DRIFT');
        }
    }
    const firstDate = dates[0] ?? null;
    if (
        previousOldestDate !== null
        && firstDate !== null
        && firstDate > previousOldestDate
    ) {
        throw new LegalOpenApiError('SCHEMA_DRIFT');
    }
}

function identityMatches(summary: CaseSummary, detail: CaseDetail): boolean {
    return detail.caseSerialId === summary.caseSerialId
        && Boolean(summary.caseNumber && detail.caseNumber && summary.caseNumber === detail.caseNumber)
        && Boolean(
            normalizeDate(summary.decisionDate)
            && normalizeDate(summary.decisionDate) === normalizeDate(detail.decisionDate)
        )
        && Boolean(summary.courtName && detail.courtName && summary.courtName === detail.courtName);
}

function mapLocalAuthorities(input: LegalResearchInputV1): LocalAuthorityRefV1[] {
    if (!input.jurisdiction) return [];
    const authorities: LocalAuthorityRefV1[] = [];
    if (input.jurisdiction.organizationCode && input.jurisdiction.organizationName) {
        authorities.push({
            code: input.jurisdiction.organizationCode,
            name: input.jurisdiction.organizationName,
            level: 'metropolitan',
        });
    }
    if (input.jurisdiction.subOrganizationCode && input.jurisdiction.subOrganizationName) {
        authorities.push({
            code: input.jurisdiction.subOrganizationCode,
            name: input.jurisdiction.subOrganizationName,
            level: 'basic',
        });
    }
    return authorities;
}

function sourceIdPart(value: string): string {
    return value.replace(/[^0-9A-Za-z가-힣]/g, '-').replace(/-+/g, '-');
}

function addUnknown(
    unknowns: LegalUnknownV1[],
    value: LegalUnknownV1
): void {
    if (!unknowns.some((item) => item.code === value.code && item.text === value.text)) {
        unknowns.push(value);
    }
}

export class LegalResearchOrchestratorV1 {
    private readonly provider: LegalResearchProviderV1;
    private readonly clock: LegalResearchClock;
    private readonly packetId: () => string;

    constructor(options: LegalResearchOrchestratorOptionsV1 = {}) {
        this.provider = options.provider ?? new LawOpenApiClient();
        this.clock = options.clock ?? systemLegalResearchClock;
        this.packetId = options.packetId ?? randomUUID;
    }

    async research(
        input: LegalResearchInputV1,
        signal?: AbortSignal
    ): Promise<LegalResearchPacketV1> {
        const now = this.clock.now();
        const generatedAt = now.toISOString();
        const asOfDate = toKoreanDate(now);
        const unknowns: LegalUnknownV1[] = [];
        const resolvedLawAnchors: ResolvedLawAnchor[] = [];
        const laws: LawSourceV1[] = [];
        const ordinances: OrdinanceSourceV1[] = [];

        const ordinanceRequired = input.researchPlan.ordinanceRequirement === 'required';
        const localAuthorities = mapLocalAuthorities(input);
        if (ordinanceRequired && localAuthorities.length === 0) {
            addUnknown(unknowns, {
                code: 'JURISDICTION_REQUIRED',
                text: '관할 자치법규 검토가 필요하지만 시·도 또는 시·군·구 관할이 확인되지 않았습니다.',
                impact: '관할을 확인하기 전에는 적용 조례·규칙을 검색하거나 결론에 반영할 수 없습니다.',
                blocking: true,
            });
        }

        for (const anchor of input.researchPlan.lawAnchors) {
            signal?.throwIfAborted();
            const resolved = await this.resolveLawAnchor(
                anchor, asOfDate, generatedAt, unknowns, signal
            );
            if (!resolved) continue;
            resolvedLawAnchors.push(resolved);
            laws.push(...resolved.sources);
        }

        for (const anchor of input.researchPlan.ordinanceAnchors) {
            signal?.throwIfAborted();
            ordinances.push(
                ...await this.resolveOrdinanceAnchor(
                    anchor, asOfDate, generatedAt, unknowns, signal
                )
            );
        }

        const caseResult = await this.researchCases(
            input,
            resolvedLawAnchors,
            generatedAt,
            asOfDate,
            signal
        );

        const eventDateRequired = input.facts.length > 0;
        if (eventDateRequired && !input.eventDate) {
            addUnknown(unknowns, {
                code: 'EVENT_DATE_REQUIRED',
                text: '구체적 사실에 현행 규정을 적용하려면 처분·의결·동의 등 사건일이 필요합니다.',
                impact: '적용 법령의 시점과 소급 적용 여부를 확정할 수 없습니다.',
                blocking: true,
            });
        }

        if (input.eventDate) {
            if (input.eventDate > asOfDate) {
                addUnknown(unknowns, {
                    code: 'FUTURE_EVENT_DATE',
                    text: '사건일이 현재 조회 기준일보다 뒤입니다.',
                    impact: '현재 시행 중인 규정이 미래 사건일까지 유지된다고 보증할 수 없습니다.',
                    blocking: true,
                });
            }
            const historicalLawRequired = [...laws, ...ordinances].some((source) => {
                const controllingDate = source.articleEffectiveFrom ?? source.effectiveFrom;
                return input.eventDate! < controllingDate;
            });
            if (historicalLawRequired) {
                addUnknown(unknowns, {
                    code: 'HISTORICAL_LAW_REQUIRED',
                    text: '사건일이 확인된 현행 조문의 시행일보다 앞섭니다.',
                    impact: '이 도구는 현행법 전용이므로 당시 시행본과 경과조치를 별도로 검토해야 합니다.',
                    blocking: true,
                });
            }
        }

        const blockingCodes = new Set(unknowns.filter((item) => item.blocking).map((item) => item.code));
        let status: LegalResearchPacketV1['status'] = 'complete';
        if (
            blockingCodes.has('EVENT_DATE_REQUIRED')
            || blockingCodes.has('JURISDICTION_REQUIRED')
        ) status = 'clarification_required';
        else if (
            blockingCodes.has('HISTORICAL_LAW_REQUIRED')
            || blockingCodes.has('FUTURE_EVENT_DATE')
        ) status = 'temporal_scope_conflict';
        else if (blockingCodes.size > 0 || laws.length === 0) status = 'insufficient_evidence';
        else if (!caseResult.audit.upstreamComplete) status = 'partial';

        const allLawAnchorsResolved = resolvedLawAnchors.length === input.researchPlan.lawAnchors.length;
        const packet: LegalResearchPacketV1 = {
            contractVersion: LEGAL_RESEARCH_PACKET_VERSION,
            packetId: this.packetId(),
            question: input.question,
            status,
            scope: {
                countryCode: 'KR',
                asOfDate,
                eventDate: input.eventDate ?? null,
                eventDateRequired,
                localAuthorities,
                lawVersionPolicy: 'effective_current_only',
                projectType: input.projectType,
                projectStage: input.projectStage,
            },
            facts: input.facts.map((fact) => ({
                factId: fact.factId,
                text: fact.text,
                origin: 'user',
                verification: 'unverified',
            })),
            laws: this.uniqueSources(laws),
            ordinances: this.uniqueSources(ordinances),
            cases: caseResult.cases,
            lawSearchAudit: {
                target: 'eflaw',
                currentOnlyNw: 3,
                exactLawNameMatched: allLawAnchorsResolved,
                exactLawTypeMatched: allLawAnchorsResolved,
            },
            ordinanceSearchAudit: {
                required: ordinanceRequired,
                performed: input.researchPlan.ordinanceAnchors.length > 0,
                target: 'ordin',
                currentOnlyNw: 1,
            },
            planCoverageAudit: buildLegalPlanCoverageAuditV1(
                input.question,
                input.researchPlan
            ),
            caseSearchAudit: caseResult.audit,
            unknowns,
            provenance: {
                provider: 'KOREA_LAW_OPEN_API',
                policyVersion: LEGAL_POLICY_VERSION,
                generatedAt,
            },
        };

        return assertLegalResearchPacketV1(packet);
    }

    private uniqueSources<T extends { sourceId: string }>(sources: T[]): T[] {
        return [...new Map(sources.map((source) => [source.sourceId, source])).values()];
    }

    private async resolveLawAnchor(
        anchor: LegalResearchInputV1['researchPlan']['lawAnchors'][number],
        asOfDate: string,
        retrievedAt: string,
        unknowns: LegalUnknownV1[],
        signal?: AbortSignal
    ): Promise<ResolvedLawAnchor | null> {
        const result = await this.provider.searchCurrentLaws({
            query: anchor.exactName,
            searchScope: 1,
            page: 1,
        }, signal);
        const matches = result.items
            .filter((item) =>
                exactLegalToken(item.name, anchor.exactName)
                && exactLegalToken(item.lawType, anchor.lawType))
            .filter((item) => {
                const date = normalizeDate(item.effectiveDate);
                return date !== null && date <= asOfDate;
            })
            .sort((left, right) =>
                (normalizeDate(right.effectiveDate) ?? '').localeCompare(
                    normalizeDate(left.effectiveDate) ?? ''
                ));
        const summary = matches[0];
        if (!summary) {
            addUnknown(unknowns, {
                code: 'LAW_NOT_FOUND',
                text: `현행 법령명과 법종을 정확히 확인하지 못했습니다: ${anchor.exactName} (${anchor.lawType})`,
                impact: '해당 법령을 결론 근거로 사용할 수 없습니다.',
                blocking: true,
            });
            return null;
        }

        const effectiveDate = normalizeDate(summary.effectiveDate);
        if (!effectiveDate) throw new LegalOpenApiError('SCHEMA_DRIFT');
        // 법제처의 현행법령 상세(target=eflaw) 응답은 검색 목록의 MST를
        // 본문 기본정보에 되돌려주지 않는 경우가 있다. 검색 결과와 상세에
        // 공통으로 존재하는 법령ID로 조회·검증하고, MST는 검색 결과의 공식
        // 버전 링크 식별자로 보존한다.
        const detail = await this.provider.getCurrentLawDetail({
            lawId: summary.lawId,
        }, signal);
        if (
            !exactLegalToken(detail.name, anchor.exactName)
            || !exactLegalToken(detail.lawType, anchor.lawType)
            || (detail.lawId !== undefined && detail.lawId !== summary.lawId)
            || (detail.mst !== undefined && detail.mst !== summary.mst)
            || normalizeDate(detail.effectiveDate) !== effectiveDate
        ) {
            throw new LegalOpenApiError('SOURCE_MISMATCH');
        }

        const selected = selectArticles(detail.articles, anchor.articleLabels, anchor.issueTerms);
        if (selected.length === 0) {
            addUnknown(unknowns, {
                code: 'LAW_PROVISION_NOT_FOUND',
                text: `현행 본문에서 지정 조문 또는 쟁점어를 확인하지 못했습니다: ${anchor.exactName}`,
                impact: '조문 원문이 없어 결론을 만들 수 없습니다.',
                blocking: true,
            });
            // 법령명·법종 exact match 감사와 조문 근거 부재를 구분한다.
            return {
                exactName: anchor.exactName,
                articleLabels: [],
                issueTerms: anchor.issueTerms,
                sources: [],
            };
        }

        const supplementalAudit = supplementalMaterialAudit(
            detail,
            selected,
            anchor.issueTerms
        );
        if (
            supplementalAudit.matchedAddendaCount > 0
            || supplementalAudit.matchedAppendixCount > 0
        ) {
            addUnknown(unknowns, {
                code: 'SUPPLEMENTAL_MATERIAL_REVIEW_REQUIRED',
                text: `쟁점 조문 또는 검색어와 일치하는 부칙·별표가 있습니다: ${anchor.exactName}`,
                impact: '자동 키워드 선별은 경과조치·별표의 법률 해석을 보증하지 않으므로 공식 원문을 별도로 검토해야 합니다.',
                blocking: true,
            });
        }

        const sources: LawSourceV1[] = [];
        for (const article of selected) {
            const label = articleLabel(article);
            const exactText = articleText(article);
            const articleDate = normalizeDate(article.effectiveDate) ?? undefined;
            const controllingDate = articleDate ?? normalizeDate(detail.effectiveDate) ?? effectiveDate;
            if (controllingDate > asOfDate) {
                addUnknown(unknowns, {
                    code: 'FUTURE_VERSION_REJECTED',
                    text: `기준일 이후 시행 조문은 제외했습니다: ${anchor.exactName} ${label}`,
                    impact: '시행예정 조문은 현재 결론 근거가 될 수 없습니다.',
                    blocking: true,
                });
                continue;
            }
            sources.push({
                sourceId: `LAW-${sourceIdPart(summary.lawId)}-${sourceIdPart(label)}`,
                sourceType: 'law',
                official: true,
                title: anchor.exactName,
                officialUrl: lawPublicUrl(summary.mst),
                retrievedAt,
                verificationStatus: 'verified',
                exactTextHash: hashText(exactText),
                lawId: summary.lawId,
                mst: summary.mst,
                lawType: anchor.lawType,
                promulgationNo: detail.promulgationNo ?? summary.promulgationNo,
                promulgatedOn: normalizeDate(detail.promulgationDate ?? summary.promulgationDate) ?? undefined,
                effectiveFrom: normalizeDate(detail.effectiveDate) ?? effectiveDate,
                articleEffectiveFrom: articleDate,
                versionStatus: 'current',
                appliesAsOf: true,
                provision: { article: label },
                exactText,
                supplementalMaterialAudit: supplementalAudit,
            });
        }

        return {
            exactName: anchor.exactName,
            articleLabels: selected.map(articleLabel),
            issueTerms: anchor.issueTerms,
            sources,
        };
    }

    private async resolveOrdinanceAnchor(
        anchor: LegalResearchInputV1['researchPlan']['ordinanceAnchors'][number],
        asOfDate: string,
        retrievedAt: string,
        unknowns: LegalUnknownV1[],
        signal?: AbortSignal
    ): Promise<OrdinanceSourceV1[]> {
        const expectedAuthorityName = anchor.subOrganizationName ?? anchor.organizationName;
        const expectedAuthorityCode = anchor.subOrganizationCode ?? anchor.organizationCode;
        const result = await this.provider.searchCurrentOrdinances({
            query: anchor.exactName,
            org: anchor.organizationCode,
            sborg: anchor.subOrganizationCode,
            searchScope: 1,
            page: 1,
        }, signal);
        const matches = result.items
            .filter((item) => exactLegalToken(item.name, anchor.exactName))
            .filter((item) => exactLegalToken(item.authorityName, expectedAuthorityName))
            .filter((item) => {
                const date = normalizeDate(item.effectiveDate);
                return date !== null && date <= asOfDate;
            })
            .sort((left, right) =>
                (normalizeDate(right.effectiveDate) ?? '').localeCompare(
                    normalizeDate(left.effectiveDate) ?? ''
                ));
        const summary = matches[0];
        if (!summary) {
            addUnknown(unknowns, {
                code: 'ORDINANCE_NOT_FOUND',
                text: `요청 관할의 현행 자치법규를 정확히 확인하지 못했습니다: ${anchor.exactName}`,
                impact: '필수 자치법규를 확인하지 못했으므로 공식 명칭·관할을 재확인하기 전에는 결론을 만들 수 없습니다.',
                blocking: true,
            });
            return [];
        }

        const detail = await this.provider.getCurrentOrdinanceDetail(
            { mst: summary.mst },
            signal
        );
        if (
            !exactLegalToken(detail.name, anchor.exactName)
            || !exactLegalToken(detail.authorityName, expectedAuthorityName)
            || (detail.mst !== undefined && detail.mst !== summary.mst)
            || (detail.ordinanceId !== undefined && detail.ordinanceId !== summary.ordinanceId)
        ) {
            throw new LegalOpenApiError('SOURCE_MISMATCH');
        }

        const effectiveDate = normalizeDate(detail.effectiveDate ?? summary.effectiveDate);
        if (!effectiveDate || effectiveDate > asOfDate) {
            addUnknown(unknowns, {
                code: 'CURRENT_ORDINANCE_REQUIRED',
                text: `현행 시행일을 검증하지 못한 자치법규를 제외했습니다: ${anchor.exactName}`,
                impact: '시행 중인 자치법규만 결론 근거로 사용할 수 있습니다.',
                blocking: true,
            });
            return [];
        }

        const selected = selectArticles(detail.articles, anchor.articleLabels, anchor.issueTerms);
        if (selected.length === 0) {
            addUnknown(unknowns, {
                code: 'ORDINANCE_PROVISION_NOT_FOUND',
                text: `자치법규에서 지정 조문 또는 쟁점어를 확인하지 못했습니다: ${anchor.exactName}`,
                impact: '자치법규 원문이 없어 결론을 만들 수 없습니다.',
                blocking: true,
            });
            return [];
        }

        const supplementalAudit = supplementalMaterialAudit(
            detail,
            selected,
            anchor.issueTerms
        );
        if (
            supplementalAudit.matchedAddendaCount > 0
            || supplementalAudit.matchedAppendixCount > 0
        ) {
            addUnknown(unknowns, {
                code: 'SUPPLEMENTAL_MATERIAL_REVIEW_REQUIRED',
                text: `쟁점 조문 또는 검색어와 일치하는 부칙·별표가 있습니다: ${anchor.exactName}`,
                impact: '자동 키워드 선별은 경과조치·별표의 법률 해석을 보증하지 않으므로 공식 원문을 별도로 검토해야 합니다.',
                blocking: true,
            });
        }

        const sources: OrdinanceSourceV1[] = [];
        for (const article of selected) {
            const label = articleLabel(article);
            const exactText = articleText(article);
            const articleDate = normalizeDate(article.effectiveDate) ?? undefined;
            const controllingDate = articleDate ?? effectiveDate;
            if (controllingDate > asOfDate) {
                addUnknown(unknowns, {
                    code: 'FUTURE_ORDINANCE_VERSION_REJECTED',
                    text: `기준일 이후 시행 조문은 제외했습니다: ${anchor.exactName} ${label}`,
                    impact: '시행예정 자치법규 조문은 현재 결론 근거가 될 수 없습니다.',
                    blocking: true,
                });
                continue;
            }
            sources.push({
                sourceId: `ORD-${sourceIdPart(summary.ordinanceId)}-${sourceIdPart(label)}`,
                sourceType: 'ordinance',
                official: true,
                title: anchor.exactName,
                officialUrl: ordinancePublicUrl(summary.mst),
                retrievedAt,
                verificationStatus: 'verified',
                exactTextHash: hashText(exactText),
                ordinanceId: summary.ordinanceId,
                mst: summary.mst,
                ordinanceType: detail.ordinanceType ?? summary.ordinanceType ?? '자치법규',
                localAuthority: {
                    code: expectedAuthorityCode,
                    name: expectedAuthorityName,
                    level: anchor.subOrganizationCode ? 'basic' : 'metropolitan',
                },
                jurisdictionMatch: 'exact',
                promulgationNo: detail.promulgationNo ?? summary.promulgationNo,
                promulgatedOn: normalizeDate(detail.promulgationDate ?? summary.promulgationDate) ?? undefined,
                effectiveFrom: effectiveDate,
                articleEffectiveFrom: articleDate,
                versionStatus: 'current',
                appliesAsOf: true,
                provision: { article: label },
                exactText,
                supplementalMaterialAudit: supplementalAudit,
            });
        }
        return sources;
    }

    private async researchCases(
        input: LegalResearchInputV1,
        resolvedLaws: ResolvedLawAnchor[],
        retrievedAt: string,
        asOfDate: string,
        signal?: AbortSignal
    ) {
        const lawNameQueries = unique(
            input.researchPlan.caseQueries.flatMap((query) => query.lawNames)
        );
        const issueQueries = unique(
            input.researchPlan.caseQueries.flatMap((query) => query.issueTerms)
        );
        // 현행 법령 조문이 하나도 확정되지 않으면 판례의 현행 규정 정합성을
        // 검증할 수 없으므로 최대 120건의 상세 fanout을 시작하지 않는다.
        if (resolvedLaws.every((law) => law.sources.length === 0)) {
            return selectRelevantCasesV1([], {
                upstreamComplete: false,
                lawNameQueries,
                issueQueries,
            });
        }
        const streams: Array<Omit<SearchCasesInput, 'page'>> = [
            ...lawNameQueries.map((referenceLawName) => ({ referenceLawName })),
            ...issueQueries.map((query) => ({ query, searchScope: 2 as const })),
        ];
        if (streams.length > MAX_CASE_QUERY_STREAMS) {
            throw new LegalOpenApiError('INVALID_REQUEST');
        }

        const pages: Array<ProviderSearchPage<CaseSummary>> = [];
        const streamStates: CaseSearchStreamState[] = [];
        let searchRequestCount = 0;
        let searchIncomplete = false;
        for (const stream of streams) {
            signal?.throwIfAborted();
            const page = await this.provider.searchCases({ ...stream, page: 1 }, signal);
            assertCasePageOrder(page, 1, asOfDate);
            searchRequestCount += 1;
            pages.push(page);
            streamStates.push({
                input: stream,
                nextPage: 2,
                totalCount: page.totalCount,
                fetchedCount: page.items.length,
                exhausted: page.items.length >= page.totalCount,
                oldestFetchedDate: normalizeDate(page.items.at(-1)?.decisionDate),
                seenCaseSerialIds: new Set(page.items.map((item) => item.caseSerialId)),
            });
        }

        const orderedSummaries = (): CaseSummary[] => {
            const uniqueSummaries = new Map<string, CaseSummary>();
            for (const summary of pages.flatMap((page) => page.items).sort(compareProviderCases)) {
                if (!uniqueSummaries.has(summary.caseSerialId)) {
                    uniqueSummaries.set(summary.caseSerialId, summary);
                }
            }
            return [...uniqueSummaries.values()].sort(compareProviderCases);
        };

        const fetchNextPages = async (
            shouldFetch: (state: CaseSearchStreamState) => boolean = () => true
        ): Promise<boolean> => {
            let fetchedAny = false;
            for (const state of streamStates) {
                if (state.exhausted || !shouldFetch(state)) continue;
                if (searchRequestCount >= MAX_CASE_SEARCH_REQUESTS) {
                    searchIncomplete = true;
                    break;
                }

                try {
                    signal?.throwIfAborted();
                    const requestedPage = state.nextPage;
                    const page = await this.provider.searchCases({
                        ...state.input,
                        page: requestedPage,
                    }, signal);
                    assertCasePageOrder(
                        page,
                        requestedPage,
                        asOfDate,
                        state.oldestFetchedDate
                    );
                    if (page.items.some((item) =>
                        state.seenCaseSerialIds.has(item.caseSerialId))) {
                        throw new LegalOpenApiError('SCHEMA_DRIFT');
                    }
                    searchRequestCount += 1;
                    state.nextPage += 1;
                    state.totalCount = Math.max(state.totalCount, page.totalCount);
                    state.fetchedCount += page.items.length;
                    state.oldestFetchedDate = normalizeDate(
                        page.items.at(-1)?.decisionDate
                    ) ?? state.oldestFetchedDate;
                    page.items.forEach((item) =>
                        state.seenCaseSerialIds.add(item.caseSerialId));
                    pages.push(page);
                    fetchedAny ||= page.items.length > 0;

                    if (page.items.length === 0 && state.fetchedCount < state.totalCount) {
                        searchIncomplete = true;
                        state.exhausted = true;
                    } else {
                        state.exhausted = state.fetchedCount >= state.totalCount;
                    }
                } catch (error) {
                    signal?.throwIfAborted();
                    // 인증·schema·식별자 오류는 상류 전체 신뢰를 잃으므로 정상 partial로 숨기지 않는다.
                    if (!isLegalOpenApiError(error) || !error.retryable) throw error;
                    // provider 429 뒤 다른 stream을 계속 호출해 fanout을 증폭하지 않는다.
                    if (error.code === 'RATE_LIMITED') throw error;
                    // timeout/rate limit 같은 일시 실패만 이미 검증한 결과와 분리해 감사한다.
                    searchRequestCount += 1;
                    searchIncomplete = true;
                    state.exhausted = true;
                }
            }
            return fetchedAny;
        };

        const candidates: CaseSourceV1[] = [];
        const processedSerialIds = new Set<string>();
        let detailFailureCount = 0;
        let detailLimitReached = false;
        let stopAfterLatestTen = false;
        let latestTenProven = false;

        while (!stopAfterLatestTen) {
            const summaries = orderedSummaries();
            const pending = summaries.filter(
                (summary) => !processedSerialIds.has(summary.caseSerialId)
            );

            if (pending.length === 0) {
                if (streamStates.every((state) => state.exhausted)) break;
                const fetchedAny = await fetchNextPages();
                if (!fetchedAny) break;
                continue;
            }

            const remainingDetailBudget = MAX_CASE_DETAIL_CANDIDATES - processedSerialIds.size;
            if (remainingDetailBudget <= 0) {
                detailLimitReached = true;
                break;
            }

            const batch = pending.slice(
                0,
                Math.min(CASE_DETAIL_BATCH_SIZE, remainingDetailBudget)
            );
            const batchResults = await Promise.allSettled(
                batch.map(async (summary) => this.toCaseSource(
                    summary,
                    await this.provider.getCaseDetail(
                        { caseSerialId: summary.caseSerialId },
                        signal
                    ),
                    input,
                    resolvedLaws,
                    retrievedAt,
                    asOfDate
                ))
            );
            signal?.throwIfAborted();

            batch.forEach((summary, index) => {
                processedSerialIds.add(summary.caseSerialId);
                const result = batchResults[index];
                if (result.status === 'fulfilled') {
                    candidates.push(result.value);
                } else {
                    const caseDetailUnavailable = isLegalOpenApiError(result.reason)
                        && result.reason.code === 'CASE_DETAIL_NOT_FOUND';
                    if (
                        !isLegalOpenApiError(result.reason)
                        || (!result.reason.retryable && !caseDetailUnavailable)
                    ) {
                        throw result.reason;
                    }
                    if (result.reason.code === 'RATE_LIMITED') throw result.reason;
                    detailFailureCount += 1;
                    candidates.push(this.toUnavailableCaseSource(summary, retrievedAt));
                }
            });

            const selected = selectRelevantCasesV1(candidates, {
                upstreamComplete: false,
                lawNameQueries,
                issueQueries,
            }).cases;
            if (selected.length === 10) {
                const boundary = selected[selected.length - 1];
                const nextSummary = orderedSummaries().find(
                    (summary) => !processedSerialIds.has(summary.caseSerialId)
                );
                if (
                    !nextSummary
                    || compareProviderCases(nextSummary, {
                        caseSerialId: boundary.caseSerialId,
                        caseName: boundary.caseName,
                        decisionDate: boundary.decisionDate,
                    }) > 0
                ) {
                    const hiddenNewerPossible = streamStates.some((state) =>
                        !state.exhausted
                        && (
                            state.oldestFetchedDate === null
                            || state.oldestFetchedDate >= boundary.decisionDate
                        ));
                    if (hiddenNewerPossible) {
                        const fetchedAny = await fetchNextPages((state) =>
                            !state.exhausted
                            && (
                                state.oldestFetchedDate === null
                                || state.oldestFetchedDate >= boundary.decisionDate
                            ));
                        if (!fetchedAny) stopAfterLatestTen = true;
                    } else {
                        latestTenProven = true;
                        stopAfterLatestTen = true;
                    }
                }
            }
        }

        const allFetchedProcessed = orderedSummaries().every(
            (summary) => processedSerialIds.has(summary.caseSerialId)
        );
        const officialExhausted = streamStates.every((state) =>
            state.exhausted && state.fetchedCount >= state.totalCount)
            && allFetchedProcessed
            && !searchIncomplete
            && !detailLimitReached
            && detailFailureCount === 0;
        const preliminary = selectRelevantCasesV1(candidates, {
            upstreamComplete: false,
            lawNameQueries,
            issueQueries,
        });
        const enoughToProveLatestTen = latestTenProven
            && preliminary.cases.length === 10
            && detailFailureCount === 0
            && !searchIncomplete;
        return selectRelevantCasesV1(candidates, {
            upstreamComplete: officialExhausted || enoughToProveLatestTen,
            lawNameQueries,
            issueQueries,
        });
    }

    private toUnavailableCaseSource(
        summary: CaseSummary,
        retrievedAt: string
    ): CaseSourceV1 {
        return {
            sourceId: `CASE-${sourceIdPart(summary.caseSerialId)}`,
            sourceType: 'case',
            official: true,
            title: summary.caseName,
            officialUrl: casePublicUrl(summary.caseSerialId),
            retrievedAt,
            verificationStatus: 'unverified',
            exactTextHash: hashText(''),
            caseSerialId: summary.caseSerialId,
            caseName: summary.caseName,
            caseNumber: summary.caseNumber ?? '',
            court: summary.courtName ?? '',
            decisionDate: normalizeDate(summary.decisionDate) ?? '',
            disposition: summary.decision,
            holding: '',
            reasoningSummary: '',
            referencedProvisions: [],
            fullTextVerified: false,
            listingIdentityVerified: false,
            relevance: {
                grade: 'unrelated',
                matchedIssues: [],
                matchedProvisions: [],
                reason: '판례 전문 조회 실패로 관련성과 현행 규정 정합성을 검증하지 못했습니다.',
            },
            currentLawFit: 'unknown',
            useInConclusion: 'excluded',
        };
    }

    private toCaseSource(
        summary: CaseSummary,
        detail: CaseDetail,
        input: LegalResearchInputV1,
        resolvedLaws: ResolvedLawAnchor[],
        retrievedAt: string,
        asOfDate: string
    ): CaseSourceV1 {
        const identityVerified = identityMatches(summary, detail);
        const decisionDate = normalizeDate(detail.decisionDate ?? summary.decisionDate) ?? '';
        if (decisionDate && decisionDate > asOfDate) {
            throw new LegalOpenApiError('SCHEMA_DRIFT');
        }
        const holdings = detail.holdings?.trim() ?? '';
        const reasoning = detail.summary?.trim() || detail.fullText?.trim().slice(0, 2000) || '';
        const searchable = [detail.holdings, detail.summary, detail.fullText]
            .filter(Boolean)
            .join('\n');
        const referenced = detail.referenceProvisions?.trim() ?? '';

        let matchedIssueIds: string[] = [];
        let matchedProvisions: string[] = [];
        let controllingDates: string[] = [];
        for (const query of input.researchPlan.caseQueries) {
            const matchedTerms = query.issueTerms.filter((term) => includesTerm(searchable, term));
            if (matchedTerms.length === 0) continue;

            const requestedArticles = new Set(
                query.articleLabels
                    .map(canonicalArticleLabel)
                    .filter((label): label is string => label !== null)
            );
            const sourcePool: LawSourceV1[] = [];
            for (const lawName of query.lawNames) {
                const resolved = resolvedLaws.find((law) =>
                    exactLegalToken(law.exactName, lawName));
                if (!resolved) continue;

                const referencedArticles = new Set(
                    exactReferenceArticles(referenced, lawName)
                );
                if (referencedArticles.size === 0) continue;

                sourcePool.push(...resolved.sources.filter((source) =>
                    referencedArticles.has(source.provision.article)
                    && (
                        requestedArticles.size === 0
                        || requestedArticles.has(source.provision.article)
                    )));
            }
            if (sourcePool.length === 0) continue;

            matchedIssueIds = unique([...matchedIssueIds, ...query.issueIds]);
            matchedProvisions = unique([
                ...matchedProvisions,
                ...sourcePool.map((source) => `${source.title} ${source.provision.article}`),
            ]);
            controllingDates = unique([
                ...controllingDates,
                ...sourcePool.map((source) => source.articleEffectiveFrom ?? source.effectiveFrom),
            ]);
        }

        const relevanceProven = matchedIssueIds.length > 0 && matchedProvisions.length > 0;
        const currentRuleCandidate = relevanceProven
            && Boolean(decisionDate)
            && controllingDates.length > 0
            && controllingDates.every((date) => decisionDate >= date);
        // 판례 API에는 해당 사건에 적용된 조문 version ID나 당시 조문 원문이 없다.
        // exact 참조+선고일은 동일 규정의 증명이 아니라 유추 가능한 후보 근거로만 남긴다.
        const currentLawFit = currentRuleCandidate
            ? 'current_rule_candidate'
            : relevanceProven && controllingDates.length > 0 && Boolean(decisionDate)
                ? 'changed_rule'
                : 'unknown';
        const fullTextVerified = Boolean(holdings && reasoning && detail.fullText);

        return {
            sourceId: `CASE-${sourceIdPart(summary.caseSerialId)}`,
            sourceType: 'case',
            official: true,
            title: detail.caseName || summary.caseName,
            officialUrl: casePublicUrl(summary.caseSerialId),
            retrievedAt,
            verificationStatus: 'verified',
            exactTextHash: hashText([
                detail.holdings,
                detail.summary,
                detail.referenceProvisions,
                detail.fullText,
            ].filter(Boolean).join('\n')),
            caseSerialId: summary.caseSerialId,
            caseName: detail.caseName || summary.caseName,
            caseNumber: detail.caseNumber ?? summary.caseNumber ?? '',
            court: detail.courtName ?? summary.courtName ?? '',
            decisionDate,
            disposition: detail.decision ?? summary.decision,
            holding: holdings,
            reasoningSummary: reasoning,
            referencedProvisions: referenced
                ? referenced.split(/[\n;]/).map((item) => item.trim()).filter(Boolean)
                : [],
            fullTextVerified,
            listingIdentityVerified: identityVerified,
            relevance: relevanceProven
                ? {
                    grade: 'analogical',
                    matchedIssues: matchedIssueIds,
                    matchedProvisions,
                    reason: currentRuleCandidate
                        ? '판례 전문의 쟁점어, NFKC·공백 정규화 후 정확히 일치하는 법령명·조문, 현행 조문 시행일 이후 선고를 확인했습니다. 다만 판례 API에 적용 규정의 버전 ID나 당시 조문 원문이 없어 현행 규정 동일성은 검증 후보로만 분류했습니다.'
                        : '판례 전문에서 정확한 법령명·조문과 쟁점은 확인했지만 선고일이 현행 조문 시행일보다 앞서 현행 규정 동일성을 인정하지 않았습니다.',
                }
                : {
                    grade: 'unrelated',
                    matchedIssues: [],
                    matchedProvisions: [],
                    reason: '전문에서 현행 법령 anchor와 쟁점의 동시 관련성을 확인하지 못했습니다.',
                },
            currentLawFit,
            useInConclusion: currentRuleCandidate
                ? 'analogical_support'
                : 'excluded',
        };
    }
}
