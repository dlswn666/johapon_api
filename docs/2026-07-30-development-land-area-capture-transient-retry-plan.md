# DEV capture transient 재시도 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 미아7 278-anchor read-only capture 가 한 실행 안에서 transient 실패 anchor 를 최대 2회 재시도해, 외부 공식 API 흔들림 때문에 전체 실행이 무효화되는 것을 막는다.

**Architecture:** `captureDevelopmentLandAreaEvidence` 의 워커 풀을 라운드 루프로 감싼다. 워커 풀은 처리할 인덱스 배열만 받도록 파라미터화하고, 게이트·집계·비식별 변환은 수정하지 않는다. 재시도 대상은 기존 집계 분류가 `FAILED` 인 entry 로 한정하고, 각 재시도 라운드 직전에 실패 비율 가드를 적용한다.

**Tech Stack:** TypeScript (CommonJS), `node:test` + `node:assert/strict`, tsx, GitHub Actions (inline node in YAML)

설계 문서: `docs/2026-07-30-development-land-area-capture-transient-retry.md`

## Global Constraints

- 게이트 의미를 바꾸지 않는다. 최종 판정은 278/278 이며 `gate` / `promotionGate` 산출 코드는 수정 대상이 아니다.
- REVIEW 로 끝난 anchor 는 재시도하지 않는다.
- `readOnlyGuards.durableSyncJobWrites` 와 `propertyUnitWriteRpcCalls` 는 리터럴 `0` 을 유지한다.
- `scripts/development-land-area-sync-remote-guardian.sh` 와 `.github/workflows/development-land-area-sync-run.yml` 은 수정하지 않는다.
- guardian·workflow 타임아웃 값(`capture_timeout_seconds=3600`, `timeout-minutes: 90`)은 변경하지 않는다.
- 상수 값은 정확히 `CAPTURE_MAX_ATTEMPTS = 3`, `CAPTURE_RETRY_DELAY_MS = 60_000`, `RETRY_ELIGIBLE_MAX_RATIO = 0.25` 다.
- 공개 artifact 에 PNU·물건지 ID·면적을 추가하지 않는다. 정수와 열거형만 추가한다.
- 매 태스크 종료 시 `npm test` 전건 통과와 `npx tsc --noEmit` 클린이 전제다. 시작 시점 기준선은 862건이다.
- 작업 브랜치는 `feat/capture-transient-retry` 이며 이미 존재한다. 커밋 메시지는 한국어 본문 + `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` 로 끝낸다.

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/operations/development-land-area-evidence-capture.ts` | capture 오케스트레이션·감사 조립 | 상수 3개, 재시도 술어, 라운드 루프, audit 필드, 버전 상수 |
| `tests/development-land-area-evidence-capture.test.ts` | capture 단위 테스트 | 재시도 시나리오 6종 |
| `.github/workflows/development-land-area-evidence-capture.yml` | 공개 artifact 생성·검증 | `@4` 버전과 retry 집계 |
| `tests/development-land-area-sync-workflow.test.ts` | 워크플로 문자열 고정 | `@4` 및 새 필드 고정 |

새로 만드는 파일은 없다. `captureOne` 은 in-memory 합성 job 으로만 동작해 멱등하므로 재시도용 추가 격리가 필요 없다.

---

### Task 1: 상수·재시도 술어·감사 필드 기반 마련

재시도 로직 없이, 관측 필드와 판정 술어만 먼저 넣는다. 이 태스크가 끝나면 모든 anchor 의 `attempts` 가 1 이고 `retry` 집계가 기본값이다.

**Files:**
- Modify: `src/operations/development-land-area-evidence-capture.ts`
- Test: `tests/development-land-area-evidence-capture.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `CAPTURE_MAX_ATTEMPTS: 3`, `CAPTURE_RETRY_DELAY_MS: 60_000`, `RETRY_ELIGIBLE_MAX_RATIO: 0.25` (모두 export)
  - `isDevelopmentEvidenceCaptureRetryable(entry: DevelopmentEvidenceCaptureAuditEntry): boolean` (export)
  - `DevelopmentEvidenceCaptureAuditEntry.attempts: number`
  - `DevelopmentEvidenceCaptureAudit.retry: { rounds: number; retriedAnchorCount: number; recoveredAnchorCount: number; skipped: 'NONE' | 'TOO_MANY_FAILURES' }`

- [ ] **Step 1: 실패 테스트 작성**

`tests/development-land-area-evidence-capture.test.ts` 파일 끝에 추가한다.

