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
  `features.legalMcpAuthSource`,
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
| `LEGAL_MCP_TOKEN_REGISTRY_FILE` | 운영 권장 client registry JSON의 container 절대 경로 | regular non-symlink, app UID 1001 소유, mode `600` |
| `LEGAL_MCP_TOKEN_REGISTRY_JSON` | 최초 file 이전·로컬 개발용 registry. `{"version":1,"clients":[{"clientId":"<lowercase-slug>","tokenSha256":"<sha256-hex>"}]}` | 1~32 client, raw bearer 금지 |
| `LEGAL_MCP_TOKEN_SHA256` | 단일 client용 legacy bearer digest | 하위 호환용; 신규 운영에는 사용하지 않음 |
| `LEGAL_MCP_PROXY_TOKEN_SHA256` | Caddy 전용 raw proxy secret의 SHA-256 hex | API에는 digest만 저장 |
| `LEGAL_MCP_PACKET_SIGNING_KEY` | 조사 패킷 HMAC용 256-bit 이상 hex | bearer와 별도 생성 |
| `LEGAL_MCP_ALLOWED_HOSTS` | 요청 Host 허용 hostname | scheme·port·path·wildcard 금지 |
| `LEGAL_MCP_ALLOWED_ORIGINS` | Origin header를 보내는 서버 간 client의 허용 hostname(선택) | 브라우저 CORS 허용값이 아님; 일반 서버 간 client는 비워 둠 |
| `LEGAL_MCP_RESEARCH_REQUESTS_PER_MINUTE` | bearer 하나의 research 분당 제한 | 기본 6 |
| `LEGAL_MCP_RESEARCH_GLOBAL_REQUESTS_PER_MINUTE` | 모든 bearer를 합산한 프로세스 분당 제한 | 기본 12 |
| `LEGAL_MCP_RESEARCH_DEADLINE_MS` | admission 대기를 포함한 1회 전체 조사 마감 | 기본 45000ms |
| `LEGAL_MCP_RESEARCH_MAX_CONCURRENCY` | 프로세스 전역 동시 조사 상한 | 기본 2 |
| `LEGAL_MCP_RESEARCH_MAX_QUEUE` | 프로세스 전역 조사 대기 상한 | 기본 4 |

`LEGAL_MCP_TOKEN_REGISTRY_FILE`, `LEGAL_MCP_TOKEN_REGISTRY_JSON`,
`LEGAL_MCP_TOKEN_SHA256` 중 둘 이상을 동시에 설정하면 우선순위나 병합 없이
잘못된 구성으로 판정해 `/mcp`를 503으로 닫는다. legacy 단일 digest는 기존 client
호환용일 뿐이며, 운영에서는 file registry만 사용한다. 운영 bearer 원문은
발급 시 한 번만 전달하고 호출 측 OS·client secret store에만 둔다. 서버에는 그 원문의
SHA-256 digest만 저장한다. proxy raw secret은 Caddy owner-only secret에만, 그
digest는 API에만 둔다. client bearer, proxy secret, packet signing key를 서로
재사용하지 않고 `.env`나 저장소에 원문을 커밋하지 않는다.

## EC2 file registry와 hot reload

소수 초대 client 운영은 DB 대신 다음 단일 EC2 registry를 사용한다.

```text
host directory  /home/ubuntu/alimtalk-proxy/.legal-mcp-secrets
host file       /home/ubuntu/alimtalk-proxy/.legal-mcp-secrets/clients.json
container dir   /run/secrets/tonghari-legal-mcp
container file  /run/secrets/tonghari-legal-mcp/clients.json
```

host directory는 숫자 UID/GID `1001:1001`, mode `700`, `clients.json`은
UID `1001`, mode `600`을 유지한다. file GID는 canonical `1001` 또는 기존 이미지가
최초 생성한 legacy `65533`만 허용한다. legacy file도 group permission이 없고 상위
directory가 `1001:1001`, mode `700`이므로 다른 group에 읽기 권한을 주지 않는다.
이미지는 `nodejs`의 UID/GID가 정확히 `1001:1001`인지 build 중 검증한다. 새 배포의
`init-from-env`와 registry updater도 모두 명시적으로 `1001:1001`로 실행하고, 성공한
mutation postcondition은 file GID `1001`을 강제해 새 file과 첫 atomic 갱신부터
canonical GID로 수렴했음을 증명한다. 이미지의 `nodejs` process가 UID 1001이므로
`ubuntu:ubuntu 600`은 읽을 수 없다. 메인 container에는 파일 하나가 아니라 상위
directory를 다음과 같이 read-only bind mount한다.

