export interface ProviderSearchPage<T> {
    totalCount: number;
    page: number;
    items: T[];
}

export interface CurrentLawSummary {
    mst: string;
    lawId: string;
    name: string;
    shortName?: string;
    lawType?: string;
    ministry?: string;
    promulgationDate?: string;
    promulgationNo?: string;
    effectiveDate?: string;
    revisionType?: string;
    currentHistoryCode?: string;
    officialUrl?: string;
}

/**
 * 법제처 시행일 기준 법령 목록이 반환하는 상태값입니다.
 * 현행 법령만 다루는 CurrentLawSummary와 달리 연혁/시행예정을 버리지 않습니다.
 */
export type LawVersionHistoryCode = '현행' | '연혁' | '시행예정';

export interface LawVersionSummary {
    mst: string;
    lawId: string;
    name: string;
    shortName?: string;
    lawType?: string;
    ministry?: string;
    promulgationDate: string;
    promulgationNo: string;
    effectiveDate: string;
    revisionType?: string;
    currentHistoryCode: LawVersionHistoryCode;
    officialUrl?: string;
}

export interface LawArticleHistoryEntry {
    mst: string;
    lawId: string;
    lawName: string;
    articleNumber: string;
    promulgationDate: string;
    promulgationNo: string;
    effectiveDate: string;
    revisionType?: string;
    lawType?: string;
    ministry?: string;
    changeReason: string;
    changeDate: string;
    officialUrl?: string;
}

export interface LawSubItem {
    number: string;
    content: string;
}

export interface LawItem {
    number: string;
    content: string;
    subItems: LawSubItem[];
}

export interface LawParagraph {
    number: string;
    content: string;
    items: LawItem[];
}

export interface LawArticle {
    articleNumber: string;
    branchNumber?: string;
    title?: string;
    content: string;
    effectiveDate?: string;
    isArticle: boolean;
    paragraphs: LawParagraph[];
}

export interface LawAddendum {
    promulgationDate?: string;
    promulgationNo?: string;
    content: string;
}

export interface LawAppendix {
    number: string;
    branchNumber?: string;
    kind?: string;
    title?: string;
    content?: string;
    fileName?: string;
    fileUrl?: string;
    pdfUrl?: string;
    effectiveDate?: string;
}

export interface CurrentLawDetail {
    mst?: string;
    lawId?: string;
    name?: string;
    nameHanja?: string;
    lawType?: string;
    ministry?: string;
    promulgationDate?: string;
    promulgationNo?: string;
    effectiveDate?: string;
    revisionType?: string;
    articles: LawArticle[];
    addenda: LawAddendum[];
    appendices: LawAppendix[];
}

export interface LawProvisionSnapshot {
    /** 시행일 기준 목록에서 선택한 법령일련번호입니다. */
    mst: string;
    lawId: string;
    effectiveDate: string;
    currentHistoryCode: LawVersionHistoryCode;
    /** 법제처 JO 요청에 사용한 6자리 조번호입니다. */
    articleNumber: string;
    detail: CurrentLawDetail;
}

export interface CurrentOrdinanceSummary {
    mst: string;
    ordinanceId: string;
    name: string;
    authorityName?: string;
    ordinanceType?: string;
    promulgationDate?: string;
    promulgationNo?: string;
    effectiveDate?: string;
    revisionType?: string;
    officialUrl?: string;
}

export interface CurrentOrdinanceDetail {
    mst?: string;
    ordinanceId?: string;
    name?: string;
    authorityName?: string;
    ordinanceType?: string;
    promulgationDate?: string;
    promulgationNo?: string;
    effectiveDate?: string;
    revisionType?: string;
    articles: LawArticle[];
    addenda: LawAddendum[];
    appendices: LawAppendix[];
}

export interface CaseSummary {
    caseSerialId: string;
    caseName: string;
    caseNumber?: string;
    decisionDate?: string;
    courtName?: string;
    courtTypeCode?: string;
    caseTypeName?: string;
    judgmentType?: string;
    decision?: string;
    dataSourceName?: string;
    officialUrl?: string;
}

export interface CaseDetail {
    caseSerialId: string;
    caseName: string;
    caseNumber?: string;
    decisionDate?: string;
    decision?: string;
    courtName?: string;
    courtTypeCode?: string;
    caseTypeName?: string;
    caseTypeCode?: string;
    judgmentType?: string;
    holdings?: string;
    summary?: string;
    referenceProvisions?: string;
    referencedCases?: string;
    fullText?: string;
}

export type LawSearchScope = 1 | 2;

export interface SearchCurrentLawsInput {
    query: string;
    searchScope?: LawSearchScope;
    page?: number;
}

export interface SearchLawVersionsInput {
    /** 법제처 법령ID(LID). 숫자 6자리로 정규화해 요청합니다. */
    lawId: string;
    page?: number;
}

export interface SearchLawArticleHistoryInput {
    /** 법제처 법령ID(ID). 숫자 6자리로 정규화해 요청합니다. */
    lawId: string;
    articleNumber: string;
    page?: number;
}

export interface GetLawProvisionSnapshotInput {
    /** searchLawVersions가 반환한 정확한 버전 메타데이터를 그대로 전달합니다. */
    version: LawVersionSummary;
    articleNumber: string;
    paragraphNumber?: string;
    itemNumber?: string;
    subItemNumber?: string;
}

export type CurrentLawDetailInput =
    | { lawId: string; mst?: never; effectiveDate?: never }
    | { mst: string; effectiveDate: string; lawId?: never };

export interface CurrentLawProvisionInput {
    lawId?: string;
    mst?: string;
    effectiveDate?: string;
    articleNumber: string;
    paragraphNumber?: string;
    itemNumber?: string;
    subItemNumber?: string;
}

export interface SearchCurrentOrdinancesInput {
    query: string;
    org: string;
    sborg?: string;
    searchScope?: LawSearchScope;
    page?: number;
}

export type CurrentOrdinanceDetailInput =
    | { ordinanceId: string; mst?: never }
    | { mst: string; ordinanceId?: never };

export interface SearchCasesInput {
    query?: string;
    referenceLawName?: string;
    searchScope?: LawSearchScope;
    courtTypeCode?: '400201' | '400202';
    courtName?: string;
    page?: number;
}

export interface GetCaseDetailInput {
    caseSerialId: string;
}
