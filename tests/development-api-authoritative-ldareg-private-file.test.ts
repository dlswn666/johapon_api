import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    runDevelopmentApiLdaregPrivateFileMaterialize,
} from '../src/cli/development-api-authoritative-ldareg-private-file-materialize';
import {
    runDevelopmentApiLdaregPrivateFileStage,
} from '../src/cli/development-api-authoritative-ldareg-private-file-stage';
import {
    readPinnedPrivateFile,
    readPinnedPrivateJson,
} from '../src/cli/development-api-authoritative-ldareg-private-file';

const MATERIALIZED =
    'DEVELOPMENT_API_AUTHORITATIVE_LDAREG_PRIVATE_FILE_MATERIALIZED';
const STAGED =
    'DEVELOPMENT_API_AUTHORITATIVE_LDAREG_PRIVATE_FILE_STAGED';
const fsPromisesMutable: typeof import('node:fs/promises') =
    require('node:fs/promises');

function privateFixture(prefix: string) {
    const temporary = fs.mkdtempSync(
        path.join(os.tmpdir(), prefix)
    );
    const privateRoot = path.join(temporary, 'private');
    fs.mkdirSync(privateRoot, { mode: 0o700 });
    fs.chmodSync(privateRoot, 0o700);
    return { temporary, privateRoot };
}

