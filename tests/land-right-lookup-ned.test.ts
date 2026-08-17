import assert from 'node:assert/strict';
import test from 'node:test';
import {
    LAND_RIGHT_LOOKUP_MAX_BYTES,
    LAND_RIGHT_LOOKUP_MAX_ROWS,
    LandRightLookupBudget,
    LandRightNedClient,
    NED_PAGE_SIZE,
    NED_SCAN_MAX_ROWS,
    type HttpRequest,
    type HttpResponse,
} from '../src/services/land-right-lookup/ned';

const PNU = '1168010100107360024';
const AUTH = { key: 'provider-secret', domain: 'admin.example.com' };

function response(data: unknown, status = 200): HttpResponse {
    return { status, data, headers: {} };
}

function body(
    key: 'ldaregVOList' | 'ladfrlVOList',
    totalCount: number,
    rows: unknown
) {
    return { [key]: { totalCount, [key]: rows } };
}

function client(
    handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse
) {
    const requests: HttpRequest[] = [];
    const sleeps: number[] = [];
    return {
        requests,
        sleeps,
        value: new LandRightNedClient({
            intervalMs: 0,
            random: () => 0,
            sleep: async (ms) => {
                sleeps.push(ms);
            },
            httpClient: async (request) => {
                requests.push(request);
                return handler(request);
            },
        }),
    };
}

test('명시적 totalCount=0만 NO_DATA로 분류한다', async () => {
    const fixture = client(() => response(body('ldaregVOList', 0, [])));
    const result = await fixture.value.fetchLdareg(PNU, AUTH);

    assert.deepEqual(result, { status: 'NO_DATA', records: [] });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].params.pnu, PNU);
    assert.equal(fixture.requests[0].params.numOfRows, NED_PAGE_SIZE);
});

test('전 페이지 row 수와 PNU가 일치해야 SUCCESS다', async () => {
    const firstRows = Array.from({ length: NED_PAGE_SIZE }, (_, index) => ({
        pnu: PNU,
        agbldgSn: String(index + 1),
    }));
    const lastRow = { pnu: PNU, agbldgSn: 'last' };
    const fixture = client((request) =>
        Number(request.params.pageNo) === 1
            ? response(body('ldaregVOList', NED_PAGE_SIZE + 1, firstRows))
            : response(body('ldaregVOList', NED_PAGE_SIZE + 1, [lastRow]))
    );

    const result = await fixture.value.fetchLdareg(PNU, AUTH);
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.records.length, NED_PAGE_SIZE + 1);
    assert.equal(fixture.requests.length, 2);
});

test('누락 container는 NO_DATA가 아니라 안전 코드의 FAILED다', async () => {
    const fixture = client(() => response({ response: {} }));
    const result = await fixture.value.fetchLdareg(PNU, AUTH);

    assert.deepEqual(result, {
        status: 'FAILED',
        records: [],
        code: 'SCHEMA_ENDPOINT_CONTAINER_MISSING_RESPONSE',
    });
    assert.doesNotMatch(JSON.stringify(result), /provider-secret/);
});

test('pagination row 부족과 row PNU 불일치는 INCOMPLETE다', async () => {
    const short = client(() =>
        response(body('ladfrlVOList', 2, [{ pnu: PNU }]))
    );
    assert.deepEqual(await short.value.fetchLadfrl(PNU, AUTH), {
        status: 'INCOMPLETE',
        records: [],
        code: 'PAGINATION_MISMATCH',
    });

    const wrongPnu = client(() =>
        response(
            body('ladfrlVOList', 1, [
                { pnu: '1168010100107360025', lndpclAr: '10' },
            ])
        )
    );
    assert.deepEqual(await wrongPnu.value.fetchLadfrl(PNU, AUTH), {
        status: 'INCOMPLETE',
        records: [],
        code: 'ROW_PNU_MISMATCH',
    });
});

