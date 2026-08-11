import { createHash } from 'node:crypto';
import {
    lstat,
    mkdir,
    open,
    readFile,
    realpath,
} from 'node:fs/promises';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
    DEVELOPMENT_RELATION_ADOPTION_INSPECTOR_CONTRACT,
    isRelationAdoptionDatabaseTarget,
    parseDevelopmentRelationAdoptionTarget,
    runDevelopmentRelationAdoption,
    toDevelopmentRelationAdoptionPublicArtifact,
    type DevelopmentRelationAdoptionDatabase,
    type DevelopmentRelationAdoptionReceipt,
    type DevelopmentRelationAdoptionTarget,
    type DevelopmentRelationSnapshot,
    type DevelopmentRelationWriteAttribution,
    type RelationAdoptionDatabaseTarget,
} from '../operations/development-building-registry-relation-adoption';
import { LandAreaSyncAdapter } from '../services/land-area-sync/adapter';
import { validateLandAreaPhase0CaptureArtifact } from '../verification/land-area-phase0-artifact-validator';

const PRIVATE_DIRECTORY =
    '.development-building-registry-relation-adoption';
const DEVELOPMENT_PROJECT_REF = 'yxypndgipnxrdfyctmvh';
const PRODUCTION_PROJECT_REF = 'bpdjashtxqrcgxfequgf';

// target 별로 접속 가능한 프로젝트를 exact 로 못박는다. 종전에는 dev URL 하나만
// 허용해 운영을 구조적으로 막았는데, 이제 "선언한 target 과 실제 URL 이 일치"를
// 요구한다 — 임의 프로젝트로 향하는 것은 여전히 불가능하다.
const SUPABASE_URL_BY_TARGET: Record<RelationAdoptionDatabaseTarget, string> = {
    development: `https://${DEVELOPMENT_PROJECT_REF}.supabase.co`,
    production: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
};

const SUPABASE_ENV_KEYS_BY_TARGET: Record<
    RelationAdoptionDatabaseTarget,
    { url: string; serviceRoleKey: string }
> = {
    development: {
        url: 'DEV_SUPABASE_URL',
        serviceRoleKey: 'DEV_SUPABASE_SERVICE_ROLE_KEY',
    },
    production: {
        url: 'SUPABASE_URL',
        serviceRoleKey: 'SUPABASE_SERVICE_ROLE_KEY',
    },
};
const INPUT_SIZE_LIMIT = 128 * 1024;
const OUTPUT_SIZE_LIMIT = 3 * 1024 * 1024;
const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

interface CliArguments {
    targetPath: string;
    phase0ManifestPath: string;
    phase0ArtifactPath: string;
    sourceReleaseSha: string;
    outputPath: string;
}

export interface DevelopmentRelationAdoptionCliEnvironment {
    DATA_PORTAL_API_KEY?: string;
    DEV_SUPABASE_URL?: string;
    DEV_SUPABASE_SERVICE_ROLE_KEY?: string;
    SUPABASE_URL?: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
    RELATION_ADOPTION_DATABASE_TARGET?: string;
    LAND_AREA_SYNC_ENABLED?: string;
    [key: string]: string | undefined;
}

interface CliDependencies {
    cwd?: string;
    env?: DevelopmentRelationAdoptionCliEnvironment;
    database?: DevelopmentRelationAdoptionDatabase;
    adapter?: LandAreaSyncAdapter;
    stdout?: (message: string) => void;
    stderr?: (message: string) => void;
}

type JsonRow = Record<string, unknown>;

function parseArguments(argv: string[]): CliArguments {
    const values = new Map<string, string>();
    if (argv.length !== 10) throw new Error('CLI_ARGUMENT_INVALID');
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (
            !flag ||
            !value ||
            ![
                '--target',
                '--phase0-manifest',
                '--phase0-artifact',
                '--source-release-sha',
                '--out',
            ].includes(flag) ||
            values.has(flag)
        ) {
            throw new Error('CLI_ARGUMENT_INVALID');
        }
        values.set(flag, value);
    }
    const targetPath = values.get('--target');
    const phase0ManifestPath = values.get('--phase0-manifest');
    const phase0ArtifactPath = values.get('--phase0-artifact');
    const sourceReleaseSha = values.get('--source-release-sha');
    const outputPath = values.get('--out');
    if (
        !targetPath ||
        !phase0ManifestPath ||
        !phase0ArtifactPath ||
        !sourceReleaseSha ||
        !outputPath ||
        !HEX40_RE.test(sourceReleaseSha)
    ) {
        throw new Error('CLI_ARGUMENT_INVALID');
    }
    return {
        targetPath,
        phase0ManifestPath,
        phase0ArtifactPath,
        sourceReleaseSha,
        outputPath,
    };
}

