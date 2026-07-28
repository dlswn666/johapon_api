# 개발 미아7 대지권 동기화 runner

## 목적과 범위

이 runner는 미아7구역 개발 DB의 활성 물건지 `429/429`를 공식 API로 전부 다시 조회하고
검증된 `LADFRL`/`LDAREG` 대지권 면적과 자동 출처를 적용하는 도구다. 운영 DB는 대상이
아니며 production target, production JWT, 외부 API origin을 입력으로 받을 수 없다.

과거의 대표 PNU canary와 7개 건물 특수 백필은 전체 완료 경로가 아니다. 전체 완료의
source of truth는
[`2026-07-28-mia7-development-land-area-full-refresh.md`](./2026-07-28-mia7-development-land-area-full-refresh.md)
및 repo-pinned `land-area-development-target-manifest@3`이다. 적용 단위는 특정 호실이나
기존 관계 행이 아니라 `295`개 공식 컴포넌트이며, 실행 전후 활성 물건 `429`, 활성 PNU
`299`, 허용 scan PNU `300`을 exact 검증한다.

## acceptance checklist

- target/API allowlist/DB approval manifest의 development + union + 정렬 PNU +
  count + canonical digest가 exact 일치한다.
- EC2 컨테이너 안의 `DEV_API_JWT_SECRET`으로만 10분 HS256 JWT를 만들며
  `kid=dev`, `iss=tonghari-web-dev`, `aud=tonghari-api`,
  `databaseTarget=development`, `purpose=GIS_SYSTEM_ADMIN`을 고정한다.
- JWT의 `sub`와 `userId`는 보호 environment secret과 exact 대조한
  개발 `auth.users` SYSTEM_ADMIN UUID다.
- 서비스 역할의 DB 직접 접근은 개발 `property_units` read-only pre/postflight뿐이다.
  discovery/confirm/apply write는 localhost canonical API route만 사용한다.
- PNU를 직렬 처리하고 latest job을 먼저 resume한다. FAILED, unexpected REVIEW,
  cache/conflict issue가 나오면 다음 PNU admission을 즉시 중단한다.
- confirmation 전에 frozen scope, strategy, property membership, proposed area,
  same-run LADFRL scope evidence를 per-PNU evidence manifest와 exact 대조한다.
- LADFRL confirmation은 parcel-scope evidence와 land-ownership evidence가 모두
  존재할 때만 두 확인값을 true로 만든다.
- 실행 전 활성 물건 membership/면적/source가 evidence의 명시적 prestate 중 하나와
  exact 일치해야 한다. 실행 후 대상 면적은 양수이고 source는 예상 strategy여야 한다.
- pre/post 활성 물건 수, PNU 수, property identity digest가 불변이어야 한다.
- pre/post 429개 전체 tuple은
  `land_area / land_area_source / land_area_synced_at / land_area_sync_job_id`
  네 필드를 포함한다. 승인 target만 expected area/source와 exact writer job으로 바뀔 수 있고,
  non-target tuple digest는 exact 불변이어야 한다.
- 이번 실행의 writer job ID로 개발 DB를 bounded 역조회하여 반환된 모든 물건이 exact
  union/target membership에 속하는지 검사한다. 타 조합 또는 승인 scope 밖 행이 하나라도
  잡히면 cross-union write로 FAIL한다.
- full artifact의 PNU/job/property 식별자는 runner 재검증과 최종 gate에만 사용하고
  GitHub artifact로 업로드하지 않는다. 업로드용 public artifact는 version,
  development target, repository manifest label, 집계 count, digest, strategy/outcome
  집계, gate status/failure code만 허용하며 timestamp와 target 배열도 포함하지 않는다.

## manifest canonical 계약

PNU를 오름차순 정렬한 뒤 각 행을 아래 형태로 만들고 쉼표로 결합해 SHA-256을 계산한다.

```text
development:<lowercase-union-uuid>:<19-digit-pnu>
```

대표 PNU canonical digest는
`423d4b2ef2df290fa1d168acf31c8ea38eb9816f2319fb34f4e11a23af48ff23`이다.
legacy v1 canonical 방식으로 계산한 전체 299 PNU digest
`638977eb11e2e09afdb949179fe59e7944c2ed4c973fe2695bf0628239a2e219`은 과거
read-only 분류 기록으로만 보존한다. v3 전체 갱신은 DB target과 union을 포함한 별도
active-PNU commitment
`db754ce378896d45bb09b66ffe1174577a805fa74d264ed59ed17c9d97a78cbc` 및 exact 배열을
요구하며 legacy digest만으로 실행을 허용하지 않는다.

