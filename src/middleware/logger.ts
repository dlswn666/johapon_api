import { Request, Response, NextFunction } from 'express';

/**
 * 요청 로깅 미들웨어
 */
export const loggerMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction
): void => {
    const startTime = Date.now();

    // 요청 정보 로깅
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);

    // 응답 완료 시 추가 정보 로깅
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const logLevel = res.statusCode >= 400 ? 'ERROR' : 'INFO';
        
        console.log(
            `[${new Date().toISOString()}] [${logLevel}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`
        );
    });

    next();
};

export default loggerMiddleware;

