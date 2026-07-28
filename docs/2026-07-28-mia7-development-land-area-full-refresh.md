# 미아7 개발 대지권 전체 공식 API 재조회

## 목표

개발 DB의 미아7구역 활성 `property_units` 전체를 공식 API로 새로 조회해 대지권 값을
적용한다. 특정 호실, 7개 건물, 기존 relation에 잡힌 물건만 처리하는 백필은 목표가 아니다.
운영 DB 적용은 이 문서의 범위가 아니며 모든 production target은 hard deny한다.

## 고정 대상

source of truth는
`development-land-area-sync-manifests/mia-seven-full-295-components-api-readonly-target-20260728.json`
이다.

| Gate | Exact 값 |
| --- | ---: |
| union | `00f48b95-e9bc-4c92-a0e5-6b9a57adcfb9` |
| 공식 컴포넌트 anchor | `295` |
| 활성 PNU | `299` |
| 공식 API scan 허용 PNU | `300` |
| 활성 property unit | `429` |
| active PNU digest | `db754ce378896d45bb09b66ffe1174577a805fa74d264ed59ed17c9d97a78cbc` |
| scope digest | `8c87b46f17416cd5aad9aaa242f09ff04aefb4186f74b72370ebb9c1407caa73` |
| manifest digest | `02bf999d970a9f0228a0bc683cc630fb157e5f4becb8576d0f4aa5b4dec1d3db` |

이 값 중 하나라도 다르면 DB write 전에 중단한다.

## 실행 계약

1. 보호된 개발 write workflow가 exact v3 target과
   `DEVELOPMENT_FULL_REFRESH_API_REQUERY_V1` 표식을 검증한다.
2. 같은 보호 실행 안에서 `LAND_AREA_SYNC_ENABLED`를 비활성화한 read-only capture를
   실행한다.
3. capture는 공식 Building HUB/V-World API로 `295`개 컴포넌트와 `300`개 허용 PNU를
   조회하고, 활성 `429`개 property membership과 활성 `299`개 PNU 집합을 exact
   검증한다.
4. capture write counter가 모두 `0`이고 gate와 promotion gate가 `PASS`일 때만 임시
   evidence를 만든다. raw evidence와 DB approval은 GitHub artifact로 넘기지 않는다.
5. runner는 이전 `latest/APPLIED` job을 재사용하지 않고 `295`개 anchor 모두에 새
   discovery를 만든다.
6. discovery는 공식 API를 다시 조회한다. evidence의 `officialComponentDigest`와
   discovery snapshot의 digest가 exact 일치해야 confirmation으로 진행한다.
7. apply job은 공식 API를 다시 조회하고 DB가 고정한 property membership과 scope
   concurrency hash를 재검증한 뒤 기존 atomic apply RPC로만 적용한다.
8. postflight에서 활성 identity 불변, 대상 4-field tuple, writer job 귀속, 비대상 tuple
   불변을 검증한다.
9. 모든 비공개 target/evidence/approval/artifact를 삭제하고 부재를 재검증한다.

## 데이터 사용 경계

- 공식 API의 current LDAREG 분자 또는 검증된 LADFRL 면적만 제안값을 만든다.
- 기존 `MANUAL` 숫자는 계산, 매칭, source selection, fallback에 사용하지 않는다.
- 기존 tuple은 동시성 guard로만 읽는다.
- API 값이 기존 MANUAL 숫자와 같아도 `land_area_source`,
  `land_area_synced_at`, `land_area_sync_job_id`를 자동 provenance로 갱신한다.
- relation/GIS 7개 테이블(`land_lots`, `building_land_lots`, `buildings`,
  `building_units`, `building_external_refs`,
  `building_registry_land_lot_relations`,
  `building_land_lot_manual_overrides`)은 scope 선택에 사용하지 않으며 이 실행의
  DML 대상이 아니다. pre/post exact-count snapshot과 content digest가 같아야 한다.
- `property_unit_land_rights`는 relation/GIS 불변 집합이 아니라 LDAREG apply의 의도된
  원장 대상이다. 변경 행은 evidence scope와 현재 writer job에 exact 귀속되고 비대상
  rights digest는 불변이어야 한다. LADFRL 결과는 rights를 변경하지 않는다.
- 기존 DB scope hash와 membership은 동시성 및 비대상 변경 감지에만 사용한다.

## PASS/FAIL

