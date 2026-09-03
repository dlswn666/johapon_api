# Tonghari API Docker 배포 가이드

## 운영 원칙

Tonghari API는 `.github/workflows/docker-build.yml`을 통한 자동 배포만 사용한다.

- 이미지는 GitHub Actions에서 빌드하고 GHCR(`ghcr.io/dlswn666/alimtalk-proxy`)에 저장한다.
- 배포 대상은 `latest`가 아니라 Git SHA 태그와 `sha256` digest로 고정한다.
- EC2에서는 이미지를 빌드하지 않고 검증된 digest를 pull해 실행한다.
- 런타임 비밀값은 GitHub에 복제하지 않고 EC2의 `/home/ubuntu/alimtalk-proxy/.env`와
  보호된 `.legal-mcp-secrets/clients.json`만 사용한다.
- 후보 컨테이너를 `127.0.0.1:13100`에서 검증한 후 공개 포트 `3100`을 교체한다.
- 성공 후 직전 컨테이너를 `alimtalk-proxy-rollback`이라는 정지 상태 컨테이너로 1세대 보존한다.
  단, 법률 MCP file registry 최초 전환에서는 구 env digest를 복원하지 않기 위해
  file-mode 최종 health 통과 후 기존 rollback container를 제거한다.

기존 `scripts/build-and-push.sh`와 `scripts/deploy-to-ec2.sh`의 Docker Hub/`latest` 방식은 사용하지 않는다.

## GitHub Actions 설정

Repository Settings > Secrets and variables > Actions에는 EC2 접속에 필요한 다음 값만 저장한다.

- `EC2_HOST`: EC2 퍼블릭 IP 또는 호스트명
- `EC2_USERNAME`: 현재 서버 기준 `ubuntu`
- `EC2_SSH_KEY`: EC2 SSH private key 원문
- `EC2_SSH_FINGERPRINT`: 접속 대상 EC2 host key fingerprint

`GITHUB_TOKEN`은 Actions가 자동 발급하며 GHCR 로그인에만 사용한다. 다음 런타임 값은 GitHub Secrets에 저장하지 않는다.

- `DEV_API_JWT_SECRET`
- `DEV_SUPABASE_URL`
- `DEV_SUPABASE_SERVICE_ROLE_KEY`

## EC2 런타임 설정

파일 위치:

```text
/home/ubuntu/alimtalk-proxy/.env
```

필수 보안 조건:

```bash
cd /home/ubuntu/alimtalk-proxy
stat -c 'owner=%U group=%G mode=%a file=%n' .env
```

정상 기준은 `owner=ubuntu`, `mode=600`이다. 배포 workflow도 컨테이너를 건드리기 전에 이 조건을 검사한다.

### 법률 MCP file registry

소수 초대 client의 bearer digest registry는 다음 고정 경로를 사용한다.

```text
/home/ubuntu/alimtalk-proxy/.legal-mcp-secrets             uid/gid 1001:1001, mode 700
/home/ubuntu/alimtalk-proxy/.legal-mcp-secrets/clients.json uid/gid 1001:1001, mode 600
```

container에서는 directory 전체를 `/run/secrets/tonghari-legal-mcp`에
read-only bind mount하고 `.env`에는 다음 경로만 둔다.

```text
LEGAL_MCP_TOKEN_REGISTRY_FILE=/run/secrets/tonghari-legal-mcp/clients.json
```

`LEGAL_MCP_TOKEN_REGISTRY_JSON` 및 `LEGAL_MCP_TOKEN_SHA256` 키는 최초 전환 후
`.env`에 남기지 않는다. file·JSON·legacy digest 중 둘 이상이 설정되면
법률 MCP는 fail-closed한다. 서버에는 bearer 원문을 저장하지 않고
`clientId`와 SHA-256 digest만 저장한다.

