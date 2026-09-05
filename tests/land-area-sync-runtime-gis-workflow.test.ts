import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(join(process.cwd(), '.github/workflows/land-area-sync-runtime-allowlist.yml'), 'utf8');
const registryHost = '/srv/tonghari/.gis-mcp-secrets';
const registryDirectory = '/run/secrets/tonghari-gis-mcp';
const registryFile = `${registryDirectory}/clients.json`;
const activeEnvironment = `NODE_ENV=production\nGIS_MCP_TOKEN_REGISTRY_FILE=${registryFile}\n`;
const activeMount = `bind|false|${registryHost}|${registryDirectory}`;

function helper(name: string): string {
    const match = workflow.match(new RegExp(`^          ${name}\\(\\) \\{[\\s\\S]*?^          \\}`, 'm'));
    assert.ok(match, `${name} workflow helper가 필요합니다.`);
    return match[0].replace(/^ {10}/gm, '');
}

function runHelper(name: string, args: string[], options: {
    environment?: string; mount?: string; inspectFailure?: boolean;
    required?: boolean; health?: unknown; action?: string;
    previousHealth?: string; runtimeEnvironment?: string;
} = {}) {
    const script = `set -Eeuo pipefail
gis_registry_host_dir="$TEST_REGISTRY_HOST"
gis_registry_container_dir="$TEST_REGISTRY_DIRECTORY"
gis_registry_container_file="$TEST_REGISTRY_FILE"
gis_registry_client_count=2
gis_registry_required="$TEST_GIS_REQUIRED"
RUNTIME_ACTION="$TEST_ACTION"
previous_health_attestation="$TEST_PREVIOUS_HEALTH"
container_name=current
env_path=$(mktemp)
trap 'rm -f "$env_path"' EXIT
printf '%s' "$MOCK_RUNTIME_ENVIRONMENT" > "$env_path"
docker() {
  if [[ "$1" == container && "$2" == inspect ]]; then
    [[ "$MOCK_INSPECT_FAILURE" == 0 ]] || return 1
    case "$*" in
      *Config.Env*) printf '%s' "$MOCK_ENVIRONMENT" ;;
      *Mounts*) printf '%s' "$MOCK_MOUNT" ;;
      *) return 90 ;;
    esac
    return 0
  fi
  if [[ "$1" == exec ]]; then
    shift
    while [[ "$1" == -i || "$1" == -e ]]; do
      if [[ "$1" == -i ]]; then shift; else export "$2"; shift 2; fi
    done
    shift
    [[ "$1" == node ]] || return 91
    shift
    "$TEST_NODE_BINARY" "$@"
    return
  fi
  return 92
}
curl() { printf '%s' "$MOCK_HEALTH"; }
sleep() { :; }
${name === 'verify_gis_repair_allowed' ? helper('verify_gis_container_contract') + '\n' + helper('verify_gis_health') : ''}
${helper(name)}
${name} "$@"
`;
    return spawnSync('bash', ['-c', script, 'runtime-gis-workflow-test', ...args], {
        encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, TEST_NODE_BINARY: process.execPath, TEST_REGISTRY_HOST: registryHost,
            TEST_REGISTRY_DIRECTORY: registryDirectory, TEST_REGISTRY_FILE: registryFile,
            TEST_GIS_REQUIRED: options.required === false ? '0' : '1', TEST_ACTION: options.action ?? 'disable',
            TEST_PREVIOUS_HEALTH: options.previousHealth ?? 'false:0:',
            MOCK_RUNTIME_ENVIRONMENT: options.runtimeEnvironment ?? 'LAND_AREA_SYNC_ENABLED=false\nLAND_AREA_SYNC_ALLOWED_TARGETS=\n',
            MOCK_ENVIRONMENT: options.environment ?? activeEnvironment,
            MOCK_MOUNT: options.mount ?? activeMount, MOCK_INSPECT_FAILURE: options.inspectFailure ? '1' : '0',
            MOCK_HEALTH: JSON.stringify(options.health ?? {}) },
    });
}

