/**
 * LAND_AREA_SYNC 큐 서비스 (DESIGN §8·§14.1).
 *
 * 기존 GIS 큐 패턴을 따른다: p-queue concurrency 2, durable sync_jobs INSERT 성공 후에만 메모리
 * queue admission, admission 실패 시 job 을 FAILED 로 기록한다. 각 job 은 AbortController 를
 * 가지며, 워커가 terminal/fatal 로 끝나면 abort 해 늦은 callback 이 apply 를 호출하지 못하게 한다.
 *
 * discovery job 은 여기서 durable INSERT 한다. confirmation apply job 은 admission RPC 가 이미
 * INSERT 했으므로 이 큐는 memory admission(재실행)만 담당한다.
 */

import PQueue from 'p-queue';
import { env } from '../../config/env';
import type { DatabaseTarget } from '../../types/database.types';
import { assertLandAreaSyncEnabled } from '../../security/land-area-sync-execution-policy';
import {
    assertDevelopmentLandAreaFullRefreshAllowed,
    developmentLandAreaFullRefreshMarkersEqual,
    parseDevelopmentLandAreaFullRefreshMarker,
} from '../../security/development-land-area-full-refresh-policy';
import {
    assertLandAreaSyncCanaryAllowed,
    assertLandAreaSyncScopeAllowed,
} from '../../security/land-area-sync-canary-policy';
import { getSupabaseService } from '../supabase.service';
import { persistSyncJobOrThrow } from '../sync-job-admission';
import { createLogger } from '../../utils/logger';
import {
    buildingHubAuthFromEnv,
    vworldAuthFromEnv,
    LandAreaSyncAdapter,
} from './adapter';
import {
    insertDiscoveryJob,
    getScopedJob,
    readLandAreaSync,
    freezeScopeSnapshot,
    type LandAreaSyncJobRow,
} from './repository';
import {
    readPropertyUnitCandidates,
    readBuildingUnitCandidates,
    readCurrentLandTuples,
} from './readers';
import {
    runLandAreaSyncJob,
    type LandAreaSyncDeps,
} from './service';
import {
    markScopedFailed,
    writeDiscoveryTerminal,
} from './finalizer';
import {
    ensureTimedOutJobHasDurableTerminal,
} from './queue-timeout-terminal';
import type {
    LandAreaSyncDiscoveryRequest,
    LandAreaSyncJobInfo,
} from '../../types/land-area-sync-job.types';

const logger = createLogger('LAND-AREA-SYNC-QUEUE');
export const LAND_AREA_SYNC_ADMISSION_WALL_TIMEOUT_MS =
    10 * 60_000;

interface JobHandle {
    unionId: string;
    databaseTarget: DatabaseTarget;
    workerController: AbortController;
    queuedController: AbortController;
    deadlineTimer: ReturnType<typeof setTimeout>;
}

class LandAreaSyncQueueService {
    private queue: PQueue;
    private jobs: Map<string, JobHandle>;
    private readonly adapter: LandAreaSyncAdapter;

    constructor(adapter?: LandAreaSyncAdapter) {
        // p-queue timeout은 task 시작 뒤 wrapper만 종료하며 underlying worker를
        // 취소하지 않는다. admission 시점 wall timer + AbortSignal로 queue 대기와
        // 실행을 함께 제한하고, underlying Promise 자체가 끝날 때까지 queue slot을
        // 유지한다.
        this.queue = new PQueue({ concurrency: 2 });
        this.jobs = new Map();
        this.adapter =
            adapter ??
            new LandAreaSyncAdapter({
                vworldRequestIntervalMs:
                    env.VWORLD_ATTR_REQUEST_INTERVAL_MS,
            });
    }

    private key(databaseTarget: DatabaseTarget, jobId: string): string {
        return `${databaseTarget}:${jobId}`;
    }

