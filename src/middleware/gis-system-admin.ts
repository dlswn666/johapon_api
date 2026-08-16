import { NextFunction, Request, Response } from 'express';
import { getSupabaseService } from '../services/supabase.service';
import { validateGisAuthenticatedScope } from '../security/gis-access-policy';
import { createLogger } from '../utils/logger';

const logger = createLogger('GIS-AUTH');

// 응답 전에 await하는 DB 권한 검증이 이 시간을 넘기면 클라이언트 타임아웃과
// 겹쳐 "처리는 됐는데 응답만 유실" 형상을 만들 수 있어 명시적으로 기록한다.
const SLOW_VERIFICATION_THRESHOLD_MS = 5_000;

const GIS_JOB_TYPES = [
    'GIS_MAP',
    'APARTMENT_PRICE_SYNC',
    'INDIVIDUAL_HOUSING_PRICE_SYNC',
    'LAND_PRICE_SYNC',
    'LAND_AREA_SYNC',
] as const;

function lookupAbortSignal(res: Response): AbortSignal | undefined {
    const execution = res.locals?.landRightLookupExecution as
        | { signal?: unknown }
        | undefined;
    return execution?.signal instanceof AbortSignal
        ? execution.signal
        : undefined;
}

function stopForLookupAbort(
    res: Response,
    signal: AbortSignal | undefined
): boolean {
    if (!signal?.aborted) return false;
    if (
        signal.reason !== 'CLIENT_DISCONNECTED' &&
        !res.destroyed &&
        !res.headersSent
    ) {
        res.status(503).json({
            success: false,
            code: 'AUTHORIZATION_DEADLINE_EXCEEDED',
            error: '현재 권한 확인 시간이 초과되었습니다.',
        });
    }
    return true;
}

/**
 * GIS 변경·가격·상태 라우트의 시스템관리자 경계.
 * 서명된 claim을 먼저 확인하고 운영 DB의 현재 역할·차단 상태를 다시 검증한다.
 */
