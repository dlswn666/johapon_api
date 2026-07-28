import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(__dirname, '..');
const read = (relativePath: string) =>
    fs.readFileSync(path.join(root, relativePath), 'utf8');
const workflow = read(
    '.github/workflows/development-api-authoritative-ldareg-backfill.yml'
);
const guardian = read(
    'scripts/development-api-authoritative-ldareg-backfill-guardian.sh'
);
const ownerInstaller = read(
    'scripts/install-development-api-authoritative-ldareg-approval.sh'
);
const runner = read(
    'src/operations/development-api-authoritative-ldareg-backfill.ts'
);
const cli = read(
    'src/cli/development-api-authoritative-ldareg-backfill.ts'
);
const targetSelector = read(
    'src/cli/development-api-authoritative-ldareg-target-bundle-select.ts'
);
const validator = read(
    'src/cli/development-api-authoritative-ldareg-backfill-validate.ts'
);
const approvalValidator = read(
    'src/cli/development-api-authoritative-ldareg-backfill-approval-request-validate.ts'
);
const privateFile = read(
    'src/cli/development-api-authoritative-ldareg-private-file.ts'
);
const privateFileMaterializer = read(
    'src/cli/development-api-authoritative-ldareg-private-file-materialize.ts'
);
const privateFileStager = read(
    'src/cli/development-api-authoritative-ldareg-private-file-stage.ts'
);
const dockerfile = read('Dockerfile');

test('workflow는 main에서 7 opaque key 중 한 private target만 protected environment로 전달한다', () => {
    assert.match(
        workflow,
        /environment: land-area-sync-development-write/
    );
    assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
    assert.match(workflow, /permissions:[\s\S]+contents: read/);
    assert.match(workflow, /type: choice/);
    assert.match(
        workflow,
        /mode:[\s\S]+default: prepare[\s\S]+- prepare[\s\S]+- apply/
    );
    assert.match(
        workflow,
        /default: ldareg-target-07/
    );
    assert.equal(
        (
            workflow
                .slice(
                    workflow.indexOf('      target:'),
                    workflow.indexOf('\npermissions:')
                )
                .match(/- ldareg-target-0[1-7]/g) ?? []
        ).length,
        7
    );
    assert.match(
        workflow,
        /TARGET_BUNDLE_B64: \$\{\{ secrets\.LDAREG_BACKFILL_TARGET_BUNDLE_B64 \}\}/
    );
    assert.match(
        workflow,
        /development-api-authoritative-ldareg-target-bundle-select\.js/
    );
    assert.match(
        workflow,
        /development-api-authoritative-ldareg-private-file-materialize\.js/
    );
    assert.match(
        workflow,
        /node --import tsx --test[\s\S]+tests\/development-api-authoritative-ldareg-private-file\.test\.ts/
    );
    assert.match(
        workflow,
        /--target-key "\$\{TARGET_KEY\}"[\s\S]+--out "\.development-api-authoritative-ldareg-backfill\/target\.json"/
    );
    const selection = workflow.slice(
        workflow.indexOf(
            '- name: Select one protected private target'
        ),
        workflow.indexOf(
            '- name: Validate pinned owner encryption recipient'
        )
    );
    assert.match(
        selection,
        /mktemp -d \/dev\/shm\/development-api-ldareg-private-target\.XXXXXX[\s\S]+stat -f -c '%T' "\$\{private_target_root\}"[\s\S]+tmpfs/
    );
    assert.match(
        selection,
        /cleanup_private_target_root\(\)[\s\S]+trap cleanup_private_target_root EXIT[\s\S]+--encoding base64[\s\S]+DEVELOPMENT_API_AUTHORITATIVE_LDAREG_PRIVATE_FILE_MATERIALIZED/
    );
    assert.match(
        selection,
        /rm -f -- "\$\{bundle_path\}"[\s\S]+test ! -e "\$\{bundle_path\}"[\s\S]+echo "target_path=\$\{target_path\}"[\s\S]+echo "private_root=\$\{private_target_root\}"[\s\S]+trap - EXIT/
    );
    assert.doesNotMatch(selection, /scp .*bundle|GITHUB_OUTPUT.*bundle/);
    assert.doesNotMatch(
        selection,
        /RUNNER_TEMP|base64 --decode|> "\$\{bundle_path\}"/
    );
    assert.doesNotMatch(
        workflow,
        /development-api-authoritative-ldareg-backfill-manifests\//
    );
    assert.doesNotMatch(
        workflow,
        /LDAREG_BACKFILL_TARGET_B64\b/
    );
    assert.doesNotMatch(workflow, /type: string/);
    assert.doesNotMatch(
        workflow,
        /replace_development_api_authoritative_ldareg_backfill_approval_v1/
    );
});

