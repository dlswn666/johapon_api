# Task 5 Report: component 단일성 가드 3곳을 선택 root 기준으로

## What I implemented

In `src/services/land-area-sync/scope.ts`:

1. Added two module-private helpers right after `partitionTitleRowsByLandRightRoot` (around line 310):
   - `selectedTitleSelfPks(titleRows, landRightRootIdentity)` — computes the self-PK set used for
     the singleness judgment. If a `landRightRootIdentity` is given, only rows whose normalized
     self PK equals it are counted; otherwise every row counts (reproducing prior behavior).
     Returns `null` (fail-closed) the moment any row's `mgmBldrgstPk` fails
     `normalizeRegistryManagementPk`.
   - `allBylotCountsZero(bylot, expectedPks)` — true only when the bylot evidence set exactly
     equals (dedup) `expectedPks` and every evidence row's count is 0. Used so the singleton path
     still requires *every* root (selected and excluded) to have zero 부속지번, not just the
     selected one.

2. `resolveStrictSameRunOfficialAttachedComponent` (the 부속지번-bearing strict attached
   component path): replaced the `titleSelfPks.length !== 1` computation with
   `selectedTitleSelfPks(baseScans[0].title.rows, input.landRightRootIdentity)`. Root-ness is now
   verified only within the selected partition (`selectedTitleRows` filtered by `managementPk`),
   and I added the brief's new condition `titleRootPks[0] !== managementPk` alongside the existing
   `titleRootPks.length !== 1`. The final gate was widened from `expectedPks.length === 1 &&
   expectedPks[0] === managementPk` to `expectedPks.includes(managementPk)`, plus a new check that
   no bylot evidence row *outside* the selected `managementPk` has a nonzero count.