배포 workflow는 최초 1회에 한해 기존 EC2 `.env`의 JSON registry를
no-network one-shot helper로 file에 이전한다. registry 원문은 GitHub Secret,
workflow input, 로그, artifact로 전송하지 않는다. 같은 경로에 이전 시도의 file이
이미 있어도 현재 `.env` JSON과 semantic equality를 `matches-env`로 증명해야 하며,
불일치하면 덮어쓰지 않고 중단한다. candidate와 final은 file-only next env와
read-only directory mount로 검증한다. final health 통과가 migration
commit point이며, 이후 구 rollback container 제거 → `.env` atomic install → mode
`600` marker 생성 순서로 마감한다. commit point 후 cleanup 실패는
새 file-mode container를 계속 실행하며 exit `71`로 수동 조치를 요청한다.
구 env-mode container를 자동으로 재시작하지 않는다.

배포는 `ERR`, `INT`, `TERM`, `HUP`, `EXIT`를 phase-aware하게 처리한다. commit
point 전에는 next env를 정리하고 기존 container를 복구하지만, commit point 후에는
구 rollback을 다시 시작하지 않고 best-effort 제거와 next env 정리만 수행한다.
프로세스 강제 종료 등으로 `.env.legal-mcp.next.*`가 남았거나 current container가
없는 상태에서 rollback만 남으면 다음 배포도 자동 진행·자동 재기동하지 않고
operator review를 요구한다.

개발 DB 분기를 위한 필수 항목은 다음 세 개다.

```text
DEV_API_JWT_SECRET
DEV_SUPABASE_URL
DEV_SUPABASE_SERVICE_ROLE_KEY
```

기준지번/부속지번 W1 operation 원장이 적용된 target은 비밀값이 아닌 아래 allowlist로 명시한다.

```text
BUILDING_WRITE_OPERATION_TARGETS=development
```

운영 DB에 W1을 적용하기 전에는 `production`을 추가하지 않는다. 이 값이 없으면 개발 GIS의
building-family queue producer는 `BUILDING_OPERATION_CAPABILITY_DISABLED`로 fail-closed한다.

대지권면적 동기화는 기본적으로 전역 OFF와 빈 allowlist를 유지한다.

```text
LAND_AREA_SYNC_ENABLED=false
LAND_AREA_SYNC_ALLOWED_TARGETS=
```

일반 `main` push 배포는 EC2에서 `LAND_AREA_SYNC_ENABLED=true`를 발견하면
fail-closed한다. 수동 이미지 배포가 이미 승인된 allowlist를 유지해야 하는 경우에만
`docker-build.yml`을 `workflow_dispatch`로 실행하면서 현재 canonical allowlist의 count와
SHA-256을 함께 제출한다.

개발 DB 대지권 backfill을 위해 runtime gate만 제한적으로 열거나 닫을 때는 별도
`Land Area Sync Runtime Allowlist` workflow를 사용한다. 이 workflow는 새 이미지를
빌드하거나 DB를 직접 호출하지 않으며, 현재 실행 중인 컨테이너와 동일한 immutable image
ID로 후보·최종 컨테이너를 다시 만든다.

Repository Environment `land-area-sync-development-backfill`에는 required reviewer와
`main` deployment branch 제한을 설정한다. 승인자는 다음 입력을 독립적으로 검증해야 한다.

- `action`: `enable` 또는 `disable`
- `land_area_sync_allowed_targets`: 공백 없는 canonical
  `development:unionUuid:19자리PNU` 항목을 쉼표로 연결한 원문
- `expected_allowlist_count`: 승인 대상 exact count
- `expected_allowlist_sha256`: canonical 원문의 SHA-256

`enable`은 development exact target만 허용한다. production, wildcard, duplicate, 비정규
순서·대문자 UUID·공백, count/digest 불일치는 EC2 변경 전에 거부한다. `disable`은 빈
allowlist, count `0`, 빈 digest만 허용하며 이미 비활성인 상태에서도 반복 실행할 수 있다.

