import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
    DEVELOPMENT_PAGED_READ_IN_CHUNK_SIZE,
    DEVELOPMENT_PAGED_READ_MAX_ROWS,
    DEVELOPMENT_PAGED_READ_PAGE_SIZE,
    chunkValues,
    readChunked,
    readExactPaged,
    type PagedReadPageResult,
} from '../src/cli/development-land-area-paged-read';

const root = path.resolve(__dirname, '..');

function tableRows(count: number, prefix = 'row'): Array<{
    id: string;
    pnu: string;
}> {
    return Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-${String(index).padStart(5, '0')}`,
        pnu: `11305101001079${String(index).padStart(5, '0')}`,
    }));
}

/**
 * PostgREST 흉내: `Range: from-to` 를 받아 rows 를 잘라 주되, 프로젝트 max-rows
 * (운영 기본 1,000) 를 넘는 요청은 오류 없이 앞 maxRows 행만 돌려준다.
 * count 는 exact(전체 행수) 로 헤더에 싣는다.
 */
function fakePostgrest(
    rows: unknown[],
    options: {
        maxRows?: number;
        countOverride?: (call: number) => number | null;
        errorAt?: { call: number; error: unknown };
        truncateAt?: number;
    } = {}
) {
    const calls: Array<[number, number]> = [];
    const maxRows = options.maxRows ?? 1000;
    const fetchPage = async (
        from: number,
        to: number
    ): Promise<PagedReadPageResult> => {
        calls.push([from, to]);
        const call = calls.length;
        if (options.errorAt && options.errorAt.call === call) {
            return { data: null, error: options.errorAt.error, count: null };
        }
        const visible =
            options.truncateAt === undefined
                ? rows
                : rows.slice(0, options.truncateAt);
        const limit = Math.min(to - from + 1, maxRows);
        const data = visible.slice(from, from + limit);
        const count = options.countOverride
            ? options.countOverride(call)
            : rows.length;
        return { data, error: null, count };
    };
    return { calls, fetchPage };
}

test('페이징 helper 상수는 500행 페이지·10,000행 상한·100건 in-chunk 로 고정된다', () => {
    assert.equal(DEVELOPMENT_PAGED_READ_PAGE_SIZE, 500);
    assert.equal(DEVELOPMENT_PAGED_READ_MAX_ROWS, 10_000);
    assert.equal(DEVELOPMENT_PAGED_READ_IN_CHUNK_SIZE, 100);
});

test('단일 range 는 PostgREST max-rows(1,000) 에서 조용히 잘리지만 exact 페이징은 1,612행 전건을 읽는다', async () => {
    const rows = tableRows(1612);
    // 종전 CLI 방식(range(0, expected) 단일 요청)의 실제 실패 형상 — 오류 없이 1,000행.
    const single = fakePostgrest(rows);
    const legacy = await single.fetchPage(0, 1612);
    assert.equal((legacy.data as unknown[]).length, 1000);
    assert.equal(legacy.count, 1612);
    assert.equal(legacy.error, null);

    const paged = fakePostgrest(rows);
    const result = await readExactPaged('SOLSAM_ACTIVE', paged.fetchPage);
    assert.equal(result.length, 1612);
    assert.deepEqual(result, rows);
    assert.deepEqual(paged.calls, [
        [0, 499],
        [500, 999],
        [1000, 1499],
        [1500, 1999],
    ]);
});

test('정확히 페이지 경계(500·1,000)와 경계+1 은 필요한 페이지 수만 요청한다', async () => {
    for (const [count, expectedCalls] of [
        [500, 1],
        [1000, 2],
        [501, 2],
        [1, 1],
    ] as const) {
        const rows = tableRows(count);
        const server = fakePostgrest(rows);
        const result = await readExactPaged('BOUNDARY', server.fetchPage);
        assert.equal(result.length, count, `count=${count}`);
        assert.equal(
            server.calls.length,
            expectedCalls,
            `count=${count} calls=${JSON.stringify(server.calls)}`
        );
    }
});

test('빈 결과는 빈 배열을 돌려주고 한 번만 요청한다', async () => {
    const server = fakePostgrest([]);
    const result = await readExactPaged('EMPTY', server.fetchPage);
    assert.deepEqual(result, []);
    assert.deepEqual(server.calls, [[0, 499]]);
});

test('중간 페이지가 count 보다 먼저 끝나면(서버 절단) _TRUNCATED 로 fail-closed 한다', async () => {
    // count 는 1,612 라고 하면서 실제로는 800행까지만 돌려주는 서버.
    const server = fakePostgrest(tableRows(1612), { truncateAt: 800 });
    await assert.rejects(
        readExactPaged('SOLSAM_ACTIVE', server.fetchPage),
        /^Error: SOLSAM_ACTIVE_TRUNCATED$/
    );
    // 500 + 300 을 받은 뒤 800 부터 한 번 더 물어 0행을 확인하고서야 멈춘다.
    assert.deepEqual(server.calls, [
        [0, 499],
        [500, 999],
        [800, 1299],
    ]);
});

test('페이지 사이에 count 가 바뀌면 _READ_FAILED_SHAPE 로 멈춘다', async () => {
    const server = fakePostgrest(tableRows(1200), {
        countOverride: (call) => (call === 1 ? 1200 : 1201),
    });
    await assert.rejects(
        readExactPaged('DRIFT', server.fetchPage),
        /^Error: DRIFT_READ_FAILED_SHAPE$/
    );
    assert.equal(server.calls.length, 2);
});

test('count 가 null 이거나 음수·비정수면 _READ_FAILED_SHAPE, 오류는 PostgREST 코드를 접미로 보존한다', async () => {
    await assert.rejects(
        readExactPaged(
            'NULLCOUNT',
            fakePostgrest(tableRows(3), { countOverride: () => null })
                .fetchPage
        ),
        /^Error: NULLCOUNT_READ_FAILED_SHAPE$/
    );
    await assert.rejects(
        readExactPaged(
            'NEGATIVE',
            fakePostgrest(tableRows(3), { countOverride: () => -1 })
                .fetchPage
        ),
        /^Error: NEGATIVE_READ_FAILED_SHAPE$/
    );
    await assert.rejects(
        readExactPaged(
            'PGCODE',
            fakePostgrest(tableRows(3), {
                errorAt: { call: 1, error: { code: 'PGRST103' } },
            }).fetchPage
        ),
        /^Error: PGCODE_READ_FAILED_PGRST103$/
    );
    await assert.rejects(
        readExactPaged(
            'NOCODE',
            fakePostgrest(tableRows(3), {
                errorAt: { call: 1, error: { message: 'boom' } },
            }).fetchPage
        ),
        /^Error: NOCODE_READ_FAILED_ERR$/
    );
    // 코드가 접미 문법을 벗어나면(공백·특수문자) 원문을 싣지 않는다.
    await assert.rejects(
        readExactPaged(
            'BADCODE',
            fakePostgrest(tableRows(3), {
                errorAt: { call: 1, error: { code: 'x y/z' } },
            }).fetchPage
        ),
        /^Error: BADCODE_READ_FAILED_ERR$/
    );
    // 두 번째 페이지에서 나는 오류도 같은 규칙이다.
    const late = fakePostgrest(tableRows(700), {
        errorAt: { call: 2, error: { code: '57014' } },
    });
    await assert.rejects(
        readExactPaged('LATE', late.fetchPage),
        /^Error: LATE_READ_FAILED_57014$/
    );
    assert.equal(late.calls.length, 2);
});

test('count 보다 많은 행이 오거나 10,000행 상한을 넘으면 _COUNT_INVALID', async () => {
    const over = fakePostgrest(tableRows(3), { countOverride: () => 2 });
    await assert.rejects(
        readExactPaged('OVER', over.fetchPage),
        /^Error: OVER_COUNT_INVALID$/
    );
    const huge = fakePostgrest(
        tableRows(DEVELOPMENT_PAGED_READ_MAX_ROWS + 1)
    );
    await assert.rejects(
        readExactPaged('HUGE', huge.fetchPage),
        /^Error: HUGE_COUNT_INVALID$/
    );
    // 정확히 상한이면 통과한다.
    const atMax = fakePostgrest(tableRows(DEVELOPMENT_PAGED_READ_MAX_ROWS));
    const rows = await readExactPaged('ATMAX', atMax.fetchPage);
    assert.equal(rows.length, DEVELOPMENT_PAGED_READ_MAX_ROWS);
});

test('행이 객체가 아니면 _ROW_INVALID, data 가 배열이 아니면 _READ_FAILED_SHAPE', async () => {
    await assert.rejects(
        readExactPaged(
            'ROW',
            fakePostgrest([{ id: 'a' }, null, { id: 'c' }]).fetchPage
        ),
        /^Error: ROW_ROW_INVALID$/
    );
    await assert.rejects(
        readExactPaged(
            'ROW2',
            fakePostgrest([{ id: 'a' }, ['nested']]).fetchPage
        ),
        /^Error: ROW2_ROW_INVALID$/
    );
    await assert.rejects(
        readExactPaged('NOTARRAY', async () => ({
            data: { id: 'a' },
            error: null,
            count: 1,
        })),
        /^Error: NOTARRAY_READ_FAILED_SHAPE$/
    );
});

test('chunkValues 는 100건씩 입력 순서를 보존해 나누고 잘못된 크기는 거부한다', () => {
    const values = Array.from({ length: 250 }, (_, index) => `v${index}`);
    const chunks = chunkValues(values);
    assert.deepEqual(
        chunks.map((chunk) => chunk.length),
        [100, 100, 50]
    );
    assert.deepEqual(chunks.flat(), values);
    assert.deepEqual(chunkValues([]), []);
    assert.deepEqual(chunkValues(['a', 'b', 'c'], 2), [['a', 'b'], ['c']]);
    assert.throws(() => chunkValues(values, 0), /PAGED_READ_CHUNK_SIZE_INVALID/);
    assert.throws(
        () => chunkValues(values, 1.5),
        /PAGED_READ_CHUNK_SIZE_INVALID/
    );
});

test('readChunked 는 100건 chunk 마다 exact 페이징으로 읽고 chunk 순서대로 병합한다', async () => {
    // job id 250개, 각 id 마다 물건 1~3건 → chunk 별 행수가 페이지(500)를 넘도록 구성.
    const jobIds = Array.from({ length: 250 }, (_, index) =>
        `job-${String(index).padStart(3, '0')}`
    );
    const rowsByJob = new Map<string, Array<{ id: string; job: string }>>();
    for (const [index, jobId] of jobIds.entries()) {
        rowsByJob.set(
            jobId,
            Array.from({ length: (index % 3) + 1 }, (_, unit) => ({
                id: `${jobId}-u${unit}`,
                job: jobId,
            }))
        );
    }
    const seenChunks: string[][] = [];
    const rangesByChunk: Array<Array<[number, number]>> = [];
    const result = await readChunked(
        'ATTR',
        jobIds,
        async (chunk, from, to) => {
            if (seenChunks.at(-1) !== chunk) {
                seenChunks.push(chunk);
                rangesByChunk.push([]);
            }
            rangesByChunk.at(-1)!.push([from, to]);
            const all = chunk.flatMap((jobId) => rowsByJob.get(jobId) ?? []);
            return {
                data: all.slice(from, Math.min(to + 1, from + 1000)),
                error: null,
                count: all.length,
            };
        }
    );
    assert.deepEqual(
        seenChunks.map((chunk) => chunk.length),
        [100, 100, 50]
    );
    assert.deepEqual(seenChunks.flat(), jobIds);
    const expected = jobIds.flatMap((jobId) => rowsByJob.get(jobId) ?? []);
    assert.equal(result.length, expected.length);
    assert.deepEqual(result, expected);
    // chunk 별 행수는 199·200·100 으로 모두 한 페이지(500) 안이다.
    assert.deepEqual(rangesByChunk, [[[0, 499]], [[0, 499]], [[0, 499]]]);
});

test('readChunked 는 chunk 하나가 절단되면 그 chunk 의 코드로 fail-closed 하고 chunk 간 합계도 10,000 상한을 지킨다', async () => {
    const values = Array.from({ length: 150 }, (_, index) => `v${index}`);
    await assert.rejects(
        readChunked('ATTR', values, async (chunk, from, to) => {
            const rows = chunk.map((value) => ({ id: value }));
            // 두 번째 chunk 만 count 를 부풀린다.
            const inflate = chunk[0] === 'v100';
            return {
                data: rows.slice(from, to + 1),
                error: null,
                count: rows.length + (inflate ? 1 : 0),
            };
        }),
        /^Error: ATTR_TRUNCATED$/
    );
    // chunk 별로는 상한 이하지만 합계가 10,000 을 넘는 경우.
    const manyValues = Array.from({ length: 101 }, (_, index) => `v${index}`);
    await assert.rejects(
        readChunked('SUM', manyValues, async (chunk, from, to) => {
            const rows = Array.from({ length: chunk.length * 100 }, (_, i) => ({
                id: `${chunk[0]}-${i}`,
            }));
            return {
                data: rows.slice(from, to + 1),
                error: null,
                count: rows.length,
            };
        }),
        /^Error: SUM_COUNT_INVALID$/
    );
});

test('캡처·러너 CLI 는 물건지 읽기를 공용 페이징 helper 로만 하고 단일 range(0, …) 를 남기지 않는다', () => {
    const captureCli = fs.readFileSync(
        path.join(
            root,
            'src/cli/development-land-area-evidence-capture.ts'
        ),
        'utf8'
    );
    const runnerCli = fs.readFileSync(
        path.join(root, 'src/cli/development-land-area-sync-runner.ts'),
        'utf8'
    );
    for (const source of [captureCli, runnerCli]) {
        assert.match(
            source,
            /from '\.\/development-land-area-paged-read';/
        );
        assert.doesNotMatch(source, /\.range\(\s*0,/);
        assert.doesNotMatch(
            source,
            /\.range\(\s*0,\s*target\.expected/
        );
    }
    assert.match(
        captureCli,
        /readExactPaged\(\s*'CAPTURE_UNION_ACTIVE_IDENTITY',[\s\S]*?\.select\('id, pnu', \{ count: 'exact' \}\)[\s\S]*?\.range\(from, to\)/
    );
    assert.match(
        runnerCli,
        /readExactPaged\(\s*'DEVELOPMENT_PREFLIGHT',[\s\S]*?land_area_synced_at, land_area_sync_job_id',\s*\{ count: 'exact' \}[\s\S]*?\.range\(from, to\)/
    );
    assert.match(
        runnerCli,
        /readChunked\(\s*'DEVELOPMENT_WRITE_ATTRIBUTION',\s*\[\.\.\.new Set\(syncJobIds\)\],[\s\S]*?\.in\('land_area_sync_job_id', syncJobIdChunk\)[\s\S]*?\.range\(from, to\)/
    );
});
