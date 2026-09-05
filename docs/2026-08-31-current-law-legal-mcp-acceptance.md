# 현행법 기반 정비사업 법률 MCP 운영 계약

## 정본과 범위

- 사용자 확정 요구사항(2026-08-31, 판례 건수·결론 gate는 2026-09-03 갱신)
  - 답변 근거는 현재 시행 중인 법령만 사용한다.
  - 현행 규정 정합성을 통과한 결론 근거 판례와, 현행법 정합성이 미확정된 관련 검토 후보를 분리한다.
  - 관련 검토 후보는 선고일 최신순으로 10건을 초과해 제공하도록 목표 상한을 12건으로 둔다.
  - 어느 목록이든 적격 판례가 12건 미만이면 실제 건수와 부족 사유를 밝히고 무관한 판례로 채우지 않는다.
  - 적용 조례와 판례의 국가법령정보센터 공식 링크를 답변에 포함한다.
- Obsidian 정본
  - `Projects/도시정비법-분석-MCP.md`
  - `Resources/정비사업-법무실무-자료집.md`
  - `Resources/정비사업-단계별-법정-동의율.md`
- 공식 외부 정본
  - 국가법령정보센터 시행일 기준 현행법령 API
  - 국가법령정보센터 현행 자치법규 API
  - 국가법령정보센터 판례 목록·본문 API
  - MCP 2026-07-28 정본, Codex 호환 2025-06-18 사양과 TypeScript SDK v2

이 변경은 법률자문을 자동 확정하는 기능이 아니라, 현행 법령·조례·판례의 검증 가능한 근거 패킷과 정형 답변을 제공하는 내부 운영 기능이다.
MCP 전송 계약과 도구명은 V1을 유지하고, 갱신된 판정 규칙은 packet provenance의
`current-law-policy.v4`로 구분한다. MCP 서버 공개 버전은 `1.3.0`이다.

## 역할별 관점

- 기획/분석: 현행성, 관할, 사건시점, 판례 선정 범위를 계약으로 고정한다.
- 구현: 법제처 provider, parser, 근거 패킷, validator, renderer, MCP transport를 분리한다.
- 리뷰: 소급 적용, 구법 판례, 검색 스니펫 인용, 링크 인증값 노출을 차단한다.
- 검증: fixture, 근거·계약 validator, MCP contract, HTTP auth, 빌드와 회귀 테스트를 분리해 통과시킨다.

## 공개 입력 계약

공개 MCP 도구는 다음 사용자 입력만 받는다.

- `question`: 질의 원문
- `jurisdiction`: 국가 `KR`, 시·도 코드/명, 필요 시 시·군·구 코드/명
- `projectType`: 재개발, 재건축, 소규모정비, 기타
- `projectStage`: 정비계획, 추진위원회, 조합설립, 사업시행, 관리처분, 청산, 기타
- `facts`: 사용자가 제공한 확인 사실 목록
- `eventDate`: 사건 발생일(선택)

고수준 조사 도구는 MCP를 호출하는 host LLM이 위 사실에서 만든 구조화
`researchPlan`도 함께 받는다. `researchPlan`은 다음 의미 정보만 표현하며,
서버가 exact match와 길이 제한을 다시 검증한다.

- `lawAnchors`: 정확한 법령명과 법종 후보
- `articleLabels`: 확인할 조문 라벨 후보
- `issueTerms`: 판례 전문에서 검증할 핵심 쟁점어
- `ordinanceRequirement`: 결론에 관할 자치법규 검토가 필요한지 여부
- `ordinanceAnchors`: 관할 코드·명칭과 자치법규명 후보. 필수인데 관할이
  없으면 비워 두어 서버가 `clarification_required`로 닫게 한다.

