import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildBasisRootIndex,
    resolveExposRootIdentity,
} from '../src/services/land-area-sync/expos-root';

const ROOT = '1001001001001';
const CHILD = '2002002002002';

function index(
    rows: Array<{
        mgmBldrgstPk?: string | number;
        mgmUpBldrgstPk?: string | number;
    }> = [
        {
            mgmBldrgstPk: ROOT,
            // title root basis row의 더 높은 lineage는 child parent로 쓰지 않는다.
            mgmUpBldrgstPk: '9999999999999',
        },
        {
            mgmBldrgstPk: CHILD,
            mgmUpBldrgstPk: ROOT,
        },
    ]
) {
    const result = buildBasisRootIndex(rows, [ROOT]);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('basis index가 해소되지 않았습니다.');
    return result.index;
}

test('title root EXPOS의 raw up 누락은 SELF 근거로 해소한다', () => {
    const result = resolveExposRootIdentity(
        { mgmBldrgstPk: ROOT },
        index()
    );
    assert.deepEqual(result, {
        ok: true,
        evidence: {
            selfIdentity: ROOT,
            rootIdentity: ROOT,
            rawUpIdentity: null,
            source: 'SELF',
        },
    });
});

test('accepted title self의 EXPOS raw up은 self와 같을 때만 허용한다', () => {
    assert.deepEqual(
        resolveExposRootIdentity(
            {
                mgmBldrgstPk: ROOT,
                mgmUpBldrgstPk: ROOT,
            },
            index()
        ),
        {
            ok: true,
            evidence: {
                selfIdentity: ROOT,
                rootIdentity: ROOT,
                rawUpIdentity: ROOT,
                source: 'RAW_UP',
            },
        }
    );
    assert.deepEqual(
        resolveExposRootIdentity(
            {
                mgmBldrgstPk: ROOT,
                mgmUpBldrgstPk: '9999999999999',
            },
            index()
        ),
        { ok: false }
    );
});

test('basis child EXPOS의 raw up 누락은 exact unique parent로만 보강한다', () => {
    const result = resolveExposRootIdentity(
        { mgmBldrgstPk: CHILD },
        index()
    );
    assert.deepEqual(result, {
        ok: true,
        evidence: {
            selfIdentity: CHILD,
            rootIdentity: ROOT,
            rawUpIdentity: null,
            source: 'BASIS_UNIQUE',
        },
    });
});

test('child의 명시 raw up은 basis parent와 같을 때만 RAW_UP으로 인정한다', () => {
    const accepted = resolveExposRootIdentity(
        {
            mgmBldrgstPk: CHILD,
            mgmUpBldrgstPk: ROOT,
        },
        index()
    );
    assert.equal(accepted.ok, true);
    assert.equal(
        accepted.ok ? accepted.evidence.source : null,
        'RAW_UP'
    );

    const conflicting = resolveExposRootIdentity(
        {
            mgmBldrgstPk: CHILD,
            mgmUpBldrgstPk: '3003003003003',
        },
        index()
    );
    assert.deepEqual(conflicting, { ok: false });
});

test('invalid raw up과 basis에 없는 child는 missing으로 강등하지 않는다', () => {
    assert.deepEqual(
        resolveExposRootIdentity(
            {
                mgmBldrgstPk: CHILD,
                mgmUpBldrgstPk: 'INVALID',
            },
            index()
        ),
        { ok: false }
    );
    assert.deepEqual(
        resolveExposRootIdentity(
            { mgmBldrgstPk: '4004004004004' },
            index()
        ),
        { ok: false }
    );
});

test('한 child의 복수 title root와 closure 밖 parent는 basis index에서 차단한다', () => {
    const otherRoot = '5005005005005';
    assert.deepEqual(
        buildBasisRootIndex(
            [
                {
                    mgmBldrgstPk: CHILD,
                    mgmUpBldrgstPk: ROOT,
                },
                {
                    mgmBldrgstPk: CHILD,
                    mgmUpBldrgstPk: otherRoot,
                },
            ],
            [ROOT, otherRoot]
        ),
        { ok: false }
    );
    assert.deepEqual(
        buildBasisRootIndex(
            [
                {
                    mgmBldrgstPk: CHILD,
                    mgmUpBldrgstPk: otherRoot,
                },
            ],
            [ROOT]
        ),
        { ok: false }
    );
});