GitHub의 concurrency group에는 running 1개와 pending 1개만 남기므로 enable과 disable을
같은 group에 두지 않는다. runtime workflow는 action별 group을 사용해 pending disable이
후속 enable에 의해 대체되지 않게 한다. EC2에서는 runtime 변경, 일반 Docker 배포, Phase 0
읽기 전용 capture가 모두 deploy-user 소유 mode `600`의
`.tonghari-api-production.lock`을 `flock`으로 독점 획득한다. runtime 요청은 GitHub
workflow 내부에서 monotonic한 `github.run_number`와 `github.run_attempt`를 요청
watermark로 사용한다. `run_attempt`는 같은 요청의 재시도 metadata이며 ordering을
앞당기지 않는다. 같은 enable 재시도는 이미 health가 정확히 적용된 경우만 성공하며, 적용
실패 뒤 enable은 새 dispatch/run_number가 필요하다. 같은 disable 재시도는 항상 다시
실행한다. requested watermark는 `.env`와 컨테이너보다 먼저 mode `600` 파일에
원자적으로 기록한다. stale enable은 fail-closed로 거부하고, disable은 stale
run_number여도 실행하면서 watermark를 되감지 않는다. disable 적용이 실패해 env/container를
이전 상태로 rollback하더라도 disable watermark tombstone은 rollback하지 않으므로 더 오래된
enable이 다시 적용될 수 없다. production lock 대기는 최대 2,400초로 제한한다.

컨테이너를 재기동하는 runtime 변경과 일반 Docker 배포는 production lock을 먼저 얻은 뒤
deploy-user 소유 mode `600`의 `.land-area-sync-operation.lock`도 획득한다. 향후 dev
batch runner는 같은 operation lock만 획득하고 전체 batch 동안 보유해야 한다. lock 순서는
항상 `production -> operation`이며 runner는 production lock을 역순으로 추가 획득하지
않는다. runner 실행은 `timeout 2400` 등으로 최대 2,400초를 강제하고, runtime/deploy의
operation lock 대기는 최대 2,700초로 제한한다. 따라서 batch 실패나 runner 종료 시 커널이
lock을 해제하며, disable이 영구 대기하지 않고 최대 대기시간 안에 재기동 절차를 시작하거나
명시적으로 실패한다. 일반 Docker deploy job은 production lock 최대 40분, operation
lock 최대 45분, 실제 배포와 rollback 예산 30분을 모두 포함하도록 SSH command timeout을
120분, job timeout을 130분으로 두어 lock 획득 직후 timeout이 컨테이너 교체를 중단하지
않게 한다.

raw allowlist는 `${{ inputs.* }}` 표현식으로 step 환경변수에 직접 주입하지 않는다.
각 job이 `GITHUB_EVENT_PATH`에서 값을 읽어 파일에 쓰고, GitHub workflow command escape를
적용한 exact 값으로 `::add-mask::`를 먼저 등록한 뒤 validator와 SSH 전달에 사용한다.
event payload나 raw allowlist 원문은 command echo와 실행 로그에 출력하지 않는다.

이 runtime workflow는 API canary만 제어한다. Supabase의 DB owner-only approval manifest를
생성·수정·활성화하지 않으며, production DB에는 어떤 변경도 수행하지 않는다. 실제 dev
동기화 전에는 별도 승인 절차에서 dev DB approval manifest의 target/count/digest/만료를
확인해야 한다.

EC2 적용 시에는 다음 보호 조건을 모두 확인한다.

1. `.env`가 deploy 사용자 소유의 regular non-symlink 파일이며 mode `600`이다.
2. raw allowlist는 사용 전에 exact mask하고 로그에 출력하지 않으며 mode `600` 임시
   파일로만 전달한다.
3. `.env`의 두 gate key를 같은 디렉터리의 mode `600` 임시 파일에서 바꾼 뒤 atomic
   rename한다.
4. 현재 컨테이너의 image ID와 후보·최종 컨테이너의 image ID가 정확히 같다.
5. 후보와 최종 `/health`의 enabled/count/digest가 승인 입력과 일치한다.
6. 후보·최종 검증이 모두 끝나는 commit point 전 실패 시 원래 `.env`, 컨테이너 이름,
   실행 상태와 이전 health attestation을 복구한다.
7. 컨테이너 재기동 전 production lock과 land-area operation lock을 고정 순서로 획득한다.
8. 최종 검증 직후 rollback 삭제 전에 commit point를 기록한다. 이후 runtime rollback
   container나 secret-bearing `.env` backup cleanup이 실패하면 새 current를 유지하고
   이전 컨테이너는 재기동하지 않으며 exit `71`로 green을 금지한다.
