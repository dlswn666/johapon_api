import path from 'node:path';
import {
    buildDevelopmentApiLdaregTargetBundle,
    parseDevelopmentApiLdaregCaptureIndex,
    type DevelopmentApiLdaregResolvedCapture,
} from '../operations/development-api-authoritative-ldareg-target-bundle';
import type { DevelopmentApiLdaregTargetPins } from '../operations/development-api-authoritative-ldareg-backfill';
import {
    expectedLandAreaPhase0Family,
    parseLandAreaPhase0Manifest,
} from '../verification/land-area-phase0-capture';
import { validateLandAreaPhase0CaptureArtifact } from '../verification/land-area-phase0-artifact-validator';
import {
    readPinnedPrivateJson,
    writeExclusivePrivateFile,
} from './development-api-authoritative-ldareg-private-files';
import { createHash } from 'node:crypto';

const MAX_JSON_BYTES = 3 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
export const DEVELOPMENT_API_LDAREG_BUNDLE_BUILD_SENTINEL =
    'DEVELOPMENT_API_AUTHORITATIVE_LDAREG_PRIVATE_TARGET_BUNDLE_BUILT';

const SAFE_BUNDLE_BUILD_REJECTION_CODES = new Set<string>([
    'BUNDLE_BUILD_ARGUMENT_INVALID',
    'CAPTURE_FILE_DIGEST_MISMATCH',
    'CAPTURE_INDEX_INVALID',
    'CAPTURE_BINDING_SAMPLE_INVALID',
    'CAPTURE_TARGET_MISSING',
    'CAPTURE_TARGET_SET_INVALID',
    'DB_GROUP_INVALID',
    'DB_GROUP_MEMBERSHIP_INVALID',
    'DB_LAND_PARCEL_INVALID',
    'DB_SNAPSHOT_FORBIDDEN_DECISION_FIELD',
    'DB_SNAPSHOT_INVALID',
    'DB_SNAPSHOT_KEY_SET_INVALID',
    'DB_UNIT_FLOOR_PREIMAGE_AMBIGUOUS',
    'DB_UNIT_INVALID',
    'DB_UNIT_RAW_FLOOR_MISMATCH',
    'LEGACY_TARGET_07_PIN_MISMATCH',
    'LEGACY_TARGET_07_CANONICAL_DONG_UPGRADE_REQUIRED',
    'LEGACY_TARGET_DIGEST_MISMATCH',
    'LEGACY_TARGET_INVALID',
    'OFFICIAL_CORRELATION_INCOMPLETE',
    'OFFICIAL_DB_PARTITION_INVALID',
    'OFFICIAL_DB_UNIT_JOIN_INVALID',
    ...[
        'OFFICIAL_DB_UNIT_ACTIVE_AMBIGUOUS',
        'OFFICIAL_DB_DONG_CANDIDATE_BOUND_INVALID',
        'OFFICIAL_DB_DONG_WITNESS_AMBIGUOUS',
        'OFFICIAL_DB_DONG_WITNESS_MISSING',
        'OFFICIAL_DB_FLOOR_HO_AMBIGUOUS',
        'OFFICIAL_DB_UNIT_INACTIVE_AMBIGUOUS',
        'OFFICIAL_DB_UNIT_MISSING',
        'OFFICIAL_PROVIDER_BRIDGE_INVALID',
    ].flatMap((code) =>
        Array.from(
            { length: 7 },
            (_, index) =>
                `${code}_TARGET_${String(index + 1).padStart(
                    2,
                    '0'
                )}`
        )
    ),
    'OFFICIAL_DENOMINATOR_DB_MISMATCH',
    'OFFICIAL_EXACT_MATCH_AMBIGUOUS',
    'OFFICIAL_EXPOS_HASH_INVALID',
    'OFFICIAL_LDAREG_RATIO_INVALID',
    'OFFICIAL_LDAREG_ROW_INVALID',
    'OFFICIAL_LDAREG_SET_INVALID',
    'OFFICIAL_PROVIDER_BRIDGE_INVALID',
    'OFFICIAL_SCOPE_EXPOS_INVALID',
    'PHASE0_ATTACHED_INVALID',
    'PHASE0_CAPTURE_INVALID',
    'PHASE0_ENDPOINT_INVALID',
    'PHASE0_INVENTORY_INVALID',
    'PHASE0_LADFRL_DB_MISMATCH',
    'PHASE0_MANAGEMENT_PK_MISMATCH',
    'PHASE0_REPLICATION_INVALID',
    'PHASE0_SAMPLE_TARGET_MISMATCH',
    'PRIVATE_INPUT_CHANGED',
    'PRIVATE_INPUT_INVALID',
    'PRIVATE_OUTPUT_CHANGED',
    'PRIVATE_OUTPUT_INVALID',
    'PRIVATE_OUTPUT_SIZE_INVALID',
    'PRIVATE_PATH_INVALID',
    'PRIVATE_ROOT_CHANGED',
    'PRIVATE_ROOT_INVALID',
    'PRIVATE_SIZE_LIMIT_INVALID',
    'PRIVATE_UID_UNAVAILABLE',
    'TARGET_07_MISSING',
    'TARGET_07_PIN_MISMATCH',
    'TARGET_BUNDLE_INVALID',
    'TARGET_BUNDLE_KEY_INVALID',
    'TARGET_BUNDLE_PIN_MISMATCH',
    'TARGET_DATABASE_DIGESTS_INVALID',
    'TARGET_DENOMINATOR_INVALID',
    'TARGET_IGNORED_OFFICIAL_UNIT_INVALID',
    'TARGET_LAND_PARCEL_INVALID',
    'TARGET_MANIFEST_DIGEST_MISMATCH',
    'TARGET_MANIFEST_INVALID',
    'TARGET_OFFICIAL_HASHES_INVALID',
    'TARGET_OFFICIAL_HASHES_SCOPE_MISMATCH',
    'TARGET_PHASE0_INVALID',
    'TARGET_PROPERTY_INVALID',
]);

