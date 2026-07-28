import { constants } from 'node:fs';
import {
    lstat,
    mkdir,
    open,
    realpath,
} from 'node:fs/promises';
import path from 'node:path';
import {
    createClient,
    type SupabaseClient,
} from '@supabase/supabase-js';
import {
    DEVELOPMENT_API_LDAREG_INSPECTOR_CONTRACT,
    parseDevelopmentApiLdaregTarget,
    prepareDevelopmentApiLdaregBackfill,
    runDevelopmentApiLdaregBackfill,
    validateDevelopmentApiLdaregApprovalRequest,
    validateDevelopmentApiLdaregArtifact,
    validateDevelopmentApiLdaregPrepareArtifact,
    type DevelopmentApiLdaregApplyReceipt,
    type DevelopmentApiLdaregApprovalItem,
    type DevelopmentApiLdaregDatabase,
    type DevelopmentApiLdaregInspectorTarget,
    type DevelopmentApiLdaregInvariantDigests,
    type DevelopmentApiLdaregManualDecisionCounters,
    type DevelopmentApiLdaregProposalArea,
    type DevelopmentApiLdaregSnapshot,
    type DevelopmentApiLdaregTarget,
} from '../operations/development-api-authoritative-ldareg-backfill';
import { LandAreaSyncAdapter } from '../services/land-area-sync/adapter';

const PRIVATE_DIRECTORY =
    '.development-api-authoritative-ldareg-backfill';
const DEVELOPMENT_PROJECT_REF = 'yxypndgipnxrdfyctmvh';
const DEVELOPMENT_SUPABASE_URL =
    `https://${DEVELOPMENT_PROJECT_REF}.supabase.co`;
const INPUT_SIZE_LIMIT = 256 * 1024;
const OUTPUT_SIZE_LIMIT = 3 * 1024 * 1024;
const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNU_RE = /^\d{10}[12]\d{8}$/;
const SAFE_DECIMAL_RE =
    /^(?:0|[1-9]\d{0,8})(?:\.\d{1,8})?$/;

interface CliArguments {
    mode: 'prepare' | 'apply';
    targetPath: string;
    sourceReleaseSha: string;
    outputPath: string;
    approvalRequestOutputPath: string;
}

export interface DevelopmentApiLdaregCliEnvironment {
    DATA_PORTAL_API_KEY?: string;
    VWORLD_API_KEY?: string;
    VWORLD_API_DOMAIN?: string;
    DEV_SUPABASE_URL?: string;
    DEV_SUPABASE_SERVICE_ROLE_KEY?: string;
    LAND_AREA_SYNC_ENABLED?: string;
    LAND_AREA_SYNC_ALLOWED_TARGETS?: string;
    [key: string]: string | undefined;
}

interface CliDependencies {
    cwd?: string;
    env?: DevelopmentApiLdaregCliEnvironment;
    database?: DevelopmentApiLdaregDatabase;
    adapter?: LandAreaSyncAdapter;
    stdout?: (message: string) => void;
    stderr?: (message: string) => void;
}

type JsonRow = Record<string, unknown>;

function parseArguments(argv: string[]): CliArguments {
    if (argv.length !== 10) throw new Error('CLI_ARGUMENT_INVALID');
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (
            !flag ||
            !value ||
            ![
                '--mode',
                '--target',
                '--source-release-sha',
                '--out',
                '--approval-request-out',
            ].includes(flag) ||
            values.has(flag)
        ) {
            throw new Error('CLI_ARGUMENT_INVALID');
        }
        values.set(flag, value);
    }
    const mode = values.get('--mode');
    const targetPath = values.get('--target');
    const sourceReleaseSha = values.get('--source-release-sha');
    const outputPath = values.get('--out');
    const approvalRequestOutputPath = values.get(
        '--approval-request-out'
    );
    if (
        (mode !== 'prepare' && mode !== 'apply') ||
        !targetPath ||
        !sourceReleaseSha ||
        !outputPath ||
        !approvalRequestOutputPath ||
        outputPath === approvalRequestOutputPath ||
        !HEX40_RE.test(sourceReleaseSha)
    ) {
        throw new Error('CLI_ARGUMENT_INVALID');
    }
    return {
        mode,
        targetPath,
        sourceReleaseSha,
        outputPath,
        approvalRequestOutputPath,
    };
}

