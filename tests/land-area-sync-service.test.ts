import assert from 'node:assert/strict';
import test from 'node:test';
import {
    runLandAreaSyncJob,
    selectSingleLdaregRootIdentity,
    type LandAreaSyncDeps,
} from '../src/services/land-area-sync/service';
import type { LandAreaSyncJobRow } from '../src/services/land-area-sync/repository';
import { HOUSING_PURPOSE_ALLOWLIST } from '../src/services/land-area-sync/housing-purpose-allowlist.fixture';
import type {
    BrBasisOulnRow,
    BrExposRow,
    BrTitleRow,
    LadfrlRow,
    LdaregRow,
    StrictScan,
} from '../src/types/land-area-sync.types';
import type { LandAreaSyncIssue } from '../src/types/land-area-sync-job.types';

const ANCHOR = '1168010100107360024';
const PROP_ID = '11111111-1111-4111-8111-111111111111';
const PK = '1002003004005';
const DETACHED = HOUSING_PURPOSE_ALLOWLIST.find((p) => p.category === 'DETACHED')!;
const MULTIPLEX = HOUSING_PURPOSE_ALLOWLIST.find((p) => p.category === 'MULTIPLEX')!;

function titleComplete(pair: typeof DETACHED): StrictScan<BrTitleRow> {
    return {
        state: 'COMPLETE',
        rows: [{ mgmBldrgstPk: PK, bylotCnt: '0', regstrGbCd: pair.regstrGbCd, mainPurpsCd: pair.mainPurpsCd, mainPurpsCdNm: pair.mainPurpsCdNm }],
        totalCount: 1,
        pagesFetched: 1,
    };
}
function zero<T>(): StrictScan<T> {
    return { state: 'COMPLETE_ZERO', rows: [], totalCount: 0, pagesFetched: 1 };
}
function failed<T>(): StrictScan<T> {
    return { state: 'FAILED', issue: { kind: 'HTTP_ERROR', endpoint: 'getBrTitleInfo', message: 'x', httpStatus: 500 } };
}
function ladfrlComplete(): StrictScan<LadfrlRow> {
    return { state: 'COMPLETE', rows: [{ pnu: ANCHOR, lndpclAr: '100.5' }], totalCount: 1, pagesFetched: 1 };
}
function exposComplete(
    rows: BrExposRow[] = [
        {
            pnu: ANCHOR,
            mgmBldrgstPk: PK,
            dongNm: '101',
            flrNoNm: '3',
            hoNm: '301',
        },
    ]
): StrictScan<BrExposRow> {
    return { state: 'COMPLETE', rows, totalCount: rows.length, pagesFetched: 1 };
}
/** CURRENT 대지권 1건. expos 를 zero 로 두면 matcher 가 NO_CHANGE(PROPERTY_UNIT_NOT_FOUND) 를 낸다. */
function ldaregCurrent(): StrictScan<LdaregRow> {
    return {
        state: 'COMPLETE',
        rows: [{ pnu: ANCHOR, agbldgSn: '1', ldaQotaRate: '10/100.5', clsSeCode: '1', buldDongNm: '101', buldFloorNm: '3', buldHoNm: '301' }],
        totalCount: 1,
        pagesFetched: 1,
    };
}

interface Spy {
    freezeCalls: number;
    applyCalls: number;
    terminalCalls: Array<{ status: string; scopeState: string; outcome: string }>;
    /** writeDiscoveryTerminal 로 넘어간 issues(terminalCalls 와 index 대응). */
    terminalIssues: LandAreaSyncIssue[][];
    failedCalls: string[];
    lastApplyParams: unknown;
    /** resolveScope 로 넘어간 params(p_root_mgm_bldrgst_pks 검증용). */
    resolverParams: Array<{ p_root_mgm_bldrgst_pks: string[] }>;
    /** freezeScopeSnapshot 로 고정된 snapshot 의 scope/membership hash + resolverRootPks. */
    frozenSnapshots: Array<{ scopeHash: string; propertyMembershipHash: string; resolverRootPks: string[] }>;
}

