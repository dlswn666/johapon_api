# 한 지번 복수 root(복수 동) 설계 개정안 (2026-07-30)

대상: `docs/2026-07-23-land-area-sync-design.md` §9.1 · §9.2 · §10.4 · §12.3 · §12.4
계기: 미아7 791-2282(anchor ordinal 108) 보류
상태: **구현됨 (2026-07-30). 원 설계 §9.1·§9.2·§10.4·§12.3·§12.4 에 반영 완료.**
구현 계획: [`2026-07-30-multi-root-land-right-root-election-implementation-plan.md`](./2026-07-30-multi-root-land-right-root-election-implementation-plan.md)

## 1. 배경

미아7 278-anchor 게이트에 남은 보류 3건 중 하나가 791-2282다. 공식 건축물대장 표제부가
**2행**이다(2026-07-28 phase0 capture run 30389054533, 2026-07-30 GIS 인스펙터 재확인).

| 행 | regstrGbCd | mainPurpsCd | mainPurpsCdNm | etcPurps 신호 |
|---|---|---|---|---|
| 1 | `1` (일반) | `01000` | 단독주택 | `DETACHED_HOUSE` |
| 2 | `2` (집합) | `02000` | 공동주택 | (없음, 원문은 존재) |

한 지번에 일반건축물 1동과 집합건물 1동이 실제로 서 있다. 데이터 이상이 아니라 **정상적인
물리 상태**다.

엔드포인트별 실측: TITLE 2, BASIS 12, ATTACHED 0, EXPOS 10, LADFRL 1, LDAREG 11.
DEV DB 활성 물건지는 10호이고 전부 같은 building(`광미빌라`)의 세대에 연결돼 있다.

현행 코드는 이를 `BUILDING_CLASSIFICATION_CONFLICT`로 판정해 `REVIEW_REQUIRED`로 닫는다.

## 2. 현행 설계가 이 상황을 어떻게 다루는가

설계 본문에 **"복수 동"이라는 물리 개념 자체가 없다.** `root 관리번호 여러 개 →
REVIEW_REQUIRED`라는 판정 규칙만 있고, 그 규칙은 복수 root를 *분류 불능·데이터 이상*으로
전제한다. "한 지번에 두 동이 정상적으로 서 있는 경우"는 모델링된 적이 없다.

§3.2가 "신규 동(棟) 엔티티"를 비범위로 명시했고, 상류 building-registry auto-link 설계는
`MULTI_BUILDING_ON_PARCEL` 전용 코드와 "모델 개편 전 자동 투영 금지"를 선언했다. 재건축 갭
감사는 동 엔티티를 3대 구조적 선행과제 중 2번(critical)으로 지목한다.

즉 791-2282는 우연한 예외가 아니라 **알려진 선행과제가 데이터에 드러난 사례**다.

## 3. 개정을 가능하게 하는 사실

대지권은 **집합건물 전유부에 딸린 권리**다. 일반건축물 소유자는 토지를 직접 소유하므로
대지권등록부에 지분 행을 갖지 않는다.

791-2282 실측이 이와 정확히 일치한다.

```
LDAREG 11행 = 집합건물 전유 10호 + placeholder 1행
              (일반건축물 몫 0행)
EXPOS  10행 = 집합건물 전유 10호
DB     10호 = 같은 10호
```

따라서 이 anchor를 처리하는 데 **동 엔티티 전면 개편은 필요하지 않다.** 필요한 것은
"표제부 root가 여럿일 때, 대지권등록부에 근거를 가진 root를 골라내는 규칙"이다.

이 규칙은 복수 root를 일반적으로 허용하는 것이 아니다. **LDAREG 매칭 축은 여전히 단일
root**이며, 달라지는 것은 그 단일 root를 *어떻게 고르는가*뿐이다.

## 4. 개정 조항

### 4.1 §9.1 모집단 — 마지막 확인 항목

**현행**
> - 모든 행이 같은 root 관리번호 계열인지 확인

**개정안**
> - 표제부 root 관리번호가 여럿이면, 그 중 **대지권등록부(LDAREG)에 행 근거를 가진 root가
>   정확히 하나**일 때만 그 root를 대지권 대상으로 삼는다. 나머지 root는 `대지권 무관 동`으로
>   기록하고 물건지 투영 대상에서 제외한다. LDAREG 근거 root가 0개이거나 2개 이상이면
>   `REVIEW_REQUIRED`다.
> - 분류·매칭은 선택된 대지권 대상 root의 표제부 행만으로 수행한다. 제외된 root의 표제부
>   행은 분류 입력에 넣지 않는다.
> - 기본개요(BASIS)·전유부(EXPOS) closure 판정은 **전체 root 집합**을 accepted root로 삼는다.
>   제외된 동의 BASIS 행이 closure 밖으로 떨어져 전체가 차단되지 않게 하기 위해서다.

