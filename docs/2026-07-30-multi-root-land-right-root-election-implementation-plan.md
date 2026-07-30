# 한 지번 복수 root — 대지권 대상 root 선출 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 한 지번에 일반건축물 1동 + 집합건물 1동이 정상적으로 서 있는 anchor(미아7 791-2282)를,
대지권등록부 근거를 가진 root 하나를 선출해 LDAREG 전략으로 통과시킨다.

**Architecture:** 표제부 root(title self PK)가 여럿일 때만 LDAREG+EXPOS+BASIS를 base PNU에 한해 미리
조회해 "대지권등록부 행 근거를 가진 root"를 선출한다. 선출된 root는 **분류 축과 단일성 판정 축**만
좁히고, **BASIS/EXPOS closure 축과 bylot·attached 축은 전체 root를 그대로 유지**한다. 두 축의 분리가
이 개정의 핵심이다. 추가로 `2 / 02000 / 공동주택` pair를 부속용도 토큰 없이도 법정 규모 기준
(지상 층수 ≤ 4 이고 연면적 ≤ 660㎡)으로 다세대주택으로 인정한다.

**Tech Stack:** TypeScript (strict), Node.js `node:test` + `node:assert/strict`, tsx. 외부 HTTP·DB는 전부
주입(deps)이라 모든 신규 로직은 순수 함수로 테스트한다.

**근거 문서:** [`docs/2026-07-30-multi-root-parcel-design-revision.md`](./2026-07-30-multi-root-parcel-design-revision.md)
(승인됨, 2026-07-30). 원 설계는 [`docs/2026-07-23-land-area-sync-design.md`](./2026-07-23-land-area-sync-design.md).

---

## Global Constraints

프로젝트 전역 요구사항이다. **모든 task의 요구사항에 이 절이 암묵적으로 포함된다.**

- **매니페스트·게이트 기대값 불변.** anchors `278`, allowedScopePnus `301`, expected `429/299`,
  `manifestDigest`, 정책 상수, 두 워크플로, 공개 artifact 하드핀, DB marker를 **바꾸지 않는다.**
  기대값은 그대로 두고 실측값만 올라간다.
- **digest 버전 불변.** `SCOPE_HASH_VERSION`(`land-area-sync/scope-hash@2`),
  `EXTERNAL_SCOPE_DIGEST_VERSION`(`land-area-sync/external-scope-digest@3`),
  `land-area-sync.same-run-official-component@1`, `land-area-sync/property-membership@1`,
  parcel-singleton digest version을 **바꾸지 않는다.** `buildExternalScopeDigest`의 payload에
  필드를 추가하지 않는다 (추가하면 모든 anchor의 scopeHash가 이동한다).
- **DB 쓰기 0건.** 이 작업은 코드·문서·테스트만 바꾼다. 마이그레이션을 만들지 않고
  `supabase db push` / `apply_migration` / DDL을 실행하지 않는다.
- **외부 API 실호출 0건.** 모든 테스트는 주입한 fake scan으로만 돌린다.
- **기존 REVIEW를 FAILED로 바꾸지 않는다.** 선출 과정의 scan 불완전·실패는 새 `FAILED` terminal을
  만들지 않고 반드시 기존 `REVIEW_REQUIRED` 경로로 닫는다(fail-closed, 게이트 호환).
- **선출 pre-pass는 `basePnus`만 조회한다.** Phase 3가 이미 title/attached를 조회한 그 집합이다.
  새 PNU를 건드리지 않으므로 `assertCanaryScopeAllowed` 계약이 그대로 유지된다.
- **분모 계산·`§3.2 신규 동(棟) 엔티티`·parcel-singleton(LADFRL) 경로·제외 동의 물건지 처리는
  이 작업 범위가 아니다** (개정안 §5).
- **주석·문서·테스트 이름은 한국어.** 기존 파일들의 밀도·어투를 따른다.
- **substring 분류 금지.** `mainPurpsCdNm.includes('주택')` 류를 절대 도입하지 않는다.
- 커밋 메시지는 기존 관례를 따른다: `feat(land-area): ...` / `fix(land-area): ...` /
  `test(land-area): ...` / `docs(land-area): ...`.

**작업 브랜치:** 전역 규칙대로 최신 `main`에서 분기한다.

```bash
cd /Users/inju/workspace/tonghari/tonghari-api && git checkout main && git pull origin main && git checkout -b feat/multi-root-land-right-root-election
```

> `docs/multi-root-parcel-revision` 브랜치(개정안 문서, 커밋 `992263f` + `6def9cb`)는 아직 `main`에
> 머지되지 않았다. Task 8에서 처리한다. 그때까지 이 브랜치에는 개정안 문서가 없으므로 위 링크는
> Task 8 이후에 유효해진다.

**전체 테스트 명령:**

```bash
cd /Users/inju/workspace/tonghari/tonghari-api && npm test
```

**타입 체크:**

```bash
cd /Users/inju/workspace/tonghari/tonghari-api && npx tsc --noEmit
```

---

## File Structure

| 파일 | 책임 | 이 계획에서의 변경 |
| --- | --- | --- |
| `src/types/land-area-sync.types.ts` | provider row 타입 | `BrTitleRow`에 `grndFlrCnt` · `totArea` 명시 |
| `src/services/land-area-sync/housing-purpose-allowlist.fixture.ts` | 공식 (대장구분·주용도) pair frozen fixture | `02000` pair에 규모 기준 대체 상한 추가 |
| `src/services/land-area-sync/classifier.ts` | 주택 유형 분류 | 규모 기준 판정 + 기대 신호 도출 helper 추출 |
| `src/services/land-area-sync/scope.ts` | 공통 parcel-scope gate + 3층 hash | 분류 입력 partition, 단일성 가드 3곳, 결과에 선택/제외 root 노출 |
| `src/services/land-area-sync/ldareg-branch.ts` | LDAREG p_items 조립 | `electLandRightRootIdentity` 신설 + closure root 축 분리 |
| `src/services/land-area-sync/matcher.ts` | per-unit 매칭 결정 | 주석만 (선택 root 의미 명시) |
| `src/services/land-area-sync/expos-root.ts` | EXPOS root closure | 변경 없음 (이미 복수 root Set 입력) — 주석만 |
| `src/services/land-area-sync/service.ts` | discovery/apply 오케스트레이션 | Phase 3.5 선출 pre-pass, scan 재사용, branch 배선 |
| `src/verification/land-area-phase0-capture.ts` | Phase 0 fixture capture | 분류 입력에 규모 두 필드 추가(계약 일치) |
| `tests/land-area-sync-classifier.test.ts` | 분류 계약 | 규모 기준 신규 + 기존 사유 갱신 |
| `tests/land-area-sync-scope.test.ts` | gate 계약 | partition·단일성 가드 |
| `tests/land-area-sync-ldareg-branch.test.ts` | 선출·closure 계약 | 신규 |
| `tests/land-area-sync-service.test.ts` | 배선 계약 | 선출 기반 root 선택 |
| `tests/land-area-sync-integration.test.ts` | end-to-end | 791-2282 형상 회귀 |
| `docs/2026-07-23-land-area-sync-design.md` | 원 설계 | §9.1 · §9.2 · §10.4 · §12.3 · §12.4 개정 반영 |

**두 축 요약 (전 task 공통 불변식):**

```
closure 축   (BASIS parentBySelf / EXPOS root 해소)  = 표제부 root 전체 집합
bylot·attached 축 (expectedPks / bylotCnt / 부속지번) = 표제부 root 전체 집합
분류 축      (classifyHousingType 입력)              = 선출된 단일 root
단일성 축    (component managementPk 판정)           = 선출된 단일 root
매칭 축      (matcher scopeRootIdentity)             = 선출된 단일 root
```

---

## Task 1: `02000 공동주택` 법정 규모 기준 분류

**Files:**
- Modify: `src/types/land-area-sync.types.ts` (`BrTitleRow`)
- Modify: `src/services/land-area-sync/housing-purpose-allowlist.fixture.ts`
- Modify: `src/services/land-area-sync/classifier.ts`
- Modify: `src/services/land-area-sync/scope.ts:301-310` (분류 입력 조립)
- Modify: `src/verification/land-area-phase0-capture.ts:2155-2166` (분류 입력 조립)
- Test: `tests/land-area-sync-classifier.test.ts`

**Interfaces:**
- Consumes: 없음 (첫 task)
- Produces:
  - `HousingScaleFallbackLimit { maxGroundFloorCount: number; maxTotalFloorAreaSqm: number }`
  - `HousingPurposePair.requiredScaleFallback?: HousingScaleFallbackLimit`
  - `HousingClassifierInput.titleRows[].grndFlrCnt?: string | number`
  - `HousingClassifierInput.titleRows[].totArea?: string | number`
  - `ClassificationReason` 에 `'HOUSING_SCALE_EVIDENCE_MISSING' | 'HOUSING_SCALE_EXCEEDS_MULTIPLEX_LIMIT'` 추가

---

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/land-area-sync-classifier.test.ts` 맨 아래에 추가한다. 파일 상단의 기존 helper
(`row`, `input`, `LIVE_MULTIPLEX`)를 그대로 쓴다. `LIVE_MULTIPLEX`는
`requiredOtherPurposeSignal === 'MULTIPLEX_HOUSE'`인 `2 / 02000 / 공동주택` pair다.

```ts
// ── §6 법정 규모 기준 (건축법 시행령 별표1) ────────────────────────────

test('02000 공동주택 pair는 토큰이 없어도 지상 4층·연면적 660㎡ 이하면 다세대로 인정한다', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                {
                    ...row({ ...LIVE_MULTIPLEX, etcPurps: '공동주택' }),
                    grndFlrCnt: '4',
                    totArea: '513.06',
                },
            ],
        })
    );
    assert.equal(r.kind, 'CLASSIFIED');
    assert.equal(r.kind === 'CLASSIFIED' && r.family, 'LDAREG');
    assert.equal(r.kind === 'CLASSIFIED' && r.category, 'MULTIPLEX');
    assert.equal(r.kind === 'CLASSIFIED' && r.regstrGbCd, '2');
});

test('02000 공동주택 pair는 지상 5층 이상이면 아파트 배제로 REVIEW_REQUIRED', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                {
                    ...row({ ...LIVE_MULTIPLEX, etcPurps: '공동주택' }),
                    grndFlrCnt: '5',
                    totArea: '513.06',
                },
            ],
        })
    );
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(
        r.kind === 'REVIEW_REQUIRED' && r.reason,
        'HOUSING_SCALE_EXCEEDS_MULTIPLEX_LIMIT'
    );
    assert.equal(
        r.kind === 'REVIEW_REQUIRED' && r.issue,
        'BUILDING_CLASSIFICATION_CONFLICT'
    );
});

test('02000 공동주택 pair는 연면적 660㎡ 초과면 연립주택 배제로 REVIEW_REQUIRED', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                {
                    ...row({ ...LIVE_MULTIPLEX, etcPurps: '공동주택' }),
                    grndFlrCnt: '4',
                    totArea: '660.01',
                },
            ],
        })
    );
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(
        r.kind === 'REVIEW_REQUIRED' && r.reason,
        'HOUSING_SCALE_EXCEEDS_MULTIPLEX_LIMIT'
    );
});

test('02000 공동주택 pair는 규모 경계값(4층·정확히 660㎡)을 이하로 인정한다', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                {
                    ...row({ ...LIVE_MULTIPLEX, etcPurps: '공동주택' }),
                    grndFlrCnt: 4,
                    totArea: 660,
                },
            ],
        })
    );
    assert.equal(r.kind, 'CLASSIFIED');
});

test('02000 공동주택 pair는 규모 값 누락·비숫자·음수를 0으로 보정하지 않고 REVIEW_REQUIRED', () => {
    const cases: Array<Record<string, unknown>> = [
        {},
        { grndFlrCnt: '4' },
        { totArea: '513.06' },
        { grndFlrCnt: '', totArea: '513.06' },
        { grndFlrCnt: '4', totArea: '' },
        { grndFlrCnt: '4층', totArea: '513.06' },
        { grndFlrCnt: '4', totArea: '513.06㎡' },
        { grndFlrCnt: '-1', totArea: '513.06' },
        { grndFlrCnt: '4', totArea: '-1' },
        { grndFlrCnt: '4', totArea: '0' },
        { grndFlrCnt: '4.5', totArea: '513.06' },
        { grndFlrCnt: null, totArea: null },
    ];
    for (const scale of cases) {
        const r = classifyHousingType(
            input({
                titleRows: [
                    {
                        ...row({ ...LIVE_MULTIPLEX, etcPurps: '공동주택' }),
                        ...scale,
                    },
                ],
            })
        );
        assert.equal(
            r.kind,
            'REVIEW_REQUIRED',
            `규모 값 ${JSON.stringify(scale)} 은 인정하지 않는다`
        );
        assert.equal(
            r.kind === 'REVIEW_REQUIRED' && r.reason,
            'HOUSING_SCALE_EVIDENCE_MISSING',
            `규모 값 ${JSON.stringify(scale)} 사유`
        );
    }
});

test('규모 기준은 모순 신호를 덮지 않는다 — 아파트 토큰은 규모가 맞아도 차단', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                {
                    ...row({
                        ...LIVE_MULTIPLEX,
                        etcPurps: '공동주택(아파트)',
                    }),
                    grndFlrCnt: '4',
                    totArea: '513.06',
                },
            ],
        })
    );
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(
        r.kind === 'REVIEW_REQUIRED' && r.reason,
        'CONTRADICTORY_OTHER_PURPOSE_SIGNAL'
    );
});

test('부속용도 다세대주택 토큰 경로는 규모 값이 없어도 그대로 인정한다(§6.5)', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                row({
                    ...LIVE_MULTIPLEX,
                    etcPurps: '공동주택(다세대주택)',
                }),
            ],
        })
    );
    assert.equal(r.kind, 'CLASSIFIED');
    assert.equal(r.kind === 'CLASSIFIED' && r.family, 'LDAREG');
});

test('02003 다세대주택 pair는 규모 검사 없이 통과한다(§6.4)', () => {
    const r = classifyHousingType(
        input({ titleRows: [row(MULTIPLEX)] })
    );
    assert.equal(r.kind, 'CLASSIFIED');
    assert.equal(r.kind === 'CLASSIFIED' && r.category, 'MULTIPLEX');
});

test('규모 기준은 02000 pair 외 다른 pair 판정에 관여하지 않는다(§6.4)', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                {
                    ...row(DETACHED),
                    grndFlrCnt: '99',
                    totArea: '99999',
                },
            ],
        })
    );
    assert.equal(r.kind, 'CLASSIFIED');
    assert.equal(r.kind === 'CLASSIFIED' && r.family, 'LADFRL');
});