function makeDeps(opts: {
    resolver: unknown;
    scans?: Partial<LandAreaSyncDeps['scans']>;
    applyResult?: { data: unknown; error: { message: string; code?: string } | null };
    membership?: unknown;
    propertyUnits?: unknown[];
    buildingUnits?: unknown[];
    onReadProperty?: () => void;
    /** getScopedJob 이 돌려줄 preview_data 오버라이드(apply job 시나리오용). */
    jobPreviewData?: Record<string, unknown>;
    assertCanaryScopeAllowed?: LandAreaSyncDeps['assertCanaryScopeAllowed'];
    writeDiscoveryTerminalResult?: boolean;
    spy: Spy;
}): LandAreaSyncDeps {
    const { spy } = opts;
    const defaultScans: LandAreaSyncDeps['scans'] = {
        scanTitle: async () => titleComplete(DETACHED),
        scanAttached: async () => zero(),
        scanBasis: async () => zero(),
        scanExpos: async () => exposComplete(),
        scanLadfrl: async () => ladfrlComplete(),
        scanLdareg: async () => zero<LdaregRow>(),
    };
    return {
        now: () => new Date('2026-07-23T00:00:00.000Z'),
        assertCanaryScopeAllowed:
            opts.assertCanaryScopeAllowed ?? (() => undefined),
        scans: { ...defaultScans, ...opts.scans },
        db: {
            resolveScope: async (params) => {
                spy.resolverParams.push({ p_root_mgm_bldrgst_pks: params.p_root_mgm_bldrgst_pks });
                return { data: opts.resolver, error: null };
            },
            applyRpc: async (params) => {
                spy.applyCalls += 1;
                spy.lastApplyParams = params;
                return opts.applyResult ?? { data: { outcome: 'NO_DATA', issues: [] }, error: null };
            },
            getScopedJob: async (): Promise<LandAreaSyncJobRow> => ({
                id: 'job-1',
                union_id: 'union-1',
                status: 'PROCESSING',
                progress: 0,
                preview_data: opts.jobPreviewData ?? { landAreaSync: { schemaVersion: 2, anchorPnu: ANCHOR, sourceDiscoveryJobId: null } },
                created_at: '', updated_at: '', error_log: null,
            }),
            freezeScopeSnapshot: async (_j, _u, patch) => {
                spy.freezeCalls += 1;
                spy.frozenSnapshots.push({
                    scopeHash: patch.scopeSnapshot.scopeHash,
                    propertyMembershipHash: patch.scopeSnapshot.propertyMembershipHash,
                    resolverRootPks: patch.scopeSnapshot.resolverRootPks,
                });
                return true;
            },
            writeDiscoveryTerminal: async (_j, _u, input) => {
                spy.terminalCalls.push({ status: input.status, scopeState: input.scopeState, outcome: input.outcome });
                spy.terminalIssues.push(input.issues);
                return opts.writeDiscoveryTerminalResult ?? true;
            },
            markScopedFailed: async (_j, _u, m) => { spy.failedCalls.push(m); return true; },
            readBuildingUnits: async () =>
                (opts.buildingUnits ?? []) as never,
            readPropertyUnits: async () => {
                opts.onReadProperty?.();
                return (opts.propertyUnits ?? []) as never;
            },
            readCurrentLandTuples: async () => [],
        },
    };
}

function emptySpy(): Spy {
    return {
        freezeCalls: 0,
        applyCalls: 0,
        terminalCalls: [],
        terminalIssues: [],
        failedCalls: [],
        lastApplyParams: null,
        resolverParams: [],
        frozenSnapshots: [],
    };
}

/** apply job(=확인 후속 job) preview_data. sourceDiscoveryJobId+confirmation 이 있으면 isApplyJob=true. */
function applyJobPreview(confirmation: {
    confirmedDiscoveryScopeHash: string;
    confirmedPropertyMembershipHash: string;
    overwriteManualConfirmed?: boolean;
}): Record<string, unknown> {
    return {
        landAreaSync: {
            schemaVersion: 2,
            anchorPnu: ANCHOR,
            sourceDiscoveryJobId: 'disc-1',
            confirmation: { overwriteManualConfirmed: false, ...confirmation },
        },
    };
}

function noEvidence(membership: unknown): unknown {
    return {
        dbState: 'NO_EVIDENCE', rootBuildingIdentities: [PK], componentPnus: [ANCHOR], linkedBasePnus: [], linkedPnus: [],
        linkedEvidenceKeys: [], pendingEvidenceKeys: [], blockingEvidence: [], openUnresolvedEvidenceKeys: [],
        componentTruncated: false, propertyMembership: membership, dbScopeHash: 'db-hash-noevidence',
    };
}
function linked(membership: unknown): unknown {
    return {
        dbState: 'LINKED', rootBuildingIdentities: [PK], componentPnus: [ANCHOR], linkedBasePnus: [ANCHOR], linkedPnus: [ANCHOR],
        linkedEvidenceKeys: ['k1'], pendingEvidenceKeys: [], blockingEvidence: [], openUnresolvedEvidenceKeys: [],
        componentTruncated: false, propertyMembership: membership, dbScopeHash: 'db-hash-linked',
    };
}

const MEMBER = [{ propertyUnitId: PROP_ID, pnu: ANCHOR, buildingUnitId: null }];

