/**
 * LAND_AREA_SYNC mock-provider 통합 테스트 (DESIGN §19.2 / Phase 2 Exit §18).
 *
 * 실 adapter + 주입 httpClient 로 discovery 전 구간(scan→DB resolver→gate→분류→매칭→
 * preview→apply barrier)을 관통시켜, 유닛 테스트로는 보증할 수 없는 오케스트레이션 불변을
 * 검증한다:
 *  - 필수 scan 하나라도 실패하면 apply RPC 0회(전 구간).
 *  - LINKED 다중 base 의 non-anchor scan 을 gate 전에 완료하고, 한 page 실패/불일치면 apply 0.
 *  - reverse-only(부속-only) anchor 전 구간, COMPLETE_ZERO 5종 outcome 분리(§10.7·§14.2).
 *  - terminal 후 늦은 callback 차단, building_unit/property_unit 직접 INSERT 경로 부재.
 *  - 모든 Building HUB/V-World strict 요청이 HTTPS.
 *
 * 중복 회피: adapter pagination·bylot·gate 판정·ratio/identity/normalizer/matcher·service
 * apply-lineage 등 유닛 커버 항목은 재작성하지 않고, 통합 수준 갭만 채운다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { runLandAreaSyncJob, type LandAreaSyncDeps } from '../src/services/land-area-sync/service';
import { HOUSING_PURPOSE_ALLOWLIST } from '../src/services/land-area-sync/housing-purpose-allowlist.fixture';
import type { StrictScan, LdaregRow } from '../src/types/land-area-sync.types';
import {
    ANCHOR,
    SIBLING,
    PK,
    DETACHED,
    MULTIPLEX,
    LDAREG_PROPERTY,
    buildIntegrationDeps,
    emptySpy,
    noEvidence,
    linked,
    hubKey,
    titleRow,
    attachedRow,
    ldaregRow,
    exposRow,
    ladfrlRow,
    httpError,
    hubEnv,
    ladfrlEnv,
    ldaregEnv,
    type ProviderRoutes,
    type Spy,
} from './land-area-sync-mock-provider';

async function run(config: {
    resolver: unknown;
    routes: ProviderRoutes;
    applyResult?: { data: unknown; error: { message: string; code?: string } | null };
    propertyUnits?: unknown[];
    buildingUnits?: unknown[];
    currentLandTuples?: unknown[];
    /** 특정 scan 을 강제로 FAILED/INCOMPLETE 로 만들기 위한 주입(경계 테스트 전용). */
    scanOverrides?: Partial<LandAreaSyncDeps['scans']>;
    spy: Spy;
}) {
    const { deps, calls } = buildIntegrationDeps(config);
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    return { calls, spy: config.spy };
}

// ── 1. 관통 + HTTPS 전수 (reverse-only/부속-only anchor 전 구간) ─────

test('no-cache single LADFRL discovery: scan→resolver→gate→분류→preview→confirmation 관통, apply 0, 모든 요청 HTTPS', async () => {
    const spy = emptySpy();
    const { calls } = await run({
        resolver: noEvidence(),
        routes: {
            getBrTitleInfo: () => hubEnv([titleRow(PK, '0', DETACHED)]),
            getBrAtchJibunInfo: () => hubEnv([]), // ATTACHED_COMPLETE_ZERO
            ladfrlList: () => ladfrlEnv([ladfrlRow(ANCHOR, '100.5')]),
        },
        spy,
    });
    // 부속-only anchor(자체 title + bylot0 + ATTACHED_COMPLETE_ZERO) → SINGLE_SCOPE_CONFIRMATION_REQUIRED.
    assert.equal(spy.freezeCalls, 1, 'snapshot 은 정확히 1회 CAS 고정');
    assert.equal(spy.applyCalls, 0, 'LADFRL discovery 는 확인 전 apply 하지 않는다');
    assert.equal(spy.terminalCalls[0].scopeState, 'SINGLE_SCOPE_CONFIRMATION_REQUIRED');
    assert.equal(spy.terminalCalls[0].outcome, 'REVIEW_REQUIRED');
    // 모든 strict 요청은 HTTPS(§10.3·§10.6 — inspector HTTP 상수 재사용 금지).
    assert.ok(calls.length > 0);
    assert.ok(calls.every((c) => c.url.startsWith('https://')), 'every request must be HTTPS');
    // TITLE_ONLY 정책 → basis endpoint 는 호출되지 않는다(BASIS_COMPLETE_ZERO 소비 안 함).
    assert.ok(!calls.some((c) => c.endpoint === 'getBrBasisOulnInfo'), 'basis 는 TITLE_ONLY 에서 미호출');
    // LADFRL 분기이므로 ldareg 는 호출되지 않는다.
    assert.ok(!calls.some((c) => c.endpoint === 'ldaregList'));
});

// ── 2. 필수 scan 실패 매트릭스 — 전 구간 apply 0 ───────────────────

