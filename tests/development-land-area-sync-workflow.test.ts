import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(
    path.join(
        root,
        '.github/workflows/development-land-area-sync-run.yml'
    ),
    'utf8'
);
const captureWorkflow = fs.readFileSync(
    path.join(
        root,
        '.github/workflows/development-land-area-evidence-capture.yml'
    ),
    'utf8'
);
const runner = fs.readFileSync(
    path.join(root, 'src/operations/development-land-area-sync-runner.ts'),
    'utf8'
);
const cli = fs.readFileSync(
    path.join(root, 'src/cli/development-land-area-sync-runner.ts'),
    'utf8'
);
const validatorCli = fs.readFileSync(
    path.join(root, 'src/cli/development-land-area-sync-validate.ts'),
    'utf8'
);
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const guardian = fs.readFileSync(
    path.join(
        root,
        'scripts/development-land-area-sync-remote-guardian.sh'
    ),
    'utf8'
);

test('workflow는 protected environment secret의 actor UUID만 내부 사용하고 공개 입력을 금지한다', () => {
    const dispatchBlock = workflow.slice(
        workflow.indexOf('workflow_dispatch:'),
        workflow.indexOf('permissions:')
    );
    assert.match(workflow, /environment: land-area-sync-development-write/);
    assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
    assert.match(workflow, /type: choice/);
    assert.match(workflow, /mia-seven-representative-20260725/);
    assert.match(
        workflow,
        /ACTOR_AUTH_USER_ID: \$\{\{ secrets\.DEV_GIS_SYSTEM_ADMIN_AUTH_UUID \}\}/
    );
    assert.doesNotMatch(dispatchBlock, /actor_auth_user_id|auth UUID/i);
    assert.doesNotMatch(
        dispatchBlock,
        /[0-9a-f]{8}-[0-9a-f-]{27}|[0-9]{19}|secret/i
    );
    assert.doesNotMatch(workflow, /\$\{\{ inputs\.actor_auth_user_id \}\}/);
    assert.doesNotMatch(workflow, /EXPECTED_ACTOR_AUTH_USER_ID/);
    assert.doesNotMatch(
        workflow,
        /echo[^\n]*\$\{ACTOR_AUTH_USER_ID\}/
    );
});

test('791-2280 API target은 read-only capture에서만 선택되고 v2 전체 scope로 임시 approval을 검증한다', () => {
    const label =
        'mia-seven-791-2280-ldareg-api-readonly-20260725';
    assert.match(captureWorkflow, new RegExp(label));
    assert.match(
        captureWorkflow,
        /mia-seven-791-2280-ldareg-api-readonly-target-20260725\.json/
    );
    assert.match(
        captureWorkflow,
        /const approvedScopePnus = Array\.isArray\(target\.allowedScopePnus\)[\s\S]+pnus: approvedScopePnus,[\s\S]+targetCount: approvedScopePnus\.length/
    );
    assert.match(
        captureWorkflow,
        /const approvedScopeDigest = typeof target\.scopeDigest === "string"[\s\S]+manifestDigest: approvedScopeDigest/
    );
    assert.match(
        captureWorkflow,
        /evidence\.manifestDigest !== target\.manifestDigest/
    );
    assert.doesNotMatch(workflow, new RegExp(label));
    assert.doesNotMatch(
        workflow,
        /mia-seven-791-2280-ldareg-api-readonly-target-20260725\.json/
    );
});

test('미아7 전체 299 anchor API 재조회 legacy route는 read-only capture에 보존한다', () => {
    const label = 'mia-seven-full-299-api-readonly-20260728';
    const selection = captureWorkflow.slice(
        captureWorkflow.indexOf(`${label})`),
        captureWorkflow.indexOf(
            'mia-seven-auto-286-20260725)',
            captureWorkflow.indexOf(`${label})`)
        )
    );
    assert.match(captureWorkflow, new RegExp(`- ${label}`));
    assert.match(
        selection,
        /mia-seven-full-299-api-readonly-target-20260728\.json/
    );
    assert.match(selection, /target_count="299"/);
    assert.match(selection, /property_unit_count="429"/);
    assert.doesNotMatch(workflow, new RegExp(label));
    assert.doesNotMatch(
        workflow,
        /mia-seven-full-299-api-readonly-target-20260728\.json/
    );
});