두 축을 분리하는 것이 이 개정의 핵심이다. `closure 축`은 전체 root, `대지권 매칭 축`은
선택된 단일 root다.

### 4.2 §9.2 결정표 — 행 교체

**현행**

| 대장·용도 판정 | 자동 전략 | 결과 |
| --- | --- | --- |
| root 관리번호 여러 개 | 없음 | `REVIEW_REQUIRED` |
| 일반·집합 또는 purpose pair 혼재 | 없음 | `REVIEW_REQUIRED` |

**개정안**

| 대장·용도 판정 | 자동 전략 | 결과 |
| --- | --- | --- |
| root 관리번호 여러 개, LDAREG 근거 root 0개 또는 2개 이상 | 없음 | `REVIEW_REQUIRED` |
| root 관리번호 여러 개, LDAREG 근거 root 정확히 1개, 그 root의 표제부 행이 공식 다세대 pair | `LDAREG` | 선택 root의 물건지×PNU 대지권 합계. 나머지 root는 `대지권 무관 동`으로 제외 |
| 단일 root에서 일반·집합 또는 purpose pair 혼재 | 없음 | `REVIEW_REQUIRED` |
| 공식 `2 / 02000 / 공동주택` pair, 부속용도 `다세대주택` 토큰 없음, 지상 층수 ≤ 4 이고 연면적 ≤ 660㎡ | `LDAREG` | 다세대주택으로 인정 (§6) |
| 공식 `2 / 02000 / 공동주택` pair, 토큰 없고 지상 층수 ≥ 5 또는 연면적 > 660㎡ 또는 두 값 결측·파싱 실패 | 없음 | `REVIEW_REQUIRED` |

기존 "혼재 → REVIEW" 규칙은 **단일 root 안에서의 혼재**로 범위를 좁혀 그대로 유지한다.
복수 root에서 대장 구분이 갈리는 것은 정상이므로 혼재로 보지 않는다.

연립주택·아파트를 `REVIEW_REQUIRED`로 두는 기존 행도 그대로 둔다 — §6.3대로 규모 기준이
그 둘을 구조적으로 배제하므로 두 규칙은 충돌하지 않는다.

### 4.3 §10.4 — LDAREG root 축

**현행**
> LDAREG 호실 매칭의 root 축은 연결된 모든 base title의 exact `mgmBldrgstPk` self
> 집합이다. **이 집합이 정확히 하나가 아니면 적용하지 않는다.**

**개정안**
> LDAREG 호실 매칭의 root 축은 연결된 모든 base title의 exact `mgmBldrgstPk` self 집합에서
> **LDAREG 행 근거를 가진 root만 남긴 부분집합**이다. 이 부분집합이 정확히 하나가 아니면
> 적용하지 않는다. 근거 판정은 같은 실행의 LDAREG 응답과 EXPOS 전유부의 root 귀속으로만
> 하며, 행 수·비율값·건물명 유사도로 추정하지 않는다.
>
> scope resolver seed의 `mgmUpBldrgstPk ?? mgmBldrgstPk` 계열 축은 관계 탐색용이며,
> LDAREG의 title-root self 축과 섞지 않는다. (현행 유지)

### 4.4 §12.3 — 보조 상관의 복수 root 차단

**현행**
> 서로 다른 동/건물명, **복수 root**, 같은 `층+호` 중복, valid와 ratio-missing 행의
> `층+호` 겹침이 하나라도 있으면 축약형을 사용하지 않고 전체를 차단한다.

**개정안**
> 서로 다른 동/건물명, **선택된 대지권 대상 root 밖의 root 근거**, 같은 `층+호` 중복,
> valid와 ratio-missing 행의 `층+호` 겹침이 하나라도 있으면 축약형을 사용하지 않고 전체를
> 차단한다.

보조 상관(§12.3)은 exact 매칭이 실패했을 때만 쓰는 완화 경로이므로, 여기서는 **선택된 root
범위 밖의 근거가 섞이는 것**을 계속 차단한다. 개정 전과 실질 강도가 같다.

### 4.5 §12.4 매칭 순서 2단계

**현행**
> 2. 전유부 root identity와 scope root identity 일치

**개정안**
> 2. 전유부 root identity가 **선택된 대지권 대상 root**와 일치

## 5. 개정하지 않는 것

- **분모 계산.** 대지권 분모는 대지 전체 면적이고 두 동이 같은 분모를 공유한다. 실측
  27.8/264, 28.3/264가 현행 tolerance 검사와 이미 정합한다. 건물별 분모 분할 개념은
  도입하지 않는다. §11의 "분자를 그대로 면적으로 쓴다" 계약도 그대로 둔다.