function resolvePrivatePath(cwd: string, candidate: string): string {
    const root = path.resolve(cwd, PRIVATE_DIRECTORY);
    const resolved = path.resolve(cwd, candidate);
    if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error('CLI_PATH_OUTSIDE_PRIVATE_DIRECTORY');
    }
    return resolved;
}

async function ensurePrivateDirectory(
    cwd: string,
    candidate: string
): Promise<string> {
    const root = path.resolve(cwd, PRIVATE_DIRECTORY);
    if (path.dirname(candidate) !== root) {
        throw new Error('CLI_PATH_OUTSIDE_PRIVATE_DIRECTORY');
    }
    try {
        const info = await lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error('CLI_PRIVATE_DIRECTORY_INVALID');
        }
        if ((info.mode & 0o077) !== 0) {
            throw new Error('CLI_PRIVATE_DIRECTORY_PERMISSIONS_INVALID');
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(root, { mode: 0o700 });
    }
    return root;
}

async function readPrivateJson(
    cwd: string,
    candidate: string
): Promise<unknown> {
    const target = resolvePrivatePath(cwd, candidate);
    const root = await ensurePrivateDirectory(cwd, target);
    const [rootInfo, targetInfo] = await Promise.all([
        lstat(root),
        lstat(target),
    ]);
    if (
        !rootInfo.isDirectory() ||
        rootInfo.isSymbolicLink() ||
        !targetInfo.isFile() ||
        targetInfo.isSymbolicLink() ||
        (targetInfo.mode & 0o077) !== 0 ||
        targetInfo.size < 2 ||
        targetInfo.size > INPUT_SIZE_LIMIT
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

async function readPrivateJsonWithSha256(
    cwd: string,
    candidate: string
): Promise<{ value: unknown; sha256: string }> {
    const target = resolvePrivatePath(cwd, candidate);
    const root = await ensurePrivateDirectory(cwd, target);
    const [rootInfo, targetInfo] = await Promise.all([
        lstat(root),
        lstat(target),
    ]);
    if (
        !rootInfo.isDirectory() ||
        rootInfo.isSymbolicLink() ||
        !targetInfo.isFile() ||
        targetInfo.isSymbolicLink() ||
        (targetInfo.mode & 0o077) !== 0 ||
        targetInfo.size < 2 ||
        targetInfo.size > OUTPUT_SIZE_LIMIT
    ) {
        throw new Error('CLI_PHASE0_ARTIFACT_INVALID');
    }
    const [rootReal, targetReal] = await Promise.all([
        realpath(root),
        realpath(target),
    ]);
    if (!targetReal.startsWith(`${rootReal}${path.sep}`)) {
        throw new Error('CLI_PHASE0_ARTIFACT_INVALID');
    }
    const body = await readFile(targetReal);
    return {
        value: JSON.parse(body.toString('utf8')) as unknown,
        sha256: createHash('sha256').update(body).digest('hex'),
    };
}

async function writePrivateJson(
    cwd: string,
    candidate: string,
    value: unknown
): Promise<void> {
    const target = resolvePrivatePath(cwd, candidate);
    await ensurePrivateDirectory(cwd, target);
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > OUTPUT_SIZE_LIMIT) {
        throw new Error('CLI_OUTPUT_SIZE_INVALID');
    }
    const handle = await open(target, 'wx', 0o600);
    try {
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
        await handle.chmod(0o600);
    } finally {
        await handle.close();
    }
}

function required(value: string | undefined, code: string): string {
    const normalized = value?.trim();
    if (!normalized) throw new Error(code);
    return normalized;
}

export function validateDevelopmentRelationAdoptionEnvironment(
    env: DevelopmentRelationAdoptionCliEnvironment
): {
    serviceKey: string;
    databaseTarget: RelationAdoptionDatabaseTarget;
    supabaseUrl: string;
    supabaseServiceRoleKey: string;
} {
    const serviceKey = required(
        env.DATA_PORTAL_API_KEY,
        'DATA_PORTAL_API_KEY_MISSING'
    );

    // 미지정이면 development. 기존 워크플로·로컬 실행은 그대로 dev 로 동작한다.
    const requestedTarget = env.RELATION_ADOPTION_DATABASE_TARGET?.trim()
        ? env.RELATION_ADOPTION_DATABASE_TARGET.trim()
        : 'development';
    if (!isRelationAdoptionDatabaseTarget(requestedTarget)) {
        throw new Error('RELATION_RUN_DATABASE_TARGET_INVALID');
    }
    const databaseTarget: RelationAdoptionDatabaseTarget = requestedTarget;
    const envKeys = SUPABASE_ENV_KEYS_BY_TARGET[databaseTarget];

    const supabaseUrl = required(
        env[envKeys.url],
        `${envKeys.url}_MISSING`
    );
    const supabaseServiceRoleKey = required(
        env[envKeys.serviceRoleKey],
        `${envKeys.serviceRoleKey}_MISSING`
    );
    if (
        supabaseUrl !== SUPABASE_URL_BY_TARGET[databaseTarget] ||
        env.LAND_AREA_SYNC_ENABLED !== 'false' ||
        serviceKey.length > 4096 ||
        supabaseServiceRoleKey.length > 8192
    ) {
        throw new Error('RELATION_RUN_ENVIRONMENT_INVALID');
    }
    return {
        serviceKey,
        databaseTarget,
        supabaseUrl,
        supabaseServiceRoleKey,
    };
}

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        const record = value as JsonRow;
        const result: JsonRow = {};
        for (const key of Object.keys(record).sort()) {
            if (record[key] !== undefined) {
                result[key] = canonicalize(record[key]);
            }
        }
        return result;
    }
    return value;
}

