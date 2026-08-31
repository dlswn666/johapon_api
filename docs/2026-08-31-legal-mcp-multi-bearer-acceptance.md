# 법률 MCP 외부 Bearer 연결 운영 계약

## 목표와 범위

- 신뢰된 외부 MCP 클라이언트마다 서로 다른 Bearer token을 발급한다.
- 클라이언트는 모든 `POST /mcp` 요청의 `Authorization: Bearer <token>` 헤더에만
  원문 token을 넣는다. query, JSON body, cookie, MCP tool input에는 token을 넣지 않는다.
- 서버는 token 원문을 저장하지 않고 SHA-256 digest와 안전한 `clientId`만 설정으로 받는다.
- 이번 버전은 소수의 사전 등록된 운영 클라이언트용 정적 credential이다. 불특정 사용자
  공개나 사용자 로그인형 연결은 OAuth 2.1 도입 전까지 범위 밖이다.

## 정본

- 사용자 요구: 다른 MCP 클라이언트에서도 Bearer token 입력으로 법률 MCP 사용
- Obsidian: `Projects/도시정비법-분석-MCP.md`
- 기존 계약: `docs/2026-08-31-current-law-legal-mcp-acceptance.md`
- MCP HTTP Authorization: 매 요청 `Authorization: Bearer`, URI token 금지

## 역할별 관점

- 기획/분석: 입력 위치, client 식별, legacy 전환, 회전·폐기 경계를 고정한다.
- 구현: registry parser, auth verifier, HTTPS proxy 증명, rate limit, 발급 도구를 분리한다.
- 리뷰: token 노출, plain HTTP 우회, client 간 packet proof 재사용, noisy-neighbor를 점검한다.
- 검증: parser/auth 단위 테스트, 실제 HTTP 계약, cross-client proof, 전체 회귀를 실행한다.

## Acceptance checklist

### 설정과 인증

- [ ] `LEGAL_MCP_TOKEN_REGISTRY_JSON`은 strict
  `{ "version": 1, "clients": [{ "clientId", "tokenSha256" }] }` 형식만 허용한다.
- [ ] clients는 1~32개이며 `clientId`는 길이 제한 lowercase ASCII slug,
  `tokenSha256`은 정확히 64자리 hex다.
- [ ] 알 수 없는 필드, raw `token` 필드, 중복 clientId, 중복 digest가 하나라도 있으면
  전체 설정을 fail-closed 한다.
- [ ] registry와 legacy `LEGAL_MCP_TOKEN_SHA256`이 동시에 있으면 우선순위나 병합 없이
  전체 설정을 invalid 처리한다.
- [ ] legacy만 있으면 기존 `tonghari-legal-mcp` principal과 packet proof subject를 유지한다.
- [ ] registry token은 설정된 `clientId`, 고정 `law:research` scope와 digest 기반
  `tokenId`를 반환한다. 호출자가 보낸 clientId는 신뢰하지 않는다.
- [ ] missing, malformed, wrong, removed token은 401이며 원문·digest·registry를 응답이나
  로그에 포함하지 않는다.

### HTTPS와 입력 위치

- [ ] `/mcp`는 Caddy가 `X-Forwarded-Proto: https`와 별도 proxy token을 주입한 요청만
  Bearer 인증 단계로 보낸다.
- [ ] API 서버에는 proxy token의 SHA-256 digest만 저장한다.
- [ ] Caddy는 외부가 보낸 proxy 증명 header를 제거하고 자신의 값을 덮어쓴다.
- [ ] direct public `http://<EC2>:3100/mcp`와 위조 forwarded proto는 403으로 닫는다.
- [ ] public 3100 inbound가 남아 있는 동안에도 proxy 증명 없는 `/mcp`는 사용할 수 없다.
- [ ] 외부 클라이언트 설정은 HTTPS endpoint와 Authorization header만 사용한다.
- [ ] 브라우저 CORS, token 입력 웹 폼, localStorage 저장은 추가하지 않는다.

### 격리, 제한, 회전

- [ ] packet proof subject는 계속 `clientId:tokenId`여서 A의 packet/proof를 B나 회전된
  token으로 render할 수 없다.
- [ ] research rate limit은 token 세대별 기본 6회/분과 프로세스 전체 기본 12회/분을
  함께 적용한다. 기존 전체 동시 2건·대기 4건 제한도 유지한다.
- [ ] A의 개별 bucket 소진은 B의 개별 bucket을 소진하지 않지만 global bucket은 공유한다.
- [ ] token 생성 도구는 256-bit 난수를 사용하고 원문을 한 번만 보여주며 서버용 digest와
  registry entry를 함께 출력한다.
- [ ] 기존 token을 등록하는 digest 모드는 TTY no-echo 또는 stdin만 사용하고 argv, URL,
  로그에 token을 넣지 않는다.
- [ ] 회전은 새 clientId 세대 추가·배포 → client 전환 확인 → 구 항목 제거·재배포 순서다.
  제거된 token은 즉시 401이며 진행 중 구 packet proof도 사용할 수 없다.

### 상태와 문서

- [ ] health에는 configuration valid, auth mode, client 수와 token 수만 표시하며 clientId,
  digest, registry 원문은 표시하지 않는다.
- [ ] 설정이 invalid/missing이면 token 유무와 무관하게 `/mcp`는 stable 503으로 닫힌다.
- [ ] 설정이 valid하면 bad Host/Origin/proxy가 auth보다 먼저 거부되고, bad Bearer는 401,
  valid Bearer 뒤 bad JSON은 400/413이다.
- [ ] Codex, Claude Code, VS Code, generic HTTP client의 secret 입력 예시를 제공한다.
- [ ] 정적 Bearer는 실제 자동 만료·OAuth discovery·refresh가 없으며 신뢰된 운영
  클라이언트용이라는 한계를 문서화한다.

## 실행 순서

1. strict registry와 verifier를 구현하고 legacy 호환을 고정한다.
2. Caddy proxy 증명과 HTTPS gate를 auth 앞에 배치한다.
3. per-token/global limiter를 적용하고 packet proof 격리를 확인한다.
4. token 생성·digest 도구와 클라이언트 설정 런북을 추가한다.
5. 표적 테스트, 법률 MCP 전체, 저장소 전체 build/test/audit를 실행한다.
6. 최신 main을 작업 브랜치에 merge하고 같은 검증을 다시 실행한다.
7. main push 뒤 자동 배포 revision과 fail-closed 운영 상태를 확인한다.

## 완료 기준

- 위 acceptance와 독립 보안 리뷰가 통과한다.
- 전체 저장소 회귀가 0 failure다.
- 운영 secret이 없을 때 배포된 `/mcp`는 계속 503이다.
- 외부 token 발급 전 Caddy proxy token과 법령 API OC를 secret/runtime에 반영하고,
  HTTPS endpoint에서 client별 research → render live smoke를 통과한다.
- 외부 법률 답변은 기존 계약대로 법률 검토자 승인 전 내부 조사 초안이다.