test('gate FAILED(title 실패)는 job 을 FAILED 로 종결하고 apply RPC 를 0회 호출한다', async () => {
    const spy = emptySpy();
    const deps = makeDeps({ resolver: noEvidence(MEMBER), scans: { scanTitle: async () => failed<BrTitleRow>() }, spy });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.freezeCalls, 0);
    assert.deepEqual(spy.terminalCalls, [{ status: 'FAILED', scopeState: 'FAILED', outcome: 'FAILED' }]);
});

test('discovery finalizer RPC가 false면 worker finalization 성공으로 반환하지 않는다', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: noEvidence(MEMBER),
        scans: { scanTitle: async () => failed<BrTitleRow>() },
        writeDiscoveryTerminalResult: false,
        spy,
    });
    await assert.rejects(
        runLandAreaSyncJob({
            jobId: 'job-1',
            unionId: 'union-1',
            deps,
        }),
        /discovery worker finalization/
    );
    assert.equal(spy.terminalCalls.length, 1);
});

test('LADFRL discovery(no-cache single)는 snapshot 을 CAS 고정하고 확인 대기(REVIEW), apply 0회', async () => {
    const spy = emptySpy();
    const deps = makeDeps({ resolver: noEvidence(MEMBER), spy });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.freezeCalls, 1, 'snapshot 은 정확히 1회 CAS 고정');
    assert.equal(spy.applyCalls, 0, 'LADFRL discovery 는 apply 하지 않는다');
    assert.equal(spy.terminalCalls.length, 1);
    assert.equal(spy.terminalCalls[0].scopeState, 'SINGLE_SCOPE_CONFIRMATION_REQUIRED');
    assert.equal(spy.terminalCalls[0].outcome, 'REVIEW_REQUIRED');
});

test('분류 conflict라도 DB parcel singleton이고 unit identity가 없으면 LADFRL 확인 후보로 진행한다', async () => {
    const spy = emptySpy();
    let ladfrlCalls = 0;
    const deps = makeDeps({
        resolver: noEvidence(MEMBER),
        scans: {
            scanTitle: async () => ({
                state: 'COMPLETE',
                rows: [
                    {
                        mgmBldrgstPk: PK,
                        bylotCnt: '0',
                        regstrGbCd: '1',
                        mainPurpsCd: '03000',
                        mainPurpsCdNm: '제1종근린생활시설',
                    },
                ],
                totalCount: 1,
                pagesFetched: 1,
            }),
            scanLadfrl: async () => {
                ladfrlCalls += 1;
                return ladfrlComplete();
            },
        },
        propertyUnits: [
            {
                id: PROP_ID,
                unionId: 'union-1',
                buildingUnitId: null,
                pnu: ANCHOR,
                isDeleted: false,
                dong: null,
                ho: null,
            },
        ],
        spy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: 'union-1',
        deps,
    });

    assert.equal(ladfrlCalls, 1);
    assert.equal(spy.freezeCalls, 1);
    assert.equal(spy.applyCalls, 0);
    assert.deepEqual(spy.terminalCalls, [
        {
            status: 'COMPLETED',
            scopeState: 'SINGLE_SCOPE_CONFIRMATION_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
        },
    ]);
});

test('분류 conflict property_unit에 호 identity가 있으면 기존 REVIEW_REQUIRED를 유지한다', async () => {
    const spy = emptySpy();
    let ladfrlCalls = 0;
    const deps = makeDeps({
        resolver: noEvidence(MEMBER),
        scans: {
            scanTitle: async () => ({
                state: 'COMPLETE',
                rows: [
                    {
                        mgmBldrgstPk: PK,
                        bylotCnt: '0',
                        regstrGbCd: '1',
                        mainPurpsCd: '03000',
                        mainPurpsCdNm: '제1종근린생활시설',
                    },
                ],
                totalCount: 1,
                pagesFetched: 1,
            }),
            scanLadfrl: async () => {
                ladfrlCalls += 1;
                return ladfrlComplete();
            },
        },
        propertyUnits: [
            {
                id: PROP_ID,
                unionId: 'union-1',
                buildingUnitId: null,
                pnu: ANCHOR,
                isDeleted: false,
                dong: null,
                ho: '201',
            },
        ],
        spy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: 'union-1',
        deps,
    });

    assert.equal(ladfrlCalls, 0);
    assert.equal(spy.freezeCalls, 0);
    assert.equal(spy.applyCalls, 0);
    assert.deepEqual(spy.terminalCalls, [
        {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
        },
    ]);
    assert.deepEqual(spy.terminalIssues[0], [
        { code: 'BUILDING_CLASSIFICATION_CONFLICT' },
    ]);
});

