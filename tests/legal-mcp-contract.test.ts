import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    mkdtempSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {
    createServer,
    request as httpRequest,
    type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import {
    createLegalMcpRoute,
    parseLegalMcpHostnameAllowlist,
    type LegalMcpRouteHandle,
} from '../src/routes/legal-mcp';
import {
    createLegalMcpTokenRegistryFileProviderV1,
    type LegalMcpTokenRegistryFileProviderV1,
} from '../src/middleware/legal-mcp-token-registry-file';
import {
    LEGAL_MCP_CLIENT_ID,
    LEGAL_MCP_SERVER_INSTRUCTIONS,
    LEGAL_POLICY_RESOURCE_URI,
    LEGAL_RENDER_TOOL_NAME,
    LEGAL_RESEARCH_TOOL_NAME,
    LEGAL_REVIEW_PROMPT_NAME,
} from '../src/services/legal-research/mcp-policy';
import type {
    LegalMcpCallContext,
    LegalMcpServerDependencies,
} from '../src/services/legal-research/mcp-server';
import { LegalOpenApiError } from '../src/services/legal-research/errors';
import {
    createLegalPacketProofV1,
    packetProofSubjectV1,
} from '../src/services/legal-research/packet-proof';

const PROTOCOL_VERSION = '2026-07-28';
const RAW_TOKEN = 'legal-mcp-contract-token';
const TOKEN_SHA256 = createHash('sha256')
    .update(RAW_TOKEN, 'utf8')
    .digest('hex');
const RAW_PROXY_TOKEN = 'legal-mcp-contract-proxy-token-256-bit';
const PROXY_TOKEN_SHA256 = createHash('sha256')
    .update(RAW_PROXY_TOKEN, 'utf8')
    .digest('hex');
const RAW_CLIENT_A_TOKEN = 'legal-mcp-contract-client-a-token';
const RAW_CLIENT_B_TOKEN = 'legal-mcp-contract-client-b-token';
const CLIENT_A_TOKEN_SHA256 = createHash('sha256')
    .update(RAW_CLIENT_A_TOKEN, 'utf8')
    .digest('hex');
const CLIENT_B_TOKEN_SHA256 = createHash('sha256')
    .update(RAW_CLIENT_B_TOKEN, 'utf8')
    .digest('hex');
const TOKEN_REGISTRY_JSON = JSON.stringify({
    version: 1,
    clients: [
        { clientId: 'contract-client-a', tokenSha256: CLIENT_A_TOKEN_SHA256 },
        { clientId: 'contract-client-b', tokenSha256: CLIENT_B_TOKEN_SHA256 },
    ],
});
const PACKET_SIGNING_KEY = 'b'.repeat(64);
const NOW_MS = Date.parse('2026-08-31T03:00:00.000Z');

const REQUEST_META = {
    'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': {
        name: 'tonghari-legal-mcp-contract-test',
        version: '1.0.0',
    },
    'io.modelcontextprotocol/clientCapabilities': {},
};

const VALID_RESEARCH_INPUT = {
    question: '재건축 조합설립 동의 요건은 무엇인가요?',
    jurisdiction: {
        countryCode: 'KR' as const,
        organizationCode: '6110000',
        organizationName: '서울특별시',
    },
    projectType: 'reconstruction' as const,
    projectStage: 'association_establishment' as const,
    facts: [
        {
            factId: 'FACT-1',
            text: '조합설립 동의서를 징구 중이다.',
            provenance: 'USER_STATED' as const,
        },
    ],
    researchPlan: {
        issues: [
            {
                issueId: 'ISSUE-1',
                issue: '조합설립 동의율 요건',
                requestedOutcome: 'vote_threshold' as const,
            },
        ],
        lawAnchors: [
            {
                issueIds: ['ISSUE-1'],
                exactName: '도시 및 주거환경정비법',
                lawType: '법률',
                articleLabels: ['제35조'],
                issueTerms: ['조합설립', '동의율'],
            },
        ],
        ordinanceRequirement: 'not_required' as const,
        ordinanceAnchors: [],
        caseQueries: [
            {
                issueIds: ['ISSUE-1'],
                lawNames: ['도시 및 주거환경정비법'],
                articleLabels: ['제35조'],
                issueTerms: ['조합설립', '동의율'],
            },
        ],
    },
};

const VALID_ANSWER_DRAFT = {
    conclusion: {
        kind: 'supported' as const,
        text: '현행 법령의 요건을 확인했습니다.',
        sourceIds: ['law-1'],
        evidenceQuotes: [{ sourceId: 'law-1', quote: '법정 동의를 받아야 한다.' }],
    },
    ruleClaims: [{
        claimId: 'rule-1',
        text: '현행 법령의 요건을 확인했다.',
        sourceIds: ['law-1'],
        evidenceQuotes: [{ sourceId: 'law-1', quote: '법정 동의를 받아야 한다.' }],
    }],
    ordinanceAnalysis: [],
    caseSummary: '적격 판례 검색 결과를 패킷 순서대로 정리했습니다.',
    caseEvidenceQuotes: [],
    applications: [],
    temporalReview: {
        summary: '현재 시행 규정을 기준으로 검토했습니다.',
        sourceIds: [],
        evidenceQuotes: [],
        historicalLawRequired: false,
    },
    warnings: [],
};

type JsonObject = Record<string, any>;

interface RunningEndpoint {
    baseUrl: string;
    route: LegalMcpRouteHandle;
    server: Server;
    close(): Promise<void>;
}

interface StartEndpointOptions {
    packetSigningKey?: string;
    researchRequestsPerMinute?: number;
    globalResearchRequestsPerMinute?: number;
    tokenSha256?: string;
    tokenRegistryJson?: string;
    tokenRegistryFileProvider?: LegalMcpTokenRegistryFileProviderV1;
    proxyTokenSha256?: string;
}

function listen(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

function rawPost(
    url: string,
    headers: Record<string, string>,
    body: string
): Promise<{ status: number; body: string }> {
    const target = new URL(url);
    return new Promise((resolve, reject) => {
        const request = httpRequest({
            hostname: target.hostname,
            port: target.port,
            path: target.pathname,
            method: 'POST',
            headers,
        }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.once('error', reject);
            response.once('end', () => resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        request.once('error', reject);
        request.end(body);
    });
}

async function startEndpoint(
    dependencies: Omit<LegalMcpServerDependencies, 'packetSigningKey'>,
    options: StartEndpointOptions = {}
): Promise<RunningEndpoint> {
    const app = express();
    const route = createLegalMcpRoute({
        dependencies,
        allowedHosts: ['127.0.0.1'],
        allowedOrigins: ['app.tonghari.test'],
        ...(options.tokenRegistryFileProvider
            ? {
                tokenRegistryFile: '',
                tokenRegistryFileProvider: options.tokenRegistryFileProvider,
            }
            : options.tokenRegistryJson
                ? { tokenRegistryJson: options.tokenRegistryJson }
                : { tokenSha256: options.tokenSha256 ?? TOKEN_SHA256 }),
        proxyTokenSha256: options.proxyTokenSha256 ?? PROXY_TOKEN_SHA256,
        packetSigningKey: options.packetSigningKey ?? PACKET_SIGNING_KEY,
        researchRequestsPerMinute: options.researchRequestsPerMinute,
        globalResearchRequestsPerMinute:
            options.globalResearchRequestsPerMinute,
    });
    app.use('/mcp', route.router);
    const server = createServer(app);
    await listen(server);
    const address = server.address() as AddressInfo;

    return {
        baseUrl: `http://127.0.0.1:${address.port}/mcp`,
        route,
        server,
        async close(): Promise<void> {
            await route.close();
            await closeServer(server);
        },
    };
}

let requestId = 0;

function mcpName(method: string, params: JsonObject): string | undefined {
    if (method === 'tools/call' || method === 'prompts/get') {
        return typeof params.name === 'string' ? params.name : undefined;
    }
    if (method === 'resources/read') {
        return typeof params.uri === 'string' ? params.uri : undefined;
    }
    return undefined;
}

async function mcpRequest(
    baseUrl: string,
    method: string,
    params: JsonObject = {},
    options: {
        token?: string | null;
        origin?: string;
        host?: string;
        forwardedProto?: string | null;
        proxyToken?: string | null;
    } = {}
): Promise<{ response: Response; body: JsonObject }> {
    const name = mcpName(method, params);
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        'mcp-method': method,
    };
    if (options.forwardedProto !== null) {
        headers['x-forwarded-proto'] = options.forwardedProto ?? 'https';
    }
    if (options.proxyToken !== null) {
        headers['x-tonghari-mcp-proxy-token'] =
            options.proxyToken ?? RAW_PROXY_TOKEN;
    }
    if (name) headers['mcp-name'] = name;
    if (options.token !== null) {
        headers.authorization = `Bearer ${options.token ?? RAW_TOKEN}`;
    }
    if (options.origin) headers.origin = options.origin;
    if (options.host) headers.host = options.host;

    const response = await fetch(baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: ++requestId,
            method,
            params: {
                ...params,
                _meta: REQUEST_META,
            },
        }),
    });
    const body = await response.json() as JsonObject;
    return { response, body };
}