3. `resolveSameRunOfficialDevelopmentFullRefreshComponent` (the singleton tail, 부속지번-zero
   path): replaced its `titleSelfPks` computation the same way, and replaced the previous
   `expectedPks.length !== 1 / evidence.length !== 1` chain with `expectedPks.includes(titleSelfPks[0])`
   plus `allBylotCountsZero(singletonGate.bylot, singletonGate.expectedPks)` — i.e. every root's
   bylotCnt (not just the selected root's) must be 0.

`BylotResolution` was already imported (`scope.ts:31`), so no import change was needed.

`resolveSameRunOfficialDevelopmentParcelSingleton` (the fourth singleness site, now at
`scope.ts:865`) was read and left completely untouched — confirmed it already computes
`titleSelfPks` via exact-set-equality against `expectedPks` (not `length !== 1`), so it already
tolerates multiple roots. Verified via `git diff` that this function does not appear in the diff.

In `tests/land-area-sync-scope.test.ts`: appended the brief's six tests verbatim after the last
existing test (`단일 root anchor에 선택 root를 주면 partition 없이 기존 경로를 유지한다`,
previously ending at line 1212), reusing the existing `GENERAL_ROOT`, `AGGREGATE_ROOT`,
`MIA_ANCHOR`, `multiRootBaseScans()`, `multiRootDbScope()`, `parseDbScopeResolution` fixtures from
Task 2 without redefining them.

## What I tested and the results

### TDD Evidence

**RED** — command:
```
cd /Users/inju/workspace/tonghari/tonghari-api && node --import tsx --test tests/land-area-sync-scope.test.ts
```
Before implementing Steps 3-5 (tests added, guards unchanged), result: `# tests 44 / # pass 42 / # fail 2`.
The two failures were exactly the two brief-predicted ones:
- `DEV 전체 갱신 singleton component는 선택 root가 있으면 복수 표제부 root를 허용한다` →
  `AssertionError [ERR_ASSERTION]: Expected "actual" to be strictly unequal to: null` (component
  came back `null`)
- `선택 root의 표제부 행이 여러 개라도 같은 self PK면 dedup 후 승격한다` → same
  `notEqual(component, null)` failure

This is exactly the expected failure per the brief: the pre-existing `titleSelfPks.length !== 1`
guard rejects the two-root fixture even when `landRightRootIdentity` is supplied, because the old
code never looked at `landRightRootIdentity` at all.

**GREEN** — same command after implementing Steps 3-5:
```
# tests 44
# suites 0
# pass 44
# fail 0
# cancelled 0
# skipped 0
# todo 0
```
All 44 tests in the file pass, output pristine (no stray warnings/logs).

### Pre-existing test confirmation

Explicit confirmation: `DEV classification-independent component scope는 root
conflict·duplicate·count mismatch·provider incomplete를 승격하지 않는다` (test #9 in the run,
unmodified in the diff) passes:
```
# Subtest: DEV classification-independent component scope는 root conflict·duplicate·count mismatch·provider incomplete를 승격하지 않는다
ok 9 - DEV classification-independent component scope는 root conflict·duplicate·count mismatch·provider incomplete를 승격하지 않는다
```

`resolveSameRunOfficialDevelopmentParcelSingleton` (fourth singleness site) was confirmed
unchanged — it does not appear anywhere in `git diff -- src/services/land-area-sync/scope.ts`.

### Full verification

```
cd /Users/inju/workspace/tonghari/tonghari-api && npx tsc --noEmit && npm test
```
- `npx tsc --noEmit`: no output, exit clean.
- `npm test`: `# tests 903 / # pass 903 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0`.
  (The `[ERROR][SUPABASE] sync_jobs update failed...` lines seen in the output are intentional
  error-path test fixtures unrelated to this change, pre-existing in other test files.)

## Files changed

- `/Users/inju/workspace/tonghari/tonghari-api/src/services/land-area-sync/scope.ts`
- `/Users/inju/workspace/tonghari/tonghari-api/tests/land-area-sync-scope.test.ts`

## Self-review findings

- **Completeness**: both helpers added next to `partitionTitleRowsByLandRightRoot`; both guard
  sites (strict attached component, DEV full-refresh singleton) updated exactly as specified; all
  six brief tests added verbatim and passing.
- **Quality**: helper names (`selectedTitleSelfPks`, `allBylotCountsZero`) describe exactly what
  they compute; Korean docblocks state the DESIGN §9.1 amendment and the danger (fail-closed on
  invalid PK) consistent with file's existing density/tone.
- **Discipline**: no restructuring beyond the brief's surgical edits; the fourth singleness site
  (`resolveSameRunOfficialDevelopmentParcelSingleton`) was read and left untouched; no compensating
  check was dropped — the attached path still requires `titleRootPks.length === 1 &&
  titleRootPks[0] === managementPk` (proves true root) plus the new "no nonzero bylot outside
  selected PK" check; the singleton path still requires all of `expectedPks`' bylot evidence to be
  present and zero, not just the selected root's.
- **Testing**: TDD followed (tests written first, RED confirmed with the exact two expected
  failures, then GREEN after implementation). Test output is pristine — no stray warnings in the
  scope test file's own output. The pre-existing "DEV classification-independent..." test passes
  unmodified, confirming no-selected-root behavior is unchanged (bit-for-bit reproduction of old
  guard semantics when `landRightRootIdentity` is absent).

## Issues or concerns

None. All six brief tests, the pre-existing regression test, the full 903-test suite, and
`tsc --noEmit` all pass cleanly.

## Commit

```
git add src/services/land-area-sync/scope.ts tests/land-area-sync-scope.test.ts
git commit -m "fix(land-area): component 단일성 가드를 선택 root 기준으로 좁힌다"
```

## 리뷰 지적 수정

원 Task 5 구현(`c7ca65b`)의 production 코드는 리뷰에서 정확하다고 승인됐고, 아래 두 지적은 모두
**테스트의 커버리지·정직성 갭**이었다. Production 로직은 변경하지 않았다 — `scope.ts`에서 실제로
바뀐 것은 `allBylotCountsZero` 위에 추가한 docblock 코멘트 한 덩어리뿐이다(조건문·리턴값·헬퍼
로직 무변경, `git diff`로 확인).

### Important 1 — `allBylotCountsZero` unreachability 주장 검증

**검증 방법**: 분석적 추적 + 경험적 프로브 두 가지로 확인했다.

1. **분석적 추적**: `resolveSameRunOfficialDevelopmentFullRefreshComponent`의 singleton tail은
   `input.baseScans[0].attached.state !== 'COMPLETE_ZERO'`면 그 자리에서 null을 반환하므로, 이
   함수 안에서 `allBylotCountsZero`가 호출되는 시점엔 attached row가 항상 0건이다(distinct
   attached count `d`가 모든 PK에 대해 0으로 고정). 이 상태에서 `resolveParcelScopeCompleteness`의
   review 수집 루프는 `ev.count > 0 && ev.count !== d`(= `d`가 0이므로 `count !== 0`이면 항상 참)일
   때 `BYLOT_ATTACHED_COUNT_MISMATCH`를 무조건 push한다. 그 결과 `classifiedSingleton`(요구:
   `issues.length === 0`)과 `classificationConflictSingleton`(요구: issues가 정확히
   `{BUILDING_CLASSIFICATION_CONFLICT}` 또는 `{BUILDING_CLASSIFICATION_CONFLICT,SCOPE_NOT_LINKED}`)
   둘 다 어떤 evidence.count든 0이 아니면 성립할 수 없다 — 즉 `allBylotCountsZero` 호출부에
   도달하는 유일한 경로는 이미 모든 evidence.count가 0으로 강제된 뒤다. PK 집합(evidencePks vs
   expected) 불일치 분기도 `resolveBylotCounts`가 `expectedPks`를 순회하며 evidence를 1:1로
   생성하므로 발생할 수 없다.
2. **경험적 프로브**: `allBylotCountsZero` 본문을 임시로 `return true;`로 무력화한 뒤
   `tests/land-area-sync-scope.test.ts` 전체(44건, 수정 전 버전)를 재실행 — 44건 전부 그대로
   PASS(문제의 테스트 포함). 즉시 `git diff`로 변경 없음을 확인 후 원복.

**결론**: 리뷰어의 unreachability 주장은 **CONFIRMED**다. `allBylotCountsZero`의 reject 분기는
`resolveSameRunOfficialDevelopmentFullRefreshComponent`(현재 이 함수의 유일한 호출부)를 통해서는
현재 도달 불가능하다.

**적용한 조치** (브리핑의 "unreachable 확정 시" 분기를 따름):
- `tests/land-area-sync-scope.test.ts`의 문제 테스트 이름을
  `'DEV 전체 갱신 singleton component는 제외 root의 bylotCnt가 0이 아니면 승격하지 않는다'` →
  `'DEV 전체 갱신 singleton component는 제외 root의 bylotCnt가 0이 아니면 공통 gate가 승격 검토
  전에 걸러낸다'`로 변경하고, 어떤 메커니즘(공통 gate의 `BYLOT_ATTACHED_COUNT_MISMATCH`)이 실제로
  막는지, 왜 `allBylotCountsZero`를 검증하는 게 아닌지 한국어 주석으로 남겼다.
- `allBylotCountsZero` 함수 docblock에 defense-in-depth 성격과 현재 도달 불가능한 이유, "죽은
  코드로 보고 지우지 말 것"이라는 경고를 추가했다(`selectedTitleSelfPks`/`allBylotCountsZero`를
  export해서 직접 단위 테스트하지 않았다 — 모듈 전용 헬퍼를 테스트만을 위해 노출하는 것은 지시사항에
  따라 하지 않았다).