```text
type=bind,src=/home/ubuntu/alimtalk-proxy/.legal-mcp-secrets,dst=/run/secrets/tonghari-legal-mcp,readonly
```

file 자체를 bind mount하면 host의 atomic rename 후에도 container가 구 inode를
볼 수 있으므로 금지한다. 서버는 각 auth·health 요청에서 변경 fingerprint를
확인하고 변경된 file을 재검증한다. 누락, symlink, 권한 오류, schema 오류가
발생하면 기존 snapshot을 계속 사용하지 않고 즉시 fail-closed한다.

최초 배포는 새 이미지의 no-network one-shot helper가 EC2 `.env`의
`LEGAL_MCP_TOKEN_REGISTRY_JSON`을 직접 읽어 file을 초기화한다. GitHub input,
step environment, stdout으로 registry를 옮기지 않는다. 원본 `.env`는 유지한 채
file-only mode `600` next env로 candidate와 final을 검증한다. final health가
통과한 시점이 commit point이다. 그 전 실패는 기존 env container로 복구하고,
그 후에는 새 file-mode container를 유지하며 다음 순서로 마감한다.

1. 구 env-mode rollback container 제거와 부재 확인
2. next env를 `.env`로 atomic install하고 JSON·legacy key 부재 확인
3. deploy-user 소유 mode `600` migration marker 생성

commit point 후 cleanup이 실패하면 구 token을 복원하지 않고 새 container를
유지한 채 배포를 실패 처리한다. marker 생성 후의 rollback은 동일 host
directory를 동일 container directory에 read-only mount하고 file-only env를 쓰는
container만 허용한다. 구 env digest container는 서비스 중단을 감수하고라도
자동으로 살리지 않는다.

이 1회 작업은 기존 client ID와 digest를 저장 위치만 바꾸는 **migration**이며
token **rotation**이 아니다. 기존 token을 폐기하려면 migration 완료 후 아래의
별도 add → 새 token smoke → revoke 절차를 수행한다.

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
전달한 뒤 client secret store에 저장한다. 서버에는 `registryEntry`의
`clientId`와 `tokenSha256`만 file registry에 추가한다. `client-digest`와 smoke
명령은 TTY에서 raw bearer를 표시하지 않고 입력받는다.

### GitHub Actions 수동 레지스트리 워크플로

`.github/workflows/legal-mcp-client-registry.yml`은 보호 environment
`legal-mcp-registry`에서만 수동 실행한다. 소수 초대 사용자의 정상 운영 경로는 이
workflow이며, 아래 직접 SSH 절차는 workflow를 사용할 수 없을 때의 break-glass
절차로만 남긴다. 지원 action은 registry mutation인 `add`, `revoke`, read-only인
`list`, `validate`, 불확실 상태의 증거만 정리하는 `recover` 다섯 가지다.
workflow 전체에는 `legal-mcp-client-registry-production` concurrency group과
`cancel-in-progress: false`가 적용되어 원격 prepare부터 동시에 두 작업이 실행되지
않는다. 대기 순서를 승인 순서로 간주하지 말고 각 dispatch의 input을 독립 검토한다.
`operation_id`와 `client_id`는 사람 이름, 이메일, 장비명,
token 또는 digest를 유추할 수 없는 opaque 값으로 만든다.
`operation_id`는 mutation마다 새로 만들고 재사용하지 않으며, 회전할 때도 새 세대
`client_id`를 발급한다.

`add`에서만 environment secret `LEGAL_MCP_REGISTRY_PENDING_SHA256`에 로컬에서 만든
64자리 `tokenSha256`을 임시 저장한다. raw bearer와 digest는 반드시 감사된 로컬
`npm run legal:mcp:token -- client-generate ...` 또는 `client-digest ...`로 만들고,
raw bearer는 Keychain 등 client secret store와 client 소유자에게만 남긴다.
workflow input `pending_digest_commitment`는 다음 객체의 필드 순서를 그대로 사용한
`JSON.stringify` 결과에 대한 SHA-256이다.

```text
SHA-256(JSON.stringify({
  version: 1,
  operationId: "<opaque-operation-id>",
  action: "add",
  clientId: "<opaque-client-id>",
  tokenSha256: "<64-hex-token-digest>"
}))
```