DB approval JSON은 실행 의도를 exact 대조하는 두 번째 입력이다. 실제 DB의 private
approval manifest 활성 여부와 scanned PNU 포함 여부는 confirmation/apply RPC가 같은
transaction 안에서 다시 검사하므로 JSON만으로 승인된 것으로 간주하지 않는다.

### v2 대표 anchor·부속 scope 계약

집합건물은 대표 PNU만 discovery 실행 anchor로 사용하고, 같은 건물의 부속 PNU는 외부 API
조회와 DB approval이 허용하는 scope로만 사용한다. v2 target은 이를 다음 두 배열로
분리한다.

- `anchors`: 실제 discovery를 실행하는 대표 PNU. evidence entry와 run artifact 순서도
  이 배열에만 대응한다.
- `allowedScopePnus`: 대표·부속 PNU 전체. runtime allowlist와 DB approval은 이 배열에
  대응한다.

두 해시의 의미도 분리한다.

- `scopeDigest`: `development:<union>:<pnu>` canonical 문자열로 계산한 대표·부속
  allowlist 해시
- `manifestDigest`: anchor, 전체 scope, 예상 property/union count,
  `allowManualOverwrite`를 모두 포함한 v2 실행계획 해시

runtime allowlist와 DB approval은 `scopeDigest`에 결합하고, read-only API evidence와 run
artifact는 `manifestDigest`에 결합한다. 따라서 같은 대표·부속 allowlist를 유지하면서
부속 PNU를 실행 anchor로 바꾸는 변조도 통과할 수 없다.

`MANUAL` prestate는 제안 면적 계산에 사용하지 않는다. v2 read-only capture가 현재 tuple을
동시성 guard로만 exact 기록하고, 제안값은 same-run LDAREG 응답의 유효한 현재행 분자에서만
생성한다. v1 target은 계속 `MANUAL` prestate를 거부한다. v2 evidence provenance는
`DEVELOPMENT_READ_ONLY_API_CAPTURE`와 capture/snapshot digest만 허용하며 workbook 근거를
가장하지 않는다.

`mia-seven-791-2280-ldareg-api-readonly-20260725` target은 다음 범위로 고정한다.

- anchor: `1130510100107912280`
- allowed scope: `1130510100107912280`, `1130510100107912281`
- expected property units: `4`
- scope digest:
  `071c33bbdb72ed3b8352b0e67fc45777b88f204807f65ea15ef9aa620126c937`
- manifest digest:
  `0bf26f3963e043ed0f7333da1d2ae575d4b6b00886d61ca9e97e2fa0560cea12`

이 target은 read-only evidence workflow에만 등록한다. live evidence와 별도 DB approval
bundle이 저장소에 승인되기 전에는 write workflow 선택지로 승격하지 않는다.

### v3 미아7 전체 공식 API 재조회 계약

전체 재조회 target은
`development-land-area-sync-manifests/mia-seven-full-295-components-api-readonly-target-20260728.json`
하나로 고정한다.

- union: `00f48b95-e9bc-4c92-a0e5-6b9a57adcfb9`
- 공식 컴포넌트 anchor: `295`
- 실행 시 활성 PNU exact 집합: `299`
- 공식 API scan 허용 PNU exact 집합: `300`
- 활성 property unit exact 집합: `429`
- active PNU digest:
  `db754ce378896d45bb09b66ffe1174577a805fa74d264ed59ed17c9d97a78cbc`
- scope digest:
  `8c87b46f17416cd5aad9aaa242f09ff04aefb4186f74b72370ebb9c1407caa73`
- manifest digest:
  `02bf999d970a9f0228a0bc683cc630fb157e5f4becb8576d0f4aa5b4dec1d3db`

이 exact target만
`DEVELOPMENT_FULL_REFRESH_API_REQUERY_V1` 표식을 받을 수 있다. 같은 형식의 임의 v3
manifest, 다른 union, 다른 digest, production database target은 API admission 전에
fail-closed한다.

