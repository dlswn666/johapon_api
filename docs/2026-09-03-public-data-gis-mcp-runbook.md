# 통하리 공공 GIS MCP 운영 런북

## 운영 표면

- endpoint: `POST /gis-mcp` (modern Streamable HTTP, legacy reject)
- read-only tools: acceptance 문서의 versioned 5개 도구
- prompt: 공개 데이터 검토 prompt 1개
- resource: `tonghari-gis://policy/public-data/v1`
- health: `GET /health`, `GET /health/detailed`의 `gisMcp*` 필드

필수 설정이 없거나 형식이 잘못되면 `/gis-mcp`만 503
`GIS_MCP_NOT_CONFIGURED`로 닫힌다. 기존 API와 법률 `/mcp`는 계속 동작한다.

## 필수 환경변수

| 변수 | 의미 |
|---|---|
| `VWORLD_API_KEY` | VWorld 운영키. 원문은 서버 secret에만 둔다. |
| `VWORLD_API_DOMAIN` | VWorld에 등록한 서비스 URL의 hostname과 동일해야 한다. |
| `DATA_PORTAL_API_KEY` | 건축HUB serviceKey. Encoding/Decoding 키를 1회 정규화한다. |
| `GIS_MCP_TOKEN_REGISTRY_FILE` | 운영 권장 client registry의 container 절대 경로. regular non-symlink, app UID 1001 소유, mode `600` |
| `GIS_MCP_TOKEN_REGISTRY_JSON` | 최초 file 이전·로컬 개발용 client registry. 1~32개 client, raw bearer 금지 |
| `GIS_MCP_TOKEN_SHA256` | legacy 단일 client digest. 신규 운영에는 사용하지 않음 |
| `GIS_MCP_PROXY_TOKEN_SHA256` | Caddy 전용 raw proxy secret의 서버측 digest |
| `GIS_MCP_ALLOWED_HOSTS` | scheme/port/path 없는 hostname allowlist |
| `GIS_MCP_ALLOWED_ORIGINS` | Origin을 보내는 서버 client allowlist, 선택 |
| `GIS_MCP_REQUESTS_PER_MINUTE` | bearer별 upstream 도구 분당 제한, 기본 20 |
| `GIS_MCP_GLOBAL_REQUESTS_PER_MINUTE` | 프로세스 전체 분당 제한, 기본 40 |
| `GIS_MCP_REQUEST_DEADLINE_MS` | admission 포함 전체 deadline, 기본 45000ms |
| `GIS_MCP_MAX_CONCURRENCY` | 동시 upstream 도구 상한, 기본 2 |
| `GIS_MCP_MAX_QUEUE` | 대기 요청 상한, 기본 4 |

`GIS_MCP_TOKEN_REGISTRY_FILE`, `GIS_MCP_TOKEN_REGISTRY_JSON`,
`GIS_MCP_TOKEN_SHA256` 중 둘 이상을 동시에 설정하면 우선순위나 병합 없이
잘못된 구성으로 판정한다. 운영은 file registry만 사용하며 서버에는
`clientId`와 SHA-256 digest만 남긴다.

```bash
npm run gis:mcp:token -- client-generate --client-id codex-mac-202609
npm run gis:mcp:token -- client-digest --client-id codex-mac-202609
npm run gis:mcp:token -- proxy-generate
```

raw bearer는 client secret store에만, raw proxy token은 Caddy owner-only secret에만
둔다. API와 배포 secret에는 digest만 저장한다.

## EC2 file registry와 hot reload

소수 초대 client는 법률 MCP와 분리된 다음 GIS 전용 경로를 사용한다.

```text
host directory  /home/ubuntu/alimtalk-proxy/.gis-mcp-secrets
host file       /home/ubuntu/alimtalk-proxy/.gis-mcp-secrets/clients.json
container dir   /run/secrets/tonghari-gis-mcp
container file  /run/secrets/tonghari-gis-mcp/clients.json
```

host directory는 UID/GID `1001:1001`, mode `700`, `clients.json`은 UID `1001`,
mode `600`을 유지한다. 메인 container에는 file 자체가 아닌 상위 directory를
다음과 같이 read-only bind mount한다.

```text
type=bind,src=/home/ubuntu/alimtalk-proxy/.gis-mcp-secrets,dst=/run/secrets/tonghari-gis-mcp,readonly
```

file만 bind mount하면 atomic rename 후 container가 이전 inode를 계속 볼 수 있으므로
금지한다. 서버는 auth·health 요청 시 변경 fingerprint를 확인하고 변경된
registry를 재검증한다. 누락, symlink, 권한, schema 오류는 기존 snapshot을
계속 쓰지 않고 `/gis-mcp`를 fail-closed한다. 정상 add/revoke는 재배포나
container 재시작 없이 바로 반영된다.
인증에 성공한 요청은 client ID, 안전하게 정규화한 MCP method/tool 이름,
HTTP 상태, 처리시간, 완료 여부만 감사 로그에 남긴다. bearer, 요청 본문, IP는
기록하지 않으며 rate-limit 등 인증 후 거부도 같은 client ID로 추적한다.