const enabledHealth = {
    status: 'ok', features: {
        gisMcpConfigurationValid: true, gisMcpAuthMode: 'client_registry', gisMcpAuthSource: 'file_registry',
        gisMcpRegisteredClientCount: 2, gisMcpRegisteredTokenCount: 2,
        gisMcpProviderMode: 'vworld_and_data_portal', gisMcpMissingConfiguration: [], gisMcpInvalidConfiguration: [],
    },
};
const disabledHealth = {
    status: 'ok', features: {
        gisMcpConfigurationValid: false, gisMcpAuthMode: 'disabled', gisMcpAuthSource: 'disabled',
        gisMcpRegisteredClientCount: 0, gisMcpRegisteredTokenCount: 0, gisMcpProviderMode: 'disabled',
    },
};
const repairableHealth = { ...disabledHealth, queue: { pending: 0, running: 0 }, features: {
    ...disabledHealth.features, gisMcpAuthSource: 'file_registry', landAreaSyncEnabled: false,
    landAreaSyncAllowedTargetCount: 0, landAreaSyncAllowedTargetsDigest: '',
} };

test('활성 GIS는 정확한 FILE 환경과 읽기 전용 고정 mount를 함께 검증한다', () => {
    const result = runHelper('verify_gis_container_contract', ['candidate', 'present']);
    assert.equal(result.status, 0, result.stderr);
});

test('중복 FILE이나 JSON·legacy 동시 설정은 값이 비어도 거부한다', () => {
    for (const environment of [
        `${activeEnvironment}GIS_MCP_TOKEN_REGISTRY_FILE=${registryFile}\n`,
        `${activeEnvironment}GIS_MCP_TOKEN_REGISTRY_JSON=\n`,
        `${activeEnvironment}GIS_MCP_TOKEN_SHA256=\n`,
        activeEnvironment.replace(registryFile, '/tmp/other-clients.json'),
    ]) {
        const result = runHelper('verify_gis_container_contract', ['candidate', 'present'], { environment });
        assert.notEqual(result.status, 0, environment);
    }
});

test('쓰기 가능한 mount·다른 host 경로·다른 mount 종류·중복 mount를 거부한다', () => {
    for (const mount of [`bind|true|${registryHost}|${registryDirectory}`, `bind|false|/tmp/other|${registryDirectory}`, `volume|false|${registryHost}|${registryDirectory}`,
        `${activeMount}\n${activeMount}`, '']) {
        const result = runHelper('verify_gis_container_contract', ['candidate', 'present'], { mount });
        assert.notEqual(result.status, 0, mount);
    }
});

test('복구 대상의 빠진 mount는 absent 검사에서만 허용하고 다른 env 결함은 거부한다', () => {
    assert.equal(runHelper('verify_gis_container_contract', ['current', 'absent'], { mount: '' }).status, 0);
    assert.notEqual(runHelper('verify_gis_container_contract', ['current', 'absent']).status, 0);
    assert.notEqual(runHelper('verify_gis_container_contract', ['current', 'absent'], {
        mount: '', environment: `${activeEnvironment}GIS_MCP_TOKEN_REGISTRY_JSON={}\n`,
    }).status, 0);
    for (const mount of [`bind|false|${registryHost}|/tmp/gis`,
        `bind|false|${registryHost}/clients.json|/tmp/clients.json`,
        `bind|false|/tmp/unrelated|${registryDirectory}/clients.json`,
        'bind|false|/tmp/unrelated|/run/secrets']) {
        for (const expectation of ['present', 'absent']) {
            assert.notEqual(runHelper('verify_gis_container_contract', ['current', expectation], { mount }).status, 0, mount);
        }
    }
    const legalMount = 'bind|false|/srv/tonghari/.legal-mcp-secrets|/run/secrets/tonghari-legal-mcp';
    assert.equal(runHelper('verify_gis_container_contract', ['current', 'absent'], { mount: legalMount }).status, 0);
    assert.equal(runHelper('verify_gis_container_contract', ['current', 'present'], { mount: `${legalMount}\n${activeMount}` }).status, 0);
});

