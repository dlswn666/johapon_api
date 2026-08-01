# 미아7 791-3568 도로지분 자동화 제외 결정 (429→422 재정의)

날짜: 2026-08-01
결정자: 사용자 (2026-08-01 "422 재정의 포함해서 진행해")
상태: **확정 — 적용됨**

## 결정

미아7 전건 갱신 게이트의 `expectedPropertyUnitCount`를 429에서 **422**로 재정의한다.
제외되는 7건은 PNU `1130510100107913568`(서울 강북구 미아동 791-3568)의 물건지
전부이며(호: B1/B2/101/102/201/202/301), 이들의 `land_area`는 수기(MANUAL) 값을
유지한다.

## 근거 — 공식 원천 부재 (3회 실측)

791-3568은 **지목 도로(landCategoryCode 14), 19㎡** 자투리 필지로:

- 건축물대장 표제부·기본개요·부속지번·전유부 전부 `COMPLETE_ZERO` (phase0 실측)
- 대지권등록부(ldaregList)는 3회 실측 전부
  `ENDPOINT_CONTAINER_MISSING_RESPONSE`로 실패:
  1. 2026-07-28 phase0 run 30389054533 (15표본 매니페스트, 마지막 표본 위치)
  2. 2026-08-01 phase0 run 30689877609 (같은 매니페스트 재실행)
  3. 2026-08-01 phase0 run 30690286210 (**3568 전용 매니페스트, 첫 표본 위치** —
     호출 순서·레이트리밋 가설 기각)

위치와 무관한 결정론적 실패 = 이 필지에는 공식 대지권등록부 데이터가 존재하지
않는다. 자동화의 유일한 인정 원천(LDAREG)이 없으므로 이 7건은 자동 기록이
구조적으로 불가능하다.

DB의 7건은 인접 건물 세대들이 나눠 가진 **도로 지분**을 명부가 별도 물건지로
기재한 것으로, 값의 원천은 등기부(수기 열람)로 추정된다. "API값이 정본" 원칙은
API에 값이 존재할 때만 적용 가능하므로 이 7건은 수기 유지가 옳다.

## 변경 사항

| 파일 | 내용 |
|---|---|
| `development-land-area-sync-manifests/mia-seven-full-278-official-components-api-readonly-target-20260729.json` | expectedPropertyUnitCount 429→422, manifestDigest 재계산 (`10eeb4fb…`) |
| `src/security/development-land-area-full-refresh-policy.ts` | repo-pinned MANIFEST_DIGEST 갱신 |
| `.github/workflows/development-land-area-evidence-capture.yml` | 278-official 항목 property_unit_count 422 |
| `src/operations/development-land-area-sync-runner.ts` | 공개 run artifact의 라벨 고정 검증 429→422 (relationGis pre/postflight 포함) |
| 테스트 4종 | 위 고정값 갱신 |

anchors(278)·allowedScopePnus(301)·expectedUnionActivePnus(299)·
expectedUnionActivePropertyUnitCount(429)는 그대로다 — DB 활성 상태의 진실값과
스캔 커버리지 요구는 변하지 않고, **자동 기록 커버리지 기대만** 422로 줄었다.
3568은 여전히 활성 PNU로 스캔되지만(299 도달 검증 유지) 그 물건지들은 evidence
커버리지 밖이다. 게이트의 SET-일치 검증은 expected==active(429)일 때만 발동하는
설계라 422 재정의로 자동 비활성화되며, COUNT 검증(=422)이 커버리지를 담당한다.

## 함께 해소된 791-2155 (같은 날, 코드로 해결)

ord 21(791-2155)의 REVIEW 이슈 3건은 반층 witness 하나로 전부 해소됐다
(`provider-unit-shape-bridge.ts` — LDAREG `4.5`/`401` ↔ EXPOS 지상4/401,
2026-08-01 GIS 인스펙터 실측 원문). bridge 게이트는 anchor 단위 all-or-nothing이라
witness 없는 반층 행 하나가 `sourceRawWitnessConsistent`를 무너뜨려 지하
`지`/`비01`까지 함께 PNF ×2 + bijection ×1로 차단하고 있었다. 등기 스캔 고아
building_unit(B01, registry_external_id 1010142714)은 매칭을 막지 않는다 —
matcher 4단계가 활성 물건지 연결이 증명된 수기 후보를 우선한다
(`tests/land-area-sync-ldareg-branch.test.ts`의 "runtime 791-2155 실측 형상"
회귀 테스트로 고정). **dev DB 데이터 보수는 불필요했다.**

## 다시 여는 조건

3568의 대지권등록부가 향후 공식 API에 등재되면(예: 등기 정비), 이 결정을 되돌려
429 매니페스트로 복귀할 수 있다. 그 전에는 3568 물건지의 land_area 수동 변경만
허용된다.