```ts
test('재시도가 없는 실행은 attempts 1과 빈 retry 집계를 남긴다', () => {
    const entry: DevelopmentEvidenceCaptureAuditEntry = {
        anchorPnu: PNU,
        status: 'CAPTURED',
        strategy: 'LADFRL',
        scannedPnuCount: 1,
        propertyUnitCount: 1,
        snapshotReferenceSha256: '0'.repeat(64),
        applyRpcBlocked: true,
        failureCode: null,
        terminalScopeState: 'RESOLVED',
        terminalOutcome: 'APPLIED',
        terminalIssueCodes: [],
        terminalIssuesTotal: 0,
        terminalIssuesTruncated: false,
        scopeResolutionSource: 'DB_RESOLVER',
        attempts: 1,
    };
    assert.equal(isDevelopmentEvidenceCaptureRetryable(entry), false);
});

test('재시도 술어는 REVIEW·NO_DATA·CAPTURED를 제외하고 판정 미도달만 고른다', () => {
    const base: DevelopmentEvidenceCaptureAuditEntry = {
        anchorPnu: PNU,
        status: 'FAILED',
        strategy: null,
        scannedPnuCount: 0,
        propertyUnitCount: 0,
        snapshotReferenceSha256: null,
        applyRpcBlocked: false,
        failureCode: 'CAPTURE_DISCOVERY_FAILED',
        terminalScopeState: 'FAILED',
        terminalOutcome: 'FAILED',
        terminalIssueCodes: ['PROVIDER_PROTOCOL_ERROR'],
        terminalIssuesTotal: 1,
        terminalIssuesTruncated: false,
        scopeResolutionSource: 'DB_RESOLVER',
        attempts: 1,
    };

    assert.equal(isDevelopmentEvidenceCaptureRetryable(base), true);
    assert.equal(
        isDevelopmentEvidenceCaptureRetryable({
            ...base,
            status: 'CAPTURED',
        }),
        false
    );
    assert.equal(
        isDevelopmentEvidenceCaptureRetryable({
            ...base,
            status: 'VERIFIED_NO_DATA',
        }),
        false
    );
    assert.equal(
        isDevelopmentEvidenceCaptureRetryable({
            ...base,
            terminalOutcome: 'NO_DATA',
        }),
        false
    );
    assert.equal(
        isDevelopmentEvidenceCaptureRetryable({
            ...base,
            terminalOutcome: 'REVIEW_REQUIRED',
        }),
        false
    );
    assert.equal(
        isDevelopmentEvidenceCaptureRetryable({
            ...base,
            terminalScopeState: 'REVIEW_REQUIRED',
        }),
        false
    );
});

test('capture 재시도 상수는 설계값으로 고정된다', () => {
    assert.equal(CAPTURE_MAX_ATTEMPTS, 3);
    assert.equal(CAPTURE_RETRY_DELAY_MS, 60_000);
    assert.equal(RETRY_ELIGIBLE_MAX_RATIO, 0.25);
});
```

같은 파일 상단 import 블록(24~28행)에 다음을 추가한다.

```ts
import {
    CAPTURE_MAX_ATTEMPTS,
    CAPTURE_RETRY_DELAY_MS,
    RETRY_ELIGIBLE_MAX_RATIO,
    isDevelopmentEvidenceCaptureRetryable,
} from '../src/operations/development-land-area-evidence-capture';
import type { DevelopmentEvidenceCaptureAuditEntry } from '../src/operations/development-land-area-evidence-capture';
```

기존 `import { captureDevelopmentLandAreaEvidence, ... } from '../src/operations/development-land-area-evidence-capture';` 와 합쳐도 된다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx tsx --test tests/development-land-area-evidence-capture.test.ts`
Expected: FAIL. `isDevelopmentEvidenceCaptureRetryable` 미정의로 인한 TypeError 또는 tsx 컴파일 오류.

- [ ] **Step 3: 상수와 술어 구현**

`src/operations/development-land-area-evidence-capture.ts` 의 `DEVELOPMENT_EVIDENCE_CAPTURE_AUDIT_VERSION` 선언(31~32행)을 다음으로 교체한다.

```ts
export const DEVELOPMENT_EVIDENCE_CAPTURE_AUDIT_VERSION =
    'land-area-development-evidence-capture-audit@3' as const;

/** 최초 시도를 포함한 anchor 당 최대 시도 수. */
export const CAPTURE_MAX_ATTEMPTS = 3;
/** 재시도 라운드 사이 고정 지연. 외부 API 가 회복할 시간을 준다. */
export const CAPTURE_RETRY_DELAY_MS = 60_000;
/**
 * 재시도 대상이 targetCount 의 이 비율을 넘으면 API 장애로 보고 재시도를 생략한다.
 * 재시도해도 무용하고 capture 예산만 태우기 때문이다.
 */
export const RETRY_ELIGIBLE_MAX_RATIO = 0.25;
```

`aggregateDevelopmentEvidenceCaptureEntries`(309행) 바로 위에 술어를 추가한다.

```ts
/**
 * 재시도 대상 판정.
 *
 * `audit.status` 는 REVIEW 로 끝난 anchor 에도 'FAILED' 를 넣으므로 그대로 쓰면 안 된다.
 * aggregateDevelopmentEvidenceCaptureEntries 와 동일한 분기를 써서 집계상 FAILED 로
 * 떨어지는 entry, 즉 판정에 도달하지 못한 anchor 만 고른다.
 */