test('GitHub 평문 target은 검증된 tmpfs 한 위치에서만 FD-safe 검증·정리한다', () => {
    const validation = workflow.slice(
        workflow.indexOf(
            '- name: Revalidate private redacted artifact'
        ),
        workflow.indexOf(
            '- name: Verify owner-encrypted approval ciphertext'
        )
    );
    assert.match(
        validation,
        /PRIVATE_TARGET_ROOT: \$\{\{ steps\.target\.outputs\.private_root \}\}/
    );
    assert.match(
        validation,
        /stat -f -c '%T' "\$\{PRIVATE_TARGET_ROOT\}"[\s\S]+tmpfs/
    );
    assert.match(
        validation,
        /"\$\{TARGET_PATH\}" != "\$\{private_root\}\/target\.json"/
    );
    assert.match(
        validation,
        /--out "\$\{private_artifact\}"[\s\S]+--encoding raw/
    );
    assert.doesNotMatch(
        validation,
        /mktemp -d(?! \/dev\/shm)|install -m 600 "\$\{TARGET_PATH\}"/
    );

    const remote = workflow.slice(
        workflow.indexOf(
            '- name: Run exact deployed guarded backfill'
        ),
        workflow.indexOf(
            '- name: Revalidate private redacted artifact'
        )
    );
    assert.match(
        remote,
        /PRIVATE_TARGET_ROOT: \$\{\{ steps\.target\.outputs\.private_root \}\}/
    );
    assert.match(
        remote,
        /Private target changed before remote transfer\.[\s\S]+scp "\$\{ssh_options\[@\]\}" "\$\{TARGET_PATH\}"/
    );
    assert.match(
        remote,
        /stat -f -c '%T' "\$\{TARGET_PATH\}"[\s\S]+tmpfs/
    );

    const cleanup = workflow.slice(
        workflow.indexOf('- name: Remove private runner material')
    );
    assert.match(
        cleanup,
        /PRIVATE_TARGET_ROOT: \$\{\{ steps\.target\.outputs\.private_root \}\}/
    );
    assert.match(
        cleanup,
        /\^\/dev\/shm\/development-api-ldareg-private-target\\\.\[A-Za-z0-9\]\{6\}\$/
    );
    assert.match(
        cleanup,
        /stat -f -c '%T' "\$\{PRIVATE_TARGET_ROOT\}"[\s\S]+tmpfs/
    );
    assert.doesNotMatch(
        cleanup,
        /RUNNER_TEMP.*development-api-ldareg-private-target/
    );
});

test('owner installer의 /dev/fd pin은 Linux와 macOS에서 underlying file identity를 비교한다', () => {
    assert.match(
        ownerInstaller,
        /stat -L -c '%d:%i:%s' -- "\$1"/
    );
    assert.match(
        ownerInstaller,
        /stat -L -f '%i:%z' "\$1"/
    );
    const statIdentityFunction = ownerInstaller.match(
        /stat_identity\(\) \{[\s\S]*?\n\}/
    )?.[0];
    assert.ok(statIdentityFunction);
    execFileSync(
        'bash',
        [
            '-c',
            `${statIdentityFunction}
exec 7<package.json
test "$(stat_identity package.json)" = "$(stat_identity /dev/fd/7)"
exec 7<&-`,
        ],
        {
            cwd: root,
            stdio: 'pipe',
        }
    );
});