- `allBylotCountsZero`를 export하거나 삭제하지 않았다.

### Important 2 — `resolveStrictSameRunOfficialAttachedComponent` 무테스트 보강

`resolveStrictSameRunOfficialAttachedComponent`는 export되지 않으므로, `resolveSameRunOfficialReadOnlyComponent`
(`allowDevelopmentFullRefreshClassification=false`로 그 함수를 그대로 호출하는 유일한 공개 진입점)를
통해 테스트를 추가했다. 기존 `multiRootBaseScans()`/`multiRootDbScope()`/`GENERAL_ROOT`/`AGGREGATE_ROOT`/
`MIA_ANCHOR`/`completeScan`을 재사용했고, 파일 상단에 이미 있던 로컬 `attachedRow(basePnu, attachedPnu, pk)`
헬퍼(19자리 PNU pair → `BrAtchJibunRow`)를 그대로 썼다 — `tests/land-area-sync-mock-provider.ts`의
동명 헬퍼는 raw provider JSON(`Record<string, unknown>`) shape이라 이 파일의 타입 지정 fixture
패턴과 맞지 않아 쓰지 않았다.

추가한 3건 (모두 `attached.state === 'COMPLETE'`, 부속지번 1건 실존 — singleton 경로의
`COMPLETE_ZERO`와 다른 축):

