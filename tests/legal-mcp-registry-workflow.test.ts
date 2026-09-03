import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(
    join(process.cwd(), '.github/workflows/legal-mcp-client-registry.yml'),
    'utf8'
);
const remoteOperatorPath = join(
    process.cwd(),
    'scripts/legal-mcp-registry-remote.sh'
);
const remoteOperator = readFileSync(remoteOperatorPath, 'utf8');

test('registry workflow는 main 수동 실행과 전용 environment만 허용한다', () => {
    assert.match(workflow, /^on:\n  workflow_dispatch:/m);
    assert.doesNotMatch(workflow, /^\s{2}(?:push|pull_request|schedule):/m);
    assert.match(workflow, /^permissions:\n  contents: read$/m);
    assert.match(workflow, /environment: legal-mcp-registry/);
    assert.match(workflow, /REGISTRY_EVENT_NAME.*github\.event_name/);
    assert.match(workflow, /REGISTRY_REF.*github\.ref/);
    assert.match(workflow, /workflow_dispatch is required/);
    assert.match(workflow, /refs\/heads\/main is required/);
    assert.match(
        workflow,
        /^concurrency:\n  group: legal-mcp-client-registry-production\n  cancel-in-progress: false$/m
    );
});

test('add digest는 dispatch commitment에 결합되고 SSH stdin으로만 전달된다', () => {
    assert.match(
        workflow,
        /secrets\.LEGAL_MCP_REGISTRY_PENDING_SHA256/
    );
    assert.match(workflow, /unset REGISTRY_PENDING_SHA256/);
    assert.match(workflow, /::add-mask::%s/);
    assert.match(
        workflow,
        /JSON\.stringify\(\{\s+version: 1,\s+operationId: process\.argv\[1\],\s+action: "add",\s+clientId: process\.argv\[2\],\s+tokenSha256: digest,/s
    );
    assert.match(
        workflow,
        /actual_commitment.*REGISTRY_PENDING_COMMITMENT/s
    );
    assert.match(
        workflow,
        /printf '%s\\n' "\$\{pending_digest\}" \| ssh/
    );
    assert.doesNotMatch(workflow, /GITHUB_ENV|GITHUB_OUTPUT/);
    assert.doesNotMatch(workflow, /docker[^\n]*-e[^\n]*(?:digest|sha256)/i);

    const remoteCommand = workflow.match(/remote_command="([^"]+)"/)?.[1] ?? '';
    assert.notEqual(remoteCommand, '');
    assert.doesNotMatch(
        remoteCommand,
        /pending_digest|REGISTRY_PENDING_SHA256|TOKEN_SHA256/i
    );
    assert.doesNotMatch(remoteOperator, /REGISTRY_PENDING_SHA256/);
    assert.doesNotMatch(remoteOperator, /--client-id[^\n]*--replace/);
});

test('workflow는 pinned host key와 exact 전송 script를 검증한다', () => {
    assert.match(workflow, /EC2_SSH_FINGERPRINT/);
    assert.match(workflow, /StrictHostKeyChecking=yes/);
    assert.match(workflow, /IdentitiesOnly=yes/);
    assert.match(workflow, /UserKnownHostsFile=/);
    assert.match(workflow, /ssh-keyscan/);
    assert.match(workflow, /sha256sum scripts\/legal-mcp-registry-remote\.sh/);
    assert.match(workflow, /EXPECTED_SCRIPT_SHA256/);
    assert.doesNotMatch(workflow, /appleboy|allenvs|set -x/);
});

test('remote operator는 production flock과 file registry 보안 계약을 유지한다', () => {
    assert.match(remoteOperator, /\.tonghari-api-production\.lock/);
    assert.match(remoteOperator, /exec 9>>"\$\{lock_path\}"/);
    assert.match(remoteOperator, /flock -w 2400 9/);
    assert.match(remoteOperator, /\/proc\/\$\$\/fd\/9/);
    assert.match(remoteOperator, /dirStat\.uid === 1001 && dirStat\.gid === 1001/);
    assert.match(remoteOperator, /dirStat\.mode & 0o7777.*0o700/);
    assert.match(remoteOperator, /fileStat\.uid === 1001 && fileStat\.gid === 1001/);
    assert.match(remoteOperator, /fileStat\.mode & 0o7777.*0o600/);
    assert.match(remoteOperator, /\.legal-mcp-file-registry-v1/);
    assert.match(remoteOperator, /\.legal-mcp-registry-commit-unknown/);
    assert.match(remoteOperator, /registry_fs_attest\(\)/);
    assert.match(remoteOperator, /docker exec -i --user 1001:1001/);
    assert.match(remoteOperator, /fs\.lstatSync\(dir\)/);
    assert.match(remoteOperator, /fs\.readdirSync\(dir\)/);
    assert.match(remoteOperator, /names\.includes\("clients\.json\.lock"\)/);
    assert.doesNotMatch(remoteOperator, /find "\$\{registry_dir\}"/);
    assert.doesNotMatch(remoteOperator, /-e "\$\{registry_lock\}"/);
});

test('updater는 현재 immutable image와 최소 권한만 사용한다', () => {
    assert.match(
        remoteOperator,
        /configured_image.*ghcr\\\.io\/dlswn666\/alimtalk-proxy@sha256:/s
    );
    assert.match(remoteOperator, /docker image inspect.*configured_image/s);
    assert.match(remoteOperator, /running_container_id/);
    assert.match(remoteOperator, /--network none/);
    assert.match(remoteOperator, /--read-only/);
    assert.match(remoteOperator, /--cap-drop ALL/);
    assert.match(remoteOperator, /--security-opt no-new-privileges:true/);
    assert.match(remoteOperator, /--user 1001:1001/);
    assert.match(remoteOperator, /--pids-limit 64/);
    assert.match(remoteOperator, /--memory 128m/);
    assert.match(remoteOperator, /,readonly/);
    assert.doesNotMatch(remoteOperator, /docker (?:pull|build)/);
    assert.doesNotMatch(remoteOperator, /\/var\/run\/docker\.sock/);
});

test('mutation은 absent/present와 count 전이를 검증하고 재시도를 금지한다', () => {
    assert.match(remoteOperator, /State-changing operations cannot run from a re-run attempt/);
    assert.match(remoteOperator, /pre_target.*pre_count.*Add precondition failed/s);
    assert.match(remoteOperator, /pre_target.*pre_count.*Revoke precondition failed/s);
    assert.match(remoteOperator, /pre_count \+ 1/);
    assert.match(remoteOperator, /pre_count - 1/);
    assert.match(remoteOperator, /Add postcondition failed/);
    assert.match(remoteOperator, /Revoke postcondition failed/);
    assert.match(remoteOperator, /COMMIT_STATE_UNKNOWN/);
    assert.match(remoteOperator, /registry lock, temporary file, or file contract is unsafe/);
    assert.match(remoteOperator, /docker create -i --name "\$\{updater_name\}"/);
    assert.match(remoteOperator, /docker start -a -i "\$\{updater_name\}"/);
    assert.match(remoteOperator, /\.State\.Status/);
    assert.match(remoteOperator, /\.State\.ExitCode/);
    assert.match(remoteOperator, /failed updater did not preserve the pre-state/);
    assert.match(remoteOperator, /parsed_count.*pre_count.*parsed_target.*pre_target/s);
    assert.match(workflow, /COMMIT_STATE_UNKNOWN: do not retry; use guarded recover/);
    assert.doesNotMatch(workflow, /gh run rerun|retry-[a-z]|for attempt|while.*retry/i);
});

test('known precommit과 commit-state-unknown은 별도 상태로 전달된다', () => {
    assert.match(remoteOperator, /exit "\$\{2:-64\}"/);
    assert.match(remoteOperator, /known-precommit-failure/);
    assert.match(remoteOperator, /phase="precommit"/);
    assert.match(remoteOperator, /phase="mutation-started"/);
    assert.match(remoteOperator, /phase="known-precommit"/);
    assert.match(workflow, /remote_completed=0/);
    assert.match(workflow, /remote_success=0/);
    assert.match(workflow, /remote_unknown=0/);
    assert.match(workflow, /ssh_status.*-eq 64/s);
    assert.match(workflow, /remote_completed=1\n\s+remote_unknown=0/);
    assert.match(workflow, /ssh_status.*-eq 75.*ssh_status.*-eq 255.*ssh_status.*-ge 128/s);
    assert.match(workflow, /COMMIT_STATE_UNKNOWN: do not retry; use guarded recover/);
    assert.match(workflow, /REMOTE_COMPLETED=.*REMOTE_SUCCESS=.*REMOTE_UNKNOWN=/);
    assert.match(
        workflow,
        /if \[\[ "\$\{REGISTRY_OPERATION\}" == "add" \|\| "\$\{REGISTRY_OPERATION\}" == "revoke" \]\]; then\n\s+remote_unknown=1/
    );
    assert.match(workflow, /Recovery did not complete; the registry was never mutated/);
});

test('mutation은 docker start 전에 durable v3 intent를 flush하고 outcome을 보존한다', () => {
    assert.match(
        remoteOperator,
        /version=3\\nrunKey=%s\\noperation=%s\\noperationId=%s\\nclientId=%s\\npreCount=%s\\npreState=%s\\npostCount=%s\\npostState=%s\\noutcome=%s/
    );
    assert.match(remoteOperator, /sync -d "\$\{unknown_marker\}"/);
    assert.match(remoteOperator, /sync -f "\$\{app_root\}"/);
    assert.match(
        remoteOperator,
        /loaded_outcome.*\^\(intent\|verified\|known-precommit\|unknown\)\$/s
    );

    const mutationFunction = remoteOperator.match(
        /run_mutation_container\(\) \{[\s\S]*?\n\}/
    )?.[0] ?? '';
    const intent = mutationFunction.indexOf('write_operation_marker intent');
    const phase = mutationFunction.indexOf('phase="mutation-started"');
    const start = mutationFunction.indexOf('docker start -a');
    assert.ok(intent >= 0 && intent < phase && phase < start);
    assert.match(mutationFunction, /write_operation_marker known-precommit/);
    assert.match(remoteOperator, /write_operation_marker verified/);
    assert.match(
        remoteOperator,
        /an earlier mutation requires guarded recovery/
    );
});

test('workflow는 terminal outcome을 별도 SSH ACK하고 durable receipt로 응답 유실을 판별한다', () => {
    assert.match(workflow, /REGISTRY_PROTOCOL_ACTION='ack'/);
    assert.match(workflow, /REGISTRY_ACK_EXPECTED_OUTCOME=/);
    assert.match(workflow, /ack_expected_outcome="verified"/);
    assert.match(workflow, /ack_expected_outcome="known-precommit"/);
    assert.match(workflow, /ssh .*"\$\{ack_command\}" <\/dev\/null/);
    assert.match(workflow, /attempting one idempotent ACK resume/);
    assert.match(workflow, /ack_resume_status=\$\?/);
    assert.match(workflow, /ack_resume_status.*-eq 0[\s\S]*remote_acknowledged=1/);
    assert.ok(
        (workflow.match(/ssh .*"\$\{ack_command\}" <\/dev\/null/g) ?? []).length >= 2,
        'initial ACK and one idempotent resume must both be dispatched'
    );
    assert.match(workflow, /remote_acknowledged=1/);
    assert.match(workflow, /ACK_REQUIRED:[^\n]+guarded recover/);
    assert.match(workflow, /ACK_REQUIRED:[\s\S]*?exit 75/);
    assert.match(workflow, /receipt_matches_current=1/);
    assert.match(workflow, /cleanup_status.*-eq 20.*remote_completed/s);
    assert.match(workflow, /receipt_pre_state.*absent.*receipt_post_state.*present/s);
    assert.match(workflow, /receipt_post_count.*receipt_pre_count \+ 1/s);
    assert.match(workflow, /receipt_pre_state.*present.*receipt_post_state.*absent/s);
    assert.match(workflow, /receipt_pre_count.*receipt_post_count \+ 1/s);
    assert.doesNotMatch(
        workflow,
        /printf[^\n]+version=2[^\n]+legal-mcp-registry-commit-unknown/
    );
});

test('ACK는 marker+receipt 또는 marker+temp 중단 지점에서 멱등 resume한다', () => {
    const ackFunction = remoteOperator.match(
        /acknowledge_operation\(\) \{[\s\S]*?\n\}/
    )?.[0] ?? '';
    assert.match(ackFunction, /loaded_run_key.*REGISTRY_RUN_ID.*REGISTRY_RUN_ATTEMPT/s);
    assert.match(ackFunction, /loaded_operation_id.*REGISTRY_OPERATION_ID/s);
    assert.match(ackFunction, /loaded_outcome.*ack_expected_outcome/s);
    assert.match(ackFunction, /pre_count.*expected_count.*current_state.*expected_state/s);
    assert.match(ackFunction, /assert_no_registry_writer_residue/);
    assert.match(ackFunction, /verify_health/);
    assert.match(ackFunction, /verify_container_unchanged/);
    const verifyIndex = ackFunction.lastIndexOf('load_operation_marker');
    const archiveIndex = ackFunction.indexOf(
        'mv -T -- "${receipt_temp}" "${receipt_path}"'
    );
    assert.ok(verifyIndex >= 0 && verifyIndex < archiveIndex);
    assert.match(ackFunction, /receipts_dir/);
    assert.match(ackFunction, /stat -c '%u:%a'.*receipts_dir.*700/s);
    assert.match(ackFunction, /stat -c '%u:%a'.*receipt_path.*600/s);
    assert.match(ackFunction, /both a receipt and a receipt temporary file/);
    assert.match(ackFunction, /existing receipt does not match the pending marker/);
    assert.match(ackFunction, /existing receipt temporary file does not match the pending marker/);
    assert.match(ackFunction, /receipt_identity=.*stat -c '%d:%i'.*receipt_path/s);
    assert.match(ackFunction, /receipt_identity=.*stat -c '%d:%i'.*receipt_temp/s);
    assert.match(ackFunction, /staged receipt changed before publish/);
    assert.match(ackFunction, /sync -d "\$\{receipt_path\}"/);
    assert.match(ackFunction, /sync -f "\$\{receipts_dir\}"/);
    const stagedSync = ackFunction.indexOf('sync -d "${receipt_temp}"');
    const receiptSync = ackFunction.indexOf('sync -f "${receipts_dir}"');
    const retire = ackFunction.indexOf('rm -f -- "${unknown_marker}"');
    assert.ok(stagedSync >= 0 && stagedSync < archiveIndex);
    assert.ok(archiveIndex < receiptSync && receiptSync < retire);
    assert.match(
        ackFunction,
        /stat -c '%d:%i'.*receipt_path.*receipt_identity[\s\S]*ACK durable receipt cannot be attested/
    );
    assert.match(
        ackFunction,
        /stat -c '%d:%i'.*unknown_marker.*marker_identity[\s\S]*rm -f -- "\$\{unknown_marker\}"/
    );
    assert.doesNotMatch(ackFunction, /rm -f -- "\$\{receipt_path\}"/);
    assert.doesNotMatch(
        ackFunction,
        /legal-mcp-registry\.js (?:add|revoke)|clients\.json[^\n]*(?:>|rm)/
    );
});

test('updater 부재 증명은 docker 열거 실패를 0건으로 삼키지 않는다', () => {
    assert.match(remoteOperator, /count_registry_updaters\(\)/);
    assert.match(
        remoteOperator,
        /names="\$\(docker container ls -a --format '\{\{\.Names\}\}'\)" \|\| return 1/
    );
    assert.doesNotMatch(
        remoteOperator,
        /docker container ls -a[^\n]*\n?[^\n]*grep -Ec[^\n]*\|\| true/
    );
    assert.match(remoteOperator, /registry updater enumeration failed/);
    assert.match(remoteOperator, /Recover cannot enumerate registry updaters/);
});

test('active marker 직후 trap을 설치하고 stdin trailing bytes를 거부한다', () => {
    const activeCreate = remoteOperator.indexOf(
        `(set -o noclobber; printf '%s\\n' "\${active_expected_payload}" > "\${active_path}")`
    );
    const exitTrap = remoteOperator.indexOf('trap cleanup EXIT');
    const deployPrecheck = remoteOperator.indexOf(
        'if [[ ! -e "${lock_path}"',
        activeCreate
    );
    assert.ok(activeCreate >= 0);
    assert.ok(exitTrap >= 0 && exitTrap < activeCreate && activeCreate < deployPrecheck);
    assert.match(remoteOperator, /boot_id=.*kernel\/random\/boot_id/);
    assert.match(remoteOperator, /proc_start_time/);
    assert.match(remoteOperator, /runKey=%s\\npid=%s\\nbootId=%s\\nstartTime=%s/);
    assert.match(
        remoteOperator,
        /if IFS= read -r _unexpected_input \|\| \[\[ -n "\$\{_unexpected_input\}" \]\]; then/
    );
});

test('recover는 승인된 count/state와 정확한 residue만 정리한다', () => {
    assert.match(workflow, /options: \[validate, list, add, revoke, recover\]/);
    assert.match(workflow, /expected_client_count/);
    assert.match(workflow, /expected_client_state/);
    assert.match(workflow, /\^\(present\|absent\)\$/);
    assert.match(remoteOperator, /inspect_recovery_evidence/);
    assert.match(remoteOperator, /version=3/);
    assert.match(remoteOperator, /loaded_pre_count/);
    assert.match(remoteOperator, /loaded_post_count/);
    assert.match(remoteOperator, /verified post-state/);
    assert.match(remoteOperator, /known pre-state/);
    assert.match(remoteOperator, /exactly one marked transition endpoint/);
    assert.match(remoteOperator, /refuses simultaneous receipt and receipt temporary evidence/);
    assert.match(remoteOperator, /Recover client ID does not match/);
    assert.match(remoteOperator, /expected_client_count/);
    assert.match(remoteOperator, /expected_client_state/);
    assert.match(remoteOperator, /operation residue not covered by the unknown marker/);
    assert.match(remoteOperator, /refuses while any registry updater exists/);
    assert.match(remoteOperator, /refuses while registry writer residue or an unsafe file contract exists/);
    assert.match(remoteOperator, /verify_health "\$\{pre_count\}"/);
    assert.match(remoteOperator, /verify_container_unchanged/);
    assert.match(remoteOperator, /stale operator process is still alive/);
    assert.match(remoteOperator, /stale_boot_id.*stale_start_time/s);
    assert.match(remoteOperator, /recovery_residue_state="active-operator"/);
    assert.match(remoteOperator, /recovery_residue_state="operator"/);
    assert.match(remoteOperator, /recovery_residue_state="empty"/);
    assert.match(remoteOperator, /refuses unreachable active-only residue/);
    assert.match(remoteOperator, /recovery_operator_sha256/);
    assert.match(remoteOperator, /Marker-only recovery residue appeared/);
    assert.match(remoteOperator, /sync -f "\$\{run_parent\}"/);
    assert.match(remoteOperator, /sync -f "\$\{app_root\}"/);
    assert.match(remoteOperator, /recovery_post_output=.*readonly_cli.*post_name.*list/s);
    assert.match(
        remoteOperator,
        /rm -f -- "\$\{recovery_stale_active\}"[\s\S]*rm -f -- "\$\{recovery_stale_operator\}"[\s\S]*rmdir -- "\$\{recovery_stale_root\}"[\s\S]*rm -f -- "\$\{unknown_marker\}"/
    );
    assert.doesNotMatch(
        remoteOperator.match(/remove_recovery_evidence\(\) \{[\s\S]*?\n\}/)?.[0] ?? '',
        /(?:rm|rmdir)[^\n]*clients\.json|legal-mcp-registry\.js (?:add|revoke)|docker rm -f/
    );
});

test('recover stale-root teardown는 active+operator, operator, empty, marker-only에서 이어진다', () => {
    const inspectFunction = remoteOperator.slice(
        remoteOperator.indexOf('inspect_recovery_evidence() {'),
        remoteOperator.indexOf('\nremove_recovery_evidence() {')
    );
    const removeFunction = remoteOperator.slice(
        remoteOperator.indexOf('remove_recovery_evidence() {'),
        remoteOperator.indexOf('\npre_output=')
    );
    assert.match(inspectFunction, /operator_present.*active_present.*active-operator/s);
    assert.match(inspectFunction, /operator_present.*recovery_residue_state="operator"/s);
    assert.match(inspectFunction, /active_present.*entry_count.*recovery_residue_state="empty"/s);
    assert.match(inspectFunction, /refuses unreachable active-only residue/);
    assert.match(inspectFunction, /recovery_operator_identity=.*stat -c '%d:%i'/s);
    assert.match(inspectFunction, /recovery_operator_sha256=.*sha256sum/s);
    assert.match(removeFunction, /recovery_operator_identity/);
    assert.match(removeFunction, /Stale operator evidence appeared after inspection/);

    const activeRetire = removeFunction.indexOf('rm -f -- "${recovery_stale_active}"');
    const operatorRetire = removeFunction.indexOf('rm -f -- "${recovery_stale_operator}"');
    const rootRetire = removeFunction.indexOf('rmdir -- "${recovery_stale_root}"');
    const parentSync = removeFunction.indexOf('sync -f "${run_parent}"');
    const markerRetire = removeFunction.indexOf('rm -f -- "${unknown_marker}"');
    assert.ok(activeRetire < operatorRetire && operatorRetire < rootRetire);
    assert.ok(rootRetire < parentSync && parentSync < markerRetire);
});

test('recover는 exact marker+receipt를 보존하고 marker+temp를 publish한 뒤 marker만 retire한다', () => {
    const inspectFunction = remoteOperator.slice(
        remoteOperator.indexOf('inspect_recovery_evidence() {'),
        remoteOperator.indexOf('\nremove_recovery_evidence() {')
    );
    const removeFunction = remoteOperator.slice(
        remoteOperator.indexOf('remove_recovery_evidence() {'),
        remoteOperator.indexOf('\npre_output=')
    );
    assert.match(inspectFunction, /loaded_outcome.*\^\(verified\|known-precommit\)\$/s);
    assert.match(inspectFunction, /stale_receipt.*stat -c '%u:%a'.*600/s);
    assert.match(inspectFunction, /sha256sum -- "\$\{stale_receipt\}".*recovery_unknown_sha256/s);
    assert.match(inspectFunction, /recovery_receipt_mode="receipt"/);
    assert.match(inspectFunction, /stale_receipt_temp.*stat -c '%u:%a'.*600/s);
    assert.match(inspectFunction, /sha256sum -- "\$\{stale_receipt_temp\}".*recovery_unknown_sha256/s);
    assert.match(inspectFunction, /recovery_receipt_mode="temp"/);
    assert.match(inspectFunction, /recovery_receipt_identity=.*stat -c '%d:%i'/s);
    assert.match(inspectFunction, /receipt does not exactly match the pending marker/);
    assert.match(inspectFunction, /receipt temporary file does not exactly match the pending marker/);

    const tempSync = removeFunction.indexOf('sync -d "${recovery_receipt_temp}"');
    const tempPublish = removeFunction.indexOf(
        'mv -T -- "${recovery_receipt_temp}" "${recovery_receipt_path}"'
    );
    const receiptDirSync = removeFunction.indexOf('sync -f "${receipts_dir}"', tempPublish);
    const markerRetire = removeFunction.indexOf('rm -f -- "${unknown_marker}"');
    assert.ok(tempSync >= 0 && tempSync < tempPublish);
    assert.ok(tempPublish < receiptDirSync && receiptDirSync < markerRetire);
    assert.match(removeFunction, /Recovery receipt evidence changed after inspection/);
    assert.match(removeFunction, /Recovery receipt temporary evidence changed after inspection/);
    assert.match(removeFunction, /Recovery durable receipt cannot be attested/);
    assert.match(removeFunction, /recovery_receipt_identity/);
    assert.doesNotMatch(removeFunction, /rm -f -- "\$\{recovery_receipt_path\}"/);
    assert.doesNotMatch(removeFunction, /rm -f -- "\$\{recovery_receipt_temp\}"/);
});

test('새 mutation은 receipt-only unknown, mismatch, temp residue를 fail-closed한다', () => {
    const ledgerFunction = remoteOperator.slice(
        remoteOperator.indexOf('assert_receipt_ledger_safe() ('),
        remoteOperator.indexOf('\noperation_marker_payload() {')
    );
    assert.match(ledgerFunction, /receipt_name.*\^\[1-9\]/s);
    assert.match(ledgerFunction, /receipt_run_key.*receipt_name/s);
    assert.match(ledgerFunction, /stat -c '%u:%a'.*receipt.*600/s);
    assert.match(ledgerFunction, /receipt_outcome.*\^\(verified\|known-precommit\)\$/s);
    assert.doesNotMatch(ledgerFunction, /intent\|verified|verified\|known-precommit\|unknown/);
    assert.match(remoteOperator, /assert_receipt_ledger_safe/);
    assert.match(
        remoteOperator,
        /COMMIT_STATE_UNKNOWN: receipt ledger contains unresolved or unsafe evidence.*75/
    );
});

test('새 mutation은 markerless self-cleanup residue를 production lock 아래 멱등 정리한다', () => {
    const reconcileFunction = remoteOperator.slice(
        remoteOperator.indexOf('reconcile_unmarked_run_residue() {'),
        remoteOperator.indexOf('\nif [[ "${mutation}" -eq 1 ]]')
    );
    assert.match(reconcileFunction, /residue.*run_root.*continue/s);
    assert.match(reconcileFunction, /entry_count <= 2/);
    assert.match(reconcileFunction, /unmarked active-only residue is unreachable/);
    assert.match(reconcileFunction, /stale_proc_fields\[19\].*stale_start_time/s);
    assert.match(reconcileFunction, /unmarked operator process is still alive/);
    assert.match(reconcileFunction, /receipt_identity=.*stat -c '%d:%i'.*residue_receipt/s);
    assert.match(reconcileFunction, /receipt_sha256=.*sha256sum.*residue_receipt/s);
    assert.match(reconcileFunction, /completed run receipt changed during cleanup/);
    const activeRetire = reconcileFunction.indexOf('rm -f -- "${residue_active}"');
    const operatorRetire = reconcileFunction.indexOf('rm -f -- "${residue_operator}"');
    const rootRetire = reconcileFunction.indexOf('rmdir -- "${residue}"');
    const parentSync = reconcileFunction.indexOf('sync -f "${run_parent}"');
    assert.ok(activeRetire >= 0 && activeRetire < operatorRetire);
    assert.ok(operatorRetire < rootRetire && rootRetire < parentSync);
    assert.doesNotMatch(reconcileFunction, /rm -f -- "\$\{residue_receipt\}"/);
    assert.doesNotMatch(
        reconcileFunction,
        /legal-mcp-registry\.js (?:add|revoke)|clients\.json[^\n]*(?:rm|>)/
    );

    const mutationGuard = remoteOperator.indexOf('if [[ "${mutation}" -eq 1 ]]');
    const cleanRegistry = remoteOperator.indexOf('registry_fs_attest 1', mutationGuard);
    const updaterGuard = remoteOperator.indexOf('stale_updaters=', mutationGuard);
    const reconcileCall = remoteOperator.indexOf(
        'reconcile_unmarked_run_residue',
        mutationGuard
    );
    assert.ok(cleanRegistry < updaterGuard && updaterGuard < reconcileCall);
});

test('remote operator는 자기 marker가 armed된 outcome만 ACK까지 보존한다', () => {
    assert.match(remoteOperator, /remove_current_run_residue\(\)/);
    assert.match(remoteOperator, /self_operator="\$\{run_root\}\/operator\.sh"/);
    assert.match(remoteOperator, /sha256sum -- "\$\{self_operator\}"/);
    assert.match(remoteOperator, /rm -f -- "\$\{self_operator\}"/);
    assert.match(remoteOperator, /rmdir -- "\$\{run_root\}"/);
    assert.match(remoteOperator, /mutation.*marker_armed.*preserve_for_ack/s);
    assert.doesNotMatch(remoteOperator, /if \[\[ "\$\{mutation\}" -eq 1 \]\]; then\n\s+preserve_for_ack=1/);
    assert.match(
        remoteOperator,
        /status.*-eq 0.*status.*-eq 64.*mutation.*-eq 0[\s\S]*preserve_for_ack.*-eq 0[\s\S]*remove_current_run_residue/
    );
});

test('outer cleanup은 살아 있는 active process와 unresolved current marker를 삭제하지 않는다', () => {
    assert.match(workflow, /active_boot_id.*current_boot_id/s);
    assert.match(workflow, /active_proc_fields\[19\].*active_start_time/s);
    assert.match(workflow, /if \[\[ "\$\{active_live\}" -eq 1 \]\]; then\n\s+exit 0/);
    assert.match(workflow, /marker_matches_current=1/);
    assert.match(
        workflow,
        /marker_matches_current \+ receipt_matches_current.*-le 1/
    );
    assert.match(
        workflow,
        /REMOTE_ACKNOWLEDGED.*-eq 0.*marker_matches_current.*-eq 1[\s\S]*exit 0/
    );
    assert.match(workflow, /sha256sum -- "\$\{script\}"/);
    assert.match(workflow, /receipt_temp="\$\{receipt\}\.tmp"/);
    assert.doesNotMatch(workflow, /rm -f -- "\$\{receipt\}"/);
});

test('remote operator는 trailing digest bytes를 precommit rc 64로 거부한다', () => {
    const operatorSha = createHash('sha256').update(remoteOperator).digest('hex');
    const result = spawnSync('bash', [remoteOperatorPath], {
        env: {
            ...process.env,
            REGISTRY_OPERATION: 'add',
            REGISTRY_OPERATION_ID: 'test-operation-1234',
            REGISTRY_CLIENT_ID: 'test-client-1234',
            REGISTRY_EXPECTED_SCRIPT_SHA256: operatorSha,
            REGISTRY_RUN_ID: '1234',
            REGISTRY_RUN_ATTEMPT: '1',
        },
        input: `${'a'.repeat(64)}\ntrailing-without-newline`,
        encoding: 'utf8',
    });
    assert.equal(result.status, 64, result.stderr);
    assert.match(result.stderr, /exactly one digest line/);
});

test('Linux precheck failure는 생성한 active marker를 정리한다', (t) => {
    if (process.platform !== 'linux') {
        t.skip('GNU stat/flock 기반 EC2 operator의 Linux behavior test');
        return;
    }
    const operatorSha = createHash('sha256').update(remoteOperator).digest('hex');
    const testHome = mkdtempSync(join(tmpdir(), 'legal-mcp-registry-test-'));
    const runRoot = join(
        testHome,
        'alimtalk-proxy',
        '.legal-mcp-registry-operations',
        '4321-1'
    );
    mkdirSync(runRoot, { recursive: true, mode: 0o700 });
    chmodSync(join(testHome, 'alimtalk-proxy', '.legal-mcp-registry-operations'), 0o700);
    chmodSync(runRoot, 0o700);
    try {
        const result = spawnSync('bash', [remoteOperatorPath], {
            env: {
                ...process.env,
                HOME: testHome,
                REGISTRY_OPERATION: 'validate',
                REGISTRY_OPERATION_ID: 'test-operation-4321',
                REGISTRY_CLIENT_ID: '',
                REGISTRY_EXPECTED_SCRIPT_SHA256: operatorSha,
                REGISTRY_RUN_ID: '4321',
                REGISTRY_RUN_ATTEMPT: '1',
            },
            input: '',
            encoding: 'utf8',
        });
        assert.equal(result.status, 64, result.stderr);
        assert.equal(
            spawnSync('test', ['!', '-e', join(runRoot, 'active')]).status,
            0,
            'active marker must be removed by the early EXIT trap'
        );
    } finally {
        rmSync(testHome, { recursive: true, force: true });
    }
});

test('postcheck는 file source health와 동일 app container를 확인한다', () => {
    assert.match(remoteOperator, /legalMcpConfigurationValid/);
    assert.match(remoteOperator, /legalMcpAuthMode === "client_registry"/);
    assert.match(remoteOperator, /legalMcpAuthSource === "file_registry"/);
    assert.match(remoteOperator, /legalMcpRegisteredClientCount/);
    assert.match(remoteOperator, /legalMcpRegisteredTokenCount/);
    assert.match(remoteOperator, /Application container changed during the registry operation/);
});

test('workflow와 remote operator의 Bash 구문이 유효하다', () => {
    const marker = '        run: |\n';
    const start = workflow.indexOf(marker);
    assert.ok(start >= 0);
    const embeddedScript = workflow
        .slice(start + marker.length)
        .replace(/^ {10}/gm, '');
    const embeddedResult = spawnSync('bash', ['-n'], {
        input: embeddedScript,
        encoding: 'utf8',
    });
    assert.equal(embeddedResult.status, 0, embeddedResult.stderr);

    const remoteResult = spawnSync('bash', ['-n', remoteOperatorPath], {
        encoding: 'utf8',
    });
    assert.equal(remoteResult.status, 0, remoteResult.stderr);
});
