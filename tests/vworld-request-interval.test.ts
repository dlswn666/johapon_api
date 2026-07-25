import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEFAULT_VWORLD_ATTR_REQUEST_INTERVAL_MS,
    MAX_VWORLD_ATTR_REQUEST_INTERVAL_MS,
    parseVworldRequestIntervalMs,
} from '../src/utils/vworld-request-interval';

test('V-World 요청 간격은 unset/empty에만 기본값 300ms를 사용하고 명시적 0을 허용한다', () => {
    assert.equal(DEFAULT_VWORLD_ATTR_REQUEST_INTERVAL_MS, 300);
    assert.equal(parseVworldRequestIntervalMs(undefined), 300);
    assert.equal(parseVworldRequestIntervalMs(''), 300);
    assert.equal(parseVworldRequestIntervalMs('   '), 300);
    assert.equal(parseVworldRequestIntervalMs(0), 0);
    assert.equal(parseVworldRequestIntervalMs('0'), 0);
    assert.equal(parseVworldRequestIntervalMs(300), 300);
    assert.equal(parseVworldRequestIntervalMs('00300'), 300);
    assert.equal(
        parseVworldRequestIntervalMs(MAX_VWORLD_ATTR_REQUEST_INTERVAL_MS),
        MAX_VWORLD_ATTR_REQUEST_INTERVAL_MS
    );
    assert.equal(
        parseVworldRequestIntervalMs(
            String(MAX_VWORLD_ATTR_REQUEST_INTERVAL_MS)
        ),
        MAX_VWORLD_ATTR_REQUEST_INTERVAL_MS
    );
});

test('V-World 요청 간격은 음수·소수·부분문자·비유한·overflow를 fail-closed한다', () => {
    const invalidValues: unknown[] = [
        null,
        -1,
        '-1',
        0.5,
        '0.5',
        '300ms',
        '300 ',
        ' 300',
        '+300',
        Number.NaN,
        'NaN',
        Number.POSITIVE_INFINITY,
        'Infinity',
        MAX_VWORLD_ATTR_REQUEST_INTERVAL_MS + 1,
        String(MAX_VWORLD_ATTR_REQUEST_INTERVAL_MS + 1),
        Number.MAX_SAFE_INTEGER + 1,
        '9007199254740992',
    ];

    for (const value of invalidValues) {
        assert.throws(
            () => parseVworldRequestIntervalMs(value),
            /0~2147483647 범위의 정수/
        );
    }
});
