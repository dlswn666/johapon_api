import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { validateLandAreaSyncRuntimeAllowlist } from '../src/verification/land-area-sync-runtime-allowlist';

const UNION = '00000000-0000-4000-a000-000000000001';
const PNU_A = '1130510100107450001';
const PNU_B = '1130510100107450002';
const DEVELOPMENT_ALLOWLIST = [
    `development:${UNION}:${PNU_A}`,
    `development:${UNION}:${PNU_B}`,
].join(',');
const DEVELOPMENT_DIGEST = createHash('sha256')
    .update(DEVELOPMENT_ALLOWLIST, 'utf8')
    .digest('hex');

test('enable은 canonical development allowlist의 count와 digest가 일치할 때만 통과한다', () => {
    assert.deepEqual(
        validateLandAreaSyncRuntimeAllowlist({
            action: 'enable',
            rawAllowedTargets: DEVELOPMENT_ALLOWLIST,
            expectedCount: '2',
            expectedDigest: DEVELOPMENT_DIGEST,
        }),
        {
            action: 'enable',
            count: 2,
            digest: DEVELOPMENT_DIGEST,
        }
    );
});

test('enable은 production canonical allowlist도 count·digest 일치 시 통과한다', () => {
    const productionAllowlist = [
        `production:${UNION}:${PNU_A}`,
        `production:${UNION}:${PNU_B}`,
    ].join(',');
    const productionDigest = createHash('sha256')
        .update(productionAllowlist, 'utf8')
        .digest('hex');
    assert.deepEqual(
        validateLandAreaSyncRuntimeAllowlist({
            action: 'enable',
            rawAllowedTargets: productionAllowlist,
            expectedCount: '2',
            expectedDigest: productionDigest,
        }),
        {
            action: 'enable',
            count: 2,
            digest: productionDigest,
        }
    );
    // 한 allowlist 에 두 환경 혼합은 거부한다 — 창은 단일 환경으로만 연다.
    const mixed = [
        `development:${UNION}:${PNU_A}`,
        `production:${UNION}:${PNU_B}`,
    ].join(',');
    assert.throws(
        () =>
            validateLandAreaSyncRuntimeAllowlist({
                action: 'enable',
                rawAllowedTargets: mixed,
                expectedCount: '2',
                expectedDigest: createHash('sha256')
                    .update(mixed, 'utf8')
                    .digest('hex'),
            }),
        /단일 database target/
    );
});

test('enable은 wildcard, duplicate, 비정규 raw allowlist를 거부한다', () => {
    const rejected = [
        `development:*:${PNU_A}`,
        `development:${UNION}:*`,
        `development:${UNION}:${PNU_A},development:${UNION}:${PNU_A}`,
        `development:${UNION.toUpperCase()}:${PNU_A}`,
        `development:${UNION}:${PNU_B},development:${UNION}:${PNU_A}`,
        `development:${UNION}:${PNU_A}, development:${UNION}:${PNU_B}`,
        `development:${UNION}:${PNU_A}\n`,
        `development:${UNION}:${PNU_A}\0`,
    ];

    for (const rawAllowedTargets of rejected) {
        const digest = createHash('sha256')
            .update(rawAllowedTargets, 'utf8')
            .digest('hex');
        assert.throws(() =>
            validateLandAreaSyncRuntimeAllowlist({
                action: 'enable',
                rawAllowedTargets,
                expectedCount: rawAllowedTargets.includes(',') ? '2' : '1',
                expectedDigest: digest,
            })
        );
    }
});

test('enable은 승인된 count 또는 digest가 다르면 fail closed한다', () => {
    assert.throws(() =>
        validateLandAreaSyncRuntimeAllowlist({
            action: 'enable',
            rawAllowedTargets: DEVELOPMENT_ALLOWLIST,
            expectedCount: '1',
            expectedDigest: DEVELOPMENT_DIGEST,
        })
    );
    assert.throws(() =>
        validateLandAreaSyncRuntimeAllowlist({
            action: 'enable',
            rawAllowedTargets: DEVELOPMENT_ALLOWLIST,
            expectedCount: '2',
            expectedDigest: '0'.repeat(64),
        })
    );
});

test('disable은 empty allowlist, count=0, empty digest로 반복 가능하다', () => {
    const input = {
        action: 'disable',
        rawAllowedTargets: '',
        expectedCount: '0',
        expectedDigest: '',
    };
    assert.deepEqual(validateLandAreaSyncRuntimeAllowlist(input), {
        action: 'disable',
        count: 0,
        digest: '',
    });
    assert.deepEqual(validateLandAreaSyncRuntimeAllowlist(input), {
        action: 'disable',
        count: 0,
        digest: '',
    });

    for (const invalid of [
        { ...input, rawAllowedTargets: DEVELOPMENT_ALLOWLIST },
        { ...input, expectedCount: '1' },
        { ...input, expectedDigest: DEVELOPMENT_DIGEST },
    ]) {
        assert.throws(() => validateLandAreaSyncRuntimeAllowlist(invalid));
    }
});
