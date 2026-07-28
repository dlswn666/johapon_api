/**
 * LAND_AREA_SYNC discovery/apply 오케스트레이션 (DESIGN §8·§13·§14).
 *
 * 한 job(discovery 또는 apply)에 대해 §8 흐름도 순서로 파이프라인을 실행한다:
 *   title seed → DB resolver → gate 입력 scan → 공통 gate → 분기 scan → 분류·매칭 →
 *   3층 hash·snapshot CAS 고정 → write barrier 충족 시 apply RPC 정확히 1회(또는 0회) → terminal.
 *
 * 외부 HTTP·DB 접근은 전부 주입(deps)한다. transaction 은 apply RPC 내부에서만 열리므로 이
 * 오케스트레이터의 모든 scan/resolve 는 DB transaction 밖이다. terminal/fatal 후 늦은 callback 은
 * AbortSignal 로 차단하고, apply RPC 자체도 terminal job 을 거부한다(이중 방어).
 */

import {
    createDevelopmentFullRefreshOfficialOnlyDbScope,
    createSameRunOfficialDevelopmentFullRefreshEffectiveScope,
    createSameRunOfficialReadOnlyEffectiveScope,
    parseDbScopeResolution,
    resolveParcelScopeCompleteness,
    resolveSameRunOfficialDevelopmentFullRefreshComponent,
    resolveSameRunOfficialDevelopmentFullRefreshParcelSingletonComponent,
    resolveSameRunOfficialReadOnlyComponent,
    type DbScopeResolution,
    type BasePnuScan,
    type SameRunOfficialDevelopmentFullRefreshComponent,
    type SameRunOfficialReadOnlyComponent,
} from './scope';
import { BYLOT_SOURCE_POLICY, bylotBasisFallbackPlan } from './bylot';
import {
    assembleAttachedPnus,
    buildingHubRowsMatchPnu,
    type AtchJibunRowInput,
} from '../gis-shared/pnu';
import { buildScopeEvidence, buildScopeSnapshot, capIssues, sanitizeIssue, emptyCounts } from './preview';
import {
    assembleLdaregApply,
    resolveLdaregPropertyMembershipLayout,
    selectCanonicalExposSourcePnu,
    type LdaregPropertyMembershipMode,
    type LdaregPnuScan,
} from './ldareg-branch';
import { resolveScopeLadfrlAreas } from './ladfrl-scope';
import {
    isOptionalRegistryManagementPkValid,
    normalizeRegistryManagementPk,
} from './registry-pk';
import { resolveParcelSingletonLadfrlCandidate } from './parcel-singleton';
import { readLandAreaSync, type LandAreaSyncJobRow } from './repository';
import type {
    BrTitleRow,
    BrAtchJibunRow,
    BrBasisOulnRow,
    BrExposRow,
    LadfrlRow,
    LdaregRow,
    StrictScan,
    LandAreaSyncIssueCode,
} from '../../types/land-area-sync.types';
import type {
    BuildingUnitCandidate,
    PropertyUnitCandidate,
} from './matcher';
import type {
    LandAreaSyncStrategy,
    LandAreaSyncScopeState,
    LandAreaSyncOutcome,
    LandAreaSyncScanCompleteness,
    LandAreaSyncCounts,
    LandAreaSyncIssue,
    LandAreaSyncLandTuple,
    LandAreaSyncProposedArea,
    LandAreaSyncScopeSnapshot,
    LandAreaSyncConfirmation,
    LandAreaSyncApplyLadfrlItem,
    LandAreaSyncApplyLdaregItem,
    ApplyPropertyLandAreaSyncParams,
    LandAreaSyncDevelopmentFullRefresh,
    ResolveScopeParams,
} from '../../types/land-area-sync-job.types';
import type { DatabaseTarget } from '../../types/database.types';
import {
    assertDevelopmentLandAreaFullRefreshAllowed,
    parseDevelopmentLandAreaFullRefreshMarker,
} from '../../security/development-land-area-full-refresh-policy';

// ── 주입 계약 ─────────────────────────────────────────────────────

export interface LandAreaSyncScanDeps {
    scanTitle(pnu: string, signal?: AbortSignal): Promise<StrictScan<BrTitleRow>>;
    scanAttached(pnu: string, signal?: AbortSignal): Promise<StrictScan<BrAtchJibunRow>>;
    scanBasis(pnu: string, signal?: AbortSignal): Promise<StrictScan<BrBasisOulnRow>>;
    scanExpos(pnu: string, signal?: AbortSignal): Promise<StrictScan<BrExposRow>>;
    scanLadfrl(pnu: string, signal?: AbortSignal): Promise<StrictScan<LadfrlRow>>;
    scanLdareg(pnu: string, signal?: AbortSignal): Promise<StrictScan<LdaregRow>>;
}

export interface LandAreaSyncTerminalInput {
    status: 'COMPLETED' | 'FAILED';
    scopeState: LandAreaSyncScopeState;
    /** APPLIED/PARTIAL terminal은 atomic apply RPC에서만 생성한다. */
    outcome: Exclude<
        LandAreaSyncOutcome,
        'APPLIED' | 'PARTIAL'
    >;
    counts: LandAreaSyncCounts;
    issues: LandAreaSyncIssue[];
    issuesTotal: number;
    issuesTruncated: boolean;
    errorLog?: string;
}

export interface LandAreaSyncDbDeps {
    resolveScope(params: ResolveScopeParams): Promise<{ data: unknown; error: { message: string } | null }>;
    applyRpc(
        params: ApplyPropertyLandAreaSyncParams
    ): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
    getScopedJob(jobId: string, unionId: string): Promise<LandAreaSyncJobRow | null>;
    freezeScopeSnapshot(
        jobId: string,
        unionId: string,
        patch: {
            scopeState: LandAreaSyncScopeState;
            scopeEvidence: ReturnType<typeof buildScopeEvidence>;
            scopeSnapshot: LandAreaSyncScopeSnapshot;
            branch: LandAreaSyncStrategy;
        }
    ): Promise<boolean>;
    writeDiscoveryTerminal(jobId: string, unionId: string, input: LandAreaSyncTerminalInput): Promise<boolean>;
    markScopedFailed(jobId: string, unionId: string, message: string): Promise<boolean>;
    readBuildingUnits(unionId: string, scopePnus: string[]): Promise<BuildingUnitCandidate[]>;
    readPropertyUnits(unionId: string, scopePnus: string[]): Promise<PropertyUnitCandidate[]>;
    readCurrentLandTuples(unionId: string, propertyUnitIds: string[]): Promise<LandAreaSyncLandTuple[]>;
}

export interface LandAreaSyncDeps {
    scans: LandAreaSyncScanDeps;
    db: LandAreaSyncDbDeps;
    /** full-refresh production hard deny와 DB target lineage 검증용. */
    databaseTarget?: DatabaseTarget;
    now(): Date;
    /** apply 직전 resolved scope의 모든 PNU를 DB target-qualified allowlist로 재검증한다. */
    assertCanaryScopeAllowed(unionId: string, scannedPnus: readonly string[]): void;
    /**
     * 읽기 전용 증거 캡처는 LINKED LDAREG discovery도 snapshot 고정까지만 수행한다.
     * 실제 API 런타임은 값을 주입하지 않아 기존 자동 apply 계약을 유지한다.
     */
    executionMode?: 'READ_ONLY_CAPTURE';
}

export interface RunLandAreaSyncArgs {
    jobId: string;
    unionId: string;
    deps: LandAreaSyncDeps;
    signal?: AbortSignal;
}

// ── 유틸 ──────────────────────────────────────────────────────────

