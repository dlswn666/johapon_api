import axios, { type AxiosInstance } from 'axios';
import { LegalOpenApiError, isLegalOpenApiError } from './errors';
import {
    parseCaseDetailXml,
    parseCaseSearchXml,
    parseLawArticleHistoryXml,
    parseLawVersionSearchXml,
    parseCurrentLawDetailXml,
    parseCurrentLawSearchXml,
    parseCurrentOrdinanceDetailXml,
    parseCurrentOrdinanceSearchXml,
} from './law-open-api-parser';
import type {
    CaseDetail,
    CaseSummary,
    CurrentLawDetail,
    CurrentLawDetailInput,
    CurrentLawProvisionInput,
    CurrentLawSummary,
    CurrentOrdinanceDetail,
    CurrentOrdinanceDetailInput,
    CurrentOrdinanceSummary,
    GetCaseDetailInput,
    GetLawProvisionSnapshotInput,
    LawArticle,
    LawArticleHistoryEntry,
    LawProvisionSnapshot,
    LawVersionHistoryCode,
    LawVersionSummary,
    ProviderSearchPage,
    SearchCasesInput,
    SearchCurrentLawsInput,
    SearchCurrentOrdinancesInput,
    SearchLawArticleHistoryInput,
    SearchLawVersionsInput,
} from './provider-types';

const LAW_OPEN_API_BASE_URL = 'https://www.law.go.kr/DRF';
const LIST_PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

type ProviderParam = string | number;

export interface LegalOpenApiHttpRequest {
    params: Record<string, ProviderParam>;
    timeout: number;
    responseType: 'text';
    transformResponse: Array<(data: unknown) => unknown>;
    maxContentLength: number;
    maxBodyLength: number;
    headers: Record<string, string>;
    signal?: AbortSignal;
}

export interface LegalOpenApiHttpResponse {
    data: unknown;
    status?: number;
}

export type LegalOpenApiHttpGet = (
    path: '/lawSearch.do' | '/lawService.do',
    request: LegalOpenApiHttpRequest,
) => Promise<LegalOpenApiHttpResponse>;

export interface LawOpenApiClientOptions {
    oc?: string;
    timeoutMs?: number;
    maxResponseBytes?: number;
    httpGet?: LegalOpenApiHttpGet;
}

function asPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw new LegalOpenApiError('INVALID_REQUEST');
    }
    return value;
}

function requiredText(value: string | undefined, maximumLength: number): string {
    const trimmed = value?.trim() ?? '';
    if (!trimmed || trimmed.length > maximumLength) {
        throw new LegalOpenApiError('INVALID_REQUEST');
    }
    return trimmed;
}

function optionalText(value: string | undefined, maximumLength: number): string | undefined {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > maximumLength) {
        throw new LegalOpenApiError('INVALID_REQUEST');
    }
    return trimmed;
}

function numericIdentifier(value: string | undefined): string {
    const identifier = requiredText(value, 30);
    if (!/^\d+$/.test(identifier)) throw new LegalOpenApiError('INVALID_REQUEST');
    return identifier;
}

/**
 * 공급자가 동일한 숫자 식별자를 선행 0 또는 전각 숫자로 되돌려주는 경우만
 * 비교 단계에서 동일하게 취급한다. 요청 파라미터 자체는 기존 ASCII 숫자 계약을 유지한다.
 */
function canonicalNumericIdentifier(value: string | undefined): string | null {
    const identifier = value?.normalize('NFKC').trim();
    if (!identifier || !/^\d+$/.test(identifier)) return null;
    return identifier.replace(/^0+(?=\d)/, '');
}

function lawIdentifier(value: string | undefined): string {
    const identifier = numericIdentifier(value);
    if (identifier.length > 6) throw new LegalOpenApiError('INVALID_REQUEST');
    return identifier.padStart(6, '0');
}

function effectiveDate(value: string | undefined): string {
    const date = requiredText(value, 8);
    if (!/^\d{8}$/.test(date)) throw new LegalOpenApiError('INVALID_REQUEST');
    return date;
}

function searchScope(value: 1 | 2 | undefined, fallback: 1 | 2): 1 | 2 {
    const scope = value ?? fallback;
    if (scope !== 1 && scope !== 2) throw new LegalOpenApiError('INVALID_REQUEST');
    return scope;
}

function pageNumber(value: number | undefined): number {
    return asPositiveInteger(value, 1, 100_000);
}

