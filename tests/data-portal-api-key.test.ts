import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDataPortalApiKey } from '../src/utils/data-portal-api-key';

test('URL 인코딩 공공데이터 인증키는 정확히 한 번 디코딩한다', () => {
    assert.equal(
        normalizeDataPortalApiKey('sample%2Bkey%2Fvalue%3D'),
        'sample+key/value='
    );
    assert.equal(
        normalizeDataPortalApiKey('sample%252Bkey'),
        'sample%2Bkey',
        '한 호출에서 두 번 디코딩하면 안 된다'
    );
});

test('일반 인증키는 변경하지 않는다', () => {
    assert.equal(
        normalizeDataPortalApiKey('sample+key/value='),
        'sample+key/value='
    );
});

test('인증키 앞뒤 공백은 인코딩 여부와 무관하게 제거한다', () => {
    assert.equal(
        normalizeDataPortalApiKey('  sample%2Bkey%3D  '),
        'sample+key='
    );
    assert.equal(
        normalizeDataPortalApiKey('\n sample+key=\t'),
        'sample+key='
    );
});

test('잘못된 percent escape는 예외 없이 trim한 원문을 유지한다', () => {
    assert.equal(
        normalizeDataPortalApiKey('  sample%2Fkey%ZZ  '),
        'sample%2Fkey%ZZ'
    );
});

test('빈 값은 빈 문자열로 정규화한다', () => {
    assert.equal(normalizeDataPortalApiKey(''), '');
    assert.equal(normalizeDataPortalApiKey('   '), '');
    assert.equal(normalizeDataPortalApiKey(undefined), '');
    assert.equal(normalizeDataPortalApiKey(null), '');
});
