import assert from 'node:assert/strict';
import test from 'node:test';
import { LegalOpenApiError } from '../src/services/legal-research/errors';
import {
    parseCurrentLawDetailXml,
    parseLawArticleHistoryXml,
    parseLawVersionSearchXml,
} from '../src/services/legal-research/law-open-api-parser';

const SECRET_OC = 'history-parser-secret';

function versionItem(mst: string, status: string, effectiveDate: string): string {
    return `<law>
      <법령일련번호>${mst}</법령일련번호>
      <현행연혁코드>${status}</현행연혁코드>
      <법령명한글>도시 및 주거환경정비법</법령명한글>
      <법령ID>009410</법령ID>
      <공포일자>${effectiveDate}</공포일자>
      <공포번호>${mst}</공포번호>
      <제개정구분명>일부개정</제개정구분명>
      <소관부처명>국토교통부</소관부처명>
      <법령구분명>법률</법령구분명>
      <시행일자>${effectiveDate}</시행일자>
      <법령상세링크>http://www.law.go.kr/DRF/lawService.do?OC=${SECRET_OC}&amp;target=eflaw&amp;MST=${mst}&amp;efYd=${effectiveDate}</법령상세링크>
    </law>`;
}

test('시행일 기준 버전 목록은 현행·연혁·시행예정 상태와 식별 메타데이터를 보존한다', () => {
    const result = parseLawVersionSearchXml(`<LawSearch>
      <totalCnt>3</totalCnt><page>1</page>
      ${versionItem('301', '현행', '20260801')}
      ${versionItem('300', '연혁', '20250722')}
      ${versionItem('302', '시행예정', '20270101')}
    </LawSearch>`);

    assert.equal(result.totalCount, 3);
    assert.deepEqual(result.items.map((item) => item.currentHistoryCode), [
        '현행',
        '연혁',
        '시행예정',
    ]);
    assert.deepEqual(result.items.map((item) => item.lawId), ['009410', '009410', '009410']);
    assert.equal(result.items[1].effectiveDate, '20250722');
    assert.equal(result.items[1].promulgationDate, '20250722');
    assert.equal(JSON.stringify(result).includes(SECRET_OC), false);
    assert.match(result.items[0].officialUrl ?? '', /^https:\/\/www\.law\.go\.kr\//);
});

test('버전 목록의 상태·날짜·MST 필수값이 훼손되면 schema drift로 닫힌다', async (t) => {
    const malformed = [
        versionItem('301', '폐지', '20260801'),
        versionItem('301', '현행', '2026-08-01'),
        versionItem('', '현행', '20260801'),
        versionItem('not-a-number', '현행', '20260801'),
    ];

    for (const [index, item] of malformed.entries()) {
        await t.test(`변형 ${index + 1}`, () => {
            assert.throws(
                () => parseLawVersionSearchXml(
                    `<LawSearch><totalCnt>1</totalCnt><page>1</page>${item}</LawSearch>`,
                ),
                (error: unknown) => error instanceof LegalOpenApiError
                    && error.code === 'SCHEMA_DRIFT',
            );
        });
    }
});

function articleHistoryXml(page = ''): string {
    return `<LawService>
      <법령ID>009410</법령ID>
      <법령명한글>도시 및 주거환경정비법</법령명한글>
      <totalCnt>1</totalCnt>${page}
      <law>
        <법령정보>
          <법령일련번호>269821</법령일련번호>
          <공포일자>20250722</공포일자>
          <공포번호>21049</공포번호>
          <제개정구분명>일부개정</제개정구분명>
          <소관부처명>국토교통부</소관부처명>
          <법령구분명>법률</법령구분명>
          <시행일자>20250722</시행일자>
        </법령정보>
        <조문정보>
          <조문번호>003900</조문번호>
          <변경사유>일부개정</변경사유>
          <조문링크>http://www.law.go.kr/DRF/lawService.do?OC=${SECRET_OC}&amp;target=eflawjosub&amp;MST=269821&amp;efYd=20250722&amp;JO=003900</조문링크>
          <조문변경일>20250722</조문변경일>
        </조문정보>
      </law>
    </LawService>`;
}

test('조문별 변경이력은 실응답에 page가 없어도 요청 page와 6자리 JO를 보존한다', () => {
    const result = parseLawArticleHistoryXml(articleHistoryXml(), 3);

    assert.equal(result.totalCount, 1);
    assert.equal(result.page, 3);
    assert.equal(result.items[0].lawId, '009410');
    assert.equal(result.items[0].lawName, '도시 및 주거환경정비법');
    assert.equal(result.items[0].mst, '269821');
    assert.equal(result.items[0].articleNumber, '003900');
    assert.equal(result.items[0].changeReason, '일부개정');
    assert.equal(result.items[0].changeDate, '20250722');
    assert.equal(JSON.stringify(result).includes(SECRET_OC), false);
});

test('조문링크 efYd는 법령 시행일과 달라도 MST·JO가 맞으면 허용하고 인증값은 제거한다', () => {
    const xml = articleHistoryXml().replace(
        'efYd=20250722',
        'efYd=20240101',
    );

    const result = parseLawArticleHistoryXml(xml);

    assert.equal(result.items[0].effectiveDate, '20250722');
    assert.match(result.items[0].officialUrl ?? '', /efYd=20240101/);
    assert.equal(JSON.stringify(result).includes(SECRET_OC), false);
});

test('조문별 변경이력 응답 page가 요청 page와 다르면 schema drift로 닫힌다', () => {
    assert.throws(
        () => parseLawArticleHistoryXml(articleHistoryXml('<page>2</page>'), 3),
        (error: unknown) => error instanceof LegalOpenApiError
            && error.code === 'SCHEMA_DRIFT',
    );
});

test('조문별 변경이력의 1~6자리 숫자 JO는 6자리로 canonicalize한다', () => {
    for (const [raw, expected] of [
        ['5', '000005'],
        ['3900', '003900'],
        ['03900', '003900'],
        ['003900', '003900'],
    ] as const) {
        const xml = articleHistoryXml()
            .replace(/\s*<조문링크>[^<]+<\/조문링크>/, '')
            .replace(
                '<조문번호>003900</조문번호>',
                `<조문번호>${raw}</조문번호>`,
            );
        assert.equal(parseLawArticleHistoryXml(xml).items[0].articleNumber, expected);
    }
});

test('조문별 변경이력의 비숫자·7자리 JO, 비숫자 MST, 잘못된 변경일은 거부한다', async (t) => {
    for (const [from, to] of [
        ['<조문번호>003900</조문번호>', '<조문번호>39조</조문번호>'],
        ['<조문번호>003900</조문번호>', '<조문번호>0003900</조문번호>'],
        ['<법령일련번호>269821</법령일련번호>', '<법령일련번호>MST-269821</법령일련번호>'],
        ['<조문변경일>20250722</조문변경일>', '<조문변경일>2025-07-22</조문변경일>'],
    ] as const) {
        await t.test(from, () => {
            assert.throws(
                () => parseLawArticleHistoryXml(articleHistoryXml().replace(from, to)),
                (error: unknown) => error instanceof LegalOpenApiError
                    && error.code === 'SCHEMA_DRIFT',
            );
        });
    }
});

test('법령키는 composite 식별자로 분리하고 explicit MST로 해석하지 않는다', () => {
    const compositeOnly = parseCurrentLawDetailXml(`<법령><기본정보>
      <법령키>0094102025072221049</법령키><법령ID>009410</법령ID>
      <법령명_한글>도시 및 주거환경정비법</법령명_한글>
    </기본정보></법령>`);
    const explicitMst = parseCurrentLawDetailXml(`<법령><기본정보>
      <법령키>0094102025072221049</법령키><법령일련번호>269821</법령일련번호>
      <법령ID>009410</법령ID><법령명_한글>도시 및 주거환경정비법</법령명_한글>
    </기본정보></법령>`);

    assert.equal(compositeOnly.mst, undefined);
    assert.equal(explicitMst.mst, '269821');
});
