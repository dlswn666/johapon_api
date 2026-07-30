import assert from 'node:assert/strict';
import test from 'node:test';
import {
    resolveDevelopmentFullRefreshLdaregPropertyMembershipMode,
    runLandAreaSyncJob,
    selectLandRightRootIdentity,
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
import {
    DEVELOPMENT_LAND_AREA_FULL_REFRESH_PROFILE,
    MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_MANIFEST_DIGEST,
    MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_SCOPE_DIGEST,
    MIA_SEVEN_DEVELOPMENT_UNION_ID,
} from '../src/security/development-land-area-full-refresh-policy';

const ANCHOR = '1168010100107360024';
const FORMER_NO_DATA_PNU = '1130510100107913568';
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

function officialTwoPnuLdaregScans(
    attachedPnu: string
): Partial<LandAreaSyncDeps['scans']> {
    return {
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
        scanBasis: async (pnu) => ({
            state: 'COMPLETE',
            rows: [{ pnu, mgmBldrgstPk: PK }],
            totalCount: 1,
            pagesFetched: 1,
        }),
        scanExpos: async (pnu) =>
            exposComplete([
                {
                    pnu,
                    mgmBldrgstPk: PK,
                    dongNm: '101',
                    flrNoNm: '3',
                    hoNm: '301',
                },
            ]),
        scanLadfrl: async (pnu) => ({
            state: 'COMPLETE',
            rows: [{ pnu, lndpclAr: '50.25' }],
            totalCount: 1,
            pagesFetched: 1,
        }),
        scanLdareg: async (pnu) => ({
            state: 'COMPLETE',
            rows: [
                {
                    ...ldaregCurrent().rows[0],
                    pnu,
                },
            ],
            totalCount: 1,
            pagesFetched: 1,
        }),
    };
}

interface Spy {
    freezeCalls: number;
    applyCalls: number;
    terminalCalls: Array<{ status: string; scopeState: string; outcome: string }>;
    terminalCounts: Array<{
        updatedPropertyUnits: number;
        unchangedPropertyUnits: number;
    }>;
    /** writeDiscoveryTerminal 로 넘어간 issues(terminalCalls 와 index 대응). */
    terminalIssues: LandAreaSyncIssue[][];
    failedCalls: string[];
    lastApplyParams: unknown;
    /** resolveScope 로 넘어간 params(p_root_mgm_bldrgst_pks 검증용). */
    resolverParams: Array<{ p_root_mgm_bldrgst_pks: string[] }>;
    /** freezeScopeSnapshot 로 고정된 snapshot 의 scope/membership hash + resolverRootPks. */
    frozenSnapshots: Array<{
        scopeHash: string;
        propertyMembershipHash: string;
        resolverRootPks: string[];
        scopeSnapshot: import('../src/types/land-area-sync-job.types').LandAreaSyncScopeSnapshot;
    }>;
}

function makeDeps(opts: {
    resolver: unknown;
    databaseTarget?: 'development' | 'production';
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
    currentLandTuples?: Array<{
        propertyUnitId: string;
        landArea: string;
        source: string;
    }>;
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
        ...(opts.databaseTarget
            ? { databaseTarget: opts.databaseTarget }
            : {}),
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
                    scopeSnapshot: patch.scopeSnapshot,
                });
                return true;
            },
            writeDiscoveryTerminal: async (_j, _u, input) => {
                spy.terminalCalls.push({ status: input.status, scopeState: input.scopeState, outcome: input.outcome });
                spy.terminalCounts.push({
                    updatedPropertyUnits:
                        input.counts.updatedPropertyUnits,
                    unchangedPropertyUnits:
                        input.counts.unchangedPropertyUnits,
                });
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
            readCurrentLandTuples: async () =>
                opts.currentLandTuples ?? [],
        },
    };
}

