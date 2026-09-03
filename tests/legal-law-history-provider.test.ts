import assert from 'node:assert/strict';
import test from 'node:test';
import { LegalOpenApiError } from '../src/services/legal-research/errors';
import {
    LawOpenApiClient,
    type LegalOpenApiHttpGet,
    type LegalOpenApiHttpRequest,
} from '../src/services/legal-research/law-open-api-client';
import type { LawVersionSummary } from '../src/services/legal-research/provider-types';

const SECRET_OC = 'history-provider-secret';

const historicalVersion: LawVersionSummary = {
    mst: '269821',
    lawId: '009410',
    name: '도시 및 주거환경정비법',
    lawType: '법률',
    ministry: '국토교통부',
    promulgationDate: '20250722',
    promulgationNo: '21049',
    effectiveDate: '20250722',
    revisionType: '일부개정',
    currentHistoryCode: '연혁',
};

function versionSearchXml(lawId = '009410', page = 2): string {
    return `<LawSearch><totalCnt>127</totalCnt><page>${page}</page><law>
      <법령일련번호>269821</법령일련번호>
      <현행연혁코드>연혁</현행연혁코드>
      <법령명한글>도시 및 주거환경정비법</법령명한글>
      <법령ID>${lawId}</법령ID>
      <공포일자>20250722</공포일자><공포번호>21049</공포번호>
      <제개정구분명>일부개정</제개정구분명><소관부처명>국토교통부</소관부처명>
      <법령구분명>법률</법령구분명><시행일자>20250722</시행일자>
    </law></LawSearch>`;
}

function articleHistoryXml(lawId = '009410', articleNumber = '003900'): string {
    return `<LawService>
      <법령ID>${lawId}</법령ID><법령명한글>도시 및 주거환경정비법</법령명한글>
      <totalCnt>1</totalCnt><law>
        <법령정보>
          <법령일련번호>269821</법령일련번호>
          <공포일자>20250722</공포일자><공포번호>21049</공포번호>
          <제개정구분명>일부개정</제개정구분명><소관부처명>국토교통부</소관부처명>
          <법령구분명>법률</법령구분명><시행일자>20250722</시행일자>
        </법령정보>
        <조문정보>
          <조문번호>${articleNumber}</조문번호><변경사유>일부개정</변경사유>
          <조문변경일>20250722</조문변경일>
        </조문정보>
      </law>
    </LawService>`;
}

interface SnapshotOverrides {
    lawId?: string;
    mst?: string;
    name?: string;
    promulgationDate?: string;
    promulgationNo?: string;
    effectiveDate?: string;
    articleNumber?: string;
}

function provisionSnapshotXml(overrides: SnapshotOverrides = {}): string {
    const explicitMst = overrides.mst === undefined
        ? ''
        : `<법령일련번호>${overrides.mst}</법령일련번호>`;
    return `<법령>
      <기본정보>
        <법령키>0094102025072221049</법령키>
        ${explicitMst}
        <법령ID>${overrides.lawId ?? historicalVersion.lawId}</법령ID>
        <법령명_한글>${overrides.name ?? historicalVersion.name}</법령명_한글>
        <공포일자>${overrides.promulgationDate ?? historicalVersion.promulgationDate}</공포일자>
        <공포번호>${overrides.promulgationNo ?? historicalVersion.promulgationNo}</공포번호>
        <시행일자>${overrides.effectiveDate ?? historicalVersion.effectiveDate}</시행일자>
        <제개정구분>일부개정</제개정구분>
      </기본정보>
      <조문>
        <조문단위>
          <조문번호>${overrides.articleNumber ?? '39'}</조문번호>
          <조문가지번호>0</조문가지번호><조문여부>전문</조문여부>
          <조문내용>제6장 정비사업의 시행</조문내용>
        </조문단위>
        <조문단위>
          <조문번호>${overrides.articleNumber ?? '39'}</조문번호>
          <조문가지번호>0</조문가지번호><조문여부>조문</조문여부>
          <조문제목>총회의 의결</조문제목><조문내용>총회의 의결 방법</조문내용>
          <조문시행일자>20250722</조문시행일자>
        </조문단위>
      </조문>
    </법령>`;
}

function clientFor(data: string) {
    const calls: Array<{ path: string; request: LegalOpenApiHttpRequest }> = [];
    const httpGet: LegalOpenApiHttpGet = async (path, request) => {
        calls.push({ path, request });
        return { data };
    };
    return {
        client: new LawOpenApiClient({ oc: SECRET_OC, httpGet }),
        calls,
    };
}

test('버전 조회는 정확한 LID와 전체 상태·최신 시행일순·100건 paging 계약을 고정한다', async () => {
    const { client, calls } = clientFor(versionSearchXml());
    const result = await client.searchLawVersions({ lawId: '9410', page: 2 });

    assert.deepEqual(calls[0].request.params, {
        OC: SECRET_OC,
        target: 'eflaw',
        LID: '009410',
        nw: '1,2,3',
        sort: 'efdes',
        display: 100,
        page: 2,
        type: 'XML',
    });
    assert.equal(result.page, 2);
    assert.equal(result.totalCount, 127);
    assert.equal(result.items[0].currentHistoryCode, '연혁');
});