운영 순서는 **environment secret 설정 → 대응하는 ID·commitment로 dispatch 1회 →
최종 상태까지 대기 → environment secret 삭제**다. mutation을 겹쳐 실행하거나
`add`, `revoke`, `recover`에 GitHub의 re-run을 사용하지 않는다. digest 전달은
runner shell → SSH stdin만
사용하고, 원격 environment, argv, 임시·전달용 file 또는 log에 넣지 않는다.
성공한 updater가 canonical `clients.json` entry로 저장하는 digest 외에 별도 사본을
남기지 않는다. raw bearer도 workflow에 입력하지 않는다.

`add`/`revoke`는 원격 operator 실행과 runner 확인을 분리한 **2단계
`operate → ACK` protocol**을 사용한다. 현재 호환 경로명은
`.legal-mcp-registry-commit-unknown`이지만, 이 file은 unknown 전용이 아닌
**미해결 operation marker**다. `version=3`은 run key, operation, operation ID,
client ID, 예상 pre/post client count·target state와 outcome만 보존하며 raw
bearer나 token digest를 포함하지 않는다.

1. operator는 read-only precheck로 현재 count와 target의 `present|absent`를 고정하고
   exact updater container를 `docker create`로 준비한다.
2. `docker start -a`를 호출하기 **전** `outcome=intent`인 v3 marker를 mode `600`
   regular file로 생성하고 file과 parent directory를 sync한다. 이 durable intent를
   쓸 수 없거나 다시 읽어 동일성을 증명할 수 없으면 updater를 시작하지 않는다.
3. operator는 attach rc가 아닌 exact container의 `.State.Status=exited`와
   `.State.ExitCode`를 authoritative result로 쓴다. 이후 marker를 같은
   identity의 terminal outcome으로 atomic replace·sync한다.

| marker outcome | 의미 | 후속 동작 |
|---|---|---|
| `verified` | updater exit 0, 예상 post count/state, loopback health, app container 동일성을 모두 재검증함 | runner가 독립 ACK |
| `known-precommit` | mutation precondition 불일치이거나, updater exit 1/64 뒤 writer residue 부재와 exact pre count/state를 재검증해 canonical registry가 변경되지 않음을 증명함 | runner가 독립 ACK한 뒤 원인을 고치고 새 operation ID로 dispatch |
| `unknown` | exit·container·writer residue·postcondition 중 하나라도 증명할 수 없음 | 재시도 금지, read-only 조사 후 guarded `recover` |

`intent`, `verified`, `known-precommit`, `unknown` 중 어느 상태든 marker가 남아
있으면 후속 `add`/`revoke`를 모두 차단한다. 다만 판정을 위한 read-only
`list`와 `validate`는 허용한다. runner는 operate SSH에서 `verified` 또는
`known-precommit`을 수신해도 완료로 간주하지 않고, 독립된 두 번째 SSH로
ACK를 실행한다. ACK는 workflow에 노출된 여섯 번째 action이 아니라
동일 dispatch 내부의 protocol phase다. 후속 mutation gate는 이 **pending marker의
존재**로 미해결 operation을 차단한다. 정상 terminal receipt 자체는 새 mutation을
차단하지 않지만, ledger 전체의 형식과 terminal outcome을 먼저 검증하므로
unknown/mismatch/임시 receipt는 fail-closed한다.

