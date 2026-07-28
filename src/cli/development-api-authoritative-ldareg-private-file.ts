import { constants, type Stats } from 'node:fs';
import {
    lstat,
    open,
    realpath,
    unlink,
} from 'node:fs/promises';
import path from 'node:path';

interface PrivateParentSnapshot {
    path: string;
    realPath: string;
    dev: number;
    ino: number;
}

interface PrivateFileStat {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
}

function currentUid(): number | null {
    return typeof process.getuid === 'function'
        ? process.getuid()
        : null;
}

function ownedByCurrentUser(uid: number): boolean {
    const expected = currentUid();
    return expected === null || uid === expected;
}

function privateMode(mode: number): boolean {
    return (mode & 0o077) === 0;
}

async function inspectPrivateParent(
    candidate: string
): Promise<PrivateParentSnapshot> {
    const parent = path.dirname(candidate);
    const [info, real] = await Promise.all([
        lstat(parent),
        realpath(parent),
    ]);
    if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        !privateMode(info.mode) ||
        !ownedByCurrentUser(info.uid)
    ) {
        throw new Error('PRIVATE_PARENT_INVALID');
    }
    return {
        path: parent,
        realPath: real,
        dev: info.dev,
        ino: info.ino,
    };
}

async function assertPrivateParentStable(
    expected: PrivateParentSnapshot
): Promise<void> {
    const [info, real] = await Promise.all([
        lstat(expected.path),
        realpath(expected.path),
    ]);
    if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        !privateMode(info.mode) ||
        !ownedByCurrentUser(info.uid) ||
        info.dev !== expected.dev ||
        info.ino !== expected.ino ||
        real !== expected.realPath
    ) {
        throw new Error('PRIVATE_PARENT_CHANGED');
    }
}

function privateRegularFile(
    info: Stats,
    minBytes: number,
    maxBytes: number
): boolean {
    return (
        info.isFile() &&
        !info.isSymbolicLink() &&
        privateMode(info.mode) &&
        ownedByCurrentUser(info.uid) &&
        info.size >= minBytes &&
        info.size <= maxBytes
    );
}

function pinnedStat(
    info: Stats
): PrivateFileStat {
    return {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
    };
}

function samePinnedStat(
    left: PrivateFileStat,
    right: Stats
): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs
    );
}

function assertBounds(minBytes: number, maxBytes: number): void {
    if (
        !Number.isSafeInteger(minBytes) ||
        !Number.isSafeInteger(maxBytes) ||
        minBytes < 0 ||
        maxBytes < Math.max(1, minBytes) ||
        maxBytes > 16 * 1024 * 1024
    ) {
        throw new Error('PRIVATE_FILE_BOUND_INVALID');
    }
}

export async function readPinnedPrivateFile(input: {
    path: string;
    minBytes?: number;
    maxBytes: number;
}): Promise<Buffer> {
    const minBytes = input.minBytes ?? 1;
    assertBounds(minBytes, input.maxBytes);
    const candidate = path.resolve(input.path);
    const parent = await inspectPrivateParent(candidate);
    const handle = await open(
        candidate,
        constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
        const [
            descriptorInfo,
            candidatePathInfo,
            targetReal,
        ] = await Promise.all([
            handle.stat(),
            lstat(candidate),
            realpath(candidate),
        ]);
        const descriptorPin = pinnedStat(descriptorInfo);
        const targetPathInfo = await lstat(targetReal);
        await assertPrivateParentStable(parent);
        if (
            path.dirname(targetReal) !== parent.realPath ||
            !privateRegularFile(
                descriptorInfo,
                minBytes,
                input.maxBytes
            ) ||
            !candidatePathInfo.isFile() ||
            candidatePathInfo.isSymbolicLink() ||
            !privateMode(candidatePathInfo.mode) ||
            !ownedByCurrentUser(candidatePathInfo.uid) ||
            descriptorInfo.dev !== candidatePathInfo.dev ||
            descriptorInfo.ino !== candidatePathInfo.ino ||
            !targetPathInfo.isFile() ||
            targetPathInfo.isSymbolicLink() ||
            !privateMode(targetPathInfo.mode) ||
            !ownedByCurrentUser(targetPathInfo.uid) ||
            descriptorInfo.dev !== targetPathInfo.dev ||
            descriptorInfo.ino !== targetPathInfo.ino
        ) {
            throw new Error('PRIVATE_FILE_INVALID');
        }
        const body = await handle.readFile();
        const [
            descriptorAfter,
            candidatePathInfoAfter,
            targetRealAfter,
        ] = await Promise.all([
            handle.stat(),
            lstat(candidate),
            realpath(candidate),
        ]);
        const targetPathInfoAfter = await lstat(targetRealAfter);
        await assertPrivateParentStable(parent);
        if (
            body.byteLength < minBytes ||
            body.byteLength > input.maxBytes ||
            body.byteLength !== descriptorPin.size ||
            !samePinnedStat(descriptorPin, descriptorAfter) ||
            targetRealAfter !== targetReal ||
            path.dirname(targetRealAfter) !== parent.realPath ||
            !candidatePathInfoAfter.isFile() ||
            candidatePathInfoAfter.isSymbolicLink() ||
            !privateMode(candidatePathInfoAfter.mode) ||
            !ownedByCurrentUser(candidatePathInfoAfter.uid) ||
            candidatePathInfoAfter.dev !== descriptorAfter.dev ||
            candidatePathInfoAfter.ino !== descriptorAfter.ino ||
            !targetPathInfoAfter.isFile() ||
            targetPathInfoAfter.isSymbolicLink() ||
            targetPathInfoAfter.dev !== descriptorAfter.dev ||
            targetPathInfoAfter.ino !== descriptorAfter.ino
        ) {
            body.fill(0);
            throw new Error('PRIVATE_FILE_CHANGED');
        }
        return body;
    } finally {
        await handle.close();
    }
}

