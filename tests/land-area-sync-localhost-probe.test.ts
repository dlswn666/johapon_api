import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
    formatLocalhostProbeSummary,
    probeLocalhostLandAreaSyncApi,
} from '../src/operations/land-area-sync-localhost-probe';

const SECRET = 'test-probe-secret';
const ACTOR = '11111111-2222-4333-a444-555555555555';

async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
    );
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
}

async function close(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
        server.close(() => resolve());
    });
}

test('프로브는 양쪽 응답을 수신하면 exit 0과 상태코드를 보고한다', async () => {
    const seenPaths: string[] = [];
    const seenAuth: Array<string | undefined> = [];
    const server = createServer((req, res) => {
        seenPaths.push(req.url ?? '');
        seenAuth.push(req.headers.authorization);
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"status":"ok"}');
            return;
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"success":false,"code":"INVALID_UNION_ID"}');
    });
    const origin = await listen(server);
    try {
        const summary = await probeLocalhostLandAreaSyncApi({
            origin,
            secret: SECRET,
            actorAuthUserId: ACTOR,
            timeoutMs: 2_000,
        });
        assert.equal(summary.exitCode, 0);
        assert.equal(summary.health.outcome, 'RESPONSE');
        assert.equal(summary.health.status, 200);
        assert.equal(summary.authed.outcome, 'RESPONSE');
        assert.equal(summary.authed.status, 400);
        assert.equal(seenPaths[0], '/health');
        assert.match(
            seenPaths[1] ?? '',
            /^\/api\/gis\/land-area-sync\/admissions\/00000000-0000-4000-a000-000000000000$/
        );
        assert.equal(seenAuth[0], undefined);
        assert.match(seenAuth[1] ?? '', /^Bearer eyJ/);
    } finally {
        await close(server);
    }
});

test('인증 라우트만 무응답이면 exit 30(TIMEOUT)으로 비대칭을 보고한다', async () => {
    const server = createServer((req, res) => {
        if (req.url === '/health') {
            res.writeHead(200);
            res.end('{"status":"ok"}');
            return;
        }
        // 응답을 보내지 않고 연결을 유지한다 — write 11~15차 재현 형상.
    });
    const origin = await listen(server);
    try {
        const summary = await probeLocalhostLandAreaSyncApi({
            origin,
            secret: SECRET,
            actorAuthUserId: ACTOR,
            timeoutMs: 300,
        });
        assert.equal(summary.exitCode, 30);
        assert.equal(summary.health.outcome, 'RESPONSE');
        assert.equal(summary.authed.outcome, 'TIMEOUT');
        assert.ok(summary.authed.durationMs >= 250);
    } finally {
        await close(server);
    }
});

test('서버가 아예 없으면 health 무응답으로 exit 20을 보고한다', async () => {
    const server = createServer(() => {});
    const origin = await listen(server);
    await close(server);
    const summary = await probeLocalhostLandAreaSyncApi({
        origin,
        secret: SECRET,
        actorAuthUserId: ACTOR,
        timeoutMs: 2_000,
    });
    assert.equal(summary.exitCode, 20);
    assert.equal(summary.health.outcome, 'NETWORK_ERROR');
});

test('secret이 없으면 인증 프로브는 INVALID로 exit 40을 보고한다', async () => {
    const server = createServer((req, res) => {
        res.writeHead(200);
        res.end('{"status":"ok"}');
    });
    const origin = await listen(server);
    try {
        const summary = await probeLocalhostLandAreaSyncApi({
            origin,
            secret: undefined,
            timeoutMs: 2_000,
        });
        assert.equal(summary.exitCode, 40);
        assert.equal(summary.health.outcome, 'RESPONSE');
        assert.equal(summary.authed.outcome, 'INVALID');
    } finally {
        await close(server);
    }
});

test('요약 문자열은 고정 키·상태코드·소요시간만 담고 식별자를 내보내지 않는다', async () => {
    const line = formatLocalhostProbeSummary({
        health: { outcome: 'RESPONSE', status: 200, durationMs: 12.6 },
        authed: { outcome: 'TIMEOUT', status: null, durationMs: 60_000 },
        exitCode: 30,
    });
    assert.equal(
        line,
        'LAND_AREA_SYNC_PROBE_SUMMARY health=RESPONSE health_status=200 health_ms=13 authed=TIMEOUT authed_status=NONE authed_ms=60000 exit=30'
    );
    assert.match(
        line,
        /^LAND_AREA_SYNC_PROBE_SUMMARY( [a-z_]+=[A-Z0-9_]+)+$/
    );
    assert.doesNotMatch(
        line,
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{19}/
    );
});
