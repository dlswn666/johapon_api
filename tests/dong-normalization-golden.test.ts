import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDong, normalizeHo } from '../src/utils/dong-ho';

/**
 * 동 정규화 golden 벡터 — 재건축 P2 SSOT (api 측 사본)
 *
 * 정본은 tonghari-web 의 normalizeDong 이다. 아래 벡터는 web 의
 * tests/unit/shared/dongNormalizationGolden.test.ts 와 **글자 그대로 같아야** 한다.
 * 한쪽만 고치면 수집(api)과 분할(web/SQL)이 다른 동 집합을 만든다.
 */
const GOLDEN_DONG_VECTORS: Array<[string | null | undefined, string | null]> = [
    // 접미사 제거
    ['101동', '101'],
    ['가동', '가'],
    ['1층', '1'],
    // 접두사 '제' 제거
    ['제1호', '1'],
    // 지하 표기 통일
    ['지하1', 'B1'],
    ['지01', 'B01'],
    ['비01', 'B01'],
    ['B01', 'B01'],
    // 접두 '제' 는 맨 앞에서만 지워진다
    ['주건축물제1동', '주건축물제1'],
    // 현행 함수는 A 와 에이를 합치지 않는다
    ['에이', '에이'],
    ['A', 'A'],
    // 건물명이 dong 컬럼에 들어간 오염 값 (LEGACY_SUSPECT 대상)
    ['영빈유토빌', '영빈유토빌'],
    // 동이 아닌 값 — 운영에서 196개 건물에 걸쳐 있는 '1'
    ['1', '1'],
    // 공백·빈 문자열·null
    ['  가동  ', '가'],
    ['', null],
    [null, null],
    [undefined, null],
];

test('normalizeDong golden 벡터 (web 정본과 동일해야 한다)', () => {
    for (const [input, expected] of GOLDEN_DONG_VECTORS) {
        assert.equal(
            normalizeDong(input),
            expected,
            `normalizeDong(${JSON.stringify(input)}) 기대 ${JSON.stringify(expected)}`,
        );
    }
});

test('같은 동의 표기 변형은 합쳐진다 (분할 대상 판정의 근거)', () => {
    assert.equal(normalizeDong('가'), normalizeDong('가동'));
    assert.equal(normalizeDong('다'), normalizeDong('다동'));
    assert.equal(normalizeDong('1'), normalizeDong('1동'));
});

test('서로 다른 동은 합쳐지지 않는다', () => {
    assert.notEqual(normalizeDong('가'), normalizeDong('나'));
    assert.notEqual(normalizeDong('101'), normalizeDong('102'));
    // A 와 에이는 사람 눈에 같아 보여도 현행 함수는 합치지 않는다
    assert.notEqual(normalizeDong('A'), normalizeDong('에이'));
});

test('normalizeHo 는 호 접미사와 지하 표기를 처리한다', () => {
    assert.equal(normalizeHo('1001호'), '1001');
    assert.equal(normalizeHo('비01'), 'B01');
    assert.equal(normalizeHo('지하101'), 'B101');
    assert.equal(normalizeHo('B101'), 'B101');
    assert.equal(normalizeHo('101'), '101');
    assert.equal(normalizeHo(null), null);
});
