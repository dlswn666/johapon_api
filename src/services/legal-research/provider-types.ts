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
