import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(
    path.join(
        root,
        '.github/workflows/development-building-registry-relation-adoption.yml'
    ),
    'utf8'
);
const guardian = fs.readFileSync(
    path.join(
        root,
        'scripts/development-building-registry-relation-adoption-guardian.sh'
    ),
    'utf8'
);
const runner = fs.readFileSync(
    path.join(
        root,
        'src/operations/development-building-registry-relation-adoption.ts'
    ),
    'utf8'
);
const cli = fs.readFileSync(
    path.join(
        root,
        'src/cli/development-building-registry-relation-adoption.ts'
    ),
    'utf8'
);
const dockerfile = fs.readFileSync(
    path.join(root, 'Dockerfile'),
    'utf8'
);

test('workflow는 main의 repository-approved 단일 target과 protected development environment만 허용한다', () => {
    assert.match(
        workflow,
        /environment: land-area-sync-development-write/
    );
    assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
    assert.match(workflow, /permissions:[\s\S]+contents: read[\s\S]+actions: read/);
    assert.match(workflow, /type: choice/);
    assert.match(
        workflow,
        /mia-seven-791-2280-2281-20260725/
    );
    assert.match(
        workflow,
        /development-building-registry-relation-adoption-manifests\/mia-seven-791-2280-2281-target-20260725\.json/
    );
    assert.match(
        workflow,
        /node scripts\/check-property-building-link-writers\.mjs/
    );
    assert.doesNotMatch(workflow, /type: string/);
    assert.doesNotMatch(
        workflow,
        /PROD_SUPABASE|SUPABASE_URL:.*secrets|SERVICE_ROLE_KEY:.*secrets/
    );
});

test('prior Phase 0 artifact는 성공 run, exact artifact name과 SHA, repository manifest를 모두 pin한다', () => {
    assert.match(workflow, /phase0_run_id="30146538770"/);
    assert.match(
        workflow,
        /land-area-phase0-mia-seven-791-2280-base-attached-first-observation-20260725-30146538770/
    );
    assert.match(
        workflow,
        /phase0-manifests\/mia-seven-791-2280-base-attached-first-observation-20260725\.json/
    );
    assert.match(workflow, /\.conclusion'[\s\S]+!= "success"/);
    assert.match(workflow, /actual_sha=.*sha256sum/);
    assert.match(
        workflow,
        /actual_sha\}" != "\$\{expected_sha\}/
    );
    assert.match(
        guardian,
        /--phase0-manifest "\.development-building-registry-relation-adoption\/phase0-manifest-\$\{RUN_KEY\}\.json"/
    );
    assert.match(
        guardian,
        /--phase0-artifact "\.development-building-registry-relation-adoption\/phase0-artifact-\$\{RUN_KEY\}\.json"/
    );
});

test('service-role runner는 approval writer를 호출하지 않고 preinstalled approval을 inspect/adopt로만 소비한다', () => {
    const implementation = `${runner}\n${cli}\n${guardian}\n${workflow}`;
    assert.match(
        cli,
        /adopt_development_verified_building_registry_relation_v1/
    );
    assert.match(
        cli,
        /inspect_development_verified_building_registry_relation_v1/
    );
    assert.match(
        runner,
        /development-building-registry-relation-inspector@1/
    );
    assert.match(
        cli,
        /DEVELOPMENT_RELATION_ADOPTION_INSPECTOR_CONTRACT/
    );
    assert.doesNotMatch(
        implementation,
        /replace_development_building_registry_relation_adoption_approval_v1|replace_land_area_sync_approval_manifest_v1|p_manifest_digest/
    );
    assert.match(runner, /validatePreinstalledApproval/);
    assert.match(
        runner,
        /manualDataUsage:[\s\S]+sourceReads: 0,[\s\S]+blockerReads: 0,[\s\S]+fallbackWrites: 0/
    );
});

test('개발 DB와 deployed image 경계, land-area disabled health attestation을 exact 강제한다', () => {
    assert.match(
        cli,
        /https:\/\/\$\{DEVELOPMENT_PROJECT_REF\}\.supabase\.co/
    );
    assert.match(cli, /yxypndgipnxrdfyctmvh/);
    assert.match(
        cli,
        /env\.LAND_AREA_SYNC_ENABLED !== 'false'/
    );
    assert.match(
        guardian,
        /health\?\.landAreaSyncEnabled !== false/
    );
    assert.match(
        guardian,
        /target_revision[\s\S]+!= "\$\{EXPECTED_GIT_SHA\}"/
    );
    assert.match(
        workflow,
        /EXPECTED_IMAGE_TAG: ghcr\.io\/dlswn666\/alimtalk-proxy:\$\{\{ github\.sha \}\}/
    );
    assert.doesNotMatch(
        `${runner}\n${cli}`,
        /PROD_SUPABASE|production-project|createProduction/
    );
});

test('guardian은 공통 lock을 보유하고 approval 원자 소비와 bounded retry를 SSH 취소와 분리한다', () => {
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
        runner,
        /DEVELOPMENT_RELATION_ADOPTION_MAX_ATTEMPTS = 3/
    );
    assert.match(
        runner,
        /const request = \{[\s\S]+syncJobId: input\.syncJobId,[\s\S]+database\.adoptRelation\(request\)/
    );
    assert.doesNotMatch(runner, /replaceRelationApproval|finally/);
});

test('target, Phase 0 inputs, 결과 artifact는 private directory에서만 처리하고 sanitized artifact만 업로드한다', () => {
    assert.match(
        dockerfile,
        /\.development-building-registry-relation-adoption/
    );
    assert.match(
        guardian,
        /container_root="\/app\/\.development-building-registry-relation-adoption"/
    );
    assert.match(
        guardian,
        /stream_file "\$\{host_target\}" "\$\{container_target\}"/
    );
    assert.match(
        guardian,
        /stream_file "\$\{host_phase0_manifest\}" "\$\{container_phase0_manifest\}"/
    );
    assert.match(
        guardian,
        /stream_file "\$\{host_phase0\}" "\$\{container_phase0\}"/
    );
    const uploadBlock = workflow.slice(
        workflow.indexOf('- name: Upload private sanitized artifact'),
        workflow.indexOf('- name: Enforce adoption gate')
    );
    assert.match(
        uploadBlock,
        /path: development-building-relation-output\/artifact\.json/
    );
    assert.doesNotMatch(
        uploadBlock,
        /target\.json|phase0-artifact\.json|phase0-manifest\.json/
    );
    assert.match(
        runner,
        /NO_PRODUCTION_CLIENT_CONSTRUCTED_DEVELOPMENT_PROJECT_REF_PINNED/
    );
});