function emptySpy(): Spy {
    return {
        freezeCalls: 0,
        applyCalls: 0,
        terminalCalls: [],
        terminalCounts: [],
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

function developmentFullRefreshMarker() {
    return {
        profile:
            DEVELOPMENT_LAND_AREA_FULL_REFRESH_PROFILE,
        manifestDigest:
            MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_MANIFEST_DIGEST,
        scopeDigest:
            MIA_SEVEN_DEVELOPMENT_FULL_REFRESH_SCOPE_DIGEST,
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

test('DEV official 1→3 membership은 query-only attached와 all-active PNU replica를 분리한다', () => {
    const pnuB = '1168010100107360025';
    const pnuC = '1168010100107360026';
    const component = {
        source:
            'SAME_RUN_OFFICIAL_DEVELOPMENT_FULL_REFRESH' as const,
        canonicalBasePnu: ANCHOR,
        memberPnus: [ANCHOR, pnuB, pnuC],
        managementPk: PK,
        pairCount: 2,
        officialComponentDigest: 'a'.repeat(64),
    };
    const property = (id: string, pnu: string, ho: string) => ({
        id,
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        buildingUnitId: null,
        pnu,
        isDeleted: false,
        dong: null,
        ho,
    });

    assert.equal(
        resolveDevelopmentFullRefreshLdaregPropertyMembershipMode({
            unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
            component,
            propertyUnits: [
                property('anchor-101', ANCHOR, '101'),
                property('anchor-201', ANCHOR, '201'),
            ],
        }),
        'SINGLE_LOGICAL_SET',
        'active property 0인 attached PNU는 query provenance만 유지한다'
    );
    assert.equal(
        resolveDevelopmentFullRefreshLdaregPropertyMembershipMode({
            unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
            component,
            propertyUnits: [ANCHOR, pnuB, pnuC].flatMap(
                (pnu, index) => [
                    property(`${index}-101`, pnu, '101'),
                    property(`${index}-201`, pnu, '201'),
                ]
            ),
        }),
        'PER_ACTIVE_PNU_REPLICA'
    );

    assert.equal(
        resolveDevelopmentFullRefreshLdaregPropertyMembershipMode({
            unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
            component: {
                ...component,
                memberPnus: [ANCHOR],
                pairCount: 0,
            },
            propertyUnits: [
                property('anchor-101', ANCHOR, '101'),
                property('anchor-201', ANCHOR, '201'),
            ],
        }),
        'SINGLE_LOGICAL_SET',
        '공식 pairCount=0 component도 exact room cohort면 LDAREG 대상이다'
    );
});

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

test('DEV 전체 갱신 분류 conflict parcel singleton은 DB_RESOLVER가 아닌 same-run official pairCount=0 snapshot을 만든다', async () => {
    const spy = emptySpy();
    const marker = developmentFullRefreshMarker();
    const resolver = linked(MEMBER) as Record<
        string,
        unknown
    >;
    const deps = makeDeps({
        databaseTarget: 'development',
        resolver,
        scans: {
            scanTitle: async () => ({
                state: 'COMPLETE',
                rows: [
                    {
                        mgmBldrgstPk: PK,
                        bylotCnt: '0',
                        regstrGbCd: '1',
                        mainPurpsCd: '03000',
                        mainPurpsCdNm:
                            '제1종근린생활시설',
                    },
                ],
                totalCount: 1,
                pagesFetched: 1,
            }),
        },
        propertyUnits: [
            {
                id: PROP_ID,
                unionId:
                    MIA_SEVEN_DEVELOPMENT_UNION_ID,
                buildingUnitId: null,
                pnu: ANCHOR,
                isDeleted: false,
                dong: null,
                ho: null,
            },
        ],
        jobPreviewData: {
            landAreaSync: {
                schemaVersion: 2,
                anchorPnu: ANCHOR,
                sourceDiscoveryJobId: null,
                developmentFullRefresh: marker,
            },
        },
        spy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps,
    });

    assert.equal(spy.freezeCalls, 1);
    assert.equal(spy.applyCalls, 0);
    const prepared =
        spy.frozenSnapshots[0].scopeSnapshot;
    assert.deepEqual(
        prepared.developmentFullRefreshScopeResolution,
        {
            source:
                'SAME_RUN_OFFICIAL_DEVELOPMENT_FULL_REFRESH',
            canonicalBasePnu: ANCHOR,
            memberPnus: [ANCHOR],
            managementPk: PK,
            pairCount: 0,
            officialComponentDigest:
                prepared
                    .developmentFullRefreshScopeResolution
                    ?.officialComponentDigest,
            manifestDigest: marker.manifestDigest,
            scopeDigest: marker.scopeDigest,
        }
    );
    assert.notEqual(
        prepared.dbScopeHash,
        resolver.dbScopeHash
    );
    assert.deepEqual(prepared.scannedPnus, [ANCHOR]);
});

test('DEV 전체 갱신 title COMPLETE_ZERO + exact DB singleton은 component를 위조하지 않고 별도 공식 parcel snapshot을 만든다', async () => {
    const spy = emptySpy();
    const marker = developmentFullRefreshMarker();
    const deps = makeDeps({
        databaseTarget: 'development',
        resolver: noEvidence(MEMBER),
        scans: {
            scanTitle: async () => zero<BrTitleRow>(),
        },
        propertyUnits: [
            {
                id: PROP_ID,
                unionId:
                    MIA_SEVEN_DEVELOPMENT_UNION_ID,
                buildingUnitId: null,
                pnu: ANCHOR,
                isDeleted: false,
                dong: null,
                ho: null,
            },
        ],
        jobPreviewData: {
            landAreaSync: {
                schemaVersion: 2,
                anchorPnu: ANCHOR,
                sourceDiscoveryJobId: null,
                developmentFullRefresh: marker,
            },
        },
        spy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps,
    });

    assert.equal(spy.freezeCalls, 1);
    assert.equal(spy.applyCalls, 0);
    assert.deepEqual(spy.terminalCalls, [
        {
            status: 'COMPLETED',
            scopeState:
                'SINGLE_SCOPE_CONFIRMATION_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
        },
    ]);
    const snapshot =
        spy.frozenSnapshots[0].scopeSnapshot;
    assert.equal(
        snapshot.developmentFullRefreshScopeResolution,
        undefined
    );
    assert.deepEqual(
        snapshot.developmentFullRefreshParcelResolution,
        {
            source:
                'SAME_RUN_OFFICIAL_DEVELOPMENT_PARCEL_SINGLETON',
            canonicalPnu: ANCHOR,
            memberPnus: [ANCHOR],
            officialParcelDigest:
                snapshot
                    .developmentFullRefreshParcelResolution
                    ?.officialParcelDigest,
            manifestDigest: marker.manifestDigest,
            scopeDigest: marker.scopeDigest,
        }
    );
    assert.equal(
        'managementPk' in
            (snapshot.developmentFullRefreshParcelResolution ??
                {}),
        false
    );
    assert.deepEqual(
        spy.resolverParams[0].p_root_mgm_bldrgst_pks,
        []
    );
});

test('과거 no-data로 고정했던 3568은 7호실을 parcel singleton으로 오인하지 않고 공식 재조회 REVIEW로 남긴다', async () => {
    const spy = emptySpy();
    const marker = developmentFullRefreshMarker();
    const propertyUnitIds = Array.from(
        { length: 7 },
        (_, index) =>
            `00000000-0000-4000-8000-${String(
                index + 1
            ).padStart(12, '0')}`
    );
    const currentLandTuples = propertyUnitIds.map(
        (propertyUnitId, index) => ({
            propertyUnitId,
            landArea: String(index + 1),
            source: 'MANUAL',
        })
    );
    const deps = makeDeps({
        databaseTarget: 'development',
        resolver: {
            dbState: 'NO_EVIDENCE',
            rootBuildingIdentities: [],
            componentPnus: [
                FORMER_NO_DATA_PNU,
            ],
            linkedBasePnus: [],
            linkedPnus: [],
            linkedEvidenceKeys: [],
            pendingEvidenceKeys: [],
            blockingEvidence: [],
            openUnresolvedEvidenceKeys: [],
            componentTruncated: false,
            propertyMembership: [],
            dbScopeHash: 'db-hash-verified-no-data',
        },
        scans: {
            scanTitle: async () => zero<BrTitleRow>(),
            scanAttached: async () => zero(),
            scanBasis: async () => zero(),
            scanExpos: async () => zero<BrExposRow>(),
            scanLadfrl: async (pnu) => ({
                state: 'COMPLETE',
                rows: [{ pnu, lndpclAr: '73' }],
                totalCount: 1,
                pagesFetched: 1,
            }),
            scanLdareg: async () => zero<LdaregRow>(),
        },
        propertyUnits: propertyUnitIds.map((id) => ({
            id,
            unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
            buildingUnitId: null,
            pnu: FORMER_NO_DATA_PNU,
            isDeleted: false,
            dong: null,
            ho: null,
        })),
        currentLandTuples,
        jobPreviewData: {
            landAreaSync: {
                schemaVersion: 2,
                anchorPnu:
                    FORMER_NO_DATA_PNU,
                sourceDiscoveryJobId: null,
                developmentFullRefresh: marker,
            },
        },
        spy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps,
    });

    assert.equal(spy.freezeCalls, 0);
    assert.equal(spy.applyCalls, 0);
    assert.deepEqual(spy.terminalCalls, [
        {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
        },
    ]);
    assert.equal(spy.applyCalls, 0);
});

test('DEV 전체 갱신 분류 conflict room cohort도 공식 호가 불일치하면 PROPERTY_UNIT_NOT_FOUND로 차단한다', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        databaseTarget: 'development',
        resolver: linked(MEMBER),
        scans: {
            scanTitle: async () => ({
                state: 'COMPLETE',
                rows: [
                    {
                        mgmBldrgstPk: PK,
                        bylotCnt: '0',
                        regstrGbCd: '1',
                        mainPurpsCd: '03000',
                        mainPurpsCdNm:
                            '제1종근린생활시설',
                    },
                ],
                totalCount: 1,
                pagesFetched: 1,
            }),
        },
        propertyUnits: [
            {
                id: PROP_ID,
                unionId:
                    MIA_SEVEN_DEVELOPMENT_UNION_ID,
                buildingUnitId: null,
                pnu: ANCHOR,
                isDeleted: false,
                dong: null,
                ho: '201',
            },
        ],
        jobPreviewData: {
            landAreaSync: {
                schemaVersion: 2,
                anchorPnu: ANCHOR,
                sourceDiscoveryJobId: null,
                developmentFullRefresh:
                    developmentFullRefreshMarker(),
            },
        },
        spy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps,
    });

    assert.equal(spy.freezeCalls, 0);
    assert.equal(spy.applyCalls, 0);
    assert.deepEqual(spy.terminalCalls, [
        {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
        },
    ]);
    assert.deepEqual(
        spy.terminalIssues[0].map((issue) => issue.code),
        ['PROPERTY_UNIT_NOT_FOUND']
    );
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

test('읽기 전용 LDAREG LINKED discovery는 snapshot과 terminal만 남기고 apply RPC를 호출하지 않는다', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: {
            scanTitle: async () => titleComplete(MULTIPLEX),
        },
        spy,
    });
    deps.executionMode = 'READ_ONLY_CAPTURE';

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: 'union-1',
        deps,
    });

    assert.equal(spy.freezeCalls, 1);
    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.failedCalls.length, 0);
    assert.deepEqual(spy.terminalCalls, [
        {
            status: 'COMPLETED',
            scopeState: 'LINKED_SCOPE_RESOLVED',
            outcome: 'REVIEW_REQUIRED',
        },
    ]);
});

