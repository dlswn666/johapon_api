import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import { loggerMiddleware } from '../src/middleware/logger';

interface FakeResponse extends EventEmitter {
    statusCode: number;
    writableFinished: boolean;
}

function run(statusCode = 200): {
    res: FakeResponse;
    nextCalled: boolean;
} {
    const req = { method: 'POST', path: '/api/gis/land-area-sync' };
    const res: FakeResponse = Object.assign(new EventEmitter(), {
        statusCode,
        writableFinished: false,
    });
    let nextCalled = false;
    loggerMiddleware(
        req as unknown as Request,
        res as unknown as Response,
        (() => {
            nextCalled = true;
        }) as NextFunction
    );
    return { res, nextCalled };
}

test('응답이 finish되면 상태코드 로그만 남고 조기종료 경고는 없다', () => {
    const info = mock.method(console, 'info', () => {});
    const warn = mock.method(console, 'warn', () => {});
    try {
        const { res, nextCalled } = run(202);
        assert.equal(nextCalled, true);
        res.writableFinished = true;
        res.emit('finish');
        res.emit('close');
        assert.equal(info.mock.callCount(), 1);
        assert.match(
            String(info.mock.calls[0]?.arguments[0]),
            /POST \/api\/gis\/land-area-sync - 202 \([0-9]+ms\)/
        );
        assert.equal(warn.mock.callCount(), 0);
    } finally {
        info.mock.restore();
        warn.mock.restore();
    }
});

test('응답이 flush되기 전에 소켓이 닫히면 CLOSED_BEFORE_FINISH를 경고로 남긴다', () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
        const { res } = run(202);
        res.emit('close');
        assert.equal(warn.mock.callCount(), 1);
        assert.match(
            String(warn.mock.calls[0]?.arguments[0]),
            /POST \/api\/gis\/land-area-sync - CLOSED_BEFORE_FINISH \([0-9]+ms\)/
        );
    } finally {
        warn.mock.restore();
    }
});