test('여러 표제부 행 중 하나라도 규모 상한을 넘으면 인정하지 않는다', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                {
                    ...row({ ...LIVE_MULTIPLEX, etcPurps: '공동주택' }),
                    grndFlrCnt: '4',
                    totArea: '513.06',
                },
                {
                    ...row({ ...LIVE_MULTIPLEX, etcPurps: '공동주택' }),
                    grndFlrCnt: '6',
                    totArea: '513.06',
                },
            ],
        })
    );
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(
        r.kind === 'REVIEW_REQUIRED' && r.reason,
        'HOUSING_SCALE_EXCEEDS_MULTIPLEX_LIMIT'
    );
});
```

같은 파일의 기존 테스트 하나를 갱신한다. `02000` pair는 이제 규모 기준 대체 경로를 가지므로,
토큰이 없을 때의 사유가 `REQUIRED_OTHER_PURPOSE_SIGNAL_MISSING` → `HOUSING_SCALE_EVIDENCE_MISSING`
으로 바뀐다. issue code는 그대로 `BUILDING_CLASSIFICATION_CONFLICT`이므로 gate·매니페스트 영향은 없다.

`tests/land-area-sync-classifier.test.ts:75-90` 의 다음 부분을

```ts
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(
        r.kind === 'REVIEW_REQUIRED' && r.reason,
        'REQUIRED_OTHER_PURPOSE_SIGNAL_MISSING'
    );
});
```

이렇게 바꾼다.

```ts
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    // 02000 pair는 규모 기준 대체 경로를 가지므로, 토큰 lookalike + 규모 값 부재는
    // 규모 근거 부재 사유로 닫힌다. issue code는 BUILDING_CLASSIFICATION_CONFLICT 그대로다.
    assert.equal(
        r.kind === 'REVIEW_REQUIRED' && r.reason,
        'HOUSING_SCALE_EVIDENCE_MISSING'
    );
});
```

- [ ] **Step 2: 실패를 확인한다**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && node --import tsx --test tests/land-area-sync-classifier.test.ts
```
Expected: FAIL. `HOUSING_SCALE_EVIDENCE_MISSING` / `HOUSING_SCALE_EXCEEDS_MULTIPLEX_LIMIT` 를 기대하는
테스트가 `REQUIRED_OTHER_PURPOSE_SIGNAL_MISSING`을 받고, "지상 4층·연면적 660㎡ 이하" 테스트가
`CLASSIFIED` 대신 `REVIEW_REQUIRED`를 받는다.

- [ ] **Step 3: `BrTitleRow`에 규모 두 필드를 명시한다**

`src/types/land-area-sync.types.ts`의 `BrTitleRow`에서

```ts
    /** 주용도 명 */
    mainPurpsCdNm?: string;
    [key: string]: unknown;
}
```

를 다음으로 바꾼다.

```ts
    /** 주용도 명 */
    mainPurpsCdNm?: string;
    /** 지상 층수 (DESIGN §9.2 규모 기준 — 아파트 배제용) */
    grndFlrCnt?: string | number;
    /** 연면적 ㎡ (DESIGN §9.2 규모 기준 — 연립주택 배제용) */
    totArea?: string | number;
    [key: string]: unknown;
}
```

- [ ] **Step 4: fixture에 규모 기준 상한을 추가한다**

`src/services/land-area-sync/housing-purpose-allowlist.fixture.ts`에서
`HousingPurposePair` 인터페이스 바로 위에 타입을 추가한다.

```ts
/**
 * 부속용도 토큰이 없을 때 법정 규모 기준으로 대체 인정하는 상한 (건축법 시행령 별표1).
 *
 * 두 대용값은 **모두 보수적인 방향**이다. 잘못 거부할 수는 있어도 잘못 승인할 수는 없다.
 *  - `totArea`(연면적)는 지하·비주거를 포함하므로 주택 바닥면적 합계 이상이다.
 *    따라서 660 이하면 주택 부분도 반드시 660 이하다 → 연립주택(660㎡ 초과) 통과 불가.
 *  - `grndFlrCnt`(지상 층수)는 주택으로 쓰는 층수 이상이다.
 *    따라서 4 이하면 주택 층수도 반드시 4 이하다 → 아파트(5개 층 이상) 통과 불가.
 */
export interface HousingScaleFallbackLimit {
    /** 지상 층수 상한(이하). */
    readonly maxGroundFloorCount: number;
    /** 연면적 상한(㎡, 이하). */
    readonly maxTotalFloorAreaSqm: number;
}
```

`HousingPurposePair`에 필드를 추가한다. `requiredOtherPurposeSignal` 바로 아래에 넣는다.

```ts
    /** 기타용도에서 exact-token으로 추가 확인해야 하는 경우의 고정 신호. */
    requiredOtherPurposeSignal?: HousingOtherPurposeSignal;
    /**
     * 위 토큰이 없을 때만 쓰는 법정 규모 기준 대체 근거 (DESIGN §9.2).
     * 토큰이 있으면 규모 검사 없이 통과한다 — 규모 기준은 토큰을 대체하지 않고 보완한다.
     */
    requiredScaleFallback?: HousingScaleFallbackLimit;
```

`02000` pair에 상한을 붙인다. `requiredOtherPurposeSignal`은 **지우지 않는다**(§6.5).

```ts
    // Phase 0 실측: 집합/공동주택 + 기타용도 exact token 다세대주택 — LDAREG
    // 2026-07-30 실측(미아7 791-2282): 부속용도 원문이 주용도와 같은 `공동주택`이어서
    // 토큰 추가 방식이 성립하지 않는다. 토큰이 없을 때만 법정 규모 기준으로 인정한다.
    {
        regstrGbCd: '2',
        mainPurpsCd: '02000',
        mainPurpsCdNm: '공동주택',
        requiredOtherPurposeSignal: 'MULTIPLEX_HOUSE',
        requiredScaleFallback: {
            maxGroundFloorCount: 4,
            maxTotalFloorAreaSqm: 660,
        },
        category: 'MULTIPLEX',
        family: 'LDAREG',
    },
```

- [ ] **Step 5: classifier에 규모 판정을 넣는다**

`src/services/land-area-sync/classifier.ts`를 편집한다.

(a) import에 새 타입을 추가한다.

```ts
import {
    HOUSING_PURPOSE_ALLOWLIST,
    UNSUPPORTED_HOUSING_TYPE_NAMES,
    type HousingCategory,
    type HousingPurposePair,
    type HousingStrategyFamily,
} from './housing-purpose-allowlist.fixture';
```

(b) `HousingClassifierInput.titleRows` 원소에 두 필드를 추가한다.

```ts
/** 분류 입력. 분류에 필요한 표제부 필드와 root 관리번호 집합만 받는다. */
export interface HousingClassifierInput {
    titleRows: Array<{
        regstrGbCd?: string;
        mainPurpsCd?: string;
        mainPurpsCdNm?: string;
        etcPurps?: string;
        /** 지상 층수. `02000` pair 규모 기준 판정에만 쓴다 (DESIGN §9.2). */
        grndFlrCnt?: string | number;
        /** 연면적 ㎡. `02000` pair 규모 기준 판정에만 쓴다 (DESIGN §9.2). */
        totArea?: string | number;
    }>;
    /** DB resolver·title seed가 확정한 root 관리번호 집합(복수면 REVIEW). */
    rootIdentities: string[];
}
```

(c) `ClassificationReason`에 두 사유를 추가한다.

```ts
    | 'REQUIRED_OTHER_PURPOSE_SIGNAL_MISSING'
    | 'CONTRADICTORY_OTHER_PURPOSE_SIGNAL'
    | 'HOUSING_SCALE_EVIDENCE_MISSING'
    | 'HOUSING_SCALE_EXCEEDS_MULTIPLEX_LIMIT'
    | 'UNSUPPORTED_HOUSING_TYPE'
```

(d) `function review(...)` 아래에 parser와 기대 신호 helper를 추가한다.
기대 신호 도출은 기존 코드에 두 번 중복돼 있었다 — 여기로 한 번만 뽑는다.

```ts
/** pair category별 유일하게 허용되는 기타용도 신호. */
function expectedOtherPurposeSignal(pair: HousingPurposePair) {
    return pair.category === 'DETACHED'
        ? 'DETACHED_HOUSE'
        : pair.category === 'MULTIFAMILY'
          ? 'MULTI_UNIT_HOUSE'
          : 'MULTIPLEX_HOUSE';
}

/**
 * 지상 층수 parser. 공백 제거 후 0 이상 safe integer만 valid하다.
 * 빈 값·null·음수·소수·비숫자·단위 접미사는 invalid이며 절대 0으로 보정하지 않는다.
 */
function parseGroundFloorCount(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!/^[0-9]+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * 연면적 parser. 공백 제거 후 양수 유한 십진수만 valid하다.
 * 0·음수·단위 포함 문자열은 invalid다 — 0은 상한 검사를 그냥 통과해버리므로 거부한다.
 */
function parseTotalFloorArea(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0 ? value : null;
    }
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

type HousingScaleCheck = 'OK' | 'EVIDENCE_MISSING' | 'EXCEEDS_LIMIT';
```

(e) `classifyHousingType` 안의 `norm` 조립에 두 raw 값을 통과시킨다.

```ts
    // 각 row 정규화 + 빈 코드·명칭 검사
    const norm = titleRows.map((r) => ({
        regstrGbCd: s(r.regstrGbCd),
        mainPurpsCd: s(r.mainPurpsCd),
        mainPurpsCdNm: s(r.mainPurpsCdNm),
        otherPurposeSignals: housingOtherPurposeSignals(r.etcPurps),
        // 규모 기준은 parser가 판정하므로 raw 값을 그대로 넘긴다.
        grndFlrCnt: r.grndFlrCnt,
        totArea: r.totArea,
    }));
```

(f) `const one = norm[0];` 아래의 allowlist 조회 블록 전체
(현행 `const exactPairMatches = ...` 부터 `UNSUPPORTED_HOUSING_TYPE_NAMES` 검사 직전까지)를
다음으로 교체한다.

```ts
    // allowlist exact (대장구분·코드·명칭) 조회
    const exactPairMatches = HOUSING_PURPOSE_ALLOWLIST.filter(
        (p) => p.regstrGbCd === one.regstrGbCd && p.mainPurpsCd === one.mainPurpsCd && p.mainPurpsCdNm === one.mainPurpsCdNm
    );

    /** 기대 신호 외의 토큰이 하나도 없는지 — 모순 신호 부재. */
    const noContradictorySignal = (pair: HousingPurposePair): boolean =>
        norm.every((row) =>
            row.otherPurposeSignals.every(
                (signal) => signal === expectedOtherPurposeSignal(pair)
            )
        );
    /** 요구 토큰까지 충족하는 기존 신호 경로. */
    const otherPurposeSignalSatisfied = (
        pair: HousingPurposePair
    ): boolean =>
        noContradictorySignal(pair) &&
        norm.every(
            (row) =>
                !pair.requiredOtherPurposeSignal ||
                row.otherPurposeSignals.includes(
                    pair.requiredOtherPurposeSignal
                )
        );
    /**
     * 법정 규모 기준 판정 (DESIGN §9.2). 모든 행이 상한 이내여야 인정한다.
     * 값 누락·파싱 실패는 0으로 보정하거나 다른 필드로 대체하지 않는다.
     */
    const scaleCheck = (pair: HousingPurposePair): HousingScaleCheck => {
        const limit = pair.requiredScaleFallback;
        if (!limit) return 'EVIDENCE_MISSING';
        for (const row of norm) {
            const floors = parseGroundFloorCount(row.grndFlrCnt);
            const area = parseTotalFloorArea(row.totArea);
            if (floors === null || area === null) return 'EVIDENCE_MISSING';
            if (
                floors > limit.maxGroundFloorCount ||
                area > limit.maxTotalFloorAreaSqm
            ) {
                return 'EXCEEDS_LIMIT';
            }
        }
        return 'OK';
    };

    const classified = (pair: HousingPurposePair): HousingClassification => ({
        kind: 'CLASSIFIED',
        family: pair.family,
        category: pair.category,
        regstrGbCd: pair.regstrGbCd,
    });

    // 1) 기존 부속용도 토큰 경로 — 규모 검사 없이 그대로 인정한다(§6.5).
    const signalMatched = exactPairMatches.find(otherPurposeSignalSatisfied);
    if (signalMatched) return classified(signalMatched);

    // 2) 토큰이 없을 때만 법정 규모 기준 대체 경로를 시도한다.
    const scaleMatched = exactPairMatches.find(
        (pair) =>
            pair.requiredScaleFallback !== undefined &&
            noContradictorySignal(pair) &&
            scaleCheck(pair) === 'OK'
    );
    if (scaleMatched) return classified(scaleMatched);

    if (exactPairMatches.length > 0) {
        const pair = exactPairMatches[0];
        // 모순 신호는 규모 기준으로 덮지 않는다 — 먼저 차단한다.
        if (!noContradictorySignal(pair)) {
            return review(
                'CONTRADICTORY_OTHER_PURPOSE_SIGNAL',
                'BUILDING_CLASSIFICATION_CONFLICT'
            );
        }
        if (pair.requiredScaleFallback) {
            return review(
                scaleCheck(pair) === 'EXCEEDS_LIMIT'
                    ? 'HOUSING_SCALE_EXCEEDS_MULTIPLEX_LIMIT'
                    : 'HOUSING_SCALE_EVIDENCE_MISSING',
                'BUILDING_CLASSIFICATION_CONFLICT'
            );
        }
        return review(
            'REQUIRED_OTHER_PURPOSE_SIGNAL_MISSING',
            'BUILDING_CLASSIFICATION_CONFLICT'
        );
    }
```

(g) 파일 상단 docblock의 핵심 계약 목록에 한 줄을 추가한다.

```
 *  - `02000 공동주택` pair는 부속용도 토큰이 없을 때만 법정 규모 기준(지상 층수·연면적)으로
 *    다세대주택으로 인정한다. 규모 값 누락·파싱 실패는 REVIEW다 (DESIGN §9.2).
```

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && node --import tsx --test tests/land-area-sync-classifier.test.ts
```
Expected: PASS (0 fail).

- [ ] **Step 7: 분류 입력을 조립하는 두 호출부에 규모 필드를 넘긴다**

`src/services/land-area-sync/scope.ts:301-310`의 `classifyHousingType` 호출을 다음으로 바꾼다.
(이 task에서는 `titleRows`·`rootIdentities` 축은 그대로 두고 필드만 추가한다. partition은 Task 2다.)

```ts
    const classification = classifyHousingType({
        titleRows: titleRows.map((r) => ({
            regstrGbCd: r.regstrGbCd,
            mainPurpsCd: r.mainPurpsCd,
            mainPurpsCdNm: r.mainPurpsCdNm,
            etcPurps:
                typeof r.etcPurps === 'string' ? r.etcPurps : undefined,
            grndFlrCnt: r.grndFlrCnt,
            totArea: r.totArea,
        })),
        rootIdentities: dbScope.rootBuildingIdentities,
    });
