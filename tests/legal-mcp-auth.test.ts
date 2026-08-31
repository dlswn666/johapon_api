import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import {
    LEGAL_MCP_AUTH_EXPIRES_IN_SECONDS,
    LegalMcpAuthConfigurationError,
    createLegalMcpTokenVerifier,
} from '../src/middleware/legal-mcp-auth';
import {
    LEGAL_MCP_CLIENT_ID,
    LEGAL_MCP_REQUIRED_SCOPE,
} from '../src/services/legal-research/mcp-policy';

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('법률 MCP bearer 인증', () => {
    it('SHA-256 digest가 일치할 때 유한한 AuthInfo를 반환한다', async () => {
        const rawToken = 'legal-mcp-test-token';
        const nowMs = 1_800_000_000_000;
        const verifier = createLegalMcpTokenVerifier({
            tokenSha256: sha256(rawToken),
            now: () => nowMs,
        });

        const authInfo = await verifier.verifyAccessToken(rawToken);

        assert.equal(authInfo.clientId, LEGAL_MCP_CLIENT_ID);
        assert.deepEqual(authInfo.scopes, [LEGAL_MCP_REQUIRED_SCOPE]);
        assert.equal(
            authInfo.expiresAt,
            Math.floor(nowMs / 1000) + LEGAL_MCP_AUTH_EXPIRES_IN_SECONDS
        );
        assert.equal(Number.isFinite(authInfo.expiresAt), true);
        assert.match(String(authInfo.extra?.tokenId), /^[0-9a-f]{64}$/);
    });

    it('불일치 token은 원문이나 설정 digest를 노출하지 않고 invalid_token으로 닫는다', async () => {
        const configuredToken = 'configured-secret-token';
        const attemptedToken = 'attacker-supplied-token';
        const configuredDigest = sha256(configuredToken);
        const verifier = createLegalMcpTokenVerifier({
            tokenSha256: configuredDigest,
        });

        await assert.rejects(
            verifier.verifyAccessToken(attemptedToken),
            (error: unknown) => {
                assert.equal(error instanceof OAuthError, true);
                const oauthError = error as OAuthError;
                assert.equal(oauthError.code, OAuthErrorCode.InvalidToken);
                assert.equal(oauthError.message.includes(attemptedToken), false);
                assert.equal(oauthError.message.includes(configuredToken), false);
                assert.equal(oauthError.message.includes(configuredDigest), false);
                return true;
            }
        );
    });

    it('누락되거나 잘못된 token digest 설정은 시작 시 안전하게 거부한다', () => {
        for (const tokenSha256 of ['', 'too-short', 'g'.repeat(64)]) {
            assert.throws(
                () => createLegalMcpTokenVerifier({ tokenSha256 }),
                (error: unknown) => {
                    assert.equal(
                        error instanceof LegalMcpAuthConfigurationError,
                        true
                    );
                    if (tokenSha256.length > 0) {
                        assert.equal(String(error).includes(tokenSha256), false);
                    }
                    return true;
                }
            );
        }
    });
});