function str(v: unknown): string {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function membershipArray(m: unknown): Array<Record<string, unknown>> {
    return Array.isArray(m) ? m.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
}

export type DevelopmentFullRefreshLdaregPropertyMembershipMode =
    LdaregPropertyMembershipMode;

/**
 * DEV 전체 갱신의 positive official component에서만 쓰는 활성 호실 membership gate.
 *
 * - 모든 활성 row가 official member PNU 안에 있고 non-empty ho identity를 가져야 한다.
 * - 둘 이상의 PNU가 property를 보유하면 각 PNU의 normalized dong+ho 집합이 exact 같아야
 *   한다. query-only attached PNU(활성 property 0)는 match cohort에서 제외한다.
 * - 한 PNU 안의 중복 room identity, 중복 id, 부분 cohort는 모두 null(REVIEW)이다.
 *
 * MANUAL/land_area/source 값은 입력에도 없으며 판정에 사용하지 않는다.
 */
export function resolveDevelopmentFullRefreshLdaregPropertyMembershipMode(
    input: {
        unionId: string;
        component: SameRunOfficialDevelopmentFullRefreshComponent;
        propertyUnits: PropertyUnitCandidate[];
    }
): DevelopmentFullRefreshLdaregPropertyMembershipMode | null {
    const { unionId, component } = input;
    const memberPnus = [...new Set(component.memberPnus)].sort();
    if (
        component.pairCount <= 0 ||
        memberPnus.length !== component.memberPnus.length ||
        memberPnus.length !== component.pairCount + 1 ||
        !memberPnus.includes(component.canonicalBasePnu)
    ) {
        return null;
    }
    const memberSet = new Set(memberPnus);
    if (
        input.propertyUnits
            .filter((row) => !row.isDeleted)
            .some(
                (row) =>
                    typeof row.pnu !== 'string' ||
                    !memberSet.has(row.pnu)
            )
    ) {
        return null;
    }
    return (
        resolveLdaregPropertyMembershipLayout({
            unionId,
            expectedTargetPnus: memberPnus,
            propertyUnits: input.propertyUnits,
        })?.mode ?? null
    );
}

function aborted(signal?: AbortSignal): boolean {
    return signal?.aborted === true;
}

/**
 * 한 title scan → 정렬된 distinct resolver root 관리 PK. 계열 grouping 목적이므로 up-PK 우선
 * (`mgmUpBldrgstPk` 있으면 그 값, 없으면 `mgmBldrgstPk`). anchor title 로 뽑은 결과가
 * resolver 호출 입력(`p_root_mgm_bldrgst_pks`)이자 snapshot.resolverRootPks 로 고정된다(C1).
 * LDAREG branch title root(self) 선택과는 의도적으로 별도 축이다.
 */
function deriveRootPks(scan: StrictScan<BrTitleRow>): string[] {
    return collectResolverRootPks([scan]);
}

/**
 * §10.4 LDAREG root: gate에 채택된 모든 base title의 exact self-PK 집합.
 * 같은 self 반복은 dedup하지만, 같은 higher up을 공유하더라도 self가 둘이면 하나로 합치지 않는다.
 */
function deriveLdaregTitleSelfRootPks(baseScans: BasePnuScan[]): string[] {
    const roots = new Set<string>();
    for (const base of baseScans) {
        if (base.title.state !== 'COMPLETE') continue;
        for (const row of base.title.rows) {
            const self = normalizeRegistryManagementPk(
                row.mgmBldrgstPk
            );
            if (self) roots.add(self);
        }
    }
    return [...roots].sort();
}

/** LDAREG branch가 허용하는 전 base title self root exactly-one gate. */
export function selectSingleLdaregRootIdentity(
    baseScans: BasePnuScan[]
): string | null {
    const roots = deriveLdaregTitleSelfRootPks(baseScans);
    return roots.length === 1 ? roots[0] : null;
}

/** resolver 입력 전용: title scan 묶음에서 up-PK 우선 root를 정렬·dedup 수집한다. */
function collectResolverRootPks(scans: StrictScan<BrTitleRow>[]): string[] {
    const set = new Set<string>();
    for (const scan of scans) {
        if (scan.state !== 'COMPLETE') continue;
        for (const r of scan.rows) {
            const root =
                normalizeRegistryManagementPk(r.mgmUpBldrgstPk) ??
                normalizeRegistryManagementPk(r.mgmBldrgstPk);
            if (root) set.add(root);
        }
    }
    return [...set].sort();
}

/** COMPLETE row 만 반환. */
function rows<T>(scan: StrictScan<T>): T[] {
    return scan.state === 'COMPLETE' ? scan.rows : [];
}

function requiredScanState(scan: StrictScan<unknown>): 'OK' | 'FAILED' | 'INCOMPLETE' {
    if (scan.state === 'FAILED') return 'FAILED';
    if (scan.state === 'INCOMPLETE') return 'INCOMPLETE';
    return 'OK'; // COMPLETE / COMPLETE_ZERO
}

// ── 메인 오케스트레이션 ────────────────────────────────────────────

export async function runLandAreaSyncJob(args: RunLandAreaSyncArgs): Promise<void> {
    const { jobId, unionId, deps, signal } = args;
    const scanStartedAt = deps.now().toISOString();

    const jobRow = await deps.db.getScopedJob(jobId, unionId);
    if (!jobRow) {
        throw Object.assign(new Error('LAND_AREA_SYNC job 을 찾을 수 없습니다.'), { code: 'JOB_NOT_FOUND' });
    }
    const land = readLandAreaSync(jobRow) ?? {};
    const anchorPnu = str(land.anchorPnu);
    if (!/^[0-9]{19}$/.test(anchorPnu)) {
        await deps.db.markScopedFailed(jobId, unionId, 'anchor PNU 가 유효하지 않습니다.');
        return;
    }
    const developmentFullRefresh =
        parseDevelopmentLandAreaFullRefreshMarker(
            land.developmentFullRefresh
        );
    if (developmentFullRefresh) {
        assertDevelopmentLandAreaFullRefreshAllowed({
            databaseTarget: deps.databaseTarget,
            unionId,
            marker: developmentFullRefresh,
        });
    }
    const isApplyJob = typeof land.sourceDiscoveryJobId === 'string' && land.confirmation != null;
    const overwriteManualConfirmed =
        isApplyJob && (land.confirmation as { overwriteManualConfirmed?: boolean } | null)?.overwriteManualConfirmed === true;

    // ── Phase 1: title seed(외부 호출 — transaction 밖) ──
    const titleSeed = await deps.scans.scanTitle(anchorPnu, signal);
    if (aborted(signal)) return;
    const rootPks = deriveRootPks(titleSeed);

    // ── Phase 2: DB resolver(read-only) ──
    const resolveRes = await deps.db.resolveScope({
        p_union_id: unionId,
        p_anchor_pnu: anchorPnu,
        p_root_mgm_bldrgst_pks: rootPks,
    });
    if (resolveRes.error) {
        await deps.db.markScopedFailed(jobId, unionId, `scope resolver 실패: ${resolveRes.error.message}`);
        return;
    }
    const dbScope = parseDbScopeResolution(resolveRes.data);
    if (aborted(signal)) return;

    // ── Phase 3: gate 입력 scan 완료(LINKED: 전 base / no-cache: anchor) ──
    const basePnus =
        developmentFullRefresh
            ? [anchorPnu]
            : dbScope.dbState === 'LINKED' &&
                dbScope.linkedBasePnus.length > 0
            ? [...new Set(dbScope.linkedBasePnus)].sort()
            : [anchorPnu];
    const policy = BYLOT_SOURCE_POLICY.policy;
    const baseScans: BasePnuScan[] = [];
    const titleByPnu: Array<{ pnu: string; titleRows: BrTitleRow[] }> = [];
    for (const pnu of basePnus) {
        const title = pnu === anchorPnu ? titleSeed : await deps.scans.scanTitle(pnu, signal);
        if (aborted(signal)) return;
        const attached = await deps.scans.scanAttached(pnu, signal);
        if (aborted(signal)) return;
        baseScans.push({ pnu, title, attached });
        titleByPnu.push({ pnu, titleRows: rows(title) });
    }
    // basis fallback(정책이 fallback 일 때만) — 필요한 PNU 만 1회 조회.
    for (const pnu of bylotBasisFallbackPlan(titleByPnu, policy)) {
        const basis = await deps.scans.scanBasis(pnu, signal);
        if (aborted(signal)) return;
        const entry = baseScans.find((b) => b.pnu === pnu);
        if (entry) entry.basis = basis;
    }

    // ── Phase 4: 공통 gate ──
    let effectiveDbScope =
        (developmentFullRefresh
            ? createDevelopmentFullRefreshOfficialOnlyDbScope(
                  dbScope,
                  anchorPnu
              )
            : null) ?? dbScope;
    let preloadedPropertyUnits: PropertyUnitCandidate[] | null = null;
    let readOnlyScopeResolution:
        | SameRunOfficialReadOnlyComponent
        | null = null;
    let developmentFullRefreshScopeResolution:
        | SameRunOfficialDevelopmentFullRefreshComponent
        | null = null;
    let developmentFullRefreshLdaregPropertyMembershipMode:
        | DevelopmentFullRefreshLdaregPropertyMembershipMode
        | null = null;
    let developmentFullRefreshLdaregClassificationOverride = false;
    let gate = resolveParcelScopeCompleteness({
        dbScope: effectiveDbScope,
        baseScans,
        policy,
    });

    // relation이 없는 공식 attached component는 READ_ONLY_CAPTURE, 또는 repo-pinned
    // DEV 전체 갱신에서만 같은 실행의 strict title/attached/bylot으로 확장한다.
    // DEV 전체 갱신은 discovery와 apply가 각각 새로 이 분기를 실행한다.
    if (
        (deps.executionMode === 'READ_ONLY_CAPTURE' &&
            !isApplyJob) ||
        developmentFullRefresh
    ) {
        const component = developmentFullRefresh
            ? resolveSameRunOfficialDevelopmentFullRefreshComponent({
                  anchorPnu,
                  dbScope,
                  baseScans,
                  policy,
              })
            : resolveSameRunOfficialReadOnlyComponent({
                  anchorPnu,
                  dbScope,
                  baseScans,
                  policy,
              });
        if (component) {
            deps.assertCanaryScopeAllowed(
                unionId,
                component.memberPnus
            );
            preloadedPropertyUnits =
                await deps.db.readPropertyUnits(
                    unionId,
                    component.memberPnus
                );
            if (aborted(signal)) return;
            const memberSet = new Set(component.memberPnus);
            const activePropertyUnits = preloadedPropertyUnits.filter(
                (row) => !row.isDeleted
            );
            if (
                activePropertyUnits.some(
                    (row) =>
                        row.unionId !== unionId ||
                        typeof row.pnu !== 'string' ||
                        !memberSet.has(row.pnu)
                ) ||
                new Set(activePropertyUnits.map((row) => row.id)).size !==
                    activePropertyUnits.length
            ) {
                throw new Error(
                    developmentFullRefresh
                        ? 'DEVELOPMENT_FULL_REFRESH_SCOPE_MEMBERSHIP_INVALID'
                        : 'READ_ONLY_SCOPE_MEMBERSHIP_INVALID'
                );
            }
            const propertyMembership = activePropertyUnits
                .map((row) => ({
                    propertyUnitId: row.id,
                    pnu: row.pnu,
                }))
                .sort((left, right) =>
                    left.propertyUnitId.localeCompare(
                        right.propertyUnitId
                    )
                );
            const ldaregPropertyMembershipMode =
                developmentFullRefresh &&
                component.pairCount > 0
                    ? resolveDevelopmentFullRefreshLdaregPropertyMembershipMode(
                          {
                              unionId,
                              component:
                                  component as SameRunOfficialDevelopmentFullRefreshComponent,
                              propertyUnits:
                                  preloadedPropertyUnits,
                          }
                      )
                    : null;
            effectiveDbScope = developmentFullRefresh
                ? createSameRunOfficialDevelopmentFullRefreshEffectiveScope(
                      {
                          dbScope,
                          component:
                              component as SameRunOfficialDevelopmentFullRefreshComponent,
                          propertyMembership,
                      }
                  )
                : createSameRunOfficialReadOnlyEffectiveScope({
                      dbScope,
                      component:
                          component as SameRunOfficialReadOnlyComponent,
                      propertyMembership,
                  });
            gate = resolveParcelScopeCompleteness({
                dbScope: effectiveDbScope,
                baseScans,
                policy,
            });
            if (gate.state === 'LINKED_SCOPE_RESOLVED') {
                if (developmentFullRefresh) {
                    if (
                        component.pairCount === 0 ||
                        ldaregPropertyMembershipMode !== null
                    ) {
                        developmentFullRefreshScopeResolution =
                            component as SameRunOfficialDevelopmentFullRefreshComponent;
                        developmentFullRefreshLdaregPropertyMembershipMode =
                            ldaregPropertyMembershipMode;
                    }
                } else {
                    readOnlyScopeResolution =
                        component as SameRunOfficialReadOnlyComponent;
                }
            } else if (
                developmentFullRefresh &&
                component.pairCount > 0 &&
                ldaregPropertyMembershipMode !== null &&
                gate.state === 'REVIEW_REQUIRED' &&
                gate.issues.length === 1 &&
                gate.issues[0] ===
                    'BUILDING_CLASSIFICATION_CONFLICT' &&
                gate.classification.kind ===
                    'REVIEW_REQUIRED' &&
                gate.classification.issue ===
                    'BUILDING_CLASSIFICATION_CONFLICT'
            ) {
                // component scope는 strict official evidence로 확정됐다. 다만 일반
                // classifier 계약은 그대로 REVIEW이며, DEV full-refresh + positive
                // component + exact room membership에서만 LDAREG strict branch로 보낸다.
                developmentFullRefreshScopeResolution =
                    component as SameRunOfficialDevelopmentFullRefreshComponent;
                developmentFullRefreshLdaregPropertyMembershipMode =
                    ldaregPropertyMembershipMode;
                developmentFullRefreshLdaregClassificationOverride =
                    true;
            }
        }
    }

    const attachedAll: BrAtchJibunRow[] = baseScans.flatMap((b) => rows(b.attached));
    const assembledAttached = assembleAttachedPnus(
        attachedAll.map((row) => ({
            ...row,
            mgmBldrgstPk: normalizeRegistryManagementPk(row.mgmBldrgstPk) ?? '',
        })) as unknown as AtchJibunRowInput[]
    );
    const scopeEvidence = buildScopeEvidence(dbScope, {
        attachedRows: attachedAll.length,
        distinctAttachedPnuCount: new Set(assembledAttached.pairs.map((p) => p.attachedPnu)).size,
    });

    if (gate.state === 'FAILED') {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'FAILED',
            scopeState: 'FAILED',
            outcome: 'FAILED',
            issues: gate.issues.map((code) => ({ code })),
            counts: gateCounts(baseScans),
        });
        return;
    }
    let parcelSingletonBasis:
        | 'CLASSIFICATION_CONFLICT_DB_PARCEL_SINGLETON'
        | null = null;
    const parcelSingletonReviewIssues =
        gate.issues.length === 1 &&
        gate.issues[0] ===
            'BUILDING_CLASSIFICATION_CONFLICT'
            ? true
            : developmentFullRefresh !== null &&
              gate.issues.length === 2 &&
              gate.issues[0] ===
                  'BUILDING_CLASSIFICATION_CONFLICT' &&
              gate.issues[1] === 'SCOPE_NOT_LINKED';
    if (
        gate.state === 'REVIEW_REQUIRED' &&
        parcelSingletonReviewIssues &&
        gate.scannedPnus.length === 1
    ) {
        const [propertyUnits, buildingUnits] = await Promise.all([
            deps.db.readPropertyUnits(unionId, gate.scannedPnus),
            deps.db.readBuildingUnits(unionId, gate.scannedPnus),
        ]);
        if (aborted(signal)) return;
        const decision = resolveParcelSingletonLadfrlCandidate({
            unionId,
            targetPnu: gate.scannedPnus[0],
            scannedPnus: gate.scannedPnus,
            membership: dbScope.propertyMembership,
            propertyUnits,
            buildingUnits,
        });
        if (decision.kind === 'ELIGIBLE') {
            parcelSingletonBasis = decision.basis;
            if (
                developmentFullRefresh !== null &&
                developmentFullRefreshScopeResolution === null
            ) {
                const component =
                    resolveSameRunOfficialDevelopmentFullRefreshParcelSingletonComponent(
                        {
                            anchorPnu,
                            dbScope,
                            baseScans,
                            policy,
                            parcelSingletonBasis:
                                decision.basis,
                        }
                    );
                if (component) {
                    deps.assertCanaryScopeAllowed(
                        unionId,
                        component.memberPnus
                    );
                    const memberSet = new Set(
                        component.memberPnus
                    );
                    const activePropertyUnits =
                        propertyUnits.filter(
                            (row) => !row.isDeleted
                        );
                    if (
                        activePropertyUnits.some(
                            (row) =>
                                row.unionId !== unionId ||
                                typeof row.pnu !== 'string' ||
                                !memberSet.has(row.pnu)
                        ) ||
                        new Set(
                            activePropertyUnits.map(
                                (row) => row.id
                            )
                        ).size !==
                            activePropertyUnits.length
                    ) {
                        throw new Error(
                            'DEVELOPMENT_FULL_REFRESH_SCOPE_MEMBERSHIP_INVALID'
                        );
                    }
                    const propertyMembership =
                        activePropertyUnits
                            .map((row) => ({
                                propertyUnitId: row.id,
                                pnu: row.pnu,
                            }))
                            .sort((left, right) =>
                                left.propertyUnitId.localeCompare(
                                    right.propertyUnitId
                                )
                            );
                    preloadedPropertyUnits =
                        propertyUnits;
                    effectiveDbScope =
                        createSameRunOfficialDevelopmentFullRefreshEffectiveScope(
                            {
                                dbScope,
                                component,
                                propertyMembership,
                            }
                        );
                    gate = resolveParcelScopeCompleteness({
                        dbScope: effectiveDbScope,
                        baseScans,
                        policy,
                    });
                    developmentFullRefreshScopeResolution =
                        component;
                }
            }
        }
    }
    if (
        gate.state === 'REVIEW_REQUIRED' &&
        parcelSingletonBasis === null &&
        !developmentFullRefreshLdaregClassificationOverride
    ) {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
            issues: gate.issues.map((code) => ({ code })),
            counts: gateCounts(baseScans),
        });
        return;
    }
    if (
        developmentFullRefresh !== null &&
        developmentFullRefreshScopeResolution === null
    ) {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
            issues: (
                gate.issues.length > 0
                    ? gate.issues
                    : ['SCOPE_NOT_LINKED' as const]
            ).map((code) => ({ code })),
            counts: gateCounts(baseScans),
        });
        return;
    }

    const strategy: LandAreaSyncStrategy | null =
        developmentFullRefreshLdaregClassificationOverride
            ? 'LDAREG'
            : parcelSingletonBasis !== null
            ? 'LADFRL'
            : gate.classification.kind === 'CLASSIFIED'
              ? gate.classification.family
              : null;
    if (!strategy) {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
            issues: [{ code: 'BUILDING_CLASSIFICATION_CONFLICT' }],
            counts: gateCounts(baseScans),
        });
        return;
    }

    // ── Phase 5: 분기 ──
    const ctx: BranchContext = {
        jobId,
        unionId,
        deps,
        signal,
        anchorPnu,
        isApplyJob,
        overwriteManualConfirmed,
        confirmation: (land.confirmation as LandAreaSyncConfirmation | null | undefined) ?? null,
        scanStartedAt,
        dbScope: effectiveDbScope,
        scopeEvidence,
        // gate 는 SINGLE_PNU_CONFIRMED 를 스스로 발급하지 않는다. 방어적으로 confirmation 요구로 취급.
        gateState:
            gate.state === 'LINKED_SCOPE_RESOLVED' ||
            developmentFullRefreshLdaregClassificationOverride
                ? 'LINKED_SCOPE_RESOLVED'
                : 'SINGLE_SCOPE_CONFIRMATION_REQUIRED',
        scannedPnus: gate.scannedPnus,
        bylot: gate.bylot,
        dbScopeHash: gate.dbScopeHash,
        externalScopeDigest: gate.externalScopeDigest,
        // resolver 호출 입력(anchor title 계열 root) — snapshot.resolverRootPks 로 고정한다(C1 계약).
        resolverRootPks: rootPks,
        baseScans,
        parcelSingletonBasis,
        preloadedPropertyUnits,
        readOnlyScopeResolution,
        developmentFullRefresh,
        developmentFullRefreshScopeResolution,
        developmentFullRefreshLdaregPropertyMembershipMode,
    };

    if (strategy === 'LADFRL') {
        await runLadfrlBranch(ctx);
    } else {
        await runLdaregBranch(ctx);
    }
}

