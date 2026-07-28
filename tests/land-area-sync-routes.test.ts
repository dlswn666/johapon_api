import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

async function gisRoute(): Promise<string> {
    return readFile('src/routes/gis.ts', 'utf8');
}

test('LAND_AREA_SYNC POST는 인증·SYSTEM_ADMIN 뒤 fail-closed gate를 거치고 GET은 조회 가능하다', async () => {
    const s = await gisRoute();
    assert.match(s, /router\.post\('\/land-area-sync',\s*authMiddleware,\s*gisSystemAdminMiddleware,\s*landAreaSyncEnabledMiddleware,\s*landAreaSyncDiscoveryCanaryMiddleware/);
    assert.match(s, /router\.post\('\/land-area-sync\/:discoveryJobId\/confirm',\s*authMiddleware,\s*gisSystemAdminMiddleware,\s*landAreaSyncEnabledMiddleware/);
    assert.match(s, /router\.get\('\/land-area-sync\/latest',\s*authMiddleware,\s*gisSystemAdminMiddleware/);
    assert.match(s, /router\.get\('\/land-area-sync\/admissions\/:admissionKey',\s*authMiddleware,\s*gisSystemAdminMiddleware/);
    assert.match(s, /router\.get\('\/land-area-sync\/:jobId',\s*authMiddleware,\s*gisSystemAdminMiddleware/);
    const getRegistrations = s
        .split('\n')
        .filter((line) => line.includes("router.get('/land-area-sync/"));
    assert.equal(getRegistrations.length, 3);
    assert.ok(getRegistrations.every((line) => !line.includes('landAreaSyncEnabledMiddleware')));
    // latest 는 :jobId 보다 먼저 등록되어야 한다(literal 우선).
    assert.ok(s.indexOf("'/land-area-sync/latest'") < s.indexOf("'/land-area-sync/:jobId'"));
    assert.ok(s.indexOf("'/land-area-sync/admissions/:admissionKey'") < s.indexOf("'/land-area-sync/:jobId'"));
});

test('POST /land-area-sync 는 UUID unionId·19자리 PNU 를 exact 검증하고 durable INSERT 후 202', async () => {
    const s = await gisRoute();
    assert.match(s, /if \(!isUuid\(unionId\)\)/);
    assert.match(s, /if \(!isPnu\(anchorPnu\)\)/);
    assert.match(s, /if \(!isUuid\(admissionKey\)\)/);
    assert.match(s, /admissionKey,/);
    assert.match(s, /addDiscoveryJob\(/);
    assert.match(s, /res\.status\(202\)/);
    // databaseTarget 은 JWT claim 만 사용.
    assert.match(s, /databaseTarget: req\.user!\.databaseTarget/);
    // admission 실패는 sendGisQueueError(503 매핑) 로 처리.
    assert.match(s, /sendGisQueueError\(res, error\)/);
});

test('confirm route 는 확인자·시각 body 금지 + scope hash·정렬 propertyUnitIds·확인 플래그를 exact 검증한다', async () => {
    const s = await gisRoute();
    const supabase = await readFile('src/services/supabase.service.ts', 'utf8');
    const queue = await readFile('src/services/land-area-sync/queue.ts', 'utf8');
    assert.match(s, /'confirmedByUserId' in body \|\| 'confirmedAt' in body/);
    assert.match(s, /HEX64_RE\.test\(expectedScopeHash\)/);
    assert.match(s, /propertyUnitIds\.every\(isUuid\)/);
    assert.match(s, /new Set\(propertyUnitIds as string\[\]\)\.size !== propertyUnitIds\.length/);
    assert.match(s, /JSON\.stringify\(sorted\) !== JSON\.stringify\(propertyUnitIds\)/);
    assert.match(s, /parcelScopeConfirmed !== true/);
    assert.match(s, /p_admission_key: admissionKey/);
    assert.match(
        supabase,
        /rpc\('create_land_area_sync_confirmation_job_v2'/
    );
    assert.match(s, /applyJob\.status === 'PROCESSING'/);
    assert.match(s, /getScopedAdmissionJob\([\s\S]*admissionKey,[\s\S]*discoveryJob\.union_id/);
    assert.match(s, /applyJob\.id !== newJobId/);
    assert.match(queue, /if \(this\.jobs\.has\(key\)\)[\s\S]+return false/);
    // admission RPC 경유 + 새 apply job 재실행.
    assert.match(s, /createLandAreaSyncConfirmationJob\(/);
    assert.match(s, /admitApplyJob\([\s\S]*applyJob\.id,[\s\S]*discoveryJob\.union_id,[\s\S]*discoveryAnchorPnu as string,[\s\S]*req\.user!\.databaseTarget/);
    // canary는 body anchor가 아니라 저장된 discovery lineage를 RPC INSERT 전에 검사한다.
    assert.match(s, /const discoveryLandAreaSync = readLandAreaSync\(discoveryJob\)/);
    assert.match(s, /const discoveryAnchorPnu = discoveryLandAreaSync\?\.anchorPnu/);
    assert.ok(
        s.indexOf('assertLandAreaSyncCanaryAllowed(') <
            s.indexOf('createLandAreaSyncConfirmationJob(')
    );
    assert.match(s, /assertLandAreaSyncScopeAllowed\([\s\S]*discoveryScannedPnus/);
    assert.ok(
        s.indexOf('assertLandAreaSyncScopeAllowed(') <
            s.indexOf('createLandAreaSyncConfirmationJob(')
    );
    // 확인자는 서버 세션 actorUserId 만 전달.
    assert.match(s, /p_actor_user_id: req\.user!\.actorUserId!/);
});

test('LAND_AREA_SYNC queue는 admission wall timer와 AbortSignal로 대기·실행 worker를 실제 종료하고 wrapper timeout을 쓰지 않는다', async () => {
    const queue = await readFile(
        'src/services/land-area-sync/queue.ts',
        'utf8'
    );
    const service = await readFile(
        'src/services/land-area-sync/service.ts',
        'utf8'
    );
    assert.match(
        queue,
        /LAND_AREA_SYNC_ADMISSION_WALL_TIMEOUT_MS\s*=\s*10 \* 60_000/
    );
    assert.match(queue, /new PQueue\(\{ concurrency: 2 \}\)/);
    assert.doesNotMatch(
        queue,
        /new PQueue\(\{[^}]*timeout\s*:/
    );
    assert.match(
        queue,
        /setTimeout\([\s\S]*workerController\.abort\(\)[\s\S]*if \(!started\) queuedController\.abort\(\)[\s\S]*LAND_AREA_SYNC_ADMISSION_WALL_TIMEOUT_MS/
    );
    assert.match(
        queue,
        /started = true[\s\S]+signal: workerController\.signal[\s\S]+signal: queuedController\.signal/
    );
    assert.match(
        queue,
        /timedOut = true[\s\S]+await runLandAreaSyncJob\([\s\S]+if \(timedOut\)[\s\S]+ensureTimedOutJobHasDurableTerminal/
    );
    assert.match(queue, /clearTimeout\(deadlineTimer\)/);
    assert.match(
        service,
        /if \(aborted\(signal\)\) return; \/\/ terminal\/fatal 이후 apply 금지[\s\S]+deps\.db\.applyRpc/
    );
});

test('실행 중 wall timeout은 worker drain 뒤 PROCESSING을 durable FAILED로 닫고 기존 terminal은 보존한다', async () => {
    const { ensureTimedOutJobHasDurableTerminal } =
        await import(
            '../src/services/land-area-sync/queue-timeout-terminal'
        );
    const events: string[] = [];
    const controller = new AbortController();
    const worker = new Promise<void>((resolve) => {
        controller.signal.addEventListener(
            'abort',
            () => {
                setImmediate(() => {
                    events.push('worker-drained');
                    resolve();
                });
            },
            { once: true }
        );
    });

    controller.abort();
    await worker;
    const marked = await ensureTimedOutJobHasDurableTerminal({
        readJob: async () => {
            events.push('terminal-read');
            return {
                id: '11111111-1111-4111-8111-111111111111',
                union_id: '22222222-2222-4222-8222-222222222222',
                status: 'PROCESSING',
                progress: 50,
                preview_data: {
                    landAreaSync: {
                        schemaVersion: 2,
                    },
                },
                created_at: '2026-07-28T00:00:00.000Z',
                updated_at: '2026-07-28T00:00:00.000Z',
                error_log: null,
            };
        },
        markFailed: async () => {
            events.push('durable-failed');
            return true;
        },
    });
    assert.equal(marked, true);
    assert.deepEqual(events, [
        'worker-drained',
        'terminal-read',
        'durable-failed',
    ]);

    let overwriteAttempts = 0;
    const preserved = await ensureTimedOutJobHasDurableTerminal({
        readJob: async () => ({
            id: '11111111-1111-4111-8111-111111111111',
            union_id: '22222222-2222-4222-8222-222222222222',
            status: 'COMPLETED',
            progress: 100,
            preview_data: {
                landAreaSync: {
                    schemaVersion: 2,
                    outcome: 'APPLIED',
                    workerFinalization: {
                        version: 1,
                        finalizedAt: '2026-07-28T00:01:00.000Z',
                    },
                },
            },
            created_at: '2026-07-28T00:00:00.000Z',
            updated_at: '2026-07-28T00:01:00.000Z',
            error_log: null,
        }),
        markFailed: async () => {
            overwriteAttempts += 1;
            return true;
        },
    });
    assert.equal(preserved, false);
    assert.equal(overwriteAttempts, 0);
});

test('GET projection은 immutable worker finalization receipt 없는 raw terminal을 공개하지 않는다', async () => {
    const s = await gisRoute();
    assert.match(s, /receipt\.version === 1/);
    assert.match(s, /Date\.parse\(receipt\.finalizedAt\)/);
    assert.match(
        s,
        /row\.status === 'PROCESSING' \|\| finalized \? row\.status : 'PROCESSING'/
    );
    assert.match(s, /Math\.min\(row\.progress, 99\)/);
});

test('GET route 는 query union scope 를 검증하고 id\\+union\\+type 스코프 read 를 쓴다', async () => {
    const s = await gisRoute();
    // query union scope(system 제외) 검증.
    assert.match(s, /req\.user!\.unionId !== 'system' && req\.user!\.unionId !== unionId/);
    // id+union+type 스코프 repository read.
    assert.match(s, /getScopedJob\(client, jobId, unionId\)/);
    assert.match(s, /getScopedAdmissionJob\(client, admissionKey, unionId\)/);
    assert.match(s, /getLatestScopedJob\(client, unionId, pnu\)/);
    // 구 id-only updateSyncJobStatus 를 새 경로에서 쓰지 않는다.
    assert.ok(!/land-area-sync[\s\S]*updateSyncJobStatus/.test(s));
});

test('gis-system-admin 미들웨어 job scope 에 LAND_AREA_SYNC 가 포함된다', async () => {
    const s = await readFile('src/middleware/gis-system-admin.ts', 'utf8');
    assert.match(s, /'LAND_AREA_SYNC'/);
});
