import {
    chmod,
    lstat,
    mkdir,
    open,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env';
import { getSupabaseService } from '../services/supabase.service';
import {
    LandAreaSyncAdapter,
    buildingHubAuthFromEnv,
    vworldAuthFromEnv,
} from '../services/land-area-sync/adapter';
import {
    readBuildingUnitCandidates,
    readCurrentLandTuples,
    readPropertyUnitCandidates,
} from '../services/land-area-sync/readers';
import {
    parseDevelopmentEvidenceManifest,
    parseDevelopmentTargetManifest,
} from '../operations/development-land-area-sync-runner';
import {
    captureDevelopmentLandAreaEvidence,
    type DevelopmentEvidenceCaptureAudit,
} from '../operations/development-land-area-evidence-capture';

const PRIVATE_DIRECTORY =
    '.development-land-area-evidence-capture';
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const RUN_ID_RE = /^[1-9][0-9]*$/;
const FILE_RE =
    /^[a-z][a-z0-9-]*-[1-9][0-9]*-[1-9][0-9]*\.json$/;

interface ParsedArgs {
    target: string;
    captureRunId: string;
    evidenceOut: string;
    auditOut: string;
}

function parseArgs(args: string[]): ParsedArgs {
    if (args.length !== 8) {
        throw new Error('CAPTURE_ARGUMENTS_INVALID');
    }
    const values = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index];
        const value = args[index + 1];
        if (
            ![
                '--target',
                '--capture-run-id',
                '--evidence-out',
                '--audit-out',
            ].includes(key) ||
            !value ||
            value.startsWith('--') ||
            values.has(key)
        ) {
            throw new Error('CAPTURE_ARGUMENTS_INVALID');
        }
        values.set(key, value);
    }
    const target = values.get('--target');
    const captureRunId = values.get('--capture-run-id');
    const evidenceOut = values.get('--evidence-out');
    const auditOut = values.get('--audit-out');
    if (
        !target ||
        !captureRunId ||
        !evidenceOut ||
        !auditOut ||
        !RUN_ID_RE.test(captureRunId)
    ) {
        throw new Error('CAPTURE_ARGUMENTS_INVALID');
    }
    return { target, captureRunId, evidenceOut, auditOut };
}

function resolvePrivateFile(cwd: string, candidate: string): string {
    const root = path.resolve(cwd, PRIVATE_DIRECTORY);
    const resolved = path.resolve(cwd, candidate);
    if (
        path.dirname(resolved) !== root ||
        !FILE_RE.test(path.basename(resolved))
    ) {
        throw new Error('CAPTURE_PATH_INVALID');
    }
    return resolved;
}

async function ensurePrivateRoot(cwd: string): Promise<string> {
    const root = path.resolve(cwd, PRIVATE_DIRECTORY);
    try {
        const info = await lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error('CAPTURE_DIRECTORY_INVALID');
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
        await mkdir(root, { mode: 0o700 });
    }
    await chmod(root, 0o700);
    return root;
}

async function readPrivateJson(
    cwd: string,
    candidate: string
): Promise<unknown> {
    const resolved = resolvePrivateFile(cwd, candidate);
    const root = await ensurePrivateRoot(cwd);
    const rootInfo = await lstat(root);
    const info = await lstat(resolved);
    if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (rootInfo.mode & 0o077) !== 0 ||
        (info.mode & 0o077) !== 0 ||
        info.size < 2 ||
        info.size > MAX_INPUT_BYTES
    ) {
        throw new Error('CAPTURE_INPUT_FILE_INVALID');
    }
    return JSON.parse(await readFile(resolved, 'utf8')) as unknown;
}

async function writePrivateJson(
    cwd: string,
    candidate: string,
    value: unknown
): Promise<void> {
    const resolved = resolvePrivateFile(cwd, candidate);
    await ensurePrivateRoot(cwd);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (
        Buffer.byteLength(text, 'utf8') < 2 ||
        Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES
    ) {
        throw new Error('CAPTURE_OUTPUT_SIZE_INVALID');
    }
    const handle = await open(resolved, 'wx', 0o600);
    try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
        await handle.chmod(0o600);
    } finally {
        await handle.close();
    }
}

function assertDevelopmentReadOnlyEnvironment(): void {
    const developmentUrl = env.DEV_SUPABASE_URL?.trim();
    const developmentKey =
        env.DEV_SUPABASE_SERVICE_ROLE_KEY?.trim();
    const productionUrl = env.SUPABASE_URL?.trim();
    const productionKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (
        !developmentUrl ||
        !developmentKey ||
        !productionUrl ||
        !productionKey ||
        developmentUrl.replace(/\/+$/, '').toLowerCase() ===
            productionUrl.replace(/\/+$/, '').toLowerCase() ||
        developmentKey === productionKey ||
        env.LAND_AREA_SYNC_ENABLED
    ) {
        throw new Error(
            'CAPTURE_DEVELOPMENT_READ_ONLY_ENVIRONMENT_INVALID'
        );
    }
}