function provisionNumber(value: string | undefined): string {
    const normalized = requiredText(value, 12)
        .replace(/^제/, '')
        .replace(/[조항호](?=의|$)/, '');
    if (/^\d{6}$/.test(normalized)) return normalized;
    const matched = /^(\d{1,4})(?:의(\d{1,2}))?$/.exec(normalized);
    if (!matched) throw new LegalOpenApiError('INVALID_REQUEST');
    return `${matched[1].padStart(4, '0')}${(matched[2] ?? '0').padStart(2, '0')}`;
}

function optionalProvisionNumber(value: string | undefined): string | undefined {
    return value === undefined ? undefined : provisionNumber(value);
}

function subItemNumber(value: string | undefined): string {
    const subItem = requiredText(value, 3).replace(/목$/, '');
    if (!/^[가-힣]$/.test(subItem)) throw new LegalOpenApiError('INVALID_REQUEST');
    return subItem;
}

const LAW_VERSION_HISTORY_CODES = new Set<LawVersionHistoryCode>([
    '현행',
    '연혁',
    '시행예정',
]);

function versionHistoryCode(value: LawVersionHistoryCode | undefined): LawVersionHistoryCode {
    if (!value || !LAW_VERSION_HISTORY_CODES.has(value)) {
        throw new LegalOpenApiError('INVALID_REQUEST');
    }
    return value;
}

function canonicalProviderLawId(value: string | undefined): string | undefined {
    const identifier = value?.trim();
    if (!identifier || !/^\d{1,6}$/.test(identifier)) return undefined;
    return identifier.padStart(6, '0');
}

function articleJo(article: LawArticle): string | undefined {
    const rawArticle = article.articleNumber.trim();
    const rawBranch = article.branchNumber?.trim() ?? '';

    if (/^\d{6}$/.test(rawArticle) && (!rawBranch || rawBranch === '0' || rawBranch === '00')) {
        return rawArticle;
    }
    if (!/^\d{1,4}$/.test(rawArticle) || (rawBranch && !/^\d{1,2}$/.test(rawBranch))) {
        return undefined;
    }
    return `${rawArticle.padStart(4, '0')}${(rawBranch || '0').padStart(2, '0')}`;
}

function mapTransportError(error: unknown): LegalOpenApiError {
    if (isLegalOpenApiError(error)) return error;
    const shaped = error as {
        code?: unknown;
        response?: { status?: unknown };
        status?: unknown;
    } | null;
    const code = typeof shaped?.code === 'string' ? shaped.code.toUpperCase() : '';
    const responseStatus = shaped?.response?.status ?? shaped?.status;
    const status = typeof responseStatus === 'number' ? responseStatus : undefined;

    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
        return new LegalOpenApiError('UPSTREAM_TIMEOUT', { cause: error });
    }
    if (code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED' || status === 413) {
        return new LegalOpenApiError('RESPONSE_TOO_LARGE', { cause: error });
    }
    if (status === 401 || status === 403) {
        return new LegalOpenApiError('AUTH', { cause: error });
    }
    if (status === 429) {
        return new LegalOpenApiError('RATE_LIMITED', { cause: error });
    }
    return new LegalOpenApiError('UPSTREAM_UNAVAILABLE', { cause: error });
}

function responseAsText(data: unknown, maximumBytes: number): string {
    let text: string;
    if (typeof data === 'string') text = data;
    else if (Buffer.isBuffer(data)) text = data.toString('utf8');
    else throw new LegalOpenApiError('SCHEMA_DRIFT');

    if (Buffer.byteLength(text, 'utf8') > maximumBytes) {
        throw new LegalOpenApiError('RESPONSE_TOO_LARGE');
    }
    return text;
}

export class LawOpenApiClient {
    private readonly oc: string;
    private readonly timeoutMs: number;
    private readonly maxResponseBytes: number;
    private readonly httpGet: LegalOpenApiHttpGet;

    constructor(options: LawOpenApiClientOptions = {}) {
        this.oc = (options.oc ?? process.env.LAW_API_OC ?? '').trim();
        this.timeoutMs = asPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 60_000);
        this.maxResponseBytes = asPositiveInteger(
            options.maxResponseBytes,
            DEFAULT_MAX_RESPONSE_BYTES,
            32 * 1024 * 1024,
        );