ACK는 production flock 안에서 v3 marker의 run key·operation·operation ID·client
ID·pre/post count/state·terminal outcome이 runner가 수신한 exact identity/state와 모두
같은지, 그리고 현재 registry·health·app container가 그 outcome과 일치하는지
다시 확인한다. 모두 맞을 때만 deploy-user 소유 mode `700`의 symlink가
아닌 `.legal-mcp-registry-receipts/` directory를 확인·생성하고, pending marker와
동일한 내용을 같은 filesystem의 `${runKey}` mode `600` regular file로 atomic
publish·sync한 뒤 pending marker를 제거한다. 따라서 ACK는 marker의 증거를
폐기하는 것이 아니라 해결된 **영구 receipt**로 보존하며, registry entry는 변경하지 않는다.
receipt는 marker와 같이 raw bearer나 token digest를 포함하지 않는 감사 증거다.
workflow outer cleanup과 `recover`는 이미 publish된 durable receipt를
삭제·덮어쓰기·이동하지 않는다. `recover`가 다루는 이동은 exact하게 검증된 receipt
임시 file을 그 durable 경로로 publish하는 경우뿐이다.
ACK는 pending marker를 바로 rename하지 않는다. receipt 임시 file을 먼저 mode
`600`으로 기록·검증·sync하고, 이를 receipt 경로에 atomic publish한 뒤 receipt
directory까지 sync한다. 그 다음에만 pending marker를 제거하고 application
directory를 sync한다. 따라서 중단 시 pending marker, durable receipt, 또는 둘 다가
남아 판정 근거가 사라지지 않는다. 최초 ACK가 nonzero이면 workflow는 mutation을
재실행하지 않고 동일 identity/outcome의 ACK를 한 번 더 멱등 호출한다. 이 호출은
pending marker와 exact하게 같은 SHA-256·identity·terminal outcome을 가진 durable
receipt가 이미 있으면 registry count/target, health, app container를 다시 검증한 뒤
receipt는 보존하고 marker만 retire한다. exact receipt 임시 file만 있으면 file을
다시 검증·sync하고 receipt 경로에 atomic publish한 뒤 directory를 sync하고 marker를
retire한다. durable receipt와 임시 file이 동시에 있거나 어느 하나라도 owner, mode,
형식, identity, outcome, hash가 다르면 어떤 증거도 지우지 않고 fail-closed한다.

ACK SSH/transport 응답이 유실되면 runner는 mutation을 재실행하지 않고 원격
pending/receipt를 확인한다. pending marker가 없고 `${runKey}` receipt가 exact
identity/state/outcome과 mode를 모두 만족하면 ACK는 완료된 것이다. terminal pending
marker와 그 marker에 exact하게 묶인 receipt 또는 receipt 임시 file이 함께 남아 있으면
위 ACK resume 또는 동일 `client_id`와 승인 count/state를 사용하는 guarded `recover`가
수렴시킬 수 있다. marker만 남은 경우도 현재 상태를 `list`/`validate`로 확인한 뒤
guarded `recover`로 넘어간다. receipt-only `unknown`, identity/hash가 다른 receipt,
durable receipt와 임시 file의 동시 존재, 또는 exact 판정을 할 수 없는 상태는
fail-closed로 보존하고 break-glass 수동 조사로 넘어간다.

`recover`는 새 dispatch에 미해결 marker의 동일 `client_id`, 운영자가 직접
확인한 현재 정수 count인 `expected_client_count`, 해당 ID의 현재 상태인
`expected_client_state=present|absent`를 함께 입력한다. production flock 안에서
다음을 모두 다시 증명한다.

- marker와, 남아 있다면 marker가 가리키는 stale run directory,
  `operator.sh`, 선택적 `active`가 deploy user 소유의 예상 mode인 실제
  file/directory이며 symlink가 아니다.
- 현재 recovery run과 marker가 가리키는 stale run(있을 때) 외의 operation residue가 없다.
- registry updater container, `clients.json.lock`, `.clients.json.*.tmp`가 없다.
- read-only registry `list`의 target state/count가 승인 input과 정확히 같고,
  loopback health와 실행 중 app container ID/image가 검사 시작 시점부터 변하지 않았다.
- terminal marker와 receipt가 함께 있으면 둘은 동일 owner/mode의 regular file이고
  내용 hash, run key, operation, operation ID, client ID, pre/post state, outcome이
  exact하게 같다. receipt 임시 file인 경우도 같은 조건이며 durable receipt와 동시에
  존재해서는 안 된다.

marker가 `verified`면 현재 상태는 기록된 post count/state와, `known-precommit`이면
기록된 pre count/state와 같아야 한다. `intent`/`unknown`이면 기록된 pre와
post 중 정확히 한 쪽과만 일치해야 한다. 어느 쪽인지 추측하거나 두 상태가
구분되지 않으면 recover를 거부한다.

`active`는 run key와 PID만이 아니라 kernel boot ID와 `/proc/<pid>/stat` start
time을 함께 기록한다. recover와 workflow outer cleanup은 현재 boot ID·PID·start
time이 모두 같은 process가 살아 있으면 해당 run residue를 절대 정리하지
않는다. PID 숫자만으로 종료를 판정하지 않고, process identity를
정확히 읽지 못하거나 liveness가 모호하면 모든 증거를 보존한다.

