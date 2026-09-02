import {
    provisionGisMcpClientTokenV1,
    provisionGisMcpProxyTokenV1,
} from '../services/public-data-mcp/token-provisioning';
import { readHiddenLegalMcpSecretV1 } from './legal-mcp-secret-input';

type Command = 'client-generate' | 'client-digest' | 'proxy-generate';

function usage(): string {
    return [
        '사용법:',
        '  npm run gis:mcp:token -- client-generate --client-id <client-id>',
        '  npm run gis:mcp:token -- client-digest --client-id <client-id>',
        '  npm run gis:mcp:token -- proxy-generate',
    ].join('\n');
}

function parseClientId(args: string[]): string {
    const index = args.indexOf('--client-id');
    if (index < 0 || !args[index + 1] || args.length !== 2) {
        throw new Error(usage());
    }
    return args[index + 1];
}

export async function runGisMcpTokenCliV1(args: string[]): Promise<string> {
    const command = args[0] as Command | undefined;
    if (command === 'client-generate') {
        const provisioned = provisionGisMcpClientTokenV1(
            parseClientId(args.slice(1))
        );
        return [
            '주의: bearerToken 원문은 이번 한 번만 표시됩니다. 서버에는 저장하지 마세요.',
            `clientId=${provisioned.clientId}`,
            `bearerToken=${provisioned.bearerToken}`,
            `tokenSha256=${provisioned.tokenSha256}`,
            `registryEntry=${JSON.stringify(provisioned.registryEntry)}`,
        ].join('\n');
    }
    if (command === 'client-digest') {
        const clientId = parseClientId(args.slice(1));
        const bearerToken = await readHiddenLegalMcpSecretV1(
            '기존 Bearer token 입력(표시되지 않음): '
        );
        const provisioned = provisionGisMcpClientTokenV1(clientId, {
            bearerToken,
        });
        return [
            `clientId=${provisioned.clientId}`,
            `tokenSha256=${provisioned.tokenSha256}`,
            `registryEntry=${JSON.stringify(provisioned.registryEntry)}`,
        ].join('\n');
    }
    if (command === 'proxy-generate' && args.length === 1) {
        const provisioned = provisionGisMcpProxyTokenV1();
        return [
            '주의: proxyToken 원문은 Caddy의 owner-only secret에만 저장합니다.',
            `proxyToken=${provisioned.proxyToken}`,
            `proxyTokenSha256=${provisioned.proxyTokenSha256}`,
        ].join('\n');
    }
    throw new Error(usage());
}

if (require.main === module) {
    void runGisMcpTokenCliV1(process.argv.slice(2)).then(
        (output) => process.stdout.write(`${output}\n`),
        (error: unknown) => {
            process.stderr.write(
                `${error instanceof Error ? error.message : 'token 작업 실패'}\n`
            );
            process.exitCode = 1;
        }
    );
}