1. **승격(admission)**: 선택 root(AGGREGATE_ROOT)에 부속지번 1건이 걸리고 그 bylotCnt(1)가
   일치하며, 제외 root(GENERAL_ROOT)는 fixture 기본값 그대로 bylotCnt 0·부속지번 없음 →
   `component.managementPk === AGGREGATE_ROOT`, `memberPnus === [MIA_ANCHOR, MIA_ATTACHED_PNU]`,
   `pairCount === 1`로 승격. 사전에 손으로 추적해 `normalGate.issues`가 정확히
   `['SCOPE_CACHE_SCAN_CONFLICT']` 하나만 되도록(= BYLOT_ATTACHED_COUNT_MISMATCH 없음, classification
   CLASSIFIED/LDAREG, bylot RESOLVED) fixture를 맞춘 뒤 실행해 확인했다. 구 가드(`titleSelfPks.length
   !== 1`, partition 없이 전체 root 대상)였다면 이 fixture는 self PK 2개라서 무조건 null이었을
   것 — 실제로 새 partition-aware 코드 경로(§9.1 개정)를 검증한다.
2. **거부: 부속지번이 선택 root가 아닌 root에 걸림**: attached row의 `mgmBldrgstPk`를 GENERAL_ROOT로
   두고(bylotCnt도 1로 맞춰 BYLOT_ATTACHED_COUNT_MISMATCH를 피함) → null. 추적 결과 이 케이스는
   Task 5 이전부터 있던 기존 체크 `attached.pairs.some(pair => normalizeRegistryManagementPk(pair.mgmBldrgstPk)
   !== managementPk)`에서 걸린다(§9.1이 새로 추가한 줄이 아님). 그래도 이 진입점 자체가 이전엔
   테스트가 0건이었으므로, partition-aware `titleSelfPks`/`titleRootPks` 계산을 통과한 뒤 이 체크에
   도달한다는 것 자체가 유효한 회귀 커버리지다.
3. **거부: 제외 root의 bylotCnt가 0이 아님**: GENERAL_ROOT(제외 root) bylotCnt=1이지만 부속지번은
   0건 → null. **정직성 노트**: Important 1과 똑같은 구조적 이유로, 이 fixture도 §9.1이 새로 추가한
   `normalGate.bylot.evidence.some(row => row.mgmBldrgstPk !== managementPk && row.count !== 0)`
   줄이 아니라, 공통 gate의 `BYLOT_ATTACHED_COUNT_MISMATCH`(GENERAL_ROOT의 distinct attached
   count `d=0` vs evidence.count=1 불일치)가 먼저 걸려 `normalGate` 사전 체크(`issues.length !==
   expectedIssues.length`)에서 null을 반환한다 — `resolveStrictSameRunOfficialAttachedComponent`
   본문의 partition-aware 코드까지 도달하지도 못한다. 분석적으로 확인한 바, 이 진입점에서는
   "제외 root에 부속지번이 실제로 있으면" 위 2번 테스트의 기존 `attached.pairs.some(...)` 체크가,
   "제외 root에 부속지번이 없으면" 공통 gate의 `BYLOT_ATTACHED_COUNT_MISMATCH`가 항상 먼저
   걸리므로, §9.1 신규 체크 줄이 유일한 판단 근거가 되는 입력을 `resolveSameRunOfficialReadOnlyComponent`
   경유로는 구성할 수 없었다(Important 1의 `allBylotCountsZero`와 동일한 구조). 테스트 이름은
   "승격하지 않는다"로 두되(관찰 가능한 동작은 맞다), 본문에 이 사실과 근거를 한국어 주석으로
   남겼다 — Important 1의 리뷰 지적처럼 브리핑이 명시적으로 이 지점의 unreachability 검증까지
   요구하진 않았지만, 같은 정직성 기준을 스스로 적용했다.

이 세 번째 테스트로 인해, §9.1이 `resolveStrictSameRunOfficialAttachedComponent`에 추가한 신규
compensating 체크(`bylot.evidence.some(...)`)는 현재 두 호출 진입점
(`resolveSameRunOfficialReadOnlyComponent` 직접 호출, `resolveSameRunOfficialDevelopmentFullRefreshComponent`의
`allowDevelopmentFullRefreshClassification=true` 호출 모두 동일한 `normalGate`/`attached.pairs.some`
선행 체크 구조를 공유) 모두에서 defense-in-depth로 보인다. **Production 코드는 브리핑 지시대로
변경하지 않았다** — 로직 변경이 필요하다고 판단되면 멈추고 보고하라는 지시에 따라, 여기서는 코드를
고치지 않고 이 사실만 정직하게 기록한다.