보호 write workflow는 과거 capture의 raw evidence나 DB approval 파일을 GitHub artifact로
가져오지 않는다. 같은 보호 실행 안에서 먼저 공식 API read-only capture를 새로 수행하고
`429/299/300/295`, read-only write counter `0`, promotion gate `PASS`를 확인한다. 그
evidence는 비공개 임시 파일로만 유지한다. 이어지는 discovery와 apply도 공식 API를 다시
조회하며, evidence의 `officialComponentDigest`와 새 discovery snapshot을 exact 대조한다.
실행이 끝나면 raw evidence와 임시 approval을 삭제한다.

DB relation/GIS 데이터는 scope 선정 입력으로 사용하지 않고 변경하지 않는다. 기존 DB
scope hash와 property membership은 동시성·비대상 변경 감지에만 사용한다. 적용 중
`land_lots`, `building_land_lots`, `buildings`, `building_units`,
`building_external_refs`, `building_registry_land_lot_relations`,
`building_land_lot_manual_overrides` 7개 relation/GIS 테이블의 pre/post exact count와
content digest가 같아야 한다. `property_unit_land_rights`는 이 불변 집합과 분리해
LDAREG target/current-writer 귀속 및 비대상 digest 불변을 검증한다.

기존 `MANUAL` 값은 API 분자·분모·매칭·fallback에 사용하지 않는다. 현재
`land_area/source/synced_at/job_id` tuple은 동시성 guard로만 사용한다. 공식 API 값이 기존
숫자와 같더라도 적용 성공 시 `land_area_source`를 `LADFRL` 또는 `LDAREG`로 바꾸고
`land_area_synced_at`과 `land_area_sync_job_id`를 현재 apply job provenance로 갱신한다.

### `791-2280 → 791-2281` 공식 관계 채택 runner

Phase 0에서 확인한 공식 건축물대장 관계를 개발 DB에 채택하는 작업은 대지권 면적
apply와 분리한다. 저장소 승인 target은 기준 PNU `1130510100107912280`, 부속 PNU
`1130510100107912281`, 관리번호 `10101100184244`, 활성 물건 4건으로 exact 고정한다.
이 runner는 수동 대지권 값을 source, blocker, fallback 어느 용도로도 읽지 않으며 공개
artifact의 `manualDataUsage` 세 카운터가 모두 0일 때만 PASS할 수 있다.

실행 전에 pin한 Phase 0 run `30146538770`의 artifact 파일 SHA-256
`c386a5dc44cb50beb876a0e3713803c0d6b812938844214037d5e22b65c8b4fe`와 schema,
관리번호·기준·부속 PNU hash 및 pair digest를 저장소 manifest와 다시 대조한다. 이어서
Building HUB 표제부, 총괄표제부, 부속지번 3개 endpoint를 새로 strict 조회하여 모두
`COMPLETE`, root 관리번호 exact-one, `bylotCnt=1`, 기준·부속 pair exact-one,
reject 0을 요구한다. 총괄표제부 root record의 `mgmUpBldrgstPk='0'`은 sentinel로
해석하고 자기 `mgmBldrgstPk`를 root로 사용한다.

DB write 직전 inspector가 반환한 활성 물건 membership digest를 실행 target digest에
결합한다. 기존 land-area approval은 pre/post 모두 disabled이고 stable digest가
불변이어야 한다. relation 전용 15분 TTL approval은 DB owner/Supabase admin이 실행
revision과 exact target digest에 맞춰 별도 설치한다. API service-role runner에는 approval
설치·교체 권한을 부여하지 않는다. runner는 inspector에서 사전 설치된 approval이
exact-one, enabled, 미소비, unexpired 상태이며 runtime target digest와 일치하는지만
검증한 뒤 `adopt_development_verified_building_registry_relation_v1`이 transaction 안에서
원자 소비하도록 한다. 기존 `replace_land_area_sync_approval_manifest_v1`과 relation
approval replace RPC는 이 경로에서 모두 호출하지 않는다.

adoption 응답이 commit 뒤 유실될 수 있으므로 동일한 `syncJobId`와 동일한 exact RPC
인자를 최대 3회까지만 재호출한다. RPC는 첫 commit의 durable operation을 찾아 `REUSED`
receipt를 반환해야 하며, 다른 인자 또는 다른 target digest로의 재사용은 거부한다.
postflight는 approval이 consumed 상태로 바뀌었는지도 exact 검증한다.

