# 운영 대지권 백필 — 인계 문서 (2026-08-11)

> **2026-08-12 진행 갱신** — §3-A·§3-B 완료, §3-C 선행 1건 추가 완료.
>
> - 3-A 러너·캡처 TS 일반화: api `27a0861`. digest·JWT·env·allowlist 전부
>   databaseTarget 축. production v3 는 full-refresh marker 를 만들지 않는다.
> - 3-B 운영 매니페스트: api `da62881`,
>   `…-production-target-20260812.json` (digest 3종 재계산: 730b3757 / 1ed934de /
>   352212dc). 운영 실측: 활성 PNU 집합 md5 가 dev 매니페스트와 exact 일치,
>   429 물건지 / land_area 0 / 3568 도로지분 7건 확인.
> - 캡처 워크플로 운영 read-only 경로: api `fabce86`. **다음 스텝 = 이 경로
>   디스패치**(무쓰기). 결과가 실행 창 설계를 결정한다: 전부 DB_RESOLVER 로
>   해석되면 그대로 write run 설계로, official 확장이 필요한 anchor 가 나오면
>   그 실패 코드를 보고 관계 채택(운영 이식 완료된 트랙) 또는 프로파일 이식을
>   선택한다. 캡처는 main SHA exact 일치 필요 — Docker Build and Deploy 완료 후
>   디스패치할 것.

**목표**: 미아7 운영 물건지 **429건의 `land_area` 를 채운다.** 지금 전건 NULL 이라
면적 기준 동의율이 아예 계산되지 않는다.

dev 에서는 2026-08-03 run 20 으로 완주했다(anchor 278/278 APPLIED, 물건지 422/422).
이 문서는 그 경로를 운영에서 돌리기 위해 **오늘 끝낸 것**과 **다음에 할 것**을 남긴다.

---

## 1. 운영 DB 현재 상태 (2026-08-11 실측)

```
land_area_sync identity        production      ← 변경 불가, 설정 완료
building_registry_land_lot_relations   1행     ← 오늘 채택 완료
land_area_sync 승인 manifest    0 (열린 것 없음)
채택 승인 manifest              0 (consumed 로 닫힘)
property_unit_land_rights       0행
LAND_AREA_SYNC sync_jobs        0건
미아7 활성 물건지               429건 / land_area 보유 0건   ← 이걸 채우는 게 목표
미아7 필지                      300
```

**운영 대지권 데이터는 아직 하나도 없다.** 오늘 한 것은 전부 "통로 열기"였다.

---

## 2. 오늘 완료된 것

### DB (운영)

| 적용 | 내용 |
|---|---|
| 범용 인프라 10종 | 승인 manifest 게이트 / 원자 종결 / confirm v2 / finalize / rootless / 원장 확장 / preview RPC / service_role SELECT 2종 / canonicalVersion 3 / source_kind |
| 채택 트랙 | 테이블 2 + 함수 6 (RLS ENABLE+FORCE) |
| `database_target` 일반화 | 채택 트랙을 production 까지 확장 |
| identity | `production` (2026-08-11 06:52:09Z, **변경 불가**) |
| Phase 0 스키마 승인 확대 | 구 `99d06939…` + 현행 `0909518650…` 2종 |
| relation 증거 | 1행 (base 791-2280 / attached 791-2281 / 건물 10101100184244) |

**dev↔운영 함수 md5 전건 일치 확인됨.** 데이터 변경은 relation 1행이 전부.

### 코드

```
web  dev = master = 7345365b
api  main         = b01a3d8
```

- web `4a47f80d` 채택 트랙 database_target 일반화 마이그레이션
- web `7345365b` Phase 0 artifact 스키마 승인 확대
- api `b6c642d` 채택 CLI production target 지원
- api `21837d4` 운영 타깃 문서 + setup 문서
- api `b01a3d8` 채택 워크플로 운영 경로

### 인프라

- GitHub 환경 `land-area-sync-production-write` 생성됨 (리뷰어 dlswn666, main 한정)
- Phase 0 캡처 run **31467832037** (gate PASS, artifact sha `08998d1c…`)
- **EC2 컨테이너는 운영 Supabase 키를 이미 보유** — `.env.example` 대로
  `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`(운영) + `DEV_SUPABASE_*`(개발) 둘 다.
  추가 설정 불필요. (오늘 채택 실행이 이걸로 성공했다.)

---

## 3. 다음에 할 일

### 3-A. 러너 TS 일반화 (운영 무접촉, 먼저 하면 안전)

`'development'` 리터럴이 두 파일에 몰려 있다.

```
src/operations/development-land-area-sync-runner.ts        25곳
src/operations/development-land-area-evidence-capture.ts    6곳
src/services/land-area-sync/{service,repository}.ts         0곳
src/routes/gis.ts                                           0곳
```

**채택 트랙(api `b6c642d`)과 같은 방식으로 하면 된다** — 그 커밋이 그대로 참고 자료다:
`RelationAdoptionDatabaseTarget` 유니온 + 멤버십 가드를 만들고, 리터럴을 변수로 바꾸고,
CLI 는 target→env키 맵으로 전환하고, 타깃 문서와 접속 DB 불일치를 교차 검증.