### 실행한 검증 명령과 결과

```
$ node --import tsx --test tests/land-area-sync-scope.test.ts
...
# tests 47
# suites 0
# pass 47
# fail 0
# cancelled 0
# skipped 0
# todo 0
```
(기존 44건 + 이번에 추가한 3건 = 47건, 전부 PASS. Important 1에서 이름을 바꾼 테스트 1건 포함.)

```
$ npx tsc --noEmit
$ echo $?
0
```
(출력 없음, exit 0.)

```
$ npm test
...
# tests 906
# suites 0
# pass 906
# fail 0
# cancelled 0
# skipped 0
# todo 0
```
(기존 903건 + 3건 = 906건, 전부 PASS.)

사전 지정된 회귀 테스트 `DEV classification-independent component scope는 root
conflict·duplicate·count mismatch·provider incomplete를 승격하지 않는다`도 수정 없이 그대로
PASS(`ok 9`)했다.

### 하지 못한 것 / 제약

- `allBylotCountsZero`의 reject 분기를 실제로 실행하는 입력을 찾지 못했다(Important 1 지침의
  "best outcome"). 위 분석·경험적 검증으로 이것이 진짜 불가능함을 확인했으므로, 대신 지침의
  두 번째 옵션(테스트 이름 변경 + docblock 경고)을 택했다.
- `resolveStrictSameRunOfficialAttachedComponent`의 §9.1 신규 체크(`bylot.evidence.some(...)`)를
  단독으로 검증하는 입력도 찾지 못했다 — Important 2는 이를 명시적으로 요구하지 않았지만, 정직성을
  위해 위에 기록했다. 이 관찰이 맞다면(재검증 환영) 장기적으로는 별도 후속 이슈로 "§9.1의 두 신규
  compensating 체크가 알려진 호출 경로 모두에서 defense-in-depth"라는 사실을 설계 문서에 반영할
  가치가 있어 보이나, 이번 작업 범위(테스트 커버리지·정직성 갭 수정)를 벗어나므로 코드/설계 문서는
  건드리지 않았다.
- Production 코드 변경은 `allBylotCountsZero` 위 docblock 코멘트 추가 1건뿐이다. 조건문·리턴값·
  헬퍼 로직은 전혀 바꾸지 않았다(`git diff -- src/services/land-area-sync/scope.ts`로 확인 가능).

### 커밋

```
git add src/services/land-area-sync/scope.ts tests/land-area-sync-scope.test.ts .superpowers/sdd/task-5-report.md
git commit -m "test(land-area): strict attached component 경로 커버리지 + singleton 테스트 정직성 보강"
```

## 재리뷰 지적 수정

재리뷰어가 위 "Important 2" 절의 처리를 **"절반만 적용됐다"**고 지적했다: `allBylotCountsZero`에는
unreachability 주석을 달았지만, 구조적으로 동일한 `selectedTitleSelfPks`의 fail-closed 분기(`self
=== null` → `return null`)는 docblock에 "호출측이 승격을 포기하게 한다"고만 적혀 있어 마치 그 분기가
살아있는 것처럼 읽힌다는 지적이었다. 이번 라운드는 **코멘트만** 수정했다 — `git diff`로 조건문·
리턴값·헬퍼 로직 무변경 확인.

### `selectedTitleSelfPks` unreachability 검증 — 결론: CONFIRMED

**주장**: 두 호출부(`resolveStrictSameRunOfficialAttachedComponent`의 `normalGate`,
`resolveSameRunOfficialDevelopmentFullRefreshComponent` singleton tail의 `singletonGate`) 모두
`selectedTitleSelfPks`를 부르기 전에 동일한 title 행 집합으로 `resolveParcelScopeCompleteness`를
이미 호출해 놓은 뒤이므로, invalid PK는 그 gate의 `hasInvalidRequiredPk(titleRows)`에 먼저 걸려
FAILED가 되고, 두 호출부의 `state !== 'REVIEW_REQUIRED'` / `classifiedSingleton` ·
`classificationConflictSingleton` 게이팅이 FAILED를 통과시키지 않으므로 `selectedTitleSelfPks`의
`self === null` 분기에는 결정자로 도달하지 못한다는 것.

**검증 방법**: 코드 추적 + 실제 실행 트레이스 두 가지.

