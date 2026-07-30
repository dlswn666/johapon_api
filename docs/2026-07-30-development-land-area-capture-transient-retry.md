# DEV 대지권 capture transient 재시도 설계 (2026-07-30)

## 배경

미아7 278-anchor read-only capture는 278건 전부가 PASS해야 evidence를 만들고 write 승격이
열리는 all-or-nothing 게이트다. 이 게이트는 설계가 명시적으로 요구한 동작이며 유지한다
(`docs/2026-07-28-mia7-development-land-area-full-refresh.md:83` — "하나라도 충족하지 않으면
FAIL이며 다음 anchor admission을 중단한다. 일부 성공을 전체 완료로 보고하지 않는다").

문제는 정확성이 아니라 가용성이다. 실측 두 실행을 비교하면 드러난다.

| run | FAILED | REVIEW | CAPTURED |
|---|---|---|---|
| 30409798468 (2026-07-29) | 0 | 7 | 271 |
| 30418532695 (2026-07-29) | **40** | 6 | 232 |

두 번째 실행에서 무관한 anchor 40건이 `PROVIDER_PROTOCOL_ERROR` 24건,
`ATTACHED_SCAN_INCOMPLETE` 16건으로 떨어졌다. 두 코드는 `scope.ts:273-275` 와
`service.ts:1340-1344` 에서 **스캔 상태**로만 발생한다 — 즉 외부 공식 API(V-World,
건축물대장 HUB) 응답 실패다. 어댑터에는 이미 페이지 단위 재시도가 있으나
(`adapter.ts:543`, timeout/429/5xx + exponential backoff) 그것을 뚫고 나온 실패는
anchor 를 그대로 죽인다. anchor 하나가 죽으면 278 게이트가 깨져 전체 실행이 무효가 된다.

결과적으로 REVIEW 건을 모두 고쳐도 "18분 동안 외부 API가 한 번도 흔들리지 않아야 PASS"
라는 조건이 남는다. 이 문서는 그 조건을 완화하는 설계를 정의한다.

## 목표 / 비목표

**목표**
- 한 capture 실행 안에서 transient 실패 anchor 를 재시도해 실행 성공률을 올린다.
- 재시도 발생 여부와 회복 수를 사후에 확인할 수 있게 한다.

**비목표**
- 게이트 의미 변경. 최종 판정은 여전히 278/278 이다.
- 실행 간 재개. `promotionGate` 가 `SAME_RUN_OFFICIAL_*` 근거를 요구하므로 앞선 실행의
  evidence 를 이어받으면 "같은 실행" 계약이 깨진다.
- write runner 의 `break` 동작 변경 (`runner.ts:3459`). apply 경로는 이 설계 범위 밖이다.
- REVIEW 건(정확성 판정)의 재시도.

## 결정 사항

| # | 결정 | 근거 |
|---|---|---|
| D1 | 실행 내 재시도만 | same-run official 근거 계약과 매니페스트·digest·승인 절차를 건드리지 않는다 |
| D2 | 집계 분류가 `FAILED` 인 anchor만 재시도 | 기존 분류를 그대로 쓴다. REVIEW = 판정 도달, FAILED = 판정 미도달 |
| D3 | 고정 3라운드 + 고정 지연 | 감사 기록이 법적 증거로 쓰이는 파이프라인이라 재현성을 우선한다 |
| D4 | 오케스트레이터 라운드 루프 | 한 곳만 수정하고 guardian write 경로에도 자동 적용된다 |
| D5 | 공개 artifact `@4` 까지 노출 | audit/evidence 는 실행 후 삭제되므로 공개 artifact 외에는 사후 확인 수단이 없다 |
| D6 | 실패 비율 가드 포함 | 대량 실패는 API 장애이므로 재시도해도 무용하고 예산만 태운다 |

### D2 의 판정 기준

`DevelopmentEvidenceCaptureAuditEntry.status` 를 그대로 쓰면 안 된다. 이 필드는
`entry ? ... : 'FAILED'`(`development-land-area-evidence-capture.ts:819-823`)라서 REVIEW 로
끝난 anchor 에도 `'FAILED'` 가 들어간다. REVIEW/FAILED 구분은
`aggregateDevelopmentEvidenceCaptureEntries`(`:318-332`)가 `terminalOutcome` 과
`terminalScopeState` 로 수행한다.

재시도 대상은 그 분류에서 `FAILED` 로 떨어지는 entry 다. 즉 아래를 모두 만족하는 경우다.

```
status !== 'CAPTURED'
status !== 'VERIFIED_NO_DATA'
terminalOutcome !== 'NO_DATA'
terminalOutcome !== 'REVIEW_REQUIRED'
terminalScopeState !== 'REVIEW_REQUIRED'
```

이 술어를 `isDevelopmentEvidenceCaptureRetryable(entry)` 로 모듈에 두고
`aggregateDevelopmentEvidenceCaptureEntries` 와 같은 분기를 공유한다. 워크플로 YAML 의
`classifyFailure` 는 인라인 JS 라 import 할 수 없으므로 기존 중복을 유지한다(이미 테스트로
고정돼 있다).

`PROVIDER_PROTOCOL_ERROR` 를 재시도 판정 기준으로 쓰지 않는 이유는 이 코드가 두 의미로
쓰이기 때문이다 — 스캔 전송 실패(`service.ts:1342`)와, 스캔은 성공했으나 응답 행의
관리번호가 무효이거나 PNU 와 불일치한 결정적 위반(`service.ts:1384`). D2 의 status 기준은
후자도 재시도하지만 결정적이라 같은 결과로 수렴하며, 라운드 상한이 낭비를 묶는다.

## 아키텍처

`captureDevelopmentEvidence`(`src/operations/development-land-area-evidence-capture.ts:860`)
의 워커 풀을 라운드로 감싼다. 워커 풀은 "처리할 인덱스 목록"을 받도록만 파라미터화하고,
게이트·집계·비식별 변환 로직은 수정하지 않는다.

```
round 1  전체 executionAnchors 인덱스        (기존 동작)
   ↓     results[i].audit.status === 'FAILED' 인 i 수집
   ↓     CAPTURE_RETRY_DELAY_MS 지연
round 2  실패 인덱스만
   ↓     동일 판정
round 3  여전히 실패한 인덱스만
   ↓
results[] → 기존 gate / promotionGate / redacted 집계
```

`captureOne` 은 durable 쓰기가 없고 in-memory 합성 job(`createSyntheticJobRow`)으로만
동작하므로 같은 인덱스를 다시 호출해 `results[index]` 를 덮어쓰는 것으로 충분하다.
멱등성을 위해 추가 조치가 필요하지 않다.

### 상수

```ts
export const CAPTURE_MAX_ATTEMPTS = 3;            // 최초 시도 포함
export const CAPTURE_RETRY_DELAY_MS = 60_000;
export const RETRY_ELIGIBLE_MAX_RATIO = 0.25;
```

세 상수는 export 해 테스트로 고정한다.

### 비율 가드 판정 시점

가드는 **각 재시도 라운드 직전에** 그 라운드의 후보 수로 판정한다. 라운드 1 직후 한 번만
보는 것이 아니다.

```
candidates = FAILED 인덱스
if (candidates.length > floor(targetCount * RETRY_ELIGIBLE_MAX_RATIO)) {
    retry.skipped = 'TOO_MANY_FAILURES';
    break;                    // 이후 라운드 없음
}
```

`targetCount = 278` 이면 임계값은 `floor(69.5) = 69` 이므로 후보가 70건 이상일 때 생략한다.
한 번 생략하면 남은 라운드를 모두 포기한다 — 라운드마다 다시 판정해 되살리지 않는다.
`retry.skipped` 는 생략이 발생한 시점과 무관하게 `'TOO_MANY_FAILURES'` 하나로 기록한다.

## 시간 예산

guardian 은 capture 를 `capture_timeout_seconds=3600`
(`scripts/development-land-area-sync-remote-guardian.sh:42`) 으로 감싼다. 실측 1라운드는
18~28분이다. 비율 가드가 없으면 최악의 경우(278건 전부 실패) 3라운드가 84분 이상이 되어
초과한다. 어댑터 백오프 때문에 실패 anchor 는 성공 anchor 보다 느리므로 초과 폭은 더 크다.

비율 가드를 두면 재시도 대상이 최대 `278 * 0.25 = 69` 건으로 묶인다.

```
round 1        ≈ 28분
round 2, 3     ≈ 2 × (69/278 × 28분) ≈ 14분   ← 아래 경고 참조
지연           2 × 1분 = 2분
합계           ≈ 44분  <  60분 (3600초)
```

> ⚠️ **이 계산은 낙관적이다. 실측 전까지 확정으로 다루지 마라.**
>
> 위 선형 추정은 재시도 라운드에 평균 anchor 단가(28분 / 278 ≈ 6초)를 그대로
> 곱했다. 그런데 재시도 라운드의 모집단은 정의상 100% 실패 anchor 이고, 실패
> anchor 는 어댑터 백오프 때문에 성공 anchor 보다 느리다
> (`adapter.ts:41,45,51` — `STRICT_SCAN_MAX_ATTEMPTS=3` ×
> `REQUEST_TIMEOUT_MS=15_000` + backoff 500/1000ms 이므로 timeout 계열 실패는
> 페이지당 최대 46.5초, anchor 당 스캔은 6종). 같은 절 앞에서 이 감속을 명시해
> 놓고 가드 적용 후 계산에는 적용하지 않은 것이 이 문서의 오류였다.
>
> 손익분기는 재시도 라운드가 각각 15분을 넘는 지점이다. 선형 추정이 7분이므로
> **실패 anchor 가 평균 대비 2.1배만 느려도 3600초 여유가 사라진다.**
>
> 초과 시 손상은 없지만 관측성이 나빠진다. guardian 의
> `timeout --kill-after=30s` 가 CLI 를 죽이는데 CLI 는 audit.json 과
> evidence.json 을 마지막에 쓰므로, 진단 artifact 가 아예 남지 않는다. 현재의
> 실패 실행은 최소한 공개 artifact 를 남긴다.
>
> **따라서 write 경로는 실측 전까지 이 동작을 물려받지 않는다.** read-only
> capture 워크플로는 `timeout-minutes: 90` 이라 여유가 있으므로, 재시도가 실제로
> 발생한 read-only 실행에서 wall-clock 경과를 3600초와 대조해 실측치를 얻는다.
> 그 수치를 보기 전에는 write run(`development-land-area-sync-run.yml`)을
> dispatch 하지 않는다. 이 워크플로는 지금까지 한 번도 실행된 적이 없으므로
> 운영 규율만으로 지킬 수 있고 코드 변경이 필요하지 않다.
>
> 실측이 여유 부족을 보이면 선택지는 둘이다. (a) `RETRY_ELIGIBLE_MAX_RATIO` 를
> 0.15 로 낮춰 후보를 41건으로 묶는다(실측된 40건 장애는 그대로 커버된다).
> (b) 각 재시도 라운드 직전에 경과 시간 가드를 넣는다 — 새 `skipped` 열거값이
> 필요하므로 공개 artifact `@5` 로 올라간다.

guardian 전체 예산 단정(`tests/development-land-area-sync-workflow.test.ts:362`,
`3600 + 18000 + 720 + 300 + 600 < 420 * 60`)은 capture 상한을 올리지 않으므로 그대로
성립한다. 즉 이 설계는 guardian·workflow 타임아웃을 **바꾸지 않는다**.

초과 시 동작은 fail-closed 다. guardian 이 capture 를 timeout 으로 죽이고 write runner 는
기동하지 않는다. 데이터 손상 경로는 없다.

## 데이터 구조 변경

### private audit

```ts
interface DevelopmentEvidenceCaptureAuditEntry {
    // ...기존 필드
    attempts: number;                  // 1..CAPTURE_MAX_ATTEMPTS
}

interface DevelopmentEvidenceCaptureAudit {
    // ...기존 필드
    retry: {
        rounds: number;                // 실제 수행한 재시도 라운드 수 (0..2)
        retriedAnchorCount: number;    // 재시도를 1회 이상 받은 anchor 수
        recoveredAnchorCount: number;  // 재시도로 FAILED → 비-FAILED 가 된 anchor 수
        skipped: 'NONE' | 'TOO_MANY_FAILURES';
    };
}
```

`DEVELOPMENT_EVIDENCE_CAPTURE_AUDIT_VERSION`
(`src/operations/development-land-area-evidence-capture.ts:31`) 을 한 단계 올린다.

### 공개 artifact `@3` → `@4`

`.github/workflows/development-land-area-evidence-capture.yml:754` 의 version 문자열과
생성 블록에 다음을 추가한다.

```
retry: { rounds, retriedAnchorCount, recoveredAnchorCount, skipped }
redactedFailureDetails[].attempts
```

공개 artifact 에는 `targetOrdinal` 만 있고 PNU·물건지 ID·면적이 없다. 추가 필드도 정수와
열거형뿐이라 기존 비식별 정규식 가드
(`anchorPnu|propertyUnitId|allowedPrestates|proposedLandAreas|landArea`, 19자리 숫자 금지)를
그대로 통과한다. 밀봉 정책은 변경하지 않는다.

## 오류 처리

- 3라운드 후에도 FAILED 면 지금과 동일하게 gate FAIL, promotionGate BLOCKED.
- REVIEW·CAPTURED anchor 는 재시도 대상에서 제외한다.
- 활성 물건지 단정(`assertDevelopmentEvidenceCaptureActiveIdentity`)은 기존대로 라운드
  시작 전 1회만 수행한다. 실행 중 변동은 기존 `finalActivePropertyIdentityDigest` 비교와
  `CAPTURE_UNION_ACTIVE_PROPERTY_SET_CHANGED` 가 잡는다.
- `readOnlyGuards` 불변. 재시도도 in-memory 경로이므로 `durableSyncJobWrites` 와
  `propertyUnitWriteRpcCalls` 는 0 을 유지한다.
- 라운드 간 지연은 `captureDevelopmentLandAreaEvidence` 의 선택 의존성 `sleep` 으로 주입
  가능하게 둔다. 이 오케스트레이터 입력에는 AbortSignal 이 없으므로(현재 시그니처는
  `target` / `captureRunId` / `deps` / `concurrency?` / `onProgress?` 뿐) 취소 연동은 범위
  밖이다. 실행 취소는 기존대로 guardian 의 `timeout` 이 프로세스를 죽여 처리한다.

## 테스트 계획 (TDD)

`tests/development-land-area-evidence-capture.test.ts` 에 추가한다. mock provider
(`tests/land-area-sync-mock-provider.ts`) 로 라운드별 응답을 제어한다.

1. 1라운드에서 스캔 실패한 anchor 가 2라운드에서 CAPTURED 로 회복되고 `attempts === 2`,
   `retry.recoveredAnchorCount === 1` 이 된다.
2. 3라운드 모두 실패하면 status FAILED 를 유지하고 `attempts === 3`, gate FAIL 이다.
3. REVIEW anchor 는 재시도하지 않는다 — `attempts === 1` 이고 라운드 수가 늘지 않는다.
4. 실패 수가 `targetCount * RETRY_ELIGIBLE_MAX_RATIO` 를 넘으면 재시도를 생략하고
   `retry.skipped === 'TOO_MANY_FAILURES'`, `retry.rounds === 0` 이다.
5. 재시도가 없으면 `retry` 가 전부 0 / `'NONE'` 이고 기존 감사 필드는 불변이다.
6. 재시도 경로에서도 `readOnlyGuards.durableSyncJobWrites === 0` 이고
   `propertyUnitWriteRpcCalls === 0` 이다.
7. `tests/development-land-area-sync-workflow.test.ts` 가 공개 artifact `@4` 와 새 필드를
   고정한다.

기존 862건 통과 유지가 전제다. `npx tsc --noEmit` 클린도 전제다.

## 영향 파일

| 파일 | 변경 |
|---|---|
| `src/operations/development-land-area-evidence-capture.ts` | 라운드 루프, 상수 3개, audit 필드, 버전 상수 |
| `.github/workflows/development-land-area-evidence-capture.yml` | 공개 artifact `@4` 생성·검증 블록 |
| `tests/development-land-area-evidence-capture.test.ts` | 시나리오 1~6 |
| `tests/development-land-area-sync-workflow.test.ts` | `@4` 및 새 필드 고정 (245행 부근) |

`scripts/development-land-area-sync-remote-guardian.sh` 와
`.github/workflows/development-land-area-sync-run.yml` 은 변경하지 않는다. guardian 은 같은
capture CLI 를 호출하므로 재시도가 write 경로에도 자동 적용된다.

## 검증 방법

1. `npm test` 862+ 건 통과, `npx tsc --noEmit` 클린.
2. main 머지 후 docker-build 배포 완료 확인 (두 워크플로가 이미지 revision 을 main HEAD 와
   exact 대조한다).
3. read-only capture 재실행 후 공개 artifact 에서 확인:
   - `retry.rounds`, `retriedAnchorCount`, `recoveredAnchorCount` 가 채워지는지
   - `redactedAggregate.FAILED` 가 이전 실행(40)보다 줄었는지
   - `readOnlyGuards` 와 `productionWrites` 가 0 인지
4. DEV DB `property_units` 의 `land_area_synced_at` 최댓값이 2026-07-24 로 불변인지
   (쓰기 0건 확인).

## 남은 별건

이 설계는 가용성만 다룬다. 278 전건 PASS 에는 아래가 여전히 남아 있다.

- 791-2320 · 2343 — LDAREG 지하 층 원문 미확정 (정규화값 `B1` 의 역상 9가지)
- 791-2282 — 공식 표제부 2행(일반/단독주택 + 집합/공동주택) 분류 충돌
- 791-2155 — 미매칭 LDAREG 1행 + 주용도 제1종근린생활시설
- 745-62 — Phase 0-S 합성 fixture 가 실제 조합 PNU 를 선점 (clone-gate BLOCKER B3)
- 791-2197 — 물건지 building_unit 미연결