        if (options.httpGet) {
            this.httpGet = options.httpGet;
        } else {
            const instance: AxiosInstance = axios.create({ baseURL: LAW_OPEN_API_BASE_URL });
            this.httpGet = async (path, request) => instance.get(path, request);
        }
    }

    private requireOc(): string {
        if (!this.oc) throw new LegalOpenApiError('AUTH');
        return this.oc;
    }

    private async requestXml(
        path: '/lawSearch.do' | '/lawService.do',
        providerParams: Record<string, ProviderParam>,
        signal?: AbortSignal,
    ): Promise<string> {
        signal?.throwIfAborted();
        const request: LegalOpenApiHttpRequest = {
            params: {
                OC: this.requireOc(),
                ...providerParams,
                type: 'XML',
            },
            timeout: this.timeoutMs,
            responseType: 'text',
            transformResponse: [(data) => data],
            maxContentLength: this.maxResponseBytes,
            maxBodyLength: this.maxResponseBytes,
            headers: { 'User-Agent': 'tonghari-legal-research/1.0' },
            ...(signal ? { signal } : {}),
        };

        try {
            const response = await this.httpGet(path, request);
            if (response.status !== undefined && response.status >= 400) {
                throw { status: response.status };
            }
            return responseAsText(response.data, this.maxResponseBytes);
        } catch (error) {
            // 취소를 일시적 upstream 장애로 바꾸면 오케스트레이터가 partial 결과로
            // 삼킬 수 있으므로 원래 AbortSignal 이유를 그대로 전파한다.
            signal?.throwIfAborted();
            throw mapTransportError(error);
        }
    }

    async searchCurrentLaws(
        input: SearchCurrentLawsInput,
        signal?: AbortSignal,
    ): Promise<ProviderSearchPage<CurrentLawSummary>> {
        const xml = await this.requestXml('/lawSearch.do', {
            target: 'eflaw',
            nw: 3,
            query: requiredText(input.query, 200),
            search: searchScope(input.searchScope, 1),
            display: LIST_PAGE_SIZE,
            page: pageNumber(input.page),
        }, signal);
        return parseCurrentLawSearchXml(xml);
    }

    /**
     * LID 하나의 시행일 기준 버전을 최신 시행일 순으로 한 페이지씩 조회합니다.
     * 연혁/시행예정/현행을 모두 요청하고 provider 상태값을 그대로 보존합니다.
     */
    async searchLawVersions(
        input: SearchLawVersionsInput,
        signal?: AbortSignal,
    ): Promise<ProviderSearchPage<LawVersionSummary>> {
        const requestedLawId = lawIdentifier(input.lawId);
        const requestedPage = pageNumber(input.page);
        const xml = await this.requestXml('/lawSearch.do', {
            target: 'eflaw',
            LID: requestedLawId,
            nw: '1,2,3',
            sort: 'efdes',
            display: LIST_PAGE_SIZE,
            page: requestedPage,
        }, signal);
        const result = parseLawVersionSearchXml(xml);
        if (
            result.page !== requestedPage
            || result.items.some((item) => canonicalProviderLawId(item.lawId) !== requestedLawId)
        ) {
            throw new LegalOpenApiError('SOURCE_MISMATCH');
        }
        return result;
    }

    /** 법령 ID와 6자리 JO로 조문별 변경 이력을 한 페이지씩 조회합니다. */
    async searchLawArticleHistory(
        input: SearchLawArticleHistoryInput,
        signal?: AbortSignal,
    ): Promise<ProviderSearchPage<LawArticleHistoryEntry>> {
        const requestedLawId = lawIdentifier(input.lawId);
        const requestedArticle = provisionNumber(input.articleNumber);
        const requestedPage = pageNumber(input.page);
        const xml = await this.requestXml('/lawService.do', {
            target: 'lsJoHstInf',
            ID: requestedLawId,
            JO: requestedArticle,
            display: LIST_PAGE_SIZE,
            page: requestedPage,
        }, signal);
        const result = parseLawArticleHistoryXml(xml, requestedPage);
        if (result.items.some((item) => (
            canonicalProviderLawId(item.lawId) !== requestedLawId
            || item.articleNumber !== requestedArticle
        ))) {
            throw new LegalOpenApiError('SOURCE_MISMATCH');
        }
        return result;
    }

    async getCurrentLawDetail(
        input: CurrentLawDetailInput,
        signal?: AbortSignal
    ): Promise<CurrentLawDetail> {
        const params: Record<string, ProviderParam> = { target: 'eflaw' };
        if ('lawId' in input && input.lawId !== undefined) {
            params.ID = numericIdentifier(input.lawId);
        } else if ('mst' in input && input.mst !== undefined) {
            params.MST = numericIdentifier(input.mst);
            params.efYd = effectiveDate(input.effectiveDate);
        } else {
            throw new LegalOpenApiError('INVALID_REQUEST');
        }
        const xml = await this.requestXml('/lawService.do', params, signal);
        const detail = parseCurrentLawDetailXml(xml);
        this.assertLawIdentity(detail, input);
        return detail;
    }

    async getCurrentLawProvision(
        input: CurrentLawProvisionInput,
        signal?: AbortSignal
    ): Promise<CurrentLawDetail> {
        const params: Record<string, ProviderParam> = {
            target: 'eflawjosub',
            JO: provisionNumber(input.articleNumber),
        };
        if (input.paragraphNumber !== undefined) {
            params.HANG = optionalProvisionNumber(input.paragraphNumber)!;
        }
        if (input.itemNumber !== undefined) {
            params.HO = optionalProvisionNumber(input.itemNumber)!;
        }
        if (input.subItemNumber !== undefined) {
            params.MOK = subItemNumber(input.subItemNumber);
        }

        if (input.lawId !== undefined && input.mst === undefined) {
            params.ID = numericIdentifier(input.lawId);
        } else if (input.mst !== undefined && input.lawId === undefined) {
            params.MST = numericIdentifier(input.mst);
            params.efYd = effectiveDate(input.effectiveDate);
        } else {
            throw new LegalOpenApiError('INVALID_REQUEST');
        }

        const xml = await this.requestXml('/lawService.do', params, signal);
        const detail = parseCurrentLawDetailXml(xml);
        if (input.lawId !== undefined && detail.lawId !== input.lawId) {
            throw new LegalOpenApiError('SOURCE_MISMATCH');
        }
        if (input.mst !== undefined && detail.mst !== input.mst) {
            throw new LegalOpenApiError('SOURCE_MISMATCH');
        }
        return detail;
    }

    /**
     * 목록 API가 반환한 MST + 시행일을 그대로 사용해 특정 버전의 조문을 조회합니다.
     * eflawjosub 실응답은 요청 MST를 별도 필드로 되돌려주지 않을 수 있으므로,
     * MST는 응답에 명시된 경우 검증하고 항상 ID/시행일/공포 메타데이터/조문을 함께 검증합니다.
     */
    async getLawProvisionSnapshot(
        input: GetLawProvisionSnapshotInput,
        signal?: AbortSignal,
    ): Promise<LawProvisionSnapshot> {
        const mst = numericIdentifier(input.version.mst);
        const lawId = lawIdentifier(input.version.lawId);
        const lawName = requiredText(input.version.name, 300);
        const versionEffectiveDate = effectiveDate(input.version.effectiveDate);
        const promulgationDate = effectiveDate(input.version.promulgationDate);
        const promulgationNo = requiredText(input.version.promulgationNo, 100);
        const currentHistoryCode = versionHistoryCode(input.version.currentHistoryCode);
        const requestedArticle = provisionNumber(input.articleNumber);
        const params: Record<string, ProviderParam> = {
            target: 'eflawjosub',
            MST: mst,
            efYd: versionEffectiveDate,
            JO: requestedArticle,
        };
        if (input.paragraphNumber !== undefined) {
            params.HANG = optionalProvisionNumber(input.paragraphNumber)!;
        }
        if (input.itemNumber !== undefined) {
            params.HO = optionalProvisionNumber(input.itemNumber)!;
        }
        if (input.subItemNumber !== undefined) {
            params.MOK = subItemNumber(input.subItemNumber);
        }

        const xml = await this.requestXml('/lawService.do', params, signal);
        const detail = parseCurrentLawDetailXml(xml);
        const actualArticles = detail.articles.filter((article) => article.isArticle);
        if (
            canonicalProviderLawId(detail.lawId) !== lawId
            || (detail.mst !== undefined && detail.mst !== mst)
            || detail.effectiveDate !== versionEffectiveDate
            || detail.promulgationDate !== promulgationDate
            || detail.promulgationNo !== promulgationNo
            || detail.name !== lawName
            || actualArticles.length === 0
            || actualArticles.some((article) => articleJo(article) !== requestedArticle)
        ) {
            throw new LegalOpenApiError('SOURCE_MISMATCH');
        }

        return {
            mst,
            lawId,
            effectiveDate: versionEffectiveDate,
            currentHistoryCode,
            articleNumber: requestedArticle,
            detail,
        };
    }

    async searchCurrentOrdinances(
        input: SearchCurrentOrdinancesInput,
        signal?: AbortSignal,
    ): Promise<ProviderSearchPage<CurrentOrdinanceSummary>> {
        const org = numericIdentifier(input.org);
        const sborg = input.sborg === undefined ? undefined : numericIdentifier(input.sborg);
        const xml = await this.requestXml('/lawSearch.do', {
            target: 'ordin',
            nw: 1,
            query: requiredText(input.query, 200),
            search: searchScope(input.searchScope, 1),
            display: LIST_PAGE_SIZE,
            page: pageNumber(input.page),
            org,
            ...(sborg ? { sborg } : {}),
        }, signal);
        return parseCurrentOrdinanceSearchXml(xml);
    }

    async getCurrentOrdinanceDetail(
        input: CurrentOrdinanceDetailInput,
        signal?: AbortSignal,
    ): Promise<CurrentOrdinanceDetail> {
        const params: Record<string, ProviderParam> = { target: 'ordin' };
        if ('ordinanceId' in input && input.ordinanceId !== undefined) {
            params.ID = numericIdentifier(input.ordinanceId);
        } else if ('mst' in input && input.mst !== undefined) {
            params.MST = numericIdentifier(input.mst);
        } else {
            throw new LegalOpenApiError('INVALID_REQUEST');
        }
        const xml = await this.requestXml('/lawService.do', params, signal);
        const detail = parseCurrentOrdinanceDetailXml(xml);
        this.assertOrdinanceIdentity(detail, input);
        return detail;
    }

    async searchCases(
        input: SearchCasesInput,
        signal?: AbortSignal
    ): Promise<ProviderSearchPage<CaseSummary>> {
        const query = optionalText(input.query, 200);
        const referenceLawName = optionalText(input.referenceLawName, 200);
        if (Number(Boolean(query)) + Number(Boolean(referenceLawName)) !== 1) {
            throw new LegalOpenApiError('INVALID_REQUEST');
        }
        const xml = await this.requestXml('/lawSearch.do', {
            target: 'prec',
            sort: 'ddes',
            display: LIST_PAGE_SIZE,
            page: pageNumber(input.page),
            ...(query ? { query, search: searchScope(input.searchScope, 2) } : {}),
            ...(referenceLawName ? { JO: referenceLawName } : {}),
            ...(input.courtTypeCode ? { org: input.courtTypeCode } : {}),
            ...(input.courtName ? { curt: requiredText(input.courtName, 100) } : {}),
        }, signal);
        return parseCaseSearchXml(xml);
    }

    async getCaseDetail(
        input: GetCaseDetailInput,
        signal?: AbortSignal
    ): Promise<CaseDetail> {
        const requestedId = numericIdentifier(input.caseSerialId);
        const xml = await this.requestXml('/lawService.do', {
            target: 'prec',
            ID: requestedId,
        }, signal);
        const detail = parseCaseDetailXml(xml);
        if (
            canonicalNumericIdentifier(detail.caseSerialId) === null
            || canonicalNumericIdentifier(detail.caseSerialId)
                !== canonicalNumericIdentifier(requestedId)
        ) {
            throw new LegalOpenApiError('SOURCE_MISMATCH');
        }
        return detail;
    }

    private assertLawIdentity(detail: CurrentLawDetail, input: CurrentLawDetailInput): void {
        if ('lawId' in input && input.lawId && detail.lawId !== input.lawId) {
            throw new LegalOpenApiError('SOURCE_MISMATCH');
        }
        if ('mst' in input && input.mst && detail.mst !== input.mst) {
            throw new LegalOpenApiError('SOURCE_MISMATCH');
        }
    }

    private assertOrdinanceIdentity(
        detail: CurrentOrdinanceDetail,
        input: CurrentOrdinanceDetailInput,
    ): void {
        if (
            'ordinanceId' in input
            && input.ordinanceId
            && detail.ordinanceId !== input.ordinanceId
        ) {
            throw new LegalOpenApiError('SOURCE_MISMATCH');
        }
        if ('mst' in input && input.mst && detail.mst !== input.mst) {
            throw new LegalOpenApiError('SOURCE_MISMATCH');
        }
    }
}