## 최초 JSON → file 배포 이전

`.github/workflows/docker-build.yml`은 최초 1회에 한해 기존 EC2 `.env`의
`GIS_MCP_TOKEN_REGISTRY_JSON`을 새 이미지의 no-network one-shot helper로 file에
이전한다. registry 원문은 GitHub input, step environment, stdout, artifact로
전송하지 않는다. 기존 file이 있으면 `.env` JSON과 semantic equality가 증명될
때만 재사용한다.

원본 `.env`를 유지한 채 file-only next env로 candidate와 final을 검증하고,
final health 통과를 commit point로 삼는다. commit point 전 실패는 기존
container를 복구한다. 통과 후에는 구 env-mode rollback 제거, file-only
`.env` atomic install, deploy-user 소유 mode `600`의
`.gis-mcp-file-registry-v1` marker 생성 순서로 마감한다. 이 단계의
cleanup 실패는 폐기된 env token을 복원하지 않고 새 file-mode container를
유지한 채 exit `71`로 수동 조치를 요청한다.

최초 설정을 쓰기 전에는 `.github/workflows/gis-mcp-initial-activation-audit.yml`을
`main`에서 수동 실행한다. 이 workflow는 보호 environment `gis-mcp-registry`와 기존
EC2 fingerprint 고정 SSH 연결을 사용하며, production lock 아래에서 다음 항목의
상태만 출력한다.

- VWorld·건축HUB key 및 VWorld domain의 존재·형식. 최초 활성화
  직전에 `VWORLD_API_DOMAIN`과 legacy `VWORLD_DOMAIN`이 모두 없으면
  저장소 canonical 기본값 `www.tonghari.kr`을 prepare 단계에서
  명시적으로 추가할 수 있는 `missing-bootstrapable`로 판정한다.
  이 호스트는 prepare 전 VWorld 인증키 관리의 서비스 URL과 다시
  일치하는지 확인한다. 두 변수 중 다른 값이 이미 있거나 legacy
  변수가 남아 있으면 덮어쓰지 않고 감사를 중단한다.
- GIS 인증 source, proxy digest, Host allowlist, file marker·registry의 미설정 여부
- 현재 container가 `disabled`와 client/token `0/0`인지 여부
- `/opt/caddy/Caddyfile`, root-only proxy env, Caddy container가 문서화한 baseline인지 여부

provider key, proxy 원문, client bearer, registry JSON, digest는 출력하지 않는다.
`stageReady=true`는 최초 쓰기를 해도 되는 구조적 전제조건일 뿐 provider 실제 호출
성공을 뜻하지 않는다. Caddy baseline hash나 상태가 예상과 다르면 템플릿으로
덮어쓰지 말고 실제 운영 구성을 별도로 검토한다.

## 소수 client 초대·폐기·회전

client ID는 개인정보 없는 lowercase 영문·숫자·단일 하이픈 조합으로 정한다.
신규 bearer는 다음 감사된 CLI로 만들고 raw 값은 한 번만 client 소유자에게
보안 전달한다.

```bash
npm run gis:mcp:token -- client-generate --client-id claude-gis-202609
npm run gis:mcp:token -- client-digest --client-id claude-gis-202609
```

`.github/workflows/gis-mcp-client-registry.yml`은 `main`의 수동 dispatch와
보호 environment `gis-mcp-registry`에서만 실행한다. environment에는 required
reviewer와 `main` deployment branch 제한을 설정하고 EC2 접속 secret 외에
`add`의 1회성 digest용 `GIS_MCP_REGISTRY_PENDING_SHA256`만 임시로 둔다.
raw bearer를 GitHub에 저장하지 않는다. workflow는 `validate`, `list`, `add`,
`revoke`, `recover`를 지원하고 `gis-mcp-client-registry-production`
concurrency로 운영 mutation을 직렬화한다.

`add`는 environment secret의 digest와 dispatch input의
`pending_digest_commitment`가 다음 canonical 객체에 같이 묶여 있을 때만
SSH stdin으로 전달한다.

```text
SHA-256(JSON.stringify({
  version: 1,
  operationId: "<opaque-operation-id>",
  action: "add",
  clientId: "<opaque-client-id>",
  tokenSha256: "<64-hex-token-digest>"
}))
```

원격 operator도 stdin digest로 같은 commitment를 다시 계산하고, `add` 게시 뒤
registry에 실제 저장된 해당 client digest로 commitment를 독립 재계산한다. 둘이
다르면 count/client ID가 맞아도 `verified`로 확정하지 않는다. operation marker와
receipt v4에는 digest 원문 대신 `tokenCommitment`, 실행한 operator의
`scriptSha256`만 기록하며 새 mutation의 `operation_id`가 기존 marker 또는 durable
receipt와 중복되면 fail-closed한다.

