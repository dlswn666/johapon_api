# 현행 정비사업 법률 MCP 운영 런북

## 운영 표면

- modern MCP 2026-07-28 endpoint: `POST /mcp` (`legacy: reject`; bodyless GET/DELETE 세션 방식은 405)
- 공개 도구
  - `research_current_urban_renewal_law_v1`
  - `render_legal_answer_v1`
- prompt: `review_current_urban_renewal_law_v1`
- 정책 resource: `tonghari-law://policy/current-answer/v1`
- health: `GET /health` 또는 `GET /health/detailed`의
  `features.legalMcpConfigurationValid`, `features.legalMcpAuthMode`,
  `features.legalMcpRegisteredClientCount`, `features.legalMcpRegisteredTokenCount`

MCP 경로는 기존 Express 전역 JSON parser보다 먼저 mount되며, 전용 요청
크기는 256kb로 제한된다. 필수 환경변수가 하나라도 없으면 MCP 경로만 503
`LEGAL_MCP_NOT_CONFIGURED`로 닫히고 기존 API 기능은 계속 동작한다.
현재 전송 표면은 신뢰된 외부 MCP client용 정적 bearer 방식이다. 공개 endpoint는
반드시 TLS를 종료하는 Caddy를 통해서만 노출하고 API의 3100 포트는 인터넷에서
직접 접근할 수 없게 닫는다. API는 Caddy가 주입한 proxy 증명과
`X-Forwarded-Proto: https`를 bearer보다 먼저 검사한다. 브라우저 CORS/preflight와
토큰 입력 화면은 제공하지 않으므로 웹 화면에서 `/mcp`를 직접 호출하지 않는다.

## 필수 환경변수

| 변수 | 의미 | 저장 규칙 |
|---|---|---|
| `LAW_API_OC` | 고정 IP가 등록된 국가법령정보 공동활용 인증값 | secret, 로그 금지 |
| `LEGAL_MCP_TOKEN_REGISTRY_JSON` | 권장 다중 client registry. `{"version":1,"clients":[{"clientId":"<lowercase-slug>","tokenSha256":"<sha256-hex>"}]}` | 1~32 client, raw bearer 금지 |
| `LEGAL_MCP_TOKEN_SHA256` | 단일 client용 legacy bearer digest | registry와 동시 설정 금지; 신규 운영에는 사용하지 않음 |
| `LEGAL_MCP_PROXY_TOKEN_SHA256` | Caddy 전용 raw proxy secret의 SHA-256 hex | API에는 digest만 저장 |
| `LEGAL_MCP_PACKET_SIGNING_KEY` | 조사 패킷 HMAC용 256-bit 이상 hex | bearer와 별도 생성 |
| `LEGAL_MCP_ALLOWED_HOSTS` | 요청 Host 허용 hostname | scheme·port·path·wildcard 금지 |
| `LEGAL_MCP_ALLOWED_ORIGINS` | Origin header를 보내는 서버 간 client의 허용 hostname(선택) | 브라우저 CORS 허용값이 아님; 일반 서버 간 client는 비워 둠 |
| `LEGAL_MCP_RESEARCH_REQUESTS_PER_MINUTE` | bearer 하나의 research 분당 제한 | 기본 6 |
| `LEGAL_MCP_RESEARCH_GLOBAL_REQUESTS_PER_MINUTE` | 모든 bearer를 합산한 프로세스 분당 제한 | 기본 12 |
| `LEGAL_MCP_RESEARCH_DEADLINE_MS` | admission 대기를 포함한 1회 전체 조사 마감 | 기본 45000ms |
| `LEGAL_MCP_RESEARCH_MAX_CONCURRENCY` | 프로세스 전역 동시 조사 상한 | 기본 2 |
| `LEGAL_MCP_RESEARCH_MAX_QUEUE` | 프로세스 전역 조사 대기 상한 | 기본 4 |

`LEGAL_MCP_TOKEN_REGISTRY_JSON`과 `LEGAL_MCP_TOKEN_SHA256`을 둘 다 설정하면
잘못된 구성으로 판정해 `/mcp`를 503으로 닫는다. legacy 단일 digest는 기존 client
호환용일 뿐이며, 외부 client가 둘 이상이면 registry만 사용한다. 운영 bearer 원문은
발급 시 한 번만 전달하고 호출 측 OS·client secret store에만 둔다. 서버에는 그 원문의
SHA-256 digest만 저장한다. proxy raw secret은 Caddy owner-only secret에만, 그
digest는 API에만 둔다. client bearer, proxy secret, packet signing key를 서로
재사용하지 않고 `.env`나 저장소에 원문을 커밋하지 않는다.