서버는 모든 issue가 법령 anchor와 판례 query에 각각 포함되는지, 연결된
`issueTerms` 중 적어도 하나가 질문 원문에 NFKC·공백 정규화 exact substring으로
존재하는지 검사한다. 정규화한 전체 plan, SHA-256 hash와 issue별 coverage를
`planCoverageAudit`에 보존한다. 이는 질문-쟁점의 법률적 의미가 올바르다는
자동 판정이 아니라, 엉뚱한 계획을 기계적으로 걸러내고 사후 감사하기 위한 gate다.
한 판례 query는 정확히 하나의 issueId와 정확히 하나의 lawName만 참조한다.
그 법령과 조문은 같은 issueId의 lawAnchor에 연결되어야 하며, 다른 쟁점이나
다른 법령 anchor의 조문을 한 검색 결과에 교차 차용하지 않는다.

API 서버 자체에는 LLM이 없으므로 질의 원문을 법적 쟁점으로 임의 변환하지
않는다. MCP의 `instructions`, 버전형 정책 resource, prompt가 host LLM의
`researchPlan` 작성 절차를 정형화하고, 서버는 그 계획으로 공식 자료를
조회한 뒤 결과를 결정론적으로 검증한다.

다음 값은 모델이나 사용자가 바꿀 수 없는 서버 정책이다.

- 법령: `target=eflaw`, `nw=3`
- 자치법규: `target=ordin`, `nw=1`
- 판례: `target=prec`, `sort=ddes`, 결론 근거 최대 12건과 격리된 검토 후보 최대 12건
- 기준일: 서버 수신 시점의 `Asia/Seoul` 날짜
- 공식 링크 허용 origin: HTTPS `law.go.kr` 계열

## 데이터 흐름

1. host LLM이 질문에서 법적 쟁점과 적용 후보 법령을 도출하고, 서버가 질문 exact
   검색어·쟁점별 법령/판례 coverage와 정규화 plan hash를 검증·보존한다.
2. 시행일 기준 현행 법령 목록에서 exact 법령명·법종을 확인한다.
3. 현행 본문을 조회해 조·항·호·목, 부칙, 별표를 파싱한다. 부칙·별표는
   키워드 선별 건수와 해시만 감사하며 법률 해석 완료로 표시하지 않는다.
4. 관할 코드가 있으면 정확히 일치하는 현행 자치법규를 검색하고 본문을 재조회한다.
5. 확정된 현행 법령명과 쟁점어를 결합한 본문 검색을 우선하고, 같은 상한 안에서
   법령명 검색을 보완해 판례 후보를 선고일 내림차순 수집한다. 단독 쟁점어로 완화하지 않는다.
6. 후보 판례 전문을 조회해 참조조문·판시사항·판결요지·판례내용을 검증한다.
7. 현행 조문과 판례가 해석한 규정의 동일성 또는 실질적 동등성을 검증한다.
   공식 판례 데이터에 적용 규정 버전 ID가 없으면 동일성을 단정하지 않고
   `current_rule_candidate` 유추 근거로만 표시한다.
8. 현행 규정 정합성까지 통과한 판례만 결론 근거 목록에 최대 12건 반환한다.
   공식 전문·사건 식별·정확 법령 문맥과 폐쇄형 쟁점군을 통과했지만 현행 정합성이
   미확정된 판례는 별도 `caseReviewCandidates`에 최대 12건만 반환한다.
   검토 후보는 `reviewOnly=true`, `useInConclusion=excluded`로 고정하고 결론·적용·
   `sourceIndex`·evidence에 직접 연결할 수 없게 서버가 검증한다. 사건번호·공식 URL·
   충분히 긴 고유 사건명·라벨된 판례일련번호와 40자 이상 exact 발췌 복사도 분석
   필드에서 차단하지만, 짧은 공통 문구나 의미적 의역까지 완전히 격리하는 계약은 아니다.
9. 근거 패킷을 근거·계약 validator로 검사하고 같은 객체에서 Markdown을 결정적으로 렌더링한다.
   각 서술에는 공식 원문에 exact substring으로 존재하는 `evidenceQuotes`를 요구한다.
   이 검사는 서술이 인용문에서 논리적으로 도출되는지까지 자동 보증하지 않는다.

