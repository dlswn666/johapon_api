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
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import { createLegalMcpTokenRegistryFileProviderV1 } from '../src/middleware/legal-mcp-token-registry-file';

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

    it('legacy 단일 digest 설정의 principal 형식을 그대로 유지한다', async () => {
        const rawToken = 'legacy-compatible-token';
        const tokenDigest = sha256(rawToken);
        const nowMs = 1_800_000_000_000;
        const verifier = createLegalMcpTokenVerifier({
            tokenSha256: tokenDigest,
            tokenRegistryJson: '',
            now: () => nowMs,
        });

        assert.deepEqual(await verifier.verifyAccessToken(rawToken), {
            token: rawToken,
            clientId: LEGAL_MCP_CLIENT_ID,
            scopes: [LEGAL_MCP_REQUIRED_SCOPE],
            expiresAt:
                Math.floor(nowMs / 1000)
                + LEGAL_MCP_AUTH_EXPIRES_IN_SECONDS,
            extra: {
                tokenId: tokenDigest,
            },
        });
    });

    it('registry token을 해당 clientId principal로 인증한다', async () => {
        const firstToken = 'external-client-a-token';
        const secondToken = 'external-client-b-token';
        const nowMs = 1_800_000_000_000;
        const verifier = createLegalMcpTokenVerifier({
            tokenSha256: '',
            tokenRegistryJson: JSON.stringify({
                version: 1,
                clients: [
                    {
                        clientId: 'external-client-a',
                        tokenSha256: sha256(firstToken),
                    },
                    {
                        clientId: 'external-client-b',
                        tokenSha256: sha256(secondToken),
                    },
                ],
            }),
            now: () => nowMs,
        });

        const firstAuth = await verifier.verifyAccessToken(firstToken);
        const secondAuth = await verifier.verifyAccessToken(secondToken);

        assert.equal(firstAuth.clientId, 'external-client-a');
        assert.equal(firstAuth.extra?.tokenId, sha256(firstToken));
        assert.equal(secondAuth.clientId, 'external-client-b');
        assert.equal(secondAuth.extra?.tokenId, sha256(secondToken));
        assert.deepEqual(firstAuth.scopes, [LEGAL_MCP_REQUIRED_SCOPE]);
        assert.deepEqual(secondAuth.scopes, [LEGAL_MCP_REQUIRED_SCOPE]);
        assert.equal(
            secondAuth.expiresAt,
            Math.floor(nowMs / 1000) + LEGAL_MCP_AUTH_EXPIRES_IN_SECONDS
        );
    });

    it('registry와 legacy digest 동시설정은 secret을 노출하지 않고 시작 시 거부한다', () => {
        const legacyDigest = sha256('legacy-secret');
        const registryDigest = sha256('registry-secret');

        assert.throws(
            () => createLegalMcpTokenVerifier({
                tokenSha256: legacyDigest,
                tokenRegistryJson: JSON.stringify({
                    version: 1,
                    clients: [{
                        clientId: 'external-client',
                        tokenSha256: registryDigest,
                    }],
                }),
            }),
            (error: unknown) => {
                assert.equal(
                    error instanceof LegalMcpAuthConfigurationError,
                    true
                );
                assert.equal(String(error).includes(legacyDigest), false);
                assert.equal(String(error).includes(registryDigest), false);
                return true;
            }
        );
    });

    it('registry 인증 실패는 입력 token과 등록 digest를 노출하지 않는다', async () => {
        const registeredToken = 'registered-secret-token';
        const attemptedToken = 'unregistered-secret-token';
        const registeredDigest = sha256(registeredToken);
        const verifier = createLegalMcpTokenVerifier({
            tokenSha256: '',
            tokenRegistryJson: JSON.stringify({
                version: 1,
                clients: [{
                    clientId: 'external-client',
                    tokenSha256: registeredDigest,
                }],
            }),
        });

        await assert.rejects(
            verifier.verifyAccessToken(attemptedToken),
            (error: unknown) => {
                assert.equal(error instanceof OAuthError, true);
                assert.equal((error as OAuthError).code, OAuthErrorCode.InvalidToken);
                assert.equal(String(error).includes(attemptedToken), false);
                assert.equal(String(error).includes(registeredToken), false);
                assert.equal(String(error).includes(registeredDigest), false);
                return true;
            }
        );
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

    it('잘못된 registry는 auth configuration 오류로 변환한다', () => {
        const digest = sha256('must-not-leak');
        assert.throws(
            () => createLegalMcpTokenVerifier({
                tokenSha256: '',
                tokenRegistryJson: JSON.stringify({
                    version: 1,
                    clients: [{
                        clientId: 'INVALID_CLIENT',
                        tokenSha256: digest,
                    }],
                }),
            }),
            (error: unknown) => {
                assert.equal(
                    error instanceof LegalMcpAuthConfigurationError,
                    true
                );
                assert.equal(String(error).includes(digest), false);
                return true;
            }
        );
    });

    it('보호 파일 atomic 교체를 다음 인증에서 읽고 stale token을 즉시 폐기한다', async () => {
        const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'legal-mcp-auth-')));
        chmodSync(root, 0o700);
        const filePath = path.join(root, 'clients.json');
        const firstToken = 'file-client-first-token';
        const secondToken = 'file-client-second-token';
        const recoveredToken = 'file-client-recovered-token';
        const writeAtomic = (clientId: string, token: string): void => {
            const temporaryPath = path.join(root, 'clients.next.json');
            writeFileSync(temporaryPath, JSON.stringify({
                version: 1,
                clients: [{ clientId, tokenSha256: sha256(token) }],
            }), { encoding: 'utf8', mode: 0o600 });
            chmodSync(temporaryPath, 0o600);
            renameSync(temporaryPath, filePath);
        };

        try {
            writeAtomic('file-client-first', firstToken);
            const provider = createLegalMcpTokenRegistryFileProviderV1(filePath);
            const verifier = createLegalMcpTokenVerifier({
                tokenSha256: '',
                tokenRegistryJson: '',
                tokenRegistryFile: '',
                tokenRegistryFileProvider: provider,
            });
            assert.equal(
                (await verifier.verifyAccessToken(firstToken)).clientId,
                'file-client-first'
            );

            writeAtomic('file-client-second', secondToken);
            assert.equal(
                (await verifier.verifyAccessToken(secondToken)).clientId,
                'file-client-second'
            );
            await assert.rejects(
                verifier.verifyAccessToken(firstToken),
                (error: unknown) => error instanceof OAuthError
                    && error.code === OAuthErrorCode.InvalidToken
            );

            writeFileSync(path.join(root, 'clients.next.json'), '{', {
                encoding: 'utf8',
                mode: 0o600,
            });
            renameSync(path.join(root, 'clients.next.json'), filePath);
            await assert.rejects(
                verifier.verifyAccessToken(secondToken),
                (error: unknown) => error instanceof OAuthError
                    && error.code === OAuthErrorCode.InvalidToken
            );

            writeAtomic('file-client-recovered', recoveredToken);
            assert.equal(
                (await verifier.verifyAccessToken(recoveredToken)).clientId,
                'file-client-recovered'
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('교체 전 inspection이 멈춰 있어도 교체 뒤 요청은 새 세대로 인증한다', async () => {
        const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'legal-mcp-order-')));
        chmodSync(root, 0o700);
        const filePath = path.join(root, 'clients.json');
        const oldToken = 'ordering-old-token';
        const newToken = 'ordering-new-token';
        const writeAtomic = (clientId: string, token: string): void => {
            const temporaryPath = path.join(root, 'clients.next.json');
            writeFileSync(temporaryPath, JSON.stringify({
                version: 1,
                clients: [{ clientId, tokenSha256: sha256(token) }],
            }), { encoding: 'utf8', mode: 0o600 });
            chmodSync(temporaryPath, 0o600);
            renameSync(temporaryPath, filePath);
        };
        let announcePaused!: () => void;
        const paused = new Promise<void>((resolve) => {
            announcePaused = resolve;
        });
        let releaseInspection!: () => void;
        const inspectionReleased = new Promise<void>((resolve) => {
            releaseInspection = resolve;
        });
        let completedInspections = 0;
        let requestBeforeReplace: Promise<unknown> | null = null;

        try {
            writeAtomic('ordering-old', oldToken);
            const provider = createLegalMcpTokenRegistryFileProviderV1(filePath, {
                onRuntimeInspectionComplete: async () => {
                    completedInspections += 1;
                    if (completedInspections === 1) {
                        announcePaused();
                        await inspectionReleased;
                    }
                },
            });
            const verifier = createLegalMcpTokenVerifier({
                tokenSha256: '',
                tokenRegistryJson: '',
                tokenRegistryFile: '',
                tokenRegistryFileProvider: provider,
            });

            requestBeforeReplace = verifier.verifyAccessToken(oldToken);
            await paused;
            writeAtomic('ordering-new', newToken);

            await assert.rejects(
                verifier.verifyAccessToken(oldToken),
                (error: unknown) => error instanceof OAuthError
                    && error.code === OAuthErrorCode.InvalidToken
            );
            assert.equal(
                (await verifier.verifyAccessToken(newToken)).clientId,
                'ordering-new'
            );

            releaseInspection();
            await assert.rejects(
                requestBeforeReplace,
                (error: unknown) => error instanceof OAuthError
                    && error.code === OAuthErrorCode.InvalidToken
            );
        } finally {
            releaseInspection();
            await requestBeforeReplace?.catch(() => undefined);
            rmSync(root, { recursive: true, force: true });
        }
    });
});