test('timeout과 429는 최대 3회만 재시도하고 원문 오류를 반환하지 않는다', async () => {
    let timeoutCalls = 0;
    const timeout = client(async () => {
        timeoutCalls += 1;
        throw Object.assign(new Error('secret timeout detail'), {
            code: 'ETIMEDOUT',
        });
    });
    assert.deepEqual(await timeout.value.fetchLdareg(PNU, AUTH), {
        status: 'INCOMPLETE',
        records: [],
        code: 'PROVIDER_TIMEOUT',
    });
    assert.equal(timeoutCalls, 3);

    let rateLimitCalls = 0;
    const rateLimited = client(() => {
        rateLimitCalls += 1;
        return response({ raw: 'do-not-return' }, 429);
    });
    assert.deepEqual(await rateLimited.value.fetchLdareg(PNU, AUTH), {
        status: 'FAILED',
        records: [],
        code: 'HTTP_429',
    });
    assert.equal(rateLimitCalls, 3);
});

test('provider key가 없으면 외부 요청 없이 FAILED다', async () => {
    const fixture = client(() => {
        throw new Error('호출되면 안 됨');
    });
    const result = await fixture.value.fetchLdareg(PNU, {
        key: '',
        domain: 'admin.example.com',
    });

    assert.deepEqual(result, {
        status: 'FAILED',
        records: [],
        code: 'PROVIDER_NOT_CONFIGURED',
    });
    assert.equal(fixture.requests.length, 0);
});

test('scan 10,000행과 요청 전체 20,000행 hard cap은 부분 rows 없이 INCOMPLETE다', async () => {
    assert.equal(NED_SCAN_MAX_ROWS, 10_000);
    assert.equal(LAND_RIGHT_LOOKUP_MAX_ROWS, 20_000);

    const scanLimited = client(() =>
        response(body('ldaregVOList', NED_SCAN_MAX_ROWS + 1, [{ pnu: PNU }]))
    );
    assert.deepEqual(await scanLimited.value.fetchLdareg(PNU, AUTH), {
        status: 'INCOMPLETE',
        records: [],
        code: 'SCAN_ROW_LIMIT_EXCEEDED',
    });
    assert.equal(scanLimited.requests.length, 1);

    const sharedBudget = new LandRightLookupBudget(1, LAND_RIGHT_LOOKUP_MAX_BYTES);
    const requestLimited = client((request) => {
        const key = request.url.includes('ldaregList')
            ? 'ldaregVOList'
            : 'ladfrlVOList';
        return response(body(key, 1, [{ pnu: PNU }]));
    });
    assert.equal(
        (await requestLimited.value.fetchLdareg(PNU, AUTH, {
            budget: sharedBudget,
        })).status,
        'SUCCESS'
    );
    assert.deepEqual(
        await requestLimited.value.fetchLadfrl(PNU, AUTH, {
            budget: sharedBudget,
        }),
        {
            status: 'INCOMPLETE',
            records: [],
            code: 'LOOKUP_ROW_LIMIT_EXCEEDED',
        }
    );
});

test('요청 전체 8MiB byte cap은 provider 원문을 반환하지 않고 INCOMPLETE다', async () => {
    assert.equal(LAND_RIGHT_LOOKUP_MAX_BYTES, 8 * 1024 * 1024);
    const requests: HttpRequest[] = [];
    const value = new LandRightNedClient({
        intervalMs: 0,
        httpClient: async (request) => {
            requests.push(request);
            return {
                ...response(body('ldaregVOList', 1, [{ pnu: PNU }])),
                byteLength: LAND_RIGHT_LOOKUP_MAX_BYTES + 1,
            };
        },
    });

    assert.deepEqual(await value.fetchLdareg(PNU, AUTH), {
        status: 'INCOMPLETE',
        records: [],
        code: 'LOOKUP_RESPONSE_SIZE_LIMIT_EXCEEDED',
    });
    assert.equal(requests[0].maxResponseBytes, LAND_RIGHT_LOOKUP_MAX_BYTES);
});