test('READ_ONLY_CAPTURE만 no-cache official attached component를 1회 확장하고 normal discovery는 계속 REVIEW한다', async () => {
    const attachedPnu = '1168010100107360025';
    const scans: Partial<LandAreaSyncDeps['scans']> = {
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
        scanBasis: async (pnu) => ({
            state: 'COMPLETE',
            rows: [{ pnu, mgmBldrgstPk: PK }],
            totalCount: 1,
            pagesFetched: 1,
        }),
        scanExpos: async (pnu) =>
            exposComplete([
                {
                    pnu,
                    mgmBldrgstPk: PK,
                    dongNm: '101',
                    flrNoNm: '3',
                    hoNm: '301',
                },
            ]),
        scanLadfrl: async (pnu) => ({
            state: 'COMPLETE',
            rows: [{ pnu, lndpclAr: '50.25' }],
            totalCount: 1,
            pagesFetched: 1,
        }),
        scanLdareg: async (pnu) => ({
            state: 'COMPLETE',
            rows: [
                {
                    ...ldaregCurrent().rows[0],
                    pnu,
                },
            ],
            totalCount: 1,
            pagesFetched: 1,
        }),
    };
    const propertyUnits = [
        {
            id: PROP_ID,
            unionId: 'union-1',
            buildingUnitId: null,
            pnu: ANCHOR,
            isDeleted: false,
            dong: '101',
            ho: '301',
        },
    ];

    const normalSpy = emptySpy();
    const normalDeps = makeDeps({
        resolver: noEvidence(MEMBER),
        scans,
        propertyUnits,
        spy: normalSpy,
    });
    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: 'union-1',
        deps: normalDeps,
    });
    assert.equal(normalSpy.freezeCalls, 0);
    assert.equal(normalSpy.applyCalls, 0);
    assert.equal(
        normalSpy.terminalCalls[0]?.scopeState,
        'REVIEW_REQUIRED'
    );

    const captureSpy = emptySpy();
    const scannedBranchPnus = new Set<string>();
    const captureDeps = makeDeps({
        resolver: noEvidence(MEMBER),
        scans: {
            ...scans,
            scanLdareg: async (pnu) => {
                scannedBranchPnus.add(pnu);
                return {
                    state: 'COMPLETE',
                    rows: [
                        {
                            ...ldaregCurrent().rows[0],
                            pnu,
                        },
                    ],
                    totalCount: 1,
                    pagesFetched: 1,
                };
            },
        },
        propertyUnits,
        spy: captureSpy,
    });
    captureDeps.executionMode = 'READ_ONLY_CAPTURE';
    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: 'union-1',
        deps: captureDeps,
    });
    assert.deepEqual([...scannedBranchPnus].sort(), [
        ANCHOR,
        attachedPnu,
    ]);
    assert.equal(captureSpy.freezeCalls, 1);
    assert.equal(captureSpy.applyCalls, 0);
    assert.deepEqual(captureSpy.terminalCalls, [
        {
            status: 'COMPLETED',
            scopeState: 'LINKED_SCOPE_RESOLVED',
            outcome: 'REVIEW_REQUIRED',
        },
    ]);
});

test('DEV 전체 갱신 LADFRL singleton은 pairCount=0 공식 snapshot으로 prepare/apply를 fresh 재조회한다', async () => {
    const unrelatedRelationPnu = '1168010100107360026';
    const marker = developmentFullRefreshMarker();
    const resolver = {
        ...(linked(MEMBER) as Record<string, unknown>),
        componentPnus: [unrelatedRelationPnu],
        linkedBasePnus: [unrelatedRelationPnu],
        linkedPnus: [unrelatedRelationPnu],
        dbScopeHash: 'db-hash-linked-unrelated-relation',
    };
    const propertyUnits = [
        {
            id: PROP_ID,
            unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
            buildingUnitId: null,
            pnu: ANCHOR,
            isDeleted: false,
            dong: null,
            ho: null,
        },
    ];
    const currentLandTuples = [
        {
            propertyUnitId: PROP_ID,
            landArea: '100.5',
            source: 'MANUAL',
        },
    ];
    const scannedTitles: string[] = [];
    const discoverySpy = emptySpy();
    const discoveryDeps = makeDeps({
        databaseTarget: 'development',
        resolver,
        propertyUnits,
        currentLandTuples,
        scans: {
            scanTitle: async (pnu) => {
                scannedTitles.push(pnu);
                return titleComplete(DETACHED);
            },
        },
        jobPreviewData: {
            landAreaSync: {
                schemaVersion: 2,
                anchorPnu: ANCHOR,
                sourceDiscoveryJobId: null,
                developmentFullRefresh: marker,
            },
        },
        spy: discoverySpy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps: discoveryDeps,
    });

    assert.equal(discoverySpy.applyCalls, 0);
    assert.equal(discoverySpy.freezeCalls, 1);
    assert.equal(
        discoverySpy.terminalCalls[0]?.scopeState,
        'MANUAL_OVERWRITE_CONFIRMATION_REQUIRED'
    );
    const prepared =
        discoverySpy.frozenSnapshots[0].scopeSnapshot;
    assert.deepEqual(
        prepared.developmentFullRefreshScopeResolution,
        {
            source:
                'SAME_RUN_OFFICIAL_DEVELOPMENT_FULL_REFRESH',
            canonicalBasePnu: ANCHOR,
            memberPnus: [ANCHOR],
            managementPk: PK,
            pairCount: 0,
            officialComponentDigest:
                prepared
                    .developmentFullRefreshScopeResolution
                    ?.officialComponentDigest,
            manifestDigest: marker.manifestDigest,
            scopeDigest: marker.scopeDigest,
        }
    );
    assert.notEqual(
        prepared.dbScopeHash,
        resolver.dbScopeHash,
        'relation-derived hash는 공식 singleton+membership synthetic hash로 감싼다'
    );

    const applySpy = emptySpy();
    const applyPreview = applyJobPreview({
        confirmedDiscoveryScopeHash: prepared.scopeHash,
        confirmedPropertyMembershipHash:
            prepared.propertyMembershipHash,
        overwriteManualConfirmed: true,
    });
    const applyDeps = makeDeps({
        databaseTarget: 'development',
        resolver,
        propertyUnits,
        currentLandTuples,
        scans: {
            scanTitle: async (pnu) => {
                scannedTitles.push(pnu);
                return titleComplete(DETACHED);
            },
        },
        jobPreviewData: {
            ...applyPreview,
            landAreaSync: {
                ...(applyPreview.landAreaSync as Record<
                    string,
                    unknown
                >),
                developmentFullRefresh: marker,
            },
        },
        applyResult: {
            data: { outcome: 'APPLIED', issues: [] },
            error: null,
        },
        spy: applySpy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps: applyDeps,
    });

    assert.deepEqual(scannedTitles, [ANCHOR, ANCHOR]);
    assert.equal(applySpy.freezeCalls, 0);
    assert.equal(applySpy.applyCalls, 1);
    const applyParams = applySpy.lastApplyParams as {
        p_db_scope_hash: string;
        p_scanned_pnus: string[];
    };
    assert.equal(
        applyParams.p_db_scope_hash,
        prepared.dbScopeHash
    );
    assert.deepEqual(applyParams.p_scanned_pnus, [ANCHOR]);
});