type BundleBuildRejectionStage =
    | 'BUNDLE_BUILD_ARGUMENT_REJECTED'
    | 'BUNDLE_BUILD_PRIVATE_INPUT_REJECTED'
    | 'BUNDLE_BUILD_CAPTURE_INDEX_REJECTED'
    | 'BUNDLE_BUILD_CAPTURE_FILE_REJECTED'
    | 'BUNDLE_BUILD_MANIFEST_REJECTED'
    | 'BUNDLE_BUILD_ARTIFACT_REJECTED'
    | 'BUNDLE_BUILD_BINDING_REJECTED'
    | 'BUNDLE_BUILD_TARGET_REJECTED'
    | 'BUNDLE_BUILD_OUTPUT_REJECTED';

function safeBundleBuildRejectionCode(
    error: unknown,
    stage: BundleBuildRejectionStage
): string {
    return error instanceof Error &&
        SAFE_BUNDLE_BUILD_REJECTION_CODES.has(error.message)
        ? error.message
        : stage;
}

interface Arguments {
    privateRoot: string;
    dbSnapshotFile: string;
    captureIndexFile: string;
    outputFile: string;
    legacyTarget07File?: string;
}

interface Dependencies {
    stdout?: (message: string) => void;
    stderr?: (message: string) => void;
    pins?: DevelopmentApiLdaregTargetPins;
}