export async function gisSystemAdminMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    const signal = lookupAbortSignal(res);
    if (stopForLookupAbort(res, signal)) return;

    const requestedUnionId =
        typeof req.body?.unionId === 'string' && req.body.unionId.trim()
            ? req.body.unionId.trim()
            : null;
    const claimFailure = validateGisAuthenticatedScope(req.user, requestedUnionId);
    if (claimFailure) {
        res.status(claimFailure.status).json({ success: false, ...claimFailure });
        return;
    }
    if (
        req.user?.legacyProductionToken === false &&
        req.user.purpose !== 'GIS_SYSTEM_ADMIN'
    ) {
        res.status(403).json({
            success: false,
            code: 'TOKEN_PURPOSE_INVALID',
            error: 'GIS 변경 전용 토큰이 필요합니다.',
        });
        return;
    }
    if (requestedUnionId) req.body.unionId = requestedUnionId;

    const verificationStartedAt = Date.now();
    try {
        const client = getSupabaseService(req.user!.databaseTarget).getClient();
        // JWT userId는 auth.users UUID다. users.id(VARCHAR)와 직접 비교하지 않는다.
        let linkQuery = client
            .from('user_auth_links')
            .select('user_id')
            .eq('auth_user_id', req.user!.userId);
        if (signal) linkQuery = linkQuery.abortSignal(signal);
        const { data: links, error: linkError } = await linkQuery;

        if (stopForLookupAbort(res, signal)) return;

        if (linkError) {
            logger.error('GIS_AUTH_LINK_LOOKUP_FAILED');
            res.status(503).json({
                success: false,
                code: 'AUTHORIZATION_LOOKUP_FAILED',
                error: '현재 권한을 확인할 수 없습니다.',
            });
            return;
        }

        const linkedUserIds = Array.from(
            new Set((links ?? []).map((link: { user_id: string }) => link.user_id).filter(Boolean))
        );
        if (linkedUserIds.length === 0) {
            res.status(403).json({
                success: false,
                code: 'SYSTEM_ADMIN_REQUIRED',
                error: '시스템관리자 권한이 필요합니다.',
            });
            return;
        }

        let actorQuery = client
            .from('users')
            .select('id, role, is_blocked')
            .in('id', linkedUserIds)
            .eq('role', 'SYSTEM_ADMIN')
            .limit(1);
        if (signal) actorQuery = actorQuery.abortSignal(signal);
        const { data: actor, error: actorError } =
            await actorQuery.maybeSingle();

        if (stopForLookupAbort(res, signal)) return;

        if (actorError) {
            logger.error('GIS_SYSTEM_ADMIN_LOOKUP_FAILED');
            res.status(503).json({
                success: false,
                code: 'AUTHORIZATION_LOOKUP_FAILED',
                error: '현재 권한을 확인할 수 없습니다.',
            });
            return;
        }

        if (!actor || actor.role !== 'SYSTEM_ADMIN') {
            res.status(403).json({
                success: false,
                code: 'SYSTEM_ADMIN_REQUIRED',
                error: '시스템관리자 권한이 필요합니다.',
            });
            return;
        }

        if (actor.is_blocked) {
            res.status(403).json({
                success: false,
                code: 'USER_BLOCKED',
                error: '차단된 사용자는 GIS 작업을 실행할 수 없습니다.',
            });
            return;
        }

        req.user!.actorUserId = actor.id;

        if (requestedUnionId) {
            let unionQuery = client
                .from('unions')
                .select('id')
                .eq('id', requestedUnionId);
            if (signal) unionQuery = unionQuery.abortSignal(signal);
            const { data: union, error: unionError } =
                await unionQuery.maybeSingle();

            if (stopForLookupAbort(res, signal)) return;

            if (unionError) {
                logger.error('GIS_UNION_SCOPE_LOOKUP_FAILED');
                res.status(503).json({
                    success: false,
                    code: 'UNION_SCOPE_LOOKUP_FAILED',
                    error: '정비사업 범위를 확인할 수 없습니다.',
                });
                return;
            }

            if (!union) {
                res.status(404).json({
                    success: false,
                    code: 'UNION_NOT_FOUND',
                    error: '정비사업을 찾을 수 없습니다.',
                });
                return;
            }
        }

        if (req.params.jobId) {
            let jobQuery = client
                .from('sync_jobs')
                .select('id, union_id, job_type')
                .eq('id', req.params.jobId)
                .in('job_type', [...GIS_JOB_TYPES]);
            if (signal) jobQuery = jobQuery.abortSignal(signal);
            const { data: job, error: jobError } =
                await jobQuery.maybeSingle();

            if (stopForLookupAbort(res, signal)) return;

            if (jobError) {
                logger.error('GIS_JOB_SCOPE_LOOKUP_FAILED');
                res.status(503).json({
                    success: false,
                    code: 'JOB_SCOPE_LOOKUP_FAILED',
                    error: 'GIS 작업 범위를 확인할 수 없습니다.',
                });
                return;
            }

            if (!job) {
                res.status(404).json({
                    success: false,
                    code: 'JOB_NOT_FOUND',
                    error: 'GIS 작업을 찾을 수 없습니다.',
                });
                return;
            }

            if (req.user!.unionId !== 'system' && req.user!.unionId !== job.union_id) {
                res.status(403).json({
                    success: false,
                    code: 'UNION_SCOPE_MISMATCH',
                    error: 'GIS 작업의 정비사업 범위가 토큰과 일치하지 않습니다.',
                });
                return;
            }
        }

        next();
    } catch {
        if (stopForLookupAbort(res, signal)) return;
        logger.error('GIS_AUTHORIZATION_UNEXPECTED_ERROR');
        res.status(503).json({
            success: false,
            code: 'AUTHORIZATION_LOOKUP_FAILED',
            error: '현재 권한을 확인할 수 없습니다.',
        });
    } finally {
        const verificationDuration = Date.now() - verificationStartedAt;
        if (verificationDuration >= SLOW_VERIFICATION_THRESHOLD_MS) {
            logger.warn(
                `GIS_AUTH_SLOW_VERIFICATION (${verificationDuration}ms)`
            );
        }
    }
}
