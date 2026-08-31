import { readHiddenLegalMcpSecretV1 } from './legal-mcp-secret-input';
import { validateLegalMcpRawBearerTokenV1 } from '../services/legal-research/mcp-token-provisioning';
import {
    LEGAL_RENDER_TOOL_NAME,
    LEGAL_RESEARCH_TOOL_NAME,
} from '../services/legal-research/mcp-policy';

const EXPECTED_LEGAL_MCP_TOOL_NAMES = [
    LEGAL_RENDER_TOOL_NAME,
    LEGAL_RESEARCH_TOOL_NAME,
].sort();

function assertExpectedLegalMcpToolsV1(payload: unknown): void {
    if (!payload || typeof payload !== 'object') {
        throw new Error('MCP tools/list 응답 형식이 올바르지 않습니다.');
    }
    const result = (payload as { result?: unknown }).result;
    if (!result || typeof result !== 'object') {
        throw new Error('MCP tools/list 응답에 result가 없습니다.');
    }
    const tools = (result as { tools?: unknown }).tools;
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
    if (
        names.length !== EXPECTED_LEGAL_MCP_TOOL_NAMES.length
        || names.some((name, index) => name !== EXPECTED_LEGAL_MCP_TOOL_NAMES[index])
    ) {
        throw new Error('MCP tools/list 응답의 법률 도구 구성이 예상과 다릅니다.');
    }
}

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
                        name: 'tonghari-legal-bearer-smoke',
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
    assertExpectedLegalMcpToolsV1(payload);
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
        process.stdout.write('MCP Bearer smoke passed (HTTP 200, expected tools verified).\n');
    })().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : 'MCP smoke 실패'}\n`);
        process.exitCode = 1;
    });
}