test('필수 scan 실패는 전 구간에서 apply RPC 0회 + FAILED (title/ladfrl/ldareg/expos)', async () => {
    // (a) title(gate 필수) 실패 → FAILED
    {
        const spy = emptySpy();
        await run({ resolver: noEvidence(), routes: { getBrTitleInfo: () => httpError(503) }, spy });
        assert.equal(spy.applyCalls, 0, 'title 실패 apply 0');
        assert.equal(spy.terminalCalls[0].status, 'FAILED');
    }
    // (b) LADFRL 분기 필수 ladfrl 실패 → FAILED
    {
        const spy = emptySpy();
        await run({
            resolver: noEvidence(),
            routes: {
                getBrTitleInfo: () => hubEnv([titleRow(PK, '0', DETACHED)]),
                ladfrlList: () => httpError(503),
            },
            spy,
        });
        assert.equal(spy.applyCalls, 0, 'ladfrl 실패 apply 0');
        assert.equal(spy.terminalCalls[0].status, 'FAILED');
    }
    // (c) LDAREG 분기 필수 ldareg 실패 → FAILED (single-PNU LINKED 다세대)
    {
        const spy = emptySpy();
        await run({
            resolver: linked([ANCHOR]),
            routes: {
                getBrTitleInfo: () => hubEnv([titleRow(PK, '0', MULTIPLEX)]),
                ldaregList: () => httpError(503),
                ladfrlList: () => ladfrlEnv([ladfrlRow(ANCHOR)]),
            },
            spy,
        });
        assert.equal(spy.applyCalls, 0, 'ldareg 실패 apply 0');
        assert.equal(spy.terminalCalls[0].status, 'FAILED');
    }
    // (d) LDAREG 분기 필수 expos 실패 → FAILED
    {
        const spy = emptySpy();
        await run({
            resolver: linked([ANCHOR]),
            routes: {
                getBrTitleInfo: () => hubEnv([titleRow(PK, '0', MULTIPLEX)]),
                ldaregList: () => ldaregEnv([ldaregRow(ANCHOR)]),
                ladfrlList: () => ladfrlEnv([ladfrlRow(ANCHOR)]),
                getBrExposInfo: () => httpError(503),
            },
            spy,
        });
        assert.equal(spy.applyCalls, 0, 'expos 실패 apply 0');
        assert.equal(spy.terminalCalls[0].status, 'FAILED');
    }
});

// ── 3. LINKED 다중 base: 비앵커 base page 실패 → 전체 FAILED, apply 0 ─

test('LINKED 다중 base 중 non-anchor title page 실패 시 전체 FAILED, apply 0, 비앵커 base 도 gate 전 scan', async () => {
    const spy = emptySpy();
    const { calls } = await run({
        resolver: linked([ANCHOR, SIBLING], undefined, {
            linkedBasePnus: [ANCHOR, SIBLING],
        }),
        routes: {
            getBrTitleInfo: (keyPnu) =>
                keyPnu === hubKey(SIBLING) ? httpError(503) : hubEnv([titleRow(PK, '1', MULTIPLEX)]),
            getBrAtchJibunInfo: () => hubEnv([]),
        },
        spy,
    });
    assert.equal(spy.applyCalls, 0, '한 base 실패면 전체 apply 0');
    assert.equal(spy.terminalCalls[0].status, 'FAILED');
    // 비앵커 base(SIBLING)의 title 을 gate 전에 실제로 조회했다(전 base scan 완료 요건).
    assert.ok(
        calls.some((c) => c.endpoint === 'getBrTitleInfo' && c.keyPnu === hubKey(SIBLING)),
        'non-anchor base 도 scan 되어야 한다'
    );
});

// ── 4. LINKED 다중 base: 비앵커 분류 불일치 → REVIEW_REQUIRED, apply 0 ─

test('LINKED 다중 base 의 non-anchor 분류 불일치(일반+집합 혼재) → REVIEW_REQUIRED, apply 0', async () => {
    const spy = emptySpy();
    const { calls } = await run({
        resolver: linked([ANCHOR, SIBLING], undefined, {
            linkedBasePnus: [ANCHOR, SIBLING],
        }),
        routes: {
            getBrTitleInfo: (keyPnu) =>
                keyPnu === hubKey(SIBLING) ? hubEnv([titleRow(PK, '1', DETACHED)]) : hubEnv([titleRow(PK, '1', MULTIPLEX)]),
            getBrAtchJibunInfo: (keyPnu) =>
                keyPnu === hubKey(ANCHOR) ? hubEnv([attachedRow(ANCHOR, SIBLING)]) : hubEnv([]),
        },
        spy,
    });
    assert.equal(spy.applyCalls, 0, '분류 불일치면 apply 0');
    assert.equal(spy.terminalCalls[0].scopeState, 'REVIEW_REQUIRED');
    assert.equal(spy.terminalCalls[0].outcome, 'REVIEW_REQUIRED');
    assert.ok(calls.some((c) => c.endpoint === 'getBrTitleInfo' && c.keyPnu === hubKey(SIBLING)));
});

// ── 5. LDAREG LINKED 다세대 multi-PNU: 한 PNU 필수 page 실패 → 전체 FAILED, apply 0 ─

test('LDAREG LINKED 다세대: 한 PNU 의 ldareg page 실패 시 전체 FAILED, apply 0 (부분합 미적용)', async () => {
    const spy = emptySpy();
    const { calls } = await run({
        resolver: linked([ANCHOR, SIBLING]),
        routes: {
            getBrTitleInfo: () => hubEnv([titleRow(PK, '1', MULTIPLEX)]),
            getBrAtchJibunInfo: (keyPnu) =>
                keyPnu === hubKey(ANCHOR) ? hubEnv([attachedRow(ANCHOR, SIBLING)]) : hubEnv([]),
            ldaregList: (keyPnu) => (keyPnu === SIBLING ? httpError(503) : ldaregEnv([ldaregRow(ANCHOR)])),
            ladfrlList: (keyPnu) => ladfrlEnv([ladfrlRow(keyPnu)]),
            getBrExposInfo: () => hubEnv([exposRow()]),
        },
        propertyUnits: [LDAREG_PROPERTY],
        spy,
    });
    assert.equal(spy.applyCalls, 0, 'multi-PNU 필수 page 실패 → apply 0');
    assert.equal(spy.terminalCalls[0].status, 'FAILED');
    assert.ok(calls.some((c) => c.endpoint === 'ldaregList' && c.keyPnu === SIBLING), '비앵커 PNU 의 ldareg 도 조회');
});