test('DEV 공식 multi-PNU parcel component는 query-only를 scope에 보존하고 property마다 자기 PNU LADFRL만 적용한다', async () => {
    const attachedPnu = '1168010100107360025';
    const queryOnlyPnu = '1168010100107360026';
    const attachedPropertyId =
        '22222222-2222-4222-8222-222222222222';
    const marker = developmentFullRefreshMarker();
    const propertyUnits = [
        {
            id: PROP_ID,
            unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
            buildingUnitId: null,
            pnu: ANCHOR,
            isDeleted: false,
            dong: null,
            ho: null,
        },
        {
            id: attachedPropertyId,
            unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
            buildingUnitId: null,
            pnu: attachedPnu,
            isDeleted: false,
            dong: null,
            ho: null,
        },
    ];
    const currentLandTuples = [
        {
            propertyUnitId: PROP_ID,
            landArea: '89',
            source: 'LADFRL',
        },
        {
            propertyUnitId: attachedPropertyId,
            landArea: '76',
            source: 'LADFRL',
        },
    ];
    const scans: Partial<LandAreaSyncDeps['scans']> = {
        scanTitle: async () => ({
            ...titleComplete(DETACHED),
            rows: [
                {
                    ...titleComplete(DETACHED).rows[0],
                    bylotCnt: '2',
                },
            ],
        }),
        scanAttached: async () => ({
            state: 'COMPLETE',
            rows: [attachedPnu, queryOnlyPnu].map(
                (pnu) => ({
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
                    atchJi: pnu.slice(15, 19),
                })
            ),
            totalCount: 2,
            pagesFetched: 1,
        }),
        scanLadfrl: async (pnu) => ({
            state: 'COMPLETE',
            rows: [
                {
                    pnu,
                    lndpclAr:
                        pnu === ANCHOR
                            ? '89'
                            : pnu === attachedPnu
                              ? '76'
                              : '66',
                },
            ],
            totalCount: 1,
            pagesFetched: 1,
        }),
    };
    const resolver = noEvidence(MEMBER);
    const discoverySpy = emptySpy();
    const discoveryDeps = makeDeps({
        databaseTarget: 'development',
        resolver,
        scans,
        propertyUnits,
        currentLandTuples,
        jobPreviewData: {
            landAreaSync: {
                schemaVersion: 2,
                anchorPnu: ANCHOR,
                sourceDiscoveryJobId: null,
                developmentFullRefresh: marker,
            },
        },
        spy: discoverySpy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps: discoveryDeps,
    });

    assert.equal(discoverySpy.applyCalls, 0);
    assert.equal(discoverySpy.freezeCalls, 1);
    const prepared =
        discoverySpy.frozenSnapshots[0].scopeSnapshot;
    assert.equal(prepared.strategy, 'LADFRL');
    assert.deepEqual(prepared.scannedPnus, [
        ANCHOR,
        attachedPnu,
        queryOnlyPnu,
    ]);
    assert.deepEqual(prepared.candidatePropertyUnitIds, [
        PROP_ID,
        attachedPropertyId,
    ].sort());
    assert.deepEqual(prepared.proposedLandAreas, [
        {
            propertyUnitId: PROP_ID,
            landArea: '89',
        },
        {
            propertyUnitId: attachedPropertyId,
            landArea: '76',
        },
    ]);
    assert.deepEqual(prepared.ladfrlAreaEvidence, {
        version: 'land-area-sync.ladfrl-scope.v1',
        parcels: [
            { pnu: ANCHOR, area: '89' },
            { pnu: attachedPnu, area: '76' },
            { pnu: queryOnlyPnu, area: '66' },
        ],
        totalArea: '231',
    });

    const applySpy = emptySpy();
    const applyPreview = applyJobPreview({
        confirmedDiscoveryScopeHash: prepared.scopeHash,
        confirmedPropertyMembershipHash:
            prepared.propertyMembershipHash,
    });
    const applyDeps = makeDeps({
        databaseTarget: 'development',
        resolver,
        scans,
        propertyUnits,
        currentLandTuples,
        jobPreviewData: {
            ...applyPreview,
            landAreaSync: {
                ...(applyPreview.landAreaSync as Record<
                    string,
                    unknown
                >),
                developmentFullRefresh: marker,
            },
        },
        applyResult: {
            data: { outcome: 'APPLIED', issues: [] },
            error: null,
        },
        spy: applySpy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps: applyDeps,
    });

    assert.equal(applySpy.freezeCalls, 0);
    assert.equal(applySpy.applyCalls, 1);
    const applyParams = applySpy.lastApplyParams as {
        p_scanned_pnus: string[];
        p_items: Array<{
            propertyUnitId: string;
            targetPnu: string;
            ladfrlArea: string;
        }>;
    };
    assert.deepEqual(applyParams.p_scanned_pnus, [
        ANCHOR,
        attachedPnu,
        queryOnlyPnu,
    ]);
    assert.deepEqual(applyParams.p_items, [
        {
            propertyUnitId: PROP_ID,
            targetPnu: ANCHOR,
            ladfrlArea: '89',
        },
        {
            propertyUnitId: attachedPropertyId,
            targetPnu: attachedPnu,
            ladfrlArea: '76',
        },
    ]);
});