## 현행법 acceptance

- [x] 답변 경로에서 `target=law`를 호출하지 않는다.
- [x] 연혁(`nw=1`)과 시행예정(`nw=2`) 법령을 현재 근거로 수용하지 않는다.
- [x] 모든 법령 근거에 법령ID, MST, 시행일, 조회시각, 기준일, 공식 URL이 있다.
- [x] 조·항·호·목을 근거로 보존하고, 부칙·별표는 파싱·키워드 선별 건수와 해시 및
  `keyword_screened_not_legally_interpreted` 상태로 기록한다.
- [x] 관련 부칙·별표가 선별되면 자동 해석하지 않고 blocking 검토사항으로 닫는다.
- [x] exact 법령명·법종이 일치하지 않으면 `AMBIGUOUS_LAW` 또는 `LAW_NOT_FOUND`로 닫힌다.
- [x] 캐시를 사용하지 않고 매 요청에서 현행 시행본을 공식 API로 재검증한다.
- [x] `eventDate`가 현행 규정 시행 전이면 현행법을 소급 적용하지 않는다.
- [x] `eventDate`가 조회 기준일보다 미래이면 현재 시행본의 미래 유지를 가정하지 않고
  blocking `FUTURE_EVENT_DATE`와 `temporal_scope_conflict`로 닫는다.
- [x] 과거 법령 검토가 필요한 질문은 `temporal_scope_conflict` 또는 `insufficient_evidence`를 반환한다.

## 조례 acceptance

- [x] `target=ordin`, `nw=1`만 사용한다.
- [x] 질문 관할과 지자체 코드·명칭이 exact로 일치한 자치법규만 근거로 수용한다.
- [x] 관할이 결론에 필요한데 누락되면 `clarification_required`를 반환한다.
- [x] exact 조례가 없으면 빈 배열과 `ordinanceSearchAudit.performed=true`를 반환하고,
  필수 조례였다면 blocking `ORDINANCE_NOT_FOUND`와 `insufficient_evidence`로 닫는다.
- [x] 조례를 인용하면 자치법규ID/MST, 조문별 시행일, 지자체, 조문 위치, 공식 URL이 필수다.

## 판례 acceptance

- [x] 목록 조회는 `target=prec`, `sort=ddes`를 명시한다.
- [x] 법령명+쟁점 복합 본문 검색과 법령명 보완 검색을 실제 실행 순서까지 감사 메타데이터에 남긴다.
- [x] 목록 스니펫만으로 관련 판례를 확정하지 않는다.
- [x] 모든 반환 판례는 판례일련번호로 전문을 재조회한다.
- [x] 목록과 본문의 사건번호·선고일·법원이 불일치하면 제외한다.
- [x] 목록 또는 본문의 선고일이 조회 기준일보다 미래이면 `SCHEMA_DRIFT`로 fail-closed 한다.
- [x] 판례 전문의 참조조문과 판시사항/판결요지/판례내용에서 관련성을 검증한다.
- [x] 동일 규정이 입증된 판례만 direct로 쓰며, 버전 ID가 없는 후보는 analogical로만 표시한다.
- [x] 실질 개정되었거나 적용본이 불명확한 판례는 결론 근거 목록에 포함하지 않는다.
- [x] 검토 후보도 공식 전문·목록/상세 identity·정확 법령 문맥·폐쇄형 쟁점군을 모두 요구한다.
- [x] `대표자`, `총회`, `전자` 또는 조문번호 단독 적중은 검토 후보 자격으로 인정하지 않는다.
- [x] 검토 후보는 현행법 정합성 미확정 및 결론 사용 금지를 항목마다 표시한다.
- [x] 검토 후보는 `sourceId`를 받지 않고 `sourceIndex`·evidence 참조에서 거부한다.
  분석 필드에는 사건번호·공식 URL·충분히 긴 고유 사건명·라벨된 판례일련번호 및
  현행법/결론 판례 원문과 겹치지 않는 40자 판결문 n-gram의 exact 복사를 거부한다.
