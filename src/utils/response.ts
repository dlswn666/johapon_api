import { Response } from 'express';
import { ApiResponse } from '../types/alimtalk.types';

/**
 * API 응답 헬퍼 함수들
 */

/**
 * 성공 응답
 */
export function sendSuccess<T>(res: Response, data: T, statusCode: number = 200): void {
    const response: ApiResponse<T> = {
        success: true,
        data,
    };
    res.status(statusCode).json(response);
}

/**
 * 에러 응답
 */
export function sendError(
    res: Response, 
    error: string, 
    code: string = 'ERROR', 
    statusCode: number = 400
): void {
    const response: ApiResponse = {
        success: false,
        error,
        code,
    };
    res.status(statusCode).json(response);
}