test('LDAREG LINKED discovery 는 snapshot 을 1회 고정하고 apply RPC 를 정확히 1회 호출한다', async () => {
    const spy = emptySpy();
    let ldaregBasisCalls = 0;
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: {
            scanTitle: async () => titleComplete(MULTIPLEX),
            scanBasis: async () => {
                ldaregBasisCalls += 1;
                return {
                    state: 'COMPLETE',
                    rows: [
                        {
                            pnu: ANCHOR,
                            mgmBldrgstPk: PK,
                        },
                    ],
                    totalCount: 1,
                    pagesFetched: 1,
                };
            },
        },
        applyResult: { data: { outcome: 'NO_DATA', issues: [] }, error: null },
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.freezeCalls, 1, 'CAS 는 1회');
    assert.equal(spy.applyCalls, 1, 'apply 는 정확히 1회');
    assert.equal(
        ldaregBasisCalls,
        1,
        'bylot evidence와 별도로 LDAREG branch basis를 same-run scan한다'
    );
    const params = spy.lastApplyParams as {
        p_result_summary: {
            extraIssues: LandAreaSyncIssue[];
            counts: { basisRows: number };
        };
    };
    assert.deepEqual(params.p_result_summary.extraIssues, []);
    assert.equal(
        params.p_result_summary.counts.basisRows,
        1,
        'branch 전용 basis row가 audit count에 포함된다'
    );
    assert.equal(spy.failedCalls.length, 0);
});

test('LDAREG base+attached는 branch basis를 PNU별 정확히 1회 scan하고 합산 count에 반영한다', async () => {
    const attachedPnu = '1168010100107360025';
    const spy = emptySpy();
    const basisCalls = new Map<string, number>();
    const deps = makeDeps({
        resolver: {
            dbState: 'LINKED',
            rootBuildingIdentities: [PK],
            componentPnus: [ANCHOR, attachedPnu],
            linkedBasePnus: [ANCHOR],
            linkedPnus: [ANCHOR, attachedPnu],
            linkedEvidenceKeys: ['k1'],
            pendingEvidenceKeys: [],
            blockingEvidence: [],
            openUnresolvedEvidenceKeys: [],
            componentTruncated: false,
            propertyMembership: MEMBER,
            dbScopeHash: 'db-hash-linked-attached',
        },
        scans: {
            scanTitle: async () => ({
                ...titleComplete(MULTIPLEX),
                rows: [
                    {
                        ...titleComplete(MULTIPLEX).rows[0],
                        bylotCnt: '1',
                    },
                ],
            }),
            scanAttached: async () => ({
                state: 'COMPLETE',
                rows: [
                    {
                        mgmBldrgstPk: PK,
                        sigunguCd: '11680',
                        bjdongCd: '10100',
                        platGbCd: '0',
                        bun: '0736',
                        ji: '0024',
                        atchSigunguCd: '11680',
                        atchBjdongCd: '10100',
                        atchPlatGbCd: '0',
                        atchBun: '0736',
                        atchJi: '0025',
                    },
                ],
                totalCount: 1,
                pagesFetched: 1,
            }),
            scanBasis: async (pnu) => {
                basisCalls.set(pnu, (basisCalls.get(pnu) ?? 0) + 1);
                return {
                    state: 'COMPLETE',
                    rows: [{ pnu, mgmBldrgstPk: PK }],
                    totalCount: 1,
                    pagesFetched: 1,
                };
            },
            scanExpos: async (pnu) =>
                pnu === ANCHOR ? exposComplete() : zero<BrExposRow>(),
            scanLadfrl: async (pnu) => ({
                state: 'COMPLETE',
                rows: [{ pnu, lndpclAr: '50.25' }],
                totalCount: 1,
                pagesFetched: 1,
            }),
            scanLdareg: async () => zero<LdaregRow>(),
        },
        propertyUnits: [
            {
                id: PROP_ID,
                unionId: 'union-1',
                buildingUnitId: null,
                pnu: ANCHOR,
                isDeleted: false,
                dong: null,
                ho: null,
            },
        ],
        applyResult: {
            data: { outcome: 'NO_DATA', issues: [] },
            error: null,
        },
        spy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: 'union-1',
        deps,
    });

    assert.deepEqual(
        [...basisCalls.entries()].sort(),
        [
            [ANCHOR, 1],
            [attachedPnu, 1],
        ]
    );
    assert.equal(spy.applyCalls, 1);
    const params = spy.lastApplyParams as {
        p_result_summary: { counts: { basisRows: number } };
    };
    assert.equal(params.p_result_summary.counts.basisRows, 2);
});

