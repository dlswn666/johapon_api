import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import {
    LocalhostDevelopmentLandAreaSyncClient,
    controlledFailureCode,
    parseDevelopmentDbApprovalManifest,
    parseDevelopmentEvidenceManifest,
    parseDevelopmentTargetManifest,
    runDevelopmentLandAreaSync,
    developmentTargetAllowedScopePnus,
    developmentTargetExpectedActivePnus,
    validateDevelopmentRunnerEnvironment,
    type DevelopmentRelationGisInvariantRows,
    type LandAreaSyncRunnerDatabaseTarget,
} from '../operations/development-land-area-sync-runner';
import {
    formatLocalhostProbeSummary,
    probeLocalhostLandAreaSyncApi,
} from '../operations/land-area-sync-localhost-probe';
import {
    readChunked,
    readExactPaged,
    type PagedReadRow,
} from './development-land-area-paged-read';

const PRIVATE_DIRECTORY = '.development-land-area-sync';
const INPUT_SIZE_LIMIT = 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// target 별로 접속 가능한 Supabase 프로젝트를 exact 로 못박는다. 선언한 target 과
// 실제 접속 URL 이 일치해야 하므로 운영 자격증명으로 dev 타깃을 돌리거나 그 반대가
// 구조적으로 불가능하다. (채택 CLI 의 SUPABASE_URL_BY_TARGET 과 같은 계약)
const DEVELOPMENT_PROJECT_REF = 'yxypndgipnxrdfyctmvh';
const PRODUCTION_PROJECT_REF = 'bpdjashtxqrcgxfequgf';
const SUPABASE_URL_BY_TARGET: Record<
    LandAreaSyncRunnerDatabaseTarget,
    string
> = {
    development: `https://${DEVELOPMENT_PROJECT_REF}.supabase.co`,
    production: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
};

interface CliArguments {
    targetPath: string;
    dbApprovalPath: string;
    evidencePath: string;
    actorAuthUserId: string;
    outputPath: string;
}

function parseArguments(argv: string[]): CliArguments {
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (
            !key ||
            !value ||
            ![
                '--target',
                '--db-approval',
                '--evidence',
                '--actor-auth-user-id',
                '--out',
            ].includes(key) ||
            values.has(key)
        ) {
            throw new Error('CLI_ARGUMENT_INVALID');
        }
        values.set(key, value);
    }
    const targetPath = values.get('--target');
    const dbApprovalPath = values.get('--db-approval');
    const evidencePath = values.get('--evidence');
    const actorAuthUserId = values.get('--actor-auth-user-id');
    const outputPath = values.get('--out');
    if (
        !targetPath ||
        !dbApprovalPath ||
        !evidencePath ||
        !actorAuthUserId ||
        !outputPath ||
        !UUID_RE.test(actorAuthUserId)
    ) {
        throw new Error('CLI_ARGUMENT_INVALID');
    }
    return {
        targetPath,
        dbApprovalPath,
        evidencePath,
        actorAuthUserId: actorAuthUserId.toLowerCase(),
        outputPath,
    };
}

function resolvePrivatePath(candidate: string): string {
    const root = path.resolve(process.cwd(), PRIVATE_DIRECTORY);
    const resolved = path.resolve(process.cwd(), candidate);
    if (
        resolved === root ||
        !resolved.startsWith(`${root}${path.sep}`)
    ) {
        throw new Error('CLI_PATH_OUTSIDE_PRIVATE_DIRECTORY');
    }
    return resolved;
}