test('DEV 전체 갱신 pairCount=0 room cohort는 classifier가 LADFRL이어도 LDAREG snapshot으로 prepare/apply한다', async () => {
    const unrelatedRelationPnu = '1168010100107360026';
    const marker = developmentFullRefreshMarker();
    const resolver = {
        ...(linked(MEMBER) as Record<string, unknown>),
        componentPnus: [unrelatedRelationPnu],
        linkedBasePnus: [unrelatedRelationPnu],
        linkedPnus: [unrelatedRelationPnu],
        dbScopeHash: 'db-hash-linked-unrelated-relation',
    };
    const propertyUnits = [
        {
            id: PROP_ID,
            unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
            buildingUnitId: null,
            pnu: ANCHOR,
            isDeleted: false,
            dong: '101',
            ho: '301',
        },
    ];
    const currentLandTuples = [
        {
            propertyUnitId: PROP_ID,
            landArea: '10',
            source: 'MANUAL',
        },
    ];
    const scannedTitles: string[] = [];
    const singletonLdaregScans: Partial<
        LandAreaSyncDeps['scans']
    > = {
        scanTitle: async (pnu) => {
            scannedTitles.push(pnu);
            // 791-2282 실측 형태: 공식 component는 singleton이지만 일반
            // classifier는 LADFRL이고 DB에는 exact room cohort가 있다.
            return titleComplete(DETACHED);
        },
        scanBasis: async (pnu) => ({
            state: 'COMPLETE',
            rows: [{ pnu, mgmBldrgstPk: PK }],
            totalCount: 1,
            pagesFetched: 1,
        }),
        scanLdareg: async () => ldaregCurrent(),
    };
    const discoverySpy = emptySpy();
    const discoveryDeps = makeDeps({
        databaseTarget: 'development',
        resolver,
        scans: singletonLdaregScans,
        propertyUnits,
        currentLandTuples,
        jobPreviewData: {
            landAreaSync: {
                schemaVersion: 2,
                anchorPnu: ANCHOR,
                sourceDiscoveryJobId: null,
                developmentFullRefresh: marker,
            },
        },
        spy: discoverySpy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps: discoveryDeps,
    });

    assert.equal(discoverySpy.applyCalls, 0);
    assert.equal(discoverySpy.freezeCalls, 1);
    const prepared =
        discoverySpy.frozenSnapshots[0].scopeSnapshot;
    assert.equal(
        prepared.strategy,
        'LDAREG'
    );
    assert.deepEqual(
        prepared.developmentFullRefreshScopeResolution,
        {
            source:
                'SAME_RUN_OFFICIAL_DEVELOPMENT_FULL_REFRESH',
            canonicalBasePnu: ANCHOR,
            memberPnus: [ANCHOR],
            managementPk: PK,
            pairCount: 0,
            officialComponentDigest:
                prepared
                    .developmentFullRefreshScopeResolution
                    ?.officialComponentDigest,
            manifestDigest: marker.manifestDigest,
            scopeDigest: marker.scopeDigest,
        }
    );

    const applySpy = emptySpy();
    const applyPreview = applyJobPreview({
        confirmedDiscoveryScopeHash: prepared.scopeHash,
        confirmedPropertyMembershipHash:
            prepared.propertyMembershipHash,
        overwriteManualConfirmed: true,
    });
    const applyDeps = makeDeps({
        databaseTarget: 'development',
        resolver,
        scans: singletonLdaregScans,
        propertyUnits,
        currentLandTuples,
        jobPreviewData: {
            ...applyPreview,
            landAreaSync: {
                ...(applyPreview.landAreaSync as Record<
                    string,
                    unknown
                >),
                developmentFullRefresh: marker,
            },
        },
        applyResult: {
            data: { outcome: 'APPLIED', issues: [] },
            error: null,
        },
        spy: applySpy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps: applyDeps,
    });

    assert.deepEqual(scannedTitles, [ANCHOR, ANCHOR]);
    assert.equal(applySpy.freezeCalls, 0);
    assert.equal(applySpy.applyCalls, 1);
    const applyParams = applySpy.lastApplyParams as {
        p_db_scope_hash: string;
        p_scanned_pnus: string[];
    };
    assert.equal(
        applyParams.p_db_scope_hash,
        prepared.dbScopeHash
    );
    assert.deepEqual(applyParams.p_scanned_pnus, [ANCHOR]);
});

test('DEV 전체 갱신 2155형 pairCount=0 classification conflict도 title positive + exact 5-room cohort면 LDAREG로 진행한다', async () => {
    const marker = developmentFullRefreshMarker();
    const propertyIds = [
        PROP_ID,
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
        '55555555-5555-4555-8555-555555555555',
    ];
    const rooms = ['101', '102', '103', '104', '105'];
    const propertyUnits = propertyIds.map(
        (id, index) => ({
            id,
            unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
            buildingUnitId: null,
            pnu: ANCHOR,
            isDeleted: false,
            dong: '101',
            ho: rooms[index],
        })
    );
    const spy = emptySpy();
    const deps = makeDeps({
        databaseTarget: 'development',
        resolver: noEvidence(MEMBER),
        propertyUnits,
        currentLandTuples: propertyIds.map(
            (propertyUnitId) => ({
                propertyUnitId,
                landArea: '10',
                source: 'LADFRL',
            })
        ),
        scans: {
            scanTitle: async () => ({
                state: 'COMPLETE',
                rows: [
                    {
                        ...titleComplete(MULTIPLEX).rows[0],
                        bylotCnt: '0',
                    },
                    {
                        ...titleComplete(DETACHED).rows[0],
                        bylotCnt: '0',
                    },
                ],
                totalCount: 2,
                pagesFetched: 1,
            }),
            scanBasis: async (pnu) => ({
                state: 'COMPLETE',
                rows: [
                    {
                        pnu,
                        mgmBldrgstPk: PK,
                    },
                ],
                totalCount: 1,
                pagesFetched: 1,
            }),
            scanExpos: async (pnu) => ({
                state: 'COMPLETE',
                rows: rooms.map((ho) => ({
                    pnu,
                    mgmBldrgstPk: PK,
                    dongNm: '101',
                    flrNoNm: '1',
                    hoNm: ho,
                })),
                totalCount: rooms.length,
                pagesFetched: 1,
            }),
            scanLdareg: async (pnu) => ({
                state: 'COMPLETE',
                rows: rooms.map((ho, index) => ({
                    pnu,
                    agbldgSn: String(index + 1),
                    ldaQotaRate: '10/100.5',
                    clsSeCode: '1',
                    buldDongNm: '101',
                    buldFloorNm: '1',
                    buldHoNm: ho,
                })),
                totalCount: rooms.length,
                pagesFetched: 1,
            }),
        },
        jobPreviewData: {
            landAreaSync: {
                schemaVersion: 2,
                anchorPnu: ANCHOR,
                sourceDiscoveryJobId: null,
                developmentFullRefresh: marker,
            },
        },
        spy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps,
    });

    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.freezeCalls, 1);
    const prepared =
        spy.frozenSnapshots[0].scopeSnapshot;
    assert.equal(prepared.strategy, 'LDAREG');
    assert.deepEqual(
        prepared.candidatePropertyUnitIds,
        [...propertyIds].sort()
    );
    assert.equal(
        prepared
            .developmentFullRefreshScopeResolution
            ?.pairCount,
        0
    );
    assert.deepEqual(
        prepared
            .developmentFullRefreshScopeResolution
            ?.memberPnus,
        [ANCHOR]
    );
});

