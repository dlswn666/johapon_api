import assert from 'node:assert/strict';
import test from 'node:test';
import { LegalOpenApiError } from '../src/services/legal-research/errors';
import {
    parseCaseDetailXml,
    parseCaseSearchXml,
    parseCurrentLawDetailXml,
    parseCurrentLawSearchXml,
    parseCurrentOrdinanceDetailXml,
} from '../src/services/legal-research/law-open-api-parser';

test('법령 목록은 단일 노드와 배열 노드를 동일한 배열로 정규화한다', () => {
    const single = parseCurrentLawSearchXml(`<LawSearch><totalCnt>1</totalCnt><page>1</page><law>
      <법령일련번호>10</법령일련번호><법령ID>20</법령ID><법령명한글>가법</법령명한글>
    </law></LawSearch>`);
    const multiple = parseCurrentLawSearchXml(`<LawSearch><totalCnt>2</totalCnt><page>1</page>
      <law><법령일련번호>10</법령일련번호><법령ID>20</법령ID><법령명한글>가법</법령명한글></law>
      <law><법령일련번호>11</법령일련번호><법령ID>21</법령ID><법령명한글>나법</법령명한글></law>
    </LawSearch>`);

    assert.equal(single.items.length, 1);
    assert.deepEqual(multiple.items.map((item) => item.name), ['가법', '나법']);
});

test('현행법 본문은 조·항·호·목, 부칙, 별표를 구조적으로 보존한다', () => {
    const parsed = parseCurrentLawDetailXml(`<법령>
      <기본정보>
        <법령키>101</법령키><법령ID>202</법령ID><법령명_한글>도시 및 주거환경정비법</법령명_한글>
        <법종구분>법률</법종구분><시행일자>20260801</시행일자>
      </기본정보>
      <조문><조문단위>
        <조문번호>45</조문번호><조문가지번호>2</조문가지번호><조문제목>직접 출석</조문제목>
        <조문내용>총회 의결 규정</조문내용><조문시행일자>20260801</조문시행일자>
        <항><항번호>①</항번호><항내용>제1항</항내용>
          <호><호번호>1.</호번호><호내용>제1호</호내용>
            <목><목번호>가</목번호><목내용>가목</목내용></목>
            <목><목번호>나</목번호><목내용>나목</목내용></목>
          </호>
        </항>
        <항><항번호>②</항번호><항내용>제2항</항내용></항>
      </조문단위></조문>
      <부칙><부칙단위><부칙공포일자>20260701</부칙공포일자><부칙공포번호>12345</부칙공포번호>
        <부칙내용>이 법은 2026년 8월 1일부터 시행한다.</부칙내용>
      </부칙단위></부칙>
      <별표><별표단위><별표번호>1</별표번호><별표구분>별표</별표구분><별표제목>동의서</별표제목>
        <별표내용>동의서 내용</별표내용>
        <별표서식파일링크>http://www.law.go.kr/file/form.hwp?OC=secret</별표서식파일링크>
        <별표서식PDF파일링크>https://www.law.go.kr/file/form.pdf?token=secret</별표서식PDF파일링크>
      </별표단위></별표>
    </법령>`);

    assert.equal(parsed.lawId, '202');
    assert.equal(parsed.articles[0].articleNumber, '45');
    assert.equal(parsed.articles[0].branchNumber, '2');
    assert.equal(parsed.articles[0].paragraphs.length, 2);
    assert.equal(parsed.articles[0].paragraphs[0].items[0].subItems[1].content, '나목');
    assert.equal(parsed.addenda[0].promulgationNo, '12345');
    assert.equal(parsed.appendices[0].title, '동의서');
    assert.equal(parsed.appendices[0].fileUrl?.includes('OC='), false);
    assert.equal(parsed.appendices[0].pdfUrl?.includes('token='), false);
    assert.match(parsed.appendices[0].fileUrl ?? '', /^https:/);
});

