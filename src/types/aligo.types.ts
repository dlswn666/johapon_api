// ============================================================
// 알리고 API 관련 타입
// ============================================================

/**
 * 알리고 API 기본 응답
 */
export interface AligoBaseResponse {
    code: number;
    message: string;
}

/**
 * 알리고 알림톡 발송 응답
 */
export interface AligoSendResponse extends AligoBaseResponse {
    info?: {
        type: string;
        mid: number;
        current: string;
        unit: number;
        total: number;
        scnt: number;
        fcnt: number;
    };
}

/**
 * 알리고 알림톡 발송 상세 결과 (각 수신자별)
 */
export interface AligoSendDetailResult {
    code: number;
    message: string;
    msgid?: string;
    type?: 'AT' | 'FT' | 'SM' | 'LM';  // AT: 알림톡, FT: 친구톡, SM: SMS, LM: LMS
}

/**
 * 알리고 템플릿 정보
 */
export interface AligoTemplate {
    templtCode: string;
    templtName: string;
    templtContent: string;
    templateType: string;
    templateEmphasizeType: string;
    status: string;       // A: 정상, R: 대기, S: 중단
    inspStatus: string;   // REG: 등록, REQ: 심사요청, APR: 승인, REJ: 반려
    buttons?: AligoTemplateButton[];
    cdate: string;
}

/**
 * 알리고 템플릿 버튼
 */
export interface AligoTemplateButton {
    ordering: number;
    name: string;
    linkType: string;
    linkTypeName: string;
    linkMo?: string;
    linkPc?: string;
    linkAnd?: string;
    linkIos?: string;
}

/**
 * 알리고 템플릿 목록 조회 응답
 */
export interface AligoTemplateListResponse extends AligoBaseResponse {
    list?: AligoTemplate[];
}

/**
 * 알리고 API 호출용 발송 파라미터
 */
export interface AligoSendParams {
    apikey: string;
    userid: string;
    senderkey: string;
    tpl_code: string;
    sender: string;
    // 수신자 정보 (최대 500건)
    // receiver_1, receiver_2, ... receiver_500
    // subject_1, subject_2, ... subject_500
    // message_1, message_2, ... message_500
    // button_1, button_2, ... button_500
    // failover (대체발송 여부): Y/N
    // fsubject_1, fsubject_2, ... (대체발송 제목)
    // fmessage_1, fmessage_2, ... (대체발송 내용)
    [key: string]: string;
}

/**
 * Sender Key 조회 결과
 */
export interface SenderKeyInfo {
    senderKey: string;
    channelName: string;
    isDefault: boolean;
}