test('미아7 278 official component·422 물건지(도로지분 7건 제외) 전체 재조회는 299 active PNU와 300 scanned PNU를 분리해 검증한다', () => {
    const label =
        'mia-seven-full-278-official-components-api-readonly-20260729';
    const selection = captureWorkflow.slice(
        captureWorkflow.indexOf(`${label})`),
        captureWorkflow.indexOf(
            'mia-seven-full-299-api-readonly-20260728)',
            captureWorkflow.indexOf(`${label})`)
        )
    );
    assert.match(
        captureWorkflow,
        new RegExp(`default: ${label}`)
    );
    assert.match(captureWorkflow, new RegExp(`- ${label}`));
    assert.match(
        selection,
        /mia-seven-full-278-official-components-api-readonly-target-20260729\.json/
    );
    assert.match(selection, /target_count="278"/);
    assert.match(selection, /property_unit_count="422"/);
    assert.match(
        captureWorkflow,
        /audit\?\.activePnuCount !== target\.expectedUnionActivePnuCount/
    );
    assert.match(
        captureWorkflow,
        /audit\?\.resolvedComponentCount !== target\.targetCount/
    );
    assert.match(
        captureWorkflow,
        /audit\?\.scannedPnuCount !== approvedScopePnus\.length/
    );
    assert.match(
        captureWorkflow,
        /audit\?\.verifiedNoDataCount[\s\S]+audit\?\.sameRunOfficialComponentCount[\s\S]+audit\?\.sameRunOfficialParcelCount[\s\S]+target\.targetCount/
    );
    assert.match(
        captureWorkflow,
        /audit\?\.promotionGate\?\.status !== "PASS"/
    );
    assert.match(
        captureWorkflow,
        /audit\?\.promotionGate\?\.writeEligible !== true/
    );
    assert.match(workflow, new RegExp(label));
    assert.match(
        workflow,
        /mia-seven-full-278-official-components-api-readonly-target-20260729\.json/
    );
    assert.match(
        workflow,
        /db_approval_path=""[\s\S]+evidence_path=""[\s\S]+full_refresh_mode="1"/
    );
    assert.match(
        workflow,
        /if \[\[ "\$\{FULL_REFRESH_MODE\}" == "0" \]\]; then[\s\S]+scp "\$\{ssh_options\[@\]\}" "\$\{DB_APPROVAL_PATH\}"/
    );
    assert.match(
        guardian,
        /-e LAND_AREA_SYNC_ENABLED=[\s\S]+development-land-area-evidence-capture\.js/
    );
    assert.match(
        guardian,
        /audit\?\.promotionGate\?\.status !== "PASS"[\s\S]+audit\?\.promotionGate\?\.writeEligible !== true/
    );
    assert.match(
        guardian,
        /audit\?\.verifiedNoDataCount[\s\S]+audit\?\.sameRunOfficialComponentCount[\s\S]+audit\?\.sameRunOfficialParcelCount[\s\S]+target\.targetCount/
    );
    assert.match(
        guardian,
        /runner\.validateDevelopmentRunnerManifests\(target, approval, evidence\)/
    );
    assert.match(
        runner,
        /DEVELOPMENT_FULL_REFRESH_ADMISSION_CUTOFF_MS\s*=\s*225 \* 60_000/
    );
    assert.match(
        runner,
        /FULL_REFRESH_ADMISSION_CUTOFF_REACHED/
    );
    for (const table of [
        'land_lots',
        'building_land_lots',
        'buildings',
        'building_units',
        'building_external_refs',
        'building_registry_land_lot_relations',
        'building_land_lot_manual_overrides',
    ]) {
        assert.match(cli, new RegExp(`['"]${table}['"]`));
    }
    assert.match(cli, /select\('\*', \{ count: 'exact' \}\)/);
    assert.match(cli, /pageSize = 500/);
    assert.match(cli, /\$\{code\}_TRUNCATED/);
    assert.match(cli, /readPropertyUnitLandRights/);
});