1. **정규화 함수 동일성**: `hasInvalidRequiredPk`(scope.ts:252-254)와 `selectedTitleSelfPks`
   내부 루프(scope.ts:322-326, 코멘트 반영 전 라인 기준) 모두 `normalizeRegistryManagementPk(row.mgmBldrgstPk)`를
   그대로 쓴다 — 같은 정규화, 같은 필드. `normalizeRegistryManagementPk('')`는 정규식 `/^\d+$/`에
   빈 문자열이 매치하지 않아 `null`을 반환한다(registry-pk.ts:17-19) — 즉 두 함수는 정확히 같은
   입력 집합에서 "invalid"를 판정한다.
2. **`hasInvalidRequiredPk` → FAILED**: `resolveParcelScopeCompleteness`는 `titleRows`(baseScans
   전체에서 수집, partition 이전)에 대해 `hasInvalidRequiredPk`를 호출해(scope.ts:403) 걸리면
   `scanFailure ??= 'PROVIDER_PROTOCOL_ERROR'`를 세우고(scope.ts:409) 이 값이 있으면 classification/
   review 수집보다 **먼저** `finalize('FAILED', [scanFailure])`로 반환한다(scope.ts:460-462, "1.
   최우선" 주석). 이 검사는 root partition과 무관하게 전체 titleRows를 본다(422번 줄의 partition
   계산보다 앞선 402번 줄) — 즉 invalid PK가 선택 root/제외 root 어느 쪽에 있든 동일하게 FAILED가
   된다.
3. **attached 경로 게이팅**: `resolveStrictSameRunOfficialAttachedComponent`는 `normalGate =
   resolveParcelScopeCompleteness(input)`(scope.ts:595 부근, 코멘트 추가 전 기준)를 부른 뒤,
   `normalGate.state !== 'REVIEW_REQUIRED'`면 즉시 `null`을 반환한다(현재 라인 번호대로는 607
   부근) — `selectedTitleSelfPks` 호출(현재 654행 부근)보다 앞선 코드다. `FAILED !== 'REVIEW_REQUIRED'`이므로
   이 분기에서 이미 걸러진다.
4. **singleton 경로 게이팅**: `resolveSameRunOfficialDevelopmentFullRefreshComponent`는
   `singletonGate = resolveParcelScopeCompleteness({...input, dbScope: officialOnlyDbScope})`를
   부른 뒤 `classifiedSingleton`(요구: `state === 'SINGLE_SCOPE_CONFIRMATION_REQUIRED'`)과
   `classificationConflictSingleton`(요구: `state === 'REVIEW_REQUIRED'`)을 계산하고, 둘 다
   거짓이면 `selectedTitleSelfPks` 호출(현재 843행 부근) 전에 `null`을 반환한다. `state === 'FAILED'`는
   두 예측 모두를 거짓으로 만든다.
5. **실행 트레이스로 재확인**: 기존 테스트 `표제부에 invalid 관리 PK가 있으면 선택 root와 무관하게
   승격하지 않는다`(tests/land-area-sync-scope.test.ts:1319, `multiRootBaseScans()`의 기본
   `attached: zeroScan()` → `attached.state === 'COMPLETE_ZERO'`를 그대로 씀)의 흐름을 손으로
   추적: attached.state가 `'COMPLETE'`가 아니므로 `resolveSameRunOfficialReadOnlyComponent`와
   attached-full-refresh fallback(`resolveStrictSameRunOfficialAttachedComponent(..., true)`)은
   `baseScans[0].attached.state !== 'COMPLETE'` 조건(scope.ts:590 부근)에서 `selectedTitleSelfPks`에
   도달하지도 못하고 먼저 `null`이 되고, 이어서 singleton fallback으로 넘어가
   `singletonGate = resolveParcelScopeCompleteness(...)`가 invalid PK로 FAILED를 반환 →
   `classifiedSingleton`/`classificationConflictSingleton` 둘 다 거짓 → `selectedTitleSelfPks`
   호출 전에 `null`. 즉 이 테스트가 실제로 통과하는 이유는 공통 gate의 FAILED이지
   `selectedTitleSelfPks`의 `self === null` 분기가 아니다 — Important 1에서 `allBylotCountsZero`에
   대해 확인한 것과 정확히 같은 구조.

**결론**: 재리뷰의 unreachability 주장은 **CONFIRMED**다. 로직 변경은 필요 없고, 지시대로 코멘트만
수정했다.

### 적용한 수정 (코멘트만, `git diff`로 조건문/리턴값 무변경 확인)

