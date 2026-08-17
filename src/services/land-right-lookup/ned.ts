/**
 * 대지권 공식자료 transient 조회용 V-World NED 클라이언트.
 *
 * 폐기 예정 Phase 2 워커의 pagination/retry 클라이언트만 선택 이식했다. queue, worker,
 * lookup 결과 저장은 포함하지 않는다. 이 모듈은 provider 응답을 네 상태로 분류하고 raw
 * body나 인증 key를 결과/오류에 싣지 않는다.
 */

import axios from 'axios';
import { createHash } from 'node:crypto';
import { GIS_SHARED_ENDPOINTS } from '../gis-shared/endpoints';
import { parseVworldRequestIntervalMs } from '../../utils/vworld-request-interval';
import type { LandRightLookupStatus } from '../../types/land-right-lookup.types';

export const NED_PAGE_SIZE = 1000;
const MAX_ATTEMPTS = 3;
const MAX_PAGES = 500;
export const NED_SCAN_MAX_ROWS = 10_000;
export const LAND_RIGHT_LOOKUP_MAX_ROWS = 20_000;
export const LAND_RIGHT_LOOKUP_MAX_BYTES = 8 * 1024 * 1024;
const BACKOFF_BASE_MS = 500;
const BACKOFF_JITTER_MS = 250;
const RETRY_AFTER_CAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const PNU_RE = /^\d{10}[12]\d{8}$/;

export interface VworldAuth {
    key: string;
    domain: string;
}

export interface HttpRequest {
    url: string;
    params: Record<string, unknown>;
    timeout: number;
    signal?: AbortSignal;
    /** 이 응답이 소비할 수 있는 남은 request-level byte 예산. */
    maxResponseBytes: number;
}

export interface HttpResponse {
    status: number;
    data: unknown;
    headers: Record<string, string>;
    /** provider 원문을 UTF-8로 읽은 크기. 주입 client는 생략할 수 있다. */
    byteLength?: number;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

export interface NedFetchResult {
    status: LandRightLookupStatus;
    records: Record<string, unknown>[];
    /** provider 원문/message를 포함하지 않는 서버 고정 코드. */
    code?: string;
}

export interface LandRightNedClientDeps {
    httpClient?: HttpClient;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    random?: () => number;
    now?: () => number;
    intervalMs?: number;
}

export interface NedScanOptions {
    signal?: AbortSignal;
    budget?: LandRightLookupBudget;
}

export type LandRightLookupTerminalCode =
    | 'LOOKUP_DEADLINE_EXCEEDED'
    | 'LOOKUP_ABORTED'
    | 'PROVIDER_TIMEOUT'
    | 'SCAN_ROW_LIMIT_EXCEEDED'
    | 'LOOKUP_ROW_LIMIT_EXCEEDED'
    | 'LOOKUP_RESPONSE_SIZE_LIMIT_EXCEEDED';

/** 한 관리자 조회의 모든 endpoint/PNU scan이 공유하는 hard budget. */
export class LandRightLookupBudget {
    private reservedRows = 0;
    private consumedBytes = 0;
    private terminal: LandRightLookupTerminalCode | null = null;

    constructor(
        readonly maxRows = LAND_RIGHT_LOOKUP_MAX_ROWS,
        readonly maxBytes = LAND_RIGHT_LOOKUP_MAX_BYTES
    ) {}

    get terminalCode(): LandRightLookupTerminalCode | null {
        return this.terminal;
    }

    get remainingBytes(): number {
        return Math.max(0, this.maxBytes - this.consumedBytes);
    }

    terminate(code: LandRightLookupTerminalCode): LandRightLookupTerminalCode {
        this.terminal ??= code;
        return this.terminal;
    }

    reserveRows(count: number): LandRightLookupTerminalCode | null {
        if (this.terminal) return this.terminal;
        if (this.reservedRows + count > this.maxRows) {
            return this.terminate('LOOKUP_ROW_LIMIT_EXCEEDED');
        }
        this.reservedRows += count;
        return null;
    }

