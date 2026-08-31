import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    LEGAL_RESEARCH_TIMEZONE,
    toKoreanDate,
} from '../src/services/legal-research/clock';

describe('법률 조사 기준일', () => {
    it('UTC 날짜가 아니라 Asia/Seoul 날짜를 사용한다', () => {
        const nearKoreanMidnight = new Date('2026-08-31T15:30:00.000Z');

        assert.equal(LEGAL_RESEARCH_TIMEZONE, 'Asia/Seoul');
        assert.equal(toKoreanDate(nearKoreanMidnight), '2026-09-01');
    });
});