순서는 **environment secret 임시 설정 → 대응 ID·commitment로 1회 dispatch
→ 최종 상태 확인 → environment secret 삭제**다. `add`, `revoke`, `recover`는
GitHub re-run을 금지하며 실패 후에는 새 operation ID로 판정한다.
`COMMIT_STATE_UNKNOWN`이나 미해결 `.gis-mcp-registry-commit-unknown`이 있으면
재시도하지 말고 `list`/`validate`로 count와 target state를 확정한 뒤
동일 `client_id`, `expected_client_count`, `expected_client_state=present|absent`로
guarded `recover`를 실행한다. recover는 registry entry를 변경하지 않고
정확히 검증된 operation 증거만 수렴시킨다. `intent`/`unknown`도 현재 상태가
정확히 pre/post endpoint 하나와만 일치해야 하며, 그 판정 결과를 mode `600`
terminal receipt로 원자 게시·fsync·재검증한 뒤에만 marker를 삭제한다. 게시 도중
중단되면 다음 recover가 terminal receipt 또는 `.tmp`와 죽은 이전 recover run
증거를 검증해 이어서 수렴한다.

무중단 회전은 **새 세대 client ID `add` → 새 raw bearer로 `tools/list`
HTTP 200 확인 → 구 ID `revoke` → 구 bearer HTTP 401 확인** 순서다.
마지막 1개 client를 단독으로 revoke하지 않는다. 운영 갱신은 배포와
같은 `.tonghari-api-production.lock`을 사용하며 registry·operation marker·receipt는
법률 MCP의 경로나 secret과 공유하지 않는다.

## Caddy exact route

법률 MCP와 GIS MCP proxy token은 서로 재사용하지 않는다.

```caddyfile
api.tonghari.kr {
    @legal_mcp path /mcp
    handle @legal_mcp {
        reverse_proxy 127.0.0.1:3100 {
            header_up X-Forwarded-Proto https
            header_up X-Tonghari-MCP-Proxy-Token {$LEGAL_MCP_PROXY_TOKEN}
        }
    }

    @gis_mcp path /gis-mcp
    handle @gis_mcp {
        reverse_proxy 127.0.0.1:3100 {
            header_up X-Forwarded-Proto https
            header_up X-Tonghari-GIS-MCP-Proxy-Token {$GIS_MCP_PROXY_TOKEN}
        }
    }

    handle {
        reverse_proxy 127.0.0.1:3100
    }
}
```

3100은 loopback 또는 host firewall/security group에서 공개 ingress를 차단한다.

## Codex client 예시

```toml
[mcp_servers.tonghari_gis]
url = "https://api.tonghari.kr/gis-mcp"
bearer_token_env_var = "TONGHARI_GIS_MCP_TOKEN"
enabled = true
required = true
enabled_tools = [
  "resolve_address_to_pnu_v1",
  "lookup_parcel_public_data_v1",
  "lookup_building_register_v1",
  "lookup_housing_official_price_v1",
  "lookup_land_right_registration_v1"
]
```

## 운영 활성화 gate

1. VWorld 운영키 신청/변경 내역에 통하리 상용 MCP 조회 용도가 포함됐는지 확인한다.
2. 건축HUB 운영계정과 호출량을 확인하고 필요하면 활용사례 등록 후 증설한다.
3. geocoder 결과를 영구 저장하지 않고 모든 응답에 VWorld 출처를 유지한다.
4. Caddy/API의 proxy raw/digest가 같은 발급 쌍인지 값을 출력하지 않고 확인한다.
5. 최초 배포 전 EC2 `.env`에 1~32개 client의
   `GIS_MCP_TOKEN_REGISTRY_JSON`을 중복 없이 정확히 한 번 설정한다. file·JSON·legacy
   중 정확히 하나만 설정되어야 하며 이 운영 설정은 코드 배포와 별도로
   승인한다.
6. 배포 후 `GET /health`에서 `gisMcpConfigurationValid=true`,
   `gisMcpAuthMode=client_registry`, `gisMcpAuthSource=file_registry`,
   `gisMcpProviderMode=vworld_and_data_portal`과 등록 client/token count 일치를 확인한다.
   health는 비밀 원문이나 digest를 출력하지 않는다.
7. HTTPS에서 hidden-input smoke를 실행한다.

```bash
npm run gis:mcp:smoke -- --endpoint https://api.tonghari.kr/gis-mcp
```

8. 정확한 테스트 PNU로 5개 도구를 각각 live 호출해 provider 성공/무자료/일시 장애
   상태와 출처표시를 확인한다. 이 live smoke 전에는 외부 MCP가 완료됐다고 보고하지 않는다.

## 공식 근거

- [VWorld Open API 목록](https://www.vworld.kr/dev/v4apiRefer.do)
- [연속지적도 2D Data API](https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=cadastral)
- [VWorld 국가중점데이터 API](https://www.vworld.kr/dtna/dtna_apiSvcList_s001.do)
- [VWorld 대지권등록 API](https://www.vworld.kr/dtna/dtna_apiSvcFc_s001.do?apiNum=78)
- [VWorld 주소→좌표 제한](https://www.vworld.kr/dev/v4dv_geocoderguide2_s001.do)
- [VWorld 이용약관](https://www.vworld.kr/v4po_prcint_a001.do)
- [VWorld 저작권 정책](https://www.vworld.kr/v4po_prcint_a006.do)
- [공공데이터포털 건축HUB](https://www.data.go.kr/data/15134735/openapi.do)