    /**
     * discovery job 을 durable INSERT 한 뒤 메모리 queue 에 admission 한다. INSERT 실패는 throw
     * (route 가 503 매핑). INSERT 후 admission 실패면 durable job 을 FAILED 로 기록하고 throw.
     */
    async addDiscoveryJob(request: LandAreaSyncDiscoveryRequest): Promise<LandAreaSyncJobInfo> {
        assertLandAreaSyncEnabled(env.LAND_AREA_SYNC_ENABLED);
        const developmentFullRefresh =
            parseDevelopmentLandAreaFullRefreshMarker(
                request.developmentFullRefresh
            );
        if (developmentFullRefresh) {
            assertDevelopmentLandAreaFullRefreshAllowed({
                databaseTarget: request.databaseTarget,
                unionId: request.unionId,
                marker: developmentFullRefresh,
            });
        }
        assertLandAreaSyncCanaryAllowed(
            env.LAND_AREA_SYNC_ALLOWED_TARGETS,
            request.databaseTarget,
            request.unionId,
            request.anchorPnu
        );

        // discovery는 caller가 미리 정한 admission UUID를 durable job id로 사용한다.
        // confirmation은 DB v2가 별도 job id를 만들며 admissionKey로 exact 조회한다.
        const jobId = request.admissionKey;
        const database = getSupabaseService(request.databaseTarget);

        let existing: LandAreaSyncJobRow | null = null;
        try {
            await persistSyncJobOrThrow(jobId, request.unionId, () =>
                insertDiscoveryJob(database.getClient(), jobId, {
                    unionId: request.unionId,
                    anchorPnu: request.anchorPnu,
                    actorUserId: request.actorUserId,
                    ...(developmentFullRefresh
                        ? { developmentFullRefresh }
                        : {}),
                })
            );
        } catch (error) {
            // response-loss replay만 복구한다. exact id+union+type+admission+anchor가
            // 이미 durable할 때만 기존 job을 재사용하고 다른 insert 실패는 보존한다.
            existing = await getScopedJob(
                database.getClient(),
                jobId,
                request.unionId
            ).catch(() => null);
            const land = existing ? readLandAreaSync(existing) : null;
            if (
                !existing ||
                land?.admissionKey !== request.admissionKey ||
                land.anchorPnu !== request.anchorPnu ||
                land.sourceDiscoveryJobId !== null ||
                !developmentLandAreaFullRefreshMarkersEqual(
                    land.developmentFullRefresh,
                    developmentFullRefresh
                )
            ) {
                throw error;
            }
        }

        try {
            if (!existing || existing.status === 'PROCESSING') {
                this.admit(jobId, request.unionId, request.databaseTarget);
            }
        } catch (admissionError) {
            await markScopedFailed(
                database,
                jobId,
                request.unionId,
                'queue admission 실패로 작업을 시작하지 못했습니다.'
            );
            throw Object.assign(new Error('queue admission 실패'), {
                code: 'DEFERRED_QUEUE_ADMISSION_FINALIZE_FAILED',
                cause: admissionError,
            });
        }

        logger.info(`LAND_AREA_SYNC discovery job added: ${jobId} (anchor: ${request.anchorPnu})`);
        return {
            jobId,
            unionId: request.unionId,
            anchorPnu: request.anchorPnu,
            status: 'pending',
            createdAt: new Date(),
        };
    }

    /**
     * confirmation admission RPC 가 이미 INSERT 한 apply job 을 재실행 admission 한다.
     */
    admitApplyJob(
        jobId: string,
        unionId: string,
        anchorPnu: string,
        databaseTarget: DatabaseTarget
    ): void {
        assertLandAreaSyncEnabled(env.LAND_AREA_SYNC_ENABLED);
        assertLandAreaSyncCanaryAllowed(
            env.LAND_AREA_SYNC_ALLOWED_TARGETS,
            databaseTarget,
            unionId,
            anchorPnu
        );

        this.admit(jobId, unionId, databaseTarget);
        logger.info(`LAND_AREA_SYNC apply job admitted: ${jobId}`);
    }