// ── 분기 컨텍스트 ─────────────────────────────────────────────────

interface BranchContext {
    jobId: string;
    unionId: string;
    deps: LandAreaSyncDeps;
    signal?: AbortSignal;
    anchorPnu: string;
    isApplyJob: boolean;
    overwriteManualConfirmed: boolean;
    /** apply job(=확인 후속 job)의 immutable confirmation. discovery/LINKED apply 는 null. */
    confirmation: LandAreaSyncConfirmation | null;
    scanStartedAt: string;
    dbScope: DbScopeResolution;
    scopeEvidence: ReturnType<typeof buildScopeEvidence>;
    gateState: 'SINGLE_SCOPE_CONFIRMATION_REQUIRED' | 'LINKED_SCOPE_RESOLVED';
    scannedPnus: string[];
    bylot: import('./bylot').BylotResolution;
    dbScopeHash: string;
    externalScopeDigest: string;
    /** resolver 호출에 실제 쓴 root 식별자(anchor title 계열, 정렬·dedup). snapshot 고정 대상(C1). */
    resolverRootPks: string[];
    baseScans: BasePnuScan[];
    /** 분류 불확정이어도 unit identity가 전혀 없는 DB parcel singleton임을 입증한 좁은 경로. */
    parcelSingletonBasis:
        | 'CLASSIFICATION_CONFLICT_DB_PARCEL_SINGLETON'
        | null;
    /** same-run official component에서 이미 읽은 matcher 후보(중복 DB read 방지). */
    preloadedPropertyUnits: PropertyUnitCandidate[] | null;
    /** 일반 apply로 승격할 수 없는 READ_ONLY_CAPTURE 전용 scope provenance. */
    readOnlyScopeResolution:
        | SameRunOfficialReadOnlyComponent
        | null;
    /** repo-pinned DEV 전체 API 재조회 표식. */
    developmentFullRefresh:
        | LandAreaSyncDevelopmentFullRefresh
        | null;
    /** relation과 독립적으로 같은 실행에서 확정한 공식 component. */
    developmentFullRefreshScopeResolution:
        | SameRunOfficialDevelopmentFullRefreshComponent
        | null;
    /** positive component의 활성 property 배치 형태. LDAREG matcher opt-in에만 사용한다. */
    developmentFullRefreshLdaregPropertyMembershipMode:
        | DevelopmentFullRefreshLdaregPropertyMembershipMode
        | null;
}