- **§3.2 비범위 "신규 동(棟) 엔티티".** 이 개정은 동 엔티티를 만들지 않는다. root 선택
  규칙만 추가한다. 동 엔티티 개편은 별도 선행과제로 남는다.
- **parcel-singleton(LADFRL) 경로.** 활성 물건지 1건 + 호 identity 부재를 요구하는 계약을
  그대로 둔다. 호별 대지권이 필요한 집합건물은 이 경로를 통과할 수 없다는 §1 조항 유지.
- **일반건축물 동의 물건지 처리.** 제외된 동에 조합원 물건지가 생기면 그때 별도 판단한다.
  현재 미아7에는 없다.

## 6. `02000 공동주택` 분류 — 법정 규모 기준 도입

**791-2282의 집합건물 행은 4절 개정만으로는 통과하지 못한다.**

현행 허용목록(`housing-purpose-allowlist.fixture.ts:52-60`)은 `2 / 02000 / 공동주택` pair에
부속용도 토큰 `다세대주택`(`MULTIPLEX_HOUSE`)을 함께 요구한다.

2026-07-30 GIS 인스펙터로 표제부 원문을 확인한 결과 **부속용도가 주용도와 같은 `공동주택`**
이었다. 즉 추가 정보가 없어 "인정 가능한 토큰을 좁게 추가"하는 방식은 성립하지 않는다.
`공동주택`을 토큰으로 인정하는 것은 토큰 요구를 없애는 것과 실질적으로 같다.

### 6.1 실측

| 항목 | 집합건물 | 일반건축물 |
|---|---|---|
| 관리번호 | `1010114204` | `1010111086` |
| 주용도 | `02000` 공동주택 | `01000` 단독주택 |
| 부속용도 | `공동주택` | `단독주택` |
| 지상 / 지하 층수 | 4 / 1 | 1 / 0 |
| 연면적 | 513.06㎡ | 88.8㎡ |
| 세대수 | 10 | 0 (가구 1) |
| 사용승인 | 1996-02-14 | 1957-04-28 |

### 6.2 개정 — 법정 규모 기준

건축법 시행령 별표1의 공동주택 세부 구분은 규모로 정해진다.

- **아파트** — 주택으로 쓰는 층수가 5개 층 **이상**
- **연립주택** — 주택으로 쓰는 1개 동 바닥면적 합계가 660㎡ **초과**, 층수 4개 층 이하
- **다세대주택** — 바닥면적 합계 660㎡ **이하**, 층수 4개 층 **이하**

따라서 `2 / 02000 / 공동주택` pair는 부속용도 토큰 대신 다음 두 조건을 모두 만족할 때
`다세대주택`으로 인정한다.

```
grndFlrCnt  <= 4      (지상 층수)
totArea     <= 660    (연면적, ㎡)
```

두 값 중 하나라도 없거나 숫자로 파싱되지 않으면 `REVIEW_REQUIRED`다. 값을 0으로 보정하거나
다른 필드로 대체하지 않는다.

### 6.3 이 기준이 안전한 이유

두 대용값은 **모두 보수적인 방향**이다. 잘못 거부할 수는 있어도 잘못 승인할 수는 없다.

- `totArea`(연면적)는 지하·비주거를 포함하므로 **주택 바닥면적 합계 이상**이다.
  따라서 `totArea <= 660` 이면 주택 부분도 반드시 660 이하다 → 연립주택은 통과 불가.
- `grndFlrCnt`(지상 층수)는 **주택으로 쓰는 층수 이상**이다.
  따라서 `grndFlrCnt <= 4` 이면 주택 층수도 반드시 4 이하다 → 아파트는 통과 불가.

즉 아파트·연립을 "정책 승인 전"으로 제외한 §9.2 결정표 조항은 그대로 지켜진다.
791-2282는 4층 / 513.06㎡ 로 두 경계에서 충분히 안쪽이다.

### 6.4 분류 입력 확장

`scope.ts:301-310`이 classifier에 넘기는 필드에 두 개를 추가한다.

```
regstrGbCd, mainPurpsCd, mainPurpsCdNm, etcPurps   (현행)
+ grndFlrCnt, totArea                              (신규)
```

이 두 필드는 `02000` pair 판정에만 쓰고 다른 pair의 판정에는 관여하지 않는다.
`02003 다세대주택` pair는 규모 검사 없이 기존대로 통과한다 — 대장이 이미 다세대로
명시했기 때문이다.

### 6.5 남기는 제약

`requiredOtherPurposeSignal: 'MULTIPLEX_HOUSE'` 경로는 **삭제하지 않고 유지**한다. 부속용도에
`다세대주택` 토큰이 있는 건물은 규모 검사 없이 그대로 통과한다. 규모 기준은 토큰이 없을 때의
대체 근거로만 추가한다.

