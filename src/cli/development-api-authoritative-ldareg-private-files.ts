import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
    lstat,
    open,
    realpath,
    unlink,
} from 'node:fs/promises';
import path from 'node:path';

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILENAME_RE =
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

interface PinnedPrivateRoot {
    path: string;
    realPath: string;
    dev: number;
    ino: number;
}

export interface PrivateFileRead {
    body: Buffer;
    sha256: string;
}

function currentUid(): number {
    const uid = process.getuid?.();
    if (uid === undefined) {
        throw new Error('PRIVATE_UID_UNAVAILABLE');
    }
    return uid;
}

async function pinPrivateRoot(
    candidate: string
): Promise<PinnedPrivateRoot> {
    const rootPath = path.resolve(candidate);
    const [info, realPath] = await Promise.all([
        lstat(rootPath),
        realpath(rootPath),
    ]);
    if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== currentUid() ||
        (info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    ) {
        throw new Error('PRIVATE_ROOT_INVALID');
    }
    return {
        path: rootPath,
        realPath,
        dev: info.dev,
        ino: info.ino,
    };
}

async function assertPrivateRootPinned(
    root: PinnedPrivateRoot
): Promise<void> {
    const [info, realPath] = await Promise.all([
        lstat(root.path),
        realpath(root.path),
    ]);
    if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== currentUid() ||
        (info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
        info.dev !== root.dev ||
        info.ino !== root.ino ||
        realPath !== root.realPath
    ) {
        throw new Error('PRIVATE_ROOT_CHANGED');
    }
}

function resolveDirectPrivateChild(
    root: PinnedPrivateRoot,
    candidate: string
): string {
    if (
        !PRIVATE_FILENAME_RE.test(candidate) ||
        path.isAbsolute(candidate) ||
        path.basename(candidate) !== candidate ||
        candidate === '.' ||
        candidate === '..'
    ) {
        throw new Error('PRIVATE_PATH_INVALID');
    }
    const resolved = path.resolve(root.path, candidate);
    if (path.dirname(resolved) !== root.path) {
        throw new Error('PRIVATE_PATH_INVALID');
    }
    return resolved;
}

export async function readPinnedPrivateFile(input: {
    privateRoot: string;
    filename: string;
    maxBytes: number;
}): Promise<PrivateFileRead> {
    if (
        !Number.isSafeInteger(input.maxBytes) ||
        input.maxBytes < 2 ||
        input.maxBytes > 16 * 1024 * 1024
    ) {
        throw new Error('PRIVATE_SIZE_LIMIT_INVALID');
    }
    const root = await pinPrivateRoot(input.privateRoot);
    const target = resolveDirectPrivateChild(
        root,
        input.filename
    );
    await assertPrivateRootPinned(root);
    const handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
        const descriptorInfo = await handle.stat();
        await assertPrivateRootPinned(root);
        const [pathInfo, targetReal] = await Promise.all([
            lstat(target),
            realpath(target),
        ]);
        if (
            !descriptorInfo.isFile() ||
            !pathInfo.isFile() ||
            pathInfo.isSymbolicLink() ||
            descriptorInfo.uid !== currentUid() ||
            pathInfo.uid !== currentUid() ||
            descriptorInfo.nlink !== 1 ||
            pathInfo.nlink !== 1 ||
            (descriptorInfo.mode & 0o777) !==
                PRIVATE_FILE_MODE ||
            (pathInfo.mode & 0o777) !== PRIVATE_FILE_MODE ||
            descriptorInfo.dev !== pathInfo.dev ||
            descriptorInfo.ino !== pathInfo.ino ||
            path.dirname(targetReal) !== root.realPath ||
            descriptorInfo.size < 2 ||
            descriptorInfo.size > input.maxBytes
        ) {
            throw new Error('PRIVATE_INPUT_INVALID');
        }
        const body = await handle.readFile();
        if (
            body.byteLength < 2 ||
            body.byteLength > input.maxBytes
        ) {
            throw new Error('PRIVATE_INPUT_INVALID');
        }
        await assertPrivateRootPinned(root);
        const [descriptorInfoAfter, pathInfoAfter, targetRealAfter] =
            await Promise.all([
                handle.stat(),
                lstat(target),
                realpath(target),
            ]);
        if (
            pathInfoAfter.isSymbolicLink() ||
            !descriptorInfoAfter.isFile() ||
            !pathInfoAfter.isFile() ||
            descriptorInfoAfter.uid !== currentUid() ||
            pathInfoAfter.uid !== currentUid() ||
            descriptorInfoAfter.nlink !== 1 ||
            pathInfoAfter.nlink !== 1 ||
            (descriptorInfoAfter.mode & 0o777) !==
                PRIVATE_FILE_MODE ||
            (pathInfoAfter.mode & 0o777) !==
                PRIVATE_FILE_MODE ||
            body.byteLength !== descriptorInfo.size ||
            descriptorInfoAfter.size !== descriptorInfo.size ||
            descriptorInfoAfter.mtimeMs !==
                descriptorInfo.mtimeMs ||
            descriptorInfoAfter.ctimeMs !==
                descriptorInfo.ctimeMs ||
            targetRealAfter !== targetReal ||
            path.dirname(targetRealAfter) !== root.realPath ||
            descriptorInfoAfter.dev !== descriptorInfo.dev ||
            descriptorInfoAfter.ino !== descriptorInfo.ino ||
            pathInfoAfter.dev !== descriptorInfo.dev ||
            pathInfoAfter.ino !== descriptorInfo.ino
        ) {
            body.fill(0);
            throw new Error('PRIVATE_INPUT_CHANGED');
        }
        return {
            body,
            sha256: createHash('sha256')
                .update(body)
                .digest('hex'),
        };
    } finally {
        await handle.close();
    }
}