// ── LADFRL 분기 ───────────────────────────────────────────────────

async function runLadfrlBranch(ctx: BranchContext): Promise<void> {
    const { deps, jobId, unionId, signal } = ctx;
    const targetPnu = ctx.scannedPnus[0];

    // 단일 필지의 활성 property_unit 정확히 1건(membership 기준).
    const membership = membershipArray(ctx.dbScope.propertyMembership);
    const candidates = [...new Set(membership.filter((m) => str(m.pnu) === targetPnu).map((m) => str(m.propertyUnitId)))];
    if (candidates.length !== 1) {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
            issues: [{ code: candidates.length === 0 ? 'PROPERTY_UNIT_NOT_FOUND' : 'PROPERTY_UNIT_AMBIGUOUS' }],
            counts: gateCounts(ctx.baseScans),
        });
        return;
    }
    const propertyUnitId = candidates[0];

    // 필수 branch scan: ladfrl.
    const ladfrl = await deps.scans.scanLadfrl(targetPnu, signal);
    if (aborted(signal)) return;
    const ladfrlState = requiredScanState(ladfrl);
    if (ladfrlState !== 'OK') {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'FAILED',
            scopeState: 'FAILED',
            outcome: 'FAILED',
            issues: [{ code: ladfrlState === 'INCOMPLETE' ? 'PAGINATION_INCOMPLETE' : 'PROVIDER_PROTOCOL_ERROR', targetPnu }],
            counts: gateCounts(ctx.baseScans),
        });
        return;
    }
    if (ladfrl.state === 'COMPLETE_ZERO') {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'COMPLETED',
            scopeState: ctx.gateState,
            outcome: 'NO_DATA',
            issues: [],
            counts: {
                ...gateCounts(ctx.baseScans),
                landRegistryRows: 0,
                matchedPropertyUnits: 0,
            },
        });
        return;
    }
    const ladfrlScope = resolveScopeLadfrlAreas(
        [{ pnu: targetPnu, rows: rows(ladfrl) }],
        [targetPnu]
    );
    if (!ladfrlScope.ok) {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'FAILED',
            scopeState: 'FAILED',
            outcome: 'FAILED',
            issues: [{ code: 'PROVIDER_PROTOCOL_ERROR', targetPnu }],
            counts: gateCounts(ctx.baseScans),
        });
        return;
    }
    const ladfrlArea = ladfrlScope.totalArea;

    const currentLandTuples = await deps.db.readCurrentLandTuples(unionId, [propertyUnitId]);
    const proposedLandAreas: LandAreaSyncProposedArea[] = [{ propertyUnitId, landArea: ladfrlArea ?? '0' }];
    const items: LandAreaSyncApplyLadfrlItem[] = [{ propertyUnitId, targetPnu, ladfrlArea }];

    const baseSnapshot = buildScopeSnapshot({
        strategy: 'LADFRL',
        frozenAt: deps.now().toISOString(),
        scannedPnus: ctx.scannedPnus,
        resolverRootPks: ctx.resolverRootPks,
        bylot: ctx.bylot,
        dbScopeHash: ctx.dbScopeHash,
        externalScopeDigest: ctx.externalScopeDigest,
        propertyMembership: ctx.dbScope.propertyMembership,
        candidatePropertyUnitIds: [propertyUnitId],
        currentLandTuples,
        proposedLandAreas,
        ladfrlAreaEvidence: {
            parcels: ladfrlScope.areas,
            totalArea: ladfrlScope.totalArea,
        },
        replicationEvidence: null,
        componentMatchDigest: [
            {
                targetPnu,
                ladfrlArea,
                parcelSingletonBasis: ctx.parcelSingletonBasis,
            },
        ],
        projectionItems: items,
    });
    const snapshot: LandAreaSyncScopeSnapshot = {
        ...baseSnapshot,
        ...(ctx.developmentFullRefresh &&
        ctx.developmentFullRefreshScopeResolution
            ? {
                  developmentFullRefreshScopeResolution: {
                      source:
                          ctx.developmentFullRefreshScopeResolution
                              .source,
                      canonicalBasePnu:
                          ctx.developmentFullRefreshScopeResolution
                              .canonicalBasePnu,
                      memberPnus: [
                          ...ctx.developmentFullRefreshScopeResolution
                              .memberPnus,
                      ],
                      managementPk:
                          ctx.developmentFullRefreshScopeResolution
                              .managementPk,
                      pairCount:
                          ctx.developmentFullRefreshScopeResolution
                              .pairCount,
                      officialComponentDigest:
                          ctx.developmentFullRefreshScopeResolution
                              .officialComponentDigest,
                      manifestDigest:
                          ctx.developmentFullRefresh
                              .manifestDigest,
                      scopeDigest:
                          ctx.developmentFullRefresh.scopeDigest,
                  },
              }
            : {}),
    };

    const counts = { ...gateCounts(ctx.baseScans), landRegistryRows: rows(ladfrl).length, matchedPropertyUnits: 1 };

    const manualOverwriteRequired =
        ctx.developmentFullRefresh !== null &&
        currentLandTuples.some(
            (tuple) =>
                tuple.propertyUnitId === propertyUnitId &&
                tuple.source === 'MANUAL'
        );
    if (
        ctx.developmentFullRefresh &&
        ctx.isApplyJob &&
        manualOverwriteRequired &&
        !ctx.overwriteManualConfirmed
    ) {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
            issues: [
                {
                    code: 'MANUAL_OVERWRITE_CONFIRMATION_REQUIRED',
                    propertyUnitId,
                },
            ],
            counts,
        });
        return;
    }

    if (ctx.isApplyJob) {
        // 확인된 apply job — snapshot 은 이미 고정. 재실행 fresh digest 로 apply RPC 호출.
        await callApplyAndRecord(ctx, 'LADFRL', snapshot, items, counts);
        return;
    }

    // discovery: LADFRL 은 항상 SYSTEM_ADMIN 확인 필요(§13.3). snapshot 고정 후 confirmation 대기.
    await freezeAndOfferConfirmation(
        ctx,
        'LADFRL',
        manualOverwriteRequired
            ? 'MANUAL_OVERWRITE_CONFIRMATION_REQUIRED'
            : 'SINGLE_SCOPE_CONFIRMATION_REQUIRED',
        snapshot,
        counts
    );
}

