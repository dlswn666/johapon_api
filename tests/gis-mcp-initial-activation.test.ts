import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflowPath = join(
    process.cwd(),
    '.github/workflows/gis-mcp-initial-activation.yml'
);
const remotePath = join(
    process.cwd(),
    'scripts/gis-mcp-initial-activation-remote.sh'
);
const workflow = readFileSync(workflowPath, 'utf8');
const remote = readFileSync(remotePath, 'utf8');

test('GIS 최초 활성화는 보호된 main 수동 workflow와 직렬화 gate만 사용한다', () => {
    assert.match(workflow, /^on:\n  workflow_dispatch:/m);
    assert.doesNotMatch(workflow, /^\s{2}(?:push|pull_request|schedule):/m);
    assert.match(workflow, /^permissions:\n  contents: read$/m);
    assert.match(workflow, /environment: gis-mcp-registry/);
    assert.match(workflow, /refs\/heads\/main is required/);
    assert.match(
        workflow,
        /actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5/
    );
    assert.match(
        workflow,
        /^concurrency:\n  group: gis-mcp-initial-activation-production\n  cancel-in-progress: false$/m
    );
    assert.match(workflow, /prepare\|status\|publish\|rollback\|recover/);
    assert.match(
        workflow,
        /ACTIVATION_OPERATION\}" != "status"[\s\S]*ACTIVATION_RUN_ATTEMPT\}" == "1"/
    );
});

test('workflow는 고정 host fingerprint와 exact script 및 exact revision을 검증한다', () => {
    assert.match(workflow, /EC2_SSH_FINGERPRINT/);
    assert.match(workflow, /StrictHostKeyChecking=yes/);
    assert.match(workflow, /IdentitiesOnly=yes/);
    assert.match(workflow, /ssh-keyscan/);
    assert.match(
        workflow,
        /sha256sum scripts\/gis-mcp-initial-activation-remote\.sh/
    );
    assert.match(workflow, /ACTIVATION_EXPECTED_SCRIPT_SHA256/);
    assert.match(workflow, /git rev-parse HEAD/);
    assert.match(workflow, /ACTIVATION_GITHUB_SHA/);
    assert.doesNotMatch(workflow, /appleboy|allenvs|set -x/);
});

test('pending digest는 dispatch commitment에 묶고 SSH stdin으로만 전달한다', () => {
    assert.match(workflow, /secrets\.GIS_MCP_REGISTRY_PENDING_SHA256/);
    assert.match(workflow, /unset ACTIVATION_PENDING_SHA256/);
    assert.match(workflow, /::add-mask::%s/);
    assert.match(
        workflow,
        /\{\\"version\\":1,\\"operationId\\":\\"\$\{ACTIVATION_ID\}\\",\\"action\\":\\"add\\",\\"clientId\\":\\"\$\{ACTIVATION_CLIENT_ID\}\\",\\"tokenSha256\\":\\"\$\{pending_digest\}\\"\}/
    );
    assert.match(
        workflow,
        /printf '%s\\n' "\$\{pending_digest\}" \\\n+\s+\| ssh/
    );
    const remoteCommand = workflow.match(
        /remote_command="([\s\S]*?)bash '\$\{remote_root\}\/operator\.sh'"/
    )?.[1] ?? '';
    assert.ok(remoteCommand.length > 0);
    assert.doesNotMatch(remoteCommand, /pending_digest|ACTIVATION_PENDING_SHA256/);
    assert.doesNotMatch(
        workflow,
        /scp[^\n]*pending_digest|ACTIVATION_PENDING_SHA256='\$\{pending_digest\}'/
    );
});

test('prepare handoff는 배포가 검증하고 소비할 strict 6-line 계약이다', () => {
    assert.match(
        remote,
        /prepared_path="\$\{app_root\}\/\.gis-mcp-initial-activation-prepared-v1"/
    );
    assert.match(
        remote,
        /deployment_receipts_dir="\$\{app_root\}\/\.gis-mcp-initial-activation-receipts"/
    );
    assert.match(
        remote,
        /"\$\{#lines\[@\]\}" -eq 6[\s\S]*'version=1'[\s\S]*activationId=[\s\S]*clientId=[\s\S]*gitSha=[\s\S]*runtimeEnvSha256=[\s\S]*tokenCommitment=/
    );
    assert.match(remote, /write_binding_file "\$\{prepared_path\}" "\$\{prepared_sha\}"/);
    assert.match(remote, /sync -f "\$\{app_root\}"/);
    assert.match(remote, /validate_deployment_receipt "\$\{prepared_sha\}"/);
    assert.match(remote, /check_user_dir "\$\{deployment_receipts_dir\}"/);
});