describe('법률 MCP 공개 계약', () => {
    let endpoint: RunningEndpoint;
    let researchCalls = 0;
    let renderCalls = 0;
    let packetValidationCalls = 0;
    let answerValidationCalls = 0;
    let answerBuildCalls = 0;
    let lastContext: LegalMcpCallContext | undefined;

    const packet = {
        contractVersion: 'LegalResearchPacketV1',
        packetId: 'packet-1',
        status: 'complete',
        scope: { asOfDate: '2026-08-31' },
        provenance: { generatedAt: '2026-08-31T03:00:00.000Z' },
    };

    const dependencies: Omit<LegalMcpServerDependencies, 'packetSigningKey'> = {
        now: () => NOW_MS,
        async research(_input, context) {
            researchCalls += 1;
            lastContext = context;
            return packet;
        },
        validatePacket(candidate) {
            packetValidationCalls += 1;
            return {
                ok: true,
                valid: true,
                value: candidate,
                errors: [],
                issues: [],
            };
        },
        buildAnswer(candidatePacket, answerDraft) {
            answerBuildCalls += 1;
            const draft = answerDraft as JsonObject;
            const conclusion = draft.conclusion as JsonObject;
            return {
                contractVersion: 'LegalAnswerV1',
                packetId: conclusion.text === 'packetId 불일치 테스트'
                    ? 'different-packet'
                    : (candidatePacket as JsonObject).packetId,
            };
        },
        validateAnswer(candidate, candidatePacket) {
            answerValidationCalls += 1;
            assert.equal(
                (candidatePacket as JsonObject).packetId,
                packet.packetId
            );
            return {
                ok: true,
                valid: true,
                value: candidate,
                errors: [],
                issues: [],
            };
        },
        async render(_packet, _answer, context) {
            renderCalls += 1;
            lastContext = context;
            return '## 1. 검토 결론\n\n검증된 답변입니다.';
        },
    };

    before(async () => {
        endpoint = await startEndpoint(dependencies);
    });

    after(async () => {
        await endpoint.close();
    });

    beforeEach(() => {
        researchCalls = 0;
        renderCalls = 0;
        packetValidationCalls = 0;
        answerValidationCalls = 0;
        answerBuildCalls = 0;
        lastContext = undefined;
    });

    it('instructions, 정확히 두 도구, versioned prompt/resource를 발견할 수 있다', async () => {
        const discover = await mcpRequest(endpoint.baseUrl, 'server/discover');
        assert.equal(discover.response.status, 200);
        assert.equal(
            discover.body.result.instructions,
            LEGAL_MCP_SERVER_INSTRUCTIONS
        );
        assert.match(
            discover.body.result.instructions,
            /정확히 하나의 issueId와 정확히 하나의 lawName/
        );

        const tools = await mcpRequest(endpoint.baseUrl, 'tools/list');
        assert.deepEqual(
            tools.body.result.tools.map((tool: JsonObject) => tool.name).sort(),
            [LEGAL_RENDER_TOOL_NAME, LEGAL_RESEARCH_TOOL_NAME].sort()
        );
        assert.equal(LEGAL_RESEARCH_TOOL_NAME, 'research_current_urban_renewal_law_v1');
        assert.equal(LEGAL_RENDER_TOOL_NAME, 'render_legal_answer_v1');
        const researchTool = tools.body.result.tools.find(
            (tool: JsonObject) => tool.name === LEGAL_RESEARCH_TOOL_NAME
        );
        const renderTool = tools.body.result.tools.find(
            (tool: JsonObject) => tool.name === LEGAL_RENDER_TOOL_NAME
        );
        assert.equal(
            researchTool.outputSchema.properties.packetProof.type,
            'string'
        );
        assert.equal(
            renderTool.inputSchema.properties.packetProof.type,
            'string'
        );
        assert.equal(renderTool.inputSchema.properties.answerDraft.type, 'object');
        assert.equal(renderTool.inputSchema.properties.answer, undefined);
        assert.equal(researchTool.annotations.readOnlyHint, true);
        assert.equal(renderTool.annotations.openWorldHint, false);

        const prompts = await mcpRequest(endpoint.baseUrl, 'prompts/list');
        assert.deepEqual(
            prompts.body.result.prompts.map((prompt: JsonObject) => prompt.name),
            [LEGAL_REVIEW_PROMPT_NAME]
        );

        const prompt = await mcpRequest(endpoint.baseUrl, 'prompts/get', {
            name: LEGAL_REVIEW_PROMPT_NAME,
            arguments: { question: '조합설립 동의율은?' },
        });
        assert.match(
            prompt.body.result.messages[0].content.text,
            new RegExp(LEGAL_RESEARCH_TOOL_NAME)
        );
        assert.match(
            prompt.body.result.messages[0].content.text,
            new RegExp(LEGAL_RENDER_TOOL_NAME)
        );
        assert.match(
            prompt.body.result.messages[0].content.text,
            /정확히 하나의 issueId와 정확히 하나의 lawName/
        );

        const resources = await mcpRequest(endpoint.baseUrl, 'resources/list');
        assert.deepEqual(
            resources.body.result.resources.map((resource: JsonObject) => resource.uri),
            [LEGAL_POLICY_RESOURCE_URI]
        );
        assert.equal(LEGAL_POLICY_RESOURCE_URI, 'tonghari-law://policy/current-answer/v1');
        assert.equal(
            resources.body.result.resources[0].title,
            '현행 정비사업 법률 답변 정책 v2'
        );
        assert.equal(
            resources.body.result.resources[0].annotations.lastModified,
            '2026-09-03T00:00:00+09:00'
        );

        const resource = await mcpRequest(endpoint.baseUrl, 'resources/read', {
            uri: LEGAL_POLICY_RESOURCE_URI,
        });
        assert.match(
            resource.body.result.contents[0].text,
            /## 고정 답변 순서/
        );
        assert.match(
            resource.body.result.contents[0].text,
            /^# 현행 정비사업 법률 답변 정책 v2/
        );
        assert.match(
            resource.body.result.contents[0].text,
            /packetProof/
        );
        assert.match(
            resource.body.result.contents[0].text,
            /정확히 하나의 issueId와 정확히 하나의 lawName/
        );
    });

    it('구조화 researchPlan을 검증한 뒤 subject-bound packetProof를 반환한다', async () => {
        const result = await mcpRequest(endpoint.baseUrl, 'tools/call', {
            name: LEGAL_RESEARCH_TOOL_NAME,
            arguments: VALID_RESEARCH_INPUT,
        });

        assert.equal(result.response.status, 200);
        assert.equal(result.body.result.isError, undefined);
        assert.deepEqual(result.body.result.structuredContent.packet, packet);
        assert.match(
            result.body.result.structuredContent.packetProof,
            /^hmac-sha256:[0-9a-f]{64}$/
        );
        assert.equal(researchCalls, 1);
        assert.equal(packetValidationCalls, 1);
        assert.equal(lastContext?.principal.clientId, LEGAL_MCP_CLIENT_ID);
        assert.deepEqual(lastContext?.principal.scopes, ['law:research']);
        assert.match(lastContext?.principal.tokenId ?? '', /^[0-9a-f]{64}$/);
        assert.equal('token' in (lastContext?.principal ?? {}), false);
    });

    it('검증된 packet+proof+answer만 고정 Markdown으로 렌더링한다', async () => {
        const researched = await mcpRequest(endpoint.baseUrl, 'tools/call', {
            name: LEGAL_RESEARCH_TOOL_NAME,
            arguments: VALID_RESEARCH_INPUT,
        });
        const { packet: researchedPacket, packetProof } =
            researched.body.result.structuredContent;

        packetValidationCalls = 0;
        const rendered = await mcpRequest(endpoint.baseUrl, 'tools/call', {
            name: LEGAL_RENDER_TOOL_NAME,
            arguments: {
                packet: researchedPacket,
                packetProof,
                answerDraft: VALID_ANSWER_DRAFT,
            },
        });

        assert.equal(rendered.response.status, 200);
        assert.equal(rendered.body.result.isError, undefined);
        assert.deepEqual(rendered.body.result.structuredContent, {
            packetId: 'packet-1',
            contractValidationPassed: true,
            markdown: '## 1. 검토 결론\n\n검증된 답변입니다.',
        });
        assert.equal(rendered.body.result.content[0].annotations.audience[0], 'user');
        assert.equal(packetValidationCalls, 1);
        assert.equal(answerBuildCalls, 1);
        assert.equal(answerValidationCalls, 1);
        assert.equal(renderCalls, 1);
    });

    it('packet, proof 또는 packetId가 변조되면 renderer 전에 fail-closed 한다', async () => {
        const researched = await mcpRequest(endpoint.baseUrl, 'tools/call', {
            name: LEGAL_RESEARCH_TOOL_NAME,
            arguments: VALID_RESEARCH_INPUT,
        });
        const { packet: researchedPacket, packetProof } =
            researched.body.result.structuredContent;

        packetValidationCalls = 0;
        const tampered = await mcpRequest(endpoint.baseUrl, 'tools/call', {
            name: LEGAL_RENDER_TOOL_NAME,
            arguments: {
                packet: { ...researchedPacket, status: 'partial' },
                packetProof,
                answerDraft: VALID_ANSWER_DRAFT,
            },
        });
        assert.equal(tampered.body.result.isError, true);
        assert.match(tampered.body.result.content[0].text, /PACKET_PROOF_INVALID/);
        assert.equal(packetValidationCalls, 0);
        assert.equal(answerValidationCalls, 0);
        assert.equal(renderCalls, 0);

        const mismatch = await mcpRequest(endpoint.baseUrl, 'tools/call', {
            name: LEGAL_RENDER_TOOL_NAME,
            arguments: {
                packet: researchedPacket,
                packetProof,
                answerDraft: {
                    ...VALID_ANSWER_DRAFT,
                    conclusion: {
                        ...VALID_ANSWER_DRAFT.conclusion,
                        text: 'packetId 불일치 테스트',
                    },
                },
            },
        });
        assert.equal(mismatch.body.result.isError, true);
        assert.match(mismatch.body.result.content[0].text, /PACKET_ANSWER_MISMATCH/);
        assert.equal(renderCalls, 0);
    });

    it('provider 제어값이 섞인 researchPlan은 구현 호출 전에 schema에서 차단한다', async () => {
        const invalidInput = {
            ...VALID_RESEARCH_INPUT,
            researchPlan: {
                ...VALID_RESEARCH_INPUT.researchPlan,
                lawAnchors: [{
                    ...VALID_RESEARCH_INPUT.researchPlan.lawAnchors[0],
                    issueTerms: ['동의&target=prec'],
                }],
            },
        };

        const result = await mcpRequest(endpoint.baseUrl, 'tools/call', {
            name: LEGAL_RESEARCH_TOOL_NAME,
            arguments: invalidInput,
        });

        assert.equal(result.response.status, 200);
        assert.equal(result.body.result.isError, true);
        assert.equal(researchCalls, 0);
    });

    it('Host, Origin, proxy 증명, bearer token 순서로 MCP dispatch 전에 검사한다', async () => {
        const badOrigin = await mcpRequest(
            endpoint.baseUrl,
            'tools/list',
            {},
            {
                token: null,
                origin: 'https://evil.example',
                forwardedProto: null,
                proxyToken: null,
            }
        );
        assert.equal(badOrigin.response.status, 403);

        const badHost = await rawPost(
            endpoint.baseUrl,
            {
                host: 'evil.example',
                'content-type': 'application/json',
            },
            JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        );
        assert.equal(badHost.status, 403);

        const missingProxyToken = await mcpRequest(
            endpoint.baseUrl,
            'tools/list',
            {},
            { token: null, proxyToken: null }
        );
        assert.equal(missingProxyToken.response.status, 403);
        assert.equal(
            missingProxyToken.body.code,
            'LEGAL_MCP_PROXY_FORBIDDEN'
        );

        const wrongProxyToken = await mcpRequest(
            endpoint.baseUrl,
            'tools/list',
            {},
            {
                token: null,
                proxyToken: 'wrong-legal-mcp-contract-proxy-token-256-bit',
            }
        );
        assert.equal(wrongProxyToken.response.status, 403);
        assert.equal(wrongProxyToken.body.code, 'LEGAL_MCP_PROXY_FORBIDDEN');

        const spoofedForwardedProto = await mcpRequest(
            endpoint.baseUrl,
            'tools/list',
            {},
            { token: null, forwardedProto: 'https, http' }
        );
        assert.equal(spoofedForwardedProto.response.status, 403);
        assert.equal(
            spoofedForwardedProto.body.code,
            'LEGAL_MCP_PROXY_FORBIDDEN'
        );

        const noToken = await mcpRequest(
            endpoint.baseUrl,
            'tools/list',
            {},
            { token: null }
        );
        assert.equal(noToken.response.status, 401);

        const badToken = await mcpRequest(
            endpoint.baseUrl,
            'tools/list',
            {},
            { token: 'wrong-token' }
        );
        assert.equal(badToken.response.status, 401);
        assert.equal(JSON.stringify(badToken.body).includes('wrong-token'), false);
    });

    it('JSON body를 256kb로 제한하고 malformed JSON을 안전한 오류로 바꾼다', async () => {
        const commonHeaders = {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${RAW_TOKEN}`,
            'x-forwarded-proto': 'https',
            'x-tonghari-mcp-proxy-token': RAW_PROXY_TOKEN,
        };
        const tooLarge = await fetch(endpoint.baseUrl, {
            method: 'POST',
            headers: commonHeaders,
            body: JSON.stringify({ value: 'x'.repeat(270 * 1024) }),
        });
        assert.equal(tooLarge.status, 413);
        assert.match(await tooLarge.text(), /exceeds 256kb/);

        const malformed = await fetch(endpoint.baseUrl, {
            method: 'POST',
            headers: commonHeaders,
            body: '{"jsonrpc":',
        });
        assert.equal(malformed.status, 400);
        assert.match(await malformed.text(), /must be valid JSON/);
    });

    it('packet signing key 누락·약한 값은 HTTP listen 전에 fail-closed 한다', async () => {
        for (const signingKey of ['', 'weak']) {
            await assert.rejects(
                startEndpoint(dependencies, { packetSigningKey: signingKey }),
                (error: unknown) => error instanceof Error
                    && error.name === 'LegalMcpRouteConfigurationError'
            );
        }
    });

    it('검증된 연구 패킷이 128kb를 넘으면 proof와 원문을 내보내지 않는다', async () => {
        const oversizedEndpoint = await startEndpoint({
            ...dependencies,
            research() {
                return {
                    contractVersion: 'LegalResearchPacketV1',
                    packetId: 'packet-too-large',
                    payload: 'x'.repeat(129 * 1024),
                };
            },
        });
        try {
            const result = await mcpRequest(
                oversizedEndpoint.baseUrl,
                'tools/call',
                {
                    name: LEGAL_RESEARCH_TOOL_NAME,
                    arguments: VALID_RESEARCH_INPUT,
                }
            );
            assert.equal(result.response.status, 200);
            assert.equal(result.body.result.isError, true);
            assert.match(result.body.result.content[0].text, /LEGAL_PACKET_TOO_LARGE/);
            assert.equal(JSON.stringify(result.body).includes('packet-too-large'), false);
        } finally {
            await oversizedEndpoint.close();
        }
    });

    it('provider 오류는 고정된 안전 코드와 메시지만 반환한다', async () => {
        const providerErrorEndpoint = await startEndpoint({
            ...dependencies,
            research() {
                throw new LegalOpenApiError('UPSTREAM_TIMEOUT');
            },
        });
        try {
            const result = await mcpRequest(
                providerErrorEndpoint.baseUrl,
                'tools/call',
                {
                    name: LEGAL_RESEARCH_TOOL_NAME,
                    arguments: VALID_RESEARCH_INPUT,
                }
            );
            const errorText = result.body.result.content[0].text;
            assert.equal(result.response.status, 200);
            assert.equal(result.body.result.isError, true);
            assert.match(errorText, /UPSTREAM_TIMEOUT/);
            assert.match(errorText, /제한 시간 안에 응답하지 않았습니다/);
            assert.equal(errorText.includes(VALID_RESEARCH_INPUT.question), false);
            assert.equal(errorText.includes('OC='), false);
        } finally {
            await providerErrorEndpoint.close();
        }
    });

    it('고비용 research 도구는 bearer 세대별 분당 상한을 적용한다', async () => {
        const limitedEndpoint = await startEndpoint(dependencies, {
            researchRequestsPerMinute: 1,
        });
        try {
            const first = await mcpRequest(limitedEndpoint.baseUrl, 'tools/call', {
                name: LEGAL_RESEARCH_TOOL_NAME,
                arguments: VALID_RESEARCH_INPUT,
            });
            const second = await mcpRequest(limitedEndpoint.baseUrl, 'tools/call', {
                name: LEGAL_RESEARCH_TOOL_NAME,
                arguments: VALID_RESEARCH_INPUT,
            });

            assert.equal(first.response.status, 200);
            assert.equal(second.response.status, 429);
            assert.equal(second.response.headers.get('retry-after') !== null, true);
            assert.equal(second.body.error.code, -32029);
        } finally {
            await limitedEndpoint.close();
        }
    });

    it('registry의 A/B bearer를 각각 인증하고 A의 proof를 B가 재사용하지 못한다', async () => {
        const registryEndpoint = await startEndpoint(dependencies, {
            tokenRegistryJson: TOKEN_REGISTRY_JSON,
        });
        try {
            const clientAList = await mcpRequest(
                registryEndpoint.baseUrl,
                'tools/list',
                {},
                { token: RAW_CLIENT_A_TOKEN }
            );
            const clientBList = await mcpRequest(
                registryEndpoint.baseUrl,
                'tools/list',
                {},
                { token: RAW_CLIENT_B_TOKEN }
            );
            assert.equal(clientAList.response.status, 200);
            assert.equal(clientBList.response.status, 200);

            const clientAResearch = await mcpRequest(
                registryEndpoint.baseUrl,
                'tools/call',
                {
                    name: LEGAL_RESEARCH_TOOL_NAME,
                    arguments: VALID_RESEARCH_INPUT,
                },
                { token: RAW_CLIENT_A_TOKEN }
            );
            assert.equal(clientAResearch.response.status, 200);
            assert.equal(lastContext?.principal.clientId, 'contract-client-a');

            const clientBResearch = await mcpRequest(
                registryEndpoint.baseUrl,
                'tools/call',
                {
                    name: LEGAL_RESEARCH_TOOL_NAME,
                    arguments: VALID_RESEARCH_INPUT,
                },
                { token: RAW_CLIENT_B_TOKEN }
            );
            assert.equal(clientBResearch.response.status, 200);
            assert.equal(lastContext?.principal.clientId, 'contract-client-b');

            const clientAProof =
                clientAResearch.body.result.structuredContent.packetProof;
            const clientBProof =
                clientBResearch.body.result.structuredContent.packetProof;
            assert.notEqual(clientAProof, clientBProof);

            const crossClientRender = await mcpRequest(
                registryEndpoint.baseUrl,
                'tools/call',
                {
                    name: LEGAL_RENDER_TOOL_NAME,
                    arguments: {
                        packet: clientAResearch.body.result.structuredContent.packet,
                        packetProof: clientAProof,
                        answerDraft: VALID_ANSWER_DRAFT,
                    },
                },
                { token: RAW_CLIENT_B_TOKEN }
            );
            assert.equal(crossClientRender.response.status, 200);
            assert.equal(crossClientRender.body.result.isError, true);
            assert.match(
                crossClientRender.body.result.content[0].text,
                /PACKET_PROOF_INVALID/
            );
            assert.equal(renderCalls, 0);
        } finally {
            await registryEndpoint.close();
        }
    });

    it('file provider route는 atomic 교체 직후 새 bearer를 허용하고 구 bearer를 폐기한다', async () => {
        const root = realpathSync(mkdtempSync(
            path.join(tmpdir(), 'legal-mcp-route-registry-')
        ));
        chmodSync(root, 0o700);
        const filePath = path.join(root, 'clients.json');
        const firstToken = 'file-route-first-token';
        const secondToken = 'file-route-second-token';
        const writeAtomic = (clientId: string, rawToken: string): void => {
            const temporaryPath = path.join(root, 'clients.next.json');
            writeFileSync(temporaryPath, JSON.stringify({
                version: 1,
                clients: [{
                    clientId,
                    tokenSha256: createHash('sha256')
                        .update(rawToken, 'utf8')
                        .digest('hex'),
                }],
            }), { encoding: 'utf8', mode: 0o600 });
            chmodSync(temporaryPath, 0o600);
            renameSync(temporaryPath, filePath);
        };

        let fileEndpoint: RunningEndpoint | undefined;
        try {
            writeAtomic('file-route-first', firstToken);
            fileEndpoint = await startEndpoint(dependencies, {
                tokenRegistryFileProvider:
                    createLegalMcpTokenRegistryFileProviderV1(filePath),
            });
            const first = await mcpRequest(
                fileEndpoint.baseUrl,
                'tools/list',
                {},
                { token: firstToken }
            );
            assert.equal(first.response.status, 200);

            writeAtomic('file-route-second', secondToken);
            const second = await mcpRequest(
                fileEndpoint.baseUrl,
                'tools/list',
                {},
                { token: secondToken }
            );
            const revoked = await mcpRequest(
                fileEndpoint.baseUrl,
                'tools/list',
                {},
                { token: firstToken }
            );
            assert.equal(second.response.status, 200);
            assert.equal(revoked.response.status, 401);
        } finally {
            await fileEndpoint?.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('registry bearer별 research 제한은 A와 B가 독립된 bucket을 사용한다', async () => {
        const registryEndpoint = await startEndpoint(dependencies, {
            tokenRegistryJson: TOKEN_REGISTRY_JSON,
            researchRequestsPerMinute: 1,
            globalResearchRequestsPerMinute: 10,
        });
        try {
            const clientAFirst = await mcpRequest(
                registryEndpoint.baseUrl,
                'tools/call',
                {
                    name: LEGAL_RESEARCH_TOOL_NAME,
                    arguments: VALID_RESEARCH_INPUT,
                },
                { token: RAW_CLIENT_A_TOKEN }
            );
            const clientASecond = await mcpRequest(
                registryEndpoint.baseUrl,
                'tools/call',
                {
                    name: LEGAL_RESEARCH_TOOL_NAME,
                    arguments: VALID_RESEARCH_INPUT,
                },
                { token: RAW_CLIENT_A_TOKEN }
            );
            const clientBFirst = await mcpRequest(
                registryEndpoint.baseUrl,
                'tools/call',
                {
                    name: LEGAL_RESEARCH_TOOL_NAME,
                    arguments: VALID_RESEARCH_INPUT,
                },
                { token: RAW_CLIENT_B_TOKEN }
            );

            assert.equal(clientAFirst.response.status, 200);
            assert.equal(clientASecond.response.status, 429);
            assert.equal(
                clientASecond.body.error.message,
                'Legal research bearer rate limit exceeded.'
            );
            assert.equal(clientBFirst.response.status, 200);
        } finally {
            await registryEndpoint.close();
        }
    });

    it('registry A/B research 호출은 process-wide global bucket을 공유한다', async () => {
        const registryEndpoint = await startEndpoint(dependencies, {
            tokenRegistryJson: TOKEN_REGISTRY_JSON,
            researchRequestsPerMinute: 10,
            globalResearchRequestsPerMinute: 2,
        });
        try {
            const clientAFirst = await mcpRequest(
                registryEndpoint.baseUrl,
                'tools/call',
                {
                    name: LEGAL_RESEARCH_TOOL_NAME,
                    arguments: VALID_RESEARCH_INPUT,
                },
                { token: RAW_CLIENT_A_TOKEN }
            );
            const clientBFirst = await mcpRequest(
                registryEndpoint.baseUrl,
                'tools/call',
                {
                    name: LEGAL_RESEARCH_TOOL_NAME,
                    arguments: VALID_RESEARCH_INPUT,
                },
                { token: RAW_CLIENT_B_TOKEN }
            );
            const clientASecond = await mcpRequest(
                registryEndpoint.baseUrl,
                'tools/call',
                {
                    name: LEGAL_RESEARCH_TOOL_NAME,
                    arguments: VALID_RESEARCH_INPUT,
                },
                { token: RAW_CLIENT_A_TOKEN }
            );

            assert.equal(clientAFirst.response.status, 200);
            assert.equal(clientBFirst.response.status, 200);
            assert.equal(clientASecond.response.status, 429);
            assert.equal(
                clientASecond.body.error.message,
                'Legal research process-wide rate limit exceeded.'
            );
            assert.equal(clientASecond.response.headers.get('retry-after') !== null, true);
        } finally {
            await registryEndpoint.close();
        }
    });

    it('서명이 유효해도 기준일이 지난 packet은 render 전에 재조사를 요구한다', async () => {
        const oldPacket = {
            ...packet,
            packetId: 'packet-old',
            scope: { asOfDate: '2020-01-01' },
            provenance: { generatedAt: '2020-01-01T00:00:00.000Z' },
        };
        const oldProof = createLegalPacketProofV1(
            oldPacket,
            packetProofSubjectV1(LEGAL_MCP_CLIENT_ID, TOKEN_SHA256),
            PACKET_SIGNING_KEY
        );

        const result = await mcpRequest(endpoint.baseUrl, 'tools/call', {
            name: LEGAL_RENDER_TOOL_NAME,
            arguments: {
                packet: oldPacket,
                packetProof: oldProof,
                answerDraft: VALID_ANSWER_DRAFT,
            },
        });

        assert.equal(result.response.status, 200);
        assert.equal(result.body.result.isError, true);
        assert.match(result.body.result.content[0].text, /LEGAL_PACKET_STALE/);
        assert.equal(answerBuildCalls, 0);
        assert.equal(renderCalls, 0);
    });
});

describe('법률 MCP hostname allowlist 설정', () => {
    it('hostname만 정규화하고 중복 제거한다', () => {
        assert.deepEqual(
            parseLegalMcpHostnameAllowlist(
                'API.TONGHARI.KR, api.tonghari.kr, [::1]',
                'TEST_ALLOWLIST'
            ),
            ['api.tonghari.kr', '[::1]']
        );
    });

    it('wildcard, URL, port와 빈 allowlist는 거부한다', () => {
        for (const value of [
            '',
            '*',
            'https://api.tonghari.kr',
            'api.tonghari.kr:443',
        ]) {
            assert.throws(() =>
                parseLegalMcpHostnameAllowlist(value, 'TEST_ALLOWLIST')
            );
        }
    });

    it('Origin allowlist는 비브라우저 전용 운영을 위해 명시적 빈 목록을 허용한다', () => {
        assert.deepEqual(
            parseLegalMcpHostnameAllowlist('', 'TEST_ORIGINS', true),
            []
        );
    });
});