test('실측형 LINKED: base·attached에 나뉜 EXPOS와 property를 full scope에서 읽고 LDAREG identity별 1회 투영한다', async () => {
    const spy = emptySpy();
    const attachedProperty = {
        ...LDAREG_PROPERTY,
        id: '22222222-2222-4222-8222-222222222222',
        pnu: SIBLING,
        ho: '201',
    };
    const { calls } = await run({
        resolver: linked([ANCHOR, SIBLING], [
            {
                propertyUnitId: LDAREG_PROPERTY.id,
                pnu: ANCHOR,
                buildingUnitId: null,
            },
            {
                propertyUnitId: attachedProperty.id,
                pnu: SIBLING,
                buildingUnitId: null,
            },
        ]),
        routes: {
            // linkedBasePnus=[ANCHOR]이므로 title/bylot/attached gate scan은 base만 수행한다.
            getBrTitleInfo: () => hubEnv([titleRow(PK, '1', MULTIPLEX)]),
            getBrAtchJibunInfo: () => hubEnv([attachedRow(ANCHOR, SIBLING)]),
            // branch strict scan은 full linkedPnus를 유지한다.
            ldaregList: (pnu) =>
                ldaregEnv([
                    ldaregRow(pnu, {
                        ldaQotaRate: '24.6/364.6',
                    }),
                    ldaregRow(pnu, {
                        agbldgSn: '2',
                        buldFloorNm: '2층',
                        buldHoNm: '201',
                        ldaQotaRate: '10/364.6',
                    }),
                ]),
            ladfrlList: (pnu) =>
                ladfrlEnv([
                    ladfrlRow(pnu, pnu === ANCHOR ? '177.6' : '187'),
                ]),
            getBrExposInfo: (keyPnu) =>
                keyPnu === hubKey(ANCHOR)
                    ? hubEnv([exposRow()])
                    : hubEnv([
                          exposRow(PK, '2층', '201', SIBLING),
                      ]),
        },
        propertyUnits: [LDAREG_PROPERTY, attachedProperty],
        applyResult: { data: { outcome: 'APPLIED', issues: [] }, error: null },
        spy,
    });

    assert.ok(
        !calls.some(
            (call) =>
                call.endpoint === 'getBrTitleInfo' &&
                call.keyPnu === hubKey(SIBLING)
        ),
        'attached-only PNU는 title/base 분류 scan에서 제외'
    );
    assert.ok(
        calls.some(
            (call) => call.endpoint === 'ldaregList' && call.keyPnu === SIBLING
        ),
        'LDAREG는 full linked scope 조회'
    );
    assert.ok(
        calls.some(
            (call) => call.endpoint === 'getBrExposInfo' && call.keyPnu === hubKey(SIBLING)
        ),
        'attached expos도 strict 조회'
    );
    assert.deepEqual(spy.readScopes, [
        {
            reader: 'buildingUnits',
            pnus: [ANCHOR, SIBLING],
        },
        {
            reader: 'propertyUnits',
            pnus: [ANCHOR, SIBLING],
        },
    ]);
    assert.equal(spy.applyCalls, 1);

    const params = spy.lastApplyParams as {
        p_items: Array<{
            propertyUnitId: string;
            expectedTargetPnus: string[];
            components: Array<{
                targetPnu: string;
                sourceIdentity: string;
                sourceRecord: { pnu: string };
            }>;
        }>;
    };
    assert.equal(params.p_items.length, 2);
    for (const item of params.p_items) {
        assert.deepEqual(item.expectedTargetPnus, [ANCHOR, SIBLING].sort());
        assert.equal(item.components.length, 2, 'PNU별 provenance 보존');
        assert.equal(
            new Set(
                item.components.map(
                    (component) => component.sourceIdentity
                )
            ).size,
            1,
            'target PNU 독립 identity'
        );
        assert.deepEqual(
            item.components
                .map((component) => component.sourceRecord.pnu)
                .sort(),
            [ANCHOR, SIBLING].sort()
        );
    }

    const snapshot = spy.frozenSnapshots[0].scopeSnapshot;
    assert.deepEqual(
        snapshot.proposedLandAreas
            .slice()
            .sort((left, right) =>
                left.propertyUnitId.localeCompare(right.propertyUnitId)
            ),
        [
            {
                propertyUnitId: LDAREG_PROPERTY.id,
                landArea: '24.6',
            },
            {
                propertyUnitId: attachedProperty.id,
                landArea: '10',
            },
        ].sort((left, right) =>
            left.propertyUnitId.localeCompare(right.propertyUnitId)
        )
    );
    assert.deepEqual(snapshot.ladfrlAreaEvidence, {
        version: 'land-area-sync.ladfrl-scope.v1',
        parcels: [
            { pnu: ANCHOR, area: '177.6' },
            { pnu: SIBLING, area: '187' },
        ].sort((a, b) => a.pnu.localeCompare(b.pnu)),
        totalArea: '364.6',
    });
    assert.equal(snapshot.replicationEvidence?.canonicalSourcePnu, ANCHOR);
    assert.equal(snapshot.replicationEvidence?.rowCount, 2);
    assert.equal(snapshot.replicationEvidence?.exactReplica, true);
});