function stableStringify(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

function text(row: JsonRow, key: string): string {
    return typeof row[key] === 'string' ? row[key].trim() : '';
}

function boolean(row: JsonRow, key: string): boolean | null {
    return typeof row[key] === 'boolean' ? row[key] : null;
}

function number(row: JsonRow, key: string): number | null {
    return typeof row[key] === 'number' &&
        Number.isSafeInteger(row[key])
        ? row[key]
        : null;
}

function exactRecord(
    input: unknown,
    keys: readonly string[],
    code: string
): JsonRow {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error(code);
    }
    const record = input as JsonRow;
    if (
        JSON.stringify(Object.keys(record).sort()) !==
        JSON.stringify([...keys].sort())
    ) {
        throw new Error(code);
    }
    return record;
}

function parseWriteAttribution(
    input: unknown
): DevelopmentRelationWriteAttribution {
    const value = exactRecord(
        input,
        [
            'syncJobs',
            'operations',
            'inputPnus',
            'commands',
            'observations',
            'observationPairs',
            'groupStates',
            'relations',
            'relationProjectionStatuses',
            'attributedIdDigest',
        ],
        'DEVELOPMENT_WRITE_ATTRIBUTION_INVALID'
    );
    const tableNames = [
        'syncJobs',
        'operations',
        'inputPnus',
        'commands',
        'observations',
        'observationPairs',
        'groupStates',
        'relations',
    ] as const;
    const tables = Object.fromEntries(
        tableNames.map((tableName) => {
            const table = exactRecord(
                value[tableName],
                ['count', 'digest'],
                'DEVELOPMENT_WRITE_ATTRIBUTION_INVALID'
            );
            if (
                typeof table.count !== 'number' ||
                !Number.isSafeInteger(table.count) ||
                table.count < 0 ||
                typeof table.digest !== 'string' ||
                !HEX64_RE.test(table.digest)
            ) {
                throw new Error(
                    'DEVELOPMENT_WRITE_ATTRIBUTION_INVALID'
                );
            }
            return [
                tableName,
                {
                    count: table.count,
                    digest: table.digest,
                },
            ];
        })
    ) as Record<
        (typeof tableNames)[number],
        { count: number; digest: string }
    >;
    if (
        !Array.isArray(value.relationProjectionStatuses) ||
        !value.relationProjectionStatuses.every(
            (status) =>
                typeof status === 'string' &&
                /^[A-Z_]{1,50}$/.test(status)
        ) ||
        typeof value.attributedIdDigest !== 'string' ||
        !HEX64_RE.test(value.attributedIdDigest)
    ) {
        throw new Error('DEVELOPMENT_WRITE_ATTRIBUTION_INVALID');
    }
    return {
        counts: {
            syncJobs: tables.syncJobs.count,
            operations: tables.operations.count,
            inputPnus: tables.inputPnus.count,
            commands: tables.commands.count,
            observations: tables.observations.count,
            observationPairs: tables.observationPairs.count,
            groupStates: tables.groupStates.count,
            relations: tables.relations.count,
        },
        digest: sha256(stableStringify(tables)),
        relationProjectionStatuses: [
            ...value.relationProjectionStatuses,
        ].sort() as string[],
        attributedIdDigest: value.attributedIdDigest,
    };
}