test('deadline abort는 외부 호출을 시작하지 않고 고정 INCOMPLETE code로 닫는다', async () => {
    const controller = new AbortController();
    controller.abort('LOOKUP_DEADLINE_EXCEEDED');
    const fixture = client(() => {
        throw new Error('호출되면 안 됨');
    });

    assert.deepEqual(
        await fixture.value.fetchLdareg(PNU, AUTH, {
            signal: controller.signal,
        }),
        {
            status: 'INCOMPLETE',
            records: [],
            code: 'LOOKUP_DEADLINE_EXCEEDED',
        }
    );
    assert.equal(fixture.requests.length, 0);
});

test('429 Retry-After는 singleton FIFO 전체에 등록돼 대기 중인 다른 조회도 cooldown을 지킨다', async () => {
    let nowMs = 0;
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
        markFirstStarted = resolve;
    });
    const calls: string[] = [];
    const pendingSleeps: Array<{ ms: number; resolve: () => void }> = [];
    let firstAttempt = true;
    const value = new LandRightNedClient({
        intervalMs: 0,
        now: () => nowMs,
        random: () => 0,
        sleep: (ms) =>
            new Promise<void>((resolve) => {
                pendingSleeps.push({ ms, resolve });
            }),
        httpClient: async (request) => {
            const source = request.url.includes('ladfrlList')
                ? 'ladfrl'
                : 'ldareg';
            calls.push(source);
            if (source === 'ladfrl' && firstAttempt) {
                firstAttempt = false;
                markFirstStarted();
                await firstGate;
                return {
                    status: 429,
                    data: {},
                    headers: { 'retry-after': '1' },
                };
            }
            const key = source === 'ladfrl' ? 'ladfrlVOList' : 'ldaregVOList';
            return response(body(key, 0, []));
        },
    });

    const first = value.fetchLadfrl(PNU, AUTH);
    await firstStarted;
    const other = value.fetchLdareg(PNU, AUTH);
    releaseFirst();
    for (let turn = 0; turn < 20 && pendingSleeps.length === 0; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(calls, ['ladfrl']);
    assert.deepEqual(pendingSleeps.map(({ ms }) => ms), [1_000]);

    nowMs = 1_000;
    pendingSleeps.splice(0).forEach(({ resolve }) => resolve());
    const [firstResult, otherResult] = await Promise.all([first, other]);
    assert.equal(firstResult.status, 'NO_DATA');
    assert.equal(otherResult.status, 'NO_DATA');
    assert.deepEqual(calls, ['ladfrl', 'ldareg', 'ladfrl']);
});

test('FIFO 대기 ticket abort는 후속 요청을 선행 HTTP 앞으로 우회시키지 않는다', async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
        markFirstStarted = resolve;
    });
    const calls: string[] = [];
    const value = new LandRightNedClient({
        intervalMs: 0,
        sleep: async () => undefined,
        httpClient: async (request) => {
            const source = request.url.includes('ladfrlList')
                ? 'ladfrl'
                : 'ldareg';
            calls.push(source);
            if (calls.length === 1) {
                markFirstStarted();
                await firstGate;
            }
            const key = source === 'ladfrl' ? 'ladfrlVOList' : 'ldaregVOList';
            return response(body(key, 0, []));
        },
    });
    const controller = new AbortController();

    const first = value.fetchLadfrl(PNU, AUTH);
    await firstStarted;
    const aborted = value.fetchLdareg(PNU, AUTH, {
        signal: controller.signal,
    });
    const last = value.fetchLdareg(PNU, AUTH);
    controller.abort('CLIENT_DISCONNECTED');

    assert.deepEqual(await aborted, {
        status: 'INCOMPLETE',
        records: [],
        code: 'LOOKUP_ABORTED',
    });
    assert.deepEqual(calls, ['ladfrl']);
    releaseFirst();
    const [firstResult, lastResult] = await Promise.all([first, last]);
    assert.equal(firstResult.status, 'NO_DATA');
    assert.equal(lastResult.status, 'NO_DATA');
    assert.deepEqual(calls, ['ladfrl', 'ldareg']);
});