test('LDAREG scope의 attached EXPOS가 다른 PNU row를 반환하면 apply 없이 FAILED로 닫는다', async () => {
    const spy = emptySpy();
    await run({
        resolver: linked([ANCHOR, SIBLING]),
        routes: {
            getBrTitleInfo: () =>
                hubEnv([titleRow(PK, '1', MULTIPLEX)]),
            getBrAtchJibunInfo: (keyPnu) =>
                keyPnu === hubKey(ANCHOR)
                    ? hubEnv([attachedRow(ANCHOR, SIBLING)])
                    : hubEnv([]),
            ldaregList: (pnu) =>
                ldaregEnv([ldaregRow(pnu)]),
            ladfrlList: (pnu) =>
                ladfrlEnv([
                    ladfrlRow(
                        pnu,
                        pnu === ANCHOR ? '177.6' : '187'
                    ),
                ]),
            getBrExposInfo: () =>
                hubEnv([
                    exposRow(PK, '3층', '301', ANCHOR),
                ]),
        },
        propertyUnits: [LDAREG_PROPERTY],
        spy,
    });

    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.terminalCalls[0].status, 'FAILED');
    assert.equal(spy.terminalCalls[0].scopeState, 'FAILED');
    assert.deepEqual(spy.terminalIssues[0], [
        {
            code: 'PROVIDER_PROTOCOL_ERROR',
            targetPnu: SIBLING,
        },
    ]);
});

// ── 6. COMPLETE_ZERO 5종 outcome 분리 (§10.7·§14.2) ────────────────

test('TITLE_COMPLETE_ZERO → REVIEW_REQUIRED(분류 불가), apply 0', async () => {
    const spy = emptySpy();
    await run({ resolver: noEvidence(), routes: { getBrTitleInfo: () => hubEnv([]) }, spy });
    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.terminalCalls[0].scopeState, 'REVIEW_REQUIRED');
    assert.ok(
        spy.terminalIssues[0].some((i) => i.code === 'BUILDING_CLASSIFICATION_CONFLICT'),
        'title zero 는 분류 불가 REVIEW'
    );
});

test('ATTACHED_COMPLETE_ZERO(+title bylot0 single) → SINGLE_SCOPE_CONFIRMATION_REQUIRED, apply 0', async () => {
    const spy = emptySpy();
    await run({
        resolver: noEvidence(),
        routes: {
            getBrTitleInfo: () => hubEnv([titleRow(PK, '0', DETACHED)]),
            getBrAtchJibunInfo: () => hubEnv([]),
            ladfrlList: () => ladfrlEnv([ladfrlRow(ANCHOR)]),
        },
        spy,
    });
    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.freezeCalls, 1);
    assert.equal(spy.terminalCalls[0].scopeState, 'SINGLE_SCOPE_CONFIRMATION_REQUIRED');
});

test('LADFRL_COMPLETE_ZERO → COMPLETED+NO_DATA, 기존 tuple 유지, snapshot/apply 0', async () => {
    const spy = emptySpy();
    await run({
        resolver: noEvidence(),
        routes: {
            getBrTitleInfo: () => hubEnv([titleRow(PK, '0', DETACHED)]),
            getBrAtchJibunInfo: () => hubEnv([]),
            ladfrlList: () => ladfrlEnv([]), // LADFRL_COMPLETE_ZERO
        },
        spy,
    });
    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.freezeCalls, 0);
    assert.equal(spy.terminalCalls[0].status, 'COMPLETED');
    assert.equal(spy.terminalCalls[0].outcome, 'NO_DATA');
    assert.equal(spy.terminalCalls[0].scopeState, 'SINGLE_SCOPE_CONFIRMATION_REQUIRED');
});

test('LDAREG_COMPLETE_ZERO(LINKED) → apply RPC 1회·NO_DATA (TITLE/ATTACHED/LADFRL zero 와 분리)', async () => {
    const spy = emptySpy();
    await run({
        resolver: linked([ANCHOR]),
        routes: {
            getBrTitleInfo: () => hubEnv([titleRow(PK, '0', MULTIPLEX)]),
            getBrAtchJibunInfo: () => hubEnv([]),
            ldaregList: () => ldaregEnv([]), // LDAREG_COMPLETE_ZERO
            ladfrlList: () => ladfrlEnv([ladfrlRow(ANCHOR)]),
            getBrExposInfo: () => hubEnv([exposRow()]),
        },
        propertyUnits: [LDAREG_PROPERTY],
        applyResult: { data: { outcome: 'NO_DATA', issues: [] }, error: null },
        spy,
    });
    // LINKED 즉시적용 경로 — LDAREG zero 는 lifecycle 평가용 empty-component item으로 호출.
    assert.equal(spy.applyCalls, 1, 'LDAREG zero 는 apply RPC 1회(NO_DATA)');
    const params = spy.lastApplyParams as {
        p_items: unknown[];
        p_result_summary: { extraIssues: unknown[] };
    };
    assert.deepEqual(params.p_items, [
        {
            propertyUnitId: LDAREG_PROPERTY.id,
            expectedTargetPnus: [ANCHOR],
            components: [],
        },
    ]);
    assert.deepEqual(params.p_result_summary.extraIssues, []);
});