test('LDAREG LINKED discovery는 resolved scope allowlist 거부 시 apply 0회 + FAILED로 수렴한다', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: { scanTitle: async () => titleComplete(MULTIPLEX) },
        assertCanaryScopeAllowed: () => {
            throw new Error('unallowed sibling PNU');
        },
        spy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: 'union-1',
        deps,
    });

    assert.equal(spy.freezeCalls, 1, 'LINKED snapshot은 apply 전에 고정된다');
    assert.equal(spy.applyCalls, 0, 'allowlist 밖 scope에는 apply RPC를 호출하지 않는다');
    assert.equal(spy.failedCalls.length, 1, 'PROCESSING orphan 없이 FAILED로 닫는다');
    assert.match(spy.failedCalls[0], /허용 대상을 벗어났습니다/);
});

test('LDAREG 필수 scan(ldareg) FAILED 는 write barrier 로 apply 0회 + FAILED', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: { scanTitle: async () => titleComplete(MULTIPLEX), scanLdareg: async () => failed<LdaregRow>() },
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.terminalCalls[0].status, 'FAILED');
});

test('LDAREG 전용 basis scan이 FAILED면 apply 0회 + FAILED로 닫는다', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: {
            scanTitle: async () => titleComplete(MULTIPLEX),
            scanBasis: async () => failed<BrBasisOulnRow>(),
        },
        spy,
    });
    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: 'union-1',
        deps,
    });
    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.terminalCalls[0].status, 'FAILED');
    assert.ok(
        spy.terminalIssues[0].some(
            (issue) => issue.code === 'PROVIDER_PROTOCOL_ERROR'
        )
    );
});

test('LDAREG basis row가 query PNU에 exact 귀속되지 않으면 apply 0회 + FAILED다', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: {
            scanTitle: async () => titleComplete(MULTIPLEX),
            scanBasis: async () => ({
                state: 'COMPLETE',
                rows: [
                    {
                        pnu: '1168010100107360999',
                        mgmBldrgstPk: PK,
                    },
                ],
                totalCount: 1,
                pagesFetched: 1,
            }),
        },
        spy,
    });
    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: 'union-1',
        deps,
    });
    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.terminalCalls[0].status, 'FAILED');
    assert.ok(
        spy.terminalIssues[0].some(
            (issue) => issue.code === 'PROVIDER_PROTOCOL_ERROR'
        )
    );
});

test('LDAREG root selector는 전 base title self가 정확히 하나일 때만 값을 낸다', () => {
    const attached = zero();
    const sharedHigherUp = '9001002003999';
    const oneRoot = [
        {
            pnu: ANCHOR,
            title: {
                ...titleComplete(MULTIPLEX),
                rows: [
                    {
                        ...titleComplete(MULTIPLEX).rows[0],
                        mgmUpBldrgstPk: sharedHigherUp,
                    },
                ],
            },
            attached,
        },
    ];
    assert.equal(selectSingleLdaregRootIdentity(oneRoot), PK);

    const otherRoot = '9001002003004';
    const twoRoots = [
        ...oneRoot,
        {
            pnu: '1168010100107360025',
            title: {
                ...titleComplete(MULTIPLEX),
                rows: [
                    {
                        ...titleComplete(MULTIPLEX).rows[0],
                        mgmBldrgstPk: otherRoot,
                        mgmUpBldrgstPk: sharedHigherUp,
                    },
                ],
            },
            attached,
        },
    ];
    assert.equal(selectSingleLdaregRootIdentity(twoRoots), null);

    const repeatedSelf = [
        ...oneRoot,
        {
            pnu: '1168010100107360025',
            title: {
                ...titleComplete(MULTIPLEX),
                rows: [
                    {
                        ...titleComplete(MULTIPLEX).rows[0],
                        mgmUpBldrgstPk: sharedHigherUp,
                    },
                ],
            },
            attached,
        },
    ];
    assert.equal(
        selectSingleLdaregRootIdentity(repeatedSelf),
        PK,
        '여러 base에서 같은 title self 반복은 dedup한다'
    );
});