export function isDevelopmentEvidenceCaptureRetryable(
    entry: DevelopmentEvidenceCaptureAuditEntry
): boolean {
    if (
        entry.status === 'VERIFIED_NO_DATA' ||
        entry.status === 'CAPTURED'
    ) {
        return false;
    }
    if (entry.terminalOutcome === 'NO_DATA') return false;
    return !(
        entry.terminalOutcome === 'REVIEW_REQUIRED' ||
        entry.terminalScopeState === 'REVIEW_REQUIRED'
    );
}
```

- [ ] **Step 4: audit 타입에 필드 추가**

`DevelopmentEvidenceCaptureAuditEntry`(59행) 의 `scopeResolutionSource` 필드 뒤에 추가한다.

```ts
    /** 이 anchor 를 실행한 총 시도 수. 최초 시도가 1 이다. */
    attempts: number;
```

`DevelopmentEvidenceCaptureAudit` 의 `readOnlyGuards` 블록 바로 뒤(`entries:` 앞)에 추가한다.

```ts
    retry: {
        /** 실제 수행한 재시도 라운드 수. 0..CAPTURE_MAX_ATTEMPTS - 1 */
        rounds: number;
        /** 재시도를 1회 이상 받은 anchor 수 */
        retriedAnchorCount: number;
        /** 재시도로 FAILED 를 벗어난 anchor 수 */
        recoveredAnchorCount: number;
        skipped: 'NONE' | 'TOO_MANY_FAILURES';
    };
```

- [ ] **Step 5: captureOne 에 attempt 전달**

`captureOne`(662행) 의 input 타입에 `attempt: number;` 를 추가하고, 반환 audit 객체의 `scopeResolutionSource` 뒤에 `attempts: input.attempt,` 를 추가한다.

워커 풀 호출부(905~911행)의 `captureOne({...})` 인자에 `attempt: 1,` 을 추가한다.

- [ ] **Step 6: audit 조립에 retry 기본값 추가**

`entries: results.map((result) => result.audit),`(1163행 부근) 바로 앞에 추가한다.

```ts
            retry: {
                rounds: 0,
                retriedAnchorCount: 0,
                recoveredAnchorCount: 0,
                skipped: 'NONE',
            },
```

- [ ] **Step 7: 테스트 통과 확인**

Run: `npx tsx --test tests/development-land-area-evidence-capture.test.ts`
Expected: PASS. 신규 3건 포함 전건 통과.

- [ ] **Step 8: 전체 회귀 확인**

Run: `npm test`
Expected: `# fail 0`. 감사 버전 문자열을 고정한 테스트가 있으면 `@2` → `@3` 으로 함께 고친다.

Run: `npx tsc --noEmit`
Expected: 출력 없음, exit 0.

- [ ] **Step 9: 커밋**

```bash
git add src/operations/development-land-area-evidence-capture.ts tests/development-land-area-evidence-capture.test.ts
git commit -F - <<'EOF'
feat(land-area): capture 재시도 상수·술어·감사 필드 추가

재시도 로직 없이 관측 필드와 판정 술어만 먼저 넣는다.
audit.status 는 REVIEW anchor 에도 'FAILED' 를 넣으므로 재시도 판정에
쓸 수 없다. aggregateDevelopmentEvidenceCaptureEntries 와 같은 분기를
쓰는 isDevelopmentEvidenceCaptureRetryable 로 판정한다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: 라운드 루프

**Files:**
- Modify: `src/operations/development-land-area-evidence-capture.ts:896-925`
- Test: `tests/development-land-area-evidence-capture.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `CAPTURE_MAX_ATTEMPTS`, `CAPTURE_RETRY_DELAY_MS`, `isDevelopmentEvidenceCaptureRetryable`, `attempts`, `retry`
- Produces: `captureDevelopmentLandAreaEvidence` input 에 `sleep?: (ms: number) => Promise<void>` 선택 필드. 테스트가 지연을 즉시 반환으로 대체할 때 쓴다. 미지정 시 실제 타이머를 쓴다.

- [ ] **Step 0: 픽스처 예열**

재시도 assert 를 쓰기 전에 픽스처가 실제로 도는지부터 확인한다. `assertDevelopmentEvidenceCaptureActiveIdentity`(`:239-250`)는 `rows.length !== target.expectedUnionActivePropertyUnitCount` 이면 `CAPTURE_UNION_ACTIVE_PROPERTY_SET_MISMATCH` 로 throw 하므로, 기존 `target()` 헬퍼(429 하드코딩)를 그대로 쓰면 capture 가 시작조차 못 한다. 전용 헬퍼를 만든다.

`tests/development-land-area-evidence-capture.test.ts` 파일 끝에 추가한다.