function resolvePrivatePath(cwd: string, candidate: string): string {
    const root = path.resolve(cwd, PRIVATE_DIRECTORY);
    const resolved = path.resolve(cwd, candidate);
    if (
        resolved === root ||
        !resolved.startsWith(`${root}${path.sep}`)
    ) {
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
            throw new Error(
                'CLI_PRIVATE_DIRECTORY_PERMISSIONS_INVALID'
            );
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
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
    const [rootInfoBefore, rootRealBefore] = await Promise.all([
        lstat(root),
        realpath(root),
    ]);
    const handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
        const [
            targetInfo,
            rootInfoAfter,
            rootRealAfter,
            targetReal,
        ] = await Promise.all([
            handle.stat(),
            lstat(root),
            realpath(root),
            realpath(target),
        ]);
        const targetPathInfo = await lstat(targetReal);
        if (
            !rootInfoBefore.isDirectory() ||
            rootInfoBefore.isSymbolicLink() ||
            !rootInfoAfter.isDirectory() ||
            rootInfoAfter.isSymbolicLink() ||
            (rootInfoBefore.mode & 0o077) !== 0 ||
            (rootInfoAfter.mode & 0o077) !== 0 ||
            rootInfoBefore.dev !== rootInfoAfter.dev ||
            rootInfoBefore.ino !== rootInfoAfter.ino ||
            rootRealBefore !== rootRealAfter ||
            path.dirname(targetReal) !== rootRealBefore ||
            !targetInfo.isFile() ||
            !targetPathInfo.isFile() ||
            targetPathInfo.isSymbolicLink() ||
            targetInfo.dev !== targetPathInfo.dev ||
            targetInfo.ino !== targetPathInfo.ino ||
            (targetInfo.mode & 0o077) !== 0 ||
            targetInfo.size < 2 ||
            targetInfo.size > INPUT_SIZE_LIMIT
        ) {
            throw new Error('CLI_INPUT_FILE_INVALID');
        }
        const body = await handle.readFile({ encoding: 'utf8' });
        if (Buffer.byteLength(body, 'utf8') > INPUT_SIZE_LIMIT) {
            throw new Error('CLI_INPUT_FILE_INVALID');
        }
        return JSON.parse(body) as unknown;
    } finally {
        await handle.close();
    }
}