test('같은 higher up을 공유하는 복수 title self도 REVIEW로 닫고 branch scan/apply를 하지 않는다', async () => {
    const sibling = '1168010100107360025';
    const otherRoot = '9001002003004';
    const spy = emptySpy();
    let ldaregCalls = 0;
    const deps = makeDeps({
        resolver: {
            dbState: 'LINKED',
            rootBuildingIdentities: [PK, otherRoot],
            componentPnus: [ANCHOR, sibling],
            linkedBasePnus: [ANCHOR, sibling],
            linkedPnus: [ANCHOR, sibling],
            linkedEvidenceKeys: ['k1'],
            pendingEvidenceKeys: [],
            blockingEvidence: [],
            openUnresolvedEvidenceKeys: [],
            componentTruncated: false,
            propertyMembership: [
                ...MEMBER,
                {
                    propertyUnitId:
                        '22222222-2222-4222-8222-222222222222',
                    pnu: sibling,
                    buildingUnitId: null,
                },
            ],
            dbScopeHash: 'db-hash-multi-root',
        },
        scans: {
            scanTitle: async (pnu) => ({
                state: 'COMPLETE',
                rows: [
                    {
                        mgmBldrgstPk:
                            pnu === ANCHOR ? PK : otherRoot,
                        mgmUpBldrgstPk: '9001002003999',
                        bylotCnt: '0',
                        regstrGbCd: MULTIPLEX.regstrGbCd,
                        mainPurpsCd: MULTIPLEX.mainPurpsCd,
                        mainPurpsCdNm: MULTIPLEX.mainPurpsCdNm,
                    },
                ],
                totalCount: 1,
                pagesFetched: 1,
            }),
            scanLdareg: async () => {
                ldaregCalls += 1;
                return zero<LdaregRow>();
            },
        },
        spy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: 'union-1',
        deps,
    });
    assert.equal(spy.applyCalls, 0);
    assert.equal(ldaregCalls, 0);
    assert.equal(spy.terminalCalls[0].scopeState, 'REVIEW_REQUIRED');
});

test('apply RPC EXCEPTION(rollback)은 job 을 FAILED 로 기록한다', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: { scanTitle: async () => titleComplete(MULTIPLEX) },
        applyResult: { data: null, error: { message: 'SCOPE_CHANGED_DURING_SYNC', code: '40001' } },
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.applyCalls, 1);
    assert.equal(spy.failedCalls.length, 1);
    assert.match(spy.failedCalls[0], /apply RPC 실패/);
});

test('terminal/fatal 후 늦은 callback(AbortSignal)은 apply RPC 를 호출하지 못한다', async () => {
    const spy = emptySpy();
    const controller = new AbortController();
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: { scanTitle: async () => titleComplete(MULTIPLEX) },
        // readPropertyUnits 시점에 terminal 이 발생한 것으로 시뮬레이션(abort). 이후 apply 는 차단돼야 한다.
        onReadProperty: () => controller.abort(),
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps, signal: controller.signal });
    assert.equal(spy.applyCalls, 0, 'abort 이후 apply 호출 0회');
});

// ── apply-lineage 경로(확인 후속 job) — Finding 1·2 ─────────────────────────────

test('LADFRL 확인 apply job: 재실행 scope 일치 → apply RPC 정확히 1회, 후속 terminal UPDATE 0회', async () => {
    // 1) discovery 를 먼저 돌려 고정될 scopeHash/membershipHash 를 캡처한다(동일 deps → 결정적).
    const disc = emptySpy();
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps: makeDeps({ resolver: noEvidence(MEMBER), spy: disc }) });
    assert.equal(disc.frozenSnapshots.length, 1, 'discovery 는 snapshot 을 1회 고정');
    const frozen = disc.frozenSnapshots[0];

    // 2) 같은 scope 로 확인된 apply job 을 재실행 → §13.4 barrier 통과 → apply RPC.
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: noEvidence(MEMBER),
        jobPreviewData: applyJobPreview({
            confirmedDiscoveryScopeHash: frozen.scopeHash,
            confirmedPropertyMembershipHash: frozen.propertyMembershipHash,
        }),
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.applyCalls, 1, 'apply RPC 정확히 1회');
    assert.equal(spy.freezeCalls, 0, '이미 고정된 apply job 은 재freeze 하지 않는다');
    assert.equal(spy.terminalCalls.length, 0, 'terminal payload와 receipt는 apply RPC가 원자 기록');
    assert.equal(spy.failedCalls.length, 0);
});

test('LADFRL 확인 apply job: 재실행 scopeHash 불일치 → apply RPC 0회 + REVIEW_REQUIRED', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: noEvidence(MEMBER),
        jobPreviewData: applyJobPreview({
            confirmedDiscoveryScopeHash: 'WRONG-SCOPE-HASH',
            confirmedPropertyMembershipHash: 'WRONG-MEMBERSHIP-HASH',
        }),
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.applyCalls, 0, '불일치 시 apply RPC 0회');
    assert.equal(spy.freezeCalls, 0);
    assert.equal(spy.terminalCalls.length, 1);
    assert.equal(spy.terminalCalls[0].scopeState, 'REVIEW_REQUIRED');
    assert.equal(spy.terminalCalls[0].outcome, 'REVIEW_REQUIRED');
    assert.ok(spy.terminalIssues[0].some((i) => i.code === 'LAND_SCOPE_CONFIRMATION_MISMATCH'), 'mismatch issue 기록');
});