postflight는 target relation이 exact-one `ACTIVE/LINKED`, property membership 불변,
비대상 relation과 land-area 관련 canonical digest 불변을 요구한다. inspector의
operation attribution은 sync job, operation, base input PNU, command, observation,
observation pair, group state, relation이 각각 1건이고 projection status가 `LINKED`여야
한다. target·Phase 0 manifest·Phase 0 artifact는 배포 컨테이너의 mode 700 비공개
디렉터리로만 전달하고 종료 시 삭제한다. 업로드 artifact에는 원 PNU, 관리번호, property
ID를 넣지 않는다.

부분 wave가 실패해도 runner는 postflight를 생략하지 않는다. 성공 terminal이 확정된
anchor만 expected tuple과 writer attribution을 검사하고, 실패·미실행 anchor는 prestate
불변을 요구한다. 타 조합·비대상 write, non-target tuple 변화, 미확정 anchor 변화는 기존
작업 오류보다 우선하는 safety failure로 기록한다.

현재 공식 건축물대장 `집합/공동주택` 범위는 canonical 83호다. 그중 projection-clean
7개 건물 39호만 대지권 wave 후보이며, 5개 건물 44호와 연결된 shadow property 52행은
별도 canonicalization dry-run·명시 승인 전까지 land-area apply를 차단한다. 로컬
`VILLA`지만 공식 대장이 `일반/단독주택`인 `791-2282` 10호는 이 LDAREG 범위에서 제외한다.

## evidence reference 경계

`sourceReferences`의 `*ReferenceSha256` 값은 사람 검토와 원본 추적을 위한 reference다.
runner가 EC2에서 로컬 Excel이나 과거 artifact 파일을 다시 열어 검증한다는 의미가 아니다.
관찰 reference는 아래에 명시한 UTF-8 canonical JSON의 SHA-256이다. JSON 앞뒤 공백과
마지막 개행은 없으며, key 순서는 표시된 그대로 고정한다. 따라서 원본이 없는 임의 digest를
근거처럼 사용할 수 없다.

```text
selectedCellsReferenceSha256 preimage:
{"cells":{"E29":"791-2166","F29":"161"},"sheet":"미아791"}

phase0ObservationReferenceSha256 preimage:
{"landArea":"161","pnu":"1130510100107912166","runId":"30105293359","strategy":"LADFRL"}

developmentObservationReferenceSha256 preimage:
{"landLotsArea":"161","pnu":"1130510100107912166","propertyUnitId":"5a1a4cbb-c8ad-45a3-ae40-b90665dc949c","unionId":"00f48b95-e9bc-4c92-a0e5-6b9a57adcfb9"}
```

각 preimage의 digest는 각각 다음과 같다.

- selected cells:
  `1d1ec3caca19963e8b296380368a27002d21fc0b72cb48575802aaf9b00f2cfb`
- Phase 0 observation:
  `b20591216e7e7108e5ea3d6fdd8ca774b4acc40a35791d652737b6e975f43497`
- development observation:
  `bb61e80f085e7ce36432c4154427f052884969656c0a315d85cdee5263c84d7f`

따라서 runtime 승인 근거는 reference hash의 형식이 아니라 다음 exact gate다.

- read-only 개발 DB prestate
- 현재 discovery frozen snapshot
- expected property membership
- expected proposed area
- same-run LADFRL/LDAREG evidence
- DB private approval gate
- read-only 개발 DB poststate

대표 reference:

- workbook file reference:
  `13fa8a38896e6964c42121b5e8d46173d4fb89ef629f830005ff815f2da29723`
- sheet/cells: `미아791!E29,F29`
- Phase 0 run: `30105293359`
- Phase 0 artifact file reference:
  `63dc038ffb83ef923a1f760f812271d1d27168aa7c8f5105c2f24b00d7ff167b`
- 개발 property unit:
  `5a1a4cbb-c8ad-45a3-ae40-b90665dc949c`

원본 값이나 소유자 개인정보는 manifest에 넣지 않는다.

## 현재 전체 evidence 분류

- Excel 숫자형 evidence: 275 PNU, digest
  `dc352ca35355d04715d0774d94331c9b918f7fbf208d62e7af96b5b54af20606`
