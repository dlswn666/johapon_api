import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
    DEVELOPMENT_API_LDAREG_ARTIFACT_VERSION,
    DEVELOPMENT_API_LDAREG_PREPARE_ARTIFACT_VERSION,
    parseDevelopmentApiLdaregTarget,
    validateDevelopmentApiLdaregArtifact,
    validateDevelopmentApiLdaregPrepareArtifact,
} from '../operations/development-api-authoritative-ldareg-backfill';

const PRIVATE_DIRECTORY =
    '.development-api-authoritative-ldareg-backfill';
const MAX_INPUT_BYTES = 3 * 1024 * 1024;
const HEX40_RE = /^[0-9a-f]{40}$/;
export const DEVELOPMENT_API_LDAREG_VALIDATION_SENTINEL =
    'DEVELOPMENT_API_AUTHORITATIVE_LDAREG_BACKFILL_ARTIFACT_VALIDATED';

interface Arguments {
    targetPath: string;
    artifactPath: string;
    sourceReleaseSha: string;
}

function parseArguments(argv: string[]): Arguments {
    if (argv.length !== 6) {
        throw new Error('VALIDATOR_ARGUMENT_INVALID');
    }
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (
            !flag ||
            !value ||
            ![
                '--target',
                '--artifact',
                '--source-release-sha',
            ].includes(flag) ||
            values.has(flag)
        ) {
            throw new Error('VALIDATOR_ARGUMENT_INVALID');
        }
        values.set(flag, value);
    }
    const targetPath = values.get('--target');
    const artifactPath = values.get('--artifact');
    const sourceReleaseSha = values.get('--source-release-sha');
    if (
        !targetPath ||
        !artifactPath ||
        !sourceReleaseSha ||
        !HEX40_RE.test(sourceReleaseSha)
    ) {
        throw new Error('VALIDATOR_ARGUMENT_INVALID');
    }
    return { targetPath, artifactPath, sourceReleaseSha };
}

async function readPrivateJson(cwd: string, candidate: string) {
    const root = path.resolve(cwd, PRIVATE_DIRECTORY);
    const target = path.resolve(cwd, candidate);
    if (
        target === root ||
        !target.startsWith(`${root}${path.sep}`)
    ) {
        throw new Error('VALIDATOR_PATH_INVALID');
    }
    const [rootInfo, targetInfo] = await Promise.all([
        lstat(root),
        lstat(target),
    ]);
    if (
        !rootInfo.isDirectory() ||
        rootInfo.isSymbolicLink() ||
        (rootInfo.mode & 0o077) !== 0 ||
        !targetInfo.isFile() ||
        targetInfo.isSymbolicLink() ||
        (targetInfo.mode & 0o077) !== 0 ||
        targetInfo.size < 2 ||
        targetInfo.size > MAX_INPUT_BYTES
    ) {
        throw new Error('VALIDATOR_FILE_INVALID');
    }
    const [rootReal, targetReal] = await Promise.all([
        realpath(root),
        realpath(target),
    ]);
    if (!targetReal.startsWith(`${rootReal}${path.sep}`)) {
        throw new Error('VALIDATOR_FILE_INVALID');
    }
    return JSON.parse(await readFile(targetReal, 'utf8')) as unknown;
}

export async function runDevelopmentApiLdaregValidatorCli(
    argv: string[],
    dependencies: {
        cwd?: string;
        stdout?: (message: string) => void;
        stderr?: (message: string) => void;
    } = {}
): Promise<number> {
    const cwd = path.resolve(dependencies.cwd ?? process.cwd());
    const stdout =
        dependencies.stdout ??
        ((message: string) => process.stdout.write(`${message}\n`));
    const stderr =
        dependencies.stderr ??
        ((message: string) => process.stderr.write(`${message}\n`));
    try {
        const args = parseArguments(argv);
        const [targetInput, artifact] = await Promise.all([
            readPrivateJson(cwd, args.targetPath),
            readPrivateJson(cwd, args.artifactPath),
        ]);
        const target =
            parseDevelopmentApiLdaregTarget(targetInput);
        const version =
            artifact &&
            typeof artifact === 'object' &&
            !Array.isArray(artifact)
                ? (artifact as Record<string, unknown>).version
                : null;
        if (
            version ===
            DEVELOPMENT_API_LDAREG_PREPARE_ARTIFACT_VERSION
        ) {
            validateDevelopmentApiLdaregPrepareArtifact({
                target,
                expectedSourceReleaseSha:
                    args.sourceReleaseSha,
                artifact,
            });
        } else if (
            version === DEVELOPMENT_API_LDAREG_ARTIFACT_VERSION
        ) {
            validateDevelopmentApiLdaregArtifact({
                target,
                expectedSourceReleaseSha:
                    args.sourceReleaseSha,
                artifact,
            });
        } else {
            throw new Error('VALIDATOR_ARTIFACT_VERSION_INVALID');
        }
        stdout(DEVELOPMENT_API_LDAREG_VALIDATION_SENTINEL);
        return 0;
    } catch {
        stderr(
            'Development API-authoritative LDAREG artifact rejected.'
        );
        return 2;
    }
}

export async function mainDevelopmentApiLdaregValidatorCli(): Promise<void> {
    process.exitCode =
        await runDevelopmentApiLdaregValidatorCli(
            process.argv.slice(2)
        );
}

if (require.main === module) {
    void mainDevelopmentApiLdaregValidatorCli();
}
