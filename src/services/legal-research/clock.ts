export const LEGAL_RESEARCH_TIMEZONE = 'Asia/Seoul' as const;

/** 법령 시행 여부의 기준일은 API 서버 수신 시점의 한국 날짜로 고정한다. */
export function toKoreanDate(now: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: LEGAL_RESEARCH_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(now);
}

export interface LegalResearchClock {
    now(): Date;
}

export const systemLegalResearchClock: LegalResearchClock = {
    now: () => new Date(),
};