⚠️ **digest 계산부는 건드리는 순간 값이 바뀐다.** runner.ts:542 는
`${databaseTarget}:${unionId}:${pnu}`, :551 은 `canonicalTargetValue('development', …)`.
여기는 "일반화 대상"이 맞다(채택의 digest namespace 토큰과 달리 실제 환경 축이다).

### 3-B. 운영 매니페스트 생성

dev 매니페스트 `development-land-area-sync-manifests/mia-seven-full-278-official-components-api-readonly-target-20260729.json`
를 기준으로 production 판을 만든다.

```
databaseTarget                development → production
scopeDigest                   a138f331…   → 재계산
manifestDigest                17f07208…   → 재계산
expectedUnionActivePnuDigest  db754ce3…   → 재계산
anchors 278 / allowedScopePnus 300 / expectedUnionActivePnus 299
```

**digest 는 손으로 쓰지 말 것.** 저장소 함수로 생성하고 저장소 파서로 자체 검증한다
(오늘 운영 타깃 문서를 그렇게 만들었다 — api `21837d4` 참고).

먼저 확인할 것: 운영의 활성 PNU/물건지 수가 dev 와 같은지.
dev 기준은 활성 PNU 299 / 물건지 429 / 앵커 278 / 스코프 300 이고,
오늘 실측으로 **운영도 필지 300 · 물건지 429** 로 같았다.

### 3-C. 실행 (창 개폐 — 집중된 세션에서)

```
1. land_area_sync 승인 manifest 발급   ← owner, replace_land_area_sync_approval_manifest_v1
2. allowlist enable                    ← land-area-sync-runtime-allowlist.yml (action=enable)
3. 러너 워크플로 디스패치 + 환경 승인
4. ⚠️ disable 로 원복                   ← 반드시
5. 검증
```

⚠️ **2~4 는 한 세션에서 끝내야 한다.** enable 상태로 남으면 운영이 쓰기 가능한 채로
방치되고, 일반 main push 배포까지 fail-closed 로 막힌다. dev 에서 이 창을 20번
열고 닫으며 완주했다.

### 3-D. 검증 (성공 기준)

```sql
-- 미아7 429건이 전부 채워졌는가
select coalesce(pu.land_area_source,'(null)') src, count(*), count(pu.land_area)
from property_units pu join unions u on u.id=pu.union_id
where u.slug='mia-seven' and pu.is_deleted=false group by 1;
-- dev run 20 기준: LADFRL 279 + LDAREG 143 + MANUAL 7 = 429
```

`property_unit_land_rights` 는 dev 에서 ACTIVE 253행이었다.

---

## 4. 반드시 알고 가야 할 함정

1. **full-refresh 마커는 조건부다** — `service.ts:343 if (developmentFullRefresh)`.
   매니페스트가 안 실으면 dev 전용 가드(`assert_mia7_development_full_refresh_marker_v1`,
   `revalidate_mia7_development_full_refresh_scope_v1`, 26KB+)를 안 탄다. 운영 confirm v2 는
   그 분기가 없는 기본판이므로 **이 가드 2종을 이식할 필요가 없다.** 매니페스트 설계로 피할 것.

2. **자격증명은 GitHub 시크릿이 아니라 EC2 컨테이너 env 에서 온다.**
   실행 경로가 `Actions → SSH → docker exec` 라서다. 계약 테스트가 워크플로에
   Supabase 시크릿이 등장하면 실패시킨다. (오늘 한 번 잘못 안내했다가 정정한 지점.)

3. **`docker exec -e` 로 실행 시점에만 target 주입.** 컨테이너 `.env` 를 영구히
   production 으로 바꾸면 평소 dev 작업이 깨진다. 채택 워크플로가 이미 그 패턴이다
   (api `b01a3d8` 참고). 미지정이면 development 폴백.

4. **`gh api` 환경 생성**: `-f wait_timer=0` 은 문자열 `"0"` 이라 422.  `-F` 를 쓸 것.

5. **캡처/러너는 EC2 컨테이너가 main SHA 와 exact 일치해야 한다**(exit 67).
   main 푸시 후엔 "Docker Build and Deploy" 완료를 확인하고 디스패치할 것.

6. **환경 승인은 사람이 눌러야 한다** — 권한 분류기가 에이전트의 자동 승인을 막는다.
   이건 결함이 아니라 이 파이프라인에서 유일하게 작동하는 사람-게이트다.

7. **같은 체크아웃에 병렬 세션이 돌면 커밋이 섞인다.** 오늘 실제로 겪었다
   (내 브랜치 위에 다른 세션의 에디터 커밋이 얹혔고, 같은 내용이 origin/dev 에도
   별도 SHA 로 들어와 중복 2개가 생겼다). 커밋 직전 브랜치 확인 필수.

---

## 5. 참고 문서

- `docs/2026-08-11-production-relation-adoption-setup.md` — 채택 트랙 준비 항목
- `docs/2026-08-01-mia7-3568-road-share-carveout.md` — 429 vs 422 차이(도로 지분 7건)
- dev 완주 기록은 메모리 `mia7-land-area-gate-progress` 참조