```ts
const RETRY_PNUS = [
    '1130510100107912166',
    '1130510100107912167',
    '1130510100107912168',
    '1130510100107912169',
];
const RETRY_PROPERTY_UNIT_IDS = [
    '5a1a4cbb-c8ad-45a3-ae40-b90665dc9001',
    '5a1a4cbb-c8ad-45a3-ae40-b90665dc9002',
    '5a1a4cbb-c8ad-45a3-ae40-b90665dc9003',
    '5a1a4cbb-c8ad-45a3-ae40-b90665dc9004',
];

function retryTarget(): DevelopmentTargetManifest {
    return {
        version: DEVELOPMENT_TARGET_MANIFEST_VERSION,
        databaseTarget: 'development',
        unionId: UNION_ID,
        pnus: RETRY_PNUS,
        targetCount: RETRY_PNUS.length,
        manifestDigest: computeDevelopmentTargetDigest(
            UNION_ID,
            RETRY_PNUS
        ),
        expectedPropertyUnitCount: RETRY_PNUS.length,
        expectedUnionActivePropertyUnitCount: RETRY_PNUS.length,
        expectedUnionActivePnuCount: RETRY_PNUS.length,
    };
}

test('재시도 픽스처는 실패 anchor 없이 완주하고 retry 집계가 비어 있다', async () => {
    let titleScans = 0;
    const result = await captureDevelopmentLandAreaEvidence({
        target: retryTarget(),
        captureRunId: '30418532695',
        concurrency: 1,
        sleep: async () => {},
        deps: alwaysFailingTitleDeps({
            onScanTitle: () => {
                titleScans += 1;
            },
            failFor: () => false,
        }) as never,
    });

    assert.equal(titleScans, RETRY_PNUS.length);
    assert.equal(result.audit.retry.rounds, 0);
    assert.equal(result.audit.retry.retriedAnchorCount, 0);
    assert.equal(result.audit.retry.skipped, 'NONE');
    for (const entry of result.audit.entries) {
        assert.equal(entry.attempts, 1);
    }
});
```

`failFor: () => false` 이면 `scanTitle` 이 `COMPLETE_ZERO` 를 돌려주고, `scope.ts:276` 의 `anyTitleZero` 경로가 `BUILDING_CLASSIFICATION_CONFLICT` REVIEW 로 종결시킨다. 즉 판정에 도달하므로 재시도 대상이 아니다.

Run: `npx tsx --test tests/development-land-area-evidence-capture.test.ts`

이 테스트가 `CAPTURE_UNION_ACTIVE_*` 로 throw 하면 픽스처 숫자가 틀린 것이다. `retryTarget()` 의 세 `expected*` 값과 `readActivePropertyIdentity` 반환 행 수를 일치시켜 통과시킨 뒤 다음 단계로 간다. 재시도 assert 는 이 테스트가 초록이 된 다음에 쓴다.

- [ ] **Step 1: 실패 테스트 작성**

파일 끝에 추가한다. `scanTitle` 이 `FAILED` 를 반환하면 `scope.ts:273` 가 `PROVIDER_PROTOCOL_ERROR` 로 종결시켜 판정 미도달(FAILED) 이 된다.