test('BASIS_COMPLETE_ZERO 는 TITLE_ONLY 정책에서 소비되지 않는다(basis endpoint 미호출)', async () => {
    // basis 원천 정책이 TITLE_ONLY 이므로 basis fallback plan 이 빈 배열 → basis scan 자체가 없다.
    // BASIS_COMPLETE_ZERO 의 outcome 분리는 bylot 유닛 테스트(FALLBACK 정책)에서 UNAVAILABLE 로 검증됨.
    const spy = emptySpy();
    const { calls } = await run({
        resolver: noEvidence(),
        routes: {
            getBrTitleInfo: () => hubEnv([titleRow(PK, '0', DETACHED)]),
            ladfrlList: () => ladfrlEnv([ladfrlRow(ANCHOR)]),
        },
        spy,
    });
    assert.ok(!calls.some((c) => c.endpoint === 'getBrBasisOulnInfo'), 'TITLE_ONLY 는 basis 미호출');
});

// ── 7. building_unit/property_unit 직접 INSERT 경로 부재 ───────────

test('전 구간에서 unit 쓰기 경로는 apply RPC 뿐 — building_unit/property_unit 직접 INSERT 0', async () => {
    const spy = emptySpy();
    const { deps } = buildIntegrationDeps({
        resolver: linked([ANCHOR]),
        routes: {
            getBrTitleInfo: () => hubEnv([titleRow(PK, '0', MULTIPLEX)]),
            getBrAtchJibunInfo: () => hubEnv([]),
            ldaregList: () => ldaregEnv([ldaregRow(ANCHOR)]),
            ladfrlList: () => ladfrlEnv([ladfrlRow(ANCHOR)]),
            getBrExposInfo: () => hubEnv([exposRow()]),
        },
        propertyUnits: [LDAREG_PROPERTY],
        applyResult: { data: { outcome: 'APPLIED', issues: [] }, error: null },
        spy,
    });

    // (구조) db 계약에 building_unit/property_unit 을 INSERT/CREATE 하는 메서드가 없다.
    const dbKeys = Object.keys(deps.db);
    assert.ok(
        !dbKeys.some((k) => /insert|create/i.test(k)),
        `db deps 에 insert/create 계열 메서드가 없어야 한다: ${dbKeys.join(',')}`
    );
    // unit 을 만지는 유일한 mutating 경로는 applyRpc(감사되는 SECURITY DEFINER RPC).
    assert.ok(dbKeys.includes('applyRpc'));

    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });

    // (동작) 후보는 read-model 로만 조회되고, unit write 는 apply RPC 정확히 1회로 수렴한다.
    assert.ok(spy.reads.includes('readBuildingUnits'));
    assert.ok(spy.reads.includes('readPropertyUnits'));
    assert.equal(spy.applyCalls, 1, 'unit write 는 apply RPC 1회로만');
    assert.equal(spy.failedCalls.length, 0);
});

// ── 8. 미아7 791-2282: 복수 root(일반 1동 + 집합 1동) end-to-end 회귀 ──────
//
// (DESIGN 2026-07-30 개정, docs/2026-07-30-multi-root-parcel-design-revision.md §2·§6.1)
//
// 실측 anchor: 표제부 self root 가 둘이다 — 일반건축물(01000 단독주택, 관리번호
// 1010111086)과 집합건물(02000 공동주택, 관리번호 1010114204, 지상 4층/연면적 513.06㎡).
// 부속용도 원문이 주용도와 같은 `공동주택`이라 토큰 경로가 성립하지 않고, 법정 규모
// 기준(지상 층수 ≤4, 연면적 ≤660㎡)으로만 다세대주택 인정을 받는다(§6.2).
//
// 엔드포인트별 실측: TITLE 2, ATTACHED 0, EXPOS 10, LDAREG 11(전유 10 + placeholder 1),
// DB 활성 물건지 10호(전부 anchor PNU, 호 identity 있음). BASIS 실측은 12행이지만, 나머지
// 10행(두 root 밑에 달린 자식/집계 lineage 행)은 필드값을 실측하지 않아 값을 지어내지 않고는
// 재현할 수 없다 — 그래서 이 fixture는 실측으로 값이 자명한 두 행만 낸다: 두 root 자신의
// 기본개요 self row(mgmBldrgstPk=root PK, mgmUpBldrgstPk=null — root는 정의상 위 lineage가
// 없으므로 지어낸 값이 아니다). 이 두 행만으로도 closure(buildScopeBasisRootIndex)는 정상
// 경로로 들어간다(both self → continue 분기) — 12행 전체가 아니라 의도적으로 부분 재현임을
// 표시해 둔다. BASIS 를 완전히 비워 COMPLETE_ZERO 로 만드는 것과는 실행 경로가 다르다.
//
// bylotCnt 검증(Step 2): 개정안 §2·§6.1 어디에도 표제부 bylotCnt 원문 값 자체는 실려 있지
// 않다(ATTACHED 행 수 0만 실측). Task 5의 allBylotCountsZero 요구대로 두 표제부 행 모두
// bylotCnt='0'으로 둔다 — 이는 개정안과 상충하지 않는다(모순 문구 없음, Step 1에서 확인).

const MIA7_MULTIPLEX_PK = '1010114204'; // 집합건물(광미빌라) 관리번호
const MIA7_DETACHED_PK = '1010111086'; // 일반건축물(단독주택) 관리번호

// 02000/공동주택 pair — 부속용도 토큰(MULTIPLEX_HOUSE) 없이 법정 규모 기준으로만 인정된다.
const MIA7_MULTIPLEX_PAIR = HOUSING_PURPOSE_ALLOWLIST.find(
    (pair) => pair.requiredOtherPurposeSignal === 'MULTIPLEX_HOUSE'
)!;