async function cleanupCreatedPath(
    candidate: string,
    descriptorInfo: PrivateFileStat
): Promise<void> {
    try {
        const pathInfo = await lstat(candidate);
        if (
            pathInfo.isFile() &&
            !pathInfo.isSymbolicLink() &&
            pathInfo.dev === descriptorInfo.dev &&
            pathInfo.ino === descriptorInfo.ino
        ) {
            await unlink(candidate);
        }
    } catch {
        // 실패 경로에서는 생성한 exact inode만 best-effort로 정리한다.
    }
}

export async function writeExclusivePrivateFile(input: {
    path: string;
    body: Buffer;
    minBytes?: number;
    maxBytes: number;
}): Promise<void> {
    const minBytes = input.minBytes ?? 1;
    assertBounds(minBytes, input.maxBytes);
    if (
        input.body.byteLength < minBytes ||
        input.body.byteLength > input.maxBytes
    ) {
        throw new Error('PRIVATE_FILE_BODY_INVALID');
    }
    const candidate = path.resolve(input.path);
    const parent = await inspectPrivateParent(candidate);
    const handle = await open(
        candidate,
        constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
        0o600
    );
    let descriptorPin: PrivateFileStat | null = null;
    try {
        const descriptorInfo = await handle.stat();
        descriptorPin = pinnedStat(descriptorInfo);
        if (
            !privateRegularFile(descriptorInfo, 0, 0) ||
            descriptorInfo.size !== 0
        ) {
            throw new Error('PRIVATE_OUTPUT_INVALID');
        }
        await handle.writeFile(input.body);
        await handle.sync();
        await handle.chmod(0o600);
        const [
            descriptorAfter,
            candidatePathInfo,
            targetReal,
        ] = await Promise.all([
            handle.stat(),
            lstat(candidate),
            realpath(candidate),
        ]);
        const targetPathInfo = await lstat(targetReal);
        await assertPrivateParentStable(parent);
        if (
            path.dirname(targetReal) !== parent.realPath ||
            !privateRegularFile(
                descriptorAfter,
                minBytes,
                input.maxBytes
            ) ||
            descriptorAfter.size !== input.body.byteLength ||
            !candidatePathInfo.isFile() ||
            candidatePathInfo.isSymbolicLink() ||
            !privateMode(candidatePathInfo.mode) ||
            !ownedByCurrentUser(candidatePathInfo.uid) ||
            candidatePathInfo.dev !== descriptorAfter.dev ||
            candidatePathInfo.ino !== descriptorAfter.ino ||
            !targetPathInfo.isFile() ||
            targetPathInfo.isSymbolicLink() ||
            targetPathInfo.dev !== descriptorAfter.dev ||
            targetPathInfo.ino !== descriptorAfter.ino ||
            (targetPathInfo.mode & 0o777) !== 0o600
        ) {
            throw new Error('PRIVATE_OUTPUT_CHANGED');
        }
    } catch (error) {
        if (descriptorPin !== null) {
            await cleanupCreatedPath(candidate, descriptorPin);
        }
        throw error;
    } finally {
        await handle.close();
    }
}

export async function stagePinnedPrivateFile(input: {
    sourcePath: string;
    outputPath: string;
    minBytes?: number;
    maxBytes: number;
}): Promise<void> {
    if (
        path.resolve(input.sourcePath) ===
        path.resolve(input.outputPath)
    ) {
        throw new Error('PRIVATE_STAGE_PATH_COLLISION');
    }
    const body = await readPinnedPrivateFile({
        path: input.sourcePath,
        minBytes: input.minBytes,
        maxBytes: input.maxBytes,
    });
    try {
        await writeExclusivePrivateFile({
            path: input.outputPath,
            body,
            minBytes: input.minBytes,
            maxBytes: input.maxBytes,
        });
    } finally {
        body.fill(0);
    }
}

export async function readPinnedPrivateJson(input: {
    path: string;
    maxBytes: number;
}): Promise<unknown> {
    const body = await readPinnedPrivateFile({
        path: input.path,
        minBytes: 2,
        maxBytes: input.maxBytes,
    });
    try {
        return JSON.parse(body.toString('utf8')) as unknown;
    } finally {
        body.fill(0);
    }
}