```ts
function alwaysFailingTitleDeps(input: {
    onScanTitle: (anchorPnu: string) => void;
    failFor?: (anchorPnu: string) => boolean;
}) {
    return {
        now: () => new Date('2026-07-30T00:00:00.000Z'),
        async readActivePropertyIdentity() {
            return RETRY_PNUS.map((pnu, index) => ({
                id: RETRY_PROPERTY_UNIT_IDS[index],
                pnu,
            }));
        },
        async resolveScope() {
            return {
                data: {
                    dbState: 'NO_EVIDENCE',
                    rootBuildingIdentities: [],
                    componentPnus: [PNU],
                    linkedBasePnus: [],
                    linkedPnus: [],
                    linkedEvidenceKeys: [],
                    pendingEvidenceKeys: [],
                    blockingEvidence: [],
                    openUnresolvedEvidenceKeys: [],
                    componentTruncated: false,
                    propertyMembership: [
                        {
                            propertyUnitId: PROPERTY_UNIT_ID,
                            pnu: PNU,
                            buildingUnitId: null,
                        },
                    ],
                    dbScopeHash: 'db-scope-no-evidence',
                },
                error: null,
            };
        },
        async readBuildingUnits() {
            return [];
        },
        async readPropertyUnits() {
            return [];
        },
        async readCurrentLandTuples() {
            return [];
        },
        scans: {
            async scanTitle(anchorPnu: string) {
                input.onScanTitle(anchorPnu);
                if (input.failFor?.(anchorPnu) ?? true) {
                    return {
                        state: 'FAILED' as const,
                        issue: {
                            kind: 'HTTP_ERROR' as const,
                            endpoint: 'getBrTitleInfo' as const,
                            message: 'http 500',
                            httpStatus: 500,
                        },
                    };
                }
                return {
                    state: 'COMPLETE_ZERO' as const,
                    rows: [],
                    totalCount: 0,
                    pagesFetched: 1,
                };
            },
            async scanAttached() {
                return {
                    state: 'COMPLETE_ZERO' as const,
                    rows: [],
                    totalCount: 0,
                    pagesFetched: 1,
                };
            },
            async scanBasis() {
                return {
                    state: 'COMPLETE_ZERO' as const,
                    rows: [],
                    totalCount: 0,
                    pagesFetched: 1,
                };
            },
            async scanExpos() {
                return {
                    state: 'COMPLETE_ZERO' as const,
                    rows: [],
                    totalCount: 0,
                    pagesFetched: 1,
                };
            },
            async scanLadfrl() {
                return {
                    state: 'COMPLETE_ZERO' as const,
                    rows: [],
                    totalCount: 0,
                    pagesFetched: 1,
                };
            },
            async scanLdareg() {
                return {
                    state: 'COMPLETE_ZERO' as const,
                    rows: [],
                    totalCount: 0,
                    pagesFetched: 1,
                };
            },
        },
    };
}

test('판정 미도달 anchor는 CAPTURE_MAX_ATTEMPTS까지 재시도하고 시도 수를 기록한다', async () => {
    let titleScans = 0;
    let slept = 0;
    const result = await captureDevelopmentLandAreaEvidence({
        target: retryTarget(),
        captureRunId: '30418532695',
        concurrency: 1,
        sleep: async (ms) => {
            slept += ms;
        },
        deps: alwaysFailingTitleDeps({
            onScanTitle: () => {
                titleScans += 1;
            },
            failFor: (pnu) => pnu === RETRY_PNUS[0],
        }) as never,
    });

    const failing = result.audit.entries.find(
        (entry) => entry.anchorPnu === RETRY_PNUS[0]
    );
    assert.ok(failing);
    // round1 4건 + round2 1건 + round3 1건
    assert.equal(titleScans, RETRY_PNUS.length + 2);
    assert.equal(failing.attempts, CAPTURE_MAX_ATTEMPTS);
    assert.equal(failing.terminalScopeState, 'FAILED');
    assert.equal(result.audit.retry.rounds, CAPTURE_MAX_ATTEMPTS - 1);
    assert.equal(result.audit.retry.retriedAnchorCount, 1);
    assert.equal(result.audit.retry.recoveredAnchorCount, 0);
    assert.equal(result.audit.retry.skipped, 'NONE');
    assert.equal(
        slept,
        CAPTURE_RETRY_DELAY_MS * (CAPTURE_MAX_ATTEMPTS - 1)
    );
    assert.equal(result.audit.readOnlyGuards.durableSyncJobWrites, 0);
    assert.equal(
        result.audit.readOnlyGuards.propertyUnitWriteRpcCalls,
        0
    );
});

test('첫 라운드에서 실패한 anchor가 다음 라운드에서 판정에 도달하면 회복으로 집계한다', async () => {
    let titleScans = 0;
    const seen = new Map<string, number>();
    const result = await captureDevelopmentLandAreaEvidence({
        target: retryTarget(),
        captureRunId: '30418532695',
        concurrency: 1,
        sleep: async () => {},
        deps: alwaysFailingTitleDeps({
            onScanTitle: (pnu) => {
                titleScans += 1;
                seen.set(pnu, (seen.get(pnu) ?? 0) + 1);
            },
            // RETRY_PNUS[0] 만 첫 시도에서 실패하고 두 번째 시도부터 성공한다.
            failFor: (pnu) =>
                pnu === RETRY_PNUS[0] && (seen.get(pnu) ?? 0) === 1,
        }) as never,
    });

    const recovered = result.audit.entries.find(
        (entry) => entry.anchorPnu === RETRY_PNUS[0]
    );
    assert.ok(recovered);
    // round1 4건 + round2 1건
    assert.equal(titleScans, RETRY_PNUS.length + 1);
    assert.equal(recovered.attempts, 2);
    assert.equal(result.audit.retry.rounds, 1);
    assert.equal(result.audit.retry.retriedAnchorCount, 1);
    assert.equal(result.audit.retry.recoveredAnchorCount, 1);
    assert.notEqual(recovered.terminalScopeState, 'FAILED');
});
```

두 번째 테스트에서 `scanTitle` 이 `COMPLETE_ZERO` 를 돌려주면 `scope.ts:276` 의 `anyTitleZero` 경로로 `BUILDING_CLASSIFICATION_CONFLICT` REVIEW 가 되어 판정에 도달한다. 즉 `audit.status` 는 여전히 `'FAILED'` 지만 `isDevelopmentEvidenceCaptureRetryable` 이 false 가 되어 재시도가 멈추고 회복으로 집계된다. 이것이 D2 술어가 status 가 아닌 이유를 그대로 검증한다.