test('docker inspect 실패를 비활성 또는 mount 부재로 오판하지 않는다', () => {
    for (const expectation of ['present', 'absent']) {
        const result = runHelper('verify_gis_container_contract', ['current', expectation], { inspectFailure: true, mount: '' });
        assert.notEqual(result.status, 0);
    }
});

test('활성 health는 등록 방식·provider·client/token 수가 모두 맞아야 통과한다', () => {
    const valid = runHelper('verify_gis_health', ['candidate', '13100', 'enabled'], { health: enabledHealth });
    assert.equal(valid.status, 0, valid.stderr);
    for (const change of [
        { gisMcpConfigurationValid: false }, { gisMcpAuthMode: 'legacy_single' },
        { gisMcpAuthSource: 'json_registry' }, { gisMcpProviderMode: 'disabled' },
        { gisMcpRegisteredClientCount: 1 }, { gisMcpRegisteredTokenCount: 1 },
    ]) {
        const health = { ...enabledHealth, features: { ...enabledHealth.features, ...change } };
        const result = runHelper('verify_gis_health', ['candidate', '13100', 'enabled'], { health });
        assert.notEqual(result.status, 0, JSON.stringify(change));
    }
});

test('기존 미활성 설치는 disabled health만 허용하고 활성 상태를 대신 인정하지 않는다', () => {
    const valid = runHelper('verify_gis_health', ['candidate', '13100', 'disabled'], { health: disabledHealth });
    assert.equal(valid.status, 0, valid.stderr);
    assert.notEqual(runHelper('verify_gis_health', ['candidate', '13100', 'disabled'], { health: enabledHealth }).status, 0);
    assert.notEqual(runHelper('verify_gis_health', ['candidate', '13100', 'enabled'], { health: disabledHealth }).status, 0);
    assert.equal(runHelper('verify_gis_container_contract', ['candidate', 'present'], {
        required: false, environment: 'NODE_ENV=production\n', mount: '',
    }).status, 0);
    assert.notEqual(runHelper('verify_gis_container_contract', ['candidate', 'present'], { required: false }).status, 0);
});

test('repairable health는 FILE 읽기 실패 상태와 빈 동기화 gate·queue만 허용한다', () => {
    const valid = runHelper('verify_gis_health', ['current', '3100', 'repairable'], { health: repairableHealth });
    assert.equal(valid.status, 0, valid.stderr);
    for (const health of [enabledHealth, disabledHealth,
        { ...repairableHealth, queue: { pending: 1, running: 0 } },
        { ...repairableHealth, queue: { pending: 0, running: 1 } },
        { ...repairableHealth, features: { ...repairableHealth.features, landAreaSyncEnabled: true } },
        { ...repairableHealth, features: { ...repairableHealth.features, landAreaSyncAllowedTargetsDigest: 'nonempty' } },
    ]) {
        assert.notEqual(runHelper('verify_gis_health', ['current', '3100', 'repairable'], { health }).status, 0);
    }
});

test('rollback의 원래 missing mount 상태는 queue가 바뀌어도 복원 증거로 인정한다', () => {
    const busy = { ...repairableHealth, queue: { pending: 1, running: 1 } };
    assert.equal(runHelper('verify_gis_health', ['current', '3100', 'missing_mount_baseline'], { health: busy }).status, 0);
    assert.notEqual(runHelper('verify_gis_health', ['current', '3100', 'repairable'], { health: busy }).status, 0);
    assert.notEqual(runHelper('verify_gis_health', ['current', '3100', 'missing_mount_baseline'], { health: disabledHealth }).status, 0);
    const rollback = helper('rollback_transaction');
    assert.match(rollback, /verify_gis_health[^\n]*previous_gis_health_state/);
    assert.doesNotMatch(rollback, /verify_gis_health[^\n]*expected_gis_health_state/);
    for (const name of ['candidate_container', 'container_name']) {
        assert.match(workflow, new RegExp(`verify_gis_health "\\$\\{${name}\\}" (?:13100|3100) "\\$\\{expected_gis_health_state\\}"`));
    }
    assert.match(workflow, /previous_gis_health_state\}" == "missing_mount_baseline"[\s\S]*?verify_gis_repair_allowed/);
});