function failureAudit(
    captureRunId: string
): DevelopmentEvidenceCaptureAudit {
    return {
        version: 'land-area-development-evidence-capture-audit@1',
        databaseTarget: 'development',
        unionId: '00000000-0000-0000-0000-000000000000',
        targetCount: 0,
        expectedPropertyUnitCount: 0,
        manifestDigest: '0'.repeat(64),
        captureRunId,
        capturedAt: new Date().toISOString(),
        readOnlyGuards: {
            durableSyncJobWrites: 0,
            propertyUnitWriteRpcCalls: 0,
            interceptedApplyRpcCalls: 0,
            interceptedSnapshotWrites: 0,
            interceptedTerminalWrites: 0,
            interceptedFailureWrites: 0,
        },
        entries: [],
        evidenceManifestSha256: null,
        gate: {
            status: 'FAIL',
            failureCodes: ['CAPTURE_SETUP_REJECTED'],
        },
    };
}

export async function runDevelopmentLandAreaEvidenceCaptureCli(
    args: string[],
    cwd: string = process.cwd()
): Promise<number> {
    let parsed: ParsedArgs | null = null;
    try {
        parsed = parseArgs(args);
        assertDevelopmentReadOnlyEnvironment();
        const target = parseDevelopmentTargetManifest(
            await readPrivateJson(cwd, parsed.target)
        );
        const database = getSupabaseService('development');
        const client = database.getClient();
        const adapter = new LandAreaSyncAdapter();
        const hubAuth = buildingHubAuthFromEnv();
        const vworldAuth = vworldAuthFromEnv();
        let lastReported = 0;

        const result =
            await captureDevelopmentLandAreaEvidence({
                target,
                captureRunId: parsed.captureRunId,
                concurrency: 2,
                deps: {
                    now: () => new Date(),
                    scans: {
                        scanTitle: (pnu, signal) =>
                            adapter.scanTitle(pnu, hubAuth, {
                                signal,
                            }),
                        scanAttached: (pnu, signal) =>
                            adapter.scanAttached(pnu, hubAuth, {
                                signal,
                            }),
                        scanBasis: (pnu, signal) =>
                            adapter.scanBasis(pnu, hubAuth, {
                                signal,
                            }),
                        scanExpos: (pnu, signal) =>
                            adapter.scanExpos(pnu, hubAuth, {
                                signal,
                            }),
                        scanLadfrl: (pnu, signal) =>
                            adapter.scanLadfrl(pnu, vworldAuth, {
                                signal,
                            }),
                        scanLdareg: (pnu, signal) =>
                            adapter.scanLdareg(pnu, vworldAuth, {
                                signal,
                            }),
                    },
                    resolveScope: (params) =>
                        database.resolveLandAreaSyncScope(params),
                    readBuildingUnits: (unionId, pnus) =>
                        readBuildingUnitCandidates(
                            client,
                            unionId,
                            pnus
                        ),
                    readPropertyUnits: (unionId, pnus) =>
                        readPropertyUnitCandidates(
                            client,
                            unionId,
                            pnus
                        ),
                    readCurrentLandTuples: (unionId, ids) =>
                        readCurrentLandTuples(
                            client,
                            unionId,
                            ids
                        ),
                },
                onProgress(completed, total) {
                    if (
                        completed === total ||
                        completed - lastReported >= 10
                    ) {
                        lastReported = completed;
                        process.stdout.write(
                            `Read-only evidence progress ${completed}/${total}\n`
                        );
                    }
                },
            });

        await writePrivateJson(
            cwd,
            parsed.auditOut,
            result.audit
        );
        if (!result.evidence) {
            process.stdout.write(
                `Development evidence capture FAIL (captured=${result.audit.entries.filter((entry) => entry.status === 'CAPTURED').length}/${target.targetCount})\n`
            );
            return 1;
        }
        parseDevelopmentEvidenceManifest(result.evidence);
        await writePrivateJson(
            cwd,
            parsed.evidenceOut,
            result.evidence
        );
        process.stdout.write(
            `Development evidence capture PASS (targets=${target.targetCount}, propertyUnits=${target.expectedPropertyUnitCount})\n`
        );
        return 0;
    } catch {
        if (parsed) {
            try {
                await writePrivateJson(
                    cwd,
                    parsed.auditOut,
                    failureAudit(parsed.captureRunId)
                );
            } catch {
                // 아래의 고정 오류와 exit code만 외부에 노출한다.
            }
        }
        process.stderr.write(
            'Development evidence capture rejected.\n'
        );
        return 2;
    }
}

export async function mainDevelopmentLandAreaEvidenceCaptureCli(): Promise<void> {
    process.exitCode =
        await runDevelopmentLandAreaEvidenceCaptureCli(
            process.argv.slice(2)
        );
}

if (require.main === module) {
    void mainDevelopmentLandAreaEvidenceCaptureCli();
}
