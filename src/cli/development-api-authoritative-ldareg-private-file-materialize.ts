import path from 'node:path';
import { TextDecoder } from 'node:util';
import { writeExclusivePrivateFile } from './development-api-authoritative-ldareg-private-file';

const MAX_PRIVATE_FILE_BYTES = 3 * 1024 * 1024;
const MATERIALIZE_SENTINEL =
    'DEVELOPMENT_API_AUTHORITATIVE_LDAREG_PRIVATE_FILE_MATERIALIZED';

interface MaterializeArguments {
    outputPath: string;
    encoding: 'raw' | 'base64';
    maxBytes: number;
}

interface MaterializeDependencies {
    cwd?: string;
    input?: Buffer;
    stdout?: (message: string) => void;
    stderr?: (message: string) => void;
}

function copyBytes(input: Uint8Array): Buffer {
    const output = Buffer.alloc(input.byteLength);
    output.set(input);
    return output;
}

function encodeUtf8(input: string): Buffer {
    const output = Buffer.alloc(Buffer.byteLength(input, 'utf8'));
    const written = output.write(input, 'utf8');
    if (written !== output.byteLength) {
        output.fill(0);
        throw new Error('MATERIALIZE_UTF8_INVALID');
    }
    return output;
}

function parseArguments(argv: string[]): MaterializeArguments {
    if (argv.length !== 6) {
        throw new Error('MATERIALIZE_ARGUMENT_INVALID');
    }
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (
            !flag ||
            !value ||
            !['--out', '--encoding', '--max-bytes'].includes(
                flag
            ) ||
            values.has(flag)
        ) {
            throw new Error('MATERIALIZE_ARGUMENT_INVALID');
        }
        values.set(flag, value);
    }
    const outputPath = values.get('--out');
    const encoding = values.get('--encoding');
    const maxBytesText = values.get('--max-bytes');
    const maxBytes = Number(maxBytesText);
    if (
        !outputPath ||
        (encoding !== 'raw' && encoding !== 'base64') ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 2 ||
        maxBytes > MAX_PRIVATE_FILE_BYTES
    ) {
        throw new Error('MATERIALIZE_ARGUMENT_INVALID');
    }
    return { outputPath, encoding, maxBytes };
}

async function readBoundedStdin(maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
        for await (const chunk of process.stdin) {
            const buffer = Buffer.isBuffer(chunk)
                ? chunk
                : typeof chunk === 'string'
                  ? encodeUtf8(chunk)
                  : copyBytes(chunk as Uint8Array);
            size += buffer.byteLength;
            if (size > maxBytes) {
                buffer.fill(0);
                throw new Error(
                    'MATERIALIZE_INPUT_TOO_LARGE'
                );
            }
            chunks.push(buffer);
        }
        return Buffer.concat(chunks);
    } finally {
        for (const value of chunks) value.fill(0);
    }
}

function decodeCanonicalBase64(input: Buffer): Buffer {
    const encoded = new TextDecoder('utf-8', {
        fatal: true,
    }).decode(input);
    if (
        Buffer.byteLength(encoded, 'utf8') !== input.byteLength ||
        encoded.length === 0 ||
        encoded.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
            encoded
        )
    ) {
        throw new Error('MATERIALIZE_BASE64_INVALID');
    }
    const paddingBytes = encoded.endsWith('==')
        ? 2
        : encoded.endsWith('=')
          ? 1
          : 0;
    const decoded = Buffer.alloc(
        (encoded.length / 4) * 3 - paddingBytes
    );
    const written = decoded.write(encoded, 'base64');
    if (
        written !== decoded.byteLength ||
        decoded.toString('base64') !== encoded
    ) {
        decoded.fill(0);
        throw new Error('MATERIALIZE_BASE64_INVALID');
    }
    return decoded;
}

export async function runDevelopmentApiLdaregPrivateFileMaterialize(
    argv: string[],
    dependencies: MaterializeDependencies = {}
): Promise<number> {
    const stdout =
        dependencies.stdout ??
        ((message: string) => process.stdout.write(`${message}\n`));
    const stderr =
        dependencies.stderr ??
        ((message: string) => process.stderr.write(`${message}\n`));
    let encodedInput: Buffer | null = null;
    let body: Buffer | null = null;
    try {
        const args = parseArguments(argv);
        const encodedLimit =
            args.encoding === 'base64'
                ? Math.ceil(args.maxBytes / 3) * 4
                : args.maxBytes;
        encodedInput =
            dependencies.input === undefined
                ? await readBoundedStdin(encodedLimit)
                : copyBytes(dependencies.input);
        if (encodedInput.byteLength > encodedLimit) {
            throw new Error('MATERIALIZE_INPUT_TOO_LARGE');
        }
        body =
            args.encoding === 'base64'
                ? decodeCanonicalBase64(encodedInput)
                : copyBytes(encodedInput);
        await writeExclusivePrivateFile({
            path: path.resolve(
                dependencies.cwd ?? process.cwd(),
                args.outputPath
            ),
            body,
            minBytes: 2,
            maxBytes: args.maxBytes,
        });
        stdout(MATERIALIZE_SENTINEL);
        return 0;
    } catch {
        stderr(
            'Development API-authoritative LDAREG private file materialization rejected.'
        );
        return 2;
    } finally {
        encodedInput?.fill(0);
        body?.fill(0);
    }
}

export async function mainDevelopmentApiLdaregPrivateFileMaterialize(): Promise<void> {
    process.exitCode =
        await runDevelopmentApiLdaregPrivateFileMaterialize(
            process.argv.slice(2)
        );
}

if (require.main === module) {
    void mainDevelopmentApiLdaregPrivateFileMaterialize();
}