    consumeBytes(count: number): LandRightLookupTerminalCode | null {
        if (this.terminal) return this.terminal;
        if (!Number.isSafeInteger(count) || count < 0) {
            return this.terminate('LOOKUP_RESPONSE_SIZE_LIMIT_EXCEEDED');
        }
        if (this.consumedBytes + count > this.maxBytes) {
            return this.terminate('LOOKUP_RESPONSE_SIZE_LIMIT_EXCEEDED');
        }
        this.consumedBytes += count;
        return null;
    }
}

type ParsedVworldEnvelope =
    | {
          kind: 'SUCCESS';
          totalCount: number;
          rows: Record<string, unknown>[];
      }
    | { kind: 'PROVIDER_ERROR' }
    | { kind: 'SCHEMA_ERROR'; code: string };

type PageFetch =
    | { ok: true; data: unknown }
    | {
          ok: false;
          status: 'FAILED' | 'INCOMPLETE';
          code: string;
      };

const defaultHttpClient: HttpClient = async ({
    url,
    params,
    timeout,
    signal,
    maxResponseBytes,
}) => {
    const response = await axios.get(url, {
        params,
        timeout,
        signal,
        maxContentLength: maxResponseBytes,
        responseType: 'text',
        transformResponse: [(value) => value],
        validateStatus: () => true,
    });
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers ?? {})) {
        headers[key.toLowerCase()] = Array.isArray(value)
            ? value.join(',')
            : String(value);
    }
    const serialized =
        typeof response.data === 'string'
            ? response.data
            : JSON.stringify(response.data);
    const raw = typeof serialized === 'string' ? serialized : '';
    const byteLength = Buffer.byteLength(raw, 'utf8');
    let data: unknown = raw;
    if (raw !== '') {
        try {
            data = JSON.parse(raw);
        } catch {
            // envelope parser가 안전한 schema code로 분류하도록 원문 문자열을 유지한다.
        }
    }
    return { status: response.status, data, headers, byteLength };
};

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            resolve();
        };
        const onAbort = () => {
            if (timer) clearTimeout(timer);
            finish();
        };
        timer = setTimeout(finish, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });

function parseNonNegativeInteger(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
        return null;
    }
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeRows(value: unknown): Record<string, unknown>[] | null {
    if (value === undefined || value === null || value === '') return [];
    if (Array.isArray(value)) {
        return value.every(
            (row) => row !== null && typeof row === 'object' && !Array.isArray(row)
        )
            ? (value as Record<string, unknown>[])
            : null;
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
        return [value as Record<string, unknown>];
    }
    return null;
}

function parseVworldEnvelope(
    containerKey: string,
    data: unknown
): ParsedVworldEnvelope {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        return { kind: 'SCHEMA_ERROR', code: 'ENDPOINT_RESPONSE_NON_OBJECT' };
    }
    const root = data as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(root, containerKey)) {
        const keys = Object.keys(root);
        const suffix =
            keys.length === 0
                ? 'EMPTY_OBJECT'
                : keys.includes('response')
                  ? 'RESPONSE'
                  : 'OTHER';
        return {
            kind: 'SCHEMA_ERROR',
            code: `ENDPOINT_CONTAINER_MISSING_${suffix}`,
        };
    }
    const container = root[containerKey];
    if (
        container === null ||
        typeof container !== 'object' ||
        Array.isArray(container)
    ) {
        return { kind: 'SCHEMA_ERROR', code: 'ENDPOINT_CONTAINER_INVALID' };
    }
    const envelope = container as Record<string, unknown>;
    if (
        (envelope.error !== undefined &&
            envelope.error !== null &&
            envelope.error !== '') ||
        (envelope.resultCode !== undefined &&
            envelope.resultCode !== null &&
            String(envelope.resultCode) !== '00')
    ) {
        return { kind: 'PROVIDER_ERROR' };
    }
    const totalCount = parseNonNegativeInteger(envelope.totalCount);
    if (totalCount === null) {
        return { kind: 'SCHEMA_ERROR', code: 'TOTAL_COUNT_INVALID' };
    }
    const rows = normalizeRows(envelope[containerKey]);
    if (rows === null) {
        return { kind: 'SCHEMA_ERROR', code: 'ROWS_INVALID' };
    }
    return { kind: 'SUCCESS', totalCount, rows };
}