function parseArguments(argv: string[]): Arguments {
    if (argv.length !== 8 && argv.length !== 10) {
        throw new Error('BUNDLE_BUILD_ARGUMENT_INVALID');
    }
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (
            !flag ||
            !value ||
            ![
                '--private-root',
                '--db-snapshot',
                '--capture-index',
                '--out',
                '--legacy-target-07',
            ].includes(flag) ||
            values.has(flag)
        ) {
            throw new Error('BUNDLE_BUILD_ARGUMENT_INVALID');
        }
        values.set(flag, value);
    }
    const privateRoot = values.get('--private-root');
    const dbSnapshotFile = values.get('--db-snapshot');
    const captureIndexFile = values.get('--capture-index');
    const outputFile = values.get('--out');
    const legacyTarget07File = values.get('--legacy-target-07');
    if (
        !privateRoot ||
        !dbSnapshotFile ||
        !captureIndexFile ||
        !outputFile ||
        new Set(
            [
                dbSnapshotFile,
                captureIndexFile,
                outputFile,
                legacyTarget07File,
            ].filter((value): value is string => value !== undefined)
        ).size !==
            (legacyTarget07File === undefined ? 3 : 4)
    ) {
        throw new Error('BUNDLE_BUILD_ARGUMENT_INVALID');
    }
    return {
        privateRoot: path.resolve(privateRoot),
        dbSnapshotFile,
        captureIndexFile,
        outputFile,
        ...(legacyTarget07File
            ? { legacyTarget07File }
            : {}),
    };
}

function identityHash(kind: string, value: string): string {
    return createHash('sha256')
        .update(`${kind}\u0000${value}`, 'utf8')
        .digest('hex');
}