PASS는 다음 조건을 모두 만족할 때만 가능하다.

- exact v3 target과 DEV-only 표식
- capture와 runner에서 `295/299/300/429` exact
- capture DB write `0`
- discovery/apply official component digest 일치
- 처리 결과 `APPLIED`, issue `0`, property `429` coverage
- postflight 양수 대지권 `429`, MANUAL source 잔여 `0`
- property identity 및 비대상 4-field tuple 불변
- relation/GIS 7개 테이블 pre/post row-count/content digest 동일(DML `0`)
- LDAREG `property_unit_land_rights` 변경은 target property/PNU/current writer에만
  귀속되고 비대상 rights 불변
- 운영 DB write `0`
- private 파일 cleanup PASS

하나라도 충족하지 않으면 FAIL이며 다음 anchor admission을 중단한다. 일부 성공을 전체
완료로 보고하지 않는다.

## 런타임 상한

- GitHub workflow 관찰 상한: `420`분
- 선행 read-only capture: `60`분
- guardian runner 비상 상한: `300`분
- runner 신규 anchor admission cutoff: `225`분
- API job admission wall timeout: `10`분(queue 대기 포함, AbortSignal로 실제 worker drain)
- hard-timeout 뒤 operation-lock quarantine: `12`분

timeout은 성공으로 간주하지 않는다. guardian은 terminal과 민감 파일 cleanup 경계를
확인할 때까지 operation lock을 유지한다. GitHub 취소로 remote cleanup이 실행되지 않으면
guardian 종료 뒤 `20`분 janitor가 exact host run directory의 raw artifact/status/log를
삭제한다.

## DEV DB owner approval 수명주기

GitHub/API service-role workflow는 owner-only
`replace_land_area_sync_approval_manifest_v1`을 호출하지 않는다. API 실행 권한과 DB
owner 승인을 한 credential에 합치지 않기 위한 경계다.

2026-07-28 실행 전 관찰된 live DEV approval은 `196/disabled`이므로 full295 apply 준비가
끝난 상태가 아니다. 실행 관리자는 DB owner 경로에서 다음을
수행해야 한다.

1. approval disabled 상태에서 standalone read-only capture가 `295/295` official
   component와 `429` property coverage로 PASS했는지 먼저 확인한다.
2. database target `development`, 위 union, exact `300` PNU, scope digest
   `8c87b46f17416cd5aad9aaa242f09ff04aefb4186f74b72370ebb9c1407caa73`로 기존 approval
   manifest를 교체한다.
3. `enabled=true`, `expires_at`은 실행 직전 정확히 최대 6시간의 non-null 창으로
   발급한다. 각 confirmation/apply
   시점에는 1시간보다 많이 남아 있어야 한다. workflow `420`분은 결과 관찰 상한일 뿐
   approval write window를 연장하지 않는다.
4. owner read-only preflight에서 enabled, 미만료, declared/actual target `300`, digest,
   union, development target을 exact 재검증한다.
5. 같은 revision의 protected full-refresh workflow를 즉시 시작한다. 보호 workflow는
   stale artifact 재사용을 막기 위해 embedded fresh capture를 한 번 더 수행한 뒤 runner를
   시작한다.
6. guardian terminal과 cleanup이 끝나면 성공·실패·취소와 무관하게 `finally`에서
   approval을 disabled로 교체하고 disabled/target/digest poststate를 read-only
   재검증한다.

owner credential, raw 300 PNU 목록, approval request는 GitHub artifact나 API 컨테이너
환경에 저장하지 않는다. expiry 또는 exact target preflight를 충족하지 못하면 workflow를
시작하지 않는다. 실행 중 approval이 바뀌거나 만료되면 apply RPC가 fail-closed해야 한다.

## 배포 전 남은 게이트

- 개발 DB catalog에서 기존 confirmation/apply RPC의 기대 signature와 최소 확장
  migration 적용 여부 확인
- DEV owner approval을 exact `300` scope로 제한 시간 enable하고 종료 시 disable하는
  lifecycle 실행
- 동일값 MANUAL provenance 교체와 2/3-PNU LDAREG replica SQL fixture 실행
- 개발 API 배포 후 protected full-refresh workflow 실호출
- 공개 sanitized artifact와 private postflight 결과에서 위 PASS 조건 확인

운영 적용은 별도 사용자 승인과 별도 production gate 없이는 수행하지 않는다.
