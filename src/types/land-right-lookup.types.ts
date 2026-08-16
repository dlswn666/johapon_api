/**
 * 대지권 공식자료 단건 조회의 transient 응답 계약.
 *
 * 조회 결과는 HTTP 응답 메모리에서만 사용하며 DB에 저장하지 않는다. provider 원문 전체를
 * 전달하지 않고 관리자 확인에 필요한 공개 필드만 명시적으로 투영한다.
 */

export type LandRightLookupStatus =
    | 'SUCCESS'
    | 'NO_DATA'
    | 'FAILED'
    | 'INCOMPLETE';

export type LandRightParcelRole = 'BASE' | 'ATTACHED' | 'UNKNOWN';

export interface LandRightLookupPropertyUnit {
    id: string;
    pnu: string | null;
    address: string | null;
    dong: string | null;
    ho: string | null;
}

export interface LandRightLookupParcel {
    pnu: string;
    role: LandRightParcelRole;
    address: string | null;
    /** 요청 응답 안에서만 유효한 익명 relation group. 관리번호 원문은 노출하지 않는다. */
    scopeGroup: string | null;
}

/** V-World 대지권등록부 공개 필드 allowlist. */
export interface LandRightLdaregRecord {
    pnu: string | null;
    agbldgSn: string | null;
    buldNm: string | null;
    buldDongNm: string | null;
    buldFloorNm: string | null;
    buldHoNm: string | null;
    buldRoomNm: string | null;
    ldaQotaRate: string | null;
    clsSeCode: string | null;
    clsSeCodeNm: string | null;
    relateLdEmdLiCode: string | null;
    lastUpdtDt: string | null;
}

/** V-World 토지대장 공개 필드 allowlist. 소유자 식별정보는 포함하지 않는다. */
export interface LandRightLadfrlRecord {
    pnu: string | null;
    ldCode: string | null;
    ldCodeNm: string | null;
    mnnmSlno: string | null;
    regstrSeCode: string | null;
    regstrSeCodeNm: string | null;
    lndcgrCode: string | null;
    lndcgrCodeNm: string | null;
    lndpclAr: string | null;
    posesnSeCode: string | null;
    posesnSeCodeNm: string | null;
    cnrsPsnCo: string | null;
    ladFrtlSc: string | null;
    ladFrtlScNm: string | null;
    lastUpdtDt: string | null;
}

export interface LandRightLookupSourceScan {
    pnu: string;
    status: LandRightLookupStatus;
    /** provider body/message를 포함하지 않는 서버 고정 코드만 허용한다. */
    code?: string;
}

export interface LandRightLookupSourceSummary {
    status: LandRightLookupStatus;
    scans: LandRightLookupSourceScan[];
}

export interface LandRightLookupData {
    status: LandRightLookupStatus;
    /** terminal 실패/불완전의 대표 서버 고정 코드. */
    code?: string;
    propertyUnit: LandRightLookupPropertyUnit;
    parcels: LandRightLookupParcel[];
    ldareg: LandRightLdaregRecord[];
    ladfrl: LandRightLadfrlRecord[];
    sources: {
        ldareg: LandRightLookupSourceSummary;
        ladfrl: LandRightLookupSourceSummary;
    };
    /** 화면 표시용 고정 구조 코드. 보류 사유로 영속화하지 않는다. */
    warnings: string[];
}

export interface LandRightLookupSuccessResponse {
    success: true;
    data: LandRightLookupData;
}