function parseRetryAfterMs(
    header: string | undefined,
    nowMs: number
): number | null {
    if (!header) return null;
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
    const dateMs = Date.parse(trimmed);
    return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - nowMs);
}

function isTimeoutError(error: unknown): boolean {
    const candidate = error as {
        code?: string;
        name?: string;
        message?: string;
    };
    return (
        candidate?.code === 'ECONNABORTED' ||
        candidate?.code === 'ETIMEDOUT' ||
        candidate?.name === 'TimeoutError' ||
        (typeof candidate?.message === 'string' &&
            /timeout/i.test(candidate.message))
    );
}

function isResponseSizeLimitError(error: unknown): boolean {
    const candidate = error as { code?: string; message?: string };
    return (
        candidate?.code === 'ERR_BAD_RESPONSE' &&
        typeof candidate.message === 'string' &&
        /maxContentLength|larger than max/i.test(candidate.message)
    );
}

function abortCode(signal?: AbortSignal): LandRightLookupTerminalCode | null {
    if (!signal?.aborted) return null;
    return signal.reason === 'LOOKUP_DEADLINE_EXCEEDED'
        ? 'LOOKUP_DEADLINE_EXCEEDED'
        : 'LOOKUP_ABORTED';
}

function abortError(): Error {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return error;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true;
    const candidate = error as { code?: string; name?: string };
    return (
        candidate?.name === 'AbortError' ||
        candidate?.name === 'CanceledError' ||
        candidate?.code === 'ERR_CANCELED'
    );
}

function responseByteLength(response: HttpResponse): number | null {
    if (
        response.byteLength !== undefined &&
        Number.isSafeInteger(response.byteLength) &&
        response.byteLength >= 0
    ) {
        return response.byteLength;
    }
    try {
        const serialized =
            typeof response.data === 'string'
                ? response.data
                : JSON.stringify(response.data);
        return typeof serialized === 'string'
            ? Buffer.byteLength(serialized, 'utf8')
            : null;
    } catch {
        return null;
    }
}

function awaitAbortable<T>(
    promise: Promise<T>,
    signal?: AbortSignal
): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const onAbort = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
            return;
        }
        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
            },
            (error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            }
        );
    });
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) {
            const nested = canonicalize(record[key]);
            if (nested !== undefined) result[key] = nested;
        }
        return result;
    }
    return value;
}

function recordFingerprint(row: Record<string, unknown>): string {
    return createHash('sha256')
        .update(JSON.stringify(canonicalize(row)), 'utf8')
        .digest('hex');
}

function pageFingerprint(recordFingerprints: string[]): string {
    return createHash('sha256')
        .update(JSON.stringify([...recordFingerprints].sort()), 'utf8')
        .digest('hex');
}

/**
 * 한 인스턴스의 모든 V-World 호출을 FIFO 직렬화한다. production에서는 singleton을 사용해
 * 동시에 들어온 관리자 조회도 provider 요청 간격을 공유한다.
 */
export class LandRightNedClient {
    private readonly httpClient: HttpClient;
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    private readonly random: () => number;
    private readonly now: () => number;
    private readonly intervalMs: number;
    private requestChain: Promise<void> = Promise.resolve();
    private lastRequestStartedAt: number | null = null;
    private requestNotBeforeAt = 0;

    constructor(deps: LandRightNedClientDeps = {}) {
        this.httpClient = deps.httpClient ?? defaultHttpClient;
        this.sleep = deps.sleep ?? defaultSleep;
        this.random = deps.random ?? Math.random;
        this.now = deps.now ?? Date.now;
        this.intervalMs = parseVworldRequestIntervalMs(deps.intervalMs);
    }

    fetchLdareg(
        pnu: string,
        auth: VworldAuth,
        options: NedScanOptions = {}
    ): Promise<NedFetchResult> {
        return this.scan(
            GIS_SHARED_ENDPOINTS.ldaregList,
            'ldaregVOList',
            pnu,
            auth,
            options
        );
    }