export function validateDevelopmentRelationAdoptionPriorPhase0Artifact(input: {
    target: DevelopmentRelationAdoptionTarget;
    manifestInput: unknown;
    artifactInput: unknown;
    artifactSha256: string;
}) {
    if (
        input.artifactSha256 !== input.target.phase0.artifactSha256
    ) {
        throw new Error('PRIOR_PHASE0_ARTIFACT_SHA_MISMATCH');
    }
    const validated = validateLandAreaPhase0CaptureArtifact(
        input.manifestInput,
        input.artifactInput
    ) as unknown as JsonRow;
    const gate = exactRecord(
        validated.gate,
        ['status', 'failureCodes', 'reviewCodes'],
        'PRIOR_PHASE0_ARTIFACT_INVALID'
    );
    if (
        validated.version !== input.target.phase0.artifactVersion ||
        validated.schemaHash !== input.target.phase0.schemaHash ||
        gate.status !== 'PASS' ||
        !Array.isArray(gate.failureCodes) ||
        gate.failureCodes.length !== 0 ||
        !Array.isArray(validated.samples)
    ) {
        throw new Error('PRIOR_PHASE0_ARTIFACT_INVALID');
    }
    const matchingSamples = validated.samples.filter((candidate) => {
        const sample =
            candidate && typeof candidate === 'object'
                ? (candidate as JsonRow)
                : {};
        return (
            sample.pnuHash ===
            input.target.officialHashes.basePnuHash
        );
    });
    if (matchingSamples.length !== 1) {
        throw new Error('PRIOR_PHASE0_SAMPLE_MISMATCH');
    }
    const sample = matchingSamples[0] as JsonRow;
    if (
        sample.expectedBylot !== 'POSITIVE' ||
        !Array.isArray(sample.endpoints)
    ) {
        throw new Error('PRIOR_PHASE0_SAMPLE_MISMATCH');
    }
    const endpoint = (name: string): JsonRow => {
        const candidates = (sample.endpoints as unknown[]).filter(
            (value) =>
                value &&
                typeof value === 'object' &&
                (value as JsonRow).endpoint === name
        );
        if (candidates.length !== 1) {
            throw new Error('PRIOR_PHASE0_ENDPOINT_MISMATCH');
        }
        return candidates[0] as JsonRow;
    };
    const title = endpoint('getBrTitleInfo');
    const basis = endpoint('getBrBasisOulnInfo');
    const attached = endpoint('getBrAtchJibunInfo');
    if (
        title.state !== 'COMPLETE' ||
        basis.state !== 'COMPLETE' ||
        attached.state !== 'COMPLETE' ||
        title.schemaHash !==
            input.target.officialHashes.titleSchemaHash ||
        basis.schemaHash !==
            input.target.officialHashes.basisSchemaHash ||
        attached.schemaHash !==
            input.target.officialHashes.attachedSchemaHash
    ) {
        throw new Error('PRIOR_PHASE0_ENDPOINT_MISMATCH');
    }
    const titleInventory = title.inventory as JsonRow;
    const basisInventory = basis.inventory as JsonRow;
    const attachedInventory = attached.inventory as JsonRow;
    if (
        !titleInventory ||
        !basisInventory ||
        !attachedInventory ||
        !Array.isArray(titleInventory.records) ||
        titleInventory.records.length !== 1 ||
        !Array.isArray(basisInventory.records) ||
        basisInventory.records.length < 1 ||
        !Array.isArray(attachedInventory.pairs) ||
        attachedInventory.pairs.length !== 1
    ) {
        throw new Error('PRIOR_PHASE0_INVENTORY_MISMATCH');
    }
    const expectedManagementHash =
        input.target.officialHashes.managementPkHash;
    const titleRecord = titleInventory.records[0] as JsonRow;
    const titleBylot = titleRecord.bylot as JsonRow;
    const basisRecords = basisInventory.records as JsonRow[];
    const basisMatches = basisRecords.every((record) => {
        const bylot = record.bylot as JsonRow;
        return (
            (record.managementPkHash === expectedManagementHash ||
                record.upManagementPkHash ===
                    expectedManagementHash) &&
            bylot?.parseState === 'VALID' &&
            bylot?.count === 1
        );
    });
    const pair = attachedInventory.pairs[0] as JsonRow;
    if (
        titleRecord.managementPkHash !== expectedManagementHash ||
        titleBylot?.parseState !== 'VALID' ||
        titleBylot?.count !== 1 ||
        !basisMatches ||
        pair.managementPkHash !== expectedManagementHash ||
        pair.basePnuHash !==
            input.target.officialHashes.basePnuHash ||
        pair.attachedPnuHash !==
            input.target.officialHashes.attachedPnuHash ||
        attachedInventory.totalPairs !== 1 ||
        attachedInventory.totalRejected !== 0 ||
        attachedInventory.pairsDigest !==
            input.target.officialHashes.pairsDigest
    ) {
        throw new Error('PRIOR_PHASE0_COMMITMENT_MISMATCH');
    }
    return {
        artifactSha256: input.artifactSha256,
        schemaHash: input.target.phase0.schemaHash,
        managementPkHash: expectedManagementHash,
        basePnuHash: input.target.officialHashes.basePnuHash,
        attachedPnuHash:
            input.target.officialHashes.attachedPnuHash,
        pairsDigest: input.target.officialHashes.pairsDigest,
    };
}