function runPreparation(options: {
    marker?: 'valid' | 'absent' | 'invalid' | 'symlink';
    environment?: string; attestation?: string; validatorFailure?: boolean; directoryMode?: string;
} = {}) {
    const script = `set -Eeuo pipefail
fixture_root=$(mktemp -d)
trap 'rm -rf "$fixture_root"' EXIT
gis_registry_host_dir="$fixture_root/registry"
gis_registry_marker="$fixture_root/marker"
gis_registry_container_dir="$TEST_REGISTRY_DIRECTORY"
gis_registry_container_file="$TEST_REGISTRY_FILE"
gis_registry_required=0
gis_registry_client_count=0
gis_registry_mount_args=()
current_image_id=sha256:current-image
env_path="$fixture_root/env"
mkdir "$gis_registry_host_dir"
printf '%s' "$MOCK_ENVIRONMENT" > "$env_path"
case "$MOCK_MARKER" in
  valid) printf 'version=1' > "$gis_registry_marker" ;;
  invalid) printf 'version=2' > "$gis_registry_marker" ;;
  symlink) printf 'version=1' > "$fixture_root/target"; ln -s "$fixture_root/target" "$gis_registry_marker" ;;
esac
stat() {
  if [[ "$3" == "$gis_registry_host_dir" ]]; then
    case "$2" in %u|%g) printf 1001 ;; %a) printf '%s' "$MOCK_DIRECTORY_MODE" ;; *) return 93 ;; esac
  elif [[ "$3" == "$gis_registry_marker" ]]; then
    case "$2" in %u) id -u ;; %a) printf 600 ;; *) return 94 ;; esac
  else return 95; fi
}
docker() {
  [[ "$1" == run && "$*" == *"--network none --read-only --cap-drop ALL"* ]] || return 96
  [[ "$*" == *"sha256:current-image sh -c"* ]] || return 97
  : > "$fixture_root/validator-called"
  [[ "$MOCK_VALIDATOR_FAILURE" == 0 ]] || return 98
  printf '%s' "$MOCK_ATTESTATION"
}
${helper('prepare_gis_registry_mount')}
status=0
prepare_gis_registry_mount || status=$?
calls=0
[[ ! -e "$fixture_root/validator-called" ]] || calls=1
printf 'status=%s;required=%s;calls=%s' "$status" "$gis_registry_required" "$calls"
if [[ "$status" == 0 && "$gis_registry_required" == 1 ]]; then
  [[ "$gis_registry_client_count" == 2 ]] || exit 99
  [[ "\${gis_registry_mount_args[0]}" == --mount ]] || exit 100
  [[ "\${gis_registry_mount_args[1]}" == "type=bind,src=$gis_registry_host_dir,dst=$gis_registry_container_dir,readonly" ]] || exit 101
fi
exit "$status"
`;
    return spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, TEST_REGISTRY_DIRECTORY: registryDirectory, TEST_REGISTRY_FILE: registryFile,
            MOCK_MARKER: options.marker ?? 'valid', MOCK_ENVIRONMENT: options.environment ?? activeEnvironment,
            MOCK_ATTESTATION: options.attestation ?? 'clientCount=2', MOCK_VALIDATOR_FAILURE: options.validatorFailure ? '1' : '0',
            MOCK_DIRECTORY_MODE: options.directoryMode ?? '700' } });
}