// ── LDAREG 분기 ───────────────────────────────────────────────────

async function runLdaregBranch(ctx: BranchContext): Promise<void> {
    const { deps, jobId, unionId, signal } = ctx;
    const scannedPnus = [...new Set(ctx.scannedPnus)].sort();
    const rootIdentity = selectSingleLdaregRootIdentity(ctx.baseScans);
    if (rootIdentity === null) {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
            issues: [{ code: 'LDAREG_IDENTITY_CONFLICT' }],
            counts: gateCounts(ctx.baseScans),
        });
        return;
    }
    const acceptedRootIdentities = [rootIdentity];

    // 대상 PNU별 필수 scan: ldareg + ladfrl + expos + LDAREG 전용 basis.
    // gate 단계의 bylot basis scan과 공유/변형하지 않고 same-run root closure 근거로만 쓴다.
    const perPnu: LdaregPnuScan[] = [];
    const ladfrlScopeScans: Array<{ pnu: string; rows: LadfrlRow[] }> = [];
    let ldaregRegistryRows = 0;
    let ldaregBasisRows = 0;
    const branchGateCounts = (): LandAreaSyncCounts => {
        const counts = gateCounts(ctx.baseScans);
        counts.basisRows += ldaregBasisRows;
        return counts;
    };
    for (const pnu of scannedPnus) {
        const ldareg = await deps.scans.scanLdareg(pnu, signal);
        if (aborted(signal)) return;
        const ladfrl = await deps.scans.scanLadfrl(pnu, signal);
        if (aborted(signal)) return;
        const expos = await deps.scans.scanExpos(pnu, signal);
        if (aborted(signal)) return;
        const basis = await deps.scans.scanBasis(pnu, signal);
        if (aborted(signal)) return;
        ldaregBasisRows += rows(basis).length;

        for (const [scan, incompleteIssue, failedIssue] of [
            [ldareg, 'PAGINATION_INCOMPLETE', 'LDAREG_PERMISSION_REQUIRED'],
            [ladfrl, 'PAGINATION_INCOMPLETE', 'PROVIDER_PROTOCOL_ERROR'],
            [expos, 'PAGINATION_INCOMPLETE', 'PROVIDER_PROTOCOL_ERROR'],
            [basis, 'PAGINATION_INCOMPLETE', 'PROVIDER_PROTOCOL_ERROR'],
        ] as const) {
            const st = requiredScanState(scan);
            if (st !== 'OK') {
                await finalizeDiscoveryTerminal(deps, jobId, unionId, {
                    status: 'FAILED',
                    scopeState: 'FAILED',
                    outcome: 'FAILED',
                    issues: [{ code: st === 'INCOMPLETE' ? incompleteIssue : failedIssue, targetPnu: pnu }],
                    counts: branchGateCounts(),
                });
                return;
            }
        }
        if (
            rows(expos).some(
                (row) =>
                    normalizeRegistryManagementPk(row.mgmBldrgstPk) === null ||
                    !isOptionalRegistryManagementPkValid(row.mgmUpBldrgstPk)
            ) ||
            !buildingHubRowsMatchPnu(
                rows(expos) as Array<Record<string, unknown>>,
                pnu
            ) ||
            rows(basis).some(
                (row) =>
                    normalizeRegistryManagementPk(row.mgmBldrgstPk) === null ||
                    !isOptionalRegistryManagementPkValid(
                        row.mgmUpBldrgstPk
                    )
            ) ||
            !buildingHubRowsMatchPnu(
                rows(basis) as Array<Record<string, unknown>>,
                pnu
            )
        ) {
            await finalizeDiscoveryTerminal(deps, jobId, unionId, {
                status: 'FAILED',
                scopeState: 'FAILED',
                outcome: 'FAILED',
                issues: [{ code: 'PROVIDER_PROTOCOL_ERROR', targetPnu: pnu }],
                counts: branchGateCounts(),
            });
            return;
        }
        ldaregRegistryRows += rows(ldareg).length;
        ladfrlScopeScans.push({ pnu, rows: rows(ladfrl) });
        perPnu.push({
            pnu,
            ldaregRows: rows(ldareg),
            exposRows: rows(expos),
            basisRows: rows(basis),
        });
    }

    // 모든 resolved scope PNU가 exactly-one distinct positive finite LADFRL 면적을 가져야
    // LDAREG 분모 기준 합계를 만든다. 누락·0·상충·PNU 혼입은 apply 0으로 닫는다.
    const scopeLadfrl = resolveScopeLadfrlAreas(ladfrlScopeScans, scannedPnus);
    if (!scopeLadfrl.ok) {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'FAILED',
            scopeState: 'FAILED',
            outcome: 'FAILED',
            issues: [
                {
                    code: 'PROVIDER_PROTOCOL_ERROR',
                    ...(scopeLadfrl.targetPnu ? { targetPnu: scopeLadfrl.targetPnu } : {}),
                },
            ],
            counts: branchGateCounts(),
        });
        return;
    }

    const buildingUnits = await deps.db.readBuildingUnits(unionId, scannedPnus);
    const propertyUnits =
        ctx.preloadedPropertyUnits ??
        (await deps.db.readPropertyUnits(unionId, scannedPnus));
    if (aborted(signal)) return;
    const canonicalBasePnus =
        ctx.dbScope.dbState === 'LINKED'
            ? [...new Set(ctx.dbScope.linkedBasePnus)].sort()
            : [...new Set(ctx.baseScans.map((scan) => scan.pnu))].sort();
    const expectedCanonicalSourcePnu = canonicalBasePnus[0];
    const canonicalSourcePnu = selectCanonicalExposSourcePnu(
        canonicalBasePnus,
        perPnu,
        acceptedRootIdentities
    );
    if (
        !expectedCanonicalSourcePnu ||
        canonicalSourcePnu === null ||
        canonicalSourcePnu !== expectedCanonicalSourcePnu
    ) {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
            issues: [{ code: 'LDAREG_IDENTITY_CONFLICT' }],
            counts: branchGateCounts(),
        });
        return;
    }

    const assembled = assembleLdaregApply({
        unionId,
        scannedPnus,
        rootIdentity,
        perPnu,
        scopeLadfrlAreas: scopeLadfrl.areas,
        scopeLadfrlTotal: scopeLadfrl.totalArea,
        canonicalSourcePnu,
        buildingUnits,
        propertyUnits,
        propertyReplicaMode:
            ctx.developmentFullRefreshLdaregPropertyMembershipMode ===
            'PER_ACTIVE_PNU_REPLICA'
                ? 'PER_ACTIVE_PNU'
                : undefined,
    });

    const counts: LandAreaSyncCounts = {
        ...branchGateCounts(),
        landRegistryRows: ldaregRegistryRows,
        exposureRows: assembled.counts.exposureRows,
        parsedRows: assembled.counts.parsedRows,
        matchedPropertyUnits: assembled.matchedPropertyUnitIds.length,
    };
    if (assembled.blocking || assembled.replicationEvidence === null) {
        // 분모/ratio 또는 raw multiset·최종 property match replica 불일치는 일부 component만
        // 골라 적용하지 않는다. job 전체를 REVIEW로 닫고 apply RPC는 0회다.
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
            issues: assembled.issues,
            counts,
        });
        return;
    }

    const items: LandAreaSyncApplyLdaregItem[] = assembled.items;
    const candidateIds = assembled.matchedPropertyUnitIds;
    const currentLandTuples = await deps.db.readCurrentLandTuples(unionId, candidateIds);
    const proposedLandAreas: LandAreaSyncProposedArea[] = items
        .filter((item) => item.components.some((component) => component.sourceState === 'CURRENT'))
        .map((item) => ({
            propertyUnitId: item.propertyUnitId,
            landArea: sumCurrentNumerators(item),
        }));

    const baseSnapshot = buildScopeSnapshot({
        strategy: 'LDAREG',
        frozenAt: deps.now().toISOString(),
        scannedPnus,
        resolverRootPks: ctx.resolverRootPks,
        bylot: ctx.bylot,
        dbScopeHash: ctx.dbScopeHash,
        externalScopeDigest: ctx.externalScopeDigest,
        propertyMembership: ctx.dbScope.propertyMembership,
        candidatePropertyUnitIds: candidateIds,
        currentLandTuples,
        proposedLandAreas,
        ladfrlAreaEvidence: {
            parcels: scopeLadfrl.areas,
            totalArea: scopeLadfrl.totalArea,
        },
        replicationEvidence: assembled.replicationEvidence,
        componentMatchDigest: assembled.componentMatchDigest,
        projectionItems: items,
    });
    const snapshot: LandAreaSyncScopeSnapshot = {
        ...baseSnapshot,
        ...(ctx.readOnlyScopeResolution
            ? {
                  readOnlyScopeResolution: {
                      source:
                          ctx.readOnlyScopeResolution.source,
                      canonicalBasePnu:
                          ctx.readOnlyScopeResolution
                              .canonicalBasePnu,
                      memberPnus: [
                          ...ctx.readOnlyScopeResolution.memberPnus,
                      ],
                      officialComponentDigest:
                          ctx.readOnlyScopeResolution
                              .officialComponentDigest,
                  },
              }
            : {}),
        ...(ctx.developmentFullRefresh &&
        ctx.developmentFullRefreshScopeResolution
            ? {
                  developmentFullRefreshScopeResolution: {
                      source:
                          ctx.developmentFullRefreshScopeResolution
                              .source,
                      canonicalBasePnu:
                          ctx.developmentFullRefreshScopeResolution
                              .canonicalBasePnu,
                      memberPnus: [
                          ...ctx.developmentFullRefreshScopeResolution
                              .memberPnus,
                      ],
                      managementPk:
                          ctx.developmentFullRefreshScopeResolution
                              .managementPk,
                      pairCount:
                          ctx.developmentFullRefreshScopeResolution
                              .pairCount,
                      officialComponentDigest:
                          ctx.developmentFullRefreshScopeResolution
                              .officialComponentDigest,
                      manifestDigest:
                          ctx.developmentFullRefresh
                              .manifestDigest,
                      scopeDigest:
                          ctx.developmentFullRefresh.scopeDigest,
                  },
              }
            : {}),
    };

    // DEV 전체 갱신 prepare는 항상 snapshot만 고정하고 owner confirmation을 기다린다.
    // MANUAL은 계산/선택에 사용하지 않고 overwrite 동시성 승인 여부만 결정한다.
    const manualOverwriteRequired =
        ctx.developmentFullRefresh !== null &&
        currentLandTuples.some(
            (tuple) =>
                tuple.source === 'MANUAL' &&
                candidateIds.includes(tuple.propertyUnitId)
        );
    if (
        ctx.developmentFullRefresh &&
        ctx.isApplyJob &&
        manualOverwriteRequired &&
        !ctx.overwriteManualConfirmed
    ) {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
            issues: [
                {
                    code: 'MANUAL_OVERWRITE_CONFIRMATION_REQUIRED',
                },
                ...assembled.issues,
            ],
            counts,
        });
        return;
    }
    if (ctx.developmentFullRefresh && !ctx.isApplyJob) {
        await freezeAndOfferConfirmation(
            ctx,
            'LDAREG',
            manualOverwriteRequired
                ? 'MANUAL_OVERWRITE_CONFIRMATION_REQUIRED'
                : 'SINGLE_SCOPE_CONFIRMATION_REQUIRED',
            snapshot,
            counts,
            assembled.issues
        );
        return;
    }

    if (ctx.gateState === 'SINGLE_SCOPE_CONFIRMATION_REQUIRED') {
        // 확인된 apply job 을 confirmation 재제안보다 먼저 처리한다(LADFRL 패턴 미러).
        // 재실행 시 DB evidence 는 불변이라 gate 가 다시 SINGLE 을 반환하는데, 여기서 순서가 뒤바뀌면
        // 이미 snapshot 이 고정된 apply job 에 재freeze 를 시도하다가 migration [6] snapshot guard 에
        // 거부돼 job 이 FAILED 로 죽는다. apply 경로는 재freeze 없이 §13.4 barrier 를 거쳐 RPC 로 간다.
        if (ctx.isApplyJob) {
            await callApplyAndRecord(ctx, 'LDAREG', snapshot, items, counts, assembled.issues);
            return;
        }
        // no-cache single LDAREG discovery — snapshot 고정 후 확인 대기.
        await freezeAndOfferConfirmation(ctx, 'LDAREG', 'SINGLE_SCOPE_CONFIRMATION_REQUIRED', snapshot, counts, assembled.issues);
        return;
    }

    // LINKED_SCOPE_RESOLVED — apply job 이든 discovery LINKED 든 적용 시도.
    if (ctx.isApplyJob) {
        await callApplyAndRecord(ctx, 'LDAREG', snapshot, items, counts, assembled.issues);
        return;
    }

    // 읽기 전용 capture는 LINKED scope도 snapshot/terminal까지만 남기고 apply를 시도하지 않는다.
    if (deps.executionMode === 'READ_ONLY_CAPTURE') {
        await freezeAndOfferConfirmation(
            ctx,
            'LDAREG',
            'LINKED_SCOPE_RESOLVED',
            snapshot,
            counts,
            assembled.issues
        );
        return;
    }

    // discovery LINKED: snapshot 고정 후 apply RPC 1회.
    const frozen = await deps.db.freezeScopeSnapshot(jobId, unionId, {
        scopeState: 'LINKED_SCOPE_RESOLVED',
        scopeEvidence: ctx.scopeEvidence,
        scopeSnapshot: snapshot,
        branch: 'LDAREG',
    });
    if (!frozen) {
        await deps.db.markScopedFailed(jobId, unionId, 'snapshot CAS 고정에 실패했습니다.');
        return;
    }
    await callApplyAndRecord(ctx, 'LDAREG', snapshot, items, counts, assembled.issues);
}

