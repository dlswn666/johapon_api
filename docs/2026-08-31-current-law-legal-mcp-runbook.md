# 현행 정비사업 법률 MCP 운영 런북

## 운영 표면

- modern MCP 2026-07-28 endpoint: `POST /mcp` (`legacy: reject`; bodyless GET/DELETE 세션 방식은 405)
- 공개 도구
  - `research_current_urban_renewal_law_v1`
  - `render_legal_answer_v1`
- prompt: `review_current_urban_renewal_law_v1`
- 정책 resource: `tonghari-law://policy/current-answer/v1`
- health: `GET /health` 또는 `GET /health/detailed`의
  `features.legalMcpConfigurationValid`

MCP 경로는 기존 Express 전역 JSON parser보다 먼저 mount되며, 전용 요청
크기는 256kb로 제한된다. 필수 환경변수가 하나라도 없으면 MCP 경로만 503
`LEGAL_MCP_NOT_CONFIGURED`로 닫히고 기존 API 기능은 계속 동작한다.
현재 전송 표면은 서버 간 MCP client 전용이다. 브라우저 CORS/preflight는 제공하지
않으므로 웹 화면에서 `/mcp`를 직접 호출하지 않는다.

## 필수 환경변수

| 변수 | 의미 | 저장 규칙 |
|---|---|---|
| `LAW_API_OC` | 고정 IP가 등록된 국가법령정보 공동활용 인증값 | secret, 로그 금지 |
| `LEGAL_MCP_TOKEN_SHA256` | MCP bearer 원문의 SHA-256 hex | digest만 서버 저장 |
| `LEGAL_MCP_PACKET_SIGNING_KEY` | 조사 패킷 HMAC용 256-bit 이상 hex | bearer와 별도 생성 |
| `LEGAL_MCP_ALLOWED_HOSTS` | 요청 Host 허용 hostname | scheme·port·path·wildcard 금지 |
| `LEGAL_MCP_ALLOWED_ORIGINS` | Origin header를 보내는 서버 간 client의 허용 hostname(선택) | 브라우저 CORS 허용값이 아님; 일반 서버 간 client는 비워 둠 |
| `LEGAL_MCP_RESEARCH_DEADLINE_MS` | admission 대기를 포함한 1회 전체 조사 마감 | 기본 45000ms |
| `LEGAL_MCP_RESEARCH_MAX_CONCURRENCY` | 프로세스 전역 동시 조사 상한 | 기본 2 |
| `LEGAL_MCP_RESEARCH_MAX_QUEUE` | 프로세스 전역 조사 대기 상한 | 기본 4 |

운영 bearer는 충분히 긴 난수로 생성하고 원문은 호출 측 secret store에만 둔다.
서버에는 그 원문의 SHA-256 digest만 저장한다. packet signing key도 별도 난수로
생성하며 bearer와 재사용하지 않는다. `.env`와 원문 bearer는 저장소에 커밋하지
않는다.

## Host LLM 호출 계약

1. prompt를 읽고 사용자 질의를 `question`, 관할, 사업 유형·단계, 사실,
   사건일과 구조화 `researchPlan`으로 만든다.
   - 모든 issue를 적어도 한 개의 lawAnchor와 caseQuery에 각각 연결한다.
   - issue별 연결 검색어 중 적어도 하나는 질문 원문에 exact로 존재해야 한다.
   - 관할 조례가 결론에 필요하면 `ordinanceRequirement=required`로 둔다.
   - required인데 관할이 없으면 관할을 추정하지 않고 `ordinanceAnchors=[]`로 호출해
     서버의 `clarification_required` 결과를 따른다.
2. `research_current_urban_renewal_law_v1`을 호출한다. 모델이 `target`, `nw`,
   `sort`, page, URL 또는 인증값을 지정할 수는 없다.
3. 반환된 `packet.status`와 `unknowns`를 먼저 확인한다.
   - `clarification_required`: 필요한 관할·사건일을 사용자에게 확인한다.
   - `temporal_scope_conflict`: 현행법을 과거 사건에 소급 적용하거나 현재 시행본이
     미래 사건일까지 유지된다고 가정하지 않는다.
   - `insufficient_evidence`: 확정 결론을 만들지 않는다.
   - `partial`: 상류 조회가 완전하지 않음을 답변에 유지한다.
4. `packet`과 `packetProof`는 byte-equivalent JSON 의미를 유지한다. LLM은
   `answerDraft`의 결론·법률 명제·조례 분석·판례 종합·사실 적용·시점 검토·경고만
   작성한다. 각 문장은 packet의 정확한 조문·판시사항·판결요지 범위를 넘지 않고
   사용한 모든 sourceId와 해당 source 원문에 exact substring으로 존재하는 짧은
   `evidenceQuotes`를 연결한다. `supported` 결론에는 법률 명제 1건 이상, packet에
   facts가 있으면 적용 판단 1건 이상이 필요하다.
5. `render_legal_answer_v1`을 호출한다. 서버가 packetId, 상태, 사실, 미확인
   사항, 출처 색인, 판례 건수·최신순·부족 사유·검색 stream 범위·정규화 plan hash·
   상류 완결성과 고정 면책문구를 자동 조립한다.
6. render 도구가 반환한 Markdown을 수정하거나 링크를 다시 쓰지 않고 표시한다.

