import { readHiddenLegalMcpSecretV1 } from './legal-mcp-secret-input';
import { PUBLIC_DATA_MCP_TOOL_NAMES } from '../services/public-data-mcp/server';
import { validateGisMcpRawBearerTokenV1 } from '../services/public-data-mcp/token-provisioning';

function assertExpectedGisMcpToolsV1(payload: unknown): void {
    if (!payload || typeof payload !== 'object') {
        throw new Error('MCP tools/list 응답 형식이 올바르지 않습니다.');
    }
    const result = (payload as { result?: unknown }).result;
    const tools = result && typeof result === 'object'
        ? (result as { tools?: unknown }).tools
        : undefined;
    if (!Array.isArray(tools)) {
        throw new Error('MCP tools/list 응답에 tools가 없습니다.');
    }

    const names = tools
        .map((tool) => (
            tool && typeof tool === 'object'
                ? (tool as { name?: unknown }).name
                : undefined
        ))
        .filter((name): name is string => typeof name === 'string')
        .sort();
    const expected = [...PUBLIC_DATA_MCP_TOOL_NAMES].sort();
    if (
        names.length !== expected.length
        || names.some((name, index) => name !== expected[index])
    ) {
        throw new Error('MCP tools/list 응답의 GIS 도구 구성이 예상과 다릅니다.');
    }
}

export function parseGisMcpSmokeEndpointV1(value: string): URL {
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
        throw new Error(
            'MCP endpoint는 credential, query, fragment가 없는 HTTPS URL이어야 합니다.'
        );
    }
    return endpoint;
}

export async function probeGisMcpBearerV1(
    endpointInput: string,
    bearerToken: string,
    fetchImpl: typeof fetch = fetch
): Promise<number> {
    const endpoint = parseGisMcpSmokeEndpointV1(endpointInput);
    validateGisMcpRawBearerTokenV1(bearerToken);
    const method = 'tools/list';
    const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
            Authorization: `Bearer ${bearerToken}`,
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'MCP-Protocol-Version': '2026-07-28',
            'MCP-Method': method,
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method,
            params: {
                _meta: {
                    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                    'io.modelcontextprotocol/clientInfo': {
                        name: 'tonghari-gis-bearer-smoke',
                        version: '1.0.0',
                    },
                    'io.modelcontextprotocol/clientCapabilities': {},
                },
            },
        }),
    });
    if (response.status !== 200) {
        await response.body?.cancel();
        return response.status;
    }
    let payload: unknown;
    try {
        payload = await response.json();
    } catch {
        throw new Error('MCP tools/list 응답을 JSON으로 해석할 수 없습니다.');
    }
    assertExpectedGisMcpToolsV1(payload);
    return response.status;
}

function parseEndpointArg(args: string[]): string {
    const index = args.indexOf('--endpoint');
    if (index < 0 || !args[index + 1] || args.length !== 2) {
        throw new Error(
            '사용법: npm run gis:mcp:smoke -- --endpoint https://api.tonghari.kr/gis-mcp'
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
        const status = await probeGisMcpBearerV1(endpoint, token);
        if (status !== 200) {
            throw new Error(`MCP Bearer smoke 실패: HTTP ${status}`);
        }
        process.stdout.write(
            'GIS MCP Bearer smoke passed (HTTP 200, expected tools verified).\n'
        );
    })().catch((error: unknown) => {
        process.stderr.write(
            `${error instanceof Error ? error.message : 'MCP smoke 실패'}\n`
        );
        process.exitCode = 1;
    });
}