    private admit(jobId: string, unionId: string, databaseTarget: DatabaseTarget): boolean {
        const workerController = new AbortController();
        const queuedController = new AbortController();
        let started = false;
        let timedOut = false;
        const key = this.key(databaseTarget, jobId);
        if (this.jobs.has(key)) {
            return false;
        }
        const deadlineTimer = setTimeout(
            () => {
                timedOut = true;
                workerController.abort();
                if (!started) queuedController.abort();
            },
            LAND_AREA_SYNC_ADMISSION_WALL_TIMEOUT_MS
        );
        deadlineTimer.unref?.();
        this.jobs.set(key, {
            unionId,
            databaseTarget,
            workerController,
            queuedController,
            deadlineTimer,
        });

        this.queue
            .add(async () => {
                // queue wrapper signal과 worker signal을 분리한다. 실행 시작 뒤에는
                // queuedController를 abort하지 않아 PQueue Promise가 underlying
                // worker/RPC 종료 전에 reject되는 race를 막는다.
                started = true;
                try {
                    await runLandAreaSyncJob({
                        jobId,
                        unionId,
                        deps: this.buildDeps(databaseTarget),
                        signal: workerController.signal,
                    });
                    if (timedOut) {
                        // abort를 관찰한 worker는 예외 없이 조기 return할 수 있다. underlying
                        // Promise가 완전히 drain된 뒤 durable terminal을 재확인하고,
                        // PROCESSING이 남아 있을 때만 조건부 FAILED finalizer를 호출한다.
                        // apply RPC가 이미 APPLIED를 commit했다면 terminal/receipt 검사가
                        // 이를 보존하며, 동시 terminal race도 DB finalizer의 상태 조건이 막는다.
                        const database =
                            getSupabaseService(databaseTarget);
                        await ensureTimedOutJobHasDurableTerminal({
                            readJob: () =>
                                getScopedJob(
                                    database.getClient(),
                                    jobId,
                                    unionId
                                ),
                            markFailed: () =>
                                markScopedFailed(
                                    database,
                                    jobId,
                                    unionId,
                                    'queue admission wall timeout으로 작업을 중단했습니다.'
                                ),
                        });
                    }
                } finally {
                    // terminal 도달 후 늦은 callback 이 apply 하지 못하도록 abort 한다.
                    clearTimeout(deadlineTimer);
                    workerController.abort();
                    this.jobs.delete(key);
                }
            }, {
                // queue 대기 중 deadline abort면 task를 제거한다. 실행 중이면 같은
                // signal이 scan과 apply 직전 barrier까지 전달되고 underlying worker
                // 완료를 기다린 뒤에만 이 Promise가 settle한다.
                signal: queuedController.signal,
            })
            .catch(async (err: unknown) => {
                clearTimeout(deadlineTimer);
                workerController.abort();
                queuedController.abort();
                this.jobs.delete(key);
                const message = err instanceof Error ? err.message : 'LAND_AREA_SYNC 워커 오류';
                logger.error(`LAND_AREA_SYNC job ${jobId} fatal error: ${message}`);
                await markScopedFailed(getSupabaseService(databaseTarget), jobId, unionId, message).catch(
                    () => undefined
                );
            });
        return true;
    }

    /** databaseTarget 별 orchestration deps 를 조립한다(adapter + supabase + repository + readers). */
    private buildDeps(databaseTarget: DatabaseTarget): LandAreaSyncDeps {
        const database = getSupabaseService(databaseTarget);
        const client = database.getClient();
        const hubAuth = buildingHubAuthFromEnv();
        const vworldAuth = vworldAuthFromEnv();

        return {
            databaseTarget,
            now: () => new Date(),
            assertCanaryScopeAllowed: (unionId, scannedPnus) =>
                assertLandAreaSyncScopeAllowed(
                    env.LAND_AREA_SYNC_ALLOWED_TARGETS,
                    databaseTarget,
                    unionId,
                    scannedPnus
                ),
            scans: {
                scanTitle: (pnu, signal) => this.adapter.scanTitle(pnu, hubAuth, { signal }),
                scanAttached: (pnu, signal) => this.adapter.scanAttached(pnu, hubAuth, { signal }),
                scanBasis: (pnu, signal) => this.adapter.scanBasis(pnu, hubAuth, { signal }),
                scanExpos: (pnu, signal) => this.adapter.scanExpos(pnu, hubAuth, { signal }),
                scanLadfrl: (pnu, signal) => this.adapter.scanLadfrl(pnu, vworldAuth, { signal }),
                scanLdareg: (pnu, signal) => this.adapter.scanLdareg(pnu, vworldAuth, { signal }),
            },
            db: {
                resolveScope: (params) => database.resolveLandAreaSyncScope(params),
                applyRpc: (params) => database.applyPropertyLandAreaSync(params),
                getScopedJob: (jobId, unionId) => getScopedJob(client, jobId, unionId),
                freezeScopeSnapshot: (jobId, unionId, patch) => freezeScopeSnapshot(client, jobId, unionId, patch),
                writeDiscoveryTerminal: (jobId, unionId, input) =>
                    writeDiscoveryTerminal(
                        database,
                        jobId,
                        unionId,
                        input
                    ),
                markScopedFailed: (jobId, unionId, message) =>
                    markScopedFailed(
                        database,
                        jobId,
                        unionId,
                        message
                    ),
                readBuildingUnits: (unionId, scopePnus) => readBuildingUnitCandidates(client, unionId, scopePnus),
                readPropertyUnits: (unionId, scopePnus) => readPropertyUnitCandidates(client, unionId, scopePnus),
                readCurrentLandTuples: (unionId, ids) => readCurrentLandTuples(client, unionId, ids),
            },
        };
    }
}

export const landAreaSyncQueueService = new LandAreaSyncQueueService();
export { LandAreaSyncQueueService };
export default landAreaSyncQueueService;