export function sumCurrentNumerators(
    item: LandAreaSyncApplyLdaregItem
): string {
    const numeratorByIdentity = new Map<string, string>();
    for (const c of item.components) {
        if (c.sourceState !== 'CURRENT') continue;
        if (!numeratorByIdentity.has(c.sourceIdentity)) {
            numeratorByIdentity.set(c.sourceIdentity, c.ratioNumerator);
        }
    }
    const values = [...numeratorByIdentity.values()].map((value) =>
        canonicalUnsignedDecimal(value)
    );
    if (values.length === 0) return '0';
    const scale = Math.max(...values.map((value) => value.split('.')[1]?.length ?? 0));
    let total = 0n;
    for (const value of values) {
        const [whole, fraction = ''] = value.split('.');
        total += BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
    }
    if (scale === 0) return total.toString();
    const digits = total.toString().padStart(scale + 1, '0');
    const whole = digits.slice(0, -scale);
    const fraction = digits.slice(-scale).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
}

function canonicalUnsignedDecimal(value: string): string {
    if (!/^\d+(?:\.\d+)?$/.test(value)) {
        throw new Error('검증되지 않은 LDAREG 분자입니다.');
    }
    const [whole, fraction = ''] = value.split('.');
    const canonicalWhole = whole.replace(/^0+(?=\d)/, '');
    const canonicalFraction = fraction.replace(/0+$/, '');
    return canonicalFraction ? `${canonicalWhole}.${canonicalFraction}` : canonicalWhole;
}

