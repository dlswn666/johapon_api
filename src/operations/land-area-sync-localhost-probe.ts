import { request as nodeHttpRequest } from 'node:http';
import { createDevelopmentGisSystemAdminJwt } from './development-land-area-sync-runner';

/**
 * localhost land-area-sync API 왕복 진단 프로브.
 *
 * write run 11~15차에서 "무인증 /health는 성공하는데 인증 라우트 응답만
 * 유실되는" 비대칭이 재현됐다. 무인증 GET /health와 인증 GET(부작용 없는
 * admissions 조회, gisSystemAdminMiddleware의 DB 검증까지 통과해야 응답이
 * 나온다)을 같은 전송층으로 찔러 응답 수신 여부·소요 시간으로 문제 범위를
 * (프로세스 전역 / 인증 라우트 한정 / 서버측 지연) 즉시 판별한다.
 * 진단 전용 — 어떤 결과도 게이트 판정에 쓰지 않는다.
 */

const DEFAULT_ORIGIN = 'http://127.0.0.1:3100';
const DEFAULT_TIMEOUT_MS = 60_000;
const RESPONSE_SIZE_LIMIT = 1024 * 1024;
// nil-계열 고정 UUID — 실존 리소스와 충돌하지 않고 side effect 없는 조회 전용.
const PROBE_ADMISSION_KEY = '00000000-0000-4000-a000-000000000000';
const FALLBACK_ACTOR_AUTH_USER_ID = '00000000-0000-4000-a000-000000000001';

export type LocalhostProbeOutcome =
    | 'RESPONSE'
    | 'TIMEOUT'
    | 'NETWORK_ERROR'
    | 'INVALID';

export interface LocalhostProbeCheck {
    outcome: LocalhostProbeOutcome;
    status: number | null;
    durationMs: number;
}

export interface LocalhostProbeSummary {
    health: LocalhostProbeCheck;
    authed: LocalhostProbeCheck;
    /**
     * 0=양쪽 응답 수신, 20=health 무응답, 30=health만 성공+인증 타임아웃,
     * 31=health만 성공+인증 소켓 오류, 40=인증 프로브 구성 불가(secret 부재 등).
     */
    exitCode: 0 | 20 | 30 | 31 | 40;
}

function probeOnce(
    origin: string,
    path: string,
    headers: Record<string, string>,
    timeoutMs: number,
    nowMs: () => number
): Promise<LocalhostProbeCheck> {
    const startedAt = nowMs();
    return new Promise((resolve) => {
        let settled = false;
        const settle = (
            outcome: LocalhostProbeOutcome,
            status: number | null
        ): void => {
            if (settled) return;
            settled = true;
            resolve({
                outcome,
                status,
                durationMs: Math.max(0, nowMs() - startedAt),
            });
        };
        let request: ReturnType<typeof nodeHttpRequest>;
        try {
            request = nodeHttpRequest(
                `${origin}${path}`,
                {
                    method: 'GET',
                    headers: { Accept: 'application/json', ...headers },
                    timeout: timeoutMs,
                },
                (incoming) => {
                    let size = 0;
                    incoming.on('data', (chunk: Buffer) => {
                        size += chunk.length;
                        if (size > RESPONSE_SIZE_LIMIT) {
                            incoming.destroy();
                        }
                    });
                    incoming.on('end', () =>
                        settle('RESPONSE', incoming.statusCode ?? null)
                    );
                    incoming.on('error', () =>
                        settle('RESPONSE', incoming.statusCode ?? null)
                    );
                }
            );
        } catch {
            settle('INVALID', null);
            return;
        }
        request.on('timeout', () => {
            request.destroy();
            settle('TIMEOUT', null);
        });
        request.on('error', () => settle('NETWORK_ERROR', null));
        request.end();
    });
}

export async function probeLocalhostLandAreaSyncApi(input: {
    origin?: string;
    secret: string | undefined;
    actorAuthUserId?: string | undefined;
    timeoutMs?: number;
    now?: () => Date;
    nowMs?: () => number;
}): Promise<LocalhostProbeSummary> {
    const origin = input.origin ?? DEFAULT_ORIGIN;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const nowMs = input.nowMs ?? (() => Date.now());
    const health = await probeOnce(
        origin,
        '/health',
        {},
        timeoutMs,
        nowMs
    );

    let authed: LocalhostProbeCheck;
    let token: string | null = null;
    try {
        token = createDevelopmentGisSystemAdminJwt(
            input.secret ?? '',
            input.actorAuthUserId ?? FALLBACK_ACTOR_AUTH_USER_ID,
            input.now ? input.now() : new Date()
        );
    } catch {
        token = null;
    }
    if (token === null) {
        authed = { outcome: 'INVALID', status: null, durationMs: 0 };
    } else {
        // query 없는 admissions 조회 — authMiddleware(JWT)와
        // gisSystemAdminMiddleware(DB 권한 검증)를 통과한 뒤 handler가 400을
        // 반환한다. 어떤 상태코드든 수신 자체가 왕복 성공의 증거다.
        authed = await probeOnce(
            origin,
            `/api/gis/land-area-sync/admissions/${PROBE_ADMISSION_KEY}`,
            { Authorization: `Bearer ${token}` },
            timeoutMs,
            nowMs
        );
    }

    let exitCode: LocalhostProbeSummary['exitCode'];
    if (health.outcome !== 'RESPONSE') {
        exitCode = 20;
    } else if (authed.outcome === 'RESPONSE') {
        exitCode = 0;
    } else if (authed.outcome === 'TIMEOUT') {
        exitCode = 30;
    } else if (authed.outcome === 'NETWORK_ERROR') {
        exitCode = 31;
    } else {
        exitCode = 40;
    }
    return { health, authed, exitCode };
}

export function formatLocalhostProbeSummary(
    summary: LocalhostProbeSummary
): string {
    const field = (
        prefix: string,
        check: LocalhostProbeCheck
    ): string =>
        `${prefix}=${check.outcome} ${prefix}_status=${
            check.status ?? 'NONE'
        } ${prefix}_ms=${Math.round(check.durationMs)}`;
    return (
        `LAND_AREA_SYNC_PROBE_SUMMARY ` +
        `${field('health', summary.health)} ` +
        `${field('authed', summary.authed)} ` +
        `exit=${summary.exitCode}`
    );
}