test('GIS 준비는 marker·env·권한·validator 결과를 모두 증명한 뒤에만 mount를 활성화한다', () => {
    const valid = runPreparation();
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout, 'status=0;required=1;calls=1');
    const inactive = runPreparation({ marker: 'absent', environment: 'NODE_ENV=production\n' });
    assert.equal(inactive.status, 0);
    assert.equal(inactive.stdout, 'status=0;required=0;calls=0');
    for (const options of [
        { marker: 'absent' as const }, { marker: 'invalid' as const }, { marker: 'symlink' as const },
        { directoryMode: '755' }, { environment: `${activeEnvironment}GIS_MCP_TOKEN_REGISTRY_JSON=\n` },
        { environment: `${activeEnvironment} GIS_MCP_TOKEN_REGISTRY_FILE = /tmp/override\n` },
    ]) {
        const result = runPreparation(options);
        assert.notEqual(result.status, 0, JSON.stringify(options));
        assert.match(result.stdout, /required=0;calls=0$/);
    }
    for (const options of [{ validatorFailure: true }, { attestation: 'clientCount=0' },
        { attestation: 'clientCount=33' }, { attestation: 'clientCount=2\nextra-line' }]) {
        const result = runPreparation(options);
        assert.notEqual(result.status, 0, JSON.stringify(options));
        assert.match(result.stdout, /required=0;calls=1$/);
    }
});

test('mount 복구는 disable 요청과 실제 env의 빈 allowlist까지 확인한다', () => {
    const normal = { mount: '', health: repairableHealth };
    assert.equal(runHelper('verify_gis_repair_allowed', [], normal).status, 0);
    for (const change of [
        { action: 'enable' }, { previousHealth: 'true:1:nonempty' },
        { runtimeEnvironment: 'LAND_AREA_SYNC_ENABLED=false\nLAND_AREA_SYNC_ALLOWED_TARGETS=hidden-target\n' },
        { runtimeEnvironment: 'LAND_AREA_SYNC_ENABLED=true\nLAND_AREA_SYNC_ALLOWED_TARGETS=\n' },
        { runtimeEnvironment: 'LAND_AREA_SYNC_ENABLED=false\nLAND_AREA_SYNC_ENABLED=false\nLAND_AREA_SYNC_ALLOWED_TARGETS=\n' },
        { runtimeEnvironment: 'LAND_AREA_SYNC_ENABLED=false\nLAND_AREA_SYNC_ALLOWED_TARGETS=\nLAND_AREA_SYNC_ALLOWED_TARGETS=\n' },
        { runtimeEnvironment: 'LAND_AREA_SYNC_ENABLED=false\nLAND_AREA_SYNC_ALLOWED_TARGETS=\n LAND_AREA_SYNC_ALLOWED_TARGETS = hidden-target\n' },
        { runtimeEnvironment: 'LAND_AREA_SYNC_ENABLED=false\n' },
        { mount: activeMount }, { health: enabledHealth },
    ]) {
        assert.notEqual(runHelper('verify_gis_repair_allowed', [], { ...normal, ...change }).status, 0, JSON.stringify(change));
    }
});

test('candidate와 최종 컨테이너 모두 GIS mount 인자와 공통 GIS 검증을 사용한다', () => {
    const candidate = workflow.split('          docker run -d \\\n')[1] ?? '';
    const final = workflow.split('          docker run -d \\\n')[2] ?? '';
    for (const run of [candidate, final]) {
        assert.ok(run, '두 실행 컨테이너가 필요합니다.');
        assert.match(run.split('>/dev/null')[0], /gis_registry_mount_args\[@\]/);
        assert.match(run, /if ! verify_container/);
        assert.match(run, /\|\| ! verify_gis_container_contract/);
        assert.match(run, /\|\| ! verify_gis_health/);
    }
    const remote = workflow.match(/<<'REMOTE_RUNTIME'\n([\s\S]*?)^          REMOTE_RUNTIME$/m)?.[1];
    assert.ok(remote, '실행할 REMOTE_RUNTIME heredoc 전체가 필요합니다.');
    const syntax = spawnSync('bash', ['-n'], { input: remote.replace(/^ {10}/gm, ''), encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
});