- [x] 후보당 저장 match는 최대 2건이다. 쟁점별 0건은 저장된 match 기준이며, 후순위
  쟁점이 상한 때문에 미평가될 수 있으므로 전체 판례 universe에 해당 쟁점 판례가 없다는
  뜻으로 표시하지 않는다.
- [x] 결론 판례와 검토 후보 모두 판례일련번호 및 사건번호·법원·선고일 decision identity로 중복 제거한다.
- [x] 중복 제거 후 선고일 내림차순, 동률은 판례일련번호 내림차순으로 안정 정렬한다.
- [x] 목표 상한 12건만 반환한다.
- [x] 적격 판례가 12건 미만이면 실제 N건과 부족 사유를 반환하고 padding하지 않는다.
- [x] 공식 결과 소진과 upstream 미완료를 서로 다른 상태로 표현한다.
- [x] 최종 Markdown에 packet 상태와 **계획된 법령명·쟁점 검색 stream 내** 최신순
  완결성 검증/미완료, 정규화 plan hash와 실제 stream을 서버 소유 값으로 표시한다.

## 링크·보안 acceptance

- [x] 법령·조례·판례의 `officialUrl`은 HTTPS `law.go.kr` canonical 상세 경로만 허용한다.
- [x] 공개 링크는 서버가 식별자로 새로 만들며 `OC`, 토큰, 인증 쿼리를 포함하지 않는다.
- [x] 공개 URL의 출처 유형과 단일 레코드 식별자가 packet 식별자와 일치해야 한다.
- [x] 사용자 질문 전문, OC, 개인정보는 새 MCP 기본 운영 로그에 남기지 않는다.
- [x] 외부 요청 URL과 provider 제어값은 서버가 구성하며 사용자 입력 URL을 전달하지 않는다.
- [x] 전체 조사 deadline, 프로세스 전역 동시 실행·대기 상한, provider 429 fanout 중단을 적용한다.

## MCP·답변 계약 acceptance

- [x] 성공 도구는 `outputSchema`를 노출하고 `structuredContent`를 런타임 검증한다.
- [x] 서버 `instructions`에 현행법-only, 판례 전문 검증, no-padding, 공식 링크 규칙이 있다.
- [x] 상세 정책은 버전형 resource로 제공한다.
- [x] 사용자 선택형 정비사업 법률 검토 prompt를 제공한다.
- [x] prompt는 host LLM이 `researchPlan`을 만들고 조사 도구를 호출하는 순서를 명시한다.
- [x] 서버는 `researchPlan`의 controlled taxonomy, 질문 exact 검색어, 쟁점별 법령·판례
  coverage와 exact 법령명·관할·전문 쟁점 anchor를 기계적으로 검증한다.
- [x] 각 `caseQuery`는 정확히 하나의 issue와 하나의 법령만 참조하며, 법령·조문은
  같은 issue의 `lawAnchor`에 연결되어 다른 쟁점·법령 anchor를 교차 차용할 수 없다.
- [x] `LegalResearchPacketV1`은 정규화 plan/hash/coverage, 법령, 조례, 결론 판례,
  격리된 검토 후보와 각각의 검색 감사,
  미확인 사항, provenance를 포함한다.
- [x] 모든 법률 명제와 적용 판단은 존재하는 source ID를 참조한다.
- [x] 결론·법률 명제·조례 분석·판례 종합·적용 판단은 참조한 모든 sourceId마다
  해당 공식 원문의 exact substring `evidenceQuotes`를 포함한다.