// ── 공통 terminal/apply ────────────────────────────────────────────

async function freezeAndOfferConfirmation(
    ctx: BranchContext,
    branch: LandAreaSyncStrategy,
    scopeState: LandAreaSyncScopeState,
    snapshot: LandAreaSyncScopeSnapshot,
    counts: LandAreaSyncCounts,
    extraIssues: LandAreaSyncIssue[] = []
): Promise<void> {
    const { deps, jobId, unionId } = ctx;
    const frozen = await deps.db.freezeScopeSnapshot(jobId, unionId, {
        scopeState,
        scopeEvidence: ctx.scopeEvidence,
        scopeSnapshot: snapshot,
        branch,
    });
    if (!frozen) {
        await deps.db.markScopedFailed(jobId, unionId, 'snapshot CAS 고정에 실패했습니다.');
        return;
    }
    await finalizeDiscoveryTerminal(deps, jobId, unionId, {
        status: 'COMPLETED',
        scopeState,
        outcome: 'REVIEW_REQUIRED',
        issues: extraIssues,
        counts,
    });
}

/**
 * write barrier(§13.1) 충족 시 apply RPC 를 정확히 1회 호출한다. terminal/fatal 후 늦은 callback 은
 * AbortSignal 로 0회. RPC EXCEPTION(rollback) 은 job 을 FAILED 로 기록한다. 성공 시 RPC 가
 * terminal 을 이미 썼으므로 scopeState(+병합 issues)만 반영한다.
 *
 * §13.4 barrier: 확인된 apply job 은 재실행 결과(membership+scopeHash)가 discovery 확인 시점과
 * 정확히 일치할 때만 RPC 를 호출한다. 어긋나면 기존값을 유지하고 REVIEW_REQUIRED 로 종결(apply 0).
 */
