import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../utils/logger';

const logger = createLogger('HTTP');

/**
 * 요청 로깅 미들웨어
 */
export const loggerMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction
): void => {
    const startTime = Date.now();

    // 응답 완료 시 추가 정보 로깅
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const message = `${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`;

        if (res.statusCode >= 500) {
            logger.error(message);
        } else if (res.statusCode >= 400) {
            logger.warn(message);
        } else {
            logger.info(message);
        }
    });

    // 응답이 flush되기 전에 소켓이 닫히면(클라이언트 타임아웃/이탈) finish가
    // 없어 위 로그가 남지 않는다 — 응답 유실 진단을 위해 명시적으로 남긴다.
    res.on('close', () => {
        if (res.writableFinished) return;
        const duration = Date.now() - startTime;
        logger.warn(
            `${req.method} ${req.path} - CLOSED_BEFORE_FINISH (${duration}ms)`
        );
    });

    next();
};

export default loggerMiddleware;