`onScanTitle` 이 `failFor` 보다 먼저 호출되므로 `seen.get(pnu) === 1` 이 곧 "첫 시도" 를 뜻한다. `retryTarget()` 의 targetCount 는 4 이고 Task 3 의 임계값은 `floor(4 * 0.25) = 1` 이므로, 실패 anchor 가 1건인 이 두 테스트는 Task 3 의 가드를 도입한 뒤에도 그대로 통과한다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx tsx --test tests/development-land-area-evidence-capture.test.ts`
Expected: FAIL. 재시도가 없어 `titleScans` 가 4 에 머물러 `4 !== 6` 으로 첫 테스트가 깨진다. Step 0 의 픽스처 예열 테스트는 계속 통과해야 한다.

- [ ] **Step 3: 워커 풀을 인덱스 배열 기반으로 바꾸기**

`captureDevelopmentLandAreaEvidence`(858행) 의 input 타입에 추가한다.

```ts
    sleep?: (ms: number) => Promise<void>;
```

`const results = new Array<CaptureOneResult>(executionAnchors.length);` 이후의 워커 풀 블록(899~925행) 전체를 다음으로 교체한다.

```ts
    const sleep =
        input.sleep ??
        ((ms: number) =>
            new Promise<void>((resolve) =>
                setTimeout(resolve, ms)
            ));

    const runRound = async (
        indices: readonly number[],
        attempt: number
    ): Promise<void> => {
        let cursor = 0;
        let completed = 0;
        const worker = async () => {
            while (true) {
                const slot = cursor;
                cursor += 1;
                if (slot >= indices.length) return;
                const index = indices[slot];
                results[index] = await captureOne({
                    target: input.target,
                    captureRunId: input.captureRunId,
                    anchorPnu: executionAnchors[index],
                    developmentFullRefresh,
                    attempt,
                    deps: input.deps,
                });
                completed += 1;
                input.onProgress?.(completed, indices.length);
            }
        };
        await Promise.all(
            Array.from(
                { length: Math.min(concurrency, indices.length) },
                () => worker()
            )
        );
    };

    await runRound(
        executionAnchors.map((_unused, index) => index),
        1
    );

    let retryRounds = 0;
    const retriedIndices = new Set<number>();
    for (
        let attempt = 2;
        attempt <= CAPTURE_MAX_ATTEMPTS;
        attempt += 1
    ) {
        const candidates = results
            .map((result, index) => ({ result, index }))
            .filter(({ result }) =>
                isDevelopmentEvidenceCaptureRetryable(result.audit)
            )
            .map(({ index }) => index);
        if (candidates.length === 0) break;
        await sleep(CAPTURE_RETRY_DELAY_MS);
        for (const index of candidates) retriedIndices.add(index);
        retryRounds += 1;
        await runRound(candidates, attempt);
    }

    const recoveredAnchorCount = [...retriedIndices].filter(
        (index) =>
            !isDevelopmentEvidenceCaptureRetryable(
                results[index].audit
            )
    ).length;
```

- [ ] **Step 4: retry 집계를 실제 값으로 교체**

Task 1 Step 6 에서 넣은 기본값 블록을 다음으로 교체한다.

```ts
            retry: {
                rounds: retryRounds,
                retriedAnchorCount: retriedIndices.size,
                recoveredAnchorCount,
                skipped: 'NONE',
            },
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx tsx --test tests/development-land-area-evidence-capture.test.ts`
Expected: PASS.

- [ ] **Step 6: 전체 회귀 확인**

Run: `npm test`
Expected: `# fail 0`.

Run: `npx tsc --noEmit`
Expected: 출력 없음, exit 0.

- [ ] **Step 7: 커밋**

