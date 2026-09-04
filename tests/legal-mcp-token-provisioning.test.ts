import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { normalizeLegalMcpSecretInputV1 } from '../src/cli/legal-mcp-secret-input';
import {
    parseLegalMcpSmokeEndpointV1,
    probeLegalMcpBearerV1,
} from '../src/cli/legal-mcp-smoke';
import {
    formatLegalMcpTokenRegistryJsonV1,
    provisionLegalMcpClientTokenV1,
    provisionLegalMcpProxyTokenV1,
} from '../src/services/legal-research/mcp-token-provisioning';

describe('법률 MCP token provisioning', () => {
    it('256-bit 난수에서 client token과 서버용 digest를 결정적으로 만든다', () => {
        const entropy = Buffer.alloc(32, 7);
        const provisioned = provisionLegalMcpClientTokenV1('codex-mac-202609', {
            randomBytesFactory: () => entropy,
        });

        assert.match(provisioned.bearerToken, /^tlmcp_v1_[A-Za-z0-9_-]+$/);
        assert.equal(
            provisioned.tokenSha256,
            createHash('sha256').update(provisioned.bearerToken).digest('hex')
        );
        assert.deepEqual(provisioned.registryEntry, {
            clientId: 'codex-mac-202609',
            tokenSha256: provisioned.tokenSha256,
        });
    });

    it('proxy token은 client token과 다른 prefix와 digest를 사용한다', () => {
        const provisioned = provisionLegalMcpProxyTokenV1(() => Buffer.alloc(32, 9));
        assert.match(provisioned.proxyToken, /^tlmcp_proxy_v1_/);
        assert.equal(
            provisioned.proxyTokenSha256,
            createHash('sha256').update(provisioned.proxyToken).digest('hex')
        );
    });

    it('registry formatter는 strict parser를 다시 통과시키며 중복을 거부한다', () => {
        const first = provisionLegalMcpClientTokenV1('codex-a', {
            randomBytesFactory: () => Buffer.alloc(32, 1),
        });
        const second = provisionLegalMcpClientTokenV1('claude-b', {
            randomBytesFactory: () => Buffer.alloc(32, 2),
        });
        assert.deepEqual(JSON.parse(formatLegalMcpTokenRegistryJsonV1([
            first.registryEntry,
            second.registryEntry,
        ])), {
            version: 1,
            clients: [first.registryEntry, second.registryEntry],
        });
        assert.throws(() => formatLegalMcpTokenRegistryJsonV1([
            first.registryEntry,
            first.registryEntry,
        ]));
    });

    it('기존 token 입력은 한 줄만 허용하고 원문을 정규화 외 변경하지 않는다', () => {
        const token = `tlmcp_v1_${'a'.repeat(43)}`;
        assert.equal(normalizeLegalMcpSecretInputV1(`${token}\n`), token);
        assert.throws(() => normalizeLegalMcpSecretInputV1(''));
        assert.throws(() => normalizeLegalMcpSecretInputV1(`${token}\nextra`));
    });

    it('smoke endpoint는 HTTPS와 credential 없는 URL만 허용한다', () => {
        assert.equal(
            parseLegalMcpSmokeEndpointV1('https://api.tonghari.kr/mcp').href,
            'https://api.tonghari.kr/mcp'
        );
        assert.throws(() => parseLegalMcpSmokeEndpointV1('http://api.tonghari.kr/mcp'));
        assert.throws(() => parseLegalMcpSmokeEndpointV1('https://user:pass@api.tonghari.kr/mcp'));
        assert.throws(() => parseLegalMcpSmokeEndpointV1('https://api.tonghari.kr/mcp?token=x'));
    });

    it('smoke 요청은 token을 Authorization에만 넣고 redirect를 거부한다', async () => {
        const token = `tlmcp_v1_${'b'.repeat(43)}`;
        let captured: RequestInit | undefined;
        const status = await probeLegalMcpBearerV1(
            'https://api.tonghari.kr/mcp',
            token,
            (async (_input: string | URL | Request, init?: RequestInit) => {
                captured = init;
                return Response.json({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        tools: [
                            { name: 'research_current_urban_renewal_law_v1' },
                            { name: 'render_legal_answer_v1' },
                        ],
                    },
                });
            }) as typeof fetch
        );

        assert.equal(status, 200);
        assert.equal(captured?.redirect, 'error');
        const headers = captured?.headers as Record<string, string>;
        assert.equal(headers.Authorization, `Bearer ${token}`);
        assert.equal(headers['MCP-Protocol-Version'], '2026-07-28');
        assert.equal(headers['MCP-Method'], 'tools/list');
        assert.equal(String(captured?.body).includes(token), false);
        const body = JSON.parse(String(captured?.body));
        assert.equal(body.method, 'tools/list');
        assert.equal(
            body.params._meta['io.modelcontextprotocol/protocolVersion'],
            '2026-07-28'
        );
    });

    it('smoke는 HTTP 200이어도 예상한 두 법률 도구가 아니면 실패한다', async () => {
        const token = `tlmcp_v1_${'c'.repeat(43)}`;
        await assert.rejects(
            probeLegalMcpBearerV1(
                'https://api.tonghari.kr/mcp',
                token,
                (async () => Response.json({
                    jsonrpc: '2.0',
                    id: 1,
                    result: { tools: [{ name: 'unexpected_tool' }] },
                })) as typeof fetch
            ),
            /법률 도구 구성이 예상과 다릅니다/
        );
    });

    it('2025-06-18 smoke는 initialize, initialized, tools/list 순서와 SSE 응답을 검증한다', async () => {
        const token = `tlmcp_v1_${'d'.repeat(43)}`;
        const captured: RequestInit[] = [];
        const fetchImpl = (async (
            _input: string | URL | Request,
            init?: RequestInit
        ) => {
            captured.push(init ?? {});
            const body = JSON.parse(String(init?.body));
            if (body.method === 'initialize') {
                return new Response(
                    `data: ${JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        result: { protocolVersion: '2025-06-18' },
                    })}\n\n`,
                    { status: 200, headers: { 'content-type': 'text/event-stream' } }
                );
            }
            if (body.method === 'notifications/initialized') {
                return new Response(null, { status: 202 });
            }
            return new Response(
                `data: ${JSON.stringify({
                    jsonrpc: '2.0',
                    id: 2,
                    result: {
                        tools: [
                            { name: 'research_current_urban_renewal_law_v1' },
                            { name: 'render_legal_answer_v1' },
                        ],
                    },
                })}\n\n`,
                { status: 200, headers: { 'content-type': 'text/event-stream' } }
            );
        }) as typeof fetch;

        const status = await probeLegalMcpBearerV1(
            'https://api.tonghari.kr/mcp',
            token,
            fetchImpl,
            '2025-06-18'
        );

        assert.equal(status, 200);
        assert.deepEqual(
            captured.map((init) => JSON.parse(String(init.body)).method),
            ['initialize', 'notifications/initialized', 'tools/list']
        );
        for (const init of captured) {
            const headers = init.headers as Record<string, string>;
            const body = JSON.parse(String(init.body));
            assert.equal(headers.Authorization, `Bearer ${token}`);
            assert.equal(headers['MCP-Protocol-Version'], '2025-06-18');
            assert.equal(headers['MCP-Method'], body.method);
            assert.equal(String(init.body).includes(token), false);
            assert.equal(body.params._meta, undefined);
        }
    });
});