async function callApplyAndRecord(
    ctx: BranchContext,
    strategy: LandAreaSyncStrategy,
    snapshot: LandAreaSyncScopeSnapshot,
    items: LandAreaSyncApplyLadfrlItem[] | LandAreaSyncApplyLdaregItem[],
    counts: LandAreaSyncCounts,
    extraIssues: LandAreaSyncIssue[] = []
): Promise<void> {
    const { deps, jobId, unionId, signal } = ctx;
    if (aborted(signal)) return; // terminal/fatal 이후 apply 금지

    // READ_ONLY_CAPTURE는 discovery/apply 모양과 무관하게 DB 호출 자체를 금지한다.
    // capture 전용 deps가 잘못 구성돼 confirmation job이 유입되어도 terminal/FAILED
    // 기록을 포함한 어떤 DB write도 시도하지 않고 호출자에게 즉시 실패를 돌려준다.
    if (deps.executionMode === 'READ_ONLY_CAPTURE') {
        throw Object.assign(
            new Error('읽기 전용 대지권 캡처에서 apply 경로가 차단되었습니다.'),
            { code: 'READ_ONLY_CAPTURE_APPLY_BLOCKED' }
        );
    }

    // §13.4 barrier — 확인된 apply job 은 재실행 scope 가 discovery 확인 시점과 exact 일치해야 apply.
    // DB apply RPC 도 동일 lineage 를 재검증하지만(이중 방어), 여기서 먼저 걸러 재실행 scope 가 바뀐
    // 경우 불필요한 write transaction 을 열지 않고 apply RPC 를 0회로 만든다.
    if (ctx.isApplyJob && ctx.confirmation) {
        const scopeMatches = snapshot.scopeHash === ctx.confirmation.confirmedDiscoveryScopeHash;
        const membershipMatches =
            snapshot.propertyMembershipHash === ctx.confirmation.confirmedPropertyMembershipHash;
        if (!scopeMatches || !membershipMatches) {
            // 확인 대상·재실행 scope 불일치 → 기존값 유지, apply 0, REVIEW_REQUIRED.
            await finalizeDiscoveryTerminal(deps, jobId, unionId, {
                status: 'COMPLETED',
                scopeState: 'REVIEW_REQUIRED',
                outcome: 'REVIEW_REQUIRED',
                issues: [{ code: 'LAND_SCOPE_CONFIRMATION_MISMATCH' }, ...extraIssues],
                counts,
            });
            return;
        }
    }

    // LINKED discovery도 곧바로 apply할 수 있으므로 anchor뿐 아니라 resolved scope 전체를 검사한다.
    // 이 검사는 apply RPC 직전에 위치해 라우트/queue admission 우회와 외부 scope 확장을 막는다.
    try {
        deps.assertCanaryScopeAllowed(unionId, snapshot.scannedPnus);
    } catch {
        await deps.db.markScopedFailed(
            jobId,
            unionId,
            'resolved scope가 대지권면적 동기화 허용 대상을 벗어났습니다.'
        );
        return;
    }

    const scanCompleteness: LandAreaSyncScanCompleteness = 'COMPLETE';
    const res = await deps.db.applyRpc({
        p_union_id: unionId,
        p_sync_job_id: jobId,
        p_strategy: strategy,
        p_scan_started_at: ctx.scanStartedAt,
        p_scan_completeness: scanCompleteness,
        p_db_scope_hash: snapshot.dbScopeHash,
        p_external_scope_digest: snapshot.externalScopeDigest,
        p_scope_hash: snapshot.scopeHash,
        p_scanned_pnus: snapshot.scannedPnus,
        p_items: items,
        // RPC가 extraIssues를 다시 allowlist 정제한 뒤 DB에서 산출한 issues와
        // dedup/cap하여 terminal summary + immutable receipt를 같은 transaction에 쓴다.
        p_result_summary: {
            counts,
            extraIssues: extraIssues.map(sanitizeIssue),
        },
    });

    if (res.error) {
        // RPC EXCEPTION → 전체 rollback. API 가 job 을 FAILED 로 기록한다.
        await deps.db.markScopedFailed(jobId, unionId, `apply RPC 실패: ${res.error.message}`);
        return;
    }

    // 성공 응답 이후에는 어떤 preview/status UPDATE도 하지 않는다. apply RPC가
    // scopeState/outcome/counts/issues metadata/workerFinalization을 한 transaction에서
    // 확정하는 것이 유일한 terminal 경로다.
}

async function finalizeDiscoveryTerminal(
    deps: LandAreaSyncDeps,
    jobId: string,
    unionId: string,
    input: {
        status: 'COMPLETED' | 'FAILED';
        scopeState: LandAreaSyncScopeState;
        outcome: Exclude<
            LandAreaSyncOutcome,
            'APPLIED' | 'PARTIAL'
        >;
        issues: LandAreaSyncIssue[];
        counts: LandAreaSyncCounts;
        errorLog?: string;
    }
): Promise<void> {
    const capped = capIssues(input.issues);
    const finalized = await deps.db.writeDiscoveryTerminal(jobId, unionId, {
        status: input.status,
        scopeState: input.scopeState,
        outcome: input.outcome,
        counts: input.counts,
        issues: capped.issues,
        issuesTotal: capped.issuesTotal,
        issuesTruncated: capped.issuesTruncated,
        errorLog: input.errorLog,
    });
    if (!finalized) {
        throw Object.assign(
            new Error('discovery worker finalization 기록에 실패했습니다.'),
            { code: 'WORKER_FINALIZATION_FAILED' }
        );
    }
}

/** gate 단계까지의 scan row count 를 counts 골격에 채운다. */
function gateCounts(baseScans: BasePnuScan[]): LandAreaSyncCounts {
    const counts = emptyCounts();
    for (const b of baseScans) {
        counts.titleRows += rows(b.title).length;
        counts.attachedRows += rows(b.attached).length;
        if (b.basis) counts.basisRows += rows(b.basis).length;
    }
    return counts;
}

export type { LandAreaSyncIssueCode };
