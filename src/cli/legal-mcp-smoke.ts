import { readHiddenLegalMcpSecretV1 } from './legal-mcp-secret-input';
import { validateLegalMcpRawBearerTokenV1 } from '../services/legal-research/mcp-token-provisioning';
import {
    LEGAL_RENDER_TOOL_NAME,
    LEGAL_RESEARCH_TOOL_NAME,
} from '../services/legal-research/mcp-policy';
import { TONGHARI_MCP_SUPPORTED_PROTOCOL_VERSIONS } from '../services/mcp-protocol';

const EXPECTED_LEGAL_MCP_TOOL_NAMES = [
    LEGAL_RENDER_TOOL_NAME,
    LEGAL_RESEARCH_TOOL_NAME,
].sort();
const [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION] =
    TONGHARI_MCP_SUPPORTED_PROTOCOL_VERSIONS;
export type LegalMcpSmokeProtocolVersion =
    | typeof MODERN_PROTOCOL_VERSION
    | typeof LEGACY_PROTOCOL_VERSION;

function assertSmokeProtocolVersion(
    value: string
): asserts value is LegalMcpSmokeProtocolVersion {
    if (value !== MODERN_PROTOCOL_VERSION && value !== LEGACY_PROTOCOL_VERSION) {
        throw new Error('MCP protocol version은 2026-07-28 또는 2025-06-18이어야 합니다.');
    }
}

async function readMcpJsonResponseV1(response: Response): Promise<unknown> {
    const text = await response.text();
    try {
        if (!response.headers.get('content-type')?.includes('text/event-stream')) {
            return JSON.parse(text);
        }
        const dataLines = text
            .replace(/\r\n/g, '\n')
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice('data:'.length).trimStart())
            .filter(Boolean);
        if (dataLines.length !== 1) {
            throw new Error('unexpected SSE message count');
        }
        return JSON.parse(dataLines[0]);
    } catch {
        throw new Error('MCP 응답을 JSON-RPC로 해석할 수 없습니다.');
    }
}

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
    fetchImpl: typeof fetch = fetch,
    protocolVersion: LegalMcpSmokeProtocolVersion = MODERN_PROTOCOL_VERSION
): Promise<number> {
    const endpoint = parseLegalMcpSmokeEndpointV1(endpointInput);
    validateLegalMcpRawBearerTokenV1(bearerToken);
    assertSmokeProtocolVersion(protocolVersion);
    const clientInfo = {
        name: 'tonghari-legal-bearer-smoke',
        version: '1.0.0',
    };
    const request = async (
        method: string,
        body: Record<string, unknown>
    ): Promise<Response> => fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
            Authorization: `Bearer ${bearerToken}`,
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'MCP-Protocol-Version': protocolVersion,
            'MCP-Method': method,
        },
        body: JSON.stringify(body),
    });

    if (protocolVersion === LEGACY_PROTOCOL_VERSION) {
        const initialized = await request('initialize', {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion,
                capabilities: {},
                clientInfo,
            },
        });
        if (initialized.status !== 200) {
            await initialized.body?.cancel();
            return initialized.status;
        }
        const initializedPayload = await readMcpJsonResponseV1(initialized);
        const negotiatedVersion = initializedPayload
            && typeof initializedPayload === 'object'
            && 'result' in initializedPayload
            && initializedPayload.result
            && typeof initializedPayload.result === 'object'
            && 'protocolVersion' in initializedPayload.result
            ? initializedPayload.result.protocolVersion
            : undefined;
        if (negotiatedVersion !== LEGACY_PROTOCOL_VERSION) {
            throw new Error('MCP initialize 응답이 요청한 legacy protocol을 선택하지 않았습니다.');
        }

        const acknowledged = await request('notifications/initialized', {
            jsonrpc: '2.0',
            method: 'notifications/initialized',
            params: {},
        });
        if (acknowledged.status !== 202) {
            await acknowledged.body?.cancel();
            return acknowledged.status;
        }
        await acknowledged.body?.cancel();
    }

    const method = 'tools/list';
    const response = await request(method, {
        jsonrpc: '2.0',
        id: protocolVersion === LEGACY_PROTOCOL_VERSION ? 2 : 1,
        method,
        params: protocolVersion === MODERN_PROTOCOL_VERSION
            ? {
                _meta: {
                    'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
                    'io.modelcontextprotocol/clientInfo': clientInfo,
                    'io.modelcontextprotocol/clientCapabilities': {},
                },
            }
            : {},
    });
    if (response.status !== 200) {
        await response.body?.cancel();
        return response.status;
    }
    let payload: unknown;
    try {
        payload = await readMcpJsonResponseV1(response);
    } catch {
        throw new Error('MCP tools/list 응답을 JSON으로 해석할 수 없습니다.');
    }
    assertExpectedLegalMcpToolsV1(payload);
    return response.status;
}

function parseSmokeArgs(args: string[]): {
    endpoint: string;
    protocolVersion: LegalMcpSmokeProtocolVersion;
} {
    const endpointIndex = args.indexOf('--endpoint');
    const protocolIndex = args.indexOf('--protocol-version');
    const expectedLength = protocolIndex < 0 ? 2 : 4;
    if (
        endpointIndex < 0
        || !args[endpointIndex + 1]
        || args.length !== expectedLength
    ) {
        throw new Error(
            '사용법: npm run legal:mcp:smoke -- --endpoint https://api.tonghari.kr/mcp [--protocol-version 2026-07-28|2025-06-18]'
        );
    }
    const protocolVersion = protocolIndex < 0
        ? MODERN_PROTOCOL_VERSION
        : args[protocolIndex + 1] ?? '';
    assertSmokeProtocolVersion(protocolVersion);
    return {
        endpoint: args[endpointIndex + 1],
        protocolVersion,
    };
}

if (require.main === module) {
    void (async () => {
        const { endpoint, protocolVersion } = parseSmokeArgs(
            process.argv.slice(2)
        );
        const token = await readHiddenLegalMcpSecretV1(
            'Bearer token 입력(표시되지 않음): '
        );
        const status = await probeLegalMcpBearerV1(
            endpoint,
            token,
            fetch,
            protocolVersion
        );
        if (status !== 200) {
            throw new Error(`MCP Bearer smoke 실패: HTTP ${status}`);
        }
        process.stdout.write('MCP Bearer smoke passed (HTTP 200, expected tools verified).\n');
    })().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : 'MCP smoke 실패'}\n`);
        process.exitCode = 1;
    });
}