test('exact target 내용은 git에 두지 않고 key별 manifest digest와 single/linked shape만 pin한다', () => {
    const pins = runner.slice(
        runner.indexOf(
            'export const DEVELOPMENT_API_LDAREG_TARGET_PINS'
        ),
        runner.indexOf(
            'export interface DevelopmentApiLdaregScanAdapter'
        )
    );
    assert.equal(
        (pins.match(/'ldareg-target-0[1-7]': Object\.freeze/g) ??
            []).length,
        7
    );
    assert.equal(
        (pins.match(/provisioned: false/g) ?? []).length,
        0
    );
    assert.equal(
        (pins.match(/provisioned: true/g) ?? []).length,
        7
    );
    assert.equal(
        (pins.match(/scopePnuCount: 1/g) ?? []).length,
        6
    );
    assert.equal(
        (pins.match(/scopePnuCount: 2/g) ?? []).length,
        1
    );
    assert.equal(
        (pins.match(/bylotCount: 0/g) ?? []).length,
        6
    );
    assert.equal(
        (pins.match(/bylotCount: 1/g) ?? []).length,
        1
    );
    assert.match(
        runner,
        /development-api-authoritative-ldareg-private-target-bundle@1/
    );
    assert.match(
        runner,
        /development-api-authoritative-ldareg-backfill-target@2/
    );
    assert.match(
        targetSelector,
        /selectDevelopmentApiLdaregTargetFromBundle/
    );
    assert.match(
        targetSelector,
        /constants\.O_EXCL[\s\S]+constants\.O_NOFOLLOW[\s\S]+0o600/
    );
    assert.match(
        targetSelector,
        /constants\.O_RDONLY \| constants\.O_NOFOLLOW[\s\S]+handle\.stat\(\)[\s\S]+targetInfo\.ino !== targetPathInfo\.ino[\s\S]+handle\.readFile/
    );
    assert.match(
        cli,
        /constants\.O_RDONLY \| constants\.O_NOFOLLOW[\s\S]+handle\.stat\(\)[\s\S]+targetInfo\.ino !== targetPathInfo\.ino[\s\S]+handle\.readFile/
    );
    assert.match(
        targetSelector,
        /Development API-authoritative LDAREG target selected\./
    );
    const manifestRoot = path.join(
        root,
        'development-api-authoritative-ldareg-backfill-manifests'
    );
    const repositoryManifests = fs.existsSync(manifestRoot)
        ? fs.readdirSync(manifestRoot)
        : [];
    assert.deepEqual(repositoryManifests, []);
    assert.doesNotMatch(
        `${workflow}\n${pins}\n${targetSelector}`,
        /\b[0-9]{19}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i
    );
    const sensitiveManifestHistory = execFileSync(
        'git',
        [
            'log',
            'HEAD',
            '--format=',
            '--name-only',
            '--',
            'development-api-authoritative-ldareg-backfill-manifests',
        ],
        {
            cwd: root,
            encoding: 'utf8',
        }
    );
    assert.equal(sensitiveManifestHistory.trim(), '');
});

test('official Building HUB/VWorld 호출은 대표·부속 전체를 직렬 처리한다', () => {
    const scanStart = runner.indexOf(
        'export async function scanDevelopmentApiLdaregOfficialSource'
    );
    const scanEnd = runner.indexOf(
        'function validateApplyReceipt',
        scanStart
    );
    const scan = runner.slice(scanStart, scanEnd);
    assert.match(scan, /await input\.adapter\.scanTitle/);
    assert.match(scan, /await input\.adapter\.scanAttached/);
    assert.match(scan, /await input\.adapter\.scanBasis/);
    assert.match(scan, /await input\.adapter\.scanExpos/);
    assert.match(scan, /await input\.adapter\.scanLadfrl/);
    assert.match(scan, /await input\.adapter\.scanLdareg/);
    assert.doesNotMatch(scan, /Promise\.all/);
    assert.match(
        runner,
        /OFFICIAL_LDAREG_EXPOS_CORRELATION_AMBIGUOUS/
    );
    assert.match(
        runner,
        /component\.sourceRecord\.pnu ===\s*component\.targetPnu|sourceRecord\.pnu !== targetPnu/
    );
});