    fetchLadfrl(
        pnu: string,
        auth: VworldAuth,
        options: NedScanOptions = {}
    ): Promise<NedFetchResult> {
        return this.scan(
            GIS_SHARED_ENDPOINTS.ladfrlList,
            'ladfrlVOList',
            pnu,
            auth,
            options
        );
    }

    private async request(
        request: HttpRequest,
        attempt: number
    ): Promise<HttpResponse> {
        const previous = this.requestChain;
        let release!: () => void;
        this.requestChain = new Promise<void>((resolve) => {
            release = resolve;
        });

        let acquired = false;
        let activeHttpPromise: Promise<HttpResponse> | null = null;
        try {
            await this.waitForTurn(previous, request.signal);
            acquired = true;
            if (request.signal?.aborted) throw abortError();

            const nowMs = this.now();
            const intervalNotBefore =
                this.lastRequestStartedAt === null
                    ? 0
                    : this.lastRequestStartedAt + this.intervalMs;
            const notBefore = Math.max(
                intervalNotBefore,
                this.requestNotBeforeAt
            );
            if (notBefore > nowMs) {
                await this.sleep(notBefore - nowMs, request.signal);
                if (request.signal?.aborted) throw abortError();
            }
            this.lastRequestStartedAt = this.now();
            try {
                activeHttpPromise = this.httpClient(request);
                const response = await awaitAbortable(
                    activeHttpPromise,
                    request.signal
                );
                if (
                    response.status === 429 ||
                    (response.status >= 500 && response.status <= 599)
                ) {
                    // 다음 FIFO ticket을 풀기 전에 singleton cooldown을 등록한다.
                    this.registerCooldown(
                        attempt,
                        response.headers['retry-after']
                    );
                }
                return response;
            } catch (error) {
                if (isTimeoutError(error) && !isAbortError(error, request.signal)) {
                    this.registerCooldown(attempt, undefined);
                }
                throw error;
            }
        } finally {
            if (acquired) {
                if (request.signal?.aborted && activeHttpPromise) {
                    // 호출자는 즉시 취소되지만 실제 socket promise가 끝날 때까지 slot은
                    // 유지한다. then 양쪽 handler가 late rejection도 소비한다.
                    void activeHttpPromise.then(release, release);
                } else {
                    release();
                }
            } else {
                // abort ticket이 후속 ticket을 선행 요청 앞으로 우회시키지 못하게 한다.
                void previous.then(release, release);
            }
        }
    }

    private waitForTurn(
        previous: Promise<void>,
        signal?: AbortSignal
    ): Promise<void> {
        return awaitAbortable(previous, signal);
    }

    private registerCooldown(
        attempt: number,
        retryAfter: string | undefined
    ): void {
        const retryAfterMs = parseRetryAfterMs(retryAfter, this.now());
        const delayMs =
            retryAfterMs === null
                ? BACKOFF_BASE_MS * 2 ** (attempt - 1) +
                  Math.floor(this.random() * BACKOFF_JITTER_MS)
                : Math.min(retryAfterMs, RETRY_AFTER_CAP_MS);
        this.requestNotBeforeAt = Math.max(
            this.requestNotBeforeAt,
            this.now() + delayMs
        );
    }

