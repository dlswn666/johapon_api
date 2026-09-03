import { readHiddenLegalMcpSecretV1 } from './legal-mcp-secret-input';
import {
    addGisMcpRegistryClientV1,
    attestGisMcpRegistryClientV1,
    initGisMcpRegistryFromEnvironmentV1,
    GisMcpRegistryCommitStateUnknownError,
    listGisMcpRegistryClientsV1,
    matchGisMcpRegistryEnvironmentV1,
    revokeGisMcpRegistryClientV1,
    validateGisMcpRegistryFileV1,
    type GisMcpRegistryOperatorResultV1,
} from '../services/public-data-mcp/mcp-token-registry-operator';

type Command =
    | 'validate'
    | 'matches-env'
    | 'list'
    | 'attest-client'
    | 'add'
    | 'revoke'
    | 'init-from-env';

interface ParsedArguments {
    command: Command;
    path: string;
    clientId?: string;
    operationId?: string;
    replace: boolean;
}

function usage(): string {
    return [
        '사용법:',
        '  npm run gis:mcp:registry -- validate --path <absolute-path>',
        '  npm run gis:mcp:registry -- matches-env --path <absolute-path>',
        '  npm run gis:mcp:registry -- list --path <absolute-path>',
        '  npm run gis:mcp:registry -- attest-client --path <absolute-path> --client-id <client-id> --operation-id <operation-id>',
        '  npm run gis:mcp:registry -- add --path <absolute-path> --client-id <client-id> [--replace]',
        '  npm run gis:mcp:registry -- revoke --path <absolute-path> --client-id <client-id>',
        '  npm run gis:mcp:registry -- init-from-env --path <absolute-path>',
        '',
        'add의 tokenSha256는 argv/env가 아니라 hidden TTY 또는 stdin 한 줄로만 입력합니다.',
    ].join('\n');
}

function isCommand(value: string | undefined): value is Command {
    return value === 'validate'
        || value === 'matches-env'
        || value === 'list'
        || value === 'attest-client'
        || value === 'add'
        || value === 'revoke'
        || value === 'init-from-env';
}

function parseArguments(args: string[]): ParsedArguments {
    const command = args[0];
    if (!isCommand(command)) throw new Error(usage());

    let filePath: string | undefined;
    let clientId: string | undefined;
    let operationId: string | undefined;
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
        if (option === '--operation-id' && operationId === undefined && args[index + 1]) {
            operationId = args[index + 1];
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
        if (!clientId || operationId) throw new Error(usage());
    } else if (command === 'attest-client') {
        if (!clientId || !operationId || replace) throw new Error(usage());
    } else if (command === 'revoke') {
        if (!clientId || operationId || replace) throw new Error(usage());
    } else if (clientId || operationId || replace) {
        throw new Error(usage());
    }

    return { command, path: filePath, clientId, operationId, replace };
}

/** stdout에는 운영 확인에 필요한 비민감 필드만 직렬화한다. */
export function formatGisMcpRegistryCliResultV1(
    result: GisMcpRegistryOperatorResultV1
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
    if (result.action === 'attest-client') {
        if (!result.clientId || !/^[0-9a-f]{64}$/.test(result.tokenCommitment ?? '')) {
            throw new Error('client commitment 결과가 올바르지 않습니다.');
        }
        return `action=attest-client clientId=${result.clientId} clientCount=${result.clientCount} tokenCommitment=${result.tokenCommitment}`;
    }
    const clientId = result.clientId ? ` clientId=${result.clientId}` : '';
    return `action=${result.action}${clientId} clientCount=${result.clientCount}`;
}

export async function runGisMcpRegistryCliV1(args: string[]): Promise<string> {
    const parsed = parseArguments(args);
    if (parsed.command === 'validate') {
        return formatGisMcpRegistryCliResultV1(
            validateGisMcpRegistryFileV1(parsed.path)
        );
    }
    if (parsed.command === 'list') {
        return formatGisMcpRegistryCliResultV1(
            listGisMcpRegistryClientsV1(parsed.path)
        );
    }
    if (parsed.command === 'matches-env') {
        return formatGisMcpRegistryCliResultV1(
            matchGisMcpRegistryEnvironmentV1(parsed.path)
        );
    }
    if (parsed.command === 'attest-client') {
        return formatGisMcpRegistryCliResultV1(
            attestGisMcpRegistryClientV1(
                parsed.path,
                parsed.clientId as string,
                parsed.operationId as string
            )
        );
    }
    if (parsed.command === 'init-from-env') {
        return formatGisMcpRegistryCliResultV1(
            await initGisMcpRegistryFromEnvironmentV1(parsed.path)
        );
    }
    if (parsed.command === 'revoke') {
        return formatGisMcpRegistryCliResultV1(
            await revokeGisMcpRegistryClientV1(parsed.path, parsed.clientId as string)
        );
    }

    const tokenSha256 = await readHiddenLegalMcpSecretV1(
        'tokenSha256 입력(표시되지 않음): '
    );
    return formatGisMcpRegistryCliResultV1(
        await addGisMcpRegistryClientV1(
            parsed.path,
            { clientId: parsed.clientId as string, tokenSha256 },
            { replace: parsed.replace }
        )
    );
}

export function gisMcpRegistryCliExitCodeV1(error: unknown): number {
    return error instanceof GisMcpRegistryCommitStateUnknownError ? 75 : 1;
}

if (require.main === module) {
    void runGisMcpRegistryCliV1(process.argv.slice(2)).then(
        (output) => process.stdout.write(`${output}\n`),
        (error: unknown) => {
            process.stderr.write(
                `${error instanceof Error ? error.message : 'registry 작업 실패'}\n`
            );
            process.exitCode = gisMcpRegistryCliExitCodeV1(error);
        }
    );
}