stale run directory 정리는 삭제 순서 자체도 멱등 상태기계로 다룬다. 정상 삭제
순서 `active → operator.sh → run directory`에서 중단될 수 있으므로 recover는
exact하게 attested된 `{active+operator}`, `{operator}`, `{empty directory}`와 이미
directory가 사라진 marker-only 상태만 허용한다. 각 상태에서 실제로 남은 file과
directory의 inode·owner·mode·content hash를 다시 고정하고 남은 단계부터 이어간다.
`{active only}`는 이 삭제 순서에서 도달할 수 없으므로, unexpected entry와 함께
fail-closed한다. run directory 제거 뒤에는 run parent directory를 반드시 sync한
다음 pending marker를 retire한다.

모든 guard가 맞을 때만 recover가 exact receipt 임시 file을 durable receipt로
publish할 필요가 있으면 file과 directory를 먼저 sync하고, 기존 durable receipt는
그대로 보존한 채 stale run residue와 v3 marker만 정리한다. filesystem sync 뒤에는
list/target/count, loopback health, 동일 app container를 다시 검증한다. recover는
`clients.json` entry를 추가·삭제·복원하지 않고 registry lock/temp를 force cleanup하지
않으며, 영구 receipt를 삭제·덮어쓰기하지 않는다. 조건이 하나라도
다르면 marker와 residue를 그대로 둔 채 닫는다. 실패한 recover 자체가
새 marker를 만들거나 기존 marker를 덮어쓰지 않는다.

host registry directory는 UID/GID `1001:1001`, mode `700`이라 일반 SSH deploy
user가 내부 file을 직접 `stat`/`find`할 수 없다. operator는 host 경로 접근 실패를
"lock/temp 없음"으로 해석하지 않는다. 검증된 현재 app container의 read-only bind
mount 안에서 UID/GID 1001 helper를 실행해 directory/file의 lstat·realpath·mode와
file GID가 canonical `1001` 또는 legacy `65533`인지,
`clients.json.lock`/`.clients.json.*.tmp` 부재를 증명하며, Docker 열거 또는 helper
실행이 실패하면 0건으로 간주하지 않고 fail-closed한다.

`version=1`·`version=2` 등 legacy operation marker, 읽을 수 없는 v3 필드, identity/state
불일치, 예상하지 않은 residue, 살아 있거나 liveness를 증명할 수 없는
process는 자동 ACK/recover 대상이 아니다. marker를 v3로 임의 변환하거나
삭제하지 말고, production lock 아래에서 증거를 보존한 채 break-glass
수동 조사로 넘어간다.

새 `add`/`revoke`는 pending marker뿐 아니라 receipt ledger 전체도 검사한다. receipt
directory와 각 entry가 예상 owner/mode의 non-symlink regular file이고, filename과
run key가 같으며, outcome이 `verified|known-precommit`이고 operation 전이가 유효해야
한다. receipt 임시 file, `intent|unknown` receipt, 잘못된 identity/transition/file
contract가 하나라도 있으면 새 mutation을 시작하지 않는다. `list`/`validate`는
이 증거를 조사할 수 있도록 계속 허용한다.

ACK 또는 nonmutation operator의 자체 cleanup도 `operator.sh` unlink와 run directory
제거 사이에서 중단될 수 있다. 다음 `add`/`revoke`는 production flock을 획득하고
pending marker, registry writer lock/temp, updater container가 없음을 확인한 뒤에만
현재 run 이외의 markerless residue를 수렴시킨다. 허용 상태는 같은 삭제 순서의
`{active+operator}`, `{operator}`, `{empty directory}`뿐이며, active가 있으면
boot ID·PID·start time으로 process가 살아 있지 않음을 증명한다. terminal receipt가
있는 old run은 ledger 검증에 더해 receipt inode/hash가 cleanup 동안 동일한지도
재검증하고 receipt 자체는 보존한다. markerless pre-intent/nonmutation residue도 같은
file contract와 liveness를 만족할 때만 정리한다. `{active only}`, unknown entry,
identity 변경, ambiguous liveness는 새 mutation을 시작하지 않고 모든 residue를
보존한다. 마지막에는 run parent directory를 sync하므로 이전 시도의 `rmdir → sync`
중단점도 다음 mutation이 안전하게 수렴시킨다.