    private async fetchPage(
        url: string,
        baseParams: Record<string, unknown>,
        pageNo: number,
        signal: AbortSignal | undefined,
        budget: LandRightLookupBudget
    ): Promise<PageFetch> {
        const params = {
            ...baseParams,
            numOfRows: NED_PAGE_SIZE,
            pageNo,
        };

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const aborted = abortCode(signal);
            if (aborted) {
                return {
                    ok: false,
                    status: 'INCOMPLETE',
                    code: budget.terminate(aborted),
                };
            }
            if (budget.terminalCode) {
                return {
                    ok: false,
                    status: 'INCOMPLETE',
                    code: budget.terminalCode,
                };
            }
            if (budget.remainingBytes <= 0) {
                return {
                    ok: false,
                    status: 'INCOMPLETE',
                    code: budget.terminate(
                        'LOOKUP_RESPONSE_SIZE_LIMIT_EXCEEDED'
                    ),
                };
            }

            let response: HttpResponse;
            try {
                response = await this.request({
                    url,
                    params,
                    timeout: REQUEST_TIMEOUT_MS,
                    signal,
                    maxResponseBytes: budget.remainingBytes,
                }, attempt);
            } catch (error) {
                if (isResponseSizeLimitError(error)) {
                    return {
                        ok: false,
                        status: 'INCOMPLETE',
                        code: budget.terminate(
                            'LOOKUP_RESPONSE_SIZE_LIMIT_EXCEEDED'
                        ),
                    };
                }
                if (isAbortError(error, signal)) {
                    return {
                        ok: false,
                        status: 'INCOMPLETE',
                        code: budget.terminate(
                            abortCode(signal) ?? 'LOOKUP_ABORTED'
                        ),
                    };
                }
                if (!isTimeoutError(error)) {
                    return {
                        ok: false,
                        status: 'FAILED',
                        code: 'TRANSPORT_ERROR',
                    };
                }
                if (attempt === MAX_ATTEMPTS) {
                    return {
                        ok: false,
                        status: 'INCOMPLETE',
                        code: budget.terminate('PROVIDER_TIMEOUT'),
                    };
                }
                continue;
            }

            const byteLength = responseByteLength(response);
            const byteLimit = budget.consumeBytes(byteLength ?? -1);
            if (byteLimit) {
                return {
                    ok: false,
                    status: 'INCOMPLETE',
                    code: byteLimit,
                };
            }

            if (
                response.status === 429 ||
                (response.status >= 500 && response.status <= 599)
            ) {
                if (attempt === MAX_ATTEMPTS) {
                    return {
                        ok: false,
                        status: 'FAILED',
                        code: `HTTP_${response.status}`,
                    };
                }
                continue;
            }
            if (response.status < 200 || response.status >= 300) {
                return {
                    ok: false,
                    status: 'FAILED',
                    code: `HTTP_${response.status}`,
                };
            }
            return { ok: true, data: response.data };
        }