test('service-role runner는 전용 inspect/apply RPC만 호출하고 approval writer나 일반 sync 경로를 호출하지 않는다', () => {
    assert.match(
        cli,
        /inspect_development_api_authoritative_ldareg_backfill_v1/
    );
    assert.match(
        cli,
        /apply_development_api_authoritative_ldareg_backfill_v1/
    );
    assert.doesNotMatch(
        cli,
        /\.rpc\(\s*['"]replace_development_api_authoritative_ldareg_backfill_approval_v1/
    );
    assert.doesNotMatch(
        workflow,
        /development-land-area-sync-runner|\/api\/gis\/land-area-sync|land-area-sync\/.*confirm/
    );
    assert.match(
        runner,
        /DEVELOPMENT_API_LDAREG_MAX_APPLY_ATTEMPTS = 3/
    );
    assert.match(
        runner,
        /evidenceDigest:[\s\S]+sourceReleaseSha:[\s\S]+targetDigest,\s+syncJobId,[\s\S]+onAttempt/
    );
    assert.match(
        cli,
        /p_target_manifest_digest:\s*target\.manifestDigest/
    );
    assert.match(
        cli,
        /p_expected_prestate_rights_digest:\s*input\.expectedPrestateTargetRightsDigest/
    );
    assert.match(
        runner,
        /input\.target\.manifestDigest,[\s\S]+input\.scopeDigest,[\s\S]+input\.prestateTargetRightsDigest,[\s\S]+input\.target\.phase0\.runId/
    );
});

test('prepare 구현은 inspect 2회 외 DB write 경로가 없고 zero-write boundary를 봉인한다', () => {
    const start = runner.indexOf(
        'export async function prepareDevelopmentApiLdaregBackfill'
    );
    const end = runner.indexOf(
        'export async function runDevelopmentApiLdaregBackfill',
        start
    );
    const prepare = runner.slice(start, end);
    assert.match(
        prepare,
        /input\.database\.inspect/g
    );
    assert.equal(
        (prepare.match(/input\.database\.inspect/g) ?? []).length,
        2
    );
    assert.doesNotMatch(prepare, /input\.database\.apply/);
    assert.doesNotMatch(prepare, /\.rpc\(/);
    assert.match(
        prepare,
        /applyRpcCallCount: 0,[\s\S]+approvalRpcCallCount: 0,[\s\S]+syncJobWriteCount: 0,[\s\S]+propertyWriteCount: 0,[\s\S]+propertyRightWriteCount: 0/
    );
    assert.match(
        cli,
        /if \(args\.mode === 'prepare'\)[\s\S]+prepareDevelopmentApiLdaregBackfill/
    );
});

test('개발 DB pin, production hard deny, 일반 sync disabled/empty gate를 모두 강제한다', () => {
    assert.match(cli, /yxypndgipnxrdfyctmvh/);
    assert.match(
        cli,
        /env\.LAND_AREA_SYNC_ENABLED !== 'false'/
    );
    assert.match(
        cli,
        /env\.LAND_AREA_SYNC_ALLOWED_TARGETS \?\? ''/
    );
    assert.match(
        guardian,
        /health\?\.features\?\.landAreaSyncEnabled !== false/
    );
    assert.match(
        guardian,
        /landAreaSyncAllowedTargetCount !== 0/
    );
    assert.match(
        guardian,
        /landAreaSyncAllowedTargetsDigest !== ""/
    );
    assert.match(
        guardian,
        /target_revision[\s\S]+!= "\$\{EXPECTED_GIT_SHA\}"/
    );
    assert.doesNotMatch(
        `${cli}\n${guardian}\n${workflow}`,
        /PROD_SUPABASE|PRODUCTION_SUPABASE|createProductionClient/
    );
});

test('guardian은 공통 operation lock, tmpfs, hard timeout, private cleanup을 보장한다', () => {
    assert.match(
        guardian,
        /operation_lock_path="\$\{application_root\}\/\.land-area-sync-operation\.lock"/
    );
    assert.match(guardian, /exec 8>>"\$\{operation_lock_path\}"/);
    assert.match(guardian, /flock -w 900 8/);
    assert.match(guardian, /trap ':' HUP INT TERM/);
    assert.match(
        workflow,
        /nohup setsid env[\s\S]+bash "\$\{run_root\}\/guardian\.sh"/
    );
    assert.match(
        guardian,
        /host_root="\/dev\/shm\/\.development-api-authoritative-ldareg-backfill-\$\{RUN_KEY\}"/
    );
    assert.match(
        guardian,
        /container_workdir="\/dev\/shm"[\s\S]+stat -f -c "%T" \/dev\/shm[\s\S]+tmpfs/
    );
    assert.match(
        guardian,
        /\^\\\/dev\\\/shm\\\/\\\.development-api-authoritative-ldareg-backfill\\\/target-/
    );
    assert.match(
        guardian,
        /runner_timeout_seconds=3000[\s\S]+runner_client_timeout_seconds=3030[\s\S]+max_runner_start_elapsed_seconds=950[\s\S]+post_runner_cleanup_budget_seconds=500[\s\S]+timeout -k 10 "\$\{runner_timeout_seconds\}"/
    );
    assert.match(
        guardian,
        /runner_start_elapsed_seconds=\$\(\( SECONDS - janitor_started_at_seconds \)\)[\s\S]+runner_start_elapsed_seconds >= max_runner_start_elapsed_seconds[\s\S]+exit 69/
    );
    assert.match(
        guardian,
        /run_docker_bounded\(\)[\s\S]+timeout -k 5 "\$\{docker_command_timeout_seconds\}" docker/
    );
    assert.match(guardian, /cleanup_container_files/);
    assert.match(guardian, /cleanup_host_input/);
    assert.match(
        guardian,
        /container_approval_request[\s\S]+cleanup_container_files/
    );
    assert.match(
        guardian,
        /--mode "\$\{MODE\}"[\s\S]+--approval-request-out/
    );
    assert.match(
        dockerfile,
        /AGE_VERSION=1\.3\.1[\s\S]+AGE_LINUX_AMD64_SHA256=[0-9a-f]{64}[\s\S]+AGE_LINUX_ARM64_SHA256=[0-9a-f]{64}[\s\S]+linux-\$\{TARGETARCH\}[\s\S]+test "\$\(age --version\)" = "v1\.3\.1"/
    );
});

test('guardian 기동은 private log를 먼저 고정하고 빠른 terminal과 startup 실패를 구분한다', () => {
    const remoteStartMarker = workflow.indexOf("<<'REMOTE_START'");
    const remoteStartEnd = workflow.indexOf(
        '\n          REMOTE_START',
        remoteStartMarker
    );
    assert.ok(remoteStartMarker >= 0);
    assert.ok(remoteStartEnd > remoteStartMarker);
    const remoteStart = workflow.slice(
        remoteStartMarker,
        remoteStartEnd
    );
    const launchIndex = remoteStart.indexOf('nohup setsid env');
    const pidCaptureIndex = remoteStart.indexOf(
        'guardian_pid="$!"',
        launchIndex
    );
    assert.ok(launchIndex > 0);
    assert.ok(pidCaptureIndex > launchIndex);
    assert.ok(
        remoteStart.indexOf(
            'install -m 600 /dev/null "${guardian_log}"'
        ) < launchIndex
    );
    assert.doesNotMatch(
        remoteStart.slice(pidCaptureIndex),
        /guardian_log|guardian\.log|guardian\.pid/
    );
    assert.doesNotMatch(
        `${workflow}\n${guardian}`,
        /guardian\.pid/
    );

    const handshake = remoteStart.slice(
        remoteStart.indexOf('startup_state="PENDING"')
    );
    assert.ok(
        handshake.indexOf(
            '[[ -e "${guardian_status}" || -L "${guardian_status}" ]]'
        ) <
            handshake.indexOf(
                '[[ -e "${guardian_started}" || -L "${guardian_started}" ]]'
            )
    );
    assert.match(
        handshake,
        /startup_state="TERMINAL"[\s\S]+startup_state="STARTED"/
    );
    assert.doesNotMatch(handshake, /kill -0 "\$\{guardian_pid\}"/);
    assert.match(
        handshake,
        /startup_state="STARTUP_TIMEOUT"/
    );
    assert.match(
        workflow,
        /case "\$\{startup_state\}" in[\s\S]+STARTED\)[\s\S]+TERMINAL\)[\s\S]+STARTUP_FAILED\)[\s\S]+STARTUP_TIMEOUT\)/
    );
    assert.match(
        workflow,
        /TERMINAL\)[\s\S]+completed=1[\s\S]+if \[\[ "\$\{completed\}" -ne 1 \]\]; then[\s\S]+seq 1 390/
    );
});