```

`src/verification/land-area-phase0-capture.ts:2155-2166`의 `classifyHousingType` 호출도 같은 계약으로
맞춘다. 두 경로가 다른 입력으로 같은 분류기를 부르면 조용히 갈라진다.

```ts
    const classification = classifyHousingType({
        titleRows: titleRows.map((row) => ({
            regstrGbCd: row.regstrGbCd,
            mainPurpsCd: row.mainPurpsCd,
            mainPurpsCdNm: row.mainPurpsCdNm,
            etcPurps:
                typeof row.etcPurps === 'string'
                    ? row.etcPurps
                    : undefined,
            grndFlrCnt: row.grndFlrCnt,
            totArea: row.totArea,
        })),
        rootIdentities,
    });
```

> `buildExternalScopeDigest`의 `titleIdentity`에는 **규모 두 필드를 추가하지 않는다.** 추가하면
> `EXTERNAL_SCOPE_DIGEST_VERSION`을 올려야 하고 모든 anchor의 `scopeHash`가 이동한다
> (Global Constraints). 규모 값의 digest 편입은 별도 개정 사안이다.

- [ ] **Step 8: 전체 테스트 + 타입 체크**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && npx tsc --noEmit && npm test
```
Expected: 타입 오류 0, 테스트 전건 PASS. `tests/land-area-phase0-capture.test.ts`의
"input@2 expectedFamily=LDAREG는 exact 집합/02000/공동주택 + 무신호 title을 Phase 0에서만 인정한다"가
계속 통과해야 한다 — 그 경로는 `hasPhase0GenericLdaregTitleEvidence`가 담당하고 규모 값이 없으므로
분류기 쪽 판정은 여전히 REVIEW이고 Phase 0 전용 보강 증거로만 LDAREG가 된다. 동작 불변이다.

- [ ] **Step 9: 커밋**

```bash
cd /Users/inju/workspace/tonghari/tonghari-api && git add src/types/land-area-sync.types.ts src/services/land-area-sync/housing-purpose-allowlist.fixture.ts src/services/land-area-sync/classifier.ts src/services/land-area-sync/scope.ts src/verification/land-area-phase0-capture.ts tests/land-area-sync-classifier.test.ts && git commit -m "feat(land-area): 02000 공동주택 pair 를 법정 규모 기준으로 분류"
```

---

## Task 2: 선택된 대지권 대상 root로 분류 입력 partition

**Files:**
- Modify: `src/services/land-area-sync/scope.ts` (`ParcelScopeInput`, `ParcelScopeResult`, `resolveParcelScopeCompleteness`)
- Test: `tests/land-area-sync-scope.test.ts`

**Interfaces:**
- Consumes: Task 1의 `HousingClassifierInput.grndFlrCnt` · `totArea`
- Produces:
  - `ParcelScopeInput.landRightRootIdentity?: string | null`
  - `ParcelScopeResult.landRightRootIdentity: string | null`
  - `ParcelScopeResult.excludedLandRightRootIdentities: string[]`
  - module-private `partitionTitleRowsByLandRightRoot(titleRows, landRightRootIdentity)`

---

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/land-area-sync-scope.test.ts` 맨 아래에 추가한다. 기존 파일의 helper 이름·형태를 먼저 읽고
맞춘다. 여기서는 자립적으로 fixture를 만든다.

```ts
// ── §9.1 개정: 선택된 대지권 대상 root 기준 분류 partition ──────────────

const GENERAL_ROOT = '1010111086';
const AGGREGATE_ROOT = '1010114204';
const MIA_ANCHOR = '1130510300107912282';

function completeScan<T>(rows: T[]) {
    return {
        state: 'COMPLETE' as const,
        rows,
        totalCount: rows.length,
        pagesFetched: 1,
    };
}

function zeroScan() {
    return {
        state: 'COMPLETE_ZERO' as const,
        rows: [] as never[],
        totalCount: 0 as const,
        pagesFetched: 1,
    };
}

/** 미아7 791-2282 실측 형상: 일반건축물 1행 + 집합건물 1행, 부속지번 0. */
function multiRootBaseScans() {
    return [
        {
            pnu: MIA_ANCHOR,
            title: completeScan([
                {
                    mgmBldrgstPk: GENERAL_ROOT,
                    bylotCnt: '0',
                    regstrGbCd: '1',
                    mainPurpsCd: '01000',
                    mainPurpsCdNm: '단독주택',
                    etcPurps: '단독주택',
                    grndFlrCnt: '1',
                    totArea: '88.8',
                },
                {
                    mgmBldrgstPk: AGGREGATE_ROOT,
                    bylotCnt: '0',
                    regstrGbCd: '2',
                    mainPurpsCd: '02000',
                    mainPurpsCdNm: '공동주택',
                    etcPurps: '공동주택',
                    grndFlrCnt: '4',
                    totArea: '513.06',
                },
            ]),
            attached: zeroScan(),
        },
    ];
}

function multiRootDbScope() {
    return parseDbScopeResolution({
        dbState: 'LINKED',
        rootBuildingIdentities: [GENERAL_ROOT, AGGREGATE_ROOT],
        componentPnus: [MIA_ANCHOR],
        linkedBasePnus: [MIA_ANCHOR],
        linkedPnus: [MIA_ANCHOR],
        linkedEvidenceKeys: [],
        pendingEvidenceKeys: [],
        blockingEvidence: [],
        openUnresolvedEvidenceKeys: [],
        componentTruncated: false,
        propertyMembership: [],
        dbScopeHash: 'db-scope-hash',
    });
}

test('선택 root 없으면 복수 root는 기존대로 REVIEW_REQUIRED다', () => {
    const res = resolveParcelScopeCompleteness({
        dbScope: multiRootDbScope(),
        baseScans: multiRootBaseScans() as never,
        policy: 'TITLE_ONLY',
    });
    assert.equal(res.state, 'REVIEW_REQUIRED');
    assert.ok(res.issues.includes('BUILDING_CLASSIFICATION_CONFLICT'));
    assert.equal(res.classification.kind, 'REVIEW_REQUIRED');
    assert.equal(
        res.classification.kind === 'REVIEW_REQUIRED' &&
            res.classification.reason,
        'MULTIPLE_ROOT_IDENTITIES'
    );
    assert.equal(res.landRightRootIdentity, null);
    assert.deepEqual(res.excludedLandRightRootIdentities, []);
});

