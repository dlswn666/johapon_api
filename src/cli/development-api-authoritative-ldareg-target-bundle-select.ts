import { constants } from 'node:fs';
import {
    lstat,
    mkdir,
    open,
    realpath,
} from 'node:fs/promises';
import path from 'node:path';
import {
    selectDevelopmentApiLdaregTargetFromBundle,
    type DevelopmentApiLdaregTargetPins,
} from '../operations/development-api-authoritative-ldareg-backfill';

const PRIVATE_DIRECTORY =
    '.development-api-authoritative-ldareg-backfill';
const BUNDLE_SIZE_LIMIT = 2 * 1024 * 1024;
const TARGET_SIZE_LIMIT = 256 * 1024;

interface SelectorArguments {
    bundlePath: string;
    targetKey: string;
    outputPath: string;
}

interface SelectorDependencies {
    cwd?: string;
    stdout?: (message: string) => void;
    stderr?: (message: string) => void;
    pins?: DevelopmentApiLdaregTargetPins;
}

function parseArguments(argv: string[]): SelectorArguments {
    if (argv.length !== 6) throw new Error('CLI_ARGUMENT_INVALID');
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (
            !flag ||
            !value ||
            !['--bundle', '--target-key', '--out'].includes(
                flag
            ) ||
            values.has(flag)
        ) {
            throw new Error('CLI_ARGUMENT_INVALID');
        }
        values.set(flag, value);
    }
    const bundlePath = values.get('--bundle');
    const targetKey = values.get('--target-key');
    const outputPath = values.get('--out');
    if (
        !bundlePath ||
        !targetKey ||
        !outputPath ||
        bundlePath === outputPath
    ) {
        throw new Error('CLI_ARGUMENT_INVALID');
    }
    return { bundlePath, targetKey, outputPath };
}

function resolvePrivatePath(cwd: string, candidate: string): string {
    const root = path.resolve(cwd, PRIVATE_DIRECTORY);
    const resolved = path.resolve(cwd, candidate);
    if (
        path.dirname(resolved) !== root ||
        !resolved.startsWith(`${root}${path.sep}`)
    ) {
        throw new Error('CLI_PATH_OUTSIDE_PRIVATE_DIRECTORY');
    }
    return resolved;
}

async function ensurePrivateDirectory(cwd: string): Promise<string> {
    const root = path.resolve(cwd, PRIVATE_DIRECTORY);
    try {
        const info = await lstat(root);
        if (
            !info.isDirectory() ||
            info.isSymbolicLink() ||
            (info.mode & 0o077) !== 0
        ) {
            throw new Error('CLI_PRIVATE_DIRECTORY_INVALID');
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
        await mkdir(root, { mode: 0o700 });
    }
    return root;
}

async function readPrivateBundle(
    cwd: string,
    candidate: string
): Promise<unknown> {
    const target = resolvePrivatePath(cwd, candidate);
    const root = await ensurePrivateDirectory(cwd);
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
            targetInfo.size > BUNDLE_SIZE_LIMIT
        ) {
            throw new Error('CLI_INPUT_FILE_INVALID');
        }
        const body = await handle.readFile({ encoding: 'utf8' });
        if (
            Buffer.byteLength(body, 'utf8') >
            BUNDLE_SIZE_LIMIT
        ) {
            throw new Error('CLI_INPUT_FILE_INVALID');
        }
        return JSON.parse(body) as unknown;
    } finally {
        await handle.close();
    }
}

async function writePrivateTarget(
    cwd: string,
    candidate: string,
    target: unknown
): Promise<void> {
    const output = resolvePrivatePath(cwd, candidate);
    await ensurePrivateDirectory(cwd);
    const body = `${JSON.stringify(target)}\n`;
    if (Buffer.byteLength(body, 'utf8') > TARGET_SIZE_LIMIT) {
        throw new Error('CLI_OUTPUT_TOO_LARGE');
    }
    const handle = await open(
        output,
        constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
        0o600
    );
    try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
        await handle.chmod(0o600);
    } finally {
        await handle.close();
    }
}

export async function runDevelopmentApiLdaregTargetBundleSelector(
    argv: string[],
    dependencies: SelectorDependencies = {}
): Promise<number> {
    const cwd = path.resolve(dependencies.cwd ?? process.cwd());
    const stdout =
        dependencies.stdout ?? ((message: string) => console.log(message));
    const stderr =
        dependencies.stderr ??
        ((message: string) => console.error(message));
    try {
        const args = parseArguments(argv);
        const bundle = await readPrivateBundle(
            cwd,
            args.bundlePath
        );
        const target =
            selectDevelopmentApiLdaregTargetFromBundle({
                bundle,
                targetKey: args.targetKey,
                pins: dependencies.pins,
            });
        await writePrivateTarget(cwd, args.outputPath, target);
        stdout('Development API-authoritative LDAREG target selected.');
        return 0;
    } catch {
        stderr(
            'Development API-authoritative LDAREG target selection rejected.'
        );
        return 2;
    }
}

export async function mainDevelopmentApiLdaregTargetBundleSelector(): Promise<void> {
    process.exitCode =
        await runDevelopmentApiLdaregTargetBundleSelector(
            process.argv.slice(2)
        );
}

if (require.main === module) {
    void mainDevelopmentApiLdaregTargetBundleSelector();
}