test('DEV 전체 갱신은 relation 범위를 사용하지 않고 공식 API를 prepare/apply마다 새로 조회한다', async () => {
    const attachedPnu = '1168010100107360025';
    const unrelatedRelationPnu = '1168010100107360026';
    const marker = developmentFullRefreshMarker();
    const resolver = {
        ...(linked(MEMBER) as Record<string, unknown>),
        componentPnus: [unrelatedRelationPnu],
        linkedBasePnus: [unrelatedRelationPnu],
        linkedPnus: [unrelatedRelationPnu],
        dbScopeHash: 'db-hash-linked-unrelated-relation',
    };
    const propertyUnits = [
        {
            id: PROP_ID,
            unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
            buildingUnitId: null,
            pnu: ANCHOR,
            isDeleted: false,
            dong: '101',
            ho: '301',
        },
    ];
    const currentLandTuples = [
        {
            propertyUnitId: PROP_ID,
            // 공식 LDAREG 분자 합계와 같아도 source/provenance 교체 승인이 필요하다.
            landArea: '10',
            source: 'MANUAL',
        },
    ];
    const scannedTitles: string[] = [];
    const scans = officialTwoPnuLdaregScans(attachedPnu);
    const baseScanTitle = scans.scanTitle!;
    const countedScans = {
        ...scans,
        scanTitle: async (pnu: string, signal?: AbortSignal) => {
            scannedTitles.push(pnu);
            return baseScanTitle(pnu, signal);
        },
    };

    const discoverySpy = emptySpy();
    const discoveryDeps = makeDeps({
        databaseTarget: 'development',
        resolver,
        scans: countedScans,
        propertyUnits,
        currentLandTuples,
        jobPreviewData: {
            landAreaSync: {
                schemaVersion: 2,
                anchorPnu: ANCHOR,
                sourceDiscoveryJobId: null,
                developmentFullRefresh: marker,
            },
        },
        spy: discoverySpy,
    });
    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps: discoveryDeps,
    });

    assert.equal(discoverySpy.applyCalls, 0);
    assert.equal(discoverySpy.freezeCalls, 1);
    assert.equal(
        discoverySpy.terminalCalls[0]?.scopeState,
        'MANUAL_OVERWRITE_CONFIRMATION_REQUIRED'
    );
    assert.deepEqual(scannedTitles, [ANCHOR]);
    const prepared =
        discoverySpy.frozenSnapshots[0].scopeSnapshot;
    assert.deepEqual(
        prepared.developmentFullRefreshScopeResolution,
        {
            source:
                'SAME_RUN_OFFICIAL_DEVELOPMENT_FULL_REFRESH',
            canonicalBasePnu: ANCHOR,
            memberPnus: [ANCHOR, attachedPnu],
            managementPk: PK,
            pairCount: 1,
            officialComponentDigest:
                prepared
                    .developmentFullRefreshScopeResolution
                    ?.officialComponentDigest,
            manifestDigest: marker.manifestDigest,
            scopeDigest: marker.scopeDigest,
        }
    );

    const applySpy = emptySpy();
    const applyDeps = makeDeps({
        databaseTarget: 'development',
        resolver,
        scans: countedScans,
        propertyUnits,
        currentLandTuples,
        jobPreviewData: {
            ...applyJobPreview({
                confirmedDiscoveryScopeHash:
                    prepared.scopeHash,
                confirmedPropertyMembershipHash:
                    prepared.propertyMembershipHash,
                overwriteManualConfirmed: true,
            }),
            landAreaSync: {
                ...(applyJobPreview({
                    confirmedDiscoveryScopeHash:
                        prepared.scopeHash,
                    confirmedPropertyMembershipHash:
                        prepared.propertyMembershipHash,
                    overwriteManualConfirmed: true,
                }).landAreaSync as Record<string, unknown>),
                developmentFullRefresh: marker,
            },
        },
        applyResult: {
            data: { outcome: 'APPLIED', issues: [] },
            error: null,
        },
        spy: applySpy,
    });
    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps: applyDeps,
    });

    assert.deepEqual(
        scannedTitles,
        [ANCHOR, ANCHOR],
        'prepare/apply가 각각 공식 title을 새로 조회한다'
    );
    assert.equal(applySpy.freezeCalls, 0);
    assert.equal(applySpy.applyCalls, 1);
});

test('DEV classification+scope dual review는 active PNU별 동일 호실을 exact bijection하고 대표·부속 전체 API를 조회한다', async () => {
    const attachedPnu = '1168010100107360025';
    const marker = developmentFullRefreshMarker();
    const baseScans = officialTwoPnuLdaregScans(attachedPnu);
    const calls = {
        ldareg: [] as string[],
        expos: [] as string[],
        ladfrl: [] as string[],
        basis: [] as string[],
    };
    const conflictTitle: StrictScan<BrTitleRow> = {
        state: 'COMPLETE',
        rows: [
            {
                ...titleComplete(MULTIPLEX).rows[0],
                bylotCnt: '1',
            },
            {
                mgmBldrgstPk: PK,
                bylotCnt: '1',
                regstrGbCd: '1',
                mainPurpsCd: '03000',
                mainPurpsCdNm: '제1종근린생활시설',
            },
        ],
        totalCount: 2,
        pagesFetched: 1,
    };
    const scans: Partial<LandAreaSyncDeps['scans']> = {
        ...baseScans,
        scanTitle: async () => conflictTitle,
        scanLdareg: async (pnu, signal) => {
            calls.ldareg.push(pnu);
            return baseScans.scanLdareg!(pnu, signal);
        },
        scanExpos: async (pnu, signal) => {
            calls.expos.push(pnu);
            return baseScans.scanExpos!(pnu, signal);
        },
        scanLadfrl: async (pnu, signal) => {
            calls.ladfrl.push(pnu);
            return baseScans.scanLadfrl!(pnu, signal);
        },
        scanBasis: async (pnu, signal) => {
            calls.basis.push(pnu);
            return baseScans.scanBasis!(pnu, signal);
        },
    };
    const attachedPropertyId =
        '22222222-2222-4222-8222-222222222222';
    const propertyUnits = [
        {
            id: PROP_ID,
            unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
            buildingUnitId: 'building-unit-anchor',
            pnu: ANCHOR,
            isDeleted: false,
            dong: '101',
            ho: '301',
        },
        {
            id: attachedPropertyId,
            unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
            buildingUnitId: 'building-unit-attached',
            pnu: attachedPnu,
            isDeleted: false,
            dong: '101',
            ho: '301',
        },
    ];
    const spy = emptySpy();
    const deps = makeDeps({
        databaseTarget: 'development',
        resolver: noEvidence(MEMBER),
        scans,
        propertyUnits,
        buildingUnits: [
            {
                id: 'building-unit-anchor',
                dong: '101',
                floor: '3',
                ho: '301',
            },
            {
                id: 'building-unit-attached',
                dong: '101',
                floor: '3',
                ho: '301',
            },
        ],
        jobPreviewData: {
            landAreaSync: {
                schemaVersion: 2,
                anchorPnu: ANCHOR,
                sourceDiscoveryJobId: null,
                developmentFullRefresh: marker,
            },
        },
        spy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps,
    });

    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.freezeCalls, 1);
    assert.deepEqual(calls.ldareg.sort(), [ANCHOR, attachedPnu]);
    assert.deepEqual(calls.expos.sort(), [ANCHOR, attachedPnu]);
    assert.deepEqual(calls.ladfrl.sort(), [ANCHOR, attachedPnu]);
    assert.deepEqual(calls.basis.sort(), [ANCHOR, attachedPnu]);
    const prepared = spy.frozenSnapshots[0].scopeSnapshot;
    assert.equal(prepared.strategy, 'LDAREG');
    assert.deepEqual(prepared.scannedPnus, [
        ANCHOR,
        attachedPnu,
    ]);
    assert.deepEqual(
        prepared.candidatePropertyUnitIds.slice().sort(),
        [PROP_ID, attachedPropertyId].sort()
    );
    assert.deepEqual(
        prepared.proposedLandAreas
            .map((row) => row.landArea)
            .sort(),
        ['10', '10'],
        'PNU replica numerator는 각 물리 property에서 source identity당 한 번만 합산한다'
    );
    assert.equal(
        prepared.developmentFullRefreshScopeResolution
            ?.pairCount,
        1
    );
});