test('prepare는 공개 Caddy를 바꾸지 않고 API env와 root-only candidate만 staging한다', () => {
    assert.match(remote, /validate_prepare_preconditions/);
    assert.match(remote, /health_disabled/);
    assert.match(remote, /gitSha === process\.env\.EXPECTED_GIT_SHA/);
    assert.match(remote, /VWORLD_API_DOMAIN=www\.tonghari\.kr/);
    assert.match(remote, /GIS_MCP_TOKEN_REGISTRY_JSON=/);
    assert.match(remote, /GIS_MCP_PROXY_TOKEN_SHA256=/);
    assert.match(remote, /GIS_MCP_ALLOWED_HOSTS=api\.tonghari\.kr/);
    assert.match(remote, /openssl rand -base64 48/);
    assert.match(remote, /root:root:600/);
    assert.match(remote, /Caddyfile\.candidate/);
    assert.match(remote, /proxy\.env\.candidate/);
    assert.match(remote, /caddy validate/);
    assert.match(remote, /--cap-drop ALL --cap-add NET_BIND_SERVICE/);
    assert.match(remote, /@legal_mcp path \/mcp/);
    assert.match(remote, /@gis_mcp path \/gis-mcp/);
    assert.match(remote, /encode gzip/);
});

test('Caddy mount 검사는 escape되지 않은 유효한 Go template을 사용한다', () => {
    const contract = remote.match(
        /check_caddy_container_contract\(\) \{([\s\S]*?)\n\}/
    )?.[1] ?? '';
    assert.ok(contract.length > 0);
    assert.match(contract, /eq \.Destination "\/etc\/caddy\/Caddyfile"/);
    assert.match(contract, /eq \.Destination "\/data"/);
    assert.match(contract, /eq \.Destination "\/config"/);
    assert.doesNotMatch(contract, /\\"/);
});

test('publish는 file registry와 두 MCP health를 확인한 뒤에만 Caddy를 공개한다', () => {
    assert.match(remote, /GIS_MCP_TOKEN_REGISTRY_FILE=\$\{gis_registry_container_file\}/);
    assert.match(remote, /\.gis-mcp-file-registry-v1/);
    assert.match(remote, /attest-client/);
    assert.match(remote, /tokenCommitment=\$\{ACTIVATION_TOKEN_COMMITMENT\}/);
    assert.match(remote, /gisMcpConfigurationValid === true/);
    assert.match(remote, /gisMcpAuthSource === "file_registry"/);
    assert.match(remote, /gisMcpProviderMode === "vworld_and_data_portal"/);
    assert.match(remote, /legalMcpConfigurationValid === true/);
    assert.match(remote, /root_publish_caddy/);
    assert.match(remote, /gis_no_auth.*401/s);
    assert.match(remote, /gis_invalid.*401/s);
    assert.match(remote, /loopback_gis.*403/s);
    assert.match(remote, /public_legal.*401/s);
    assert.match(remote, /loopback_legal.*403/s);
});

test('rollback은 migration 전으로 제한되고 ambiguous state는 75와 recover로 닫힌다', () => {
    assert.match(remote, /EX_TEMPFAIL=75/);
    assert.match(remote, /COMMIT_STATE_UNKNOWN/);
    assert.match(remote, /\.gis-mcp-initial-activation-commit-unknown/);
    assert.match(remote, /rollback is prohibited after migration has started or committed/);
    assert.match(
        remote,
        /! -e "\$\{deployment_receipt\}"[\s\S]*! -e "\$\{gis_marker\}"[\s\S]*! -e "\$\{gis_registry_dir\}"/
    );
    assert.match(remote, /restore_runtime_backup/);
    assert.match(remote, /recover_operation/);
    assert.match(remote, /publish-not-exposed/);
    assert.match(remote, /restored-legal-only/);
    assert.match(remote, /finalized-publish/);
    assert.match(remote, /cleared-prepare-intent/);
    assert.match(remote, /finalized-published-cleanup/);
    assert.match(remote, /cleanupRequired=true/);
});

test('준비 SHA는 receipt에 고정하되 이후 main 이동 시 status/recover가 과거 증거를 읽을 수 있다', () => {
    assert.match(remote, /state_git_sha="\$\{lines\[5\]#githubSha=\}"/);
    assert.match(
        remote,
        /validate_deployment_receipt "\$\{state_prepared_sha\}" "\$\{state_git_sha\}"/
    );
    assert.match(remote, /health_disabled "\$\{state_git_sha\}"/);
    assert.match(remote, /health_disabled "\$\{unknown_git_sha\}"/);
    assert.match(remote, /health_disabled ''/);
    assert.match(remote, /verify_active_file_mode "\$\{state_git_sha\}"/);
    assert.match(remote, /"githubSha=\$\{git_sha\}"/);
    assert.match(
        remote,
        /expectedCaddyfileSha256=\$\{ACTIVATION_EXPECTED_CADDYFILE_SHA256\}/
    );
    assert.match(
        remote,
        /state_git_sha\}" == "\$\{unknown_git_sha\}/
    );
    assert.ok(
        remote.includes(': /^[0-9a-f]{40}$/.test(health.gitSha || "")')
    );
    assert.doesNotMatch(
        remote,
        /lines\[5\].*githubSha=\$\{ACTIVATION_GITHUB_SHA\}/
    );
    assert.match(remote, /printf 'gitSha=%s\\n' "\$\{state_git_sha\}"/);
});