export class SupabaseDevelopmentRelationAdoptionDatabase
    implements DevelopmentRelationAdoptionDatabase
{
    constructor(private readonly client: SupabaseClient) {}

    async readSnapshot(
        target: DevelopmentRelationAdoptionTarget,
        syncJobId: string | null
    ): Promise<DevelopmentRelationSnapshot> {
        const { data, error } = await this.client.rpc(
            'inspect_development_verified_building_registry_relation_v1',
            {
                p_union_id: target.unionId,
                p_base_pnu: target.basePnu,
                p_attached_pnu: target.attachedPnu,
                p_mgm_bldrgst_pk: target.managementPk,
                p_sync_job_id: syncJobId,
            }
        );
        if (error) {
            throw new Error('DEVELOPMENT_RELATION_INSPECTOR_RPC_FAILED');
        }
        const result = exactRecord(
            data,
            [
                'contractVersion',
                'databaseTarget',
                'unionId',
                'basePnu',
                'attachedPnu',
                'mgmBldrgstPk',
                'propertyMembership',
                'relationProjection',
                'canonicalTableDigests',
                'landAreaApproval',
                'relationAdoptionApproval',
                'writeAttribution',
            ],
            'DEVELOPMENT_RELATION_INSPECTOR_INVALID'
        );
        if (
            result.contractVersion !==
                DEVELOPMENT_RELATION_ADOPTION_INSPECTOR_CONTRACT ||
            result.databaseTarget !== target.databaseTarget ||
            result.unionId !== target.unionId ||
            result.basePnu !== target.basePnu ||
            result.attachedPnu !== target.attachedPnu ||
            result.mgmBldrgstPk !== target.managementPk
        ) {
            throw new Error('DEVELOPMENT_RELATION_INSPECTOR_INVALID');
        }
        const membership = exactRecord(
            result.propertyMembership,
            ['count', 'digest'],
            'DEVELOPMENT_RELATION_INSPECTOR_INVALID'
        );
        const relation = exactRecord(
            result.relationProjection,
            ['count', 'digest', 'activeCount', 'linkedCount'],
            'DEVELOPMENT_RELATION_INSPECTOR_INVALID'
        );
        const digests = exactRecord(
            result.canonicalTableDigests,
            [
                'propertyUnits',
                'propertyOwnerships',
                'buildings',
                'buildingUnits',
                'buildingLandLots',
                'buildingExternalRefs',
                'landLots',
                'propertyUnitLandRights',
                'landAreaProvenance',
                'landAreaSyncJobs',
                'nonTargetOfficialRelations',
            ],
            'DEVELOPMENT_RELATION_INSPECTOR_INVALID'
        );
        const landAreaApproval = exactRecord(
            result.landAreaApproval,
            [
                'rowCount',
                'enabledCount',
                'targetRowCount',
                'targetCount',
                'manifestDigest',
                'stableDigest',
            ],
            'DEVELOPMENT_RELATION_INSPECTOR_INVALID'
        );
        const relationApproval = exactRecord(
            result.relationAdoptionApproval,
            [
                'rowCount',
                'enabled',
                'consumedAt',
                'targetDigest',
                'expiresAt',
            ],
            'DEVELOPMENT_RELATION_INSPECTOR_INVALID'
        );
        const integerField = (row: JsonRow, key: string): number => {
            const value = number(row, key);
            if (value === null || value < 0) {
                throw new Error(
                    'DEVELOPMENT_RELATION_INSPECTOR_INVALID'
                );
            }
            return value;
        };
        const digestField = (row: JsonRow, key: string): string => {
            const value = text(row, key);
            if (!HEX64_RE.test(value)) {
                throw new Error(
                    'DEVELOPMENT_RELATION_INSPECTOR_INVALID'
                );
            }
            return value;
        };
        const optionalTimestamp = (
            row: JsonRow,
            key: string
        ): string | null => {
            if (row[key] === null) return null;
            if (
                typeof row[key] !== 'string' ||
                !Number.isFinite(Date.parse(row[key]))
            ) {
                throw new Error(
                    'DEVELOPMENT_RELATION_INSPECTOR_INVALID'
                );
            }
            return new Date(row[key]).toISOString();
        };
        const optionalDigest = (
            row: JsonRow,
            key: string
        ): string | null => {
            if (row[key] === null) return null;
            return digestField(row, key);
        };
        const enabled = boolean(relationApproval, 'enabled');
        const relationApprovalRowCount = integerField(
            relationApproval,
            'rowCount'
        );
        integerField(landAreaApproval, 'rowCount');
        const landAreaEnabledCount = integerField(
            landAreaApproval,
            'enabledCount'
        );
        integerField(landAreaApproval, 'targetRowCount');
        const landAreaTargetCount =
            landAreaApproval.targetCount === null
                ? null
                : integerField(landAreaApproval, 'targetCount');
        const landAreaManifestDigest =
            landAreaApproval.manifestDigest === null
                ? null
                : digestField(landAreaApproval, 'manifestDigest');
        if (
            enabled === null ||
            relationApprovalRowCount > 1 ||
            landAreaEnabledCount !== 0 ||
            (landAreaTargetCount === null) !==
                (landAreaManifestDigest === null)
        ) {
            throw new Error('DEVELOPMENT_RELATION_INSPECTOR_INVALID');
        }
        return {
            expectedActivePropertyUnitCount: integerField(
                membership,
                'count'
            ),
            expectedPropertyUnitDigest: digestField(
                membership,
                'digest'
            ),
            landAreaApproval: {
                enabled: false,
                stableDigest: digestField(
                    landAreaApproval,
                    'stableDigest'
                ),
            },
            relationAdoptionApproval: {
                rowCount: relationApprovalRowCount,
                enabled,
                consumedAt: optionalTimestamp(
                    relationApproval,
                    'consumedAt'
                ),
                targetDigest: optionalDigest(
                    relationApproval,
                    'targetDigest'
                ),
                expiresAt: optionalTimestamp(
                    relationApproval,
                    'expiresAt'
                ),
            },
            targetRelation: {
                count: integerField(relation, 'count'),
                digest: digestField(relation, 'digest'),
                activeCount: integerField(relation, 'activeCount'),
                linkedCount: integerField(relation, 'linkedCount'),
            },
            hashes: {
                propertyUnits: digestField(digests, 'propertyUnits'),
                propertyOwnerships: digestField(
                    digests,
                    'propertyOwnerships'
                ),
                buildingLandLots: digestField(
                    digests,
                    'buildingLandLots'
                ),
                buildings: digestField(digests, 'buildings'),
                buildingUnits: digestField(digests, 'buildingUnits'),
                buildingExternalRefs: digestField(
                    digests,
                    'buildingExternalRefs'
                ),
                landLots: digestField(digests, 'landLots'),
                landAreaTuples: digestField(
                    digests,
                    'landAreaProvenance'
                ),
                landRightRows: digestField(
                    digests,
                    'propertyUnitLandRights'
                ),
                landAreaSyncJobs: digestField(
                    digests,
                    'landAreaSyncJobs'
                ),
                nonTargetRelations: digestField(
                    digests,
                    'nonTargetOfficialRelations'
                ),
            },
            writeAttribution:
                result.writeAttribution === null
                    ? null
                    : parseWriteAttribution(
                          result.writeAttribution
                      ),
        };
    }

    async adoptRelation(input: {
        target: DevelopmentRelationAdoptionTarget;
        expectedPropertyUnitDigest: string;
        targetDigest: string;
        sourceReleaseSha: string;
        syncJobId: string;
    }): Promise<DevelopmentRelationAdoptionReceipt> {
        const { target } = input;
        const { data, error } = await this.client.rpc(
            'adopt_development_verified_building_registry_relation_v1',
            {
                p_union_id: target.unionId,
                p_base_pnu: target.basePnu,
                p_attached_pnu: target.attachedPnu,
                p_mgm_bldrgst_pk: target.managementPk,
                p_expected_property_unit_count:
                    target.expectedActivePropertyUnitCount,
                p_expected_property_unit_digest:
                    input.expectedPropertyUnitDigest,
                p_target_digest: input.targetDigest,
                p_phase0_run_id: Number(target.phase0.runId),
                p_phase0_artifact_version:
                    target.phase0.artifactVersion,
                p_phase0_artifact_sha256:
                    target.phase0.artifactSha256,
                p_phase0_schema_hash: target.phase0.schemaHash,
                p_phase0_pair_digest:
                    target.officialHashes.pairsDigest,
                p_source_release_sha: input.sourceReleaseSha,
                p_sync_job_id: input.syncJobId,
            }
        );
        if (error) throw new Error('DEVELOPMENT_RELATION_ADOPTION_RPC_FAILED');
        const receipt = exactRecord(
            data,
            [
                'status',
                'relationId',
                'observationId',
                'buildingId',
                'operationId',
                'operationEpoch',
                'commandId',
                'syncJobId',
                'projectionStatus',
                'basePnu',
                'attachedPnu',
                'mgmBldrgstPk',
                'expectedPropertyUnitCount',
                'expectedPropertyUnitDigest',
                'targetDigest',
                'phase0RunId',
                'phase0ArtifactSha256',
                'phase0SchemaHash',
                'phase0PairDigest',
                'sourceReleaseSha',
                'landAreaApprovalStableDigest',
            ],
            'DEVELOPMENT_RELATION_ADOPTION_RECEIPT_INVALID'
        );
        const stringField = (key: string): string => {
            if (typeof receipt[key] !== 'string') {
                throw new Error(
                    'DEVELOPMENT_RELATION_ADOPTION_RECEIPT_INVALID'
                );
            }
            return receipt[key];
        };
        const operationEpoch = number(receipt, 'operationEpoch');
        const expectedPropertyUnitCount = number(
            receipt,
            'expectedPropertyUnitCount'
        );
        const phase0RunId = number(receipt, 'phase0RunId');
        if (
            operationEpoch === null ||
            expectedPropertyUnitCount === null ||
            phase0RunId === null
        ) {
            throw new Error(
                'DEVELOPMENT_RELATION_ADOPTION_RECEIPT_INVALID'
            );
        }
        return {
            status: stringField('status') as
                | 'CREATED'
                | 'UPDATED'
                | 'REUSED',
            relationId: stringField('relationId'),
            observationId: stringField('observationId'),
            buildingId: stringField('buildingId'),
            operationId: stringField('operationId'),
            operationEpoch,
            commandId: stringField('commandId'),
            syncJobId: stringField('syncJobId'),
            projectionStatus: stringField(
                'projectionStatus'
            ) as 'LINKED',
            basePnu: stringField('basePnu'),
            attachedPnu: stringField('attachedPnu'),
            managementPk: stringField('mgmBldrgstPk'),
            expectedPropertyUnitCount,
            expectedPropertyUnitDigest: stringField(
                'expectedPropertyUnitDigest'
            ),
            targetDigest: stringField('targetDigest'),
            phase0RunId,
            phase0ArtifactSha256: stringField(
                'phase0ArtifactSha256'
            ),
            phase0SchemaHash: stringField('phase0SchemaHash'),
            phase0PairDigest: stringField('phase0PairDigest'),
            sourceReleaseSha: stringField('sourceReleaseSha'),
            landAreaApprovalStableDigest: stringField(
                'landAreaApprovalStableDigest'
            ),
        };
    }

}