회전은 새 opaque ID `add` → 새 raw bearer로 `tools/list` HTTP 200 → 구 ID
`revoke` → 구 raw bearer HTTP 401 순서다. 이 file hot reload는 DB, API 재배포
또는 container 재시작이 필요 없다.

운영 갱신은 배포와 같은 `.tonghari-api-production.lock`을 획득한 뒤 현재
container의 immutable image를 one-shot updater로 사용한다. `add`의 digest는
argv·environment가 아닌 hidden TTY/stdin으로만 넘긴다.

```bash
# 추가: 프롬프트에 tokenSha256 64자를 숨김 입력한다.
(
  set -Eeuo pipefail
  cd /home/ubuntu/alimtalk-proxy
  production_lock_path="$(pwd -P)/.tonghari-api-production.lock"
  if [[ ! -e "${production_lock_path}" && ! -L "${production_lock_path}" ]]; then
    (umask 077; set -o noclobber; : > "${production_lock_path}") \
      2>/dev/null || true
  fi
  if [[ ! -f "${production_lock_path}" || -L "${production_lock_path}" ]] \
    || [[ "$(stat -c %u "${production_lock_path}")" != "$(id -u)" ]] \
    || [[ "$(stat -c %a "${production_lock_path}")" != 600 ]]; then
    echo 'production lock이 안전한 mode 600 regular file이 아닙니다.' >&2
    exit 1
  fi
  exec 9>>"${production_lock_path}"
  flock -w 30 9 || exit 1
  test "$(<.legal-mcp-file-registry-v1)" = 'version=1'
  registry_image="$(docker container inspect --format '{{.Image}}' alimtalk-proxy)"
  docker run --rm -it \
    --name tonghari-legal-mcp-registry-updater \
    --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges \
    --mount type=bind,src="$(pwd)/.legal-mcp-secrets",dst=/registry \
    "${registry_image}" \
    node dist/cli/legal-mcp-registry.js add \
      --path /registry/clients.json --client-id claude-mac-202609
)

# 폐기: 원문과 digest를 입력하지 않는다.
(
  set -Eeuo pipefail
  cd /home/ubuntu/alimtalk-proxy
  production_lock_path="$(pwd -P)/.tonghari-api-production.lock"
  if [[ ! -e "${production_lock_path}" && ! -L "${production_lock_path}" ]]; then
    (umask 077; set -o noclobber; : > "${production_lock_path}") \
      2>/dev/null || true
  fi
  if [[ ! -f "${production_lock_path}" || -L "${production_lock_path}" ]] \
    || [[ "$(stat -c %u "${production_lock_path}")" != "$(id -u)" ]] \
    || [[ "$(stat -c %a "${production_lock_path}")" != 600 ]]; then
    echo 'production lock이 안전한 mode 600 regular file이 아닙니다.' >&2
    exit 1
  fi
  exec 9>>"${production_lock_path}"
  flock -w 30 9 || exit 1
  test "$(<.legal-mcp-file-registry-v1)" = 'version=1'
  registry_image="$(docker container inspect --format '{{.Image}}' alimtalk-proxy)"
  docker run --rm \
    --name tonghari-legal-mcp-registry-updater \
    --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges \
    --mount type=bind,src="$(pwd)/.legal-mcp-secrets",dst=/registry \
    "${registry_image}" \
    node dist/cli/legal-mcp-registry.js revoke \
      --path /registry/clients.json --client-id old-client-202608
)
```

updater는 같은 directory의 mode `600` 임시 file을 검증·fsync한 뒤 atomic
rename한다. 실행 중 container는 다음 auth 또는 health 요청에서 새 inode를
읽으므로 재배포·재시작·signal이 필요 없다.
변경 후 `curl -fsS http://127.0.0.1:3100/health`에서 valid, source와 예상
count를 확인한 뒤 client 장비의 hidden raw token으로 `tools/list` smoke를
실행한다. health는 token 자체가 아닌 file 형식과 개수만 증명한다.

- 폐기: `revoke`가 atomic commit된 후에는 후속 health/smoke 오류가 있어도
  폐기 전 file을 자동 복원하지 않는다.
- 마지막 1개 client는 단독 `revoke`할 수 없다. 긴급 회전도 새 세대 ID를 먼저
  `add`한 뒤 구 ID를 `revoke`하거나, 동일 ID를 유지해야 하면 검증된 새 digest를
  `add --replace`로 교체한다.