- 그중 274 PNU는 `land_lots.area`와 exact 일치한다.
- PNU `1130510100107450076`은 Excel reference 면적과 개발 `land_lots.area`가
  다르므로 LADFRL 자동 confirmation에서 제외하고 STOP/REVIEW로 남겨야 한다.
- 나머지 24 PNU / 154 active units는 숫자형 evidence가 없으며, 검증된 LDAREG
  scope evidence를 별도로 만들어야 한다.

## workflow 운영 계약

GitHub workflow는 `main`에서만 실행되고 보호 environment
`land-area-sync-development-write`를 사용한다. 이 environment에는 다음 secret이
필요하다.

```text
DEV_GIS_SYSTEM_ADMIN_AUTH_UUID
```

SYSTEM_ADMIN UUID는 공개 `workflow_dispatch` 입력으로 받지 않고 보호 environment의
이 secret에서만 읽어 형식을 검사한 뒤 내부 실행에 사용한다. 값을 로그에 출력하지 않는다.
JWT secret과 개발 service-role key는 GitHub runner로 전달하지 않고 현재 EC2 컨테이너
환경에서만 사용한다.

EC2에서는 deploy-user 소유 mode `600` 파일
`.land-area-sync-operation.lock`을 `flock`으로 잡은 전체 구간에서만 실행한다.
runtime enable/disable 및 deploy는 같은 operation lock을 사용하므로 runner 중
컨테이너를 재기동할 수 없다. lock 소유자는 GitHub SSH shell이 아니라
`nohup + setsid`로 분리한 host guardian이다. 따라서 GitHub 취소나 SSH 단절 뒤에도
guardian은 runner, terminal drain, artifact 검증, 민감 input cleanup이 끝날 때까지
lock을 놓지 않는다. GitHub concurrency group은 pending run을 대체할 수 있으므로
직렬화 권위로 사용하지 않는다.

API `LAND_AREA_SYNC` p-queue의 600초는 worker 실행 상한이고 queue 대기 시간은 별도다.
runner의 job soft deadline은 전파 여유 60초를 더한 660초 이상으로 고정한다. 이 deadline이
지나도 runner는 실패 artifact를 즉시 반환하지 않고, API 일시 오류를 재시도하면서 해당
durable job이 `COMPLETED` 또는 `FAILED`이면서
`workerFinalization={version:1,finalizedAt}` immutable receipt를 가질 때까지 drain한다.
apply RPC는 scopeState/outcome/counts/issues/`issuesTotal`/`issuesTruncated`/receipt를
같은 DB transaction의 한 UPDATE로 확정한다. receipt 없는 raw terminal은 API가
`PROCESSING`으로 투영하고 runner도 terminal로 인정하지 않는다. terminal 확인 후에만
`JOB_POLL_SOFT_TIMEOUT_AFTER_TERMINAL`로 FAIL하므로 cancel endpoint나 새 DB lock 없이도
늦은 job write와 operation lock 조기 해제가 분리되지 않는다. terminal을 영구 확인할 수
없으면 guardian도 lock을 영구 보유하는 것이 의도된 fail-closed 상태다.
discovery/review/failed terminal도 direct `sync_jobs` UPDATE를 쓰지 않고
`finalize_land_area_sync_job_v1`이 phase/outcome/counts/issues를 검증한 뒤 같은 방식의 DB
transaction timestamp receipt로 원자 종결한다. APPLIED/PARTIAL은 이 finalizer가 거부하며
기존 atomic apply RPC만 생성한다.
discovery/confirmation POST 응답 자체가 유실된 경우도 실패로 바로 반환하지 않는다.
runner가 POST 전에 UUID admission key를 생성하고, 5xx/timeout 뒤에는 `latest`나 job id를
추정하지 않고 인증된 union+admissionKey+sourceDiscoveryJobId endpoint만 최대 10회 조회한다.
confirmation apply의 실제 job UUID는 admission key와 다를 수 있다. durable row가 없으면
`AMBIGUOUS_ADMISSION_NOT_DURABLE`로 FAIL하고 중복 POST를 만들지 않는다. exact row가
있으면 anchor/admissionKey/sourceDiscoveryJobId lineage를 대조한다. 아직 PROCESSING이면
DB INSERT 뒤 메모리 queue admission 유실만 복구하도록 동일 key+digest POST를 한 번 재전송한
뒤 같은 terminal drain에 연결한다. confirmation admission RPC v2는 동일 key+동일 request digest replay에 같은
apply job id를 반환하고, 동일 key+다른 digest는 거부한다.