export async function runDevelopmentRelationAdoptionCli(
    argv: string[],
    dependencies: CliDependencies = {}
): Promise<number> {
    const cwd = path.resolve(dependencies.cwd ?? process.cwd());
    const env = dependencies.env ?? process.env;
    const stdout =
        dependencies.stdout ??
        ((message: string) => process.stdout.write(`${message}\n`));
    const stderr =
        dependencies.stderr ??
        ((message: string) => process.stderr.write(`${message}\n`));
    try {
        const args = parseArguments(argv);
        const environment =
            validateDevelopmentRelationAdoptionEnvironment(env);
        const target = parseDevelopmentRelationAdoptionTarget(
            await readPrivateJson(cwd, args.targetPath)
        );
        const priorPhase0Manifest = await readPrivateJson(
            cwd,
            args.phase0ManifestPath
        );
        const priorPhase0Artifact =
            await readPrivateJsonWithSha256(
                cwd,
                args.phase0ArtifactPath
            );
        const priorPhase0Validation =
            validateDevelopmentRelationAdoptionPriorPhase0Artifact({
                target,
                manifestInput: priorPhase0Manifest,
                artifactInput: priorPhase0Artifact.value,
                artifactSha256:
                    priorPhase0Artifact.sha256,
            });
        // 접속할 DB 와 타깃 문서가 선언한 환경이 어긋나면 즉시 멈춘다.
        // 이게 없으면 production 자격증명으로 development 타깃을 채택할 수 있다.
        if (target.databaseTarget !== environment.databaseTarget) {
            throw new Error('RELATION_RUN_DATABASE_TARGET_MISMATCH');
        }
        const client = createClient(
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
        const artifact = await runDevelopmentRelationAdoption({
            target,
            sourceReleaseSha: args.sourceReleaseSha,
            buildingHubServiceKey: environment.serviceKey,
            adapter:
                dependencies.adapter ?? new LandAreaSyncAdapter(),
            database:
                dependencies.database ??
                new SupabaseDevelopmentRelationAdoptionDatabase(client),
            priorPhase0Validation,
        });
        await writePrivateJson(
            cwd,
            args.outputPath,
            toDevelopmentRelationAdoptionPublicArtifact(artifact)
        );
        stdout(
            artifact.gate.status === 'PASS'
                ? 'Development building relation adoption PASS (private artifact written).'
                : 'Development building relation adoption FAIL (private artifact written).'
        );
        return artifact.gate.status === 'PASS' ? 0 : 1;
    } catch {
        stderr(
            'Development building relation adoption rejected (input, environment, or file boundary).'
        );
        return 2;
    }
}

export async function mainDevelopmentRelationAdoptionCli(): Promise<void> {
    process.exitCode = await runDevelopmentRelationAdoptionCli(
        process.argv.slice(2)
    );
}

if (require.main === module) {
    void mainDevelopmentRelationAdoptionCli();
}