export async function runDevelopmentApiLdaregTargetBundleBuilder(
    argv: string[],
    dependencies: Dependencies = {}
): Promise<number> {
    const stdout =
        dependencies.stdout ??
        ((message: string) => process.stdout.write(`${message}\n`));
    const stderr =
        dependencies.stderr ??
        ((message: string) => process.stderr.write(`${message}\n`));
    let rejectionStage: BundleBuildRejectionStage =
        'BUNDLE_BUILD_ARGUMENT_REJECTED';
    try {
        const args = parseArguments(argv);
        rejectionStage = 'BUNDLE_BUILD_PRIVATE_INPUT_REJECTED';
        const [snapshotRead, indexRead, legacyRead] =
            await Promise.all([
                readPinnedPrivateJson({
                    privateRoot: args.privateRoot,
                    filename: args.dbSnapshotFile,
                    maxBytes: MAX_JSON_BYTES,
                }),
                readPinnedPrivateJson({
                    privateRoot: args.privateRoot,
                    filename: args.captureIndexFile,
                    maxBytes: MAX_JSON_BYTES,
                }),
                args.legacyTarget07File
                    ? readPinnedPrivateJson({
                          privateRoot: args.privateRoot,
                          filename: args.legacyTarget07File,
                          maxBytes: MAX_JSON_BYTES,
                      })
                    : Promise.resolve(undefined),
            ]);
        rejectionStage = 'BUNDLE_BUILD_CAPTURE_INDEX_REJECTED';
        const index = parseDevelopmentApiLdaregCaptureIndex(
            indexRead.value
        );
        const validatedArtifacts = new Map<
            string,
            ReturnType<
                typeof validateLandAreaPhase0CaptureArtifact
            >
        >();
        const manifests = new Map<
            string,
            ReturnType<typeof parseLandAreaPhase0Manifest>
        >();
        for (const descriptor of index.artifacts) {
            rejectionStage = 'BUNDLE_BUILD_CAPTURE_FILE_REJECTED';
            const [artifactRead, manifestRead] = await Promise.all([
                readPinnedPrivateJson({
                    privateRoot: args.privateRoot,
                    filename: descriptor.artifactFile,
                    maxBytes: MAX_JSON_BYTES,
                }),
                readPinnedPrivateJson({
                    privateRoot: args.privateRoot,
                    filename: descriptor.manifestFile,
                    maxBytes: MAX_JSON_BYTES,
                }),
            ]);
            if (
                artifactRead.sha256 !==
                    descriptor.artifactSha256 ||
                manifestRead.sha256 !==
                    descriptor.manifestSha256
            ) {
                throw new Error('CAPTURE_FILE_DIGEST_MISMATCH');
            }
            rejectionStage = 'BUNDLE_BUILD_MANIFEST_REJECTED';
            const manifest = parseLandAreaPhase0Manifest(
                manifestRead.value
            );
            rejectionStage = 'BUNDLE_BUILD_ARTIFACT_REJECTED';
            const artifact =
                validateLandAreaPhase0CaptureArtifact(
                    manifest,
                    artifactRead.value
                );
            manifests.set(descriptor.key, manifest);
            validatedArtifacts.set(descriptor.key, artifact);
        }
        rejectionStage = 'BUNDLE_BUILD_BINDING_REJECTED';
        const captures: DevelopmentApiLdaregResolvedCapture[] =
            index.bindings.map((binding) => {
                const descriptor = index.artifacts.find(
                    (entry) => entry.key === binding.artifactKey
                );
                const manifest = manifests.get(
                    binding.artifactKey
                );
                const artifact = validatedArtifacts.get(
                    binding.artifactKey
                );
                const manifestSamples =
                    manifest?.samples.filter(
                        (sample) => sample.alias === binding.alias
                    ) ?? [];
                const artifactSamples =
                    artifact?.samples.filter(
                        (sample) =>
                            sample.aliasHash ===
                            identityHash('ALIAS', binding.alias)
                    ) ?? [];
                if (
                    !descriptor ||
                    !manifest ||
                    !artifact ||
                    manifestSamples.length !== 1 ||
                    artifactSamples.length !== 1 ||
                    expectedLandAreaPhase0Family(
                        manifestSamples[0]
                    ) !== 'LDAREG'
                ) {
                    throw new Error(
                        'CAPTURE_BINDING_SAMPLE_INVALID'
                    );
                }
                return {
                    targetKey: binding.targetKey,
                    runId: descriptor.runId,
                    artifactSha256:
                        descriptor.artifactSha256,
                    artifact,
                    sample: artifactSamples[0],
                };
            });
        rejectionStage = 'BUNDLE_BUILD_TARGET_REJECTED';
        const bundle = buildDevelopmentApiLdaregTargetBundle({
            snapshot: snapshotRead.value,
            captures,
            ...(legacyRead
                ? { legacyTarget07: legacyRead.value }
                : {}),
            ...(dependencies.pins
                ? { pins: dependencies.pins }
                : {}),
        });
        const encoded = new TextEncoder().encode(
            `${JSON.stringify(bundle)}\n`
        );
        const body = Buffer.alloc(encoded.byteLength);
        body.set(encoded);
        rejectionStage = 'BUNDLE_BUILD_OUTPUT_REJECTED';
        let outputDigest: string;
        try {
            const write = await writeExclusivePrivateFile({
                privateRoot: args.privateRoot,
                filename: args.outputFile,
                body,
                maxBytes: MAX_BUNDLE_BYTES,
            });
            outputDigest = write.sha256;
        } finally {
            body.fill(0);
            encoded.fill(0);
        }
        const activeCount = bundle.targets.reduce(
            (sum, entry) =>
                sum + entry.target.propertyTargets.length,
            0
        );
        const ignoredCount = bundle.targets.reduce(
            (sum, entry) =>
                sum + entry.target.ignoredOfficialUnits.length,
            0
        );
        stdout(
            `${DEVELOPMENT_API_LDAREG_BUNDLE_BUILD_SENTINEL} keys=${bundle.targets.length} active=${activeCount} ignored=${ignoredCount} digest=${outputDigest}`
        );
        return 0;
    } catch (error) {
        const rejectionCode = safeBundleBuildRejectionCode(
            error,
            rejectionStage
        );
        stderr(
            `Development API-authoritative LDAREG private target bundle build rejected. code=${rejectionCode}`
        );
        return 2;
    }
}

export async function mainDevelopmentApiLdaregTargetBundleBuilder(): Promise<void> {
    process.exitCode =
        await runDevelopmentApiLdaregTargetBundleBuilder(
            process.argv.slice(2)
        );
}

if (require.main === module) {
    void mainDevelopmentApiLdaregTargetBundleBuilder();
}