// 지상 4층 세대수 10 — 1~3층 3세대씩 + 4층 1세대.
const MIA7_UNITS: ReadonlyArray<{ floor: string; ho: string }> = [
    { floor: '1층', ho: '101' },
    { floor: '1층', ho: '102' },
    { floor: '1층', ho: '103' },
    { floor: '2층', ho: '201' },
    { floor: '2층', ho: '202' },
    { floor: '2층', ho: '203' },
    { floor: '3층', ho: '301' },
    { floor: '3층', ho: '302' },
    { floor: '3층', ho: '303' },
    { floor: '4층', ho: '401' },
];

function mia7DetachedTitleRow(): Record<string, unknown> {
    return titleRow(MIA7_DETACHED_PK, '0', DETACHED, { etcPurps: '단독주택' });
}

function mia7MultiplexTitleRow(): Record<string, unknown> {
    // grndFlrCnt/totArea 가 법정 규모 기준(≤4층·≤660㎡)을 충족해야 다세대주택으로 인정된다.
    return titleRow(MIA7_MULTIPLEX_PK, '0', MIA7_MULTIPLEX_PAIR, {
        grndFlrCnt: '4',
        totArea: '513.06',
        // 2026-07-30 실측: 부속용도 원문 = 주용도(`공동주택`) — 토큰 경로 불성립, 규모 기준만 통과.
        etcPurps: '공동주택',
    });
}

/**
 * BASIS(getBrBasisOulnInfo) self-root 행 2개 — 실측 12행 중 값이 지어낸 것 없이 확정되는
 * 유일한 부분(§8 상단 코멘트 참고). 두 root 는 정의상 자기 자신을 가리키며 위 lineage 가
 * 없으므로 mgmUpBldrgstPk=null 은 추정이 아니다. BASIS 를 완전히 비우면 closure 판정이
 * loop 자체를 건너뛰는 축퇴 경로를 타므로, 실제로는 이 두 행을 소비하는 경로를 탄다.
 * pnu 는 buildingHubRowsMatchPnu(service.ts LDAREG branch gate) 가 sigunguCd 등 지번
 * 분해 필드 없이도 row→PNU 귀속을 확인하도록 직접 명시한다 — anchor 자신을 스캔한 결과이므로
 * ANCHOR 로 고정하는 것은 추정이 아니다.
 */
function mia7BasisSelfRows(): Array<Record<string, unknown>> {
    return [
        { pnu: ANCHOR, mgmBldrgstPk: MIA7_DETACHED_PK, mgmUpBldrgstPk: null },
        { pnu: ANCHOR, mgmBldrgstPk: MIA7_MULTIPLEX_PK, mgmUpBldrgstPk: null },
    ];
}

// exposRow() 는 mgmUpBldrgstPk 를 받지 않는다. 복수 root 전유부는 self 가 어느 root에
// 귀속되는지가 선출·매칭의 핵심이므로 raw literal 로 명시한다.
function mia7MultiplexExposRows(): Array<Record<string, unknown>> {
    return MIA7_UNITS.map((unit) => ({
        pnu: ANCHOR,
        mgmBldrgstPk: MIA7_MULTIPLEX_PK,
        mgmUpBldrgstPk: null,
        flrNoNm: unit.floor,
        hoNm: unit.ho,
    }));
}

function mia7DetachedExposRow(floor: string, ho: string): Record<string, unknown> {
    return {
        pnu: ANCHOR,
        mgmBldrgstPk: MIA7_DETACHED_PK,
        mgmUpBldrgstPk: null,
        flrNoNm: floor,
        hoNm: ho,
    };
}

function mia7MultiplexLdaregRows(
    units: ReadonlyArray<{ floor: string; ho: string }> = MIA7_UNITS
): Array<Record<string, unknown>> {
    return units.map((unit) =>
        ldaregRow(ANCHOR, {
            agbldgSn: '1',
            buldNm: '광미빌라',
            buldFloorNm: unit.floor,
            buldHoNm: unit.ho,
            // 실측이 아니라 합성값 — 10세대 균등 지분(26.4×10=264)으로 내부 정합만 맞춘 것.
            ldaQotaRate: '26.4/264',
            clsSeCode: '0',
            clsSeCodeNm: '유효',
        })
    );
}

/** LDAREG 11행 = 전유 10 + placeholder 1(ratio 없음·동층호실 전부 0·CURRENT). */
function mia7PlaceholderLdaregRow(): Record<string, unknown> {
    return ldaregRow(ANCHOR, {
        agbldgSn: '1',
        buldNm: '광미빌라',
        buldDongNm: '0000',
        buldFloorNm: '0000',
        buldHoNm: '0000',
        buldRoomNm: '0000',
        ldaQotaRate: '',
        clsSeCode: '0',
        clsSeCodeNm: '유효',
    });
}

interface Mia7PropertyUnit {
    id: string;
    unionId: string;
    buildingUnitId: null;
    pnu: string;
    isDeleted: boolean;
    dong: null;
    ho: string;
}

/** DB 활성 물건지 10호 — 전부 anchor PNU, 전부 호 identity 있음(실측과 일치). */
function mia7PropertyUnits(): Mia7PropertyUnit[] {
    return MIA7_UNITS.map((unit, index) => ({
        id: `99999999-9999-4999-8999-${String(index).padStart(12, '0')}`,
        unionId: 'union-1',
        buildingUnitId: null,
        pnu: ANCHOR,
        isDeleted: false,
        dong: null,
        ho: unit.ho,
    }));
}

