import { readHiddenLegalMcpSecretV1 } from './legal-mcp-secret-input';
import {
    addLegalMcpRegistryClientV1,
    initLegalMcpRegistryFromEnvironmentV1,
    LegalMcpRegistryCommitStateUnknownError,
    listLegalMcpRegistryClientsV1,
    matchLegalMcpRegistryEnvironmentV1,
    revokeLegalMcpRegistryClientV1,
    validateLegalMcpRegistryFileV1,
    type LegalMcpRegistryOperatorResultV1,
} from '../services/legal-research/mcp-token-registry-operator';

type Command =
    | 'validate'
    | 'matches-env'
    | 'list'
    | 'add'
    | 'revoke'
    | 'init-from-env';

interface ParsedArguments {
    command: Command;
    path: string;
    clientId?: string;
    replace: boolean;
}

function usage(): string {
    return [
        '사용법:',
        '  npm run legal:mcp:registry -- validate --path <absolute-path>',
        '  npm run legal:mcp:registry -- matches-env --path <absolute-path>',
        '  npm run legal:mcp:registry -- list --path <absolute-path>',
        '  npm run legal:mcp:registry -- add --path <absolute-path> --client-id <client-id> [--replace]',
        '  npm run legal:mcp:registry -- revoke --path <absolute-path> --client-id <client-id>',
        '  npm run legal:mcp:registry -- init-from-env --path <absolute-path>',
        '',
        'add의 tokenSha256는 argv/env가 아니라 hidden TTY 또는 stdin 한 줄로만 입력합니다.',
    ].join('\n');
}

function isCommand(value: string | undefined): value is Command {
    return value === 'validate'
        || value === 'matches-env'
        || value === 'list'
        || value === 'add'
        || value === 'revoke'
        || value === 'init-from-env';
}

function parseArguments(args: string[]): ParsedArguments {
    const command = args[0];
    if (!isCommand(command)) throw new Error(usage());

    let filePath: string | undefined;
    let clientId: string | undefined;
    let replace = false;
    for (let index = 1; index < args.length; index += 1) {
        const option = args[index];
        if (option === '--path' && filePath === undefined && args[index + 1]) {
            filePath = args[index + 1];
            index += 1;
            continue;
        }
        if (option === '--client-id' && clientId === undefined && args[index + 1]) {
            clientId = args[index + 1];
            index += 1;
            continue;
        }
        if (option === '--replace' && replace === false) {
            replace = true;
            continue;
        }
        throw new Error(usage());
    }

    if (!filePath) throw new Error(usage());
    if (command === 'add') {
        if (!clientId) throw new Error(usage());
    } else if (command === 'revoke') {
        if (!clientId || replace) throw new Error(usage());
    } else if (clientId || replace) {
        throw new Error(usage());
    }

    return { command, path: filePath, clientId, replace };
}

/** stdout에는 운영 확인에 필요한 비민감 필드만 직렬화한다. */
export function formatLegalMcpRegistryCliResultV1(
    result: LegalMcpRegistryOperatorResultV1
): string {
    if (result.action === 'validate' || result.action === 'matches-env') {
        return `clientCount=${result.clientCount}`;
    }
    if (result.action === 'list') {
        return [
            `action=list clientCount=${result.clientCount}`,
            ...(result.clientIds ?? []).map((clientId) => `clientId=${clientId}`),
        ].join('\n');
    }
    const clientId = result.clientId ? ` clientId=${result.clientId}` : '';
    return `action=${result.action}${clientId} clientCount=${result.clientCount}`;
}

export async function runLegalMcpRegistryCliV1(args: string[]): Promise<string> {
    const parsed = parseArguments(args);
    if (parsed.command === 'validate') {
        return formatLegalMcpRegistryCliResultV1(
            validateLegalMcpRegistryFileV1(parsed.path)
        );
    }
    if (parsed.command === 'list') {
        return formatLegalMcpRegistryCliResultV1(
            listLegalMcpRegistryClientsV1(parsed.path)
        );
    }
    if (parsed.command === 'matches-env') {
        return formatLegalMcpRegistryCliResultV1(
            matchLegalMcpRegistryEnvironmentV1(parsed.path)
        );
    }
    if (parsed.command === 'init-from-env') {
        return formatLegalMcpRegistryCliResultV1(
            await initLegalMcpRegistryFromEnvironmentV1(parsed.path)
        );
    }
    if (parsed.command === 'revoke') {
        return formatLegalMcpRegistryCliResultV1(
            await revokeLegalMcpRegistryClientV1(parsed.path, parsed.clientId as string)
        );
    }

    const tokenSha256 = await readHiddenLegalMcpSecretV1(
        'tokenSha256 입력(표시되지 않음): '
    );
    return formatLegalMcpRegistryCliResultV1(
        await addLegalMcpRegistryClientV1(
            parsed.path,
            { clientId: parsed.clientId as string, tokenSha256 },
            { replace: parsed.replace }
        )
    );
}

export function legalMcpRegistryCliExitCodeV1(error: unknown): number {
    return error instanceof LegalMcpRegistryCommitStateUnknownError ? 75 : 1;
}

if (require.main === module) {
    void runLegalMcpRegistryCliV1(process.argv.slice(2)).then(
        (output) => process.stdout.write(`${output}\n`),
        (error: unknown) => {
            process.stderr.write(
                `${error instanceof Error ? error.message : 'registry 작업 실패'}\n`
            );
            process.exitCode = legalMcpRegistryCliExitCodeV1(error);
        }
    );
}