test('취소·오류 cleanup은 exact ACK, 5분 terminal, 75분 absolute TTL로 self-expire한다', () => {
    assert.match(guardian, /absolute_cleanup_ttl_seconds=4500/);
    assert.match(guardian, /export_cleanup_ttl_seconds=300/);
    assert.match(guardian, /JANITOR_MODE=1/);
    assert.match(
        guardian,
        /guardian_session_id="\$\(ps -o sid= -p "\$\$" \| tr -d '\[:space:\]'\)"[\s\S]+guardian_process_group_id[\s\S]+GUARDIAN_SESSION_ID="\$\{guardian_session_id\}"/
    );
    assert.match(
        guardian,
        /actual_sid[\s\S]+actual_process_group_id[\s\S]+actual_sid}" = "\$\{expected_session_id\}"[\s\S]+actual_process_group_id}" = "\$\{expected_session_id\}"/
    );
    assert.doesNotMatch(
        guardian,
        /actual_sid}" = "\$\{guardian_pid\}"/
    );
    assert.match(
        guardian,
        /kill -TERM -- "-\$\{guardian_session_id\}"[\s\S]+kill -KILL -- "-\$\{guardian_session_id\}"/
    );
    assert.ok(
        guardian.lastIndexOf('start_cleanup_janitor') <
            guardian.indexOf('flock -w 900')
    );
    assert.ok(
        guardian.lastIndexOf('start_cleanup_janitor') <
            guardian.indexOf(
                'node /app/dist/cli/development-api-authoritative-ldareg-backfill.js'
            )
    );
    assert.match(
        guardian,
        /host_container_id="\$\{host_root\}\/container-id"[\s\S]+write_private_line "\$\{host_container_id\}" "\$\{target_container\}"/
    );
    assert.match(
        guardian,
        /ack_value="ACK:\$\{RUN_KEY\}:\$\{EXPECTED_GIT_SHA\}:\$\{MODE\}"/
    );
    assert.match(
        guardian,
        /host_approval_ciphertext[\s\S]+host_artifact[\s\S]+host_status/
    );
    assert.doesNotMatch(guardian, /rm -rf/);
    assert.equal(
        guardian.includes(['host', 'approval', 'request'].join('_')),
        false
    );

    const cleanup = workflow.slice(
        workflow.indexOf('cleanup_remote()'),
        workflow.indexOf('finish_step()')
    );
    assert.match(cleanup, /workflow-ack/);
    assert.match(cleanup, /ACK:\$\{RUN_KEY\}:\$\{EXPECTED_GIT_SHA\}:\$\{MODE\}/);
    assert.doesNotMatch(cleanup, /flock -w 30|operation_lock/);
    const finish = workflow.slice(
        workflow.indexOf('finish_step()'),
        workflow.indexOf('trap finish_step EXIT')
    );
    assert.doesNotMatch(finish, /cleanup_remote \|\| true/);
    assert.match(finish, /cleanup_status/);
});