test('LDAREG(single 확인) apply job: 재실행 scope 일치 → apply RPC 정확히 1회, 재freeze 0회, SINGLE_PNU_CONFIRMED', async () => {
    // Finding 1 회귀 가드: 수정 전에는 SINGLE 분기가 isApplyJob 보다 먼저 와서 apply job 이
    // freezeAndOfferConfirmation(재freeze)로 떨어져 apply 0회였다. 수정 후 barrier 를 거쳐 apply 1회.
    const disc = emptySpy();
    await runLandAreaSyncJob({
        jobId: 'job-1', unionId: 'union-1',
        deps: makeDeps({ resolver: noEvidence(MEMBER), scans: { scanTitle: async () => titleComplete(MULTIPLEX) }, spy: disc }),
    });
    assert.equal(disc.terminalCalls[0].scopeState, 'SINGLE_SCOPE_CONFIRMATION_REQUIRED', 'discovery 는 확인 대기');
    const frozen = disc.frozenSnapshots[0];

    const spy = emptySpy();
    const deps = makeDeps({
        resolver: noEvidence(MEMBER),
        scans: { scanTitle: async () => titleComplete(MULTIPLEX) },
        jobPreviewData: applyJobPreview({
            confirmedDiscoveryScopeHash: frozen.scopeHash,
            confirmedPropertyMembershipHash: frozen.propertyMembershipHash,
        }),
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.applyCalls, 1, 'apply RPC 정확히 1회(재freeze 없이 barrier 통과)');
    assert.equal(spy.freezeCalls, 0, '이미 고정된 apply job 은 재freeze 하지 않는다');
    assert.equal(spy.terminalCalls.length, 0);
});

test('LDAREG(single 확인) apply job: 재실행 scopeHash 불일치 → apply RPC 0회 + REVIEW_REQUIRED', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: noEvidence(MEMBER),
        scans: { scanTitle: async () => titleComplete(MULTIPLEX) },
        jobPreviewData: applyJobPreview({
            confirmedDiscoveryScopeHash: 'WRONG-SCOPE-HASH',
            confirmedPropertyMembershipHash: 'WRONG-MEMBERSHIP-HASH',
        }),
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.applyCalls, 0, '불일치 시 apply RPC 0회');
    assert.equal(spy.freezeCalls, 0);
    assert.equal(spy.terminalCalls[0].scopeState, 'REVIEW_REQUIRED');
    assert.ok(spy.terminalIssues[0].some((i) => i.code === 'LAND_SCOPE_CONFIRMATION_MISMATCH'), 'mismatch issue 기록');
});

// ── Finding 3: LINKED discovery extraIssue를 원자 apply RPC에 전달 ─────────────

test('LINKED LDAREG 즉시적용: discovery extraIssue를 apply RPC 입력으로 전달한다', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: {
            scanTitle: async () => titleComplete(MULTIPLEX),
            // 상태 코드 ambiguity가 CURRENT component + discovery extraIssue를 함께 만든다.
            scanLdareg: async () => ({
                state: 'COMPLETE',
                rows: [{ pnu: ANCHOR, agbldgSn: '1', ldaQotaRate: '10/100.5', clsSeCode: 'X7', clsSeCodeNm: 'ZZZ', buldDongNm: '101', buldFloorNm: '3', buldHoNm: '301' }],
                totalCount: 1,
                pagesFetched: 1,
            }),
        },
        propertyUnits: [
            {
                id: PROP_ID,
                unionId: 'union-1',
                buildingUnitId: null,
                pnu: ANCHOR,
                isDeleted: false,
                dong: '101',
                ho: '301',
            },
        ],
        applyResult: {
            data: {
                outcome: 'NO_DATA',
                issues: [
                    { code: 'LDAREG_IDENTITY_CONFLICT', propertyUnitId: PROP_ID, targetPnu: ANCHOR }, // discovery extraIssue 와 동일
                    { code: 'STALE_SCAN_REJECTED', targetPnu: ANCHOR }, // RPC 고유 issue
                ],
            },
            error: null,
        },
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });

    assert.equal(spy.applyCalls, 1, 'LINKED 즉시적용은 apply RPC 1회');
    const params = spy.lastApplyParams as {
        p_result_summary: { extraIssues: LandAreaSyncIssue[] };
    };
    assert.deepEqual(
        params.p_result_summary.extraIssues.map((issue) => issue.code),
        ['LDAREG_IDENTITY_CONFLICT']
    );
});

// ── C1: resolverRootPks 계약(up-PK ≠ self-PK) ─────────────────────────

/** anchor title 이 up-PK(계열 root)와 self-PK(동별)를 모두 갖는 총괄표제부 집합건물 케이스. */
function titleUpVsSelf(pair: typeof DETACHED, up: string, self: string): StrictScan<BrTitleRow> {
    return {
        state: 'COMPLETE',
        rows: [{ mgmBldrgstPk: self, mgmUpBldrgstPk: up, bylotCnt: '0', regstrGbCd: pair.regstrGbCd, mainPurpsCd: pair.mainPurpsCd, mainPurpsCdNm: pair.mainPurpsCdNm }],
        totalCount: 1,
        pagesFetched: 1,
    };
}

