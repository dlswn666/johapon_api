// 대지권 동기화 CLI(캡처·러너)가 Supabase 를 읽는 유일한 경로.
//
// PostgREST 는 프로젝트 설정 max-rows(운영 기본 1,000) 를 넘는 range 요청을
// 오류 없이 1,000행으로 잘라 돌려준다. 삼양동처럼 활성 물건지가 1,000 을 넘는
// 조합을 단일 range 로 읽으면 앞 1,000행만 조용히 받게 되므로, 모든 읽기는
// exact count 와 500행 페이지로 전건을 확인하고 모자라거나 넘치면 fail-closed
// 한다. 오류 코드는 `${code}_READ_FAILED_<PostgREST 코드>` / `_TRUNCATED` /
// `_COUNT_INVALID` / `_ROW_INVALID` 로 artifact 에서 판독 가능한 접미를 보존한다.

export const DEVELOPMENT_PAGED_READ_PAGE_SIZE = 500;
export const DEVELOPMENT_PAGED_READ_MAX_ROWS = 10_000;
export const DEVELOPMENT_PAGED_READ_IN_CHUNK_SIZE = 100;

export type PagedReadRow = Record<string, unknown>;

export interface PagedReadPageResult {
    data: unknown;
    error: unknown;
    count: number | null;
}

export type PagedReadFetchPage = (
    from: number,
    to: number
) => PromiseLike<PagedReadPageResult>;

export type PagedReadFetchChunk = (
    chunk: string[],
    from: number,
    to: number
) => PromiseLike<PagedReadPageResult>;

/**
 * `.select(..., { count: 'exact' }).range(from, to)` 페이지를 count 가 맞을 때까지
 * 이어 읽는다. 페이지 사이에 count 가 바뀌거나, count 보다 적게 끝나거나(서버
 * 절단), count 보다 많이 오거나, 행이 객체가 아니면 던진다.
 */
export async function readExactPaged(
    code: string,
    fetchPage: PagedReadFetchPage
): Promise<PagedReadRow[]> {
    const rows: PagedReadRow[] = [];
    let expectedCount: number | null = null;
    while (true) {
        const result = await fetchPage(
            rows.length,
            rows.length + DEVELOPMENT_PAGED_READ_PAGE_SIZE - 1
        );
        if (
            result.error ||
            !Array.isArray(result.data) ||
            !Number.isSafeInteger(result.count) ||
            (result.count as number) < 0 ||
            (expectedCount !== null && result.count !== expectedCount)
        ) {
            // PostgREST 오류 코드를 artifact에서 판독 가능한 접미로 보존한다.
            const causeRaw = (result.error as { code?: unknown } | null)
                ?.code;
            const cause =
                typeof causeRaw === 'string' &&
                /^[A-Za-z0-9]{1,16}$/.test(causeRaw)
                    ? `_${causeRaw.toUpperCase()}`
                    : result.error
                      ? '_ERR'
                      : '_SHAPE';
            throw new Error(`${code}_READ_FAILED${cause}`);
        }
        const pageCount = result.count as number;
        expectedCount = pageCount;
        for (const row of result.data) {
            if (
                row === null ||
                typeof row !== 'object' ||
                Array.isArray(row)
            ) {
                throw new Error(`${code}_ROW_INVALID`);
            }
            rows.push(row as PagedReadRow);
        }
        if (
            rows.length > DEVELOPMENT_PAGED_READ_MAX_ROWS ||
            rows.length > pageCount
        ) {
            throw new Error(`${code}_COUNT_INVALID`);
        }
        if (rows.length === pageCount) return rows;
        if (result.data.length === 0) {
            throw new Error(`${code}_TRUNCATED`);
        }
    }
}

/** `.in()` 인자를 URL 길이 안전 범위(100건)로 나눈다. 입력 순서를 보존한다. */
export function chunkValues<T>(
    values: readonly T[],
    size = DEVELOPMENT_PAGED_READ_IN_CHUNK_SIZE
): T[][] {
    if (!Number.isSafeInteger(size) || size < 1) {
        throw new Error('PAGED_READ_CHUNK_SIZE_INVALID');
    }
    const result: T[][] = [];
    for (let offset = 0; offset < values.length; offset += size) {
        result.push(values.slice(offset, offset + size));
    }
    return result;
}

/**
 * 값 목록을 100건씩 `.in()` 으로 나눠 각 chunk 를 exact 페이징으로 읽고 chunk
 * 순서대로 이어 붙인다. chunk 간 중복 제거나 정렬은 하지 않는다 — 호출자가
 * 단일 `.in()` 과 같은 결과를 원하면 값 목록을 미리 유일화하고 결과를 정렬한다.
 */
export async function readChunked(
    code: string,
    values: readonly string[],
    fetchChunk: PagedReadFetchChunk
): Promise<PagedReadRow[]> {
    const rows: PagedReadRow[] = [];
    for (const chunk of chunkValues(values)) {
        rows.push(
            ...(await readExactPaged(code, (from, to) =>
                fetchChunk(chunk, from, to)
            ))
        );
    }
    if (rows.length > DEVELOPMENT_PAGED_READ_MAX_ROWS) {
        throw new Error(`${code}_COUNT_INVALID`);
    }
    return rows;
}