test('DEV positive official component라도 active PNU 호실 identity가 하나라도 없으면 branch/apply 없이 REVIEW한다', async () => {
    const attachedPnu = '1168010100107360025';
    const marker = developmentFullRefreshMarker();
    const baseScans = officialTwoPnuLdaregScans(attachedPnu);
    let ldaregCalls = 0;
    const spy = emptySpy();
    const deps = makeDeps({
        databaseTarget: 'development',
        resolver: noEvidence(MEMBER),
        scans: {
            ...baseScans,
            scanTitle: async () => ({
                state: 'COMPLETE',
                rows: [
                    {
                        ...titleComplete(MULTIPLEX).rows[0],
                        bylotCnt: '1',
                    },
                    {
                        mgmBldrgstPk: PK,
                        bylotCnt: '1',
                        regstrGbCd: '1',
                        mainPurpsCd: '03000',
                        mainPurpsCdNm:
                            '제1종근린생활시설',
                    },
                ],
                totalCount: 2,
                pagesFetched: 1,
            }),
            scanLdareg: async (pnu, signal) => {
                ldaregCalls += 1;
                return baseScans.scanLdareg!(pnu, signal);
            },
        },
        propertyUnits: [
            {
                id: PROP_ID,
                unionId:
                    MIA_SEVEN_DEVELOPMENT_UNION_ID,
                buildingUnitId: null,
                pnu: ANCHOR,
                isDeleted: false,
                dong: '101',
                ho: '301',
            },
            {
                id: '22222222-2222-4222-8222-222222222222',
                unionId:
                    MIA_SEVEN_DEVELOPMENT_UNION_ID,
                buildingUnitId: null,
                pnu: attachedPnu,
                isDeleted: false,
                dong: '101',
                ho: null,
            },
        ],
        jobPreviewData: {
            landAreaSync: {
                schemaVersion: 2,
                anchorPnu: ANCHOR,
                sourceDiscoveryJobId: null,
                developmentFullRefresh: marker,
            },
        },
        spy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps,
    });
    assert.equal(ldaregCalls, 0);
    assert.equal(spy.freezeCalls, 0);
    assert.equal(spy.applyCalls, 0);
    assert.deepEqual(spy.terminalCalls, [
        {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
        },
    ]);
});

test('DEV official component는 base EXPOS zero라도 attached-only room으로 exact prepare/apply하고 all-zero는 차단한다', async () => {
    const attachedPnu = '1168010100107360025';
    const marker = developmentFullRefreshMarker();
    const baseScans = officialTwoPnuLdaregScans(attachedPnu);
    const attachedOnlyScans: Partial<
        LandAreaSyncDeps['scans']
    > = {
        ...baseScans,
        scanExpos: async (pnu) =>
            pnu === ANCHOR
                ? zero<BrExposRow>()
                : exposComplete([
                      {
                          pnu,
                          mgmBldrgstPk: PK,
                          dongNm: '101',
                          flrNoNm: '3',
                          hoNm: '301',
                      },
                  ]),
    };
    const propertyUnits = [
        {
            id: PROP_ID,
            unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
            buildingUnitId: 'attached-evidence-unit',
            pnu: ANCHOR,
            isDeleted: false,
            dong: '101',
            ho: '301',
        },
    ];
    const common = {
        databaseTarget: 'development' as const,
        resolver: noEvidence(MEMBER),
        scans: attachedOnlyScans,
        propertyUnits,
        buildingUnits: [
            {
                id: 'attached-evidence-unit',
                dong: '101',
                floor: '3',
                ho: '301',
            },
        ],
    };
    const discoverySpy = emptySpy();
    const discoveryDeps = makeDeps({
        ...common,
        jobPreviewData: {
            landAreaSync: {
                schemaVersion: 2,
                anchorPnu: ANCHOR,
                sourceDiscoveryJobId: null,
                developmentFullRefresh: marker,
            },
        },
        spy: discoverySpy,
    });
    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps: discoveryDeps,
    });

    assert.equal(discoverySpy.freezeCalls, 1);
    assert.equal(discoverySpy.applyCalls, 0);
    const prepared =
        discoverySpy.frozenSnapshots[0].scopeSnapshot;
    assert.deepEqual(prepared.candidatePropertyUnitIds, [
        PROP_ID,
    ]);
    assert.deepEqual(prepared.proposedLandAreas, [
        { propertyUnitId: PROP_ID, landArea: '10' },
    ]);

    const applySpy = emptySpy();
    const applyPreview = applyJobPreview({
        confirmedDiscoveryScopeHash: prepared.scopeHash,
        confirmedPropertyMembershipHash:
            prepared.propertyMembershipHash,
    });
    const applyDeps = makeDeps({
        ...common,
        jobPreviewData: {
            ...applyPreview,
            landAreaSync: {
                ...(applyPreview.landAreaSync as Record<
                    string,
                    unknown
                >),
                developmentFullRefresh: marker,
            },
        },
        applyResult: {
            data: { outcome: 'APPLIED', issues: [] },
            error: null,
        },
        spy: applySpy,
    });
    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps: applyDeps,
    });
    assert.equal(applySpy.applyCalls, 1);
    const applyParams = applySpy.lastApplyParams as {
        p_items: Array<{ propertyUnitId: string }>;
    };
    assert.deepEqual(
        applyParams.p_items.map((item) => item.propertyUnitId),
        [PROP_ID]
    );

    const allZeroSpy = emptySpy();
    const allZeroDeps = makeDeps({
        ...common,
        scans: {
            ...attachedOnlyScans,
            scanExpos: async () => zero<BrExposRow>(),
        },
        jobPreviewData: {
            landAreaSync: {
                schemaVersion: 2,
                anchorPnu: ANCHOR,
                sourceDiscoveryJobId: null,
                developmentFullRefresh: marker,
            },
        },
        spy: allZeroSpy,
    });
    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps: allZeroDeps,
    });
    assert.equal(allZeroSpy.freezeCalls, 0);
    assert.equal(allZeroSpy.applyCalls, 0);
    assert.equal(
        allZeroSpy.terminalCalls[0]?.scopeState,
        'REVIEW_REQUIRED'
    );
});

