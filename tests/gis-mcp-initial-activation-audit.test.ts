import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(
    join(process.cwd(), '.github/workflows/gis-mcp-initial-activation-audit.yml'),
    'utf8'
);
const remoteScript = readFileSync(
    join(process.cwd(), 'scripts/gis-mcp-initial-activation-audit-remote.sh'),
    'utf8'
);

test('GIS 최초 활성화 감사 workflow는 보호된 main 수동 실행만 허용한다', () => {
    assert.match(workflow, /^on:\n  workflow_dispatch:/m);
    assert.doesNotMatch(workflow, /^\s{2}(?:push|pull_request|schedule):/m);
    assert.match(workflow, /^permissions:\n  contents: read$/m);
    assert.match(workflow, /environment: gis-mcp-registry/);
    assert.match(workflow, /refs\/heads\/main is required/);
    assert.match(workflow, /actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5/);
    assert.match(workflow, /^concurrency:\n  group: gis-mcp-initial-activation-production\n  cancel-in-progress: false$/m);
});

test('감사 workflow는 고정 host fingerprint와 exact script를 검증한다', () => {
    assert.match(workflow, /EC2_SSH_FINGERPRINT/);
    assert.match(workflow, /StrictHostKeyChecking=yes/);
    assert.match(workflow, /IdentitiesOnly=yes/);
    assert.match(workflow, /ssh-keyscan/);
    assert.match(workflow, /sha256sum scripts\/gis-mcp-initial-activation-audit-remote\.sh/);
    assert.match(workflow, /AUDIT_EXPECTED_SCRIPT_SHA256/);
    assert.doesNotMatch(workflow, /appleboy|allenvs|set -x/);
});

test('원격 감사는 production lock 아래에서 secret 값을 출력하지 않는다', () => {
    assert.match(remoteScript, /\.tonghari-api-production\.lock/);
    assert.match(remoteScript, /exec 9>>"\$\{lock_path\}"/);
    assert.match(remoteScript, /flock -w 60 9/);
    assert.match(remoteScript, /stageReady=%s/);
    assert.match(remoteScript, /stage_ready.*true.*exit 64/s);
    assert.match(remoteScript, /caddyfileSha256=%s/);
    assert.doesNotMatch(remoteScript, /set -x|printenv|docker container inspect --format '[^']*\.Config\.Env/);
    assert.doesNotMatch(remoteScript, /cat .*\.env|cat .*proxy/);
    assert.doesNotMatch(remoteScript, /printf[^\n]*(?:VWORLD_API_KEY|DATA_PORTAL_API_KEY|PROXY_TOKEN)=/);
});

test('원격 감사는 current disabled 상태와 Caddy exact baseline을 검사한다', () => {
    assert.match(remoteScript, /gisMcpConfigurationValid === false/);
    assert.match(remoteScript, /gisMcpRegisteredClientCount === 0/);
    assert.match(remoteScript, /PortBindings "3100\/tcp"/);
    assert.match(remoteScript, /apiPortBinding=%s/);
    assert.match(remoteScript, /@gis_mcp/);
    assert.match(remoteScript, /X-Tonghari-GIS-MCP-Proxy-Token/);
    assert.match(remoteScript, /supported-legal-only/);
    assert.match(remoteScript, /\/opt\/caddy\/Caddyfile/);
    assert.match(remoteScript, /root:root:600/);
    assert.match(remoteScript, /normalized_caddyfile.*expected_legal_caddyfile/s);
    assert.match(remoteScript, /caddy validate/);
    assert.match(remoteScript, /LEGAL_MCP_PROXY_TOKEN_SHA256/);
    assert.match(remoteScript, /candidateConfiguration=%s/);
    assert.match(remoteScript, /getGisMcpConfigurationStateV1/);
    assert.match(remoteScript, /expected_vworld_domain='www\.tonghari\.kr'/);
    assert.match(remoteScript, /single_nonempty_state VWORLD_DOMAIN/);
    assert.match(remoteScript, /vworldLegacyDomain=%s/);
    assert.match(remoteScript, /vworld_legacy_domain_state\}" == missing/);
    assert.match(remoteScript, /missing-bootstrapable/);
    assert.match(remoteScript, /present-matched/);
    assert.match(remoteScript, /-e VWORLD_API_DOMAIN="\$\{expected_vworld_domain\}"/);
    assert.match(remoteScript, /--cap-drop ALL --cap-add NET_BIND_SERVICE/);
    assert.match(remoteScript, /--tmpfs \/config:rw,nosuid,nodev,noexec,size=4194304/);
    assert.match(remoteScript, /--tmpfs \/data:rw,nosuid,nodev,noexec,size=4194304/);
    assert.match(remoteScript, /caddyExecutable=%s/);
    assert.match(remoteScript, /caddy version/);
    assert.match(remoteScript, /caddy_container_state=not-tested/);
});

test('감사 cleanup과 production lock은 동일 실행이 만든 정확한 inode만 다룬다', () => {
    assert.match(workflow, /remote_prepared=0/);
    assert.match(workflow, /REMOTE_PREPARED='\$\{remote_prepared\}'/);
    assert.match(workflow, /remote_prepared=1/);
    assert.match(remoteScript, /\/proc\/\$\$\/fd\/9/);
    assert.match(remoteScript, /Production lock changed while acquired|production lock changed while acquired/);
});

test('workflow와 원격 감사 shell 구문이 유효하다', () => {
    for (const source of [remoteScript]) {
        const result = spawnSync('bash', ['-n'], { input: source, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    }
    const marker = '        run: |\n';
    const start = workflow.indexOf(marker);
    assert.ok(start >= 0);
    const embeddedScript = workflow
        .slice(start + marker.length)
        .replace(/^ {10}/gm, '');
    const syntax = spawnSync('bash', ['-n'], {
        input: embeddedScript,
        encoding: 'utf8',
    });
    assert.equal(syntax.status, 0, syntax.stderr);
});
