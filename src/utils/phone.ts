/**
 * 전화번호 포맷팅 유틸리티
 */

/**
 * 전화번호에서 하이픈 등 특수문자 제거
 * @param phoneNumber 원본 전화번호
 * @returns 숫자만 포함된 전화번호
 */
export function formatPhoneNumber(phoneNumber: string): string {
    // 숫자만 추출
    const cleaned = phoneNumber.replace(/\D/g, '');
    
    // 국가코드 제거 (한국)
    if (cleaned.startsWith('82')) {
        return '0' + cleaned.substring(2);
    }
    
    return cleaned;
}

/**
 * 전화번호 유효성 검사
 * @param phoneNumber 검사할 전화번호
 * @returns 유효 여부
 */
export function isValidPhoneNumber(phoneNumber: string): boolean {
    const cleaned = formatPhoneNumber(phoneNumber);
    
    // 한국 휴대폰 번호 형식 검사 (010, 011, 016, 017, 018, 019)
    const mobilePattern = /^01[016789]\d{7,8}$/;
    
    return mobilePattern.test(cleaned);
}

