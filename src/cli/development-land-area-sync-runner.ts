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
} from '../operations/development-land-area-sync-runner';

const PRIVATE_DIRECTORY = '.development-land-area-sync';
const INPUT_SIZE_LIMIT = 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    validateDevelopmentRunnerEnvironment(process.env, target);

    const client = new LocalhostDevelopmentLandAreaSyncClient(
        process.env.DEV_API_JWT_SECRET!,
        args.actorAuthUserId
    );
    const developmentDatabase = createClient(
        process.env.DEV_SUPABASE_URL!,
        process.env.DEV_SUPABASE_SERVICE_ROLE_KEY!,
        {
            auth: {
                persistSession: false,
                autoRefreshToken: false,
                detectSessionInUrl: false,
            },
        }
    );
    type JsonRow = Record<string, unknown>;
    const pageSize = 500;
    const maxInvariantRows = 10_000;
    const readExactPaged = async (
        code: string,
        fetchPage: (
            from: number,
            to: number
        ) => PromiseLike<{
            data: unknown;
            error: unknown;
            count: number | null;
        }>
    ): Promise<JsonRow[]> => {
        const rows: JsonRow[] = [];
        let expectedCount: number | null = null;
        while (true) {
            const result = await fetchPage(
                rows.length,
                rows.length + pageSize - 1
            );
            if (
                result.error ||
                !Array.isArray(result.data) ||
                !Number.isSafeInteger(result.count) ||
                (result.count as number) < 0 ||
                (expectedCount !== null &&
                    result.count !== expectedCount)
            ) {
                throw new Error(`${code}_READ_FAILED`);
            }
            const pageCount = result.count as number;
            expectedCount = pageCount;
            for (const row of result.data) {
                if (
                    row === null ||
                    typeof row !== 'object' ||
                    Array.isArray(row)
                ) {
                    throw new Error(`${code}_ROW_INVALID`);
                }
                rows.push(row as JsonRow);
            }
            if (
                rows.length > maxInvariantRows ||
                rows.length > pageCount
            ) {
                throw new Error(`${code}_COUNT_INVALID`);
            }
            if (rows.length === pageCount) return rows;
            if (result.data.length === 0) {
                throw new Error(`${code}_TRUNCATED`);
            }
        }
    };
    const chunks = <T>(values: T[], size = 100): T[][] => {
        const result: T[][] = [];
        for (let offset = 0; offset < values.length; offset += size) {
            result.push(values.slice(offset, offset + size));
        }
        return result;
    };
    const readChunked = async (
        code: string,
        values: string[],
        fetchChunk: (
            chunk: string[],
            from: number,
            to: number
        ) => PromiseLike<{
            data: unknown;
            error: unknown;
            count: number | null;
        }>
    ): Promise<JsonRow[]> => {
        const rows: JsonRow[] = [];
        for (const chunk of chunks(values)) {
            rows.push(
                ...(await readExactPaged(
                    code,
                    (from, to) =>
                        fetchChunk(chunk, from, to)
                ))
            );
        }
        if (rows.length > maxInvariantRows) {
            throw new Error(`${code}_COUNT_INVALID`);
        }
        return rows;
    };
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
                const { data, error } = await developmentDatabase
                    .from('property_units')
                    .select(
                        'id, pnu, land_area, land_area_source, land_area_synced_at, land_area_sync_job_id'
                    )
                    .eq('union_id', unionId)
                    .eq('is_deleted', false)
                    .order('id', { ascending: true })
                    .range(
                        0,
                        target.expectedUnionActivePropertyUnitCount
                    );
                if (error || !Array.isArray(data)) {
                    throw new Error('DEVELOPMENT_PREFLIGHT_READ_FAILED');
                }
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
                const { data, error } = await developmentDatabase
                    .from('property_units')
                    .select('id, union_id, land_area_sync_job_id')
                    .in('land_area_sync_job_id', syncJobIds)
                    .order('id', { ascending: true })
                    .range(0, target.expectedPropertyUnitCount);
                if (error || !Array.isArray(data)) {
                    throw new Error(
                        'DEVELOPMENT_WRITE_ATTRIBUTION_READ_FAILED'
                    );
                }
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
        process.exitCode = 1;
    }
}

main().catch((error: unknown) => {
    process.stderr.write(
        `LAND_AREA_DEVELOPMENT_RUNNER_ERROR:${controlledFailureCode(error)}\n`
    );
    process.exitCode = 2;
});