9. 같은-run idempotent return 전에 orphan `.env.land-area-sync.backup.*`를 최대 8개까지
   검출하고 소유자와 mode `600`을 확인한다. 현재는 성공 apply 뒤 cleanup만 실패했다는
   durable marker가 없으므로 하나라도 있으면 자동 삭제하지 않고 복구 근거로 보존한 채
   exit `71`로 중단한다.
10. runner와 EC2에 staged한 raw allowlist는 모든 종료 경로에서 삭제 후 부재를 검증하고,
    삭제 실패를 `|| true`로 무시하지 않는다.

값을 출력하지 않고 항목 수만 확인한다.

```bash
for key in DEV_API_JWT_SECRET DEV_SUPABASE_URL DEV_SUPABASE_SERVICE_ROLE_KEY; do
  printf '%s count=' "$key"
  grep -c "^${key}=" .env
done
```

각 항목은 정확히 `count=1`이어야 한다. Supabase secret key와 JWT 원문은 터미널 로그, GitHub, 저장소에 남기지 않는다.

## 자동 배포 흐름

`main` push 또는 수동 workflow 실행 시 다음 순서로 진행한다.

1. 테스트, TypeScript 컴파일, property-building writer guard를 실행한다.
2. Git SHA 태그로 이미지를 빌드하고 GHCR에 push한다.
3. push 결과의 digest 형식을 검증한다.
4. EC2 접속 비밀과 EC2 `.env` 소유자·권한·필수 항목을 검사한다.
5. `repo@sha256:digest` 형식으로 정확한 이미지를 pull한다.
6. 법률 MCP registry directory/file의 소유자·모드·schema를 검증한다. 최초
   전환이면 EC2 내부에서만 JSON registry를 file로 초기화하고 file-only next
   env를 만든다.
7. 후보 컨테이너를 `127.0.0.1:13100`에 띄워 SHA, build time, image tag,
   LAND_AREA_SYNC enabled/count/digest와 법률 MCP valid/mode/source/client count를 검증한다.
8. 후보가 통과한 경우에만 기존 `3100` 컨테이너를 rollback 이름으로 보존하고 새 컨테이너로 교체한다.
9. 최종 `3100` health 검증에 실패하면 직전 컨테이너를 복구한다. 이미 file
   migration marker가 있다면 rollback container의 file-only env와 동일 read-only
   mount를 먼저 검증하며, 불일치하면 구 digest를 살리지 않고 fail-closed한다.
10. 최초 전환의 final health가 통과하면 구 rollback을 제거하고 file-only
    `.env`와 migration marker를 원자적으로 확정한다.

별도 `Land Area Sync Runtime Allowlist` workflow도 migration marker, file-only
`.env`, UID/GID `1001:1001` mode `700` registry directory와 CLI validate count를
먼저 요구한다. 현재·candidate·final·rollback container 모두 같은 read-only
directory mount, loopback `127.0.0.1` port, legal MCP valid/mode/source/count 계약을
통과해야 하므로 runtime allowlist 변경이 legal MCP 구성을 우회할 수 없다.

## 상태 확인과 롤백

배포 상태 확인:

```bash
docker ps --filter name=alimtalk-proxy
curl -fsS http://127.0.0.1:3100/health
```

배포 성공 후 rollback 컨테이너 확인:

```bash
docker ps -a --filter name=alimtalk-proxy-rollback
```

법률 MCP file registry 최초 전환 배포는 구 env digest 부활을 막기 위해
rollback container가 **없는 것이 정상**이다. 그 다음 file-mode 배포부터
동일 registry directory를 read-only mount한 직전 container 하나를 보존한다.

자동 rollback이 실패한 비상 상황에서만 다음을 실행한다. 법률 MCP
migration marker가 있으면 먼저 rollback container의 env에 file path가 정확히
한 번 있고 JSON/legacy key가 없으며, mount source/destination이 동일하고
`RW=false`인지 확인한다. 이 계약을 자동 workflow와 동일하게 검증할 수
없으면 아래 명령을 실행하지 않는다.