test('자치법규 본문도 조문·부칙·별표의 단일 노드를 보존한다', () => {
    const parsed = parseCurrentOrdinanceDetailXml(`<자치법규>
      <자치법규ID>300</자치법규ID><자치법규일련번호>301</자치법규일련번호>
      <자치법규명>서울특별시 도시 및 주거환경정비 조례</자치법규명><지자체기관명>서울특별시</지자체기관명>
      <시행일자>20260801</시행일자>
      <조문><조문단위><조문번호>1</조문번호><조제목>목적</조제목><조내용>목적 내용</조내용></조문단위></조문>
      <부칙><부칙단위><부칙내용>시행일</부칙내용></부칙단위></부칙>
      <별표><별표단위><별표번호>1</별표번호><별표제목>기준</별표제목></별표단위></별표>
    </자치법규>`);

    assert.equal(parsed.ordinanceId, '300');
    assert.equal(parsed.authorityName, '서울특별시');
    assert.equal(parsed.articles[0].title, '목적');
    assert.equal(parsed.addenda[0].content, '시행일');
    assert.equal(parsed.appendices[0].title, '기준');
});

test('판례 목록 링크와 판례 전문 필드를 구분해 파싱한다', () => {
    const list = parseCaseSearchXml(`<LawSearch><totalCnt>1</totalCnt><page>1</page><prec>
      <판례일련번호>700</판례일련번호><사건명>조합설립인가무효</사건명><사건번호>2025두1234</사건번호>
      <선고일자>20260820</선고일자><법원명>대법원</법원명>
      <판례상세링크>http://www.law.go.kr/DRF/lawService.do?OC=secret&amp;target=prec&amp;ID=700</판례상세링크>
    </prec></LawSearch>`);
    const detail = parseCaseDetailXml(`<PrecService>
      <판례정보일련번호>700</판례정보일련번호><사건명>조합설립인가무효</사건명><사건번호>2025두1234</사건번호>
      <선고일자>20260820</선고일자><선고>선고</선고><법원명>대법원</법원명><법원종류코드>400201</법원종류코드>
      <판시사항>직접 출석의 의미</판시사항><판결요지>전자적 의결의 한계</판결요지>
      <참조조문>도시 및 주거환경정비법 제45조</참조조문><참조판례>대법원 2024두1</참조판례>
      <판례내용><![CDATA[판례 전문 내용]]></판례내용>
    </PrecService>`);

    assert.equal(list.items[0].officialUrl?.includes('OC='), false);
    assert.equal(detail.caseSerialId, '700');
    assert.equal(detail.holdings, '직접 출석의 의미');
    assert.equal(detail.summary, '전자적 의결의 한계');
    assert.equal(detail.referenceProvisions, '도시 및 주거환경정비법 제45조');
    assert.equal(detail.fullText, '판례 전문 내용');
});

test('판례 최신순 탐색에 필요한 totalCnt와 page는 누락·비정수 값을 허용하지 않는다', () => {
    const item = `<prec><판례일련번호>700</판례일련번호><사건명>조합설립인가무효</사건명></prec>`;
    for (const xml of [
        `<LawSearch><page>1</page>${item}</LawSearch>`,
        `<LawSearch><totalCnt>1</totalCnt>${item}</LawSearch>`,
        `<LawSearch><totalCnt>unknown</totalCnt><page>1</page>${item}</LawSearch>`,
        `<LawSearch><totalCnt>1</totalCnt><page>one</page>${item}</LawSearch>`,
        `<LawSearch><totalCnt>0</totalCnt><page>1</page>${item}</LawSearch>`,
    ]) {
        assert.throws(
            () => parseCaseSearchXml(xml),
            (error: unknown) => error instanceof LegalOpenApiError
                && error.code === 'SCHEMA_DRIFT'
        );
    }
});

test('오류 XML·HTML과 필수 필드 누락은 안전한 provider 오류로 닫힌다', async (t) => {
    await t.test('unregistered IP XML', () => {
        assert.throws(
            () => parseCurrentLawSearchXml('<Response><resultCode>1</resultCode><resultMsg>등록되지 않은 IP입니다.</resultMsg></Response>'),
            (error: unknown) => error instanceof LegalOpenApiError && error.code === 'IP_NOT_REGISTERED',
        );
    });
    await t.test('authentication HTML', () => {
        assert.throws(
            () => parseCurrentLawSearchXml('<html><body>인증값 OC 오류</body></html>'),
            (error: unknown) => error instanceof LegalOpenApiError && error.code === 'AUTH',
        );
    });
    await t.test('schema drift', () => {
        assert.throws(
            () => parseCurrentLawSearchXml('<LawSearch><totalCnt>1</totalCnt></LawSearch>'),
            (error: unknown) => error instanceof LegalOpenApiError && error.code === 'SCHEMA_DRIFT',
        );
    });
});
