import assert from 'node:assert/strict';
import test from 'node:test';
import { LegalOpenApiError } from '../src/services/legal-research/errors';
import {
    isOfficialLawLink,
    sanitizeOfficialLawLink,
    sanitizeOptionalOfficialLawLink,
} from '../src/services/legal-research/official-link';

test('법제처 상대/http 링크를 HTTPS 공개 링크로 만들고 인증 query를 제거한다', () => {
    const relative = sanitizeOfficialLawLink('/DRF/lawService.do?OC=secret&target=prec&ID=700&token=abc');
    const absolute = sanitizeOfficialLawLink('http://law.go.kr/%EB%B2%95%EB%A0%B9/%EB%8F%84%EC%8B%9C%EC%A0%95%EB%B9%84%EB%B2%95?api_key=x');

    assert.equal(relative, 'https://www.law.go.kr/DRF/lawService.do?target=prec&ID=700');
    assert.match(absolute, /^https:\/\/law\.go\.kr\//);
    assert.equal(absolute.includes('api_key'), false);
    assert.equal(sanitizeOptionalOfficialLawLink(undefined), undefined);
});

test('링크 식별자 일치 여부를 인증 query 제거 전에 확인한다', () => {
    const expectation = {
        identifiers: [{ value: '700', queryKeys: ['ID', 'precId'] }],
        requireIdentifier: true,
    } as const;
    const valid = sanitizeOfficialLawLink(
        'https://www.law.go.kr/DRF/lawService.do?OC=secret&target=prec&ID=700',
        expectation,
    );
    assert.equal(valid.includes('OC='), false);

    assert.throws(
        () => sanitizeOfficialLawLink(
            'https://www.law.go.kr/DRF/lawService.do?target=prec&ID=701',
            expectation,
        ),
        (error: unknown) => error instanceof LegalOpenApiError && error.code === 'SOURCE_MISMATCH',
    );
    assert.throws(
        () => sanitizeOfficialLawLink('https://www.law.go.kr/판례/조합설립인가', expectation),
        (error: unknown) => error instanceof LegalOpenApiError && error.code === 'SOURCE_MISMATCH',
    );
});

test('임의 하위 도메인·유사 도메인·userinfo·비표준 포트·비HTTP scheme을 거부한다', () => {
    const invalidLinks = [
        'https://evil.law.go.kr/path',
        'https://law.go.kr.evil.example/path',
        'https://user:password@law.go.kr/path',
        'https://law.go.kr:8443/path',
        'file:///etc/passwd',
    ];

    for (const value of invalidLinks) {
        assert.throws(
            () => sanitizeOfficialLawLink(value),
            (error: unknown) => error instanceof LegalOpenApiError && error.code === 'SOURCE_MISMATCH',
        );
        assert.equal(isOfficialLawLink(value), false);
    }
});

test('이미 정규화된 공식 HTTPS 링크만 official predicate를 통과한다', () => {
    assert.equal(isOfficialLawLink('https://www.law.go.kr/법령/도시정비법'), true);
    assert.equal(isOfficialLawLink('http://www.law.go.kr/법령/도시정비법'), false);
    assert.equal(isOfficialLawLink('https://www.law.go.kr/path?OC=secret'), false);
});