test('active HTTP abort는 caller만 즉시 끝내고 underlying settle 전 FIFO slot을 풀지 않는다', async () => {
    let releaseUnderlying!: () => void;
    let markStarted!: () => void;
    const underlyingGate = new Promise<void>((resolve) => {
        releaseUnderlying = resolve;
    });
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    let calls = 0;
    const value = new LandRightNedClient({
        intervalMs: 0,
        sleep: async () => undefined,
        httpClient: async () => {
            calls += 1;
            if (calls === 1) {
                markStarted();
                await underlyingGate;
                throw new Error('late provider rejection must be consumed');
            }
            return response(body('ldaregVOList', 0, []));
        },
    });
    const controller = new AbortController();
    const first = value.fetchLdareg(PNU, AUTH, {
        signal: controller.signal,
    });
    await started;
    controller.abort('CLIENT_DISCONNECTED');

    const didNotReturn = Symbol('did-not-return');
    const firstOutcome = await Promise.race([
        first,
        new Promise<typeof didNotReturn>((resolve) =>
            setTimeout(() => resolve(didNotReturn), 50)
        ),
    ]);
    assert.notEqual(firstOutcome, didNotReturn);
    assert.deepEqual(firstOutcome, {
        status: 'INCOMPLETE',
        records: [],
        code: 'LOOKUP_ABORTED',
    });

    const last = value.fetchLdareg(PNU, AUTH);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'underlying HTTP가 끝나기 전에 후속 호출을 시작하면 안 된다');
    releaseUnderlying();
    assert.equal((await last).status, 'NO_DATA');
    assert.equal(calls, 2);
});

test('이전 page 전체가 순서만 바뀌어 반복돼도 stable full-row fingerprint가 차단한다', async () => {
    const rows = Array.from({ length: NED_PAGE_SIZE }, (_, index) => ({
        pnu: PNU,
        rowId: String(index),
        nested: { b: 2, a: 1 },
    }));
    for (const secondRows of [rows, [...rows].reverse()]) {
        const fixture = client((request) =>
            Number(request.params.pageNo) === 1
                ? response(body('ldaregVOList', 2_000, rows))
                : response(
                      body(
                          'ldaregVOList',
                          2_000,
                          secondRows.map(({ pnu, rowId, nested }) => ({
                              nested: { a: nested.a, b: nested.b },
                              rowId,
                              pnu,
                          }))
                      )
                  )
        );
        assert.deepEqual(await fixture.value.fetchLdareg(PNU, AUTH), {
            status: 'INCOMPLETE',
            records: [],
            code: 'PAGE_REPEATED',
        });
    }
});

test('이전 page row와 1건이라도 겹치면 partial overlap을 INCOMPLETE로 닫는다', async () => {
    const rows = Array.from({ length: NED_PAGE_SIZE }, (_, index) => ({
        pnu: PNU,
        rowId: String(index),
    }));
    const fixture = client((request) =>
        Number(request.params.pageNo) === 1
            ? response(body('ladfrlVOList', 1_001, rows))
            : response(
                  body('ladfrlVOList', 1_001, [
                      { rowId: rows[500].rowId, pnu: PNU },
                  ])
              )
    );

    assert.deepEqual(await fixture.value.fetchLadfrl(PNU, AUTH), {
        status: 'INCOMPLETE',
        records: [],
        code: 'PAGE_RECORD_OVERLAP',
    });
});

test('같은 page 내부 duplicate row는 원문 의미대로 보존한다', async () => {
    const duplicate = { pnu: PNU, rowId: 'same' };
    const fixture = client(() =>
        response(body('ldaregVOList', 2, [duplicate, { ...duplicate }]))
    );
    const result = await fixture.value.fetchLdareg(PNU, AUTH);

    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.records.length, 2);
    assert.deepEqual(result.records[0], result.records[1]);
});
