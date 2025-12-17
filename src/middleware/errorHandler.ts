import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

/**
 * 커스텀 에러 클래스
 */
export class AppError extends Error {
    public readonly statusCode: number;
    public readonly code: string;
    public readonly isOperational: boolean;

    constructor(message: string, statusCode: number = 500, code: string = 'INTERNAL_ERROR') {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.isOperational = true;

        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * 에러 핸들링 미들웨어
 */
export const errorHandler = (
    err: Error | AppError,
    req: Request,
    res: Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    next: NextFunction
): void => {
    // AppError인 경우
    if (err instanceof AppError) {
        res.status(err.statusCode).json({
            success: false,
            error: err.message,
            code: err.code,
        });
        return;
    }

    // 일반 에러인 경우
    console.error('Unhandled error:', err);

    res.status(500).json({
        success: false,
        error: env.isDevelopment ? err.message : 'Internal server error',
        code: 'INTERNAL_ERROR',
    });
};

/**
 * 404 핸들러
 */
export const notFoundHandler = (
    req: Request,
    res: Response
): void => {
    res.status(404).json({
        success: false,
        error: `Route ${req.method} ${req.path} not found`,
        code: 'NOT_FOUND',
    });
};

export default errorHandler;

