// ============================================================
// 알림톡 발송 관련 타입
// ============================================================

/**
 * 알림톡 수신자 정보
 */
export interface AlimtalkRecipient {
    phoneNumber: string;
    name: string;
    variables?: Record<string, string>;
    failoverSubject?: string; // 대체 발송 제목 (LMS용)
    failoverMessage?: string; // 대체 발송 내용 (LMS용)
    content?: string; // 템플릿 메시지 내용 (변수 포함)
    buttons?: AlimtalkButton[]; // 버튼 정보
    emtitle?: string; // 강조표기형 알림톡 서브타이틀
}

/**
 * 알림톡 버튼 정보
 */
export interface AlimtalkButton {
    name: string;
    linkType: string; // WL: 웹링크, AL: 앱링크, DS: 배송조회, BK: 봇키워드, MD: 메시지전달
    linkTypeName: string; // 웹링크, 앱링크, 배송조회, 봇키워드, 메시지전달
    linkMo: string; // 모바일 웹 링크
    linkPc?: string; // PC 웹 링크
}

/**
 * 알리고 API 수신자 타입 (배치 처리용)
 */
export interface Recipient {
    phoneNumber: string;
    name?: string;
    variables?: Record<string, string>;
    failoverSubject?: string; // 대체 발송 제목 (LMS용)
    failoverMessage?: string; // 대체 발송 내용 (LMS용)
    content?: string; // 템플릿 메시지 내용 (변수 포함)
    buttons?: AlimtalkButton[]; // 버튼 정보
    emtitle?: string; // 강조표기형 알림톡 서브타이틀
}

/**
 * 알림톡 발송 요청 파라미터
 */
export interface SendAlimtalkRequest {
    unionId: string;
    senderId: string;
    templateCode: string;
    templateName: string;
    title: string;
    content?: string;
    noticeId?: number;
    recipients: AlimtalkRecipient[];
}

/**
 * 알림톡 발송 결과
 */
export interface SendAlimtalkResult {
    logId: string;
    totalCount: number;
    kakaoSuccessCount: number;
    smsSuccessCount: number;
    failCount: number;
    estimatedCost: number;
    channelName: string;
}

/**
 * 알림톡 로그 입력
 */
export interface AlimtalkLogInput {
    union_id: string;
    sender_id: string;
    template_code: string;
    template_name: string;
    title: string;
    content?: string;
    notice_id?: number;
    sender_channel_name: string;
    total_count: number;
    kakao_success_count: number;
    sms_success_count: number;
    fail_count: number;
    estimated_cost: number;
    recipient_details: AlimtalkRecipient[];
    aligo_response: unknown;
}

/**
 * 알림톡 템플릿 정보
 */
export interface AlimtalkTemplate {
    id?: string;
    template_code: string;
    template_name: string;
    template_content?: string;
    status?: string;
    insp_status?: string;
    buttons?: unknown;
    synced_at?: string;
}

/**
 * 단가 정보
 */
export interface PricingInfo {
    message_type: string;
    unit_price: number;
}

export interface PricingMap {
    KAKAO: number;
    SMS: number;
    LMS: number;
}

/**
 * API 응답 기본 형식
 */
export interface ApiResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
    code?: string;
}

/**
 * 템플릿 동기화 결과
 */
export interface TemplateSyncResult {
    totalFromAligo: number;
    inserted: number;
    updated: number;
    deleted: number;
    syncedAt: string;
}