async function writePrivateJson(
    cwd: string,
    candidate: string,
    value: unknown
): Promise<void> {
    const target = resolvePrivatePath(cwd, candidate);
    await ensurePrivateDirectory(cwd, target);
    const body = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(body, 'utf8') > OUTPUT_SIZE_LIMIT) {
        throw new Error('CLI_OUTPUT_TOO_LARGE');
    }
    const handle = await open(target, 'wx', 0o600);
    try {
        await handle.writeFile(body, 'utf8');
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

export function validateDevelopmentApiLdaregEnvironment(
    env: DevelopmentApiLdaregCliEnvironment
): {
    buildingHubServiceKey: string;
    vworldKey: string;
    vworldDomain: string;
    developmentUrl: string;
    developmentServiceRoleKey: string;
} {
    const buildingHubServiceKey = required(
        env.DATA_PORTAL_API_KEY,
        'DATA_PORTAL_API_KEY_MISSING'
    );
    const vworldKey = required(
        env.VWORLD_API_KEY,
        'VWORLD_API_KEY_MISSING'
    );
    const vworldDomain = required(
        env.VWORLD_API_DOMAIN,
        'VWORLD_API_DOMAIN_MISSING'
    );
    const developmentUrl = required(
        env.DEV_SUPABASE_URL,
        'DEV_SUPABASE_URL_MISSING'
    );
    const developmentServiceRoleKey = required(
        env.DEV_SUPABASE_SERVICE_ROLE_KEY,
        'DEV_SUPABASE_SERVICE_ROLE_KEY_MISSING'
    );
    if (
        developmentUrl !== DEVELOPMENT_SUPABASE_URL ||
        env.LAND_AREA_SYNC_ENABLED !== 'false' ||
        (env.LAND_AREA_SYNC_ALLOWED_TARGETS ?? '').trim() !== '' ||
        buildingHubServiceKey.length > 4096 ||
        vworldKey.length > 4096 ||
        vworldDomain.length > 253 ||
        !/^[A-Za-z0-9.-]+$/.test(vworldDomain) ||
        developmentServiceRoleKey.length > 8192
    ) {
        throw new Error('DEVELOPMENT_API_LDAREG_ENVIRONMENT_INVALID');
    }
    return {
        buildingHubServiceKey,
        vworldKey,
        vworldDomain,
        developmentUrl,
        developmentServiceRoleKey,
    };
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

function stringField(
    row: JsonRow,
    key: string,
    code: string
): string {
    if (typeof row[key] !== 'string') throw new Error(code);
    return row[key];
}

function integerField(
    row: JsonRow,
    key: string,
    code: string
): number {
    const value = row[key];
    if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0
    ) {
        throw new Error(code);
    }
    return value;
}

function booleanField(
    row: JsonRow,
    key: string,
    code: string
): boolean {
    if (typeof row[key] !== 'boolean') throw new Error(code);
    return row[key];
}

function digestField(
    row: JsonRow,
    key: string,
    code: string
): string {
    const value = stringField(row, key, code);
    if (!HEX64_RE.test(value)) throw new Error(code);
    return value;
}

function optionalDigestField(
    row: JsonRow,
    key: string,
    code: string
): string | null {
    return row[key] === null ? null : digestField(row, key, code);
}

function optionalUuidField(
    row: JsonRow,
    key: string,
    code: string
): string | null {
    if (row[key] === null) return null;
    const value = stringField(row, key, code).toLowerCase();
    if (!UUID_RE.test(value)) throw new Error(code);
    return value;
}

function optionalTimestampField(
    row: JsonRow,
    key: string,
    code: string
): string | null {
    if (row[key] === null) return null;
    const value = stringField(row, key, code);
    if (!Number.isFinite(Date.parse(value))) throw new Error(code);
    return new Date(value).toISOString();
}

function parseManualCounters(
    input: unknown,
    code: string
): DevelopmentApiLdaregManualDecisionCounters {
    const row = exactRecord(
        input,
        [
            'sourceReads',
            'resolverReads',
            'blockerReads',
            'fallbackReads',
            'selectionReads',
        ],
        code
    );
    for (const key of Object.keys(row)) {
        if (row[key] !== 0) throw new Error(code);
    }
    return {
        sourceReads: 0,
        resolverReads: 0,
        blockerReads: 0,
        fallbackReads: 0,
        selectionReads: 0,
    };
}

function parseInvariantDigests(
    input: unknown,
    code: string
): DevelopmentApiLdaregInvariantDigests {
    const keys = [
        'nonTargetPropertyUnits',
        'propertyOwnerships',
        'buildings',
        'buildingUnits',
        'buildingLandLots',
        'buildingExternalRefs',
        'landLots',
        'nonTargetPropertyUnitLandRights',
    ] as const;
    const row = exactRecord(input, keys, code);
    return Object.fromEntries(
        keys.map((key) => [key, digestField(row, key, code)])
    ) as unknown as DevelopmentApiLdaregInvariantDigests;
}

function parseInspectorTarget(
    input: unknown,
    code: string
): DevelopmentApiLdaregInspectorTarget {
    const row = exactRecord(
        input,
        [
            'propertyUnitId',
            'matchedBuildingUnitId',
            'pnu',
            'normalizedDong',
            'normalizedHo',
        ],
        code
    );
    const propertyUnitId = stringField(
        row,
        'propertyUnitId',
        code
    ).toLowerCase();
    const matchedBuildingUnitId = stringField(
        row,
        'matchedBuildingUnitId',
        code
    ).toLowerCase();
    const pnu = stringField(row, 'pnu', code);
    const normalizedDong = stringField(
        row,
        'normalizedDong',
        code
    );
    const normalizedHo = stringField(
        row,
        'normalizedHo',
        code
    );
    if (
        !UUID_RE.test(propertyUnitId) ||
        !UUID_RE.test(matchedBuildingUnitId) ||
        !PNU_RE.test(pnu) ||
        normalizedDong.length > 100 ||
        normalizedHo.length === 0 ||
        normalizedHo.length > 100
    ) {
        throw new Error(code);
    }
    return {
        propertyUnitId,
        matchedBuildingUnitId,
        pnu,
        normalizedDong,
        normalizedHo,
    };
}

function parseProposalArea(
    input: unknown,
    code: string
): DevelopmentApiLdaregProposalArea {
    const row = exactRecord(
        input,
        [
            'propertyUnitId',
            'matchedBuildingUnitId',
            'landArea',
            'itemDigest',
        ],
        code
    );
    const propertyUnitId = stringField(
        row,
        'propertyUnitId',
        code
    ).toLowerCase();
    const matchedBuildingUnitId = stringField(
        row,
        'matchedBuildingUnitId',
        code
    ).toLowerCase();
    const landArea = stringField(row, 'landArea', code);
    if (
        !UUID_RE.test(propertyUnitId) ||
        !UUID_RE.test(matchedBuildingUnitId) ||
        !SAFE_DECIMAL_RE.test(landArea) ||
        Number(landArea) <= 0
    ) {
        throw new Error(code);
    }
    return {
        propertyUnitId,
        matchedBuildingUnitId,
        landArea,
        itemDigest: digestField(row, 'itemDigest', code),
    };
}

function parseSnapshot(
    input: unknown
): DevelopmentApiLdaregSnapshot {
    const code = 'DEVELOPMENT_API_LDAREG_INSPECTOR_INVALID';
    const row = exactRecord(
        input,
        [
            'contractVersion',
            'databaseTarget',
            'unionId',
            'basePnu',
            'mgmBldrgstPk',
            'canonicalBuildingId',
            'scope',
            'propertyTargets',
            'proposal',
            'currentState',
            'relationPrerequisite',
            'canonicalInvariantDigests',
            'approval',
            'replay',
            'manualDecisionCounters',
        ],
        code
    );
    const unionId = stringField(row, 'unionId', code).toLowerCase();
    const canonicalBuildingId = stringField(
        row,
        'canonicalBuildingId',
        code
    ).toLowerCase();
    if (
        row.contractVersion !==
            DEVELOPMENT_API_LDAREG_INSPECTOR_CONTRACT ||
        row.databaseTarget !== 'development' ||
        !UUID_RE.test(unionId) ||
        !PNU_RE.test(stringField(row, 'basePnu', code)) ||
        !/^\d{10,30}$/.test(
            stringField(row, 'mgmBldrgstPk', code)
        ) ||
        !UUID_RE.test(canonicalBuildingId)
    ) {
        throw new Error(code);
    }
    const scope = exactRecord(
        row.scope,
        ['pnus', 'count', 'digest'],
        code
    );
    if (
        !Array.isArray(scope.pnus) ||
        !scope.pnus.every(
            (pnu) => typeof pnu === 'string' && PNU_RE.test(pnu)
        )
    ) {
        throw new Error(code);
    }
    const propertyTargets = exactRecord(
        row.propertyTargets,
        ['ids', 'count', 'digest', 'targets'],
        code
    );
    if (
        !Array.isArray(propertyTargets.ids) ||
        !propertyTargets.ids.every(
            (id) => typeof id === 'string' && UUID_RE.test(id)
        ) ||
        !Array.isArray(propertyTargets.targets)
    ) {
        throw new Error(code);
    }
    let proposal: DevelopmentApiLdaregSnapshot['proposal'] = null;
    if (row.proposal !== null) {
        const value = exactRecord(
            row.proposal,
            [
                'digest',
                'itemCount',
                'componentCount',
                'source',
                'allCurrentPositive',
                'proposedAreas',
            ],
            code
        );
        if (
            value.source !== 'LDAREG' ||
            value.allCurrentPositive !== true ||
            !Array.isArray(value.proposedAreas)
        ) {
            throw new Error(code);
        }
        proposal = {
            digest: digestField(value, 'digest', code),
            itemCount: integerField(value, 'itemCount', code),
            componentCount: integerField(
                value,
                'componentCount',
                code
            ),
            source: 'LDAREG',
            allCurrentPositive: true,
            proposedAreas: value.proposedAreas.map((area) =>
                parseProposalArea(area, code)
            ),
        };
    }
    const currentState = exactRecord(
        row.currentState,
        ['prestateTupleDigest', 'targetRightsDigest'],
        code
    );
    const relation = exactRecord(
        row.relationPrerequisite,
        ['required', 'count', 'linkedCount', 'satisfied'],
        code
    );
    const approval = exactRecord(
        row.approval,
        [
            'rowCount',
            'enabled',
            'consumedAt',
            'consumedSyncJobId',
            'targetDigest',
            'expiresAt',
        ],
        code
    );
    const replay = exactRecord(
        row.replay,
        ['syncJobId', 'eligible', 'receiptDigest'],
        code
    );
    return {
        contractVersion: DEVELOPMENT_API_LDAREG_INSPECTOR_CONTRACT,
        databaseTarget: 'development',
        unionId,
        basePnu: stringField(row, 'basePnu', code),
        managementPk: stringField(row, 'mgmBldrgstPk', code),
        canonicalBuildingId,
        scope: {
            pnus: [...scope.pnus] as string[],
            count: integerField(scope, 'count', code),
            digest: digestField(scope, 'digest', code),
        },
        propertyTargets: {
            ids: (propertyTargets.ids as string[]).map((id) =>
                id.toLowerCase()
            ),
            count: integerField(propertyTargets, 'count', code),
            digest: digestField(propertyTargets, 'digest', code),
            targets: propertyTargets.targets.map((target) =>
                parseInspectorTarget(target, code)
            ),
        },
        proposal,
        currentState: {
            prestateTupleDigest: digestField(
                currentState,
                'prestateTupleDigest',
                code
            ),
            targetRightsDigest: digestField(
                currentState,
                'targetRightsDigest',
                code
            ),
        },
        relationPrerequisite: {
            required: booleanField(relation, 'required', code),
            count: integerField(relation, 'count', code),
            linkedCount: integerField(
                relation,
                'linkedCount',
                code
            ),
            satisfied: booleanField(
                relation,
                'satisfied',
                code
            ),
        },
        canonicalInvariantDigests: parseInvariantDigests(
            row.canonicalInvariantDigests,
            code
        ),
        approval: {
            rowCount: integerField(approval, 'rowCount', code),
            enabled: booleanField(approval, 'enabled', code),
            consumedAt: optionalTimestampField(
                approval,
                'consumedAt',
                code
            ),
            consumedSyncJobId: optionalUuidField(
                approval,
                'consumedSyncJobId',
                code
            ),
            targetDigest: optionalDigestField(
                approval,
                'targetDigest',
                code
            ),
            expiresAt: optionalTimestampField(
                approval,
                'expiresAt',
                code
            ),
        },
        replay: {
            syncJobId: optionalUuidField(
                replay,
                'syncJobId',
                code
            ),
            eligible: booleanField(replay, 'eligible', code),
            receiptDigest: optionalDigestField(
                replay,
                'receiptDigest',
                code
            ),
        },
        manualDecisionCounters: parseManualCounters(
            row.manualDecisionCounters,
            code
        ),
    };
}

function parseApplyReceipt(
    input: unknown
): DevelopmentApiLdaregApplyReceipt {
    const code = 'DEVELOPMENT_API_LDAREG_APPLY_RECEIPT_INVALID';
    const row = exactRecord(
        input,
        [
            'status',
            'syncJobId',
            'targetDigest',
            'scopeDigest',
            'propertyUnitDigest',
            'proposedValuesDigest',
            'prestateTupleDigest',
            'prestateTargetRightsDigest',
            'poststateTupleDigest',
            'poststateTargetRightsDigest',
            'rightsRowCount',
            'updatedPropertyUnitCount',
            'source',
            'manualDecisionCounters',
            'invariantDigests',
            'replay',
        ],
        code
    );
    if (
        (row.status !== 'APPLIED' && row.status !== 'REUSED') ||
        row.source !== 'LDAREG'
    ) {
        throw new Error(code);
    }
    const invariantDigests = exactRecord(
        row.invariantDigests,
        ['before', 'after', 'stable'],
        code
    );
    const replay = exactRecord(
        row.replay,
        ['eligible', 'recovered', 'receiptDigest'],
        code
    );
    if (
        invariantDigests.stable !== true ||
        replay.eligible !== true ||
        typeof replay.recovered !== 'boolean'
    ) {
        throw new Error(code);
    }
    const syncJobId = stringField(row, 'syncJobId', code).toLowerCase();
    if (!UUID_RE.test(syncJobId)) throw new Error(code);
    return {
        status: row.status,
        syncJobId,
        targetDigest: digestField(row, 'targetDigest', code),
        scopeDigest: digestField(row, 'scopeDigest', code),
        propertyUnitDigest: digestField(
            row,
            'propertyUnitDigest',
            code
        ),
        proposedValuesDigest: digestField(
            row,
            'proposedValuesDigest',
            code
        ),
        prestateTupleDigest: digestField(
            row,
            'prestateTupleDigest',
            code
        ),
        prestateTargetRightsDigest: digestField(
            row,
            'prestateTargetRightsDigest',
            code
        ),
        poststateTupleDigest: digestField(
            row,
            'poststateTupleDigest',
            code
        ),
        poststateTargetRightsDigest: digestField(
            row,
            'poststateTargetRightsDigest',
            code
        ),
        rightsRowCount: integerField(
            row,
            'rightsRowCount',
            code
        ),
        updatedPropertyUnitCount: integerField(
            row,
            'updatedPropertyUnitCount',
            code
        ),
        source: 'LDAREG',
        manualDecisionCounters: parseManualCounters(
            row.manualDecisionCounters,
            code
        ),
        invariantDigests: {
            before: parseInvariantDigests(
                invariantDigests.before,
                code
            ),
            after: parseInvariantDigests(
                invariantDigests.after,
                code
            ),
            stable: true,
        },
        replay: {
            eligible: true,
            recovered: replay.recovered,
            receiptDigest: digestField(
                replay,
                'receiptDigest',
                code
            ),
        },
    };
}

export class SupabaseDevelopmentApiLdaregDatabase
    implements DevelopmentApiLdaregDatabase
{
    constructor(private readonly client: SupabaseClient) {}

    async inspect(input: {
        target: DevelopmentApiLdaregTarget;
        items: DevelopmentApiLdaregApprovalItem[] | null;
        syncJobId: string | null;
    }): Promise<DevelopmentApiLdaregSnapshot> {
        const { target } = input;
        const { data, error } = await this.client.rpc(
            'inspect_development_api_authoritative_ldareg_backfill_v1',
            {
                p_union_id: target.unionId,
                p_base_pnu: target.basePnu,
                p_mgm_bldrgst_pk: target.managementPk,
                p_scope_pnus: target.scopePnus,
                p_property_unit_ids: target.propertyTargets.map(
                    (property) => property.propertyUnitId
                ),
                p_items: input.items,
                p_sync_job_id: input.syncJobId,
            }
        );
        if (error) {
            throw new Error(
                'DEVELOPMENT_API_LDAREG_INSPECTOR_RPC_FAILED'
            );
        }
        return parseSnapshot(data);
    }

    async apply(input: {
        target: DevelopmentApiLdaregTarget;
        items: DevelopmentApiLdaregApprovalItem[];
        expectedScopeDigest: string;
        expectedPropertyUnitDigest: string;
        expectedProposedValuesDigest: string;
        expectedPrestateTupleDigest: string;
        expectedPrestateTargetRightsDigest: string;
        evidenceDigest: string;
        sourceReleaseSha: string;
        targetDigest: string;
        syncJobId: string;
    }): Promise<DevelopmentApiLdaregApplyReceipt> {
        const { target } = input;
        const { data, error } = await this.client.rpc(
            'apply_development_api_authoritative_ldareg_backfill_v1',
            {
                p_union_id: target.unionId,
                p_base_pnu: target.basePnu,
                p_mgm_bldrgst_pk: target.managementPk,
                p_scope_pnus: target.scopePnus,
                p_property_unit_ids: target.propertyTargets.map(
                    (property) => property.propertyUnitId
                ),
                p_items: input.items,
                p_expected_scope_digest:
                    input.expectedScopeDigest,
                p_expected_property_unit_digest:
                    input.expectedPropertyUnitDigest,
                p_expected_proposed_values_digest:
                    input.expectedProposedValuesDigest,
                p_expected_prestate_tuple_digest:
                    input.expectedPrestateTupleDigest,
                p_expected_prestate_rights_digest:
                    input.expectedPrestateTargetRightsDigest,
                p_target_manifest_digest:
                    target.manifestDigest,
                p_phase0_run_id: Number(target.phase0.runId),
                p_phase0_artifact_version:
                    target.phase0.artifactVersion,
                p_phase0_artifact_sha256:
                    target.phase0.artifactSha256,
                p_phase0_schema_hash: target.phase0.schemaHash,
                p_evidence_digest: input.evidenceDigest,
                p_source_release_sha: input.sourceReleaseSha,
                p_target_digest: input.targetDigest,
                p_sync_job_id: input.syncJobId,
            }
        );
        if (error) {
            throw new Error(
                'DEVELOPMENT_API_LDAREG_APPLY_RPC_FAILED'
            );
        }
        return parseApplyReceipt(data);
    }
}

export async function runDevelopmentApiLdaregCli(
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
        const resolvedTargetPath = resolvePrivatePath(
            cwd,
            args.targetPath
        );
        const resolvedOutputPath = resolvePrivatePath(
            cwd,
            args.outputPath
        );
        const resolvedApprovalRequestOutputPath =
            resolvePrivatePath(
                cwd,
                args.approvalRequestOutputPath
            );
        if (
            new Set([
                resolvedTargetPath,
                resolvedOutputPath,
                resolvedApprovalRequestOutputPath,
            ]).size !== 3
        ) {
            throw new Error('CLI_PATH_COLLISION');
        }
        const environment =
            validateDevelopmentApiLdaregEnvironment(env);
        const target = parseDevelopmentApiLdaregTarget(
            await readPrivateJson(cwd, args.targetPath)
        );
        const client = createClient(
            environment.developmentUrl,
            environment.developmentServiceRoleKey,
            {
                auth: {
                    persistSession: false,
                    autoRefreshToken: false,
                    detectSessionInUrl: false,
                },
            }
        );
        const database =
            dependencies.database ??
            new SupabaseDevelopmentApiLdaregDatabase(client);
        const adapter =
            dependencies.adapter ?? new LandAreaSyncAdapter();
        if (args.mode === 'prepare') {
            const result =
                await prepareDevelopmentApiLdaregBackfill({
                    target,
                    sourceReleaseSha: args.sourceReleaseSha,
                    buildingHubServiceKey:
                        environment.buildingHubServiceKey,
                    vworldKey: environment.vworldKey,
                    vworldDomain: environment.vworldDomain,
                    adapter,
                    database,
                });
            validateDevelopmentApiLdaregPrepareArtifact({
                target,
                expectedSourceReleaseSha:
                    args.sourceReleaseSha,
                artifact: result.artifact,
            });
            await writePrivateJson(
                cwd,
                args.outputPath,
                result.artifact
            );
            if (result.artifact.gate.status === 'PASS') {
                if (result.approvalRequest === null) {
                    throw new Error(
                        'CLI_APPROVAL_REQUEST_MISSING'
                    );
                }
                validateDevelopmentApiLdaregApprovalRequest({
                    target,
                    expectedSourceReleaseSha:
                        args.sourceReleaseSha,
                    request: result.approvalRequest,
                });
                await writePrivateJson(
                    cwd,
                    args.approvalRequestOutputPath,
                    result.approvalRequest
                );
            }
            stdout(
                result.artifact.gate.status === 'PASS'
                    ? 'Development API-authoritative LDAREG prepare PASS (private artifacts written).'
                    : 'Development API-authoritative LDAREG prepare FAIL (private redacted artifact written).'
            );
            return result.artifact.gate.status === 'PASS'
                ? 0
                : 1;
        }
        const artifact = await runDevelopmentApiLdaregBackfill({
            target,
            sourceReleaseSha: args.sourceReleaseSha,
            buildingHubServiceKey:
                environment.buildingHubServiceKey,
            vworldKey: environment.vworldKey,
            vworldDomain: environment.vworldDomain,
            adapter,
            database,
        });
        validateDevelopmentApiLdaregArtifact({
            target,
            expectedSourceReleaseSha: args.sourceReleaseSha,
            artifact,
        });
        await writePrivateJson(cwd, args.outputPath, artifact);
        stdout(
            artifact.gate.status === 'PASS'
                ? 'Development API-authoritative LDAREG apply PASS (private redacted artifact written).'
                : 'Development API-authoritative LDAREG apply FAIL (private redacted artifact written).'
        );
        return artifact.gate.status === 'PASS' ? 0 : 1;
    } catch {
        stderr(
            'Development API-authoritative LDAREG backfill rejected (input, environment, or file boundary).'
        );
        return 2;
    }
}

export async function mainDevelopmentApiLdaregCli(): Promise<void> {
    process.exitCode = await runDevelopmentApiLdaregCli(
        process.argv.slice(2)
    );
}

if (require.main === module) {
    void mainDevelopmentApiLdaregCli();
}
