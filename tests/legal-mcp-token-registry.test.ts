import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
    LEGAL_MCP_TOKEN_REGISTRY_MAX_CLIENTS,
    LegalMcpTokenRegistryConfigurationError,
    parseLegalMcpTokenRegistryJson,
    validateLegalMcpClientId,
} from '../src/middleware/legal-mcp-token-registry';

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function registry(clients: unknown[]): string {
    return JSON.stringify({ version: 1, clients });
}

function entry(clientId: string, token = clientId): Record<string, string> {
    return { clientId, tokenSha256: sha256(token) };
}

function assertConfigurationError(
    action: () => unknown,
    sensitiveValues: string[] = []
): void {
    assert.throws(action, (error: unknown) => {
        assert.equal(
            error instanceof LegalMcpTokenRegistryConfigurationError,
            true
        );
        for (const sensitiveValue of sensitiveValues) {
            assert.equal(String(error).includes(sensitiveValue), false);
        }
        return true;
    });
}

describe('법률 MCP token registry parser', () => {
    it('strict v1 registry를 파싱하고 digest를 canonical lowercase로 만든다', () => {
        const firstDigest = sha256('first-token');
        const secondDigest = sha256('second-token').toUpperCase();

        assert.deepEqual(
            parseLegalMcpTokenRegistryJson(registry([
                { clientId: 'client-one', tokenSha256: firstDigest },
                { clientId: 'client-two', tokenSha256: ` ${secondDigest} ` },
            ])),
            {
                version: 1,
                clients: [
                    { clientId: 'client-one', tokenSha256: firstDigest },
                    {
                        clientId: 'client-two',
                        tokenSha256: secondDigest.toLowerCase(),
                    },
                ],
            }
        );
    });

    it('clientId는 최대 64자의 lowercase ASCII slug만 허용한다', () => {
        assert.equal(validateLegalMcpClientId('client-01'), true);
        assert.equal(validateLegalMcpClientId('a'.repeat(64)), true);

        for (const clientId of [
            '',
            'Client',
            'client_name',
            '-client',
            'client-',
            'client--name',
            '한글-client',
            'a'.repeat(65),
        ]) {
            assert.equal(validateLegalMcpClientId(clientId), false);
            assertConfigurationError(
                () => parseLegalMcpTokenRegistryJson(registry([entry(clientId)]))
            );
        }
    });

    it('최상위와 client entry의 unknown key를 거부한다', () => {
        assertConfigurationError(() => parseLegalMcpTokenRegistryJson(
            JSON.stringify({
                version: 1,
                clients: [entry('client-one')],
                extra: true,
            })
        ));
        assertConfigurationError(() => parseLegalMcpTokenRegistryJson(registry([
            { ...entry('client-one'), extra: true },
        ])));
    });

    it('version, clients 타입, clients 개수 제한을 엄격히 검사한다', () => {
        assertConfigurationError(() => parseLegalMcpTokenRegistryJson(
            JSON.stringify({ version: 2, clients: [entry('client-one')] })
        ));
        assertConfigurationError(() => parseLegalMcpTokenRegistryJson(
            JSON.stringify({ version: 1, clients: {} })
        ));
        assertConfigurationError(() => parseLegalMcpTokenRegistryJson(registry([])));
        assertConfigurationError(() => parseLegalMcpTokenRegistryJson(registry(
            Array.from(
                { length: LEGAL_MCP_TOKEN_REGISTRY_MAX_CLIENTS + 1 },
                (_, index) => entry(`client-${index}`)
            )
        )));

        const maximumRegistry = parseLegalMcpTokenRegistryJson(registry(
            Array.from(
                { length: LEGAL_MCP_TOKEN_REGISTRY_MAX_CLIENTS },
                (_, index) => entry(`client-${index}`, `token-${index}`)
            )
        ));
        assert.equal(
            maximumRegistry.clients.length,
            LEGAL_MCP_TOKEN_REGISTRY_MAX_CLIENTS
        );
    });

    it('clientId와 canonical digest 중복을 각각 거부한다', () => {
        const duplicatedDigest = sha256('duplicated-token');
        assertConfigurationError(() => parseLegalMcpTokenRegistryJson(registry([
            entry('same-client', 'first'),
            entry('same-client', 'second'),
        ])));
        assertConfigurationError(() => parseLegalMcpTokenRegistryJson(registry([
            { clientId: 'first-client', tokenSha256: duplicatedDigest },
            {
                clientId: 'second-client',
                tokenSha256: duplicatedDigest.toUpperCase(),
            },
        ])), [duplicatedDigest]);
    });

    it('malformed JSON과 invalid digest 오류에 원문이나 digest를 노출하지 않는다', () => {
        const malformed = '{"secret-token-material":';
        assertConfigurationError(
            () => parseLegalMcpTokenRegistryJson(malformed),
            ['secret-token-material']
        );

        const invalidDigest = 'raw-secret-that-is-not-a-digest';
        assertConfigurationError(() => parseLegalMcpTokenRegistryJson(registry([
            { clientId: 'client-one', tokenSha256: invalidDigest },
        ])), [invalidDigest]);
    });
});
