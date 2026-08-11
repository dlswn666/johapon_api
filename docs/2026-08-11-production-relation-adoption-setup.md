# 운영 relation 채택 실행 — 남은 준비 항목 (2026-08-11)

미아7 운영 대지권 백필의 마지막 선행과제는 `building_registry_land_lot_relations`
**1행**(base 791-2280 / attached 791-2281 / 건물 10101100184244)이다. 이 행이 없으면
resolver 가 두 필지를 별개로 보고, all-or-nothing 게이트가 429건 전체를 막는다.

DB·코드 쪽 준비는 끝났다. 남은 것은 **자격증명과 GitHub 환경**뿐이며, 이 문서는 그것만 다룬다.

## 완료된 것

| 항목 | 상태 |
|---|---|
| 운영 DB 에 채택 트랙 설치 | 완료 (테이블 2 + 함수 6, RLS ENABLE+FORCE) |
| `database_target` 일반화 | 완료 (dev·운영 함수 md5 일치) |
| 운영 DB identity | `production` (2026-08-11 06:52:09Z, **변경 불가**) |
| Phase 0 artifact 스키마 승인 확대 | 완료 (구·현행 2종, dev·운영 md5 일치) |
| Phase 0 캡처 | run **31467832037**, gate PASS, 실패 코드 0 |
| 운영 타깃 문서 | `mia-seven-791-2280-2281-target-production-20260811.json` |
| CLI production target 지원 | 완료 (`RELATION_ADOPTION_DATABASE_TARGET`) |

운영 데이터는 아직 **하나도 바뀌지 않았다**: 승인 manifest 0 / relations 0 / 원장 0 /
미아7 429건 `land_area` 전부 NULL.

## 남은 준비 항목

### 1. GitHub 환경 `land-area-sync-production-write` 생성

⚠️ **먼저 만들고 보호 규칙을 걸어야 한다.** GitHub 은 워크플로가 존재하지 않는 환경 이름을
참조하면 **보호 규칙 없이 자동 생성**한다. 즉 워크플로부터 고치면 승인 게이트가 없는 채로
운영 쓰기 경로가 열린다. 순서를 지킬 것.

필요한 설정:
- Required reviewers 지정 (dev-write 환경과 동일 수준)
- 시크릿: 운영 Supabase 접속에 필요한 값

### 2. EC2 컨테이너의 운영 자격증명

채택 CLI 는 EC2 에서 돌고, 현재 컨테이너 `.env` 는 dev Supabase 를 본다. 운영 실행에는
아래가 필요하다 (CLI 는 target 별로 다른 키 이름을 읽는다).

```
RELATION_ADOPTION_DATABASE_TARGET=production
SUPABASE_URL=https://bpdjashtxqrcgxfequgf.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<운영 service role>
DATA_PORTAL_API_KEY=<건축물대장>
LAND_AREA_SYNC_ENABLED=false        # 캡처-안전 자세 유지 (CLI 가 exact 강제)
```

CLI 는 **선언한 target 과 실제 URL 이 일치하지 않으면 거부**한다
(`RELATION_RUN_ENVIRONMENT_INVALID`). 또 타깃 문서의 `databaseTarget` 과 접속 DB 가 다르면
`RELATION_RUN_DATABASE_TARGET_MISMATCH` 로 즉시 멈춘다.

### 3. 채택 워크플로에 운영 경로 추가

`.github/workflows/development-building-registry-relation-adoption.yml`

- `inputs.target` 의 `options:` 에
  `mia-seven-791-2280-2281-production-20260811` 추가
- `environment:` 를 `land-area-sync-development-write` 고정에서 target 에 따라 분기
  (1번 환경을 **만든 뒤에** 변경할 것)

### 4. 실행 직전: 운영 승인 manifest 발급

owner 전용 `public.replace_development_building_registry_relation_adoption_approval_v1`
(service_role 도 REVOKE — SQL 에디터/MCP 로 실행). **`expires_at` 은 발급 시각 +15분 이내**
여야 하므로 실행 직전에 찍는다. 인자는 운영 타깃 문서의 값을 그대로 쓰고,
`p_target_digest` 는 DB 가 재계산해 대조한다.

## 실행 순서

```
1. GitHub 환경 생성 + 보호 규칙          ← 사람
2. EC2 .env 에 운영 자격증명             ← 사람
3. 워크플로에 운영 옵션/환경 분기 추가    ← 코드 변경
4. 승인 manifest 발급 (15분 창)          ← owner
5. 채택 워크플로 디스패치 + 환경 승인
6. 검증: relations 1행, 미아7 2280/2281 이 NO_EVIDENCE → LINKED
```

## 참고 — 왜 dev artifact 를 재사용하지 않았나

Phase 0 캡처는 DB 를 전혀 건드리지 않는다(`DATA_PORTAL_API_KEY`/`VWORLD_*` 만 사용,
Supabase 참조 0건, 워크플로 environment 가 `phase0-production-readonly`). 따라서 artifact 는
국가 공부 데이터라 환경 무관이지만, 운영 반영의 감사 추적을 위해 **운영용으로 새로 캡처**했다.

실측으로 확인된 사실: 새 캡처의 `officialHashes` 7종이 7월 dev 캡처와 **전부 동일**하다.
공부 데이터가 그대로이고 캡처가 결정적이라는 뜻이다. 운영 타깃 문서가 dev 문서와 다른 값은
20개 필드 중 5개뿐이다 — `databaseTarget`, phase0 캡처 핀 3종, 그리고 문서 자기해시
`manifestDigest`.
