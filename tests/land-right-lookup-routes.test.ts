import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';

const PRODUCTION_SECRET = 'land-right-route-prod-secret';
const DEVELOPMENT_SECRET = 'land-right-route-dev-secret';
const UNION_ID = '11111111-1111-4111-8111-111111111111';
const PROPERTY_ID = '22222222-2222-4222-8222-222222222222';
const PNU = '1168010100107360024';

Object.assign(process.env, {
    JWT_SECRET: PRODUCTION_SECRET,
    DEV_API_JWT_SECRET: DEVELOPMENT_SECRET,
    ALIGO_API_KEY: 'test-aligo-key',
    ALIGO_USER_ID: 'test-aligo-user',
    ALIGO_SENDER_PHONE: '0212345678',
    DEFAULT_SENDER_KEY: 'test-sender-key',
    SUPABASE_URL: 'https://land-right-prod.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'land-right-prod-service-key',
    DEV_SUPABASE_URL: 'https://land-right-dev.supabase.co',
    DEV_SUPABASE_SERVICE_ROLE_KEY: 'land-right-dev-service-key',
    VWORLD_API_KEY: 'server-provider-key',
});

test('대지권 조회는 /api/gis 외부 경로에서 no-store·인증·입력·SYSTEM_ADMIN 순서로 보호된다', async () => {
    const [route, routesIndex] = await Promise.all([
        readFile('src/routes/gis.ts', 'utf8'),
        readFile('src/routes/index.ts', 'utf8'),
    ]);

    assert.match(routesIndex, /router\.use\('\/api\/gis', gisRouter\)/);
    assert.match(
        route,
        /router\.post\(\s*'\/land-right\/lookup',\s*landRightLookupNoStore,\s*landRightLookupExecutionContext,\s*authMiddleware,\s*validateLandRightLookupRequest,\s*gisSystemAdminMiddleware,/
    );
    assert.match(
        route,
        /function landRightLookupNoStore[\s\S]*res\.set\('Cache-Control', 'no-store'\)/
    );
    assert.match(route, /new Set\(\['unionId', 'propertyUnitId'\]\)/);
    assert.match(route, /!isUuid\(unionId\)[\s\S]*!isUuid\(propertyUnitId\)/);
    assert.match(route, /getSupabaseService\(\s*req\.user!\.databaseTarget\s*\)/);
    assert.match(route, /LAND_RIGHT_LOOKUP_DEADLINE_MS = 50_000/);
    assert.match(route, /req\.once\('aborted', abortForDisconnect\)/);
});

test('transient 조회 경로는 provider identity를 서버 환경에서만 받고 writer·queue·job을 사용하지 않는다', async () => {
    const [route, transient] = await Promise.all([
        readFile('src/routes/gis.ts', 'utf8'),
        readFile('src/services/land-right-lookup/transient.ts', 'utf8'),
    ]);
    const lookupRoute = route.slice(
        route.indexOf("router.post(\n    '/land-right/lookup'"),
        route.indexOf('function hasWorkerFinalization')
    );

    assert.match(lookupRoute, /key: env\.VWORLD_API_KEY/);
    assert.match(lookupRoute, /domain: env\.VWORLD_API_DOMAIN/);
    assert.doesNotMatch(lookupRoute, /req\.body\.(pnu|key|source)/);
    assert.doesNotMatch(
        transient,
        /\.(?:insert|update|upsert|delete|rpc)\s*\(/
    );
    assert.doesNotMatch(
        transient,
        /sync_jobs|land_right_lookup_results|poller|worker/i
    );
    assert.equal(
        (
            transient.match(
                /\.limit\(MAX_LAND_RIGHT_RELATION_ROWS \+ 1\)/g
            ) ?? []
        ).length,
        2
    );
    assert.match(transient, /MAX_LAND_RIGHT_SCOPE_PNUS = 20/);
});

type RouteHandler = (
    req: Request,
    res: Response,
    next: NextFunction
) => unknown;

async function loadLookupHandlers(): Promise<RouteHandler[]> {
    const { default: router } = await import('../src/routes/gis');
    const layer = (
        router as unknown as {
            stack: Array<{
                route?: {
                    path: string;
                    stack: Array<{ handle: RouteHandler }>;
                };
            }>;
        }
    ).stack.find((candidate) => candidate.route?.path === '/land-right/lookup');
    assert.ok(layer?.route);
    return layer.route.stack.map(({ handle }) => handle);
}

function signDevelopmentToken(unionId = UNION_ID): string {
    return jwt.sign(
        {
            unionId,
            userId: 'auth-user-a',
            databaseTarget: 'development',
            iss: 'tonghari-web-dev',
            aud: 'tonghari-api',
            purpose: 'GIS_SYSTEM_ADMIN',
        },
        DEVELOPMENT_SECRET,
        { algorithm: 'HS256', expiresIn: '5m', keyid: 'dev' }
    );
}

type FakePlan = {
    actorRole?: 'SYSTEM_ADMIN' | 'ADMIN';
    firstQueryDelayMs?: number;
};

function createFakeClient(plan: FakePlan = {}) {
    const traces: string[] = [];
    let queryCount = 0;
    const client = {
        from(table: string) {
            traces.push(table);
            queryCount += 1;
            const delayMs = queryCount === 1
                ? (plan.firstQueryDelayMs ?? 0)
                : 0;
            const result = () => {
                switch (table) {
                    case 'user_auth_links':
                        return {
                            data: [{ user_id: 'admin-a' }],
                            error: null,
                        };
                    case 'users':
                        return {
                            data: {
                                id: 'admin-a',
                                role: plan.actorRole ?? 'SYSTEM_ADMIN',
                                is_blocked: false,
                            },
                            error: null,
                        };
                    case 'unions':
                        return { data: { id: UNION_ID }, error: null };
                    case 'property_units':
                        return {
                            data: {
                                id: PROPERTY_ID,
                                union_id: UNION_ID,
                                pnu: PNU,
                                property_address_jibun: '서울시 테스트 736-24',
                                dong: null,
                                ho: null,
                                land_area: null,
                                is_deleted: false,
                            },
                            error: null,
                        };
                    case 'building_registry_land_lot_relations':
                        return { data: [], error: null };
                    case 'land_lots':
                        return {
                            data: [
                                {
                                    union_id: UNION_ID,
                                    pnu: PNU,
                                    address: '서울시 테스트 736-24',
                                },
                            ],
                            error: null,
                        };
                    default:
                        return { data: null, error: null };
                }
            };
            const builder: Record<string, unknown> &
                PromiseLike<ReturnType<typeof result>> = {
                select: () => builder,
                eq: () => builder,
                in: () => builder,
                or: () => builder,
                limit: () => builder,
                abortSignal: () => builder,
                maybeSingle: async () => {
                    if (delayMs > 0) {
                        await new Promise((resolve) => setTimeout(resolve, delayMs));
                    }
                    return result();
                },
                then: (resolve, reject) => {
                    const delayed = delayMs > 0
                        ? new Promise<void>((done) => setTimeout(done, delayMs))
                        : Promise.resolve();
                    return delayed.then(result).then(resolve, reject);
                },
            };
            return builder;
        },
    };
    return { client, traces };
}

function createRequest(token: string, body: unknown): Request {
    return Object.assign(new EventEmitter(), {
        headers: { authorization: `Bearer ${token}` },
        body,
        params: {},
        query: {},
    }) as unknown as Request;
}

function createResponse() {
    const emitter = new EventEmitter();
    const state: {
        status: number;
        body?: unknown;
        headers: Record<string, string>;
    } = { status: 200, headers: {} };
    const response = Object.assign(emitter, {
        locals: {},
        writableEnded: false,
        destroyed: false,
        headersSent: false,
        set(name: string, value: string) {
            state.headers[name.toLowerCase()] = value;
            return response;
        },
        status(value: number) {
            state.status = value;
            return response;
        },
        json(value: unknown) {
            state.body = value;
            response.writableEnded = true;
            response.headersSent = true;
            response.emit('finish');
            return response;
        },
    });
    return { response: response as unknown as Response, state };
}

async function invokeMiddleware(
    handler: RouteHandler,
    req: Request,
    res: Response
): Promise<boolean> {
    let nextCalled = false;
    await handler(
        req,
        res,
        (() => {
            nextCalled = true;
        }) as NextFunction
    );
    return nextCalled;
}

test('실제 route stack은 인증 실패 전에도 no-store를 설정하고 union mismatch를 거부한다', async () => {
    const handlers = await loadLookupHandlers();
    assert.equal(handlers.length, 6);

    const unauthorizedReq = createRequest('', {
        unionId: UNION_ID,
        propertyUnitId: PROPERTY_ID,
    });
    const unauthorizedRes = createResponse();
    assert.equal(
        await invokeMiddleware(
            handlers[0],
            unauthorizedReq,
            unauthorizedRes.response
        ),
        true
    );
    assert.equal(unauthorizedRes.state.headers['cache-control'], 'no-store');
    assert.equal(
        await invokeMiddleware(
            handlers[1],
            unauthorizedReq,
            unauthorizedRes.response
        ),
        true
    );
    assert.equal(
        await invokeMiddleware(
            handlers[2],
            unauthorizedReq,
            unauthorizedRes.response
        ),
        false
    );
    assert.equal(unauthorizedRes.state.status, 401);

    const mismatchReq = createRequest(signDevelopmentToken(
        '33333333-3333-4333-8333-333333333333'
    ), {
        unionId: UNION_ID,
        propertyUnitId: PROPERTY_ID,
    });
    const mismatchRes = createResponse();
    for (const index of [0, 1, 2, 3]) {
        assert.equal(
            await invokeMiddleware(
                handlers[index],
                mismatchReq,
                mismatchRes.response
            ),
            true
        );
    }
    assert.equal(
        await invokeMiddleware(
            handlers[4],
            mismatchReq,
            mismatchRes.response
        ),
        false
    );
    assert.equal(mismatchRes.state.status, 403);
    assert.equal(
        (mismatchRes.state.body as { code: string }).code,
        'UNION_SCOPE_MISMATCH'
    );
});

test('실제 execution middleware는 client disconnect를 동일 AbortSignal에 연결한다', async () => {
    const handlers = await loadLookupHandlers();
    const req = createRequest(signDevelopmentToken(), {
        unionId: UNION_ID,
        propertyUnitId: PROPERTY_ID,
    });
    const res = createResponse();
    assert.equal(
        await invokeMiddleware(handlers[1], req, res.response),
        true
    );
    const execution = res.response.locals.landRightLookupExecution as {
        signal: AbortSignal;
        cleanup: () => void;
    };
    assert.equal(execution.signal.aborted, false);
    (req as unknown as EventEmitter).emit('aborted');
    assert.equal(execution.signal.aborted, true);
    assert.equal(execution.signal.reason, 'CLIENT_DISCONNECTED');
    execution.cleanup();
});

test('initial disconnected 상태는 next 없이 fail-closed하고 listener를 남기지 않는다', async () => {
    const handlers = await loadLookupHandlers();
    for (const initial of [
        { request: { aborted: true }, response: {} },
        { request: { destroyed: true }, response: {} },
        { request: {}, response: { destroyed: true } },
    ]) {
        const req = createRequest(signDevelopmentToken(), {
            unionId: UNION_ID,
            propertyUnitId: PROPERTY_ID,
        });
        Object.assign(req, initial.request);
        const res = createResponse();
        Object.assign(res.response, initial.response);

        assert.equal(
            await invokeMiddleware(handlers[1], req, res.response),
            false
        );
        const execution = res.response.locals.landRightLookupExecution as {
            signal: AbortSignal;
        };
        assert.equal(execution.signal.aborted, true);
        assert.equal(execution.signal.reason, 'CLIENT_DISCONNECTED');
        assert.equal((req as unknown as EventEmitter).listenerCount('aborted'), 0);
        assert.equal(
            (res.response as unknown as EventEmitter).listenerCount('close'),
            0
        );
    }
});

test('early auth·validation 오류 응답은 deadline timer와 listener를 즉시 정리한다', async () => {
    const handlers = await loadLookupHandlers();
    const { createLandRightLookupExecutionContextMiddleware } = await import(
        '../src/routes/gis'
    );
    const shortExecution = createLandRightLookupExecutionContextMiddleware(10);

    for (const scenario of ['AUTH', 'VALIDATION'] as const) {
        const req = createRequest(
            scenario === 'AUTH' ? '' : signDevelopmentToken(),
            scenario === 'AUTH'
                ? { unionId: UNION_ID, propertyUnitId: PROPERTY_ID }
                : { unionId: 'invalid', propertyUnitId: PROPERTY_ID }
        );
        const res = createResponse();
        assert.equal(await invokeMiddleware(shortExecution, req, res.response), true);
        const execution = res.response.locals.landRightLookupExecution as {
            signal: AbortSignal;
        };
        assert.equal(
            await invokeMiddleware(handlers[2], req, res.response),
            scenario === 'VALIDATION'
        );
        if (scenario === 'VALIDATION') {
            assert.equal(
                await invokeMiddleware(handlers[3], req, res.response),
                false
            );
        }
        assert.equal((req as unknown as EventEmitter).listenerCount('aborted'), 0);
        assert.equal(
            (res.response as unknown as EventEmitter).listenerCount('finish'),
            0
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(
            execution.signal.aborted,
            false,
            'early response 뒤 deadline timer가 남아 있으면 안 된다'
        );
    }
});

test('deadline은 SYSTEM_ADMIN DB 인증을 포함하고 늦은 인증 뒤 provider를 시작하지 않는다', async () => {
    const handlers = await loadLookupHandlers();
    const { createLandRightLookupExecutionContextMiddleware } = await import(
        '../src/routes/gis'
    );
    const { getSupabaseService } = await import('../src/services/supabase.service');
    const { landRightNedClient } = await import(
        '../src/services/land-right-lookup/ned'
    );
    const delayed = createFakeClient({ firstQueryDelayMs: 25 });
    const service = getSupabaseService('development');
    const originalGetClient = service.getClient;
    const originalLdareg = landRightNedClient.fetchLdareg;
    const originalLadfrl = landRightNedClient.fetchLadfrl;
    let providerCalls = 0;
    (service as unknown as { getClient: () => unknown }).getClient =
        () => delayed.client;
    landRightNedClient.fetchLdareg = async () => {
        providerCalls += 1;
        return { status: 'NO_DATA', records: [] };
    };
    landRightNedClient.fetchLadfrl = async () => {
        providerCalls += 1;
        return { status: 'NO_DATA', records: [] };
    };

    try {
        const req = createRequest(signDevelopmentToken(), {
            unionId: UNION_ID,
            propertyUnitId: PROPERTY_ID,
        });
        const res = createResponse();
        assert.equal(await invokeMiddleware(handlers[0], req, res.response), true);
        assert.equal(
            await invokeMiddleware(
                createLandRightLookupExecutionContextMiddleware(5),
                req,
                res.response
            ),
            true
        );
        assert.equal(await invokeMiddleware(handlers[2], req, res.response), true);
        assert.equal(await invokeMiddleware(handlers[3], req, res.response), true);
        assert.equal(await invokeMiddleware(handlers[4], req, res.response), false);
        assert.equal(res.state.status, 503);
        assert.equal(
            (res.state.body as { code: string }).code,
            'AUTHORIZATION_DEADLINE_EXCEEDED'
        );
        assert.equal(providerCalls, 0);
        assert.ok(delayed.traces.includes('user_auth_links'));
        assert.ok(!delayed.traces.includes('users'));
    } finally {
        (service as unknown as { getClient: typeof originalGetClient }).getClient =
            originalGetClient;
        landRightNedClient.fetchLdareg = originalLdareg;
        landRightNedClient.fetchLadfrl = originalLadfrl;
    }
});

test('실제 SYSTEM_ADMIN middleware와 handler는 token의 development client만 선택한다', async () => {
    const handlers = await loadLookupHandlers();
    const { getSupabaseService } = await import('../src/services/supabase.service');
    const { landRightNedClient } = await import(
        '../src/services/land-right-lookup/ned'
    );
    const development = createFakeClient();
    const production = createFakeClient();
    const developmentService = getSupabaseService('development');
    const productionService = getSupabaseService('production');
    const originalDevelopmentGetClient = developmentService.getClient;
    const originalProductionGetClient = productionService.getClient;
    const originalLdareg = landRightNedClient.fetchLdareg;
    const originalLadfrl = landRightNedClient.fetchLadfrl;
    (developmentService as unknown as { getClient: () => unknown }).getClient =
        () => development.client;
    (productionService as unknown as { getClient: () => unknown }).getClient =
        () => production.client;
    landRightNedClient.fetchLdareg = async () => ({
        status: 'NO_DATA',
        records: [],
    });
    landRightNedClient.fetchLadfrl = async () => ({
        status: 'NO_DATA',
        records: [],
    });

    try {
        const req = createRequest(signDevelopmentToken(), {
            unionId: UNION_ID,
            propertyUnitId: PROPERTY_ID,
        });
        const res = createResponse();
        for (const index of [0, 1, 2, 3, 4]) {
            assert.equal(
                await invokeMiddleware(handlers[index], req, res.response),
                true
            );
        }
        await handlers[5](req, res.response, (() => undefined) as NextFunction);

        assert.equal(res.state.status, 200);
        assert.equal((res.state.body as { success: boolean }).success, true);
        assert.equal(
            (res.state.body as {
                data: { status: string; warnings: string[] };
            }).data.status,
            'INCOMPLETE'
        );
        assert.ok(
            (res.state.body as {
                data: { warnings: string[] };
            }).data.warnings.includes('NO_ACTIVE_BASE_ATTACHED_RELATION')
        );
        assert.ok(development.traces.includes('property_units'));
        assert.deepEqual(production.traces, []);
    } finally {
        (
            developmentService as unknown as {
                getClient: typeof originalDevelopmentGetClient;
            }
        ).getClient = originalDevelopmentGetClient;
        (
            productionService as unknown as {
                getClient: typeof originalProductionGetClient;
            }
        ).getClient = originalProductionGetClient;
        landRightNedClient.fetchLdareg = originalLdareg;
        landRightNedClient.fetchLadfrl = originalLadfrl;
    }
});

test('실제 SYSTEM_ADMIN middleware는 현재 DB role이 ADMIN이면 handler 전에 차단한다', async () => {
    const handlers = await loadLookupHandlers();
    const { getSupabaseService } = await import('../src/services/supabase.service');
    const development = createFakeClient({ actorRole: 'ADMIN' });
    const service = getSupabaseService('development');
    const originalGetClient = service.getClient;
    (service as unknown as { getClient: () => unknown }).getClient =
        () => development.client;
    try {
        const req = createRequest(signDevelopmentToken(), {
            unionId: UNION_ID,
            propertyUnitId: PROPERTY_ID,
        });
        const res = createResponse();
        for (const index of [0, 1, 2, 3]) {
            assert.equal(
                await invokeMiddleware(handlers[index], req, res.response),
                true
            );
        }
        assert.equal(
            await invokeMiddleware(handlers[4], req, res.response),
            false
        );
        assert.equal(res.state.status, 403);
        assert.equal(
            (res.state.body as { code: string }).code,
            'SYSTEM_ADMIN_REQUIRED'
        );
        assert.ok(!development.traces.includes('property_units'));
    } finally {
        (service as unknown as { getClient: typeof originalGetClient }).getClient =
            originalGetClient;
    }
});