## Bearer 발급·폐기·회전

client ID는 client와 발급 세대를 식별하는 lowercase 영문·숫자·단일 하이픈 조합
1~64자로 정한다. 사람 이름이나 이메일 같은 개인정보는 넣지 않는다.

```bash
# 신규 client용 256-bit bearer와 registry entry 생성
npm run legal:mcp:token -- client-generate --client-id codex-mac-202609

# 기존 bearer를 숨김 입력해 digest와 registry entry만 재생성
npm run legal:mcp:token -- client-digest --client-id codex-mac-202609

# Caddy와 API 사이의 별도 proxy 증명 생성
npm run legal:mcp:token -- proxy-generate
```

`client-generate`는 raw bearer를 딱 한 번 stdout에 표시한다. 전체 출력을 티켓·메신저·
CI log에 붙이지 말고, raw bearer만 승인된 보안 전달 수단으로 client 소유자에게
전달한 뒤 client secret store에 저장한다. 서버 설정에는 `registryEntry`의
`clientId`와 `tokenSha256`만 합쳐 `LEGAL_MCP_TOKEN_REGISTRY_JSON`을 만든다.
`client-digest`와 smoke 명령은 TTY에서 raw bearer를 표시하지 않고 입력받는다.

- 폐기: 해당 registry entry를 제거하고 새 runtime 설정으로 컨테이너를 교체한다.
- 무중단 회전: 새 세대 ID(예: 월 suffix)로 새 entry를 추가해 client 전환과 smoke를
  마친 뒤 구 entry를 제거한다. 동일 `clientId` 또는 동일 digest의 중복 entry는 금지된다.
- 긴급 회전: 의심 token entry를 즉시 제거한다. token digest가 packet proof 주체에
  포함되므로 제거·회전한 token의 기존 proof를 재사용하지 않는다.
- registry나 token 원문을 health, 응답, access log, 오류 추적 시스템에 기록하지 않는다.