        return { ok: false, status: 'FAILED', code: 'HTTP_ERROR' };
    }

    private async scan(
        url: string,
        containerKey: string,
        pnu: string,
        auth: VworldAuth,
        options: NedScanOptions
    ): Promise<NedFetchResult> {
        const budget = options.budget ?? new LandRightLookupBudget();
        const initialAbort = abortCode(options.signal);
        const initialTerminal = initialAbort ?? budget.terminalCode;
        if (initialTerminal) {
            return {
                status: 'INCOMPLETE',
                records: [],
                code: budget.terminate(initialTerminal),
            };
        }
        if (!PNU_RE.test(pnu)) {
            return {
                status: 'FAILED',
                records: [],
                code: 'INPUT_PNU_INVALID',
            };
        }
        if (!auth.key.trim() || !auth.domain.trim()) {
            return {
                status: 'FAILED',
                records: [],
                code: 'PROVIDER_NOT_CONFIGURED',
            };
        }

        const baseParams: Record<string, unknown> = {
            pnu,
            key: auth.key,
            domain: auth.domain,
            format: 'json',
        };
        const allRows: Record<string, unknown>[] = [];
        const pageFingerprints = new Set<string>();
        const priorRecordFingerprints = new Set<string>();
        let expectedTotal: number | null = null;
        let totalPages: number | null = null;

        for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
            const fetched = await this.fetchPage(
                url,
                baseParams,
                pageNo,
                options.signal,
                budget
            );
            if (!fetched.ok) {
                return {
                    status: fetched.status,
                    records: [],
                    code: fetched.code,
                };
            }

            const parsed = parseVworldEnvelope(containerKey, fetched.data);
            if (parsed.kind === 'PROVIDER_ERROR') {
                return {
                    status: 'FAILED',
                    records: [],
                    code: 'PROVIDER_ERROR',
                };
            }
            if (parsed.kind === 'SCHEMA_ERROR') {
                return {
                    status: 'FAILED',
                    records: [],
                    code: `SCHEMA_${parsed.code}`,
                };
            }

            const { totalCount, rows } = parsed;
            if (pageNo === 1) {
                expectedTotal = totalCount;
                if (expectedTotal > NED_SCAN_MAX_ROWS) {
                    return {
                        status: 'INCOMPLETE',
                        records: [],
                        code: budget.terminate('SCAN_ROW_LIMIT_EXCEEDED'),
                    };
                }
                const rowLimit = budget.reserveRows(expectedTotal);
                if (rowLimit) {
                    return {
                        status: 'INCOMPLETE',
                        records: [],
                        code: rowLimit,
                    };
                }
                if (expectedTotal === 0) {
                    return rows.length === 0
                        ? { status: 'NO_DATA', records: [] }
                        : {
                              status: 'INCOMPLETE',
                              records: [],
                              code: 'PAGINATION_MISMATCH',
                          };
                }
                totalPages = Math.ceil(expectedTotal / NED_PAGE_SIZE);
                if (totalPages > MAX_PAGES) {
                    return {
                        status: 'INCOMPLETE',
                        records: [],
                        code: 'PAGE_LIMIT_EXCEEDED',
                    };
                }
            } else if (totalCount !== expectedTotal) {
                return {
                    status: 'INCOMPLETE',
                    records: [],
                    code: 'PAGINATION_MISMATCH',
                };
            }

            const isLastPage = pageNo === totalPages;
            const expectedThisPage = isLastPage
                ? (expectedTotal as number) -
                  NED_PAGE_SIZE * ((totalPages as number) - 1)
                : NED_PAGE_SIZE;
            if (rows.length !== expectedThisPage) {
                return {
                    status: 'INCOMPLETE',
                    records: [],
                    code: 'PAGINATION_MISMATCH',
                };
            }

            if (
                rows.some(
                    (row) =>
                        typeof row.pnu !== 'string' ||
                        row.pnu.trim() !== pnu
                )
            ) {
                return {
                    status: 'INCOMPLETE',
                    records: [],
                    code: 'ROW_PNU_MISMATCH',
                };
            }

            const fingerprints = rows.map(recordFingerprint);
            const fingerprint = pageFingerprint(fingerprints);
            if (pageFingerprints.has(fingerprint)) {
                return {
                    status: 'INCOMPLETE',
                    records: [],
                    code: 'PAGE_REPEATED',
                };
            }
            if (
                fingerprints.some((candidate) =>
                    priorRecordFingerprints.has(candidate)
                )
            ) {
                return {
                    status: 'INCOMPLETE',
                    records: [],
                    code: 'PAGE_RECORD_OVERLAP',
                };
            }
            pageFingerprints.add(fingerprint);
            // 같은 page 안의 duplicate는 provider 원문 의미를 보존한다. 다음 page와의
            // overlap 판정에만 사용하도록 page 검증이 끝난 뒤 한 번에 등록한다.
            for (const candidate of fingerprints) {
                priorRecordFingerprints.add(candidate);
            }

            allRows.push(...rows);
            if (allRows.length > (expectedTotal as number)) {
                return {
                    status: 'INCOMPLETE',
                    records: [],
                    code: 'PAGINATION_MISMATCH',
                };
            }
            if (isLastPage) break;
        }

        const finalAbort = abortCode(options.signal);
        const finalTerminal = finalAbort ?? budget.terminalCode;
        if (finalTerminal) {
            return {
                status: 'INCOMPLETE',
                records: [],
                code: budget.terminate(finalTerminal),
            };
        }

        if (
            expectedTotal === null ||
            totalPages === null ||
            allRows.length !== expectedTotal
        ) {
            return {
                status: 'INCOMPLETE',
                records: [],
                code: 'PAGINATION_MISMATCH',
            };
        }

        return { status: 'SUCCESS', records: allRows };
    }
}

export const landRightNedClient = new LandRightNedClient({
    intervalMs: parseVworldRequestIntervalMs(
        process.env.VWORLD_ATTR_REQUEST_INTERVAL_MS
    ),
});