- 무중단 회전: 새 세대 ID(예: 월 suffix) `add` → **새 raw token**으로
  `tools/list` HTTP 200 확인 → 구 ID `revoke` → health count와 `list` 확인 →
  가능하면 구 raw token의 `tools/list` 401 확인 순서로 실행한다. 새 token의
  성공을 확인하기 전에 구 ID를 폐기하지 않는다.
- 동일 `clientId` 또는 동일 digest의 중복 entry는 금지된다.
- 긴급 회전: 의심 token entry를 즉시 제거한다. token digest가 packet proof 주체에
  포함되므로 제거·회전한 token의 기존 proof를 재사용하지 않는다.
- registry나 token 원문을 health, 응답, access log, 오류 추적 시스템에 기록하지 않는다.

mutation의 operate가 exit `75`, SSH `255`, signal 종료, stdin/SSH 전송 불명으로
끝나거나 v3 pending marker가 여전히 보이면 add/revoke를 바로 재실행하지
않는다. workflow의 read-only `validate`와 `list`로 count·client ID를 확인하고
목표 상태를 운영자가 판정한 뒤, 승인한 count/state로 guarded `recover`를
실행해 pending operation 증거만 정리한다. ACK 응답만 유실된 경우는
먼저 exact `${runKey}` receipt를 확인한다. pending marker가 없고 유효한 receipt만
있으면 ACK 완료이므로 recover를 실행하지 않는다. 같은 terminal marker가 함께
남아 있거나 exact receipt 임시 file이 함께 남아 있으면 ACK 중단 상태이므로 동일
client의 승인 count/state로 recover를 실행해 receipt를 보존·완성하고 marker만
retire할 수 있다.
digest나 raw token을 확인 명령의 argv·environment·출력에 넣지 않는다.

CLI가 비정상 종료되어 `clients.json.lock` directory나 registry temp가 남았거나,
operation marker가 legacy/unverifiable하면 workflow `recover`는 이를 삭제·변환하지
않고 실패한다. 다음 절차는 자동화된 recover와 분리한 break-glass 수동
조사 절차다. 모든 updater가 같은 global flock을 사용한다는
전제에서 production lock을 획득하고, updater container가 없으며, lock directory가
UID 1001 소유 mode `700`인 빈 실제 directory일 때만 `rmdir`한다. 이후 registry를
다시 validate한다.

```bash
(
  set -Eeuo pipefail
  cd /home/ubuntu/alimtalk-proxy
  production_lock_path="$(pwd -P)/.tonghari-api-production.lock"
  if [[ ! -e "${production_lock_path}" && ! -L "${production_lock_path}" ]]; then
    (umask 077; set -o noclobber; : > "${production_lock_path}") \
      2>/dev/null || true
  fi
  if [[ ! -f "${production_lock_path}" || -L "${production_lock_path}" ]] \
    || [[ "$(stat -c %u "${production_lock_path}")" != "$(id -u)" ]] \
    || [[ "$(stat -c %a "${production_lock_path}")" != 600 ]]; then
    echo 'production lock이 안전한 mode 600 regular file이 아닙니다.' >&2
    exit 1
  fi
  exec 9>>"${production_lock_path}"
  flock -w 30 9 || exit 1
  test "$(<.legal-mcp-file-registry-v1)" = 'version=1'
  if docker container inspect tonghari-legal-mcp-registry-updater \
    >/dev/null 2>&1; then
    echo 'registry updater가 존재하므로 lock을 제거하지 않습니다.' >&2
    exit 1
  fi
  registry_image="$(docker container inspect --format '{{.Image}}' alimtalk-proxy)"
  docker run --rm \
    --name tonghari-legal-mcp-registry-lock-recovery \
    --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges \
    --mount type=bind,src="$(pwd)/.legal-mcp-secrets",dst=/registry \
    "${registry_image}" \
    sh -eu -c '
      lock_path=/registry/clients.json.lock
      stale_count=0
      test -d "${lock_path}"
      test ! -L "${lock_path}"
      test "$(stat -c %u "${lock_path}")" = "$(id -u)"
      test "$(stat -c %a "${lock_path}")" = 700
      test -z "$(find "${lock_path}" -mindepth 1 -maxdepth 1 -print -quit)"
      node dist/cli/legal-mcp-registry.js validate \
        --path /registry/clients.json
      for temp_path in /registry/.clients.json.*.tmp; do
        if test ! -e "${temp_path}" && test ! -L "${temp_path}"; then
          continue
        fi
        stale_count=$((stale_count + 1))
        test "${stale_count}" -le 8
        test -f "${temp_path}"
        test ! -L "${temp_path}"
        test "$(stat -c %u "${temp_path}")" = "$(id -u)"
        test "$(stat -c %a "${temp_path}")" = 600
      done
      for temp_path in /registry/.clients.json.*.tmp; do
        if test -f "${temp_path}" && test ! -L "${temp_path}"; then
          rm -f -- "${temp_path}"
        fi
      done
      test -z "$(find /registry -mindepth 1 -maxdepth 1 \
        -name ".clients.json.*.tmp" -print -quit)"
      rmdir -- "${lock_path}"
      node -e '\''
        const fs = require("node:fs");
        const descriptor = fs.openSync("/registry", fs.constants.O_RDONLY);
        try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      '\''
      node dist/cli/legal-mcp-registry.js validate \
        --path /registry/clients.json
    '
)
```