## 7. 영향 범위

### 코드

| 파일 | 변경 |
|---|---|
| `src/services/land-area-sync/scope.ts` | 분류 입력 조립을 선택 root 기준으로 partition + `grndFlrCnt`·`totArea` 추가(:301-310), component 조립의 단일성 가드 3곳(:516, :534, :691-694) |
| `src/services/land-area-sync/classifier.ts` | `02000` pair 의 규모 기준 판정(§6.2) |
| `src/services/land-area-sync/housing-purpose-allowlist.fixture.ts` | `02000` pair 에 규모 기준 대체 경로 추가. `requiredOtherPurposeSignal` 경로는 유지(§6.5) |
| `src/services/land-area-sync/service.ts` | `selectSingleLdaregRootIdentity`(:242-262)를 LDAREG 근거 기반 선택으로 교체 |
| `src/services/land-area-sync/ldareg-branch.ts` | `LdaregBranchInput.rootIdentity`(:84)와 singleRoot 게이트 2곳(:792-796, :943-949) |
| `src/services/land-area-sync/matcher.ts` | `MatchInput.scopeRootIdentity`(:336) |
| `src/services/land-area-sync/expos-root.ts` | closure accepted root를 전체 root 집합으로 (자료구조는 이미 Set, 상한 없음) |

`buildBasisRootIndex`는 이미 복수 root 입력을 받도록 만들어져 있고 phase0 캡처가 그 경로로
실행된다(`src/verification/land-area-phase0-capture.ts:2295-2301`). 신규 개념이 아니라 런타임
경로에 같은 형태를 적용하는 것이다.

구현 중 확정한 사항 두 가지:

- **선출 시점.** 선출에는 LDAREG·EXPOS·BASIS 응답이 필요하고 그 조회는 원래 LDAREG 분기에서
  일어난다. 따라서 표제부 root가 여럿일 때만 공통 gate **앞에** base PNU 한정 선출 pre-pass를
  넣고, 그 결과 scan을 LDAREG 분기에서 재사용한다. 같은 endpoint를 두 번 조회하지 않는다.
- **선출 실패는 FAILED가 아니다.** 선출용 scan 실패·불완전·근거 불확정은 모두 기존 복수 root
  `REVIEW_REQUIRED` 경로로 닫는다. 새 `FAILED` terminal을 만들면 278-anchor 게이트의 기대값이
  움직인다.

### 매니페스트·게이트

**변경 없다.** anchors 278, allowedScopePnus 301, expected 429/299, scopeDigest,
manifestDigest, 정책 상수, 두 워크플로, 공개 artifact 하드핀, DB marker가 전부 불변이다.
기대값은 그대로 두고 실측값만 올라간다.

791-2282만 해결되면 `scannedPnuCount` 297→298, `capturedEvidencePropertyUnitCount`
406→416이다. 301/429 전건 PASS에는 745-62와 791-2155도 함께 풀려야 한다.

### 테스트

`land-area-sync-classifier.test.ts`(단일 root 전제 fixture), `land-area-sync-scope.test.ts`,
`land-area-sync-ldareg-branch.test.ts`, `land-area-sync-matcher.test.ts`, 그리고 §19.2의
"복수 root → REVIEW" 계약 테스트. 마지막 것은 **삭제가 아니라 조건을 좁히는** 방향으로
고쳐야 한다 — LDAREG 근거 root가 0개·2개 이상인 경우는 계속 REVIEW여야 한다.

## 8. 승인 이력

- 2026-07-30 — 4절 개정 방향 승인.
- 2026-07-30 — 6절 `02000 공동주택` 분류를 **법정 규모 기준**으로 확정. 부속용도 원문이
  `공동주택`이어서 토큰 추가 방식이 성립하지 않음을 인스펙터 실측으로 확인한 뒤 내린 결정.

## 9. 남은 선행 과제

이 개정으로 791-2282는 해소되지만 278 전건 PASS에는 두 건이 더 남는다.

- **745-62** — Phase 0-S 합성 fixture가 실제 조합 PNU를 선점(clone-gate BLOCKER B3).
  fixture 재실행·cleanup은 CASCADE → SET NULL로 미아7 링크를 끊으므로 금지.
- **791-2155** — 상가+주택 혼합(제1종근린생활시설). LDAREG 반층 표기 `4.5`/`401`도 별도로
  남아 있다. 비주거 포함 여부는 미결정.

DB marker digest 블로커(279 → 278)는 2026-07-30 web 마이그레이션
`20260730140000_fix_mia7_full_refresh_marker_278_digest.sql`로 해소됐다.
