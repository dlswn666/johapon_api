import { emitKeypressEvents, type Key } from 'node:readline';

const MAX_SECRET_INPUT_BYTES = 4096;

export function normalizeLegalMcpSecretInputV1(input: string): string {
    const normalized = input.replace(/\r?\n$/, '');
    if (
        normalized.length === 0
        || Buffer.byteLength(normalized, 'utf8') > MAX_SECRET_INPUT_BYTES
        || /[\r\n]/.test(normalized)
    ) {
        throw new Error('비밀 입력은 비어 있지 않은 한 줄이어야 합니다.');
    }
    return normalized;
}

async function readPipedSecret(input: NodeJS.ReadStream): Promise<string> {
    input.setEncoding('utf8');
    let value = '';
    for await (const chunk of input) {
        value += chunk;
        if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_INPUT_BYTES) {
            throw new Error('비밀 입력이 허용 크기를 초과했습니다.');
        }
    }
    return normalizeLegalMcpSecretInputV1(value);
}

/** TTY에서는 문자를 echo하지 않고, pipe에서는 stdin 한 줄만 읽는다. */
export function readHiddenLegalMcpSecretV1(
    prompt: string,
    input: NodeJS.ReadStream = process.stdin,
    output: NodeJS.WriteStream = process.stderr
): Promise<string> {
    if (!input.isTTY) return readPipedSecret(input);

    return new Promise((resolve, reject) => {
        let value = '';
        let settled = false;

        const cleanup = (): void => {
            input.removeListener('keypress', onKeypress);
            input.setRawMode(false);
            input.pause();
            output.write('\n');
        };
        const finish = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            cleanup();
            callback();
        };
        const onKeypress = (text: string, key: Key): void => {
            if (key.ctrl && key.name === 'c') {
                finish(() => reject(new Error('비밀 입력이 취소되었습니다.')));
                return;
            }
            if (key.name === 'return' || key.name === 'enter') {
                finish(() => {
                    try {
                        resolve(normalizeLegalMcpSecretInputV1(value));
                    } catch (error) {
                        reject(error);
                    }
                });
                return;
            }
            if (key.name === 'backspace') {
                value = value.slice(0, -1);
                return;
            }
            if (
                text
                && /^[\x21-\x7e]+$/.test(text)
                && Buffer.byteLength(value + text, 'utf8') <= MAX_SECRET_INPUT_BYTES
            ) {
                value += text;
            }
        };

        output.write(prompt);
        emitKeypressEvents(input);
        input.setRawMode(true);
        input.resume();
        input.on('keypress', onKeypress);
    });
}