/** scanLdareg 를 강제로 FAILED 로 만드는 주입값(테스트 4 전용, HTTP 를 통해 유도하지 않는다). */
const MIA7_LDAREG_SCAN_FAILURE: StrictScan<LdaregRow> = {
    state: 'FAILED',
    issue: {
        kind: 'HTTP_ERROR',
        endpoint: 'ldaregList',
        message: '선출용 LDAREG scan 강제 실패(테스트 주입)',
        httpStatus: 503,
    },
};

/** 선출 성공 → LDAREG 전략으로 apply 까지 도달하는 end-to-end fixture(테스트 1·5 공유). */
function mia7ElectedConfig(spy: Spy) {
    const propertyUnits = mia7PropertyUnits();
    const membership = propertyUnits.map((p) => ({
        propertyUnitId: p.id,
        pnu: p.pnu,
        buildingUnitId: null,
    }));
    return {
        resolver: linked([ANCHOR], membership, { linkedBasePnus: [ANCHOR] }),
        routes: {
            getBrTitleInfo: () => hubEnv([mia7DetachedTitleRow(), mia7MultiplexTitleRow()]),
            getBrAtchJibunInfo: () => hubEnv([]), // ATTACHED 0 — 실측과 일치
            ldaregList: () => ldaregEnv([...mia7MultiplexLdaregRows(), mia7PlaceholderLdaregRow()]),
            getBrExposInfo: () => hubEnv(mia7MultiplexExposRows()),
            getBrBasisOulnInfo: () => hubEnv(mia7BasisSelfRows()), // 실측 12행 중 값이 자명한 두 self-root 행만(mia7BasisSelfRows 참고)
            // '264' 는 실측이 아니라 합성값 — LDAREG 세대별 지분 26.4/264(10세대 × 26.4=264)와
            // 내부 정합을 맞추려고 고른 것이지 토지대장에서 직접 읽은 대지면적이 아니다.
            ladfrlList: () => ladfrlEnv([ladfrlRow(ANCHOR, '264')]),
        },
        propertyUnits,
        applyResult: { data: { outcome: 'APPLIED', issues: [] }, error: null },
        spy,
    };
}

/** spy 로부터 snapshot/terminal 을 뽑아낸다. 성공 apply 경로는 discovery 쪽에서 별도
 * REVIEW terminal 을 쓰지 않으므로(applyRpc 내부 SECURITY DEFINER 가 유일한 terminal 경로,
 * 이 harness 는 그 내부를 mock 하지 않는다) terminal 이 null 인 것 자체가 정상이다. */
function terminalState(spy: Spy) {
    const t = spy.terminalCalls[0];
    return {
        snapshot: spy.frozenSnapshots[0]?.scopeSnapshot ?? null,
        terminal: t
            ? { status: t.status, scopeState: t.scopeState, issues: spy.terminalIssues[0] }
            : null,
    };
}

test('복수 root anchor는 LDAREG 근거 root를 선출해 LDAREG 전략으로 진행한다', async () => {
    const spy = emptySpy();
    await run(mia7ElectedConfig(spy));
    const state = terminalState(spy);

    assert.notEqual(state.snapshot, null);
    assert.equal(state.snapshot?.strategy, 'LDAREG');
    assert.equal(state.terminal?.scopeState !== 'REVIEW_REQUIRED', true);

    // ELECTED 경로가 실제로 apply RPC 까지 도달했는지(단순 "에러 없음"이 아니라 양성 신호로 고정).
    assert.equal(spy.freezeCalls, 1, '스냅샷은 정확히 1회 CAS 고정된다');
    assert.equal(spy.applyCalls, 1, 'blocking 없이 apply RPC 까지 도달해야 한다');
    assert.equal(spy.terminalCalls.length, 0, '성공 apply 경로는 discovery 쪽 REVIEW terminal 을 쓰지 않는다');
});

test('복수 root anchor에서 LDAREG 근거 root가 0개면 기존대로 REVIEW_REQUIRED다', async () => {
    const spy = emptySpy();
    // LDAREG 의 동·층·호를 전유부(floor 1~4층/ho 101~401)와 전혀 겹치지 않게 바꾼다.
    const mismatchedUnits = MIA7_UNITS.map((_, index) => ({
        floor: '9층',
        ho: `9${String(index).padStart(2, '0')}`,
    }));
    await run({
        resolver: linked([ANCHOR]),
        routes: {
            getBrTitleInfo: () => hubEnv([mia7DetachedTitleRow(), mia7MultiplexTitleRow()]),
            getBrAtchJibunInfo: () => hubEnv([]),
            ldaregList: () =>
                ldaregEnv([...mia7MultiplexLdaregRows(mismatchedUnits), mia7PlaceholderLdaregRow()]),
            getBrExposInfo: () => hubEnv(mia7MultiplexExposRows()),
            getBrBasisOulnInfo: () => hubEnv(mia7BasisSelfRows()), // 실측 12행 중 값이 자명한 두 self-root 행만
        },
        spy,
    });
    const state = terminalState(spy);

    assert.equal(state.terminal?.scopeState, 'REVIEW_REQUIRED');
    assert.deepEqual(
        state.terminal?.issues.map((issue) => issue.code),
        ['BUILDING_CLASSIFICATION_CONFLICT']
    );
    assert.equal(spy.applyCalls, 0);
    assert.equal(state.snapshot, null, '선출 실패 경로는 snapshot 을 고정하지 않는다');
});