```bash
set -Eeuo pipefail

rollback_env="$(
  docker container inspect \
    --format '{{range .Config.Env}}{{println .}}{{end}}' \
    alimtalk-proxy-rollback
)"
test "$(grep -Fxc \
  'LEGAL_MCP_TOKEN_REGISTRY_FILE=/run/secrets/tonghari-legal-mcp/clients.json' \
  <<< "${rollback_env}" || true)" = 1
test "$(grep -Ec '^LEGAL_MCP_TOKEN_REGISTRY_JSON=' \
  <<< "${rollback_env}" || true)" = 0
test "$(grep -Ec '^LEGAL_MCP_TOKEN_SHA256=' \
  <<< "${rollback_env}" || true)" = 0

rollback_mount="$(
  docker container inspect --format \
    '{{range .Mounts}}{{if eq .Destination "/run/secrets/tonghari-legal-mcp"}}{{.Type}}|{{.RW}}|{{.Source}}{{println}}{{end}}{{end}}' \
    alimtalk-proxy-rollback
)"
test "${rollback_mount}" = \
  'bind|false|/home/ubuntu/alimtalk-proxy/.legal-mcp-secrets'

rollback_image="$(
  docker container inspect --format '{{.Image}}' alimtalk-proxy-rollback
)"
registry_validation="$(
  docker run --rm \
    --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges \
    --mount \
      type=bind,src=/home/ubuntu/alimtalk-proxy/.legal-mcp-secrets,dst=/run/secrets/tonghari-legal-mcp,readonly \
    "${rollback_image}" \
    node dist/cli/legal-mcp-registry.js validate \
      --path /run/secrets/tonghari-legal-mcp/clients.json
)"
[[ "${registry_validation}" =~ ^clientCount=([1-9][0-9]*)$ ]]
expected_client_count="${BASH_REMATCH[1]}"

docker rm -f alimtalk-proxy
docker rename alimtalk-proxy-rollback alimtalk-proxy
docker start alimtalk-proxy
curl -fsS http://127.0.0.1:3100/health \
  | docker exec -i \
      -e EXPECTED_LEGAL_MCP_CLIENT_COUNT="${expected_client_count}" \
      alimtalk-proxy \
      node -e '
        let body = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { body += chunk; });
        process.stdin.on("end", () => {
          try {
            const health = JSON.parse(body);
            const valid = health.status === "ok"
              && health.features?.legalMcpConfigurationValid === true
              && health.features?.legalMcpAuthMode === "client_registry"
              && health.features?.legalMcpAuthSource === "file_registry"
              && String(health.features?.legalMcpRegisteredClientCount)
                === process.env.EXPECTED_LEGAL_MCP_CLIENT_COUNT
              && String(health.features?.legalMcpRegisteredTokenCount)
                === process.env.EXPECTED_LEGAL_MCP_CLIENT_COUNT;
            process.exit(valid ? 0 : 1);
          } catch {
            process.exit(1);
          }
        });
      '
```

비상 롤백 전에는 실행 중인 컨테이너와 rollback 컨테이너의 존재를 먼저 확인한다.
시작 후 health의 `legalMcpConfigurationValid=true`,
`legalMcpAuthMode=client_registry`, `legalMcpAuthSource=file_registry`와 두 count가
현재 `clients.json`의 검증 count와 일치하지 않으면 롤백 성공으로 판정하지 않는다.
폐기된 legal token이 포함된 env-mode rollback은 서비스 중단을 감수하고라도
시작하지 않는다.

## 주의사항

- `.env`를 수정해도 실행 중인 컨테이너에는 반영되지 않는다. `docker restart`도 환경변수를
  다시 읽지 않으므로 새 컨테이너 배포가 필요하다. 단, legal MCP
  `clients.json`은 directory bind mount와 request-time reload를 사용하므로 원자적
  add/revoke 후 재배포·재시작이 필요 없다.
- Vercel 환경변수도 새 배포부터 적용된다. 공유 JWT를 교체한 경우 API와 `johapon-dev`를 연속으로 재배포한다.
- 공개 HTTP `3100`은 HTTPS 전환 전 합성 개발 GIS 검증에만 제한한다. 운영 bearer token 검증에 사용하지 않는다.
- `.env` 원문은 저장소나 GitHub Actions artifact에 백업하지 않는다. 별도의 암호화 백업 절차를 사용한다.