test('C1: mgmUpBldrgstPk ≠ mgmBldrgstPk 일 때 resolver 는 up-PK 로 호출되고 snapshot.resolverRootPks == resolver 입력', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: noEvidence(MEMBER),
        scans: { scanTitle: async () => titleUpVsSelf(DETACHED, '9001002003004', '9001002003005') },
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });

    // resolver 는 up-PK 우선으로 유도된 root 로 호출된다(self-PK 아님).
    assert.deepEqual(spy.resolverParams[0].p_root_mgm_bldrgst_pks, ['9001002003004']);
    // 고정 snapshot 의 resolverRootPks 는 resolver 호출 입력과 정확히 일치해야 한다(웹 [5.3] 재검증 계약).
    assert.equal(spy.freezeCalls, 1);
    assert.deepEqual(spy.frozenSnapshots[0].resolverRootPks, spy.resolverParams[0].p_root_mgm_bldrgst_pks);
    assert.deepEqual(spy.frozenSnapshots[0].resolverRootPks, ['9001002003004']);
});

test('§10.4 LDAREG: title self를 branch root로 쓰고 basis title-row의 higher up은 resolver 축에만 남긴다', async () => {
    const higherUp = '9001002003004';
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: {
            scanTitle: async () =>
                titleUpVsSelf(MULTIPLEX, higherUp, PK),
            scanBasis: async () => ({
                state: 'COMPLETE',
                rows: [
                    {
                        pnu: ANCHOR,
                        mgmBldrgstPk: PK,
                        mgmUpBldrgstPk: higherUp,
                    },
                ],
                totalCount: 1,
                pagesFetched: 1,
            }),
            // accepted title self와 같은 EXPOS self, raw up은 없음 → SELF.
            scanExpos: async () => exposComplete(),
            scanLdareg: async () => ldaregCurrent(),
        },
        propertyUnits: [
            {
                id: PROP_ID,
                unionId: 'union-1',
                buildingUnitId: null,
                pnu: ANCHOR,
                isDeleted: false,
                dong: '101',
                ho: '301',
            },
        ],
        applyResult: {
            data: { outcome: 'NO_DATA', issues: [] },
            error: null,
        },
        spy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: 'union-1',
        deps,
    });

    assert.equal(
        selectSingleLdaregRootIdentity([
            {
                pnu: ANCHOR,
                title: titleUpVsSelf(MULTIPLEX, higherUp, PK),
                attached: zero(),
            },
        ]),
        PK,
        'branch root는 up이 아닌 title self다'
    );
    assert.deepEqual(
        spy.resolverParams[0].p_root_mgm_bldrgst_pks,
        [higherUp],
        'resolver root는 기존 up-preferred 축을 유지한다'
    );
    assert.equal(spy.applyCalls, 1);
    const params = spy.lastApplyParams as {
        p_result_summary: {
            counts: { basisRows: number };
            extraIssues: LandAreaSyncIssue[];
        };
    };
    assert.equal(params.p_result_summary.counts.basisRows, 1);
    assert.ok(
        !params.p_result_summary.extraIssues.some(
            (issue) => issue.code === 'LDAREG_IDENTITY_CONFLICT'
        )
    );
});

// ── LADFRL manual-overwrite apply atomic terminal ───────────────────

test('LADFRL overwrite 확인 apply도 후속 preview UPDATE 없이 RPC 한 번으로 종결한다', async () => {
    // discovery 로 고정될 scope/membership hash 캡처.
    const disc = emptySpy();
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps: makeDeps({ resolver: noEvidence(MEMBER), spy: disc }) });
    const frozen = disc.frozenSnapshots[0];

    // overwriteManualConfirmed=true 인 LADFRL 확인 apply job. 수정 전에는 LINKED_SCOPE_RESOLVED 로
    // 오표기됐다. LADFRL 은 단일 PNU 전략이므로 SINGLE_PNU_CONFIRMED 여야 한다.
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: noEvidence(MEMBER),
        applyResult: { data: { outcome: 'APPLIED', issues: [] }, error: null },
        jobPreviewData: applyJobPreview({
            confirmedDiscoveryScopeHash: frozen.scopeHash,
            confirmedPropertyMembershipHash: frozen.propertyMembershipHash,
            overwriteManualConfirmed: true,
        }),
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.applyCalls, 1, 'overwrite 확인 apply RPC 1회');
    assert.equal(spy.terminalCalls.length, 0, 'apply 성공 뒤 JS terminal UPDATE는 없다');
});