lock이 symlink·파일이거나, owner/mode가 다르거나, 내부가 비어 있지 않거나,
updater 존재 여부가 불명확하면 자동 정리하지 말고 보존한 채 원인을 조사한다.
legacy/unverifiable marker도 같은 원칙으로 수동 판정하며, raw bearer나 token
digest를 조사 로그에 출력하지 않는다.

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
   - 각 caseQuery는 정확히 하나의 issueId와 정확히 하나의 lawName만 참조한다.
   - caseQuery의 법령·조문은 같은 issueId의 lawAnchor에 연결하고, 다른 issue나
     다른 법령 anchor의 조문을 교차 차용하지 않는다.
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
   `evidenceQuotes`를 연결한다. `supported` 결론에는 법률 명제 1건 이상이 필요하다.
   blocking unknown이 없고 packet에 facts가 있으면 적용 판단 1건 이상이 필요하며,
   blocking unknown이 있으면 서버가 결론을 고정 유보문으로 바꾸고 적용 판단을 비운다.
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
  → 현행 규정 정합성 gate → 선고일 내림차순 → 최대 12건
- 선고일 안전: 조회 기준일 뒤 선고일이 목록·본문에 있으면 schema drift로 전체 요청을 닫음
- 최신성 범위: `planCoverageAudit`의 정규화 plan/hash와 실제 법령명·쟁점 query stream
  안에서만 최신순 완결성을 주장하며 전체 판례 universe의 최신성을 주장하지 않음
- 12건 미만: 검색 조건을 완화하거나 구법·무관 판례로 채우지 않고 실제 건수와
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
2. file registry, proxy digest, packet signing key, Host·Origin 정책과 rate limit을
   API secret/runtime에 반영한다. file·JSON·legacy digest는 정확히 하나만 둔다.
3. Caddy owner-only secret에 proxy raw 값을 반영하고 `caddy validate`를 통과한 뒤
   reload한다. Caddy의 raw 값과 API digest가 같은 발급 쌍인지 값 자체를 출력하지
   않는 승인 기록으로 확인한다.
4. 최초 file 전환은 자동 배포 workflow의 candidate → final → legacy rollback
   제거 → env/marker commit 순서로만 수행한다. 일반 환경변수 변경은 새
   API container 배포가 필요하지만 file registry add/revoke는 그렇지 않다.
5. `/health`에서 다음 비밀 비노출 상태를 확인한다.
   - `legalMcpConfigurationValid=true`
   - 신규 다중 client 운영이면 `legalMcpAuthMode=client_registry`
   - EC2 file 운영이면 `legalMcpAuthSource=file_registry`
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

- `LEGAL_MCP_NOT_CONFIGURED`: file·JSON·legacy digest의 동시 설정, 빈 registry,
  중복 client ID/digest, proxy digest·signing key·Host 설정 누락을 먼저 확인한다.
- health의 `legalMcpConfigurationValid=false`, `legalMcpAuthSource=file_registry`:
  registry file 누락·symlink, UID/GID·mode, 크기, JSON schema를 확인한다.
  startup에서 invalid하면 route는 503, 실행 중 손상이면 기존 mounted route의
  모든 bearer는 401 `invalid_token`으로 fail-closed한다. 이전 valid snapshot으로
  복귀하지 말고 정상 file을 atomic replace한다.
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