1. `src/services/land-area-sync/scope.ts` — `selectedTitleSelfPks` docblock(옛 310-313행)에
   `allBylotCountsZero`와 같은 톤의 defense-in-depth 단락을 추가: 두 호출부가 이미 같은 title 행으로
   `resolveParcelScopeCompleteness`를 먼저 돌린다는 것, `hasInvalidRequiredPk`가 동일한 정규화
   함수·필드를 쓴다는 것, attached 경로는 `normalGate.state !== 'REVIEW_REQUIRED'`에서, singleton
   경로는 `classifiedSingleton`/`classificationConflictSingleton` 두 판정에서 각각 걸러진다는 것,
   "죽은 코드로 보고 지우지 말 것" 경고를 명시.
2. `tests/land-area-sync-scope.test.ts:1319` 테스트에 동일한 스타일의 정직성 주석 추가 — 이
   fixture가 singleton tail로 빠지는 이유, `hasInvalidRequiredPk` → FAILED → 두 판정 모두 거짓 →
   `selectedTitleSelfPks` 호출 전에 null이 된다는 실제 메커니즘을 명시.
3. (Minor) `src/services/land-area-sync/scope.ts:642-644` 부근 block comment를 완화 — "아래
   attached pair 검사와 bylot 검사에서 막힌다"는 문구가 bylot `some(...)` 체크도 살아있는 것처럼
   읽혔던 것을, 실제로 막는 두 메커니즘(기존 `attached.pairs.some(...)` cross-root pair 검사, 공통
   gate의 `BYLOT_ATTACHED_COUNT_MISMATCH`)을 명시하고 bylot `some(...)`은 그 둘이 못 잡는 경우를
   위한 defense-in-depth라고 정정.
4. (Minor) 같은 파일의 `normalGate.bylot.evidence.some(row => row.mgmBldrgstPk !== managementPk
   && row.count !== 0)` 절(§9.1 신규 compensating check) 바로 위에 동일 취지의 인라인 코멘트 추가 —
   이전 라운드의 report(Important 2, "제외 root의 bylotCnt가 0이 아님" 테스트 분석)에서만 남아있던
   unreachability 사실을 production 코드에도 반영.
5. (Minor) `tests/land-area-sync-scope.test.ts`의 `부속지번-bearing 경로: 부속지번이 선택 root가
   아닌 root에 걸리면 승격하지 않는다` 테스트(옛 1379행)에 한 문장 추가 — 이 케이스를 실제로
   결정하는 것은 Task 5 이전부터 있던 cross-root `attached.pairs.some(...)` 비교이며, `git show
   c7ca65b`로 확인한 바 이 줄은 c7ca65b diff에 나타나지 않는(= pre-existing) 반면 바로 아래 bylot
   `some(...)` 줄은 c7ca65b의 `+` 라인이라는 것.

### 실행한 검증 명령과 결과

```
$ node --import tsx --test tests/land-area-sync-scope.test.ts
...
# tests 47
# suites 0
# pass 47
# fail 0
# cancelled 0
# skipped 0
# todo 0
```
(코멘트 라운드 전과 동일한 47/47 — 테스트 개수·결과 무변경 확인.)

```
$ npx tsc --noEmit
$ echo $?
0
```
(출력 없음, exit 0.)

```
$ git diff -- src/services/land-area-sync/scope.ts tests/land-area-sync-scope.test.ts \
  | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | grep -vE '^\+\s*(//|/\*|\*)'
-    // 부속지번·bylot 축은 전체 root를 그대로 유지하므로, 제외된 root에 부속지번이 있으면
-    // 아래 attached pair 검사와 bylot 검사에서 막힌다.
-    // 조건만 남긴다.
```
(제거된 세 줄도 전부 코멘트 — 추가된 줄은 전부 `//`/`/*`/`*`로 시작. 코드 라인 변경 0건.)

### 하지 못한 것 / 제약

없음. 요청받은 Important 1건 + Minor 2건 모두 코멘트만으로 반영했고, 로직 변경이 필요하다고
판단되는 지점은 없었다.

### 커밋

```
git add src/services/land-area-sync/scope.ts tests/land-area-sync-scope.test.ts .superpowers/sdd/task-5-report.md
git commit -m "docs(land-area): selectedTitleSelfPks unreachability 코멘트 half-apply 격차 해소"
```