이 방식은 신뢰된 service client에 사전 공유한 **정적 bearer 인증**이며 OAuth가
아니다. 사용자 로그인, 동적 client 등록, consent, scope, refresh token, 짧은 수명의
access token 발급·철회를 제공하지 않는다. 불특정 다수 사용자나 제3자 앱에 개방할
때는 MCP Authorization 규격에 맞춘 OAuth 2.1 resource/authorization server로
전환한다. 참고:
[MCP Authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

## Caddy TLS·proxy 증명

Caddy는 외부 요청의 동명 proxy header와 `X-Forwarded-Proto`를 Caddy process만
읽는 raw secret 및 고정 `https` 값으로 덮어쓴다. API에는 그 raw 값의 digest인
`LEGAL_MCP_PROXY_TOKEN_SHA256`만 설정한다. 다음은 `/mcp` route의 최소 예시다.

```caddyfile
api.tonghari.kr {
    @legal_mcp path /mcp
    handle @legal_mcp {
        reverse_proxy 127.0.0.1:3100 {
            header_up X-Forwarded-Proto https
            header_up X-Tonghari-MCP-Proxy-Token {$LEGAL_MCP_PROXY_TOKEN}
        }
    }

    handle {
        reverse_proxy 127.0.0.1:3100
    }
}
```

Caddy 공식 문서에서 prefix 없는 `header_up <field> <value>`는 외부의 기존 값을
덮어쓴다. 삭제 연산을 같은 필드의 설정 연산과 함께 두지 않는다. `{$ENV}`는 Caddyfile
parse 시 환경변수 치환이다. `/mcp`에서는 `X-Forwarded-Proto`도 `https`로 명시한다.
matcher가 있는 첫 `handle`과
matcher 없는 fallback `handle`은 mutually exclusive이므로 일반 API routing은
유지하면서 `/mcp`에만 proxy 증명을 주입한다. 근거:
[reverse_proxy headers](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers),
[Caddyfile 환경변수](https://caddyserver.com/docs/caddyfile/concepts#environment-variables),
[handle](https://caddyserver.com/docs/caddyfile/directives/handle).

`LEGAL_MCP_PROXY_TOKEN` 원문은 Caddy service owner만 읽는 secret/credential에 두고
API container 환경, client, 저장소, 배포 로그로 넘기지 않는다. 값이 비어 있으면
Caddy reload를 진행하지 않는다. 3100은 loopback에만 bind하거나 보안그룹·host
firewall에서 외부 ingress를 차단한다. Docker `0.0.0.0:3100:3100` 공개와
보안그룹 3100 허용은 운영 금지다. Host allowlist나 proxy header 검증은 TLS와
network-level 포트 차단을 대체하지 않는다.

## 외부 MCP client의 Bearer 입력

모든 client는 `Authorization: Bearer <raw-token>` HTTP header로만 전송한다. token을
MCP tool argument, JSON body, URL query/fragment, cookie, 브라우저 form,
`localStorage`에 넣지 않는다. 공유 설정 파일에는 secret reference만 두고 raw 값은
각 client의 secret store에 입력한다.

### Codex / ChatGPT desktop

raw bearer는 `TONGHARI_LEGAL_MCP_TOKEN`이라는 client-side 환경변수/secret store에
주입하고 `~/.codex/config.toml`에는 이름만 기록한다.

```toml
[mcp_servers.tonghari_legal]
url = "https://api.tonghari.kr/mcp"
bearer_token_env_var = "TONGHARI_LEGAL_MCP_TOKEN"
enabled = true
required = true
enabled_tools = ["research_current_urban_renewal_law_v1", "render_legal_answer_v1"]
```

OpenAI 공식 설정의 `bearer_token_env_var`는 지정한 환경변수 값을
`Authorization` header로 보낸다. 같은 Codex host의 ChatGPT desktop, Codex CLI,
IDE extension은 MCP 설정을 공유한다. 반면 **ChatGPT web은 로컬 Codex 설정 파일을
읽지 않으며**, web에서 쓰려면 별도 plugin이 제공하는 remote MCP 도구 경로가
필요하다. 근거: [OpenAI Codex MCP 설정](https://developers.openai.com/codex/mcp).

### Claude Code

`.mcp.json`에는 raw 값을 넣지 않고 client 환경변수를 참조한다.

```json
{
  "mcpServers": {
    "tonghari-legal": {
      "type": "http",
      "url": "https://api.tonghari.kr/mcp",
      "headers": {
        "Authorization": "Bearer ${TONGHARI_LEGAL_MCP_TOKEN}"
      }
    }
  }
}
```

환경변수 header 확장은 Claude Code 공식 MCP 설정 형식이다. project scope 설정을
공유하더라도 raw 값은 각 사용자가 따로 주입한다. 근거:
[Claude Code MCP 환경변수 header](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson).

### VS Code

VS Code의 `promptString` + `password: true` 입력을 사용하면 최초 시작 시 token을
가린 입력창으로 받아 secure credential store에 보관할 수 있다.

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "tonghari-legal-token",
      "description": "통하리 법률 MCP Bearer token",
      "password": true
    }
  ],
  "servers": {
    "tonghari-legal": {
      "type": "http",
      "url": "https://api.tonghari.kr/mcp",
      "headers": {
        "Authorization": "Bearer ${input:tonghari-legal-token}"
      }
    }
  }
}
```

근거: [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration#_input-variables-for-sensitive-data).

### 일반 MCP SDK/client

Streamable HTTP endpoint를 HTTPS URL로 설정하고 연결을 만들 때 secret store에서
읽은 값을 `Authorization` header에만 주입한다. command line argument에 raw 값을
직접 쓰면 shell history/process list에 남을 수 있으므로 피한다.

```text
endpoint = "https://api.tonghari.kr/mcp"
headers.Authorization = "Bearer " + secretStore.read("tonghari-legal-mcp")
redirect = "error"
```

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
- 호출 보호: 공식 API를 사용하는 research 도구는 bearer digest별 분당 6회,
  모든 bearer 합산 프로세스별 분당 12회로 제한
- 부하 보호: admission 대기 포함 전체 45초 deadline, 프로세스 전역 동시 2건·대기
  4건. queue 초과 또는 provider 429이면 남은 fanout을 시작하지 않음
- 현행 법령 조문이 0건이면 판례의 현행 규정 정합성을 검증할 수 없으므로 판례
  목록·상세 fanout을 시작하지 않음
- 부칙·별표: 파싱 후 쟁점 조문·검색어로 선별한 건수와 해시만 감사하며, 관련 자료가
  있으면 `SUPPLEMENTAL_MATERIAL_REVIEW_REQUIRED`로 자동 결론을 차단

## 배포 전·후 확인

1. EC2 고정 IP와 `LAW_API_OC` 등록 상태를 확인한다.
2. client registry, proxy digest, packet signing key, Host·Origin 정책과 rate limit을
   API secret/runtime에 반영한다. registry와 legacy digest는 정확히 하나만 둔다.
3. Caddy owner-only secret에 proxy raw 값을 반영하고 `caddy validate`를 통과한 뒤
   reload한다. Caddy의 raw 값과 API digest가 같은 발급 쌍인지 값 자체를 출력하지
   않는 승인 기록으로 확인한다.
4. 변경 환경변수를 반영해 새 API container를 배포한다. 단순 `docker restart`는
   변경 환경변수를 다시 읽지 않으므로 사용하지 않는다.
5. `/health`에서 다음 비밀 비노출 상태를 확인한다.
   - `legalMcpConfigurationValid=true`
   - 신규 다중 client 운영이면 `legalMcpAuthMode=client_registry`
   - 등록 client/token count가 승인 manifest와 일치
   - health에 client ID, digest, registry JSON, raw secret이 없음

   이 상태는 설정의 존재·형식만 뜻하며 provider reachability를 뜻하지 않는다.
6. network와 TLS 경계를 별도로 확인한다.
   - 인터넷의 별도 host에서 public IP의 TCP 3100 연결이 실패한다.
   - API host loopback에서 proxy 증명 없이 `/mcp`를 호출하면
     `403 LEGAL_MCP_PROXY_FORBIDDEN`이다. production Host allowlist가 domain-only이면
     다음처럼 허용된 Host를 명시해 Host guard가 아닌 proxy guard 응답을 확인한다.

     ```bash
     curl -sS -X POST -H 'Host: api.tonghari.kr' \
       http://127.0.0.1:3100/mcp
     ```
   - HTTP URL에는 bearer를 보내지 않는다. Caddy의 HTTP 요청은 HTTPS로만 전환되고
     평문 HTTP upstream 경로에서 MCP가 처리되지 않는지 확인한다.
   - HTTPS 인증서 hostname/chain이 유효하고 redirect 없이 최종 `/mcp`에 도달한다.
7. 각 발급 client에서 raw token을 숨김 입력해 modern `tools/list` smoke를 실행한다.

   ```bash
   npm run legal:mcp:smoke -- --endpoint https://api.tonghari.kr/mcp
   ```

   이 명령은 credential·query·fragment가 없는 HTTPS endpoint만 허용하고 redirect를
   거부하며 응답 body나 token을 출력하지 않는다. 정상 token은 HTTP 200, 폐기·오입력
   token은 성공하지 않아야 한다. 최소 두 client가 각자 token으로 성공하고, 한
   client의 폐기가 다른 client를 막지 않는지도 회전 staging에서 확인한다.
8. 등록된 고정 IP에서 다음 read-only provider/contract smoke를 실행한다.
   - 현행 법령 exact 검색 및 본문 1건
   - 관할 현행 조례 exact 검색 및 본문 1건
   - 판례 최신순 목록과 전문 1건
   - research → packet proof → answerDraft → render 전체 1회
9. 두 bearer를 번갈아 호출해 bearer별 분당 6회와 전체 분당 12회가 독립적으로
   적용되고, `Retry-After`가 있는 429가 확정 법률 답변으로 변환되지 않는지 확인한다.
10. 응답·로그에 `OC`, bearer, proxy secret, digest, signing key, 사용자 질문 전문이
   남지 않는지 확인한다.
11. 법령·조례·판례 링크를 비로그인 브라우저에서 열어 레코드 식별자가 일치하는지
   확인한다.

## 장애·회전

- `LEGAL_MCP_NOT_CONFIGURED`: registry와 legacy digest의 동시 설정, 빈 registry,
  중복 client ID/digest, proxy digest·signing key·Host 설정 누락을 먼저 확인한다.
- `LEGAL_MCP_PROXY_FORBIDDEN`: direct 3100 접근, 비 HTTPS forwarding, Caddy raw
  proxy secret과 API digest 불일치 여부를 확인한다. client bearer를 바꾸어 우회하지
  않는다.
- HTTP 401: 해당 client entry와 client secret store의 발급 세대를 확인한다. token
  원문을 로그나 support ticket로 수집하지 않는다.
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