`sourceIds`는 packet에 실제 존재하는 값만 사용한다. 법률 명제에는 law source,
조례 분석에는 ordinance source를 연결한다. 사실 적용에는 사용한 factId와 모든
법령·조례·판례 sourceId를 명시한다. blocking unknown이 있으면 결론 종류는
`cannot_conclude`로 둔다.

패킷은 발급 후 30분 이내, 현재 한국 날짜의 `asOfDate`일 때만 render할 수 있다.
근거·계약 validator는 출처 ID, 원문 exact substring 인용, 현행성 metadata, 관할,
정렬, 링크, 상태와 형식을 검증한다. 인용문이 서술을 논리적으로 뒷받침하는지,
쟁점 선택과 법률 해석이 타당한지는 자동 보증하지 않는다.

## 서버가 강제하는 조사 정책

- 법령 목록: `target=eflaw`, `nw=3`(현행)
- 자치법규 목록: `target=ordin`, `nw=1`(현행), 요청 관할 코드·명칭 exact match
- 판례 목록: `target=prec`, `sort=ddes`, 한 page 최대 100건
- 판례 선정: 공식 전문과 목록 식별자 재검증 → exact 법령·조문 및 쟁점 관련성
  → 현행 규정 정합성 gate → 선고일 내림차순 → 최대 10건
- 선고일 안전: 조회 기준일 뒤 선고일이 목록·본문에 있으면 schema drift로 전체 요청을 닫음
- 최신성 범위: `planCoverageAudit`의 정규화 plan/hash와 실제 법령명·쟁점 query stream
  안에서만 최신순 완결성을 주장하며 전체 판례 universe의 최신성을 주장하지 않음
- 10건 미만: 검색 조건을 완화하거나 구법·무관 판례로 채우지 않고 실제 건수와
  `shortfallReason`을 반환
- 공개 링크: HTTPS 국가법령정보센터의 레코드별 공개 상세 URL만 허용; API OC와
  인증 query는 반환 금지
- 호출 보호: 공식 API를 사용하는 research 도구는 bearer 세대별 분당 6회로 제한
- 부하 보호: admission 대기 포함 전체 45초 deadline, 프로세스 전역 동시 2건·대기
  4건. queue 초과 또는 provider 429이면 남은 fanout을 시작하지 않음
- 현행 법령 조문이 0건이면 판례의 현행 규정 정합성을 검증할 수 없으므로 판례
  목록·상세 fanout을 시작하지 않음
- 부칙·별표: 파싱 후 쟁점 조문·검색어로 선별한 건수와 해시만 감사하며, 관련 자료가
  있으면 `SUPPLEMENTAL_MATERIAL_REVIEW_REQUIRED`로 자동 결론을 차단

## 배포 전·후 확인

1. EC2 고정 IP와 `LAW_API_OC` 등록 상태를 확인한다.
2. 필수 환경변수 4개와 서버 간 client가 Origin header를 보낼 때의 정책을 secret/runtime 설정에
   반영해 새 컨테이너를 배포한다. 단순
   `docker restart`는 변경 환경변수를 다시 읽지 않으므로 사용하지 않는다.
3. `/health`에서 `legalMcpConfigurationValid=true`를 확인한다. 이 값은 설정의
   존재·형식만 뜻하며 provider reachability를 뜻하지 않는다. secret 값 자체는
   조회하거나 로그에 남기지 않는다.
4. 등록된 고정 IP에서 다음 read-only smoke를 실행한다.
   - 현행 법령 exact 검색 및 본문 1건
   - 관할 현행 조례 exact 검색 및 본문 1건
   - 판례 최신순 목록과 전문 1건
   - research → packet proof → answerDraft → render 전체 1회
5. 응답·로그에 `OC`, bearer, signing key, 사용자 질문 전문이 남지 않는지 확인한다.
6. 법령·조례·판례 링크를 비로그인 브라우저에서 열어 레코드 식별자가 일치하는지
   확인한다.

## 장애·회전

- `AUTH`, `IP_NOT_REGISTERED`: OC와 법제처 등록 고정 IP를 확인한다.
- `RATE_LIMITED`, `UPSTREAM_TIMEOUT`, `UPSTREAM_UNAVAILABLE`: 확정 답변으로
  변환하지 말고 재시도 가능한 상류 장애로 취급한다.
- `SCHEMA_DRIFT`, `SOURCE_MISMATCH`: 자동 우회하지 말고 parser/식별자 계약을
  검토한다.
- bearer를 회전하면 token ID가 달라져 기존 packet proof를 재사용할 수 없다.
- signing key를 회전하면 모든 기존 packet proof가 무효화된다. 진행 중인 research와
  render 호출 사이에는 회전하지 않는다.

## 외부 제공 전 사람 검토

render 성공과 `contractValidationPassed=true`는 근거 연결·현행성·형식 계약 통과를
뜻하며 법률 해석 승인 표식이 아니다. 외부 사용자 또는 실제 의사결정에 제공하기 전
법률 검토자가 다음을 확인한다.

1. 질문과 `planCoverageAudit.normalizedPlan`의 쟁점·법령 매핑
2. 각 `evidenceQuote`가 연결된 결론·명제·적용을 실제로 지지하는지
3. 부칙·경과조치, 상하위 법령 체계와 판례의 적용 범위
4. 제공 사실·미확인 사실·사건일과 최종 결론

승인 전 결과는 내부 조사 초안으로만 취급한다.

이 기능은 공식 근거를 정형화하는 내부 운영 도구이며 변호사의 구체적 법률자문을
대체하지 않는다.