test('버전 조회 응답의 법령 ID가 LID와 다르면 SOURCE_MISMATCH로 닫힌다', async () => {
    const { client } = clientFor(versionSearchXml('009411'));
    await assert.rejects(
        client.searchLawVersions({ lawId: '009410', page: 2 }),
        (error: unknown) => error instanceof LegalOpenApiError
            && error.code === 'SOURCE_MISMATCH',
    );
});

test('조문별 변경이력은 ID·6자리 JO·100건 paging 계약을 고정한다', async () => {
    const { client, calls } = clientFor(articleHistoryXml());
    const result = await client.searchLawArticleHistory({
        lawId: '9410',
        articleNumber: '제39조',
        page: 3,
    });

    assert.deepEqual(calls[0].request.params, {
        OC: SECRET_OC,
        target: 'lsJoHstInf',
        ID: '009410',
        JO: '003900',
        display: 100,
        page: 3,
        type: 'XML',
    });
    assert.equal(result.page, 3);
    assert.equal(result.items[0].mst, '269821');
    assert.equal(result.items[0].articleNumber, '003900');
});

test('조문별 변경이력의 선행 0이 생략된 JO도 요청 JO와 동일하게 검증한다', async () => {
    const { client } = clientFor(articleHistoryXml('009410', '3900'));
    const result = await client.searchLawArticleHistory({
        lawId: '009410',
        articleNumber: '제39조',
    });

    assert.equal(result.items[0].articleNumber, '003900');
});

test('조문별 변경이력의 법령 ID 또는 JO가 요청과 다르면 SOURCE_MISMATCH로 닫힌다', async (t) => {
    for (const response of [
        articleHistoryXml('009411', '003900'),
        articleHistoryXml('009410', '004000'),
    ]) {
        await t.test(response.includes('009411') ? '법령 ID' : 'JO', async () => {
            const { client } = clientFor(response);
            await assert.rejects(
                client.searchLawArticleHistory({
                    lawId: '009410',
                    articleNumber: '제39조',
                }),
                (error: unknown) => error instanceof LegalOpenApiError
                    && error.code === 'SOURCE_MISMATCH',
            );
        });
    }
});

test('과거 조문 조회는 목록의 MST·efYd와 JO를 고정하고 상태값을 결과에 보존한다', async () => {
    const { client, calls } = clientFor(provisionSnapshotXml());
    const result = await client.getLawProvisionSnapshot({
        version: historicalVersion,
        articleNumber: '제39조',
        paragraphNumber: '제1항',
        itemNumber: '제2호',
        subItemNumber: '가목',
    });

    assert.deepEqual(calls[0].request.params, {
        OC: SECRET_OC,
        target: 'eflawjosub',
        MST: '269821',
        efYd: '20250722',
        JO: '003900',
        HANG: '000100',
        HO: '000200',
        MOK: '가',
        type: 'XML',
    });
    assert.equal(result.mst, '269821');
    assert.equal(result.lawId, '009410');
    assert.equal(result.effectiveDate, '20250722');
    assert.equal(result.articleNumber, '003900');
    assert.equal(result.currentHistoryCode, '연혁');
    assert.equal(result.detail.mst, undefined);
    assert.equal(result.detail.articles.filter((article) => article.isArticle).length, 1);
});

test('조문 본문은 응답의 ID·MST(명시 시)·날짜·법령명·조문 identity를 모두 검증한다', async (t) => {
    const mismatches: Array<[string, SnapshotOverrides]> = [
        ['법령 ID', { lawId: '009411' }],
        ['명시 MST', { mst: '269822' }],
        ['공포일', { promulgationDate: '20250723' }],
        ['공포번호', { promulgationNo: '21050' }],
        ['시행일', { effectiveDate: '20250723' }],
        ['법령명', { name: '도시 및 주거환경정비법 시행령' }],
        ['조문', { articleNumber: '40' }],
    ];

    for (const [label, overrides] of mismatches) {
        await t.test(label, async () => {
            const { client } = clientFor(provisionSnapshotXml(overrides));
            await assert.rejects(
                client.getLawProvisionSnapshot({
                    version: historicalVersion,
                    articleNumber: '제39조',
                }),
                (error: unknown) => error instanceof LegalOpenApiError
                    && error.code === 'SOURCE_MISMATCH',
            );
        });
    }
});

test('목록에서 허용하지 않은 현행연혁코드는 본문 호출 전에 거부한다', async () => {
    const { client, calls } = clientFor(provisionSnapshotXml());
    await assert.rejects(
        client.getLawProvisionSnapshot({
            version: { ...historicalVersion, currentHistoryCode: '폐지' as never },
            articleNumber: '제39조',
        }),
        (error: unknown) => error instanceof LegalOpenApiError
            && error.code === 'INVALID_REQUEST',
    );
    assert.equal(calls.length, 0);
});