guardian은 lock을 보유한 상태에서 container의 target/approval/evidence/artifact와 host의
target/approval/evidence를 삭제하고 각 경로의 부재를 재검증한다. cleanup 명령이나 부재
검사가 하나라도 실패하면 status `90`으로 고정하며 green을 허용하지 않는다. 로컬 재검증
임시 파일도 같은 방식으로 삭제와 디렉터리 부재를 확인한다. 원격에서 내려받은 full
artifact는 저장소 validator로 다시 검증하고 최종 PASS/FAIL gate를 판정하는 데만 쓴다.
그 검증 뒤 exact-key public artifact를 별도로 만들며, GitHub upload에는 이 공개 파일만
지정한다.

v3 전체 갱신은 7키 또는 호실별 wave로 나누지 않는다. repo-pinned `295`개 컴포넌트를
한 보호 실행에서 직렬 처리한다. workflow 관찰 timeout은 `420`분, guardian runner
비상 timeout은 `300`분, 신규 anchor admission cutoff는 `225`분,
선행 read-only capture timeout은 `60`분,
hard-timeout 뒤 operation-lock quarantine은 `12`분이다. timeout이
나면 새 admission을 만들지 않고 lock을 유지한 채 terminal/cleanup 경계를 지킨다.
기존 v1/v2 승인 bundle은 별도 canary 호환 경로로만 유지한다.

GitHub job이 hard timeout 또는 취소되어 remote cleanup을 호출하지 못한 경우에도
guardian은 container/host 민감 입력을 먼저 삭제한다. status를 쓴 뒤 `20`분 지연
self-cleanup janitor가 operation lock을 다시 얻어 exact run directory의 raw
artifact/status/log까지 삭제한다. 정상 workflow cleanup이 먼저 끝났으면 janitor는
대상이 없음을 확인하고 종료한다.

DB owner approval은 이 workflow가 만들지 않는다. 먼저 approval disabled 상태의
standalone read-only capture PASS를 확인하고, live DEV manifest가 exact `300` PNU,
위 v3 scope digest, enabled, 미만료 상태임을 owner 경로에서 실행 직전 확인해야 한다.
approval은 실행 직전에 발급한 최대 6시간의 non-null expiry로 제한하고 각
confirmation/apply 시점에 1시간 초과 잔여를 요구한다. workflow `420`분은 관찰
상한이며 write window가 아니다. guardian 종료 후 성공·실패·취소와
무관하게 finally disable한다. 현재 `196/disabled` manifest를 그대로 둔 실행은 apply
RPC에서 정상적으로 실패해야 한다. protected workflow는 owner 승인 뒤에도 같은 revision의
embedded fresh capture를 반복해 stale evidence 재사용을 막는다.

## 완료 판정

대표 bundle 또는 일부 호실 PASS만으로 전체 완료라고 보고하지 않는다. 최종 PASS는 적어도 다음을 모두
만족해야 한다.

1. v3 manifest/scope/active-PNU digest가 위 repo-pinned 값과 exact 일치
2. 공식 컴포넌트 `295`, scanned PNU `300`, active PNU `299`
3. pre/post active property unit exact 집합 `429`
4. postflight positive land area `429`, source `MANUAL` 잔여 `0`
5. target source가 evidence strategy와 exact 일치
6. FAILED/REVIEW_REQUIRED/NO_DATA/PARTIAL 잔여 0
   - terminal issues가 `issuesTruncated=false`이고 `issuesTotal===issues.length`
7. property identity digest 불변
8. non-target 4-field tuple digest 불변, writer-job attribution scope exact
9. relation/GIS 7개 테이블 pre/post row-count/content digest 동일(DML `0`)
10. LDAREG rights 변경 target/current-writer 귀속 및 비대상 rights digest 불변
11. guardian terminal drain 및 host/container/local cleanup PASS
12. 개발 feature flag와 allowlist를 후속 disable workflow로 원복
13. 운영 DB write `0`