test('복수 root anchor에서 LDAREG 근거 root가 2개면 기존대로 REVIEW_REQUIRED다', async () => {
    const spy = emptySpy();
    await run({
        resolver: linked([ANCHOR]),
        routes: {
            getBrTitleInfo: () => hubEnv([mia7DetachedTitleRow(), mia7MultiplexTitleRow()]),
            getBrAtchJibunInfo: () => hubEnv([]),
            ldaregList: () =>
                ldaregEnv([
                    ...mia7MultiplexLdaregRows(),
                    // 일반 root(단독주택) 밑에도 전유부 호실 + 대응 LDAREG 행을 붙여 근거를 2개로 만든다.
                    ldaregRow(ANCHOR, {
                        agbldgSn: '1',
                        buldNm: '단독주택동',
                        buldFloorNm: '1층',
                        buldHoNm: '1',
                        ldaQotaRate: '5/264',
                        clsSeCode: '0',
                        clsSeCodeNm: '유효',
                    }),
                    mia7PlaceholderLdaregRow(),
                ]),
            getBrExposInfo: () => hubEnv([...mia7MultiplexExposRows(), mia7DetachedExposRow('1층', '1')]),
            getBrBasisOulnInfo: () => hubEnv(mia7BasisSelfRows()), // 실측 12행 중 값이 자명한 두 self-root 행만
        },
        spy,
    });
    const state = terminalState(spy);

    assert.equal(state.terminal?.scopeState, 'REVIEW_REQUIRED');
    assert.deepEqual(
        state.terminal?.issues.map((issue) => issue.code),
        ['BUILDING_CLASSIFICATION_CONFLICT']
    );
    assert.equal(spy.applyCalls, 0);
});

test('선출용 LDAREG scan이 실패하면 FAILED가 아니라 기존 REVIEW_REQUIRED로 닫는다', async () => {
    const spy = emptySpy();
    // 주입한 FAILED override 가 실제로 실행 경로에서 소비됐는지를 호출 횟수로 고정한다 —
    // 그러지 않으면 override 가 배선 누락·다른 PNU 로의 라우팅 등으로 실제로는 한 번도
    // 불리지 않았는데도 우연히 같은 terminal 이 나와 테스트가 통과할 수 있다.
    let ldaregCalls = 0;
    await run({
        resolver: linked([ANCHOR]),
        routes: {
            getBrTitleInfo: () => hubEnv([mia7DetachedTitleRow(), mia7MultiplexTitleRow()]),
            getBrAtchJibunInfo: () => hubEnv([]),
        },
        scanOverrides: {
            scanLdareg: async () => {
                ldaregCalls += 1;
                return MIA7_LDAREG_SCAN_FAILURE;
            },
        },
        spy,
    });
    const state = terminalState(spy);

    assert.equal(ldaregCalls, 1, '주입한 FAILED scan 이 선출 pre-pass 에서 정확히 1회 소비돼야 한다');
    // status='COMPLETED' 는 이 테스트 이름이 주장하는 "FAILED 가 아니라"를 job 상태 필드로
    // 직접 검증한다 — scopeState/issues 는 REVIEW 판정의 *사유*를 고정할 뿐, writeDiscoveryTerminal
    // 호출 자체가 status:'FAILED' 로 바뀌는 회귀(예: 선출 pre-pass 실패를 곧장 job 실패로
    // 승격시키는 변경)는 별도로 잡아내지 못한다. status 는 그 필드를 독립적으로 고정한다.
    assert.equal(state.terminal?.status, 'COMPLETED');
    assert.equal(state.terminal?.scopeState, 'REVIEW_REQUIRED');
    assert.deepEqual(
        state.terminal?.issues.map((issue) => issue.code),
        ['BUILDING_CLASSIFICATION_CONFLICT']
    );
    assert.equal(spy.applyCalls, 0);
    // 선출용 scan 실패는 job 을 FAILED 로 죽이지 않는다 — INDETERMINATE 로 흡수해 기존
    // 복수 root REVIEW 경로로 되돌아간다(FAILED 였다면 markScopedFailed 가 호출됐을 것).
    assert.equal(spy.failedCalls.length, 0);
});

test('복수 root anchor는 선출 pre-pass 결과를 재사용해 같은 PNU를 두 번 조회하지 않는다', async () => {
    const spy = emptySpy();
    const { calls } = await run(mia7ElectedConfig(spy));

    const ldaregCalls = calls.filter((c) => c.endpoint === 'ldaregList').map((c) => c.keyPnu);
    const exposCalls = calls.filter((c) => c.endpoint === 'getBrExposInfo').map((c) => c.keyPnu);
    const basisCalls = calls.filter((c) => c.endpoint === 'getBrBasisOulnInfo').map((c) => c.keyPnu);

    // ldareg(VWorld)는 keyPnu 가 19자리 PNU 원문 그대로이고, expos/basis(Building HUB)는
    // hubKey 18자리다 — endpoint 별 정확한 표현으로 anchor 가 각 1회씩만 잡혀야 한다.
    // 재사용이 깨지면(선출 pre-pass 와 LDAREG branch 가 각자 다시 조회하면) 배열 길이가 늘어난다.
    assert.deepEqual(ldaregCalls, [ANCHOR]);
    assert.deepEqual(exposCalls, [hubKey(ANCHOR)]);
    assert.deepEqual(basisCalls, [hubKey(ANCHOR)]);
    assert.equal(spy.applyCalls, 1, '재사용 검증과 별개로 apply 까지 정상 도달해야 한다');
});