async function readJsonInput(candidate: string): Promise<unknown> {
    const target = resolvePrivatePath(candidate);
    const root = path.dirname(target);
    const [rootStat, targetStat] = await Promise.all([
        lstat(root),
        lstat(target),
    ]);
    if (
        !rootStat.isDirectory() ||
        rootStat.isSymbolicLink() ||
        !targetStat.isFile() ||
        targetStat.isSymbolicLink() ||
        targetStat.size < 2 ||
        targetStat.size > INPUT_SIZE_LIMIT
    ) {
        throw new Error('CLI_INPUT_FILE_INVALID');
    }
    const [rootReal, targetReal] = await Promise.all([
        realpath(root),
        realpath(target),
    ]);
    if (!targetReal.startsWith(`${rootReal}${path.sep}`)) {
        throw new Error('CLI_INPUT_FILE_INVALID');
    }
    return JSON.parse(await readFile(targetReal, 'utf8')) as unknown;
}

async function writeArtifact(
    candidate: string,
    artifact: unknown
): Promise<void> {
    const target = resolvePrivatePath(candidate);
    const parent = path.dirname(target);
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        throw new Error('CLI_OUTPUT_DIRECTORY_INVALID');
    }
    const body = `${JSON.stringify(artifact, null, 2)}\n`;
    const file = await open(target, 'wx', 0o600);
    try {
        await file.writeFile(body, 'utf8');
    } finally {
        await file.close();
    }
}

/**
 * write 11~15차 admission 응답 유실 진단용 in-process 프로브.
 * guardian의 fresh-process 프로브(PRERUN_PROBE_EXIT_*)와 결과를 대조해
 * 문제 범위를 판별한다. 실패해도 run 진행에는 영향을 주지 않으며,
 * 출력은 고정 토큰·상태코드·소요시간뿐이다(식별자 금지).
 */
async function emitRunnerProbe(
    phase: 'STARTUP' | 'POSTFAIL',
    actorAuthUserId: string,
    probeAuth: {
        secret: string | undefined;
        databaseTarget: LandAreaSyncRunnerDatabaseTarget;
    }
): Promise<void> {
    try {
        const summary = await probeLocalhostLandAreaSyncApi({
            secret: probeAuth.secret,
            actorAuthUserId,
            databaseTarget: probeAuth.databaseTarget,
        });
        process.stdout.write(
            `LAND_AREA_SYNC_RUNNER_PROBE_${phase}_EXIT_${summary.exitCode}\n`
        );
        process.stdout.write(
            `${formatLocalhostProbeSummary(summary)}\n`
        );
    } catch {
        process.stdout.write(
            `LAND_AREA_SYNC_RUNNER_PROBE_${phase}_EXIT_99\n`
        );
    }
}

