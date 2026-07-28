import path from 'node:path';
import { stagePinnedPrivateFile } from './development-api-authoritative-ldareg-private-file';

const MAX_PRIVATE_FILE_BYTES = 3 * 1024 * 1024;
const STAGE_SENTINEL =
    'DEVELOPMENT_API_AUTHORITATIVE_LDAREG_PRIVATE_FILE_STAGED';

interface StageArguments {
    sourcePath: string;
    outputPath: string;
    maxBytes: number;
}

interface StageDependencies {
    cwd?: string;
    stdout?: (message: string) => void;
    stderr?: (message: string) => void;
}

function parseArguments(argv: string[]): StageArguments {
    if (argv.length !== 6) {
        throw new Error('STAGE_ARGUMENT_INVALID');
    }
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (
            !flag ||
            !value ||
            !['--source', '--out', '--max-bytes'].includes(
                flag
            ) ||
            values.has(flag)
        ) {
            throw new Error('STAGE_ARGUMENT_INVALID');
        }
        values.set(flag, value);
    }
    const sourcePath = values.get('--source');
    const outputPath = values.get('--out');
    const maxBytes = Number(values.get('--max-bytes'));
    if (
        !sourcePath ||
        !outputPath ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 2 ||
        maxBytes > MAX_PRIVATE_FILE_BYTES
    ) {
        throw new Error('STAGE_ARGUMENT_INVALID');
    }
    return { sourcePath, outputPath, maxBytes };
}

export async function runDevelopmentApiLdaregPrivateFileStage(
    argv: string[],
    dependencies: StageDependencies = {}
): Promise<number> {
    const stdout =
        dependencies.stdout ??
        ((message: string) =>
            process.stdout.write(`${message}\n`));
    const stderr =
        dependencies.stderr ??
        ((message: string) =>
            process.stderr.write(`${message}\n`));
    try {
        const args = parseArguments(argv);
        const cwd = path.resolve(
            dependencies.cwd ?? process.cwd()
        );
        await stagePinnedPrivateFile({
            sourcePath: path.resolve(cwd, args.sourcePath),
            outputPath: path.resolve(cwd, args.outputPath),
            minBytes: 2,
            maxBytes: args.maxBytes,
        });
        stdout(STAGE_SENTINEL);
        return 0;
    } catch {
        stderr(
            'Development API-authoritative LDAREG private file staging rejected.'
        );
        return 2;
    }
}

export async function mainDevelopmentApiLdaregPrivateFileStage(): Promise<void> {
    process.exitCode =
        await runDevelopmentApiLdaregPrivateFileStage(
            process.argv.slice(2)
        );
}

if (require.main === module) {
    void mainDevelopmentApiLdaregPrivateFileStage();
}