test('materializer는 canonical base64를 새 0600 파일에만 쓰고 고정 sentinel만 출력한다', async () => {
    const { temporary, privateRoot } = privateFixture(
        'ldareg-private-materialize-'
    );
    const secret = Buffer.from(
        '{"private":"never-print-this-value"}\n',
        'utf8'
    );
    const encoded = Buffer.from(secret.toString('base64'), 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const output = path.join(privateRoot, 'bundle.json');
    try {
        assert.equal(
            await runDevelopmentApiLdaregPrivateFileMaterialize(
                [
                    '--out',
                    output,
                    '--encoding',
                    'base64',
                    '--max-bytes',
                    '1024',
                ],
                {
                    input: encoded,
                    stdout: (message) => stdout.push(message),
                    stderr: (message) => stderr.push(message),
                }
            ),
            0
        );
        assert.deepEqual(stdout, [MATERIALIZED]);
        assert.deepEqual(stderr, []);
        assert.equal(fs.statSync(output).mode & 0o777, 0o600);
        assert.deepEqual(fs.readFileSync(output), secret);
        assert.equal(
            `${stdout.join('\n')}\n${stderr.join('\n')}`.includes(
                'never-print-this-value'
            ),
            false
        );

        assert.equal(
            await runDevelopmentApiLdaregPrivateFileMaterialize(
                [
                    '--out',
                    output,
                    '--encoding',
                    'raw',
                    '--max-bytes',
                    '1024',
                ],
                {
                    input: Buffer.from('replacement\n'),
                    stdout: (message) => stdout.push(message),
                    stderr: (message) => stderr.push(message),
                }
            ),
            2
        );
        assert.deepEqual(fs.readFileSync(output), secret);

        const victim = path.join(privateRoot, 'victim.json');
        const symlink = path.join(privateRoot, 'symlink.json');
        fs.writeFileSync(victim, 'unchanged\n', { mode: 0o600 });
        fs.symlinkSync(victim, symlink);
        assert.equal(
            await runDevelopmentApiLdaregPrivateFileMaterialize(
                [
                    '--out',
                    symlink,
                    '--encoding',
                    'raw',
                    '--max-bytes',
                    '1024',
                ],
                { input: Buffer.from('replacement\n') }
            ),
            2
        );
        assert.equal(fs.readFileSync(victim, 'utf8'), 'unchanged\n');

        const publicRoot = path.join(temporary, 'public');
        fs.mkdirSync(publicRoot, { mode: 0o755 });
        fs.chmodSync(publicRoot, 0o755);
        assert.equal(
            await runDevelopmentApiLdaregPrivateFileMaterialize(
                [
                    '--out',
                    path.join(publicRoot, 'rejected.json'),
                    '--encoding',
                    'raw',
                    '--max-bytes',
                    '1024',
                ],
                { input: Buffer.from('private\n') }
            ),
            2
        );
        assert.equal(
            fs.existsSync(path.join(publicRoot, 'rejected.json')),
            false
        );
    } finally {
        secret.fill(0);
        encoded.fill(0);
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});

test('stager는 owner-private source inode를 읽어 배타적 0600 복사본만 만든다', async () => {
    const { temporary, privateRoot } = privateFixture(
        'ldareg-private-stage-'
    );
    const source = path.join(privateRoot, 'source.json');
    const output = path.join(privateRoot, 'staged.json');
    fs.writeFileSync(source, '{"value":1}\n', { mode: 0o600 });
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
        assert.equal(
            await runDevelopmentApiLdaregPrivateFileStage(
                [
                    '--source',
                    source,
                    '--out',
                    output,
                    '--max-bytes',
                    '1024',
                ],
                {
                    stdout: (message) => stdout.push(message),
                    stderr: (message) => stderr.push(message),
                }
            ),
            0
        );
        assert.deepEqual(stdout, [STAGED]);
        assert.deepEqual(stderr, []);
        assert.equal(fs.statSync(output).mode & 0o777, 0o600);
        assert.equal(
            fs.readFileSync(output, 'utf8'),
            '{"value":1}\n'
        );

        fs.chmodSync(source, 0o644);
        assert.equal(
            await runDevelopmentApiLdaregPrivateFileStage(
                [
                    '--source',
                    source,
                    '--out',
                    path.join(privateRoot, 'mode-rejected.json'),
                    '--max-bytes',
                    '1024',
                ]
            ),
            2
        );
        fs.chmodSync(source, 0o600);

        const sourceSymlink = path.join(
            privateRoot,
            'source-symlink.json'
        );
        fs.symlinkSync(source, sourceSymlink);
        assert.equal(
            await runDevelopmentApiLdaregPrivateFileStage(
                [
                    '--source',
                    sourceSymlink,
                    '--out',
                    path.join(
                        privateRoot,
                        'symlink-rejected.json'
                    ),
                    '--max-bytes',
                    '1024',
                ]
            ),
            2
        );

        assert.equal(
            await runDevelopmentApiLdaregPrivateFileStage(
                [
                    '--source',
                    source,
                    '--out',
                    output,
                    '--max-bytes',
                    '1024',
                ]
            ),
            2
        );
        assert.equal(
            fs.readFileSync(output, 'utf8'),
            '{"value":1}\n'
        );
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});

test('pinned JSON reader는 symlink·공개 mode·공개 parent를 fail-closed로 거부한다', async () => {
    const { temporary, privateRoot } = privateFixture(
        'ldareg-private-read-'
    );
    const source = path.join(privateRoot, 'source.json');
    fs.writeFileSync(source, '{"value":1}\n', { mode: 0o600 });
    try {
        assert.deepEqual(
            await readPinnedPrivateJson({
                path: source,
                maxBytes: 1024,
            }),
            { value: 1 }
        );

        const symlink = path.join(privateRoot, 'symlink.json');
        fs.symlinkSync(source, symlink);
        await assert.rejects(
            readPinnedPrivateJson({
                path: symlink,
                maxBytes: 1024,
            })
        );

        fs.chmodSync(source, 0o644);
        await assert.rejects(
            readPinnedPrivateJson({
                path: source,
                maxBytes: 1024,
            })
        );
        fs.chmodSync(source, 0o600);

        fs.chmodSync(privateRoot, 0o755);
        await assert.rejects(
            readPinnedPrivateJson({
                path: source,
                maxBytes: 1024,
            })
        );
    } finally {
        fs.chmodSync(privateRoot, 0o700);
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});

test('descriptor open 뒤 candidate가 같은 inode symlink로 바뀌어도 path pin이 거부한다', async (context) => {
    const { temporary, privateRoot } = privateFixture(
        'ldareg-private-same-inode-swap-'
    );
    const source = path.join(privateRoot, 'source.json');
    const anchor = path.join(privateRoot, 'anchor.json');
    fs.writeFileSync(source, '{"value":1}\n', { mode: 0o600 });
    fs.linkSync(source, anchor);
    const originalLstat = fsPromisesMutable.lstat;
    let swapped = false;
    context.mock.method(
        fsPromisesMutable,
        'lstat',
        async (
            ...args: Parameters<typeof fsPromisesMutable.lstat>
        ) => {
            const candidate = path.resolve(
                args[0].toString()
            );
            if (!swapped && candidate === source) {
                fs.unlinkSync(source);
                fs.symlinkSync(anchor, source);
                swapped = true;
            }
            return originalLstat(...args);
        }
    );
    try {
        await assert.rejects(
            readPinnedPrivateFile({
                path: source,
                maxBytes: 1024,
            })
        );
        assert.equal(swapped, true);
        assert.equal(fs.lstatSync(source).isSymbolicLink(), true);
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});
