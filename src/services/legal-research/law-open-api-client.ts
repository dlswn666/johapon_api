import axios, { type AxiosInstance } from 'axios';
import { LegalOpenApiError, isLegalOpenApiError } from './errors';
import {
    parseCaseDetailXml,
    parseCaseSearchXml,
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
    ProviderSearchPage,
    SearchCasesInput,
    SearchCurrentLawsInput,
    SearchCurrentOrdinancesInput,
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
            const subItem = requiredText(input.subItemNumber, 3).replace(/목$/, '');
            if (!/^[가-힣]$/.test(subItem)) throw new LegalOpenApiError('INVALID_REQUEST');
            params.MOK = subItem;
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
        if (detail.caseSerialId !== requestedId) {
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