test('read-only capture는 raw evidence를 업로드하지 않고 비식별 순번 진단·집계만 게시한 뒤 private 파일을 제거한다', () => {
    const uploadBlock = captureWorkflow.slice(
        captureWorkflow.indexOf(
            '- name: Upload sanitized read-only capture artifact'
        ),
        captureWorkflow.indexOf('- name: Enforce capture gate')
    );
    const publicArtifactBlock = captureWorkflow.slice(
        captureWorkflow.indexOf(
            '- name: Build sanitized read-only capture artifact'
        ),
        captureWorkflow.indexOf(
            '- name: Upload sanitized read-only capture artifact'
        )
    );
    const cleanupBlock = captureWorkflow.slice(
        captureWorkflow.indexOf('- name: Remove private capture files')
    );
    assert.match(
        uploadBlock,
        /path: development-land-area-evidence-public\/artifact\.json/
    );
    assert.doesNotMatch(
        uploadBlock,
        /development-land-area-evidence-output|audit\.json|evidence\.json/
    );
    assert.match(
        publicArtifactBlock,
        /land-area-development-evidence-public-artifact@4/
    );
    assert.match(publicArtifactBlock, /retry: \{/);
    assert.match(publicArtifactBlock, /rounds: audit\.retry\.rounds/);
    assert.match(
        publicArtifactBlock,
        /retriedAnchorCount: audit\.retry\.retriedAnchorCount/
    );
    assert.match(
        publicArtifactBlock,
        /recoveredAnchorCount: audit\.retry\.recoveredAnchorCount/
    );
    assert.match(
        publicArtifactBlock,
        /skipped: audit\.retry\.skipped/
    );
    assert.match(publicArtifactBlock, /attempts: entry\.attempts/);
    assert.match(
        publicArtifactBlock,
        /Number\.isSafeInteger\(entry\.attempts\)/
    );
    assert.match(publicArtifactBlock, /entry\.attempts >= 0/);
    assert.match(
        publicArtifactBlock,
        /const retrySkippedValues = new Set\(/
    );
    assert.match(publicArtifactBlock, /"TOO_MANY_FAILURES"/);
    assert.match(publicArtifactBlock, /!audit\.retry\b/);
    assert.match(
        publicArtifactBlock,
        /Number\.isSafeInteger\(audit\.retry\.rounds\)/
    );
    assert.match(publicArtifactBlock, /audit\.retry\.rounds < 0/);
    assert.match(
        publicArtifactBlock,
        /Number\.isSafeInteger\(audit\.retry\.retriedAnchorCount\)/
    );
    assert.match(
        publicArtifactBlock,
        /audit\.retry\.retriedAnchorCount < 0/
    );
    assert.match(
        publicArtifactBlock,
        /Number\.isSafeInteger\(audit\.retry\.recoveredAnchorCount\)/
    );
    assert.match(
        publicArtifactBlock,
        /audit\.retry\.recoveredAnchorCount < 0/
    );
    assert.match(
        publicArtifactBlock,
        /retrySkippedValues\.has\(audit\.retry\.skipped\)/
    );
    assert.match(publicArtifactBlock, /redactedAggregate/);
    assert.match(publicArtifactBlock, /redactedIssueCounts/);
    assert.match(publicArtifactBlock, /redactedFailureDetails/);
    assert.match(publicArtifactBlock, /targetOrdinal: index \+ 1/);
    assert.match(publicArtifactBlock, /failureDetailsValid/);
    assert.match(publicArtifactBlock, /classifyFailure/);
    assert.match(
        publicArtifactBlock,
        /redactedFailureDetails\.filter/
    );
    assert.match(publicArtifactBlock, /activePnuCount/);
    assert.match(publicArtifactBlock, /resolvedComponentCount/);
    assert.match(publicArtifactBlock, /scannedPnuCount/);
    assert.match(publicArtifactBlock, /sameRunOfficialComponentCount/);
    assert.match(publicArtifactBlock, /sameRunOfficialParcelCount/);
    assert.match(publicArtifactBlock, /verifiedNoDataCount/);
    assert.match(
        publicArtifactBlock,
        /\["CAPTURED", "VERIFIED_NO_DATA", "FAILED"\]/
    );
    assert.match(publicArtifactBlock, /"VERIFIED_NO_DATA"/);
    assert.match(publicArtifactBlock, /promotionGate/);
    assert.doesNotMatch(publicArtifactBlock, /anchorIndex/);
    assert.doesNotMatch(publicArtifactBlock, /redactedDiagnostics/);
    assert.doesNotMatch(publicArtifactBlock, /targetPnu/);
    assert.match(publicArtifactBlock, /productionWrites: 0/);
    assert.match(
        publicArtifactBlock,
        /anchorPnu\|propertyUnitId\|allowedPrestates\|proposedLandAreas\|landArea/
    );
    assert.match(
        publicArtifactBlock,
        /\^\(\?!\.\*\[0-9\]\{19\}\)\[A-Z0-9_\]\{1,100\}/
    );
    assert.match(publicArtifactBlock, /\\b\[0-9\]\{19\}\\b/);
    assert.equal(
        /^(?!.*[0-9]{19})[A-Z0-9_]{1,100}$/.test(
            'ERR_1130510100107912280'
        ),
        false
    );
    assert.match(cleanupBlock, /rm -f -- "\$\{candidate\}"/);
    assert.match(cleanupBlock, /rmdir -- "\$\{root\}"/);
    assert.match(cleanupBlock, /test ! -e "\$\{root\}"/);
});

test('workflow는 full artifact를 로컬 gate에만 쓰고 strict 공개 artifact만 업로드한다', () => {
    const uploadBlock = workflow.slice(
        workflow.indexOf('- name: Upload sanitized run artifact'),
        workflow.indexOf('- name: Enforce development run gate')
    );
    const gateBlock = workflow.slice(
        workflow.indexOf('- name: Enforce development run gate')
    );
    assert.match(workflow, /--manifest-label "\$\{MANIFEST_LABEL\}"/);
    assert.match(
        workflow,
        /--public-out "\.development-land-area-sync\/public-artifact\.json"/
    );
    assert.match(
        uploadBlock,
        /path: development-land-area-sync-output\/public-artifact\.json/
    );
    assert.doesNotMatch(
        uploadBlock,
        /path: development-land-area-sync-output\/artifact\.json/
    );
    assert.match(
        gateBlock,
        /artifact_file="development-land-area-sync-output\/artifact\.json"/
    );
    assert.match(
        validatorCli,
        /createDevelopmentPublicRunArtifact[\s\S]+validateDevelopmentPublicRunArtifact/
    );
    assert.match(validatorCli, /flag: 'wx'/);
    assert.match(runner, /PUBLIC_RUN_ARTIFACT_INVALID/);
});

test('workflow는 SSH와 분리된 guardian이 공통 operation lock을 terminal drain과 cleanup까지 보유한다', () => {
    assert.match(
        guardian,
        /application_root="\$\{HOME\}\/alimtalk-proxy"[\s\S]+operation_lock_path="\$\{application_root\}\/\.land-area-sync-operation\.lock"/
    );
    assert.match(guardian, /exec 8>>"\$\{operation_lock_path\}"/);
    assert.match(guardian, /flock -w 300 8/);
    assert.match(
        workflow,
        /nohup setsid env[\s\S]+bash "\$\{guardian\}"/
    );
    assert.match(workflow, /while \[\[ ! -f "\$\{status_file\}" \]\]/);
    assert.match(workflow, /kill -0 "\$\{guardian_pid\}"/);
    assert.match(workflow, /exec 7>>"\$\{operation_lock_path\}"/);
    assert.match(workflow, /flock -w 30 7/);
    assert.doesNotMatch(workflow, /timeout .*development-land-area-sync-runner/);
    assert.doesNotMatch(
        `${workflow}\n${guardian}`,
        /production_lock_path|\.tonghari-api-production\.lock/
    );
    assert.match(workflow, /timeout-minutes: 420/);
    assert.match(guardian, /capture_timeout_seconds=3600/);
    assert.match(guardian, /runner_timeout_seconds=18000/);
    assert.match(guardian, /post_timeout_quarantine_seconds=720/);
    assert.match(
        guardian,
        /timeout --foreground --kill-after=30s "\$\{capture_timeout_seconds\}"[\s\S]+development-land-area-evidence-capture\.js/
    );
    assert.match(
        guardian,
        /timeout --foreground --kill-after=30s "\$\{runner_timeout_seconds\}"/
    );
    assert.match(
        guardian,
        /runner_status.*124.*runner_status.*137[\s\S]+sleep "\$\{post_timeout_quarantine_seconds\}"/
    );
    assert.ok(
        3_600 + 18_000 + 720 + 300 + 600 < 420 * 60,
        'lock/capture/runner/quarantine/cleanup은 workflow hard timeout에 setup 여유를 남겨야 한다'
    );
    assert.match(
        guardian,
        /host_self_cleanup_delay_seconds=1200[\s\S]+schedule_host_self_cleanup/
    );
    assert.match(
        guardian,
        /exec 8>&-[\s\S]+sleep "\$\{host_self_cleanup_delay_seconds\}"[\s\S]+rm -f --[\s\S]+artifact\.json[\s\S]+rmdir -- "\$\{host_root\}"/
    );
    assert.match(
        guardian,
        /cleanup_complete=1[\s\S]+write_private_line "\$\{host_status\}" "\$\{final_status\}"[\s\S]+schedule_host_self_cleanup[\s\S]+trap - EXIT/
    );
});

test('workflow와 runner는 raw JWT/secret/log를 artifact나 출력으로 내보내지 않는다', () => {
    assert.doesNotMatch(workflow, /docker logs/);
    assert.doesNotMatch(workflow, /DEV_API_JWT_SECRET/);
    assert.doesNotMatch(workflow, /DEV_SUPABASE_SERVICE_ROLE_KEY/);
    assert.doesNotMatch(workflow, /Authorization:|Bearer \$\{/);
    assert.doesNotMatch(
        runner,
        /console\.(?:log|error)|process\.(?:stdout|stderr)/
    );
    assert.doesNotMatch(cli, /process\.env\.(?:JWT_SECRET|SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)\b.*write/);
});

test('DB 직접 접근은 target 축 service-role read-only select이며 write는 localhost canonical API에만 맡긴다', () => {
    // 접속 정보는 validateDevelopmentRunnerEnvironment 의 target 선택 결과만 쓴다.
    // 원시 env 를 CLI 에서 직접 집어 쓰는 경로는 금지한다.
    assert.match(cli, /environment\.supabaseUrl/);
    assert.match(cli, /environment\.supabaseServiceRoleKey/);
    assert.doesNotMatch(cli, /process\.env\.DEV_SUPABASE_URL/);
    assert.doesNotMatch(cli, /process\.env\.SUPABASE_URL/);
    // 선언한 target 과 실제 접속 프로젝트의 exact 일치를 강제한다.
    assert.match(
        cli,
        /SUPABASE_URL_BY_TARGET\[target\.databaseTarget\]/
    );
    assert.match(cli, /RUNNER_DATABASE_TARGET_MISMATCH/);
    assert.match(cli, /yxypndgipnxrdfyctmvh/);
    assert.match(cli, /bpdjashtxqrcgxfequgf/);
    assert.match(cli, /\.from\('property_units'\)[\s\S]+\.select\(/);
    assert.match(
        cli,
        /land_area_synced_at, land_area_sync_job_id/
    );
    assert.match(cli, /\.in\('land_area_sync_job_id', syncJobIds\)/);
    assert.doesNotMatch(
        cli,
        /\.(?:insert|update|upsert|delete|rpc)\s*\(/
    );
    assert.match(runner, /const LOCAL_API_ORIGIN = 'http:\/\/127\.0\.0\.1:3100'/);
    // JWT 는 서명키(kid)가 환경을 확정한다 — dev/prod 두 flavor 만 존재한다.
    assert.match(runner, /keyid: development \? 'dev' : 'prod'/);
    assert.match(
        runner,
        /iss: development \? 'tonghari-web-dev' : 'tonghari-web'/
    );
    assert.match(runner, /aud: 'tonghari-api'/);
});

test('cleanup은 host/container/local evidence 부재를 재검증하며 실패를 무시하지 않는다', () => {
    assert.doesNotMatch(workflow, /\|\| true/);
    assert.doesNotMatch(guardian, /\|\| true/);
    assert.match(guardian, /cleanup_container_inputs/);
    assert.match(guardian, /cleanup_host_inputs/);
    assert.match(
        guardian,
        /docker exec "\$\{target_container\}" test ! -e "\$\{candidate\}"/
    );
    assert.match(workflow, /test ! -e "\$\{run_root\}"/);
    assert.match(workflow, /test ! -e "\$\{validation_root\}"/);
});

test('runner soft timeout은 API queue 10분보다 길고 terminal 전 반환하지 않는다', () => {
    assert.match(runner, /DEVELOPMENT_API_QUEUE_TIMEOUT_MS = 10 \* 60_000/);
    assert.match(
        runner,
        /DEVELOPMENT_JOB_POLL_SOFT_TIMEOUT_MS =[\s\S]+DEVELOPMENT_API_QUEUE_TIMEOUT_MS \+ 60_000/
    );
    assert.match(
        runner,
        /current\.status === 'PROCESSING'[\s\S]+!hasWorkerFinalization\(current\)/
    );
    assert.match(runner, /JOB_POLL_SOFT_TIMEOUT_AFTER_TERMINAL/);
});

test('admission 응답 유실 진단 프로브는 고정 토큰 마커·카운트만 내보내고 원문 로그를 반출하지 않는다', () => {
    const probeCli = fs.readFileSync(
        path.join(root, 'src/cli/development-land-area-sync-probe.ts'),
        'utf8'
    );
    const probeModule = fs.readFileSync(
        path.join(
            root,
            'src/operations/land-area-sync-localhost-probe.ts'
        ),
        'utf8'
    );
    // guardian: fresh-process 프로브 + runner 센티널 승격 + 실패 시 카운트 마커
    assert.match(guardian, /development-land-area-sync-probe\.js/);
    assert.match(
        guardian,
        /append_stage "PRERUN_PROBE_EXIT_\$\{prerun_probe_status\}"/
    );
    assert.match(
        guardian,
        /\^LAND_AREA_SYNC_RUNNER_PROBE_\[A-Z0-9_\]\{1,44\}\$/
    );
    assert.match(
        guardian,
        /docker logs --since "\$\{probe_window_started_at\}"/
    );
    assert.match(guardian, /ADMISSION_202_LOGGED_/);
    assert.match(guardian, /RESPONSE_CLOSED_EARLY_/);
    assert.match(guardian, /GIS_AUTH_SLOW_LOGGED_/);
    // 서버 로그 원문은 stage/host 어디에도 쓰지 않는다 — grep 카운트만 쓴다.
    assert.doesNotMatch(
        guardian,
        /append_stage "\$\{server_http_window\}"|server_http_window[^\n]*>+ *"?\$\{host_/
    );
    // runner CLI: in-process 프로브 센티널(startup/postfail) — target 축 인증 전달
    assert.match(
        cli,
        /emitRunnerProbe\('STARTUP', args\.actorAuthUserId, probeAuth\)/
    );
    assert.match(
        cli,
        /emitRunnerProbe\(\s*'POSTFAIL',\s*args\.actorAuthUserId,\s*probeAuth\s*\)/
    );
    assert.match(
        cli,
        /ADMISSION\|API_NETWORK\|API_RESPONSE/
    );
    // 진단이 게이트 판정을 바꾸지 않는다 — 프로브는 exitCode에 관여하지 않는다.
    assert.match(cli, /LAND_AREA_SYNC_RUNNER_PROBE_\$\{phase\}_EXIT_/);
    // localhost client 타임아웃은 서버측 지연/유실 판별을 위해 60초다.
    assert.match(
        runner,
        /LOCAL_API_REQUEST_TIMEOUT_MS = 60_000/
    );
    assert.doesNotMatch(runner, /15_000/);
    // 프로브 출력은 고정 토큰·상태코드·소요시간뿐 — 식별자 출력 금지.
    assert.match(probeModule, /LAND_AREA_SYNC_PROBE_SUMMARY/);
    assert.doesNotMatch(
        probeCli,
        /anchorPnu|unionId|process\.env\.DEV_SUPABASE/
    );
});

test('image는 non-root runner private directory를 mode 700으로 준비한다', () => {
    assert.match(dockerfile, /\.development-land-area-sync/);
    assert.match(
        dockerfile,
        /\.development-land-area-evidence-capture/
    );
    assert.match(
        dockerfile,
        /chown -R nodejs:nodejs[\s\S]+\.development-land-area-sync[\s\S]+\.development-land-area-evidence-capture/
    );
    assert.match(
        dockerfile,
        /chmod 700[\s\S]+\.development-land-area-sync[\s\S]+\.development-land-area-evidence-capture/
    );
});

test('미아7 production read-only 캡처 경로는 캡처 워크플로에만 있고 합성 approval은 target 환경을 따른다', () => {
    const label =
        'mia-seven-full-278-official-components-api-readonly-production-20260812';
    const selection = captureWorkflow.slice(
        captureWorkflow.indexOf(`${label})`),
        captureWorkflow.indexOf(
            '*)',
            captureWorkflow.indexOf(`${label})`)
        )
    );
    assert.match(captureWorkflow, new RegExp(`- ${label}`));
    assert.match(
        selection,
        /mia-seven-full-278-official-components-api-readonly-production-target-20260812\.json/
    );
    assert.match(selection, /target_count="278"/);
    assert.match(selection, /property_unit_count="422"/);
    // 합성 approval 하드코딩 금지 — target 문서의 환경을 그대로 따라야 한다.
    assert.match(
        captureWorkflow,
        /databaseTarget: target\.databaseTarget/
    );
    assert.doesNotMatch(
        captureWorkflow,
        /databaseTarget: "development"/
    );
    // production 은 write run 워크플로에 아직 없다 — 실행 창 설계 전 유출 방지.
    assert.doesNotMatch(workflow, new RegExp(label));
    assert.doesNotMatch(
        workflow,
        /production-target-20260812\.json/
    );
    // dev 기본값은 그대로다.
    assert.match(
        captureWorkflow,
        /default: mia-seven-full-278-official-components-api-readonly-20260729/
    );
});