export async function readPinnedPrivateJson(input: {
    privateRoot: string;
    filename: string;
    maxBytes: number;
}): Promise<{ value: unknown; sha256: string }> {
    const read = await readPinnedPrivateFile(input);
    try {
        return {
            sha256: read.sha256,
            value: JSON.parse(
                read.body.toString('utf8')
            ) as unknown,
        };
    } finally {
        read.body.fill(0);
    }
}

export async function writeExclusivePrivateFile(input: {
    privateRoot: string;
    filename: string;
    body: Buffer;
    maxBytes: number;
}): Promise<{ sha256: string }> {
    if (
        !Number.isSafeInteger(input.maxBytes) ||
        input.maxBytes < 2 ||
        input.maxBytes > 16 * 1024 * 1024 ||
        input.body.byteLength < 2 ||
        input.body.byteLength > input.maxBytes
    ) {
        throw new Error('PRIVATE_OUTPUT_SIZE_INVALID');
    }
    const root = await pinPrivateRoot(input.privateRoot);
    const target = resolveDirectPrivateChild(
        root,
        input.filename
    );
    await assertPrivateRootPinned(root);
    const handle = await open(
        target,
        constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE
    );
    let created:
        | {
              dev: number;
              ino: number;
          }
        | undefined;
    try {
        const descriptorInfo = await handle.stat();
        created = {
            dev: descriptorInfo.dev,
            ino: descriptorInfo.ino,
        };
        if (
            !descriptorInfo.isFile() ||
            descriptorInfo.uid !== currentUid() ||
            descriptorInfo.nlink !== 1 ||
            descriptorInfo.size !== 0 ||
            (descriptorInfo.mode & 0o777) !==
                PRIVATE_FILE_MODE
        ) {
            throw new Error('PRIVATE_OUTPUT_INVALID');
        }
        await assertPrivateRootPinned(root);
        const pathInfo = await lstat(target);
        if (
            !pathInfo.isFile() ||
            pathInfo.isSymbolicLink() ||
            pathInfo.uid !== currentUid() ||
            pathInfo.nlink !== 1 ||
            (pathInfo.mode & 0o777) !== PRIVATE_FILE_MODE ||
            pathInfo.dev !== descriptorInfo.dev ||
            pathInfo.ino !== descriptorInfo.ino
        ) {
            throw new Error('PRIVATE_OUTPUT_INVALID');
        }
        await handle.writeFile(input.body);
        await handle.sync();
        await handle.chmod(PRIVATE_FILE_MODE);
        await assertPrivateRootPinned(root);
        const [descriptorInfoAfter, pathInfoAfter, targetRealAfter] =
            await Promise.all([
                handle.stat(),
                lstat(target),
                realpath(target),
            ]);
        if (
            pathInfoAfter.isSymbolicLink() ||
            !descriptorInfoAfter.isFile() ||
            !pathInfoAfter.isFile() ||
            descriptorInfoAfter.uid !== currentUid() ||
            pathInfoAfter.uid !== currentUid() ||
            descriptorInfoAfter.nlink !== 1 ||
            pathInfoAfter.nlink !== 1 ||
            descriptorInfoAfter.size !==
                input.body.byteLength ||
            pathInfoAfter.size !== input.body.byteLength ||
            path.dirname(targetRealAfter) !== root.realPath ||
            path.basename(targetRealAfter) !== input.filename ||
            descriptorInfoAfter.dev !== descriptorInfo.dev ||
            descriptorInfoAfter.ino !== descriptorInfo.ino ||
            pathInfoAfter.dev !== descriptorInfo.dev ||
            pathInfoAfter.ino !== descriptorInfo.ino ||
            (pathInfoAfter.mode & 0o777) !==
                PRIVATE_FILE_MODE
        ) {
            throw new Error('PRIVATE_OUTPUT_CHANGED');
        }
        return {
            sha256: createHash('sha256')
                .update(input.body)
                .digest('hex'),
        };
    } catch (error) {
        if (created) {
            try {
                const current = await lstat(target);
                if (
                    current.isFile() &&
                    !current.isSymbolicLink() &&
                    current.dev === created.dev &&
                    current.ino === created.ino
                ) {
                    await unlink(target);
                }
            } catch {
                // 생성한 exact inode만 best-effort로 정리한다.
            }
        }
        throw error;
    } finally {
        await handle.close();
    }
}