```bash
git add src/operations/development-land-area-evidence-capture.ts tests/development-land-area-evidence-capture.test.ts
git commit -F - <<'EOF'
feat(land-area): capture 판정 미도달 anchor 라운드 재시도

워커 풀을 인덱스 배열 기반 runRound 로 바꾸고 최대 2회 재시도한다.
REVIEW 로 판정에 도달한 anchor 는 재시도하지 않는다. 지연은 테스트가
주입할 수 있도록 sleep 을 선택 의존성으로 뺐다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: 실패 비율 가드

**Files:**
- Modify: `src/operations/development-land-area-evidence-capture.ts`
- Test: `tests/development-land-area-evidence-capture.test.ts`

**Interfaces:**
- Consumes: Task 2 의 라운드 루프, Task 1 의 `RETRY_ELIGIBLE_MAX_RATIO`
- Produces: 없음 (기존 `retry.skipped` 를 채운다)

- [ ] **Step 1: 실패 테스트 작성**

파일 끝에 추가한다. `retryTarget()` 의 targetCount 는 4 이므로 임계값은 `floor(4 * 0.25) = 1` 이고, 4건 전부 실패하면 후보 4 > 1 이라 재시도가 생략된다.

```ts
test('실패가 임계 비율을 넘으면 재시도를 생략하고 사유를 남긴다', async () => {
    let titleScans = 0;
    let slept = 0;
    const result = await captureDevelopmentLandAreaEvidence({
        target: retryTarget(),
        captureRunId: '30418532695',
        concurrency: 1,
        sleep: async (ms) => {
            slept += ms;
        },
        deps: alwaysFailingTitleDeps({
            onScanTitle: () => {
                titleScans += 1;
            },
            failFor: () => true,
        }) as never,
    });

    assert.equal(titleScans, RETRY_PNUS.length);
    assert.equal(slept, 0);
    assert.equal(result.audit.retry.rounds, 0);
    assert.equal(result.audit.retry.retriedAnchorCount, 0);
    assert.equal(result.audit.retry.recoveredAnchorCount, 0);
    assert.equal(result.audit.retry.skipped, 'TOO_MANY_FAILURES');
    for (const entry of result.audit.entries) {
        assert.equal(entry.attempts, 1);
    }
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx tsx --test tests/development-land-area-evidence-capture.test.ts`
Expected: FAIL. 가드가 없어 4건 모두 3회씩 시도되므로 `titleScans` 가 12 가 되어 `12 !== 4`.

`slept` 가 0 이 아닌 것과 `retry.skipped` 가 `'NONE'` 인 것도 함께 깨진다.

- [ ] **Step 3: 가드 구현**

Task 2 Step 3 의 재시도 for 루프를 다음으로 교체한다.

```ts
    let retryRounds = 0;
    let retrySkipped: 'NONE' | 'TOO_MANY_FAILURES' = 'NONE';
    const retriedIndices = new Set<number>();
    const retryEligibleMax = Math.floor(
        input.target.targetCount * RETRY_ELIGIBLE_MAX_RATIO
    );
    for (
        let attempt = 2;
        attempt <= CAPTURE_MAX_ATTEMPTS;
        attempt += 1
    ) {
        const candidates = results
            .map((result, index) => ({ result, index }))
            .filter(({ result }) =>
                isDevelopmentEvidenceCaptureRetryable(result.audit)
            )
            .map(({ index }) => index);
        if (candidates.length === 0) break;
        // 대량 실패는 외부 API 장애다. 재시도해도 무용하고 capture 예산만
        // 태우므로 남은 라운드를 모두 포기한다.
        if (candidates.length > retryEligibleMax) {
            retrySkipped = 'TOO_MANY_FAILURES';
            break;
        }
        await sleep(CAPTURE_RETRY_DELAY_MS);
        for (const index of candidates) retriedIndices.add(index);
        retryRounds += 1;
        await runRound(candidates, attempt);
    }
```

Task 2 Step 4 의 retry 집계에서 `skipped` 를 교체한다.

```ts
                skipped: retrySkipped,
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx tsx --test tests/development-land-area-evidence-capture.test.ts`
Expected: PASS. Task 2 의 두 테스트도 계속 통과해야 한다 — 실패 anchor 가 1건이고 임계값이 1 이라 `1 > 1` 이 false 이므로 가드에 걸리지 않는다.

- [ ] **Step 5: 전체 회귀 확인**

Run: `npm test`
Expected: `# fail 0`.

Run: `npx tsc --noEmit`
Expected: 출력 없음, exit 0.

- [ ] **Step 6: 커밋**

```bash
git add src/operations/development-land-area-evidence-capture.ts tests/development-land-area-evidence-capture.test.ts
git commit -F - <<'EOF'
feat(land-area): capture 재시도에 실패 비율 가드 추가

후보가 targetCount * 0.25 를 넘으면 API 장애로 보고 남은 라운드를
포기한다. 이 가드로 재시도 대상이 69건으로 묶여 총 소요가 guardian
capture 예산 3600초 안에 들어온다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: 공개 artifact @4

**Files:**
- Modify: `.github/workflows/development-land-area-evidence-capture.yml:723-790`
- Test: `tests/development-land-area-sync-workflow.test.ts:245`

**Interfaces:**
- Consumes: Task 1~3 의 `audit.retry`, `audit.entries[].attempts`
- Produces: 공개 artifact `land-area-development-evidence-public-artifact@4`

- [ ] **Step 1: 실패 테스트 작성**

`tests/development-land-area-sync-workflow.test.ts` 의 `land-area-development-evidence-public-artifact@3` 고정(245행)을 `@4` 로 바꾸고, 같은 test 블록에 추가한다.

```ts
    assert.match(publicArtifactBlock, /retry: \{/);
    assert.match(publicArtifactBlock, /rounds: audit\.retry\.rounds/);
    assert.match(
        publicArtifactBlock,
        /retriedAnchorCount: audit\.retry\.retriedAnchorCount/
    );
    assert.match(
        publicArtifactBlock,
        /recoveredAnchorCount: audit\.retry\.recoveredAnchorCount/
    );
    assert.match(
        publicArtifactBlock,
        /skipped: audit\.retry\.skipped/
    );
    assert.match(publicArtifactBlock, /attempts: entry\.attempts/);
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx tsx --test tests/development-land-area-sync-workflow.test.ts`
Expected: FAIL. `@4` 문자열이 워크플로에 없어 첫 assert 에서 실패.

- [ ] **Step 3: 워크플로 수정**

`.github/workflows/development-land-area-evidence-capture.yml` 754행을 바꾼다.

```yaml
            version: "land-area-development-evidence-public-artifact@4",
```

`redactedFailureDetails` 의 객체 리터럴(728~739행)에서 `resolutionSource` 뒤에 추가한다.

```js
                    attempts: entry.attempts,
```

artifact 객체의 `readOnlyGuards` 앞에 추가한다.

```js
            retry: {
              rounds: audit.retry.rounds,
              retriedAnchorCount: audit.retry.retriedAnchorCount,
              recoveredAnchorCount: audit.retry.recoveredAnchorCount,
              skipped: audit.retry.skipped,
            },
```

- [ ] **Step 4: 검증 블록 확인**

같은 워크플로의 sanitized artifact 검증 단계에서 `land-area-development-evidence-public-artifact@3` 을 참조하는 곳이 더 있는지 확인한다.

Run: `grep -n "public-artifact@" .github/workflows/development-land-area-evidence-capture.yml`
Expected: `@4` 만 남는다. `@3` 이 남아 있으면 모두 `@4` 로 바꾼다.

Run: `grep -rn "public-artifact@3" .github/ src/ tests/`
Expected: 출력 없음.

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx tsx --test tests/development-land-area-sync-workflow.test.ts`
Expected: PASS.

- [ ] **Step 6: 전체 회귀 확인**

Run: `npm test`
Expected: `# fail 0`.

Run: `npx tsc --noEmit`
Expected: 출력 없음, exit 0.

- [ ] **Step 7: 커밋**

```bash
git add .github/workflows/development-land-area-evidence-capture.yml tests/development-land-area-sync-workflow.test.ts
git commit -F - <<'EOF'
feat(land-area): 공개 capture artifact 에 재시도 집계 노출 (@4)

audit/evidence 는 실행 후 삭제되므로 공개 artifact 외에는 재시도 발생
여부를 사후에 확인할 수단이 없다. 정수와 열거형만 추가해 기존 비식별
정규식 가드는 그대로 통과한다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 5: main 머지와 실환경 검증

**Files:** 없음 (운영 절차)

**Interfaces:**
- Consumes: Task 1~4
- Produces: 없음

- [ ] **Step 1: 작업 브랜치 최신화**

```bash
git checkout feat/capture-transient-retry
git merge main
```

충돌이 있으면 이 브랜치에서 해소한다.

- [ ] **Step 2: main 머지와 푸시**

```bash
git checkout main
git merge feat/capture-transient-retry
git push origin main
git branch -d feat/capture-transient-retry
```

- [ ] **Step 3: 배포 완료 확인**

두 워크플로가 EC2 이미지 revision 을 main HEAD 와 exact 대조하므로 배포가 끝나야 실행할 수 있다.

```bash
gh run list --workflow docker-build.yml -L 1 --json databaseId,status,conclusion,headSha
```

Expected: `conclusion: success` 이고 `headSha` 가 방금 푸시한 main HEAD 와 같다.

- [ ] **Step 4: read-only capture 재실행**

```bash
gh workflow run development-land-area-evidence-capture.yml --ref main -f manifest=mia-seven-full-278-official-components-api-readonly-20260729
```

이 워크플로는 `land-area-sync-development-backfill` 환경에 수동 리뷰어 승인 게이트가 걸려 있다. 승인 없이는 `waiting` 에서 진행되지 않으므로 사용자에게 승인을 요청한다.

- [ ] **Step 5: 공개 artifact 확인**

```bash
gh run download <run-id> -D /tmp/capture-verify
```

확인할 값:

| 필드 | 기대 |
|---|---|
| `version` | `land-area-development-evidence-public-artifact@4` |
| `retry.rounds` | 0 이상 |
| `retry.skipped` | `NONE` 또는 `TOO_MANY_FAILURES` |
| `redactedAggregate.FAILED` | 직전 실행(40)보다 감소 |
| `readOnlyGuards.durableSyncJobWrites` | 0 |
| `readOnlyGuards.propertyUnitWriteRpcCalls` | 0 |
| `productionWrites` | 0 |

- [ ] **Step 6: DEV DB 무쓰기 확인**

Supabase project `yxypndgipnxrdfyctmvh` 에 read-only SELECT 를 돌린다.

```sql
select max(land_area_synced_at) as last_synced_at
from property_units
where union_id = '00f48b95-e9bc-4c92-a0e5-6b9a57adcfb9';
```

Expected: `2026-07-24 21:45:22.714366+00` 로 불변.

---

## 완료 기준

- `npm test` 전건 통과, `npx tsc --noEmit` 클린
- 공개 artifact `@4` 에 `retry` 집계가 채워짐
- `readOnlyGuards` 와 `productionWrites` 가 0
- DEV DB 최종 쓰기 시각 불변

## 범위 밖

278 전건 PASS 는 이 계획으로 달성되지 않는다. REVIEW 6건(791-2155 · 2282 · 2320 · 2343 · 745-62 · 791-2197)의 개별 사유는 설계 문서 "남은 별건" 절에 정리돼 있고 각각 별도 작업이다.