- [x] `supported` 결론은 법률 명제 1건 이상, facts가 있으면 적용 판단 1건 이상을 요구한다.
- [x] blocking 미확인 사항이 있으면 `supported`·`conditional`을 모두 거부하고 `cannot_conclude`만 허용한다.
- [x] application의 사건일·참조 조문 시행일을 대조하고 미확인 사실의 high confidence를 거부한다.
- [x] renderer는 검증된 패킷과 서술 draft에서 서버 소유 필드를 조립해 고정 순서 Markdown을 생성한다.
- [x] 최종 Markdown에 현행 법령, 조례, 판례 링크가 클릭 가능한 형태로 포함된다.
- [x] renderer 결과는 `contractValidationPassed`로 표시하며 법률 해석 검증 완료로 과대 표시하지 않는다.
- [x] 근거 packet은 UTF-8 128KiB, host LLM answerDraft는 UTF-8 96KiB로 각각 검증하고,
  proof와 JSON-RPC envelope를 합친 정상 최대 요청이 HTTP 256kb parser 상한 아래인지
  contract test로 확인한다.

## 사람 검토 gate

다음은 자동화 범위다.

- 현행본·관할·공식 링크·판례 식별·날짜·정렬·검색 stream·원문 부분문자열 검증
- packet 불변 필드 조립과 고정 11개 섹션 렌더링

다음은 외부 제공 또는 실제 의사결정 전에 법률 검토자가 확인해야 한다.

- 질문을 쟁점과 법령 anchor로 매핑한 판단의 타당성
- `evidenceQuotes`가 해당 서술을 실제로 뒷받침하는지 여부
- 부칙·경과조치·법령 체계 및 판례 법리의 해석
- 사실관계의 완전성, 적용 추론과 최종 결론
- 검토 후보의 짧은 공통 문구와 의미적 의역이 결론·적용에 섞이지 않았는지 여부

validator의 sourceId/evidence/식별자/40자 exact-copy 차단은 이 사람 검토를 대체하지
않으며, 짧은 fragment나 LLM 의미적 paraphrase를 기계적으로 검출·차단한다고 보증하지
않는다. 진정한 hard isolation은 검토 후보를 암호화하거나 서버 측 별도 appendix로
분리하는 2-stage 구조가 필요하며 후속 과제다. 승인 전 결과는 내부 조사 초안이다.

## 오류와 정상 불완전 상태

- 프로토콜/상류 오류: `AUTH`, `IP_NOT_REGISTERED`, `RATE_LIMITED`, `UPSTREAM_TIMEOUT`, `UPSTREAM_UNAVAILABLE`, `SCHEMA_DRIFT`, `SOURCE_MISMATCH`
- 도메인 상태: `complete`, `partial`, `clarification_required`, `temporal_scope_conflict`, `insufficient_evidence`
- 판례 부족 사유: `official_results_exhausted`, `upstream_incomplete`, `full_text_unavailable`, `current_law_misaligned`

결론 판례나 검토 후보가 12건 미만인 것은 tool execution error가 아니라 구조화된 정상
불완전 결과다. 상류 응답 자체를 신뢰할 수 없는 경우에만 MCP `isError`를 사용한다.

## 검증 순서

1. 파서 fixture: 단일/배열 XML, 조·항·호·목, 부칙, 별표, 판례 본문, 오류 XML/HTML
2. provider 계약: 현행법·현행 조례·판례 최신순 요청 파라미터
3. 근거·계약 validator: 시점 metadata, 관할, 판례 관련성 metadata, 정렬, 링크, 참조 무결성
4. renderer snapshot: 고정 섹션과 링크
5. MCP contract: tools, output schemas, instructions, prompts, resources
6. 인증 HTTP 통합: 무인증 거부, 요청 크기, 오류 envelope
7. 전체 typecheck, build, test, 보안 점검

## 완료 정의

- 모든 acceptance와 테스트가 통과한다.
- 고정 IP 개발 환경의 live smoke에서 법령 1건, 조례 1건, 판례 검색 1건을 확인한다.
- OC가 로그·응답·공식 URL에 노출되지 않는다.
- 최신 `main`을 작업 브랜치에 병합한 뒤 동일 검증을 다시 통과한다.
- 검증된 동일 커밋만 `main`에 병합·push한다.