test('DEV query-only attached의 SINGLE cohort도 official unit에 없는 extra active property가 있으면 whole-component REVIEW다', async () => {
    const attachedPnu = '1168010100107360025';
    const marker = developmentFullRefreshMarker();
    const spy = emptySpy();
    const deps = makeDeps({
        databaseTarget: 'development',
        resolver: noEvidence(MEMBER),
        scans: officialTwoPnuLdaregScans(attachedPnu),
        propertyUnits: [
            {
                id: PROP_ID,
                unionId:
                    MIA_SEVEN_DEVELOPMENT_UNION_ID,
                buildingUnitId: null,
                pnu: ANCHOR,
                isDeleted: false,
                dong: '101',
                ho: '301',
            },
            {
                id: '22222222-2222-4222-8222-222222222222',
                unionId:
                    MIA_SEVEN_DEVELOPMENT_UNION_ID,
                buildingUnitId: null,
                pnu: ANCHOR,
                isDeleted: false,
                dong: '101',
                ho: '401',
            },
        ],
        jobPreviewData: {
            landAreaSync: {
                schemaVersion: 2,
                anchorPnu: ANCHOR,
                sourceDiscoveryJobId: null,
                developmentFullRefresh: marker,
            },
        },
        spy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
        deps,
    });
    assert.equal(spy.freezeCalls, 0);
    assert.equal(spy.applyCalls, 0);
    assert.equal(
        spy.terminalCalls[0]?.scopeState,
        'REVIEW_REQUIRED'
    );
    assert.ok(
        spy.terminalIssues[0].some(
            (issue) => issue.code === 'PROPERTY_UNIT_NOT_FOUND'
        )
    );
});

test('DEV 전체 갱신 표식은 production target에서 worker 진입 전에 거부한다', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        databaseTarget: 'production',
        resolver: noEvidence(MEMBER),
        jobPreviewData: {
            landAreaSync: {
                schemaVersion: 2,
                anchorPnu: ANCHOR,
                sourceDiscoveryJobId: null,
                developmentFullRefresh:
                    developmentFullRefreshMarker(),
            },
        },
        spy,
    });
    await assert.rejects(
        runLandAreaSyncJob({
            jobId: 'job-1',
            unionId: MIA_SEVEN_DEVELOPMENT_UNION_ID,
            deps,
        }),
        /운영 환경/
    );
    assert.equal(spy.resolverParams.length, 0);
    assert.equal(spy.freezeCalls, 0);
    assert.equal(spy.applyCalls, 0);
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

test('같은 higher up을 공유하는 복수 title self도 REVIEW로 닫고 branch scan/apply를 하지 않는다', async () => {
    const sibling = '1168010100107360025';
    const otherRoot = '9001002003004';
    const spy = emptySpy();
    let ldaregCalls = 0;
    let ladfrlCalls = 0;
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
            scanLadfrl: async () => {
                ladfrlCalls += 1;
                return zero<LadfrlRow>();
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
    // 표제부 self root가 둘이므로 선출 pre-pass(Phase 3.5)가 base PNU마다(ANCHOR, sibling)
    // LDAREG를 조회한다(§9.1 개정) — ldaregCalls=2는 pre-pass의 근거. 하지만 LDAREG 행 근거가
    // 없어 선출은 INDETERMINATE로 끝나고, LADFRL은 호출되지 않음 (ladfrlCalls=0) 으로 per-PNU
    // scan 분기(runLdaregBranch)에 도달하지 않음을 증명한다.
    assert.equal(ldaregCalls, 2);
    assert.equal(ladfrlCalls, 0);
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

test('읽기 전용 모드는 확인 완료 apply job도 모든 DB write 전에 차단한다', async () => {
    const disc = emptySpy();
    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: 'union-1',
        deps: makeDeps({
            resolver: noEvidence(MEMBER),
            scans: { scanTitle: async () => titleComplete(MULTIPLEX) },
            spy: disc,
        }),
    });
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
    deps.executionMode = 'READ_ONLY_CAPTURE';

    await assert.rejects(
        runLandAreaSyncJob({
            jobId: 'job-1',
            unionId: 'union-1',
            deps,
        }),
        (error: unknown) =>
            error instanceof Error &&
            (error as Error & { code?: string }).code ===
                'READ_ONLY_CAPTURE_APPLY_BLOCKED'
    );
    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.freezeCalls, 0);
    assert.equal(spy.terminalCalls.length, 0);
    assert.equal(spy.failedCalls.length, 0);
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

// ── Finding 3: LINKED discovery extraIssue·ambiguity write barrier ─────────────

test('LINKED LDAREG 즉시적용: 비적용 placeholder 정확히 1행은 issue 없이 제외한다', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: {
            scanTitle: async () => titleComplete(MULTIPLEX),
            // 실측형 비적용 placeholder는 유효 CURRENT component를 막지 않는 유일한 정보성 issue다.
            scanLdareg: async () => ({
                state: 'COMPLETE',
                rows: [
                    { pnu: ANCHOR, agbldgSn: '1', ldaQotaRate: '10/100.5', clsSeCode: '0', clsSeCodeNm: '현재', buldDongNm: '101', buldFloorNm: '3', buldHoNm: '301' },
                    { pnu: ANCHOR, agbldgSn: '2', ldaQotaRate: '', clsSeCode: '0', clsSeCodeNm: '현재', buldDongNm: '0000', buldFloorNm: '0000', buldHoNm: '0000', buldRoomNm: '0000' },
                ],
                totalCount: 2,
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
        []
    );
});

test('LINKED LDAREG: 비적용 placeholder가 2행이면 component 전체를 차단하고 apply RPC를 호출하지 않는다', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: {
            scanTitle: async () => titleComplete(MULTIPLEX),
            scanLdareg: async () => ({
                state: 'COMPLETE',
                rows: [
                    { pnu: ANCHOR, agbldgSn: '1', ldaQotaRate: '10/100.5', clsSeCode: '0', clsSeCodeNm: '현재', buldDongNm: '101', buldFloorNm: '3', buldHoNm: '301' },
                    { pnu: ANCHOR, agbldgSn: '2', ldaQotaRate: '', clsSeCode: '0', clsSeCodeNm: '현재', buldDongNm: '0000', buldFloorNm: '0000', buldHoNm: '0000', buldRoomNm: '0000' },
                    { pnu: ANCHOR, agbldgSn: '3', ldaQotaRate: '', clsSeCode: '0', clsSeCodeNm: '현재', buldDongNm: '0000', buldFloorNm: '0000', buldHoNm: '0000', buldRoomNm: '0000' },
                ],
                totalCount: 3,
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
        spy,
    });

    await runLandAreaSyncJob({
        jobId: 'job-1',
        unionId: 'union-1',
        deps,
    });

    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.freezeCalls, 0);
    assert.deepEqual(spy.terminalCalls, [
        {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
        },
    ]);
    assert.deepEqual(
        spy.terminalIssues[0].map((issue) => issue.code),
        ['RATIO_PARSE_FAILED']
    );
});

test('LINKED LDAREG clsSeCode ambiguity는 apply items를 사용하지 않고 RPC 0회로 전체 차단한다', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: {
            scanTitle: async () => titleComplete(MULTIPLEX),
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
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });

    assert.equal(spy.applyCalls, 0, 'ambiguity는 apply RPC 전에 차단한다');
    assert.equal(spy.freezeCalls, 0);
    assert.equal(spy.terminalCalls[0].scopeState, 'REVIEW_REQUIRED');
    assert.ok(
        spy.terminalIssues[0].some((issue) => issue.code === 'LDAREG_IDENTITY_CONFLICT'),
        '진단 issue는 보존한다'
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
