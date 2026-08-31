import { readHiddenLegalMcpSecretV1 } from './legal-mcp-secret-input';
import { validateLegalMcpRawBearerTokenV1 } from '../services/legal-research/mcp-token-provisioning';

export function parseLegalMcpSmokeEndpointV1(value: string): URL {
    let endpoint: URL;
    try {
        endpoint = new URL(value);
    } catch {
        throw new Error('MCP endpoint는 유효한 HTTPS URL이어야 합니다.');
    }
    if (
        endpoint.protocol !== 'https:'
        || endpoint.username
        || endpoint.password
        || endpoint.search
        || endpoint.hash
    ) {
        throw new Error('MCP endpoint는 credential, query, fragment가 없는 HTTPS URL이어야 합니다.');
    }
    return endpoint;
}

export async function probeLegalMcpBearerV1(
    endpointInput: string,
    bearerToken: string,
    fetchImpl: typeof fetch = fetch
): Promise<number> {
    const endpoint = parseLegalMcpSmokeEndpointV1(endpointInput);
    validateLegalMcpRawBearerTokenV1(bearerToken);
    const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
            Authorization: `Bearer ${bearerToken}`,
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'MCP-Protocol-Version': '2026-07-28',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2026-07-28',
                capabilities: {},
                clientInfo: {
                    name: 'tonghari-legal-bearer-smoke',
                    version: '1.0.0',
                },
            },
        }),
    });
    await response.body?.cancel();
    return response.status;
}

function parseEndpointArg(args: string[]): string {
    const index = args.indexOf('--endpoint');
    if (index < 0 || !args[index + 1] || args.length !== 2) {
        throw new Error(
            '사용법: npm run legal:mcp:smoke -- --endpoint https://api.tonghari.kr/mcp'
        );
    }
    return args[index + 1];
}

if (require.main === module) {
    void (async () => {
        const endpoint = parseEndpointArg(process.argv.slice(2));
        const token = await readHiddenLegalMcpSecretV1(
            'Bearer token 입력(표시되지 않음): '
        );
        const status = await probeLegalMcpBearerV1(endpoint, token);
        if (status !== 200) {
            throw new Error(`MCP Bearer smoke 실패: HTTP ${status}`);
        }
        process.stdout.write('MCP Bearer smoke passed (HTTP 200).\n');
    })().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : 'MCP smoke 실패'}\n`);
        process.exitCode = 1;
    });
}