test('redacted artifact와 owner age ciphertext만 분리 검증·보관한다', () => {
    assert.match(
        guardian,
        /DEVELOPMENT_API_AUTHORITATIVE_LDAREG_BACKFILL_ARTIFACT_VALIDATED/
    );
    assert.match(
        workflow,
        /Revalidate private redacted artifact/
    );
    assert.match(
        validator,
        /validateDevelopmentApiLdaregArtifact[\s\S]+validateDevelopmentApiLdaregPrepareArtifact|validateDevelopmentApiLdaregPrepareArtifact[\s\S]+validateDevelopmentApiLdaregArtifact/
    );
    const upload = workflow.slice(
        workflow.indexOf(
            '- name: Upload private redacted artifact'
        ),
        workflow.indexOf(
            '- name: Enforce API-authoritative backfill gate'
        )
    );
    assert.match(
        upload,
        /path: development-api-ldareg-output\/artifact\.json/
    );
    assert.doesNotMatch(upload, /target\.json|guardian\.log/);
    const approvalUpload = workflow.slice(
        workflow.indexOf(
            '- name: Upload owner-encrypted approval ciphertext'
        ),
        workflow.indexOf(
            '- name: Enforce API-authoritative backfill gate'
        )
    );
    assert.match(
        approvalUpload,
        /path: development-api-ldareg-output\/approval-request\.age/
    );
    assert.match(approvalUpload, /retention-days: 1/);
    assert.doesNotMatch(
        approvalUpload,
        /artifact\.json|target\.json|guardian\.log/
    );
    assert.match(
        approvalValidator,
        /validateDevelopmentApiLdaregApprovalRequest/
    );
    assert.match(
        validator,
        /readPinnedPrivateJson[\s\S]+resolvePrivateJsonPath/
    );
    assert.match(
        approvalValidator,
        /readPinnedPrivateJson[\s\S]+resolvePrivateJsonPath/
    );
    assert.doesNotMatch(
        `${validator}\n${approvalValidator}`,
        /readFile\(|realpath\(|lstat\(/
    );
    assert.match(
        privateFile,
        /constants\.O_RDONLY \| constants\.O_NOFOLLOW[\s\S]+handle\.stat\(\)[\s\S]+realpath\(candidate\)[\s\S]+targetPathInfoAfter\.ino !== descriptorAfter\.ino/
    );
    assert.match(
        privateFile,
        /lstat\(candidate\)[\s\S]+candidatePathInfo\.isSymbolicLink\(\)[\s\S]+lstat\(candidate\)[\s\S]+candidatePathInfoAfter\.isSymbolicLink\(\)/
    );
    assert.match(
        privateFile,
        /constants\.O_WRONLY[\s\S]+constants\.O_CREAT[\s\S]+constants\.O_EXCL[\s\S]+constants\.O_NOFOLLOW[\s\S]+0o600[\s\S]+lstat\(candidate\)[\s\S]+candidatePathInfo\.isSymbolicLink\(\)/
    );
    assert.match(
        privateFileMaterializer,
        /DEVELOPMENT_API_AUTHORITATIVE_LDAREG_PRIVATE_FILE_MATERIALIZED/
    );
    assert.match(
        privateFileStager,
        /DEVELOPMENT_API_AUTHORITATIVE_LDAREG_PRIVATE_FILE_STAGED/
    );
    assert.match(
        guardian,
        /DEVELOPMENT_API_AUTHORITATIVE_LDAREG_APPROVAL_REQUEST_VALIDATED/
    );
    assert.match(
        workflow,
        /inputs\.mode == 'prepare'[\s\S]+approval-ciphertext-validated-runner/
    );
    assert.match(
        guardian,
        /age --encrypt --armor[\s\S]+--recipient "\$\{OWNER_AGE_RECIPIENT\}"[\s\S]+rm -f -- "\$\{PRIVATE_REQUEST\}"/
    );
    assert.match(
        workflow,
        /LDAREG_APPROVAL_AGE_RECIPIENT[\s\S]+20f4e791c9b45cccdd8882ded87bf9171ef0387fc5e1a25dcd89781c1893b93c/
    );
    assert.doesNotMatch(
        workflow,
        /vars\.LDAREG_APPROVAL_AGE_RECIPIENT_SHA256/
    );
    assert.match(
        ownerInstaller,
        /age --version\)" != "v1\.3\.1"[\s\S]+stage_private_input "\$\{ciphertext\}" "\$\{staged_ciphertext\}"[\s\S]+exec 7<"\$\{staged_identity\}"[\s\S]+stat_identity "\$\{staged_identity\}"[\s\S]+age-keygen -y \/dev\/fd\/7[\s\S]+age --decrypt[\s\S]+--identity \/dev\/fd\/8[\s\S]+\/dev\/fd\/9/
    );
    assert.match(
        ownerInstaller,
        /development-api-authoritative-ldareg-private-file-materialize\.js[\s\S]+--encoding raw/
    );
    assert.match(
        ownerInstaller,
        /development-api-authoritative-ldareg-backfill-approval-request-validate\.js[\s\S]+node "\$\{validator\}"[\s\S]+stage_private_input "\$\{plaintext_temporary\}" "\$\{private_output\}"/
    );
    assert.match(
        ownerInstaller,
        /stat_uid "\$\{private_input\}"[\s\S]+stat_mode "\$\{private_input\}"[\s\S]+stat_uid "\$\{private_input_parent\}"[\s\S]+stat_mode "\$\{private_input_parent\}"\)" != "700"/
    );
    assert.doesNotMatch(
        ownerInstaller,
        /--identity "\$\{identity\}"|age --decrypt[\s\S]+ "\$\{ciphertext\}"|install -m 600 "\$\{plaintext_temporary\}" "\$\{private_output\}"|> "\$\{plaintext_temporary\}"/
    );
    assert.doesNotMatch(
        approvalUpload,
        /approval-request\.json|target\.json|guardian\.log|artifact\.json/
    );
    const summary = workflow.slice(
        workflow.indexOf(
            '- name: Enforce API-authoritative backfill gate'
        ),
        workflow.indexOf('- name: Remove private runner material')
    );
    assert.doesNotMatch(
        summary,
        /approval-request\.json|TARGET_B64|OWNER_AGE_RECIPIENT=/
    );
    assert.match(
        runner,
        /NO_PRODUCTION_CLIENT_CONSTRUCTED_DEVELOPMENT_PROJECT_REF_PINNED/
    );
    assert.match(
        runner,
        /sourceReads: 0,[\s\S]+resolverReads: 0,[\s\S]+blockerReads: 0,[\s\S]+fallbackReads: 0,[\s\S]+selectionReads: 0/
    );
});