test('선택 root를 주면 그 root의 표제부 행만으로 분류하고 나머지는 제외 기록한다', () => {
    const res = resolveParcelScopeCompleteness({
        dbScope: multiRootDbScope(),
        baseScans: multiRootBaseScans() as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.equal(res.classification.kind, 'CLASSIFIED');
    assert.equal(
        res.classification.kind === 'CLASSIFIED' &&
            res.classification.family,
        'LDAREG'
    );
    assert.equal(res.landRightRootIdentity, AGGREGATE_ROOT);
    assert.deepEqual(res.excludedLandRightRootIdentities, [GENERAL_ROOT]);
    assert.equal(res.state, 'LINKED_SCOPE_RESOLVED');
    assert.deepEqual(res.issues, []);
});

test('선택 root partition은 bylot·attached 축을 좁히지 않는다 — expectedPks는 전체 root', () => {
    const res = resolveParcelScopeCompleteness({
        dbScope: multiRootDbScope(),
        baseScans: multiRootBaseScans() as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.deepEqual(res.expectedPks, [GENERAL_ROOT, AGGREGATE_ROOT].sort());
    assert.equal(res.bylot.evidence.length, 2);
});

test('선택 root가 표제부에 없으면 partition하지 않고 복수 root REVIEW를 유지한다', () => {
    const res = resolveParcelScopeCompleteness({
        dbScope: multiRootDbScope(),
        baseScans: multiRootBaseScans() as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: '9999999999',
    });
    assert.equal(res.state, 'REVIEW_REQUIRED');
    assert.equal(
        res.classification.kind === 'REVIEW_REQUIRED' &&
            res.classification.reason,
        'MULTIPLE_ROOT_IDENTITIES'
    );
    assert.equal(res.landRightRootIdentity, null);
});

test('선택 root가 상위 up-PK를 가진 child면 root로 인정하지 않는다', () => {
    const scans = multiRootBaseScans();
    scans[0].title.rows[1] = {
        ...scans[0].title.rows[1],
        mgmUpBldrgstPk: '1010119999',
    } as never;
    const res = resolveParcelScopeCompleteness({
        dbScope: multiRootDbScope(),
        baseScans: scans as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.equal(res.state, 'REVIEW_REQUIRED');
    assert.equal(res.landRightRootIdentity, null);
});

test('단일 root anchor에 선택 root를 주면 partition 없이 기존 경로를 유지한다', () => {
    const scans = multiRootBaseScans();
    scans[0].title.rows = [scans[0].title.rows[1]] as never;
    const res = resolveParcelScopeCompleteness({
        dbScope: parseDbScopeResolution({
            ...multiRootDbScope(),
            rootBuildingIdentities: [AGGREGATE_ROOT],
        }),
        baseScans: scans as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.equal(res.classification.kind, 'CLASSIFIED');
    assert.equal(res.landRightRootIdentity, null);
    assert.deepEqual(res.excludedLandRightRootIdentities, []);
});
```

파일 상단 import에 `parseDbScopeResolution`이 없으면 추가한다.

- [ ] **Step 2: 실패를 확인한다**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && node --import tsx --test tests/land-area-sync-scope.test.ts
```
Expected: FAIL. `landRightRootIdentity` 프로퍼티가 `ParcelScopeInput`·`ParcelScopeResult`에 없어
타입 오류 또는 `undefined` 비교 실패가 난다.

- [ ] **Step 3: `ParcelScopeInput`·`ParcelScopeResult`를 확장한다**

`src/services/land-area-sync/scope.ts`에서

```ts
export interface ParcelScopeInput {
    dbScope: DbScopeResolution;
    baseScans: BasePnuScan[];
    policy: BylotSourcePolicy;
}
```

를 다음으로 바꾼다.

```ts
export interface ParcelScopeInput {
    dbScope: DbScopeResolution;
    baseScans: BasePnuScan[];
    policy: BylotSourcePolicy;
    /**
     * 표제부 root가 여럿일 때 LDAREG 행 근거로 선출된 대지권 대상 root (DESIGN §9.1).
     *
     * null/미지정이면 기존 단일 root 계약 그대로다. 설정하면 **분류 축과 단일성 판정 축만**
     * 이 root의 표제부 행으로 좁힌다. bylot·attached·BASIS/EXPOS closure 축은 전체 root를
     * 그대로 쓴다 — 제외된 동의 부속지번·기본개요가 판정 밖으로 떨어지면 안 된다.
     */
    landRightRootIdentity?: string | null;
}
```

`ParcelScopeResult`에 두 필드를 추가한다.

```ts
export interface ParcelScopeResult {
    state: ParcelScopeState;
    /** §14.3 issue code, 정렬·중복 제거 */
    issues: LandAreaSyncIssueCode[];
    expectedPks: string[];
    bylot: BylotResolution;
    classification: HousingClassification;
    /** 정렬된 distinct base PNU */
    scannedPnus: string[];
    dbScopeHash: string;
    externalScopeDigest: string;
    /**
     * 실제로 적용된 대지권 대상 root. partition이 성립하지 않으면 null이다.
     * digest에 참여하지 않는 진단용 값이다.
     */
    landRightRootIdentity: string | null;
    /** `대지권 무관 동`으로 제외한 root(정렬). partition 미성립이면 빈 배열. */
    excludedLandRightRootIdentities: string[];
}
```

- [ ] **Step 4: partition helper를 추가한다**

`hasInvalidOptionalUpPk` 함수 바로 아래에 넣는다.

```ts
interface LandRightRootPartition {
    selectedRootIdentity: string;
    /** 선택 root에 귀속된 표제부 행만. */
    selectedTitleRows: BrTitleRow[];
    /** 대지권 대상에서 제외한 root(정렬). */
    excludedRootIdentities: string[];
}

/**
 * 표제부 행을 선택된 대지권 대상 root 기준으로 나눈다 (DESIGN §9.1 개정).
 *
 * partition 축은 LDAREG root 축과 같은 exact `mgmBldrgstPk` self다. resolver의
 * up-preferred 축과 섞지 않는다.
 *
 * null을 반환하는 경우(= partition 미성립, 기존 계약 그대로 진행):
 *  - 선택 root가 없거나 정규화되지 않는다
 *  - 표제부에 invalid PK 행이 있다
 *  - 선택 root 귀속 행이 0건이다
 *  - 선택 root 귀속 행에 자기 자신이 아닌 상위 up-PK가 있다(= 실제 root가 아니다)
 *  - 제외할 다른 root가 없다(= 단일 root라 partition이 무의미하다)
 */
function partitionTitleRowsByLandRightRoot(
    titleRows: BrTitleRow[],
    landRightRootIdentity: string | null | undefined
): LandRightRootPartition | null {
    const selected = normalizeRegistryManagementPk(
        landRightRootIdentity ?? ''
    );
    if (selected === null) return null;
    const selectedTitleRows: BrTitleRow[] = [];
    const excluded = new Set<string>();
    for (const row of titleRows) {
        const self = normalizeRegistryManagementPk(row.mgmBldrgstPk);
        if (self === null) return null;
        if (self !== selected) {
            excluded.add(self);
            continue;
        }
        const up = normalizeRegistryManagementPk(row.mgmUpBldrgstPk);
        if (up !== null && up !== selected) return null;
        selectedTitleRows.push(row);
    }
    if (selectedTitleRows.length === 0 || excluded.size === 0) return null;
    return {
        selectedRootIdentity: selected,
        selectedTitleRows,
        excludedRootIdentities: [...excluded].sort(),
    };
}
```

- [ ] **Step 5: gate가 partition을 쓰게 한다**

`resolveParcelScopeCompleteness` 안에서 Task 1이 만든 `classifyHousingType` 호출을 다음으로 바꾼다.

```ts
    // 표제부 root가 여럿이면 선출된 대지권 대상 root의 행만 분류 입력으로 쓴다 (DESIGN §9.1).
    // closure·bylot·attached 축은 위에서 이미 전체 root로 계산돼 있고 그대로 둔다.
    const landRightPartition = partitionTitleRowsByLandRightRoot(
        titleRows,
        input.landRightRootIdentity
    );
    const classificationTitleRows =
        landRightPartition?.selectedTitleRows ?? titleRows;
    const classification = classifyHousingType({
        titleRows: classificationTitleRows.map((r) => ({
            regstrGbCd: r.regstrGbCd,
            mainPurpsCd: r.mainPurpsCd,
            mainPurpsCdNm: r.mainPurpsCdNm,
            etcPurps:
                typeof r.etcPurps === 'string' ? r.etcPurps : undefined,
            grndFlrCnt: r.grndFlrCnt,
            totArea: r.totArea,
        })),
        rootIdentities: landRightPartition
            ? [landRightPartition.selectedRootIdentity]
            : dbScope.rootBuildingIdentities,
    });
```

`finalize`에 두 필드를 채운다.

```ts
    const finalize = (state: ParcelScopeState, issues: LandAreaSyncIssueCode[]): ParcelScopeResult => ({
        state,
        issues: sortedDedup(issues),
        expectedPks: bylot.expectedPks,
        bylot,
        classification,
        scannedPnus,
        dbScopeHash: dbScope.dbScopeHash,
        externalScopeDigest,
        landRightRootIdentity:
            landRightPartition?.selectedRootIdentity ?? null,
        excludedLandRightRootIdentities:
            landRightPartition?.excludedRootIdentities ?? [],
    });
```

파일 상단 docblock에 한 줄 추가한다.

```
 *  - 표제부 root가 여럿이면 선출된 대지권 대상 root의 표제부 행만 분류·단일성 판정에 쓴다.
 *    bylot·attached·closure 축은 전체 root를 유지한다 (DESIGN §9.1).
```

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && node --import tsx --test tests/land-area-sync-scope.test.ts
```
Expected: PASS.

- [ ] **Step 7: 전체 테스트 + 타입 체크**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && npx tsc --noEmit && npm test
```
Expected: 전건 PASS. `ParcelScopeResult`에 필드가 늘었을 뿐이라 기존 소비자는 영향받지 않는다.

- [ ] **Step 8: 커밋**

```bash
cd /Users/inju/workspace/tonghari/tonghari-api && git add src/services/land-area-sync/scope.ts tests/land-area-sync-scope.test.ts && git commit -m "feat(land-area): 분류 입력을 선택된 대지권 대상 root 로 partition"
```

---

## Task 3: LDAREG 행 근거 기반 root 선출 순수 함수

**Files:**
- Modify: `src/services/land-area-sync/ldareg-branch.ts` (신규 export)
- Test: `tests/land-area-sync-ldareg-branch.test.ts`

**Interfaces:**
- Consumes: 없음 (순수 함수)
- Produces:
  ```ts
  export type LandRightRootElectionReason =
      | 'ELECTION_SCAN_INCOMPLETE'
      | 'BASIS_CLOSURE_UNRESOLVED'
      | 'EXPOS_ROOT_UNRESOLVED'
      | 'LDAREG_UNIT_ROOT_AMBIGUOUS'
      | 'EVIDENCE_ROOT_NOT_UNIQUE'
      | 'SELECTED_ROOT_NOT_TITLE_ROOT';

  export type LandRightRootElection =
      | { kind: 'NOT_REQUIRED'; rootIdentities: string[] }
      | { kind: 'ELECTED'; selectedRootIdentity: string;
          excludedRootIdentities: string[]; rootIdentities: string[];
          evidenceUnitCount: number }
      | { kind: 'INDETERMINATE'; reason: LandRightRootElectionReason;
          rootIdentities: string[] };

  export function electLandRightRootIdentity(input: {
      titleRootIdentities: readonly string[];
      titleRows: readonly BrTitleRow[];
      perPnu: readonly LdaregPnuScan[];
  }): LandRightRootElection;
  ```

---

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/land-area-sync-ldareg-branch.test.ts` 맨 아래에 추가한다. 파일 상단 import에
`electLandRightRootIdentity`를 추가한다.

```ts
// ── §9.1/§10.4 개정: LDAREG 행 근거 기반 대지권 대상 root 선출 ──────────

const ELECT_GENERAL_ROOT = '1010111086';
const ELECT_AGGREGATE_ROOT = '1010114204';
const ELECT_PNU = '1130510300107912282';

/** 집합 root 10호 + 일반 root 1동. 미아7 791-2282 실측 형상. */
function electionFixture() {
    const hos = ['101', '102', '201', '202', '301', '302', '401', '402', '103', '203'];
    return {
        titleRows: [
            { mgmBldrgstPk: ELECT_GENERAL_ROOT, regstrGbCd: '1' },
            { mgmBldrgstPk: ELECT_AGGREGATE_ROOT, regstrGbCd: '2' },
        ],
        perPnu: [
            {
                pnu: ELECT_PNU,
                // 전유 10행 + placeholder 1행 = 실측 11행
                ldaregRows: [
                    ...hos.map((ho, index) => ({
                        pnu: ELECT_PNU,
                        agbldgSn: '1',
                        buldNm: '광미빌라',
                        buldDongNm: '0',
                        buldFloorNm: String(Math.floor(index / 2) + 1),
                        buldHoNm: ho,
                        buldRoomNm: '0',
                        ldaQotaRate: '27.8/264',
                        clsSeCode: '1',
                        clsSeCodeNm: '현재',
                    })),
                    {
                        pnu: ELECT_PNU,
                        buldDongNm: '0',
                        buldFloorNm: '0',
                        buldHoNm: '0',
                        buldRoomNm: '0',
                        ldaQotaRate: '',
                        clsSeCode: '1',
                        clsSeCodeNm: '현재',
                    },
                ],
                exposRows: hos.map((ho, index) => ({
                    mgmBldrgstPk: `${ELECT_AGGREGATE_ROOT}${index}`,
                    mgmUpBldrgstPk: ELECT_AGGREGATE_ROOT,
                    flrNoNm: String(Math.floor(index / 2) + 1),
                    hoNm: ho,
                })),
                basisRows: [
                    { mgmBldrgstPk: ELECT_GENERAL_ROOT },
                    { mgmBldrgstPk: ELECT_AGGREGATE_ROOT },
                    ...hos.map((_, index) => ({
                        mgmBldrgstPk: `${ELECT_AGGREGATE_ROOT}${index}`,
                        mgmUpBldrgstPk: ELECT_AGGREGATE_ROOT,
                    })),
                ],
            },
        ],
    };
}

test('단일 root면 선출을 요구하지 않는다', () => {
    const fx = electionFixture();
    const res = electLandRightRootIdentity({
        titleRootIdentities: [ELECT_AGGREGATE_ROOT],
        titleRows: fx.titleRows as never,
        perPnu: fx.perPnu as never,
    });
    assert.equal(res.kind, 'NOT_REQUIRED');
    assert.deepEqual(res.rootIdentities, [ELECT_AGGREGATE_ROOT]);
});

test('복수 root에서 LDAREG 행 근거를 가진 root가 정확히 하나면 선출한다', () => {
    const fx = electionFixture();
    const res = electLandRightRootIdentity({
        titleRootIdentities: [ELECT_GENERAL_ROOT, ELECT_AGGREGATE_ROOT],
        titleRows: fx.titleRows as never,
        perPnu: fx.perPnu as never,
    });
    assert.equal(res.kind, 'ELECTED');
    assert.equal(
        res.kind === 'ELECTED' && res.selectedRootIdentity,
        ELECT_AGGREGATE_ROOT
    );
    assert.deepEqual(
        res.kind === 'ELECTED' && res.excludedRootIdentities,
        [ELECT_GENERAL_ROOT]
    );
    // placeholder 1행은 근거로 세지 않는다.
    assert.equal(res.kind === 'ELECTED' && res.evidenceUnitCount, 10);
});

test('LDAREG 행이 전혀 매칭되지 않으면 선출하지 않는다', () => {
    const fx = electionFixture();
    fx.perPnu[0].ldaregRows = fx.perPnu[0].ldaregRows.map((row) => ({
        ...row,
        buldHoNm: '999',
    }));
    const res = electLandRightRootIdentity({
        titleRootIdentities: [ELECT_GENERAL_ROOT, ELECT_AGGREGATE_ROOT],
        titleRows: fx.titleRows as never,
        perPnu: fx.perPnu as never,
    });
    assert.equal(res.kind, 'INDETERMINATE');
    assert.equal(
        res.kind === 'INDETERMINATE' && res.reason,
        'EVIDENCE_ROOT_NOT_UNIQUE'
    );
});

test('두 root 모두 LDAREG 근거를 가지면 선출하지 않는다', () => {
    const fx = electionFixture();
    // 일반 root 밑에 전유 호실을 하나 붙이고 그 호실에 대응하는 LDAREG 행을 추가한다.
    fx.perPnu[0].basisRows.push({
        mgmBldrgstPk: `${ELECT_GENERAL_ROOT}0`,
        mgmUpBldrgstPk: ELECT_GENERAL_ROOT,
    } as never);
    fx.perPnu[0].exposRows.push({
        mgmBldrgstPk: `${ELECT_GENERAL_ROOT}0`,
        mgmUpBldrgstPk: ELECT_GENERAL_ROOT,
        flrNoNm: '9',
        hoNm: '901',
    } as never);
    fx.perPnu[0].ldaregRows.push({
        pnu: ELECT_PNU,
        agbldgSn: '2',
        buldNm: '별동',
        buldDongNm: '0',
        buldFloorNm: '9',
        buldHoNm: '901',
        buldRoomNm: '0',
        ldaQotaRate: '10/264',
        clsSeCode: '1',
        clsSeCodeNm: '현재',
    } as never);
    const res = electLandRightRootIdentity({
        titleRootIdentities: [ELECT_GENERAL_ROOT, ELECT_AGGREGATE_ROOT],
        titleRows: fx.titleRows as never,
        perPnu: fx.perPnu as never,
    });
    assert.equal(res.kind, 'INDETERMINATE');
    assert.equal(
        res.kind === 'INDETERMINATE' && res.reason,
        'EVIDENCE_ROOT_NOT_UNIQUE'
    );
});

test('한 LDAREG 행이 서로 다른 root의 호실에 동시 매칭되면 선출하지 않는다', () => {
    const fx = electionFixture();
    fx.perPnu[0].basisRows.push({
        mgmBldrgstPk: `${ELECT_GENERAL_ROOT}0`,
        mgmUpBldrgstPk: ELECT_GENERAL_ROOT,
    } as never);
    // 집합 root 101호와 같은 층·호를 일반 root 밑에도 만든다.
    fx.perPnu[0].exposRows.push({
        mgmBldrgstPk: `${ELECT_GENERAL_ROOT}0`,
        mgmUpBldrgstPk: ELECT_GENERAL_ROOT,
        flrNoNm: '1',
        hoNm: '101',
    } as never);
    const res = electLandRightRootIdentity({
        titleRootIdentities: [ELECT_GENERAL_ROOT, ELECT_AGGREGATE_ROOT],
        titleRows: fx.titleRows as never,
        perPnu: fx.perPnu as never,
    });
    assert.equal(res.kind, 'INDETERMINATE');
    assert.equal(
        res.kind === 'INDETERMINATE' && res.reason,
        'LDAREG_UNIT_ROOT_AMBIGUOUS'
    );
});

test('BASIS closure가 전체 root로 닫히지 않으면 선출하지 않는다', () => {
    const fx = electionFixture();
    fx.perPnu[0].basisRows = fx.perPnu[0].basisRows.filter(
        (row) => (row as { mgmBldrgstPk: string }).mgmBldrgstPk !== ELECT_GENERAL_ROOT
    );
    fx.perPnu[0].basisRows.push({
        mgmBldrgstPk: ELECT_GENERAL_ROOT,
        mgmUpBldrgstPk: '9999999999',
    } as never);
    const res = electLandRightRootIdentity({
        titleRootIdentities: [ELECT_GENERAL_ROOT, ELECT_AGGREGATE_ROOT],
        titleRows: fx.titleRows as never,
        perPnu: fx.perPnu as never,
    });
    assert.equal(res.kind, 'INDETERMINATE');
    assert.equal(
        res.kind === 'INDETERMINATE' && res.reason,
        'BASIS_CLOSURE_UNRESOLVED'
    );
});

test('선출된 root가 상위 up-PK를 가진 child면 선출하지 않는다', () => {
    const fx = electionFixture();
    fx.titleRows[1] = {
        mgmBldrgstPk: ELECT_AGGREGATE_ROOT,
        mgmUpBldrgstPk: '1010119999',
        regstrGbCd: '2',
    } as never;
    const res = electLandRightRootIdentity({
        titleRootIdentities: [ELECT_GENERAL_ROOT, ELECT_AGGREGATE_ROOT],
        titleRows: fx.titleRows as never,
        perPnu: fx.perPnu as never,
    });
    assert.equal(res.kind, 'INDETERMINATE');
    assert.equal(
        res.kind === 'INDETERMINATE' && res.reason,
        'SELECTED_ROOT_NOT_TITLE_ROOT'
    );
});

test('선출은 행 수·비율값·건물명으로 추정하지 않는다 — 비율/건물명이 달라도 결과가 같다', () => {
    const fx = electionFixture();
    fx.perPnu[0].ldaregRows = fx.perPnu[0].ldaregRows.map((row, index) => ({
        ...row,
        ldaQotaRate: index % 2 === 0 ? '28.3/264' : '27.8/264',
        buldNm: `이름${index}`,
    }));
    const res = electLandRightRootIdentity({
        titleRootIdentities: [ELECT_GENERAL_ROOT, ELECT_AGGREGATE_ROOT],
        titleRows: fx.titleRows as never,
        perPnu: fx.perPnu as never,
    });
    assert.equal(res.kind, 'ELECTED');
    assert.equal(
        res.kind === 'ELECTED' && res.selectedRootIdentity,
        ELECT_AGGREGATE_ROOT
    );
});
```

- [ ] **Step 2: 실패를 확인한다**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && node --import tsx --test tests/land-area-sync-ldareg-branch.test.ts
```
Expected: FAIL — `electLandRightRootIdentity` 가 export되지 않아 import 오류.

- [ ] **Step 3: 선출 함수를 구현한다**

`src/services/land-area-sync/ldareg-branch.ts`를 편집한다.

(a) import에 `normalizeRegistryManagementPk`와 `BrTitleRow`를 추가한다.

```ts
import type {
    LdaregRow,
    BrExposRow,
    BrBasisOulnRow,
    BrTitleRow,
    LandAreaSyncIssueCode,
} from '../../types/land-area-sync.types';
```
```ts
import { normalizeRegistryManagementPk } from './registry-pk';
```

(b) `selectCanonicalExposSourcePnu` 함수 **바로 위**에 선출 로직을 넣는다.
(`dongFloorHoKey` · `normalizeLdaregDong` · `isObservedNonApplicablePlaceholder` ·
`toExposCandidate` · `buildScopeBasisRootIndex`가 모두 이 모듈 안에 있어야 재구현 없이 쓴다.
`dongFloorHoKey`는 파일 뒤쪽에 선언돼 있지만 함수 선언 hoisting으로 문제없다.)

```ts
export type LandRightRootElectionReason =
    /** 선출용 same-run scan이 COMPLETE/COMPLETE_ZERO가 아니었다(호출측이 판정). */
    | 'ELECTION_SCAN_INCOMPLETE'
    | 'BASIS_CLOSURE_UNRESOLVED'
    | 'EXPOS_ROOT_UNRESOLVED'
    | 'LDAREG_UNIT_ROOT_AMBIGUOUS'
    | 'EVIDENCE_ROOT_NOT_UNIQUE'
    | 'SELECTED_ROOT_NOT_TITLE_ROOT';

export type LandRightRootElection =
    | { kind: 'NOT_REQUIRED'; rootIdentities: string[] }
    | {
          kind: 'ELECTED';
          selectedRootIdentity: string;
          excludedRootIdentities: string[];
          rootIdentities: string[];
          /** 근거로 인정된 LDAREG 행 수(placeholder 제외). 진단용. */
          evidenceUnitCount: number;
      }
    | {
          kind: 'INDETERMINATE';
          reason: LandRightRootElectionReason;
          rootIdentities: string[];
      };

/**
 * 표제부 root가 여럿일 때 대지권등록부 행 근거를 가진 root를 선출한다 (DESIGN §9.1·§10.4 개정).
 *
 * 대지권은 집합건물 전유부에 딸린 권리다. 일반건축물 소유자는 토지를 직접 소유하므로
 * 대지권등록부에 지분 행을 갖지 않는다. 그래서 "LDAREG 행이 EXPOS 전유부와 exact 대응하는
 * root"가 대지권 대상이다.
 *
 * 근거 판정은 **같은 실행의 LDAREG 응답과 EXPOS 전유부의 root 귀속으로만** 한다.
 * 행 수·비율값·건물명 유사도로 추정하지 않는다.
 *
 * BASIS/EXPOS closure는 **전체 root 집합**을 accepted root로 삼는다. 제외될 동의 기본개요
 * 행이 closure 밖으로 떨어져 전체가 차단되는 것을 막기 위해서다.
 *
 * 어떤 이유로든 확정되지 않으면 `INDETERMINATE`다. 호출측은 이 경우 기존 복수 root
 * REVIEW 경로를 그대로 유지해야 한다 — 새 FAILED terminal을 만들지 않는다.
 */
export function electLandRightRootIdentity(input: {
    titleRootIdentities: readonly string[];
    titleRows: readonly BrTitleRow[];
    perPnu: readonly LdaregPnuScan[];
}): LandRightRootElection {
    const rootIdentities = [
        ...new Set(
            input.titleRootIdentities
                .map((value) => normalizeRegistryManagementPk(value))
                .filter((value): value is string => value !== null)
        ),
    ].sort();
    if (rootIdentities.length <= 1) {
        return { kind: 'NOT_REQUIRED', rootIdentities };
    }
    const indeterminate = (
        reason: LandRightRootElectionReason
    ): LandRightRootElection => ({
        kind: 'INDETERMINATE',
        reason,
        rootIdentities,
    });

    // 1) closure는 전체 root 집합으로 닫는다.
    const basisRootIndex = buildScopeBasisRootIndex(
        [...input.perPnu],
        rootIdentities
    );
    if (basisRootIndex === null) {
        return indeterminate('BASIS_CLOSURE_UNRESOLVED');
    }

    // 2) EXPOS 호실 identity → 그 호실이 귀속된 root 집합.
    const rootsByUnitKey = new Map<string, Set<string>>();
    for (const scan of input.perPnu) {
        for (const row of scan.exposRows) {
            const candidate = toExposCandidate(row, basisRootIndex);
            if (
                !candidate ||
                !candidate.selfIdentity ||
                !candidate.rootIdentitySource
            ) {
                return indeterminate('EXPOS_ROOT_UNRESOLVED');
            }
            const key = dongFloorHoKey(candidate);
            const roots = rootsByUnitKey.get(key) ?? new Set<string>();
            roots.add(candidate.rootIdentity);
            rootsByUnitKey.set(key, roots);
        }
    }

    // 3) LDAREG 행마다 exact 동·층·호로 root 근거를 모은다.
    const evidenceRoots = new Set<string>();
    let evidenceUnitCount = 0;
    for (const scan of input.perPnu) {
        for (const row of scan.ldaregRows) {
            if (isObservedNonApplicablePlaceholder(row)) continue;
            const raw = row as Record<string, unknown>;
            const key = dongFloorHoKey({
                dong: normalizeLdaregDong(raw.buldDongNm),
                floor:
                    normalizeFloorLabel(str(raw.buldFloorNm)) || null,
                ho: str(raw.buldHoNm) || null,
            });
            const matchedRoots = rootsByUnitKey.get(key);
            // 대응 호실이 없으면 근거를 만들지 않는다. 추정하지 않고 그냥 넘긴다.
            if (matchedRoots === undefined) continue;
            if (matchedRoots.size !== 1) {
                return indeterminate('LDAREG_UNIT_ROOT_AMBIGUOUS');
            }
            evidenceRoots.add([...matchedRoots][0]);
            evidenceUnitCount += 1;
        }
    }
    if (evidenceRoots.size !== 1) {
        return indeterminate('EVIDENCE_ROOT_NOT_UNIQUE');
    }
    const selectedRootIdentity = [...evidenceRoots][0];

    // 4) 선출된 root가 실제 표제부 root인지 확인한다(child 선택 금지).
    const selectedTitleRows = input.titleRows.filter(
        (row) =>
            normalizeRegistryManagementPk(row.mgmBldrgstPk) ===
            selectedRootIdentity
    );
    if (
        selectedTitleRows.length === 0 ||
        selectedTitleRows.some((row) => {
            const up = normalizeRegistryManagementPk(
                row.mgmUpBldrgstPk
            );
            return up !== null && up !== selectedRootIdentity;
        })
    ) {
        return indeterminate('SELECTED_ROOT_NOT_TITLE_ROOT');
    }

    return {
        kind: 'ELECTED',
        selectedRootIdentity,
        excludedRootIdentities: rootIdentities.filter(
            (root) => root !== selectedRootIdentity
        ),
        rootIdentities,
        evidenceUnitCount,
    };
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && node --import tsx --test tests/land-area-sync-ldareg-branch.test.ts
```
Expected: PASS.

- [ ] **Step 5: 전체 테스트 + 타입 체크**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && npx tsc --noEmit && npm test
```
Expected: 전건 PASS (순수 신규 export라 기존 동작 불변).

- [ ] **Step 6: 커밋**

```bash
cd /Users/inju/workspace/tonghari/tonghari-api && git add src/services/land-area-sync/ldareg-branch.ts tests/land-area-sync-ldareg-branch.test.ts && git commit -m "feat(land-area): LDAREG 행 근거로 대지권 대상 root 를 선출한다"
```

---

## Task 4: closure root 축을 선택 root와 분리

**Files:**
- Modify: `src/services/land-area-sync/ldareg-branch.ts` (`LdaregBranchInput`, `assembleLdaregApply:1251`)
- Modify: `src/services/land-area-sync/expos-root.ts` (주석만)
- Modify: `src/services/land-area-sync/matcher.ts:334-336` (주석만)
- Test: `tests/land-area-sync-ldareg-branch.test.ts`

**Interfaces:**
- Consumes: Task 3의 `LandRightRootElection.rootIdentities`
- Produces: `LdaregBranchInput.closureRootIdentities?: string[]`
  (생략 시 `[rootIdentity]`로 취급 — 기존 단일 root 동작 유지)

---

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/land-area-sync-ldareg-branch.test.ts`에 추가한다. `assembleLdaregApply` 호출 형태는
같은 파일의 기존 테스트를 그대로 참고해 맞춘다(입력 필드가 많다). 여기서는 **closure 축이
전체 root로 열리는지**만 검증한다.

```ts
test('closureRootIdentities를 주면 제외된 root의 기본개요 행이 closure를 막지 않는다', () => {
    const fx = electionFixture();
    const result = assembleLdaregApply({
        unionId: 'u1',
        scannedPnus: [ELECT_PNU],
        rootIdentity: ELECT_AGGREGATE_ROOT,
        closureRootIdentities: [
            ELECT_GENERAL_ROOT,
            ELECT_AGGREGATE_ROOT,
        ],
        perPnu: fx.perPnu as never,
        scopeLadfrlAreas: [{ pnu: ELECT_PNU, area: '264' }] as never,
        scopeLadfrlTotal: '264',
        canonicalSourcePnu: ELECT_PNU,
        buildingUnits: [],
        propertyUnits: [],
    });
    // 물건지 후보가 없어 apply item은 0이지만, closure 자체는 열려야 한다.
    // closure가 막히면 LDAREG_IDENTITY_CONFLICT 하나로 즉시 닫히고 replicationEvidence가 null이다.
    assert.notEqual(result.replicationEvidence, null);
});

test('closureRootIdentities가 없으면 제외 root 기본개요 행에 막혀 기존대로 닫힌다', () => {
    const fx = electionFixture();
    const result = assembleLdaregApply({
        unionId: 'u1',
        scannedPnus: [ELECT_PNU],
        rootIdentity: ELECT_AGGREGATE_ROOT,
        perPnu: fx.perPnu as never,
        scopeLadfrlAreas: [{ pnu: ELECT_PNU, area: '264' }] as never,
        scopeLadfrlTotal: '264',
        canonicalSourcePnu: ELECT_PNU,
        buildingUnits: [],
        propertyUnits: [],
    });
    assert.equal(result.blocking, true);
    assert.equal(result.replicationEvidence, null);
    assert.deepEqual(
        result.issues.map((issue) => issue.code),
        ['LDAREG_IDENTITY_CONFLICT']
    );
});
```

- [ ] **Step 2: 실패를 확인한다**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && node --import tsx --test tests/land-area-sync-ldareg-branch.test.ts
```
Expected: FAIL — `closureRootIdentities`가 `LdaregBranchInput`에 없어 타입 오류.

- [ ] **Step 3: `LdaregBranchInput`에 closure 축을 추가한다**

`src/services/land-area-sync/ldareg-branch.ts`의 `LdaregBranchInput`에서

```ts
    /** 단일 root 관리번호(전유부 root identity 비교 기준). */
    rootIdentity: string;
```

를 다음으로 바꾼다.

```ts
    /**
     * 선택된 대지권 대상 root 관리번호. 전유부 root identity 비교(매칭 축)의 유일한 기준이다
     * (DESIGN §10.4·§12.4 개정). 표제부 root가 하나면 그 root와 같다.
     */
    rootIdentity: string;
    /**
     * BASIS/EXPOS closure accepted root 집합 (DESIGN §9.1 개정). 표제부 root **전체**를 넣는다.
     * 제외된 동의 기본개요 행이 closure 밖으로 떨어져 전체가 차단되는 것을 막는다.
     * 생략하면 `[rootIdentity]`로 취급해 기존 단일 root 동작을 그대로 유지한다.
     */
    closureRootIdentities?: string[];
```

- [ ] **Step 4: `assembleLdaregApply`가 closure 축을 쓰게 한다**

`assembleLdaregApply` 안의 `:1251` 한 줄을 바꾼다.

```ts
    // closure는 전체 표제부 root로 닫고, 매칭 축은 선택된 rootIdentity 하나로 좁힌다.
    // 두 축을 섞지 않는 것이 §9.1 개정의 핵심이다.
    const closureRootIdentities = [
        ...new Set([
            rootIdentity,
            ...(input.closureRootIdentities ?? []),
        ]),
    ].sort();
    const basisRootIndex = buildScopeBasisRootIndex(
        perPnu,
        closureRootIdentities
    );
```

> `tests/land-area-sync-matcher.test.ts`는 **바꾸지 않는다.** matcher의 root 비교 코드는 그대로이고
> 주석만 바뀐다(§12.4 개정은 `scopeRootIdentity`의 *의미*를 바꾸는 것이고 비교식은 동일하다).
> 기존 `ROOT_IDENTITY / ROOT_MISMATCH` 계약 테스트가 그대로 통과해야 한다.

> `collectScopeExposUnits`는 이제 전체 root의 EXPOS 후보를 담는다. 제외된 root의 호실이 섞이면
> `evaluateExposFloorHoFallback` · `evaluateExposProviderShapeBridge`의 `singleRoot`가 false가 되어
> 축약형 경로가 닫힌다 — §12.3 개정이 요구하는 그대로다(개정 전과 실질 강도 동일). matcher는
> `rootIdentity`가 아닌 호실을 `ROOT_IDENTITY / ROOT_MISMATCH`로 무변경 처리한다. 코드 변경 없음.

- [ ] **Step 5: 주석으로 두 축을 명시한다 (동작 변경 없음)**

`src/services/land-area-sync/matcher.ts:334-335`의 주석을 다음으로 바꾼다.

```ts
    // 2) 전유부 root identity == 선택된 대지권 대상 root identity
    // scopeRootIdentity는 표제부 root가 하나면 그 root, 여럿이면 LDAREG 행 근거로 선출된
    // 단일 root다(DESIGN §12.4 개정). expos.rootIdentity는 전체 root를 accepted로 삼은
    // title-bound basis closure로 해소된 effective root다. resolver의 up-preferred 축과 섞지 않는다.
```

`src/services/land-area-sync/expos-root.ts`의 `buildBasisRootIndex` docblock 첫 줄 위에 한 줄을 넣는다.
(자료구조는 이미 복수 root Set을 받으므로 **코드 변경은 없다.**)

```ts
/**
 * basis child self-PK별 title-bound parent를 만든다.
 *
 * accepted root는 표제부 root **전체 집합**이다(DESIGN §9.1 개정). 대지권 대상 root 선택은
 * 상위 계층의 판단이고, closure는 제외될 동까지 포함해 닫아야 전체가 차단되지 않는다.
 *
```

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && node --import tsx --test tests/land-area-sync-ldareg-branch.test.ts
```
Expected: PASS.

- [ ] **Step 7: 전체 테스트 + 타입 체크**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && npx tsc --noEmit && npm test
```
Expected: 전건 PASS. `closureRootIdentities`가 optional이라 기존 호출부는 동작 불변이다.

- [ ] **Step 8: 커밋**

```bash
cd /Users/inju/workspace/tonghari/tonghari-api && git add src/services/land-area-sync/ldareg-branch.ts src/services/land-area-sync/matcher.ts src/services/land-area-sync/expos-root.ts tests/land-area-sync-ldareg-branch.test.ts && git commit -m "feat(land-area): BASIS/EXPOS closure 를 표제부 root 전체로 닫는다"
```

---

## Task 5: component 단일성 가드 3곳을 선택 root 기준으로

**Files:**
- Modify: `src/services/land-area-sync/scope.ts:507-546` (strict attached component),
  `src/services/land-area-sync/scope.ts:678-701` (DEV full-refresh singleton)
- Test: `tests/land-area-sync-scope.test.ts`

**Interfaces:**
- Consumes: Task 2의 `ParcelScopeInput.landRightRootIdentity`
- Produces: module-private `selectedTitleSelfPks(titleRows, landRightRootIdentity)` /
  `allBylotCountsZero(bylot, expectedPks)` helper

---

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/land-area-sync-scope.test.ts`에 추가한다. `resolveSameRunOfficialDevelopmentFullRefreshComponent`는
이미 이 파일에서 테스트되고 있으니 기존 helper를 재사용한다.

```ts
test('DEV 전체 갱신 singleton component는 선택 root가 있으면 복수 표제부 root를 허용한다', () => {
    const component = resolveSameRunOfficialDevelopmentFullRefreshComponent({
        anchorPnu: MIA_ANCHOR,
        dbScope: parseDbScopeResolution({
            ...multiRootDbScope(),
            dbState: 'NO_EVIDENCE',
            linkedBasePnus: [],
            linkedPnus: [],
        }),
        baseScans: multiRootBaseScans() as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.notEqual(component, null);
    assert.equal(component?.managementPk, AGGREGATE_ROOT);
    assert.deepEqual(component?.memberPnus, [MIA_ANCHOR]);
    assert.equal(component?.pairCount, 0);
});

test('DEV 전체 갱신 singleton component는 선택 root가 없으면 복수 root를 승격하지 않는다', () => {
    const component = resolveSameRunOfficialDevelopmentFullRefreshComponent({
        anchorPnu: MIA_ANCHOR,
        dbScope: parseDbScopeResolution({
            ...multiRootDbScope(),
            dbState: 'NO_EVIDENCE',
            linkedBasePnus: [],
            linkedPnus: [],
        }),
        baseScans: multiRootBaseScans() as never,
        policy: 'TITLE_ONLY',
    });
    assert.equal(component, null);
});

test('DEV 전체 갱신 singleton component는 제외 root의 bylotCnt가 0이 아니면 승격하지 않는다', () => {
    const scans = multiRootBaseScans();
    scans[0].title.rows[0] = {
        ...scans[0].title.rows[0],
        bylotCnt: '1',
    } as never;
    const component = resolveSameRunOfficialDevelopmentFullRefreshComponent({
        anchorPnu: MIA_ANCHOR,
        dbScope: parseDbScopeResolution({
            ...multiRootDbScope(),
            dbState: 'NO_EVIDENCE',
            linkedBasePnus: [],
            linkedPnus: [],
        }),
        baseScans: scans as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.equal(component, null);
});

test('선택 root 귀속 표제부 행이 0건이면 승격하지 않는다', () => {
    const component = resolveSameRunOfficialDevelopmentFullRefreshComponent({
        anchorPnu: MIA_ANCHOR,
        dbScope: parseDbScopeResolution({
            ...multiRootDbScope(),
            dbState: 'NO_EVIDENCE',
            linkedBasePnus: [],
            linkedPnus: [],
        }),
        baseScans: multiRootBaseScans() as never,
        policy: 'TITLE_ONLY',
        // 표제부에 없는 root
        landRightRootIdentity: '9999999999',
    });
    assert.equal(component, null);
});

test('선택 root의 표제부 행이 여러 개라도 같은 self PK면 dedup 후 승격한다', () => {
    const scans = multiRootBaseScans();
    // 집합 root 표제부 행을 한 번 더 반복한다(같은 self PK).
    scans[0].title.rows.push({ ...scans[0].title.rows[1] } as never);
    const component = resolveSameRunOfficialDevelopmentFullRefreshComponent({
        anchorPnu: MIA_ANCHOR,
        dbScope: parseDbScopeResolution({
            ...multiRootDbScope(),
            dbState: 'NO_EVIDENCE',
            linkedBasePnus: [],
            linkedPnus: [],
        }),
        baseScans: scans as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.notEqual(component, null);
    assert.equal(component?.managementPk, AGGREGATE_ROOT);
});

test('표제부에 invalid 관리 PK가 있으면 선택 root와 무관하게 승격하지 않는다', () => {
    const scans = multiRootBaseScans();
    scans[0].title.rows[0] = {
        ...scans[0].title.rows[0],
        mgmBldrgstPk: '',
    } as never;
    const component = resolveSameRunOfficialDevelopmentFullRefreshComponent({
        anchorPnu: MIA_ANCHOR,
        dbScope: parseDbScopeResolution({
            ...multiRootDbScope(),
            dbState: 'NO_EVIDENCE',
            linkedBasePnus: [],
            linkedPnus: [],
        }),
        baseScans: scans as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.equal(component, null);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && node --import tsx --test tests/land-area-sync-scope.test.ts
```
Expected: FAIL — "선택 root가 있으면 복수 표제부 root를 허용한다"가 `null`을 받는다
(`titleSelfPks.length !== 1` 가드).

- [ ] **Step 3: helper 두 개를 추가한다**

`src/services/land-area-sync/scope.ts`의 `partitionTitleRowsByLandRightRoot` 아래에 넣는다.

```ts
/**
 * 단일성 판정용 표제부 self PK 집합. 선택 root가 있으면 그 파티션만 본다 (DESIGN §9.1 개정).
 * invalid PK가 하나라도 있으면 null을 반환해 호출측이 승격을 포기하게 한다.
 */
function selectedTitleSelfPks(
    titleRows: readonly BrTitleRow[],
    landRightRootIdentity: string | null | undefined
): string[] | null {
    const selected = normalizeRegistryManagementPk(
        landRightRootIdentity ?? ''
    );
    const pks = new Set<string>();
    for (const row of titleRows) {
        const self = normalizeRegistryManagementPk(row.mgmBldrgstPk);
        if (self === null) return null;
        if (selected !== null && self !== selected) continue;
        pks.add(self);
    }
    return [...pks].sort();
}

/**
 * expectedPks 전체가 bylot 근거를 갖고 그 값이 모두 0인지 (DESIGN §9.1 개정).
 * 제외된 동에도 부속지번이 없어야 필지 singleton으로 승격할 수 있다.
 */
function allBylotCountsZero(
    bylot: BylotResolution,
    expectedPks: readonly string[]
): boolean {
    const expected = [...new Set(expectedPks)].sort();
    const evidencePks = [
        ...new Set(bylot.evidence.map((row) => row.mgmBldrgstPk)),
    ].sort();
    return (
        expected.length > 0 &&
        evidencePks.length === expected.length &&
        evidencePks.every((pk, index) => pk === expected[index]) &&
        bylot.evidence.every((row) => row.count === 0)
    );
}
```

- [ ] **Step 4: strict attached component 가드(:507-546)를 고친다**

`resolveStrictSameRunOfficialAttachedComponent` 안에서 현행

```ts
    const titleSelfPks = [ ... ].sort();
    if (titleSelfPks.length !== 1) return null;
    const titleRootPks = [ ... ].sort();
    if (titleRootPks.length !== 1) return null;
    const managementPk = titleSelfPks[0];
    if (
        attached.pairs.some(
            (pair) =>
                normalizeRegistryManagementPk(pair.mgmBldrgstPk) !==
                managementPk
        ) ||
        normalGate.expectedPks.length !== 1 ||
        normalGate.expectedPks[0] !== managementPk
    ) {
        return null;
    }
```

블록을 다음으로 교체한다.

```ts
    // 단일성 판정은 선택된 대지권 대상 root 파티션에서만 한다 (DESIGN §9.1 개정).
    // 부속지번·bylot 축은 전체 root를 그대로 유지하므로, 제외된 root에 부속지번이 있으면
    // 아래 attached pair 검사와 bylot 검사에서 막힌다.
    const titleSelfPks = selectedTitleSelfPks(
        baseScans[0].title.rows,
        input.landRightRootIdentity
    );
    if (titleSelfPks === null || titleSelfPks.length !== 1) return null;
    const managementPk = titleSelfPks[0];
    const selectedTitleRows = baseScans[0].title.rows.filter(
        (row) =>
            normalizeRegistryManagementPk(row.mgmBldrgstPk) ===
            managementPk
    );
    const titleRootPks = [
        ...new Set(
            selectedTitleRows
                .map(
                    (row) =>
                        normalizeRegistryManagementPk(
                            row.mgmUpBldrgstPk
                        ) ??
                        normalizeRegistryManagementPk(
                            row.mgmBldrgstPk
                        )
                )
                .filter(
                    (value): value is string => value !== null
                )
        ),
    ].sort();
    if (
        titleRootPks.length !== 1 ||
        titleRootPks[0] !== managementPk
    ) {
        return null;
    }
    if (
        attached.pairs.some(
            (pair) =>
                normalizeRegistryManagementPk(pair.mgmBldrgstPk) !==
                managementPk
        ) ||
        !normalGate.expectedPks.includes(managementPk) ||
        // 선택 root 밖의 관리 PK는 부속지번이 0이어야 한다.
        normalGate.bylot.evidence.some(
            (row) =>
                row.mgmBldrgstPk !== managementPk && row.count !== 0
        )
    ) {
        return null;
    }
```

- [ ] **Step 5: DEV full-refresh singleton 가드(:678-701)를 고친다**

같은 파일 `resolveSameRunOfficialDevelopmentFullRefreshComponent` 안에서 현행

```ts
    const titleSelfPks = [ ... ].sort();
    if (
        titleSelfPks.length !== 1 ||
        singletonGate.expectedPks.length !== 1 ||
        singletonGate.expectedPks[0] !== titleSelfPks[0] ||
        singletonGate.bylot.evidence.length !== 1 ||
        singletonGate.bylot.evidence[0].mgmBldrgstPk !==
            titleSelfPks[0] ||
        singletonGate.bylot.evidence[0].count !== 0
    ) {
        return null;
    }
    const managementPk = titleSelfPks[0];
```

블록을 다음으로 교체한다.

```ts
    // 선택된 대지권 대상 root 파티션에서 self PK가 정확히 하나여야 한다 (DESIGN §9.1 개정).
    // 제외된 동을 포함한 전체 expectedPks의 bylotCnt가 모두 0일 때만 필지 singleton이다.
    const titleSelfPks = selectedTitleSelfPks(
        input.baseScans[0].title.rows,
        input.landRightRootIdentity
    );
    if (
        titleSelfPks === null ||
        titleSelfPks.length !== 1 ||
        !singletonGate.expectedPks.includes(titleSelfPks[0]) ||
        !allBylotCountsZero(
            singletonGate.bylot,
            singletonGate.expectedPks
        )
    ) {
        return null;
    }
    const managementPk = titleSelfPks[0];
```

`BylotResolution` 타입이 이미 import되어 있는지 확인한다. 없으면 기존 import에 추가한다.

```ts
import { resolveBylotCounts, BYLOT_SOURCE_POLICY, type BylotResolution } from './bylot';
```

> **네 번째 단일성 지점은 고치지 않는다.** `resolveSameRunOfficialDevelopmentParcelSingleton`
> (`scope.ts:801-830`)도 `titleSelfPks`를 계산하지만 **길이 1을 요구하지 않는다** — `expectedPks`와
> exact 일치하고 모든 bylot 값이 0이면 되므로 복수 root를 이미 통과시킨다. 확인만 하고 손대지
> 않는다. 이 경로는 활성 물건지 1건 + 호 identity 부재를 요구하는 LADFRL 필지 singleton이라
> 791-2282(10호 집합건물)와 무관하다.

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && node --import tsx --test tests/land-area-sync-scope.test.ts
```
Expected: PASS.

- [ ] **Step 7: 전체 테스트 + 타입 체크**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && npx tsc --noEmit && npm test
```
Expected: 전건 PASS. 선택 root가 없으면 `selectedTitleSelfPks`는 전체 self PK를 반환하고
`allBylotCountsZero`는 단일 PK·count 0을 요구하므로 기존 동작과 동일하다.
특히 `tests/land-area-sync-scope.test.ts:351`의 "DEV classification-independent component scope는
root conflict·duplicate·count mismatch·provider incomplete를 승격하지 않는다"가 계속 통과해야 한다.

- [ ] **Step 8: 커밋**

```bash
cd /Users/inju/workspace/tonghari/tonghari-api && git add src/services/land-area-sync/scope.ts tests/land-area-sync-scope.test.ts && git commit -m "fix(land-area): component 단일성 가드를 선택 root 기준으로 좁힌다"
```

---

## Task 6: service 배선 — 선출 pre-pass와 scan 재사용

**Files:**
- Modify: `src/services/land-area-sync/service.ts`
- Test: `tests/land-area-sync-service.test.ts`

**Interfaces:**
- Consumes: Task 2 `ParcelScopeInput.landRightRootIdentity`, Task 3 `electLandRightRootIdentity`,
  Task 4 `LdaregBranchInput.closureRootIdentities`
- Produces:
  ```ts
  export function selectLandRightRootIdentity(
      baseScans: BasePnuScan[],
      landRightRootIdentity: string | null
  ): string | null;
  export function selectSingleLdaregRootIdentity(baseScans: BasePnuScan[]): string | null; // 기존 export 유지
  interface LandRightRootElectionScan {
      pnu: string;
      ldareg: StrictScan<LdaregRow>;
      expos: StrictScan<BrExposRow>;
      basis: StrictScan<BrBasisOulnRow>;
  }
  // BranchContext 추가 필드: landRightRootIdentity, landRightClosureRootIdentities, landRightElectionScans
  ```

---

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/land-area-sync-service.test.ts`에 추가한다. 상단 import에 `selectLandRightRootIdentity`를 추가한다.
기존 `selectSingleLdaregRootIdentity` 테스트(2508 · 2528 · 2547 · 2996행)는 **그대로 둔다** —
하위 호환 export를 유지하는 것이 이 task의 계약이다.

```ts
test('selectLandRightRootIdentity: 단일 root면 선출값과 무관하게 그 root를 쓴다', () => {
    const oneRoot = [
        {
            pnu: ANCHOR,
            title: {
                state: 'COMPLETE' as const,
                rows: [{ mgmBldrgstPk: PK }],
                totalCount: 1,
                pagesFetched: 1,
            },
            attached: {
                state: 'COMPLETE_ZERO' as const,
                rows: [],
                totalCount: 0 as const,
                pagesFetched: 1,
            },
        },
    ];
    assert.equal(selectLandRightRootIdentity(oneRoot as never, null), PK);
    assert.equal(
        selectLandRightRootIdentity(oneRoot as never, 'OTHER-PK'),
        PK
    );
});

test('selectLandRightRootIdentity: 복수 root는 선출된 root가 표제부에 있을 때만 채택한다', () => {
    const twoRoots = [
        {
            pnu: ANCHOR,
            title: {
                state: 'COMPLETE' as const,
                rows: [
                    { mgmBldrgstPk: '1010111086' },
                    { mgmBldrgstPk: '1010114204' },
                ],
                totalCount: 2,
                pagesFetched: 1,
            },
            attached: {
                state: 'COMPLETE_ZERO' as const,
                rows: [],
                totalCount: 0 as const,
                pagesFetched: 1,
            },
        },
    ];
    assert.equal(selectLandRightRootIdentity(twoRoots as never, null), null);
    assert.equal(
        selectLandRightRootIdentity(twoRoots as never, '1010114204'),
        '1010114204'
    );
    assert.equal(
        selectLandRightRootIdentity(twoRoots as never, '9999999999'),
        null
    );
});
```

- [ ] **Step 2: 실패를 확인한다**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && node --import tsx --test tests/land-area-sync-service.test.ts
```
Expected: FAIL — `selectLandRightRootIdentity` export 없음.

- [ ] **Step 3: root 선택 함수를 확장한다**

`src/services/land-area-sync/service.ts:256-262`의 현행

```ts
/** LDAREG branch가 허용하는 전 base title self root exactly-one gate. */
export function selectSingleLdaregRootIdentity(
    baseScans: BasePnuScan[]
): string | null {
    const roots = deriveLdaregTitleSelfRootPks(baseScans);
    return roots.length === 1 ? roots[0] : null;
}
```

를 다음으로 바꾼다.

```ts
/**
 * LDAREG branch가 쓰는 대지권 대상 root를 고른다 (DESIGN §10.4 개정).
 *
 * 표제부 root가 하나면 그 root다. 여럿이면 상위 계층이 LDAREG 행 근거로 선출한 root가
 * 실제 표제부 self root 집합 안에 있을 때만 채택한다. 그 외에는 null(REVIEW)이다.
 */
export function selectLandRightRootIdentity(
    baseScans: BasePnuScan[],
    landRightRootIdentity: string | null
): string | null {
    const roots = deriveLdaregTitleSelfRootPks(baseScans);
    if (roots.length === 1) return roots[0];
    if (
        roots.length > 1 &&
        landRightRootIdentity !== null &&
        roots.includes(landRightRootIdentity)
    ) {
        return landRightRootIdentity;
    }
    return null;
}

/** 하위 호환: 선출 없이 단일 root만 허용하는 기존 gate. */
export function selectSingleLdaregRootIdentity(
    baseScans: BasePnuScan[]
): string | null {
    return selectLandRightRootIdentity(baseScans, null);
}
```

- [ ] **Step 4: import와 선출 scan 타입을 추가한다**

`./ldareg-branch` import에 선출 함수와 타입을 추가한다.

```ts
import {
    assembleLdaregApply,
    electLandRightRootIdentity,
    LDAREG_OFFICIAL_CURRENT_SUPERSET_MODE,
    resolveLdaregPropertyMembershipLayout,
    selectCanonicalExposSourcePnu,
    type LandRightRootElection,
    type LdaregPropertyMembershipMode,
    type LdaregPnuScan,
} from './ldareg-branch';
```

`aborted` 함수 위에 타입을 추가한다.

```ts
/**
 * 복수 root 선출 전용 same-run scan 묶음.
 *
 * gate 단계의 bylot basis scan과는 목적이 다르므로 공유하지 않는다. 반대로 LDAREG branch의
 * root closure basis와는 목적이 같으므로 그쪽에서 재사용한다 — 같은 실행에서 같은 endpoint를
 * 두 번 때리면 응답이 갈라져 결정론이 깨진다.
 */
interface LandRightRootElectionScan {
    pnu: string;
    ldareg: StrictScan<LdaregRow>;
    expos: StrictScan<BrExposRow>;
    basis: StrictScan<BrBasisOulnRow>;
}
```

- [ ] **Step 5: Phase 3.5 선출 pre-pass를 넣는다**

`runLandAreaSyncJob` 안에서, basis fallback 루프가 끝나고
`// 과거 791-3568을 고정 no-data로 간주했던 예외는 ...` 주석 **바로 위**에 넣는다.

```ts
    // ── Phase 3.5: 표제부 root가 여럿일 때만 LDAREG 근거 root 선출 (DESIGN §9.1 개정) ──
    // base PNU 집합은 Phase 3가 이미 title/attached를 조회한 그 집합이다. 새 PNU를 건드리지
    // 않으므로 canary scope 계약이 그대로 유지된다. 선출 실패는 새 FAILED terminal을 만들지
    // 않고 기존 복수 root REVIEW 경로로 닫는다.
    const titleSelfRootPks = deriveLdaregTitleSelfRootPks(baseScans);
    const landRightElectionScans: LandRightRootElectionScan[] = [];
    let landRightRootElection: LandRightRootElection = {
        kind: 'NOT_REQUIRED',
        rootIdentities: titleSelfRootPks,
    };
    if (titleSelfRootPks.length > 1) {
        for (const pnu of basePnus) {
            const ldareg = await deps.scans.scanLdareg(pnu, signal);
            if (aborted(signal)) return;
            const expos = await deps.scans.scanExpos(pnu, signal);
            if (aborted(signal)) return;
            const basis = await deps.scans.scanBasis(pnu, signal);
            if (aborted(signal)) return;
            landRightElectionScans.push({ pnu, ldareg, expos, basis });
        }
        const electionScansUsable = landRightElectionScans.every(
            (scan) =>
                requiredScanState(scan.ldareg) === 'OK' &&
                requiredScanState(scan.expos) === 'OK' &&
                requiredScanState(scan.basis) === 'OK'
        );
        landRightRootElection = electionScansUsable
            ? electLandRightRootIdentity({
                  titleRootIdentities: titleSelfRootPks,
                  titleRows: baseScans.flatMap((scan) =>
                      rows(scan.title)
                  ),
                  perPnu: landRightElectionScans.map((scan) => ({
                      pnu: scan.pnu,
                      ldaregRows: rows(scan.ldareg),
                      exposRows: rows(scan.expos),
                      basisRows: rows(scan.basis),
                  })),
              })
            : {
                  kind: 'INDETERMINATE',
                  reason: 'ELECTION_SCAN_INCOMPLETE',
                  rootIdentities: titleSelfRootPks,
              };
    }
    const landRightRootIdentity =
        landRightRootElection.kind === 'ELECTED'
            ? landRightRootElection.selectedRootIdentity
            : null;
```

- [ ] **Step 6: gate·component 호출부 4곳에 선택 root를 전달한다**

`runLandAreaSyncJob` 안의 다음 호출 전부에 `landRightRootIdentity`를 추가한다.
(`ParcelScopeInput`을 그대로 전달하는 scope.ts 내부 재호출은 자동으로 따라간다.)

첫 gate (현행 `let gate = resolveParcelScopeCompleteness({...})`):

```ts
    let gate = resolveParcelScopeCompleteness({
        dbScope: effectiveDbScope,
        baseScans,
        policy,
        landRightRootIdentity,
    });
```

component 해소 두 곳:

```ts
        const component = developmentFullRefresh
            ? resolveSameRunOfficialDevelopmentFullRefreshComponent({
                  anchorPnu,
                  dbScope,
                  baseScans,
                  policy,
                  landRightRootIdentity,
              })
            : resolveSameRunOfficialReadOnlyComponent({
                  anchorPnu,
                  dbScope,
                  baseScans,
                  policy,
                  landRightRootIdentity,
              });
```

component 확정 후 gate 재계산:

```ts
            gate = resolveParcelScopeCompleteness({
                dbScope: effectiveDbScope,
                baseScans,
                policy,
                landRightRootIdentity,
            });
```

parcel singleton 해소:

```ts
                const parcelResolution =
                    resolveSameRunOfficialDevelopmentParcelSingleton(
                        {
                            anchorPnu,
                            dbScope,
                            baseScans,
                            policy,
                            landRightRootIdentity,
                            parcelSingletonBasis:
                                resolvedParcelSingletonBasis,
                        }
                    );
```

parcel singleton 확정 후 gate 재계산:

```ts
                    gate = resolveParcelScopeCompleteness({
                        dbScope: effectiveDbScope,
                        baseScans,
                        policy,
                        landRightRootIdentity,
                    });
```

- [ ] **Step 7: `BranchContext`에 선출 결과를 넘긴다**

`BranchContext` 인터페이스의 `baseScans: BasePnuScan[];` 아래에 추가한다.

```ts
    /** LDAREG 행 근거로 선출된 대지권 대상 root. 단일 root거나 선출 실패면 null. */
    landRightRootIdentity: string | null;
    /** BASIS/EXPOS closure accepted root 전체(표제부 self 축, 정렬·dedup). */
    landRightClosureRootIdentities: string[];
    /** 선출 pre-pass가 이미 조회한 same-run scan. 같은 PNU 재조회를 막는다. */
    landRightElectionScans: LandRightRootElectionScan[];
```

`ctx` 리터럴의 `baseScans,` 아래에 채운다.

```ts
        baseScans,
        landRightRootIdentity,
        landRightClosureRootIdentities: titleSelfRootPks,
        landRightElectionScans,
```

- [ ] **Step 8: `runLdaregBranch`가 선출 결과를 쓰게 한다**

`runLdaregBranch` 시작부의 현행

```ts
    const rootIdentity = selectSingleLdaregRootIdentity(ctx.baseScans);
```

를 다음으로 바꾼다.

```ts
    const rootIdentity = selectLandRightRootIdentity(
        ctx.baseScans,
        ctx.landRightRootIdentity
    );
```

`const acceptedRootIdentities = [rootIdentity];` 를 closure 축으로 바꾼다.

```ts
    // closure 축은 표제부 root 전체다. 매칭 축(rootIdentity)과 섞지 않는다 (DESIGN §9.1 개정).
    const closureRootIdentities = [
        ...new Set([
            rootIdentity,
            ...ctx.landRightClosureRootIdentities,
        ]),
    ].sort();
```

per-PNU scan 루프에서 선출 pre-pass 결과를 재사용한다. 루프 앞에 map을 만들고,

```ts
    const electionScanByPnu = new Map(
        ctx.landRightElectionScans.map((scan) => [scan.pnu, scan])
    );
    for (const pnu of scannedPnus) {
        const reused = electionScanByPnu.get(pnu);
        const ldareg =
            reused?.ldareg ?? (await deps.scans.scanLdareg(pnu, signal));
        if (aborted(signal)) return;
        const ladfrl = await deps.scans.scanLadfrl(pnu, signal);
        if (aborted(signal)) return;
        const expos =
            reused?.expos ?? (await deps.scans.scanExpos(pnu, signal));
        if (aborted(signal)) return;
        const basis =
            reused?.basis ?? (await deps.scans.scanBasis(pnu, signal));
        if (aborted(signal)) return;
        ldaregBasisRows += rows(basis).length;
```

`selectCanonicalExposSourcePnu` 호출의 3번째 인자를 closure 축으로 바꾼다.

```ts
    const canonicalSourcePnu = selectCanonicalExposSourcePnu(
        canonicalBasePnus,
        perPnu,
        closureRootIdentities,
        {
```

`assembleLdaregApply` 호출에 closure 축을 추가한다.

```ts
    const assembled = assembleLdaregApply({
        unionId,
        scannedPnus,
        rootIdentity,
        closureRootIdentities,
        perPnu,
```

- [ ] **Step 9: 테스트가 통과하는지 확인한다**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && node --import tsx --test tests/land-area-sync-service.test.ts
```
Expected: PASS. 기존 `selectSingleLdaregRootIdentity` 테스트 4건도 함께 통과해야 한다.

- [ ] **Step 10: 전체 테스트 + 타입 체크**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && npx tsc --noEmit && npm test
```
Expected: 전건 PASS. 단일 root anchor는 `titleSelfRootPks.length > 1`이 false라 선출 pre-pass가
아예 실행되지 않으므로 외부 호출 수가 늘지 않는다.

- [ ] **Step 11: 커밋**

```bash
cd /Users/inju/workspace/tonghari/tonghari-api && git add src/services/land-area-sync/service.ts tests/land-area-sync-service.test.ts && git commit -m "feat(land-area): 복수 root anchor 에 LDAREG 근거 root 선출을 배선한다"
```

---

## Task 7: 791-2282 형상 end-to-end 회귀 + 복수 root REVIEW 계약 좁히기

**Files:**
- Modify: `tests/land-area-sync-integration.test.ts`
- Test: 위 파일 (이 task는 테스트가 산출물이다)

**Interfaces:**
- Consumes: Task 1~6 전부
- Produces: 없음 (계약 고정)

---

- [ ] **Step 1: 통합 회귀 테스트를 쓴다**

`tests/land-area-sync-integration.test.ts`의 기존 harness(job row·deps 조립 helper, mock provider)를
먼저 읽고 그 형태를 그대로 재사용한다. `tests/land-area-sync-mock-provider.ts`가 있으면 쓴다.
아래 세 케이스를 추가한다.

```ts
// ── 미아7 791-2282: 한 지번 복수 root(일반 1동 + 집합 1동) ──────────────

test('복수 root anchor는 LDAREG 근거 root를 선출해 LDAREG 전략으로 진행한다', async () => {
    // 표제부 2행(일반 01000/단독주택, 집합 02000/공동주택 4층 513.06㎡),
    // 부속지번 0, 기본개요 12행, 전유부 10행, LDAREG 11행(전유 10 + placeholder 1),
    // 활성 물건지 10호(전부 anchor PNU, 호 identity 있음).
    //
    // 기대: 분류는 선택된 집합 root 1행만 보고 규모 기준으로 CLASSIFIED/LDAREG,
    // strategy는 LDAREG, terminal은 REVIEW_REQUIRED가 아니고 snapshot이 고정된다.
    // ... harness 조립 후:
    assert.notEqual(state.snapshot, null);
    assert.equal(state.snapshot?.strategy, 'LDAREG');
    assert.equal(state.terminal?.scopeState !== 'REVIEW_REQUIRED', true);
});

test('복수 root anchor에서 LDAREG 근거 root가 0개면 기존대로 REVIEW_REQUIRED다', async () => {
    // LDAREG 행의 동·층·호를 전유부와 어긋나게 바꾼다.
    assert.equal(state.terminal?.scopeState, 'REVIEW_REQUIRED');
    assert.deepEqual(
        state.terminal?.issues.map((issue) => issue.code),
        ['BUILDING_CLASSIFICATION_CONFLICT']
    );
});

test('복수 root anchor에서 LDAREG 근거 root가 2개면 기존대로 REVIEW_REQUIRED다', async () => {
    // 일반 root 밑에도 전유부 호실 + 대응 LDAREG 행을 붙인다.
    assert.equal(state.terminal?.scopeState, 'REVIEW_REQUIRED');
    assert.deepEqual(
        state.terminal?.issues.map((issue) => issue.code),
        ['BUILDING_CLASSIFICATION_CONFLICT']
    );
});

test('선출용 LDAREG scan이 실패하면 FAILED가 아니라 기존 REVIEW_REQUIRED로 닫는다', async () => {
    // scanLdareg가 { state: 'FAILED', issue: ... }를 반환하게 한다.
    assert.equal(state.terminal?.scopeState, 'REVIEW_REQUIRED');
    assert.deepEqual(
        state.terminal?.issues.map((issue) => issue.code),
        ['BUILDING_CLASSIFICATION_CONFLICT']
    );
});

test('복수 root anchor는 선출 pre-pass 결과를 재사용해 같은 PNU를 두 번 조회하지 않는다', async () => {
    // scanLdareg/scanExpos/scanBasis 호출 PNU를 기록해 anchor가 각 1회인지 확인한다.
    assert.deepEqual(ldaregCalls, [MIA_ANCHOR]);
    assert.deepEqual(exposCalls, [MIA_ANCHOR]);
    assert.deepEqual(basisCalls, [MIA_ANCHOR]);
});
```

> harness 조립은 이 파일의 기존 테스트를 복사해 fixture만 위 형상으로 바꾼다. `assert` 라인은
> 위 그대로 쓴다. `state`는 기존 harness가 노출하는 terminal/snapshot 수집 객체 이름에 맞춘다.
> **`bylotCnt`는 두 표제부 행 모두 `'0'`으로 둔다** — Task 5의 `allBylotCountsZero`가 이를 요구한다.

- [ ] **Step 2: 실제 실측값과 fixture를 대조한다**

두 표제부 행의 `bylotCnt`가 실제로 유효한 `0`인지 캡처 증거에서 확인한다. 하나라도 누락/invalid면
`BYLOT_COUNT_UNAVAILABLE`이 gate issue로 추가되어 component 승격이 막히고, 그건 이 개정과 별개의
선행 조건이다.

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && grep -rn "791.\{0,2\}2282\|1010114204\|1010111086" docs/2026-07-30-multi-root-parcel-design-revision.md
```

확인 결과가 개정안 §2·§6.1의 실측(ATTACHED 0, TITLE 2, BASIS 12, EXPOS 10, LDAREG 11)과 어긋나면
**멈추고 사용자에게 보고한다.** fixture를 실측에 맞추려고 추정값을 넣지 않는다.

- [ ] **Step 3: 테스트를 돌린다**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && node --import tsx --test tests/land-area-sync-integration.test.ts
```
Expected: PASS.

- [ ] **Step 4: 전체 테스트 + 타입 체크**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && npx tsc --noEmit && npm test
```
Expected: 전건 PASS.

- [ ] **Step 5: 커밋**

```bash
cd /Users/inju/workspace/tonghari/tonghari-api && git add tests/land-area-sync-integration.test.ts && git commit -m "test(land-area): 한 지번 복수 root anchor end-to-end 회귀를 고정한다"
```

---

## Task 8: 설계 문서 개정 반영 + 개정안 브랜치 정리

**Files:**
- Modify: `docs/2026-07-23-land-area-sync-design.md` (§9.1 · §9.2 · §10.4 · §12.3 · §12.4)
- Modify: `docs/2026-07-30-multi-root-parcel-design-revision.md` (상태 갱신)

**Interfaces:**
- Consumes: Task 1~7 구현 결과
- Produces: 없음

---

- [ ] **Step 1: 개정안 브랜치를 작업 브랜치에 합친다**

개정안 문서(`docs/2026-07-30-multi-root-parcel-design-revision.md`)는 `docs/multi-root-parcel-revision`
브랜치에만 있다. 구현과 같은 브랜치에 올려서 함께 `main`으로 들어가게 한다.

```bash
cd /Users/inju/workspace/tonghari/tonghari-api && git merge --no-ff docs/multi-root-parcel-revision -m "merge: 한 지번 복수 root 설계 개정안 문서"
```

충돌이 나면 임의로 rebase/reset하지 않고 멈춰 보고한다.

- [ ] **Step 2: §9.1 모집단 마지막 확인 항목을 교체한다**

`docs/2026-07-23-land-area-sync-design.md`에서

```
- 모든 행이 같은 root 관리번호 계열인지 확인
```

를 다음으로 바꾼다.

```
- 표제부 root 관리번호가 여럿이면, 그 중 **대지권등록부(LDAREG)에 행 근거를 가진 root가
  정확히 하나**일 때만 그 root를 대지권 대상으로 삼는다. 나머지 root는 `대지권 무관 동`으로
  기록하고 물건지 투영 대상에서 제외한다. LDAREG 근거 root가 0개이거나 2개 이상이면
  `REVIEW_REQUIRED`다.
- 분류·매칭은 선택된 대지권 대상 root의 표제부 행만으로 수행한다. 제외된 root의 표제부
  행은 분류 입력에 넣지 않는다.
- 기본개요(BASIS)·전유부(EXPOS) closure 판정은 **전체 root 집합**을 accepted root로 삼는다.
  제외된 동의 BASIS 행이 closure 밖으로 떨어져 전체가 차단되지 않게 하기 위해서다.
- `bylotCnt`·부속지번 축도 **전체 root 집합**을 유지한다. 제외된 동의 부속지번이 판정 밖으로
  빠지지 않는다.
```

- [ ] **Step 3: §9.2 결정표 행을 교체한다**

같은 파일 §9.2 결정표에서

```
| root 관리번호 여러 개 | 없음 | `REVIEW_REQUIRED` |
| 일반·집합 또는 purpose pair 혼재 | 없음 | `REVIEW_REQUIRED` |
```

두 행을 다음 다섯 행으로 바꾼다.

```
| root 관리번호 여러 개, LDAREG 근거 root 0개 또는 2개 이상 | 없음 | `REVIEW_REQUIRED` |
| root 관리번호 여러 개, LDAREG 근거 root 정확히 1개, 그 root의 표제부 행이 공식 다세대 pair | `LDAREG` | 선택 root의 물건지×PNU 대지권 합계. 나머지 root는 `대지권 무관 동`으로 제외 |
| 단일 root에서 일반·집합 또는 purpose pair 혼재 | 없음 | `REVIEW_REQUIRED` |
| 공식 `2 / 02000 / 공동주택` pair, 부속용도 `다세대주택` 토큰 없음, 지상 층수 ≤ 4 이고 연면적 ≤ 660㎡ | `LDAREG` | 다세대주택으로 인정 |
| 공식 `2 / 02000 / 공동주택` pair, 토큰 없고 지상 층수 ≥ 5 또는 연면적 > 660㎡ 또는 두 값 결측·파싱 실패 | 없음 | `REVIEW_REQUIRED` |
```

결정표 아래에 근거 단락을 추가한다.

```
복수 root에서 대장 구분이 갈리는 것은 정상적인 물리 상태이므로 혼재로 보지 않는다. 기존
"혼재 → REVIEW" 규칙은 **단일 root 안에서의 혼재**로 범위를 좁혀 그대로 유지한다.

`02000 공동주택` 규모 기준의 두 대용값은 모두 보수적인 방향이다. `totArea`(연면적)는 지하·비주거를
포함하므로 주택 바닥면적 합계 이상이고, `grndFlrCnt`(지상 층수)는 주택으로 쓰는 층수 이상이다.
따라서 연립주택(660㎡ 초과)과 아파트(5개 층 이상)는 이 경로를 통과할 수 없으며, 위 표의
`연립주택·아파트·다중주택 → REVIEW_REQUIRED` 행과 충돌하지 않는다. 부속용도 `다세대주택` 토큰이
있는 건물은 규모 검사 없이 그대로 통과한다 — 규모 기준은 토큰을 대체하지 않고 보완한다.
```

- [ ] **Step 4: §10.4 LDAREG root 축을 교체한다**

같은 파일에서

```
- LDAREG 호실 매칭의 root 축은 연결된 모든 base title의 exact
  `mgmBldrgstPk` self 집합이다. 이 집합이 정확히 하나가 아니면 적용하지 않는다.
```

를 다음으로 바꾼다.

```
- LDAREG 호실 매칭의 root 축은 연결된 모든 base title의 exact `mgmBldrgstPk` self 집합에서
  **LDAREG 행 근거를 가진 root만 남긴 부분집합**이다. 이 부분집합이 정확히 하나가 아니면
  적용하지 않는다. 근거 판정은 같은 실행의 LDAREG 응답과 EXPOS 전유부의 root 귀속으로만
  하며, 행 수·비율값·건물명 유사도로 추정하지 않는다. BASIS/EXPOS closure의 accepted root는
  이 부분집합이 아니라 self 집합 전체다.
```

- [ ] **Step 5: §12.3 보조 상관 차단 조건을 교체한다**

같은 파일에서

```
서로 다른 동/건물명, 복수 root, 같은 `층+호` 중복
```

를 다음으로 바꾼다.

```
서로 다른 동/건물명, 선택된 대지권 대상 root 밖의 root 근거, 같은 `층+호` 중복
```

- [ ] **Step 6: §12.4 매칭 순서 2단계를 교체한다**

같은 파일에서

```
2. 전유부 root identity와 scope root identity 일치
```

를 다음으로 바꾼다.

```
2. 전유부 root identity가 **선택된 대지권 대상 root**와 일치
```

- [ ] **Step 7: 개정안 문서 상태를 갱신한다**

`docs/2026-07-30-multi-root-parcel-design-revision.md`의 5행

```
상태: **승인됨 (2026-07-30). 코드 변경은 아직 없음 — 구현 계획 작성 단계.**
```

를 다음으로 바꾼다.

```
상태: **구현됨 (2026-07-30). 원 설계 §9.1·§9.2·§10.4·§12.3·§12.4 에 반영 완료.**
구현 계획: [`2026-07-30-multi-root-land-right-root-election-implementation-plan.md`](./2026-07-30-multi-root-land-right-root-election-implementation-plan.md)
```

같은 문서 §7 "코드" 표 아래에 실제 구현에서 드러난 두 가지를 추가한다.

```
구현 중 확정한 사항 두 가지:

- **선출 시점.** 선출에는 LDAREG·EXPOS·BASIS 응답이 필요하고 그 조회는 원래 LDAREG 분기에서
  일어난다. 따라서 표제부 root가 여럿일 때만 공통 gate **앞에** base PNU 한정 선출 pre-pass를
  넣고, 그 결과 scan을 LDAREG 분기에서 재사용한다. 같은 endpoint를 두 번 조회하지 않는다.
- **선출 실패는 FAILED가 아니다.** 선출용 scan 실패·불완전·근거 불확정은 모두 기존 복수 root
  `REVIEW_REQUIRED` 경로로 닫는다. 새 `FAILED` terminal을 만들면 278-anchor 게이트의 기대값이
  움직인다.
```

- [ ] **Step 8: 문서와 코드가 어긋나지 않는지 확인한다**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && grep -n "모든 행이 같은 root 관리번호 계열인지 확인\|이 집합이 정확히 하나가 아니면 적용하지 않는다\|복수 root, 같은" docs/2026-07-23-land-area-sync-design.md
```
Expected: 출력 없음 (현행 문구가 남아 있지 않다).

- [ ] **Step 9: 전체 테스트 + 타입 체크 최종 확인**

Run:
```bash
cd /Users/inju/workspace/tonghari/tonghari-api && npx tsc --noEmit && npm test
```
Expected: 타입 오류 0, 테스트 전건 PASS.

- [ ] **Step 10: 커밋**

```bash
cd /Users/inju/workspace/tonghari/tonghari-api && git add docs/2026-07-23-land-area-sync-design.md docs/2026-07-30-multi-root-parcel-design-revision.md && git commit -m "docs(land-area): 한 지번 복수 root 개정을 원 설계에 반영한다"
```

- [ ] **Step 11: 브랜치를 정리한다**

전역 규칙대로 작업 브랜치에서 먼저 `main`을 머지해 최신화하고, 그다음 `main`으로 올린다.

```bash
cd /Users/inju/workspace/tonghari/tonghari-api && git fetch origin && git merge origin/main
```

```bash
cd /Users/inju/workspace/tonghari/tonghari-api && npx tsc --noEmit && npm test
```

```bash
cd /Users/inju/workspace/tonghari/tonghari-api && git checkout main && git merge --ff-only feat/multi-root-land-right-root-election && git push origin main
```

```bash
cd /Users/inju/workspace/tonghari/tonghari-api && git branch -d feat/multi-root-land-right-root-election && git branch -d docs/multi-root-parcel-revision
```

---

## 검증 후속 (코드 변경 아님)

구현이 끝나도 다음은 **사용자 승인 후에만** 한다. 이 계획의 task가 아니다.

1. **DEV 캡처 재실행.** 278-anchor 게이트를 다시 돌려 791-2282가 `CAPTURED`로 바뀌는지,
   `scannedPnuCount` 297→298, `capturedEvidencePropertyUnitCount` 406→416인지 확인한다.
   워크플로 실행은 외부 API 실호출·비용이 발생하므로 사용자가 지시할 때만 실행한다.
2. **301/429 전건 PASS는 이 작업만으로 달성되지 않는다.** 745-62(Phase 0-S 합성 fixture가 실제 조합
   PNU 선점, clone-gate BLOCKER B3)와 791-2155(상가+주택 혼합, LDAREG 반층 표기 `4.5`/`401`)가
   남는다. 둘 다 코드가 아니라 판단이 필요한 건이다.

## 범위 밖 (의도적으로 남기는 것)

- **`land-area-phase0-capture.ts`의 복수 root 처리.** `hasPhase0GenericLdaregTitleEvidence`는
  `rootIdentityCount === 1 && rows.length === 1`을 요구하므로 복수 root anchor에서
  `HOUSING_CLASSIFICATION_ALLOWLIST_MISMATCH`로 닫힌다. 이 경로는 **278-anchor 게이트의 임계
  경로가 아니다** — 그 게이트는 `src/operations/development-land-area-evidence-capture.ts`가
  `runLandAreaSyncJob`을 돌려서 만든다. Phase 0 fixture capture를 복수 root anchor에 다시 돌릴
  필요가 생기면 별도로 판단한다. (Task 1에서 분류 입력 필드는 이미 맞춰 둔다.)
- **규모 값의 `externalScopeDigest` 편입.** digest 버전 고정 제약 때문에 하지 않는다. 분류에
  쓰는 값이 digest에 없다는 provenance 간극은 남는다 — 필요하면 `@4` bump를 별도 개정으로 다룬다.
- **제외된 동에 물건지가 있는 경우.** 현재 미아7에는 없다. 생기면 그때 별도 판단한다(개정안 §5).
- **동(棟) 엔티티 개편.** 개정안 §5가 명시적으로 비범위로 둔 선행과제다.
- **분모 분할.** 두 동이 같은 분모(대지 전체 면적)를 공유한다. 건물별 분모 분할 개념을 도입하지
  않는다(개정안 §5).