test('recover는 partial Caddy swap과 post-publish cleanup residue를 수렴시킨다', () => {
    assert.match(
        remote,
        /root_restore_original_caddy[\s\S]*recovery=restored-legal-only/
    );
    assert.match(remote, /sync -f \/opt\/caddy \|\| return 1/);
    assert.match(
        remote,
        /published service cannot be proven before cleanup recovery/
    );
    assert.match(
        remote,
        /remove_root_stage \|\| cleanup_failed=1[\s\S]*finalized-published-cleanup/
    );
    assert.match(
        remote,
        /verify_active_file_mode "\$\{state_git_sha\}"[\s\S]*published service cannot be proven before cleanup recovery/
    );
    assert.match(
        remote,
        /unknown_operation\}" == prepare[\s\S]*check_legal_caddy_baseline[\s\S]*check_legal_proxy_pair[\s\S]*health_disabled "\$\{state_git_sha\}"[\s\S]*verify_public_legal_only[\s\S]*finalized-prepare/
    );
    assert.match(remote, /cleanup_activation_temp_files/);
    assert.match(remote, /\.env\.gis-mcp-backup\.next\.\*/);
    assert.match(remote, /\.env\.gis-mcp-activation\.next\.\*/);
    assert.match(remote, /activation_temp_files_absent/);
    assert.match(remote, /root_caddy_temp_files\(\)/);
    assert.match(remote, /\/opt\/caddy\/\.proxy\.env\.next\.\*/);
    assert.match(remote, /\/opt\/caddy\/\.proxy\.env\.restore\.\*/);
    assert.match(remote, /stat -c '%U:%G:%a:%h'/);
    assert.match(
        remote,
        /root_publish_caddy; then[\s\S]*root_caddy_temp_files cleanup[\s\S]*Caddy publication did not reach a known state/
    );
    assert.match(
        remote,
        /load_unknown[\s\S]*root_caddy_temp_files cleanup[\s\S]*cleanup_activation_temp_files/
    );
    assert.match(
        remote,
        /activationStatus=rolled-back[\s\S]*check_legal_proxy_pair[\s\S]*verify_public_legal_only/
    );
});

test('operator는 raw secret을 stdout, argv, 저장소 경로에 노출하지 않는다', () => {
    assert.doesNotMatch(remote, /set -x|printenv|\.Config\.Env/);
    assert.doesNotMatch(remote, /printf[^\n]*proxy_raw[^\n]*(?:stdout|\/dev\/stdout)/);
    assert.doesNotMatch(remote, /echo[^\n]*(?:token_digest|proxy_raw)/);
    assert.doesNotMatch(remote, /docker run[^\n]*-e\s+GIS_MCP_PROXY_TOKEN=/);
    assert.doesNotMatch(remote, /ACTIVATION_TOKEN_DIGEST=/);
    assert.match(remote, /unset token_digest/);
    assert.match(remote, /unset proxy_raw legal_line/);
});

test('workflow YAML과 workflow/remote Bash 구문이 유효하다', (t) => {
    const remoteSyntax = spawnSync('bash', ['-n', remotePath], { encoding: 'utf8' });
    assert.equal(remoteSyntax.status, 0, remoteSyntax.stderr);

    const marker = '        run: |\n';
    const start = workflow.indexOf(marker);
    assert.ok(start >= 0);
    const embedded = workflow
        .slice(start + marker.length)
        .replace(/^ {10}/gm, '');
    const embeddedSyntax = spawnSync('bash', ['-n'], {
        input: embedded,
        encoding: 'utf8',
    });
    assert.equal(embeddedSyntax.status, 0, embeddedSyntax.stderr);

    const ruby = spawnSync(
        'ruby',
        ['-e', 'require "yaml"; value = YAML.load_file(ARGV[0]); abort unless value.is_a?(Hash)', workflowPath],
        { encoding: 'utf8' }
    );
    if (ruby.error && (ruby.error as NodeJS.ErrnoException).code === 'ENOENT') {
        t.diagnostic('Ruby YAML parser is unavailable; Bash/static workflow checks still ran.');
        return;
    }
    assert.equal(ruby.status, 0, ruby.stderr);
});