async function main(): Promise<void> {
    const args = parseArguments(process.argv.slice(2));
    const [targetInput, dbApprovalInput, evidenceInput] = await Promise.all([
        readJsonInput(args.targetPath),
        readJsonInput(args.dbApprovalPath),
        readJsonInput(args.evidencePath),
    ]);
    const target = parseDevelopmentTargetManifest(targetInput);
    const dbApproval =
        parseDevelopmentDbApprovalManifest(dbApprovalInput);
    const evidence = parseDevelopmentEvidenceManifest(evidenceInput);
    const environment = validateDevelopmentRunnerEnvironment(
        process.env,
        target
    );
    // 선언한 target 과 실제 접속 프로젝트가 어긋나면 어떤 읽기도 하기 전에 멈춘다.
    if (
        environment.supabaseUrl.trim().replace(/\/+$/, '') !==
        SUPABASE_URL_BY_TARGET[target.databaseTarget]
    ) {
        throw new Error('RUNNER_DATABASE_TARGET_MISMATCH');
    }
    const probeAuth = {
        secret: environment.apiJwtSecret,
        databaseTarget: target.databaseTarget,
    };
    await emitRunnerProbe('STARTUP', args.actorAuthUserId, probeAuth);

    const client = new LocalhostDevelopmentLandAreaSyncClient(
        environment.apiJwtSecret,
        args.actorAuthUserId,
        () => new Date(),
        fetch,
        target.databaseTarget
    );
    const developmentDatabase = createClient(
        environment.supabaseUrl,
        environment.supabaseServiceRoleKey,
        {
            auth: {
                persistSession: false,
                autoRefreshToken: false,
                detectSessionInUrl: false,
            },
        }
    );
    // 페이징·chunk 읽기는 공용 모듈(development-land-area-paged-read)에 있다.
    type JsonRow = PagedReadRow;
    const dedupeById = (
        code: string,
        rows: JsonRow[]
    ): JsonRow[] => {
        const byId = new Map<string, JsonRow>();
        for (const row of rows) {
            const id = String(row.id ?? '').toLowerCase();
            if (!UUID_RE.test(id)) {
                throw new Error(`${code}_ROW_INVALID`);
            }
            byId.set(id, row);
        }
        return [...byId.values()];
    };
    const artifact = await runDevelopmentLandAreaSync({
        target,
        dbApproval,
        evidence,
        client,
        preflightReader: {
            async readActivePropertyUnits(unionId) {
                // 활성 물건지가 PostgREST max-rows(1,000)를 넘는 조합도 전건을
                // 읽는다. 총행수는 exact count 로 검증하고 manifest 기대치 비교는
                // 러너(readAndValidateDevelopmentSnapshot)가 맡는다.
                const data = await readExactPaged(
                    'DEVELOPMENT_PREFLIGHT',
                    (from, to) =>
                        developmentDatabase
                            .from('property_units')
                            .select(
                                'id, pnu, land_area, land_area_source, land_area_synced_at, land_area_sync_job_id',
                                { count: 'exact' }
                            )
                            .eq('union_id', unionId)
                            .eq('is_deleted', false)
                            .order('id', { ascending: true })
                            .range(from, to)
                );
                return data.map((row: Record<string, unknown>) => {
                    const source =
                        row.land_area_source == null
                            ? 'LEGACY_UNKNOWN'
                            : String(row.land_area_source);
                    if (
                        source !== 'LEGACY_UNKNOWN' &&
                        source !== 'MANUAL' &&
                        source !== 'LADFRL' &&
                        source !== 'LDAREG'
                    ) {
                        throw new Error('DEVELOPMENT_PREFLIGHT_SOURCE_INVALID');
                    }
                    return {
                        id: String(row.id ?? ''),
                        pnu: String(row.pnu ?? ''),
                        landArea:
                            row.land_area == null
                                ? null
                                : String(row.land_area),
                        landAreaSource: source,
                        landAreaSyncedAt:
                            row.land_area_synced_at == null
                                ? null
                                : String(row.land_area_synced_at),
                        landAreaSyncJobId:
                            row.land_area_sync_job_id == null
                                ? null
                                : String(row.land_area_sync_job_id),
                    };
                });
            },
            async readPropertyUnitsBySyncJobIds(syncJobIds) {
                if (
                    syncJobIds.length < 1 ||
                    syncJobIds.length > target.targetCount
                ) {
                    throw new Error(
                        'DEVELOPMENT_WRITE_ATTRIBUTION_SCOPE_INVALID'
                    );
                }
                // `.in()` 은 100건씩 나눠 읽고 단일 조회와 같은 결과(유일 job id,
                // id 오름차순)로 병합한다. 중복 제거는 하지 않는다 — job id 가
                // 유일하면 행도 유일하고, 아니면 러너의 attribution 검증이 잡는다.
                const data = (
                    await readChunked(
                        'DEVELOPMENT_WRITE_ATTRIBUTION',
                        [...new Set(syncJobIds)],
                        (syncJobIdChunk, from, to) =>
                            developmentDatabase
                                .from('property_units')
                                .select(
                                    'id, union_id, land_area_sync_job_id',
                                    { count: 'exact' }
                                )
                                .in('land_area_sync_job_id', syncJobIdChunk)
                                .order('id', { ascending: true })
                                .range(from, to)
                    )
                ).sort((left, right) =>
                    String(left.id ?? '').localeCompare(
                        String(right.id ?? '')
                    )
                );
                return data.map((row: Record<string, unknown>) => ({
                    id: String(row.id ?? ''),
                    unionId: String(row.union_id ?? ''),
                    landAreaSyncJobId: String(
                        row.land_area_sync_job_id ?? ''
                    ),
                }));
            },
            async readRelationGisInvariantRows(input) {
                const scopePnus = [...new Set(input.scopePnus)].sort();
                const expectedScopePnus = [
                    ...developmentTargetAllowedScopePnus(target),
                ].sort();
                const scopeSet = new Set(scopePnus);
                if (
                    input.unionId !== target.unionId ||
                    scopePnus.length !==
                        expectedScopePnus.length ||
                    scopePnus.some(
                        (pnu, index) =>
                            pnu !== expectedScopePnus[index]
                    )
                ) {
                    throw new Error(
                        'DEVELOPMENT_RELATION_GIS_SCOPE_INVALID'
                    );
                }
                const landLots = await readChunked(
                    'DEVELOPMENT_LAND_LOTS_INVARIANT',
                    scopePnus,
                    (chunk, from, to) =>
                        developmentDatabase
                            .from('land_lots')
                            .select('*', { count: 'exact' })
                            .eq('union_id', input.unionId)
                            .in('pnu', chunk)
                            .order('pnu', { ascending: true })
                            .range(from, to)
                );
                // 조회 scope에는 land_lots가 없는 것이 정상인 공식 query-only
                // 부속지번(예: 791-2244의 703-130)이 포함될 수 있다. land_lots
                // 전건 요구는 union 활성 PNU(∩ scope)에만 적용하고, query-only
                // PNU는 행이 있으면 검증에 포함하되 부재를 실패로 보지 않는다.
                const expectedActivePnusForLots =
                    developmentTargetExpectedActivePnus(target);
                const requiredLandLotPnus =
                    expectedActivePnusForLots === null
                        ? scopePnus
                        : (() => {
                              const activeSet = new Set(
                                  expectedActivePnusForLots
                              );
                              return scopePnus.filter((pnu) =>
                                  activeSet.has(pnu)
                              );
                          })();
                const landLotPnuSet = new Set(
                    landLots.map((row) => row.pnu)
                );
                if (
                    landLots.some(
                        (row) =>
                            row.union_id !== input.unionId ||
                            typeof row.pnu !== 'string' ||
                            !scopeSet.has(row.pnu)
                    ) ||
                    landLotPnuSet.size !== landLots.length ||
                    requiredLandLotPnus.some(
                        (pnu) => !landLotPnuSet.has(pnu)
                    )
                ) {
                    throw new Error(
                        'DEVELOPMENT_LAND_LOTS_INVARIANT_SCOPE_INVALID'
                    );
                }

                const buildingLandLots = dedupeById(
                    'DEVELOPMENT_BUILDING_LAND_LOTS_INVARIANT',
                    await readChunked(
                        'DEVELOPMENT_BUILDING_LAND_LOTS_INVARIANT',
                        scopePnus,
                        (chunk, from, to) =>
                            developmentDatabase
                                .from('building_land_lots')
                                .select('*', { count: 'exact' })
                                .in('pnu', chunk)
                                .order('id', {
                                    ascending: true,
                                })
                                .range(from, to)
                    )
                );
                if (
                    buildingLandLots.some(
                        (row) =>
                            typeof row.pnu !== 'string' ||
                            !scopeSet.has(row.pnu) ||
                            typeof row.building_id !== 'string' ||
                            !UUID_RE.test(row.building_id)
                    )
                ) {
                    throw new Error(
                        'DEVELOPMENT_BUILDING_LAND_LOTS_INVARIANT_SCOPE_INVALID'
                    );
                }
                const buildingIds = [
                    ...new Set(
                        buildingLandLots.map((row) =>
                            String(
                                row.building_id
                            ).toLowerCase()
                        )
                    ),
                ].sort();
                const buildings = dedupeById(
                    'DEVELOPMENT_BUILDINGS_INVARIANT',
                    await readChunked(
                        'DEVELOPMENT_BUILDINGS_INVARIANT',
                        buildingIds,
                        (chunk, from, to) =>
                            developmentDatabase
                                .from('buildings')
                                .select('*', { count: 'exact' })
                                .in('id', chunk)
                                .order('id', {
                                    ascending: true,
                                })
                                .range(from, to)
                    )
                );
                if (
                    buildings.length !== buildingIds.length ||
                    buildings.some(
                        (row) =>
                            typeof row.id !== 'string' ||
                            !buildingIds.includes(
                                row.id.toLowerCase()
                            )
                    )
                ) {
                    throw new Error(
                        'DEVELOPMENT_BUILDINGS_INVARIANT_SCOPE_INVALID'
                    );
                }
                const buildingIdSet = new Set(buildingIds);
                const buildingUnits = dedupeById(
                    'DEVELOPMENT_BUILDING_UNITS_INVARIANT',
                    await readChunked(
                        'DEVELOPMENT_BUILDING_UNITS_INVARIANT',
                        buildingIds,
                        (chunk, from, to) =>
                            developmentDatabase
                                .from('building_units')
                                .select('*', { count: 'exact' })
                                .in('building_id', chunk)
                                .order('id', {
                                    ascending: true,
                                })
                                .range(from, to)
                    )
                );
                if (
                    buildingUnits.some(
                        (row) =>
                            typeof row.building_id !== 'string' ||
                            !buildingIdSet.has(
                                row.building_id.toLowerCase()
                            )
                    )
                ) {
                    throw new Error(
                        'DEVELOPMENT_BUILDING_UNITS_INVARIANT_SCOPE_INVALID'
                    );
                }
                const externalRefs = dedupeById(
                    'DEVELOPMENT_BUILDING_EXTERNAL_REFS_INVARIANT',
                    [
                        ...(await readChunked(
                            'DEVELOPMENT_BUILDING_EXTERNAL_REFS_INVARIANT',
                            buildingIds,
                            (chunk, from, to) =>
                                developmentDatabase
                                    .from(
                                        'building_external_refs'
                                    )
                                    .select('*', {
                                        count: 'exact',
                                    })
                                    .in('building_id', chunk)
                                    .order('id', {
                                        ascending: true,
                                    })
                                    .range(from, to)
                        )),
                        ...(await readChunked(
                            'DEVELOPMENT_BUILDING_EXTERNAL_REFS_INVARIANT',
                            scopePnus,
                            (chunk, from, to) =>
                                developmentDatabase
                                    .from(
                                        'building_external_refs'
                                    )
                                    .select('*', {
                                        count: 'exact',
                                    })
                                    .in('pnu', chunk)
                                    .order('id', {
                                        ascending: true,
                                    })
                                    .range(from, to)
                        )),
                    ]
                );
                if (
                    externalRefs.some(
                        (row) =>
                            (typeof row.building_id !== 'string' ||
                                !buildingIdSet.has(
                                    row.building_id.toLowerCase()
                                )) &&
                            (typeof row.pnu !== 'string' ||
                                !scopeSet.has(row.pnu))
                    )
                ) {
                    throw new Error(
                        'DEVELOPMENT_BUILDING_EXTERNAL_REFS_INVARIANT_SCOPE_INVALID'
                    );
                }
                const unionRelations = await readExactPaged(
                    'DEVELOPMENT_BUILDING_REGISTRY_RELATIONS_INVARIANT',
                    (from, to) =>
                        developmentDatabase
                            .from(
                                'building_registry_land_lot_relations'
                            )
                            .select('*', { count: 'exact' })
                            .eq('union_id', input.unionId)
                            .order('id', { ascending: true })
                            .range(from, to)
                );
                const relations = unionRelations.filter(
                    (row) =>
                        (typeof row.base_pnu === 'string' &&
                            scopeSet.has(row.base_pnu)) ||
                        (typeof row.attached_pnu === 'string' &&
                            scopeSet.has(row.attached_pnu))
                );
                if (
                    relations.some(
                        (row) =>
                            row.union_id !== input.unionId ||
                            typeof row.base_pnu !== 'string' ||
                            typeof row.attached_pnu !== 'string'
                    )
                ) {
                    throw new Error(
                        'DEVELOPMENT_BUILDING_REGISTRY_RELATIONS_INVARIANT_SCOPE_INVALID'
                    );
                }
                const unionManualOverrides = await readExactPaged(
                    'DEVELOPMENT_BUILDING_MANUAL_OVERRIDES_INVARIANT',
                    (from, to) =>
                        developmentDatabase
                            .from(
                                'building_land_lot_manual_overrides'
                            )
                            .select('*', { count: 'exact' })
                            .eq('union_id', input.unionId)
                            .order('id', { ascending: true })
                            .range(from, to)
                );
                const manualOverrides =
                    unionManualOverrides.filter(
                        (row) =>
                            (typeof row.base_pnu === 'string' &&
                                scopeSet.has(row.base_pnu)) ||
                            (typeof row.attached_pnu === 'string' &&
                                scopeSet.has(row.attached_pnu))
                    );
                if (
                    manualOverrides.some(
                        (row) =>
                            row.union_id !== input.unionId ||
                            typeof row.base_pnu !== 'string' ||
                            typeof row.attached_pnu !== 'string'
                    )
                ) {
                    throw new Error(
                        'DEVELOPMENT_BUILDING_MANUAL_OVERRIDES_INVARIANT_SCOPE_INVALID'
                    );
                }
                return {
                    land_lots: landLots,
                    building_land_lots: buildingLandLots,
                    buildings,
                    building_units: buildingUnits,
                    building_external_refs: externalRefs,
                    building_registry_land_lot_relations:
                        relations,
                    building_land_lot_manual_overrides:
                        manualOverrides,
                } satisfies DevelopmentRelationGisInvariantRows;
            },
            async readPropertyUnitLandRights(unionId) {
                if (unionId !== target.unionId) {
                    throw new Error(
                        'DEVELOPMENT_LAND_RIGHT_SCOPE_INVALID'
                    );
                }
                const rows = await readExactPaged(
                    'DEVELOPMENT_LAND_RIGHT',
                    (from, to) =>
                        developmentDatabase
                            .from('property_unit_land_rights')
                            .select('*', { count: 'exact' })
                            .eq('union_id', unionId)
                            .order('property_unit_id', {
                                ascending: true,
                            })
                            .order('target_pnu', {
                                ascending: true,
                            })
                            .range(from, to)
                );
                if (
                    rows.some(
                        (row) => row.union_id !== unionId
                    )
                ) {
                    throw new Error(
                        'DEVELOPMENT_LAND_RIGHT_SCOPE_INVALID'
                    );
                }
                return rows;
            },
        },
    });
    await writeArtifact(args.outputPath, artifact);
    process.stdout.write(
        `LAND_AREA_DEVELOPMENT_RUN_ARTIFACT:${artifact.gate.status}\n`
    );
    if (artifact.gate.status !== 'PASS') {
        if (
            typeof artifact.gate.failureCode === 'string' &&
            /ADMISSION|API_NETWORK|API_RESPONSE/.test(
                artifact.gate.failureCode
            )
        ) {
            await emitRunnerProbe(
                'POSTFAIL',
                args.actorAuthUserId,
                probeAuth
            );
        }
        process.exitCode = 1;
    }
}

main().catch((error: unknown) => {
    process.stderr.write(
        `LAND_AREA_DEVELOPMENT_RUNNER_ERROR:${controlledFailureCode(error)}\n`
    );
    process.exitCode = 2;
});
