import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LegalResearchInputV1 } from '../src/services/legal-research/research-plan';
import {
    LegalResearchOrchestratorV1,
    type LegalResearchProviderV1,
} from '../src/services/legal-research/research-orchestrator';
import type {
    CaseDetail,
    CaseSummary,
    CurrentLawDetail,
    CurrentLawDetailInput,
    CurrentLawSummary,
    CurrentOrdinanceDetail,
    CurrentOrdinanceSummary,
    ProviderSearchPage,
    SearchCasesInput,
} from '../src/services/legal-research/provider-types';
import { LegalOpenApiError } from '../src/services/legal-research/errors';

const lawSummary: CurrentLawSummary = {
    mst: '123456',
    lawId: '001234',
    name: '도시 및 주거환경정비법',
    lawType: '법률',
    effectiveDate: '20260101',
    currentHistoryCode: '현행',
};

const lawDetail: CurrentLawDetail = {
    mst: lawSummary.mst,
    lawId: lawSummary.lawId,
    name: lawSummary.name,
    lawType: lawSummary.lawType,
    effectiveDate: lawSummary.effectiveDate,
    articles: [
        {
            articleNumber: '35',
            title: '조합설립인가 등',
            content: '제35조 조합을 설립하려면 토지등소유자의 동의를 받아야 한다.',
            isArticle: true,
            paragraphs: [
                {
                    number: '②',
                    content: '재개발사업은 법정 동의율을 갖추어야 한다.',
                    items: [],
                },
            ],
        },
    ],
    addenda: [],
    appendices: [],
};

const ordinanceSummary: CurrentOrdinanceSummary = {
    mst: '654321',
    ordinanceId: 'ORD-SEOUL-1',
    name: '서울특별시 도시 및 주거환경정비 조례',
    authorityName: '서울특별시',
    ordinanceType: '조례',
    effectiveDate: '20250101',
};

const ordinanceDetail: CurrentOrdinanceDetail = {
    ...ordinanceSummary,
    articles: [{
        articleNumber: '10',
        title: '조합설립인가 신청',
        content: '제10조 조합설립인가 신청에 필요한 사항을 정한다.',
        effectiveDate: '20260701',
        isArticle: true,
        paragraphs: [],
    }],
    addenda: [],
    appendices: [],
};

const input: LegalResearchInputV1 = {
    question: '재개발 조합설립 동의 요건은?',
    jurisdiction: { countryCode: 'KR' },
    projectType: 'redevelopment',
    projectStage: 'association_establishment',
    facts: [],
    researchPlan: {
        issues: [
            {
                issueId: 'ISSUE-1',
                issue: '조합설립 동의 요건',
                requestedOutcome: 'vote_threshold',
            },
        ],
        lawAnchors: [
            {
                issueIds: ['ISSUE-1'],
                exactName: lawSummary.name,
                lawType: '법률',
                articleLabels: ['제35조'],
                issueTerms: ['조합설립', '동의'],
            },
        ],
        ordinanceRequirement: 'not_required',
        ordinanceAnchors: [],
        caseQueries: [
            {
                issueIds: ['ISSUE-1'],
                lawNames: [lawSummary.name],
                articleLabels: ['제35조'],
                issueTerms: ['조합설립', '동의'],
            },
        ],
    },
};

function dateToCompact(value: string): string {
    return value.replace(/-/g, '');
}

function makeCase(serial: number, decisionDate: string): CaseSummary {
    return {
        caseSerialId: String(serial),
        caseName: `조합설립인가처분취소 ${serial}`,
        caseNumber: `2026두${serial}`,
        decisionDate: dateToCompact(decisionDate),
        courtName: '대법원',
        officialUrl: `https://www.law.go.kr/precInfoP.do?precSeq=${serial}`,
    };
}

function detailFor(summary: CaseSummary): CaseDetail {
    return {
        caseSerialId: summary.caseSerialId,
        caseName: summary.caseName,
        caseNumber: summary.caseNumber,
        decisionDate: summary.decisionDate,
        courtName: summary.courtName,
        holdings: '도시 및 주거환경정비법 제35조의 조합설립 동의 요건이 문제된 사안',
        summary: '조합설립 동의 요건을 충족하여야 한다는 판결요지',
        referenceProvisions: '도시 및 주거환경정비법 제35조',
        fullText: '조합설립 동의에 관한 판례 전문 내용',
    };
}

interface FakeProviderOptions {
    pageSize?: number;
    detailFactory?: (summary: CaseSummary) => CaseDetail;
    failingDetailIds?: readonly string[];
    failingDetailCode?: ConstructorParameters<typeof LegalOpenApiError>[0];
    failingDetailCodes?: Readonly<Record<string, ConstructorParameters<typeof LegalOpenApiError>[0]>>;
    currentLawSummary?: CurrentLawSummary;
    currentLawDetail?: CurrentLawDetail;
    ordinanceItems?: CurrentOrdinanceSummary[];
    ordinanceDetail?: CurrentOrdinanceDetail;
    reportedCasePage?: (requestedPage: number) => number;
    casePageItems?: (requestedPage: number, defaultItems: CaseSummary[]) => CaseSummary[];
}

class FakeProvider implements LegalResearchProviderV1 {
    readonly caseSearchPages: number[] = [];
    readonly caseDetailIds: string[] = [];
    readonly currentLawDetailRequests: CurrentLawDetailInput[] = [];
    private readonly pageSize: number;
    private readonly detailFactory: (summary: CaseSummary) => CaseDetail;
    private readonly failingDetailIds: Set<string>;
    private readonly failingDetailCode: ConstructorParameters<typeof LegalOpenApiError>[0];
    private readonly failingDetailCodes: Readonly<Record<string, ConstructorParameters<typeof LegalOpenApiError>[0]>>;
    private readonly currentLawSummary: CurrentLawSummary;
    private readonly currentLawDetail: CurrentLawDetail;
    private readonly ordinanceItems: CurrentOrdinanceSummary[] | undefined;
    private readonly currentOrdinanceDetail: CurrentOrdinanceDetail | undefined;
    private readonly reportedCasePage: (requestedPage: number) => number;
    private readonly casePageItems: (requestedPage: number, defaultItems: CaseSummary[]) => CaseSummary[];
    readonly ordinanceSearches: Array<{ query: string; org: string; sborg?: string }> = [];

    constructor(
        private readonly caseItems: CaseSummary[],
        options: FakeProviderOptions = {}
    ) {
        this.pageSize = options.pageSize ?? 100;
        this.detailFactory = options.detailFactory ?? detailFor;
        this.failingDetailIds = new Set(options.failingDetailIds ?? []);
        this.failingDetailCode = options.failingDetailCode ?? 'UPSTREAM_TIMEOUT';
        this.failingDetailCodes = options.failingDetailCodes ?? {};
        this.currentLawSummary = options.currentLawSummary ?? lawSummary;
        this.currentLawDetail = options.currentLawDetail ?? lawDetail;
        this.ordinanceItems = options.ordinanceItems;
        this.currentOrdinanceDetail = options.ordinanceDetail;
        this.reportedCasePage = options.reportedCasePage ?? ((requestedPage) => requestedPage);
        this.casePageItems = options.casePageItems
            ?? ((_requestedPage, defaultItems) => defaultItems);
    }

    async searchCurrentLaws(): Promise<ProviderSearchPage<CurrentLawSummary>> {
        return { totalCount: 1, page: 1, items: [this.currentLawSummary] };
    }

    async getCurrentLawDetail(input: CurrentLawDetailInput): Promise<CurrentLawDetail> {
        this.currentLawDetailRequests.push(input);
        return this.currentLawDetail;
    }

    async searchCurrentOrdinances(search: {
        query: string;
        org: string;
        sborg?: string;
    }): Promise<ProviderSearchPage<CurrentOrdinanceSummary>> {
        if (this.ordinanceItems === undefined) {
            throw new Error('자치법규 검색은 호출되지 않아야 합니다.');
        }
        this.ordinanceSearches.push(search);
        return { totalCount: this.ordinanceItems.length, page: 1, items: this.ordinanceItems };
    }

    async getCurrentOrdinanceDetail(): Promise<CurrentOrdinanceDetail> {
        if (!this.currentOrdinanceDetail) {
            throw new Error('자치법규 상세는 호출되지 않아야 합니다.');
        }
        return this.currentOrdinanceDetail;
    }

    async searchCases(input: SearchCasesInput): Promise<ProviderSearchPage<CaseSummary>> {
        const page = input.page ?? 1;
        const start = (page - 1) * this.pageSize;
        this.caseSearchPages.push(page);
        return {
            totalCount: this.caseItems.length,
            page: this.reportedCasePage(page),
            items: this.casePageItems(
                page,
                this.caseItems.slice(start, start + this.pageSize)
            ),
        };
    }

    async getCaseDetail({ caseSerialId }: { caseSerialId: string }): Promise<CaseDetail> {
        this.caseDetailIds.push(caseSerialId);
        if (this.failingDetailIds.has(caseSerialId)) {
            throw new LegalOpenApiError(
                this.failingDetailCodes[caseSerialId] ?? this.failingDetailCode
            );
        }
        const summary = this.caseItems.find((item) => item.caseSerialId === caseSerialId);
        if (!summary) throw new Error('missing fixture case');
        return this.detailFactory(summary);
    }
}

function buildOrchestrator(caseItems: CaseSummary[], options: FakeProviderOptions = {}) {
    return new LegalResearchOrchestratorV1({
        provider: new FakeProvider(caseItems, options),
        clock: { now: () => new Date('2026-08-31T03:00:00.000Z') },
        packetId: () => 'packet-fixed',
    });
}

function buildOrchestratorWithProvider(provider: LegalResearchProviderV1) {
    return new LegalResearchOrchestratorV1({
        provider,
        clock: { now: () => new Date('2026-08-31T03:00:00.000Z') },
        packetId: () => 'packet-fixed',
    });
}

describe('LegalResearchOrchestratorV1', () => {
    it('필수 조례 검토에 관할이 없으면 추정 검색 없이 clarification_required로 닫는다', async () => {
        const provider = new FakeProvider([makeCase(190, '2026-08-20')]);
        const packet = await buildOrchestratorWithProvider(provider).research({
            ...input,
            jurisdiction: undefined,
            researchPlan: {
                ...input.researchPlan,
                ordinanceRequirement: 'required',
                ordinanceAnchors: [],
            },
        });

        assert.equal(packet.status, 'clarification_required');
        assert.equal(packet.ordinanceSearchAudit.required, true);
        assert.equal(packet.ordinanceSearchAudit.performed, false);
        assert.equal(provider.ordinanceSearches.length, 0);
        assert.ok(packet.unknowns.some((unknown) =>
            unknown.code === 'JURISDICTION_REQUIRED' && unknown.blocking));
    });

    it('필수 관할 조례를 검색했지만 exact 결과가 없으면 빈 배열과 insufficient_evidence로 닫는다', async () => {
        const provider = new FakeProvider([makeCase(191, '2026-08-20')], {
            ordinanceItems: [],
        });
        const packet = await buildOrchestratorWithProvider(provider).research({
            ...input,
            jurisdiction: {
                countryCode: 'KR',
                organizationCode: '6110000',
                organizationName: '서울특별시',
            },
            researchPlan: {
                ...input.researchPlan,
                ordinanceRequirement: 'required',
                ordinanceAnchors: [{
                    issueIds: ['ISSUE-1'],
                    exactName: ordinanceSummary.name,
                    organizationCode: '6110000',
                    organizationName: '서울특별시',
                    articleLabels: ['제10조'],
                    issueTerms: ['조합설립인가'],
                }],
            },
        });

        assert.equal(packet.status, 'insufficient_evidence');
        assert.deepEqual(packet.ordinances, []);
        assert.equal(packet.ordinanceSearchAudit.required, true);
        assert.equal(packet.ordinanceSearchAudit.performed, true);
        assert.equal(provider.ordinanceSearches.length, 1);
        assert.ok(packet.unknowns.some((unknown) =>
            unknown.code === 'ORDINANCE_NOT_FOUND' && unknown.blocking));
    });

    it('조례 조문별 시행일을 보존하고 사건일이 앞서면 현행법 소급 적용을 막는다', async () => {
        const provider = new FakeProvider([makeCase(192, '2026-08-20')], {
            ordinanceItems: [ordinanceSummary],
            ordinanceDetail,
        });
        const packet = await buildOrchestratorWithProvider(provider).research({
            ...input,
            eventDate: '2026-06-30',
            jurisdiction: {
                countryCode: 'KR',
                organizationCode: '6110000',
                organizationName: '서울특별시',
            },
            researchPlan: {
                ...input.researchPlan,
                ordinanceRequirement: 'required',
                ordinanceAnchors: [{
                    issueIds: ['ISSUE-1'],
                    exactName: ordinanceSummary.name,
                    organizationCode: '6110000',
                    organizationName: '서울특별시',
                    articleLabels: ['제10조'],
                    issueTerms: ['조합설립인가'],
                }],
            },
        });

        assert.equal(packet.ordinances[0].articleEffectiveFrom, '2026-07-01');
        assert.equal(packet.status, 'temporal_scope_conflict');
        assert.ok(packet.unknowns.some((unknown) =>
            unknown.code === 'HISTORICAL_LAW_REQUIRED' && unknown.blocking));
    });

    it('미래 사건일에는 현재 시행본이 유지된다고 가정하지 않고 시간 범위 충돌로 닫는다', async () => {
        const packet = await buildOrchestrator([
            makeCase(194, '2026-08-20'),
        ]).research({
            ...input,
            eventDate: '2030-01-01',
        });

        assert.equal(packet.scope.asOfDate, '2026-08-31');
        assert.equal(packet.status, 'temporal_scope_conflict');
        assert.ok(packet.unknowns.some((unknown) =>
            unknown.code === 'FUTURE_EVENT_DATE' && unknown.blocking));
    });

    it('자치법규의 관련 부칙·별표도 자동 해석하지 않고 별도 검토로 닫는다', async () => {
        const provider = new FakeProvider([makeCase(193, '2026-08-20')], {
            ordinanceItems: [ordinanceSummary],
            ordinanceDetail: {
                ...ordinanceDetail,
                addenda: [{ content: '제10조는 조합설립인가 신청일부터 적용한다.' }],
                appendices: [{ number: '1', title: '조합설립인가 신청서' }],
            },
        });
        const packet = await buildOrchestratorWithProvider(provider).research({
            ...input,
            jurisdiction: {
                countryCode: 'KR',
                organizationCode: '6110000',
                organizationName: '서울특별시',
            },
            researchPlan: {
                ...input.researchPlan,
                ordinanceRequirement: 'required',
                ordinanceAnchors: [{
                    issueIds: ['ISSUE-1'],
                    exactName: ordinanceSummary.name,
                    organizationCode: '6110000',
                    organizationName: '서울특별시',
                    articleLabels: ['제10조'],
                    issueTerms: ['조합설립인가'],
                }],
            },
        });

        assert.equal(packet.status, 'insufficient_evidence');
        assert.equal(packet.ordinances[0].supplementalMaterialAudit.matchedAddendaCount, 1);
        assert.equal(packet.ordinances[0].supplementalMaterialAudit.matchedAppendixCount, 1);
        assert.ok(packet.unknowns.some((unknown) =>
            unknown.code === 'SUPPLEMENTAL_MATERIAL_REVIEW_REQUIRED'
            && unknown.blocking));
    });

    it('전문 관련성 gate 뒤 최신 판례 12건만 반환한다', async () => {
        const caseItems = Array.from({ length: 12 }, (_, index) =>
            makeCase(200 + index, `2026-08-${String(20 - index).padStart(2, '0')}`));

        const packet = await buildOrchestrator(caseItems).research(input);

        assert.equal(packet.status, 'complete');
        assert.equal(packet.laws.length, 1);
        assert.equal(packet.cases.length, 12);
        assert.equal(packet.caseSearchAudit.requestedMax, 12);
        assert.equal(packet.caseSearchAudit.listSort, 'ddes');
        assert.equal(packet.caseSearchAudit.shortfallReason, null);
        assert.ok(packet.cases.every((legalCase) =>
            legalCase.currentLawFit === 'current_rule_candidate'
            && legalCase.relevance.grade === 'analogical'
            && legalCase.useInConclusion === 'analogical_support'));
        assert.deepEqual(
            packet.cases.map((item) => item.decisionDate),
            [...packet.cases.map((item) => item.decisionDate)].sort().reverse()
        );
    });

    it('현행 상세는 응답에 공통으로 존재하는 법령ID로 조회하고 MST는 출처에 보존한다', async () => {
        const provider = new FakeProvider([makeCase(212, '2026-08-20')], {
            currentLawDetail: {
                ...lawDetail,
                mst: undefined,
            },
        });

        const packet = await buildOrchestratorWithProvider(provider).research(input);

        assert.deepEqual(provider.currentLawDetailRequests, [{ lawId: lawSummary.lawId }]);
        assert.equal(packet.laws[0].lawId, lawSummary.lawId);
        assert.equal(packet.laws[0].mst, lawSummary.mst);
    });

    it('현행법령 목록의 currentHistoryCode가 연혁이면 SCHEMA_DRIFT로 fail-closed 한다', async () => {
        await assert.rejects(
            () => buildOrchestrator([makeCase(214, '2026-08-20')], {
                currentLawSummary: {
                    ...lawSummary,
                    currentHistoryCode: '연혁',
                },
            }).research(input),
            (error: unknown) => error instanceof LegalOpenApiError
                && error.code === 'SCHEMA_DRIFT'
        );
    });

    it('법령ID 조회 결과의 시행일이 검색 버전과 다르면 SOURCE_MISMATCH로 닫는다', async () => {
        const provider = new FakeProvider([makeCase(213, '2026-08-20')], {
            currentLawDetail: {
                ...lawDetail,
                mst: undefined,
                effectiveDate: '20250101',
            },
        });

        await assert.rejects(
            () => buildOrchestratorWithProvider(provider).research(input),
            (error: unknown) => error instanceof LegalOpenApiError
                && error.code === 'SOURCE_MISMATCH'
        );
    });

    it('현행 규정 시행 전 판례로 12건을 채우지 않는다', async () => {
        const currentCases = Array.from({ length: 7 }, (_, index) =>
            makeCase(300 + index, `2026-08-${String(20 - index).padStart(2, '0')}`));
        const oldCases = [
            makeCase(100, '2025-12-30'),
            makeCase(101, '2025-11-20'),
        ];

        const packet = await buildOrchestrator([...currentCases, ...oldCases]).research(input);

        assert.equal(packet.status, 'complete');
        assert.equal(packet.cases.length, 7);
        assert.equal(packet.caseSearchAudit.returnedCount, 7);
        assert.equal(packet.caseSearchAudit.shortfallReason, 'current_law_misaligned');
        assert.equal(packet.caseSearchAudit.exclusions.currentLawMisaligned, 2);
    });

    it('조회 기준일 뒤의 선고일을 제공한 판례 목록은 SCHEMA_DRIFT로 fail-closed 한다', async () => {
        await assert.rejects(
            () => buildOrchestrator([
                makeCase(399, '2030-01-01'),
            ]).research(input),
            (error: unknown) => error instanceof LegalOpenApiError
                && error.code === 'SCHEMA_DRIFT'
        );
    });

    it('판례 목록보다 상세의 선고일이 미래로 바뀌어도 SCHEMA_DRIFT로 fail-closed 한다', async () => {
        const summary = makeCase(398, '2026-08-20');
        await assert.rejects(
            () => buildOrchestrator([summary], {
                detailFactory(value) {
                    return {
                        ...detailFor(value),
                        decisionDate: '20300101',
                    };
                },
            }).research(input),
            (error: unknown) => error instanceof LegalOpenApiError
                && error.code === 'SCHEMA_DRIFT'
        );
    });

    it('법령명·조문은 NFKC와 공백만 정규화하고 시행령·가지조문·구법을 exact로 거부한다', async () => {
        const caseItems = [
            makeCase(509, '2026-08-26'),
            makeCase(508, '2026-08-25'),
            makeCase(507, '2026-08-24'),
            makeCase(506, '2026-08-23'),
            makeCase(505, '2026-08-22'),
            makeCase(504, '2026-08-21'),
            makeCase(503, '2026-08-20'),
            makeCase(502, '2026-08-19'),
            makeCase(501, '2026-08-18'),
            makeCase(500, '2026-08-17'),
        ];
        const packet = await buildOrchestrator(caseItems, {
            detailFactory(summary) {
                const detail = detailFor(summary);
                if (summary.caseSerialId === '509') {
                    return {
                        ...detail,
                        referenceProvisions: '구법인 「도시 및 주거환경정비법」 제35조',
                    };
                }
                if (summary.caseSerialId === '508') {
                    return {
                        ...detail,
                        referenceProvisions: '종전의 「도시 및 주거환경정비법」 제35조',
                    };
                }
                if (summary.caseSerialId === '507') {
                    return {
                        ...detail,
                        referenceProvisions: '개정되기 이전의 「도시 및 주거환경정비법」 제35조',
                    };
                }
                if (summary.caseSerialId === '506') {
                    return {
                        ...detail,
                        referenceProvisions: '2018년 개정 이전의 「도시 및 주거환경정비법」 제35조',
                    };
                }
                if (summary.caseSerialId === '505') {
                    return {
                        ...detail,
                        referenceProvisions: '개정 전의 「도시 및 주거환경정비법」 제35조',
                    };
                }
                if (summary.caseSerialId === '504') {
                    return {
                        ...detail,
                        referenceProvisions: '(구) 도시 및 주거환경정비법 제35조',
                    };
                }
                if (summary.caseSerialId === '503') {
                    return {
                        ...detail,
                        referenceProvisions: '「도시   및 주거환경정비법」 제 ３５ 조',
                    };
                }
                if (summary.caseSerialId === '502') {
                    return {
                        ...detail,
                        referenceProvisions: '도시 및 주거환경정비법 시행령 제35조',
                    };
                }
                if (summary.caseSerialId === '501') {
                    return {
                        ...detail,
                        referenceProvisions: '도시 및 주거환경정비법 제35조의2',
                    };
                }
                return {
                    ...detail,
                    referenceProvisions: '구 「도시 및 주거환경정비법」 제35조',
                };
            },
        }).research(input);

        assert.deepEqual(packet.cases.map((legalCase) => legalCase.caseSerialId), ['503']);
        assert.equal(packet.caseSearchAudit.exclusions.irrelevant, 9);
        assert.match(packet.cases[0].relevance.reason, /버전 ID/);
        assert.equal(packet.cases[0].currentLawFit, 'current_rule_candidate');
        assert.equal(packet.cases[0].relevance.grade, 'analogical');
        assert.equal(packet.cases[0].useInConclusion, 'analogical_support');
        assert.deepEqual(packet.cases[0].relevance.matchedProvisions, [
            '도시 및 주거환경정비법 제35조',
        ]);
    });

    it('현행 법령 목록·본문과 조문 번호도 NFKC·공백 정규화 exact 일치를 허용한다', async () => {
        const normalizedSummary: CurrentLawSummary = {
            ...lawSummary,
            name: '도시   및 주거환경정비법',
        };
        const normalizedDetail: CurrentLawDetail = {
            ...lawDetail,
            name: '도시\n및 주거환경정비법',
            articles: lawDetail.articles.map((article) => ({
                ...article,
                articleNumber: '３５',
            })),
        };
        const packet = await buildOrchestrator([makeCase(600, '2026-08-20')], {
            currentLawSummary: normalizedSummary,
            currentLawDetail: normalizedDetail,
        }).research(input);

        assert.equal(packet.laws.length, 1);
        assert.equal(packet.laws[0].provision.article, '제35조');
        assert.equal(packet.cases.length, 1);
    });

    it('같은 exact 법령명의 여러 anchor를 모두 합쳐 판례 참조조문과 대조한다', async () => {
        const electronicVoteArticle: CurrentLawDetail['articles'][number] = {
            articleNumber: '45',
            title: '총회의 의결',
            content: '제45조 총회의 전자투표와 의결 방법을 정한다.',
            isArticle: true,
            paragraphs: [],
        };
        const summary = makeCase(605, '2026-08-20');
        const packet = await buildOrchestrator([summary], {
            currentLawDetail: {
                ...lawDetail,
                articles: [...lawDetail.articles, electronicVoteArticle],
            },
            detailFactory(value) {
                return {
                    ...detailFor(value),
                    holdings: '총회 전자투표의 의결 방법이 문제된 사안',
                    summary: '전자투표 절차를 준수하여야 한다는 판결요지',
                    referenceProvisions: '도시 및 주거환경정비법 제45조',
                    fullText: '총회 전자투표 절차에 관한 판례 전문 내용',
                };
            },
        }).research({
            ...input,
            question: '조합설립과 조합 총회 전자투표 의결 방법은?',
            researchPlan: {
                ...input.researchPlan,
                issues: [
                    ...input.researchPlan.issues,
                    {
                        issueId: 'ISSUE-2',
                        issue: '총회 전자투표 의결 방법',
                        requestedOutcome: 'procedure',
                    },
                ],
                lawAnchors: [
                    input.researchPlan.lawAnchors[0],
                    {
                        issueIds: ['ISSUE-2'],
                        exactName: lawSummary.name,
                        lawType: '법률',
                        articleLabels: ['제45조'],
                        issueTerms: ['전자투표'],
                    },
                ],
                caseQueries: [
                    input.researchPlan.caseQueries[0],
                    {
                        issueIds: ['ISSUE-2'],
                        lawNames: [lawSummary.name],
                        articleLabels: ['제45조'],
                        issueTerms: ['전자투표'],
                    },
                ],
            },
        });

        assert.equal(packet.laws.length, 2);
        assert.deepEqual(packet.cases.map((legalCase) => legalCase.caseSerialId), ['605']);
        assert.deepEqual(packet.cases[0].relevance.matchedProvisions, [
            '도시 및 주거환경정비법 제45조',
        ]);
        assert.deepEqual(packet.cases[0].relevance.matchedIssues, ['ISSUE-2']);
    });

    it('판례 query는 같은 issueId의 resolved law anchor만 근거로 사용한다', async () => {
        const electronicVoteArticle: CurrentLawDetail['articles'][number] = {
            articleNumber: '45',
            title: '총회의 의결',
            content: '제45조 총회의 전자투표와 의결 방법을 정한다.',
            isArticle: true,
            paragraphs: [],
        };
        const summary = makeCase(606, '2026-08-20');
        const packet = await buildOrchestrator([summary], {
            currentLawDetail: {
                ...lawDetail,
                articles: [...lawDetail.articles, electronicVoteArticle],
            },
            detailFactory(value) {
                return {
                    ...detailFor(value),
                    holdings: '조합설립 절차가 문제된 사안',
                    summary: '조합설립 절차에 관한 판결요지',
                    referenceProvisions: '도시 및 주거환경정비법 제45조',
                    fullText: '조합설립 절차에 관한 판례 전문 내용',
                };
            },
        }).research({
            ...input,
            question: '조합설립과 총회 전자투표 절차는?',
            researchPlan: {
                ...input.researchPlan,
                issues: [
                    ...input.researchPlan.issues,
                    {
                        issueId: 'ISSUE-2',
                        issue: '총회 전자투표 절차',
                        requestedOutcome: 'procedure',
                    },
                ],
                lawAnchors: [
                    input.researchPlan.lawAnchors[0],
                    {
                        issueIds: ['ISSUE-2'],
                        exactName: lawSummary.name,
                        lawType: '법률',
                        articleLabels: ['제45조'],
                        issueTerms: ['전자투표'],
                    },
                ],
                caseQueries: [
                    {
                        ...input.researchPlan.caseQueries[0],
                        articleLabels: [],
                    },
                    {
                        issueIds: ['ISSUE-2'],
                        lawNames: [lawSummary.name],
                        articleLabels: ['제45조'],
                        issueTerms: ['전자투표'],
                    },
                ],
            },
        });

        assert.equal(packet.laws.length, 2);
        assert.deepEqual(packet.cases, []);
        assert.equal(packet.caseSearchAudit.exclusions.irrelevant, 1);
    });

    it('법령 identity는 일치하지만 지정 조문이 없으면 tool 오류가 아닌 근거 부족 패킷으로 닫는다', async () => {
        const provider = new FakeProvider([makeCase(601, '2026-08-20')], {
            currentLawDetail: {
                ...lawDetail,
                articles: [],
            },
        });
        const packet = await buildOrchestratorWithProvider(provider).research(input);

        assert.equal(packet.status, 'insufficient_evidence');
        assert.equal(packet.lawSearchAudit.exactLawNameMatched, true);
        assert.equal(packet.lawSearchAudit.exactLawTypeMatched, true);
        assert.deepEqual(packet.laws, []);
        assert.equal(provider.caseSearchPages.length, 0);
        assert.equal(provider.caseDetailIds.length, 0);
        assert.ok(packet.unknowns.some((unknown) =>
            unknown.code === 'LAW_PROVISION_NOT_FOUND' && unknown.blocking));
    });

    it('exact 조문 번호만 맞고 쟁점어가 없는 무관 조문은 근거로 신뢰하지 않는다', async () => {
        const packet = await buildOrchestrator([makeCase(602, '2026-08-20')], {
            currentLawDetail: {
                ...lawDetail,
                articles: [{
                    articleNumber: '1',
                    title: '목적',
                    content: '제1조 이 법은 도시환경을 개선함을 목적으로 한다.',
                    isArticle: true,
                    paragraphs: [],
                }],
            },
        }).research({
            ...input,
            researchPlan: {
                ...input.researchPlan,
                lawAnchors: [{
                    ...input.researchPlan.lawAnchors[0],
                    articleLabels: ['제1조'],
                }],
                caseQueries: [{
                    ...input.researchPlan.caseQueries[0],
                    articleLabels: ['제1조'],
                }],
            },
        });

        assert.equal(packet.status, 'insufficient_evidence');
        assert.deepEqual(packet.laws, []);
        assert.ok(packet.unknowns.some((unknown) =>
            unknown.code === 'LAW_PROVISION_NOT_FOUND'));
    });

    it('관련 부칙·별표는 키워드 선별 사실만 감사하고 자동 해석으로 과대 주장하지 않는다', async () => {
        const packet = await buildOrchestrator([makeCase(650, '2026-08-20')], {
            currentLawDetail: {
                ...lawDetail,
                addenda: [{
                    promulgationDate: '20260101',
                    promulgationNo: '12345',
                    content: '제35조의 개정규정은 조합설립 동의일부터 적용한다.',
                }],
                appendices: [{
                    number: '1',
                    title: '조합설립 동의서',
                    content: '동의서 서식',
                }],
            },
        }).research(input);

        assert.equal(packet.status, 'insufficient_evidence');
        assert.deepEqual(packet.laws[0].supplementalMaterialAudit, {
            parsedAddendaCount: 1,
            parsedAppendixCount: 1,
            matchedAddendaCount: 1,
            matchedAppendixCount: 1,
            matchedTextHash: packet.laws[0].supplementalMaterialAudit.matchedTextHash,
            interpretationStatus: 'keyword_screened_not_legally_interpreted',
        });
        assert.match(
            packet.laws[0].supplementalMaterialAudit.matchedTextHash,
            /^[0-9a-f]{64}$/
        );
        assert.ok(packet.unknowns.some((unknown) =>
            unknown.code === 'SUPPLEMENTAL_MATERIAL_REVIEW_REQUIRED'
            && unknown.blocking));
    });

    it('판례 상세 한 건 실패는 다른 최신 적격 판례를 폐기하지 않고 partial 감사로 남긴다', async () => {
        const caseItems = Array.from({ length: 13 }, (_, index) =>
            makeCase(700 + index, `2026-08-${String(20 - index).padStart(2, '0')}`));
        const failedId = caseItems[0].caseSerialId;
        const provider = new FakeProvider(caseItems, { failingDetailIds: [failedId] });

        const packet = await buildOrchestratorWithProvider(provider).research(input);

        assert.equal(packet.status, 'partial');
        assert.equal(packet.cases.length, 12);
        assert.equal(packet.caseSearchAudit.upstreamComplete, false);
        assert.equal(packet.caseSearchAudit.exclusions.fullTextUnavailable, 1);
        assert.equal(packet.caseSearchAudit.shortfallReason, null);
        assert.equal(provider.caseDetailIds.length, 13);
    });

    it('검색에는 있으나 상세가 없는 판례 2건을 제외하고 최신 적격 12건을 계속 찾는다', async () => {
        const caseItems = [
            makeCase(622797, '2026-08-20'),
            makeCase(618379, '2026-08-19'),
            ...Array.from({ length: 12 }, (_, index) =>
                makeCase(720 + index, `2026-08-${String(18 - index).padStart(2, '0')}`)),
        ];
        const provider = new FakeProvider(caseItems, {
            failingDetailIds: [caseItems[0].caseSerialId, caseItems[1].caseSerialId],
            failingDetailCode: 'CASE_DETAIL_NOT_FOUND',
        });

        const packet = await buildOrchestratorWithProvider(provider).research(input);

        assert.equal(packet.status, 'partial');
        assert.equal(packet.cases.length, 12);
        assert.equal(packet.caseSearchAudit.upstreamComplete, false);
        assert.equal(packet.caseSearchAudit.exclusions.fullTextUnavailable, 2);
        assert.equal(packet.caseSearchAudit.shortfallReason, null);
        assert.equal(provider.caseDetailIds.length, 14);
    });

    it('상세 누락 뒤 적격 판례가 12건 미만이면 upstream_incomplete를 명시한다', async () => {
        const caseItems = Array.from({ length: 5 }, (_, index) =>
            makeCase(760 + index, `2026-08-${String(20 - index).padStart(2, '0')}`));
        const provider = new FakeProvider(caseItems, {
            failingDetailIds: [caseItems[0].caseSerialId],
            failingDetailCode: 'CASE_DETAIL_NOT_FOUND',
        });

        const packet = await buildOrchestratorWithProvider(provider).research(input);

        assert.equal(packet.status, 'partial');
        assert.equal(packet.cases.length, 4);
        assert.equal(packet.caseSearchAudit.upstreamComplete, false);
        assert.equal(packet.caseSearchAudit.shortfallReason, 'upstream_incomplete');
        assert.equal(packet.caseSearchAudit.exclusions.fullTextUnavailable, 1);
    });

    it('사건일 확인이 필요하면 판례 상류 미완료보다 clarification_required를 우선한다', async () => {
        const caseItems = Array.from({ length: 5 }, (_, index) =>
            makeCase(780 + index, `2026-08-${String(20 - index).padStart(2, '0')}`));
        const provider = new FakeProvider(caseItems, {
            failingDetailIds: [caseItems[0].caseSerialId],
            failingDetailCode: 'CASE_DETAIL_NOT_FOUND',
        });

        const packet = await buildOrchestratorWithProvider(provider).research({
            ...input,
            facts: [{
                factId: 'FACT-1',
                text: '사건일을 알 수 없는 전자투표가 있었다.',
                provenance: 'USER_STATED',
            }],
        });

        assert.equal(packet.status, 'clarification_required');
        assert.equal(packet.caseSearchAudit.upstreamComplete, false);
        assert.equal(packet.caseSearchAudit.shortfallReason, 'upstream_incomplete');
        assert.ok(packet.unknowns.some((unknown) =>
            unknown.code === 'EVENT_DATE_REQUIRED' && unknown.blocking));
    });

    it('인식된 상세 누락과 SOURCE_MISMATCH가 섞이면 전체 조사를 fail-closed 한다', async () => {
        const caseItems = Array.from({ length: 12 }, (_, index) =>
            makeCase(740 + index, `2026-08-${String(20 - index).padStart(2, '0')}`));
        const provider = new FakeProvider(caseItems, {
            failingDetailIds: [caseItems[0].caseSerialId, caseItems[1].caseSerialId],
            failingDetailCodes: {
                [caseItems[0].caseSerialId]: 'CASE_DETAIL_NOT_FOUND',
                [caseItems[1].caseSerialId]: 'SOURCE_MISMATCH',
            },
        });

        await assert.rejects(
            () => buildOrchestratorWithProvider(provider).research(input),
            (error: unknown) => error instanceof LegalOpenApiError
                && error.code === 'SOURCE_MISMATCH'
        );
    });

    it('판례 상세의 인증·schema·식별자 오류는 partial로 숨기지 않고 fail-closed 한다', async () => {
        const caseItems = [makeCase(750, '2026-08-20')];
        for (const code of ['AUTH', 'SCHEMA_DRIFT', 'SOURCE_MISMATCH'] as const) {
            const provider = new FakeProvider(caseItems, {
                failingDetailIds: [caseItems[0].caseSerialId],
                failingDetailCode: code,
            });
            await assert.rejects(
                () => buildOrchestratorWithProvider(provider).research(input),
                (error: unknown) => error instanceof LegalOpenApiError
                    && error.code === code
            );
        }
    });

    it('provider 429가 발생하면 남은 판례 상세 fanout을 중단한다', async () => {
        const caseItems = Array.from({ length: 12 }, (_, index) =>
            makeCase(780 + index, `2026-08-${String(20 - index).padStart(2, '0')}`));
        const provider = new FakeProvider(caseItems, {
            failingDetailIds: [caseItems[0].caseSerialId],
            failingDetailCode: 'RATE_LIMITED',
        });

        await assert.rejects(
            () => buildOrchestratorWithProvider(provider).research(input),
            (error: unknown) => error instanceof LegalOpenApiError
                && error.code === 'RATE_LIMITED'
        );
        assert.equal(provider.caseDetailIds.length, 4);
    });

    it('12건 미만이면 totalCount 범위의 후속 페이지를 탐색하고 실제 적격 수만 반환한다', async () => {
        const caseItems = Array.from({ length: 12 }, (_, index) =>
            makeCase(800 + index, `2026-08-${String(20 - index).padStart(2, '0')}`));
        const firstPageIds = new Set(caseItems.slice(0, 4).map((item) => item.caseSerialId));
        const provider = new FakeProvider(caseItems, {
            pageSize: 4,
            detailFactory(summary) {
                const detail = detailFor(summary);
                return firstPageIds.has(summary.caseSerialId)
                    ? { ...detail, referenceProvisions: '도시 및 주거환경정비법 제35조의2' }
                    : detail;
            },
        });

        const packet = await buildOrchestratorWithProvider(provider).research(input);

        assert.equal(packet.status, 'complete');
        assert.equal(packet.cases.length, 8);
        assert.equal(packet.caseSearchAudit.candidateCount, 12);
        assert.equal(packet.caseSearchAudit.upstreamComplete, true);
        assert.equal(packet.caseSearchAudit.shortfallReason, 'official_results_exhausted');
        assert.deepEqual([...new Set(provider.caseSearchPages)].sort(), [1, 2, 3]);
    });

    it('후속 page 요청에 이전 page가 반복되면 SCHEMA_DRIFT로 fail-closed 한다', async () => {
        const caseItems = Array.from({ length: 8 }, (_, index) =>
            makeCase(900 + index, `2026-08-${String(20 - index).padStart(2, '0')}`));
        const provider = new FakeProvider(caseItems, {
            pageSize: 4,
            reportedCasePage: (requestedPage) => requestedPage === 2 ? 1 : requestedPage,
        });

        await assert.rejects(
            () => buildOrchestratorWithProvider(provider).research(input),
            (error: unknown) => error instanceof LegalOpenApiError
                && error.code === 'SCHEMA_DRIFT'
        );
        assert.ok(provider.caseSearchPages.includes(2));
    });

    it('page 번호만 증가하고 이전 판례 목록을 반복해도 SCHEMA_DRIFT로 fail-closed 한다', async () => {
        const caseItems = Array.from({ length: 8 }, (_, index) =>
            makeCase(950 + index, '2026-08-20'));
        const firstPage = caseItems.slice(0, 4);
        const provider = new FakeProvider(caseItems, {
            pageSize: 4,
            casePageItems: (requestedPage, defaultItems) =>
                requestedPage === 2 ? firstPage : defaultItems,
        });

        await assert.rejects(
            () => buildOrchestratorWithProvider(provider).research(input),
            (error: unknown) => error instanceof LegalOpenApiError
                && error.code === 'SCHEMA_DRIFT'
        );
        assert.ok(provider.caseSearchPages.includes(2));
    });

    it('각 stream의 미조회 page 경계를 확인해 숨은 최신 적격 판례를 먼저 반환한다', async () => {
        const lawFirstPage = Array.from({ length: 100 }, (_, index) =>
            makeCase(2000 + index, '2026-08-20'));
        const hiddenLatest = Array.from({ length: 4 }, (_, index) =>
            makeCase(3000 + index, '2026-07-19'));
        const issueEligible = Array.from({ length: 12 }, (_, index) =>
            makeCase(4000 + index, '2026-02-20'));
        const issueIrrelevant = Array.from({ length: 88 }, (_, index) =>
            makeCase(5000 + index, '2024-08-20'));
        const allCases = [
            ...lawFirstPage,
            ...hiddenLatest,
            ...issueEligible,
            ...issueIrrelevant,
        ];
        const calls: string[] = [];
        const provider: LegalResearchProviderV1 = {
            async searchCurrentLaws() {
                return { totalCount: 1, page: 1, items: [lawSummary] };
            },
            async getCurrentLawDetail() {
                return lawDetail;
            },
            async searchCurrentOrdinances() {
                throw new Error('자치법규 검색은 호출되지 않아야 합니다.');
            },
            async getCurrentOrdinanceDetail() {
                throw new Error('자치법규 상세는 호출되지 않아야 합니다.');
            },
            async searchCases(search) {
                const page = search.page ?? 1;
                if (search.referenceLawName) {
                    calls.push(`law:${page}`);
                    const items = page === 1 ? lawFirstPage : page === 2 ? hiddenLatest : [];
                    return { totalCount: 104, page, items };
                }
                calls.push(`issue:${page}`);
                const items = page === 1 ? [...issueEligible, ...issueIrrelevant] : [];
                return { totalCount: 100, page, items };
            },
            async getCaseDetail({ caseSerialId }) {
                const summary = allCases.find((candidate) =>
                    candidate.caseSerialId === caseSerialId);
                if (!summary) throw new Error('missing multi-stream fixture case');
                const exactReference = hiddenLatest.includes(summary)
                    || issueEligible.includes(summary);
                return {
                    ...detailFor(summary),
                    referenceProvisions: exactReference
                        ? '도시 및 주거환경정비법 제35조'
                        : '도시 및 주거환경정비법 제35조의2',
                };
            },
        };

        const packet = await buildOrchestratorWithProvider(provider).research(input);

        assert.ok(calls.includes('law:2'));
        assert.equal(packet.cases.length, 12);
        assert.deepEqual(
            packet.cases.slice(0, 4).map((legalCase) => legalCase.caseSerialId),
            [...hiddenLatest]
                .sort((left, right) => Number(right.caseSerialId) - Number(left.caseSerialId))
                .map((summary) => summary.caseSerialId)
        );
        assert.equal(packet.caseSearchAudit.upstreamComplete, true);
    });

    it('stream provenance로 교집합, 쟁점어, 법령명-only 순서로 상세조회하고 최종 결과는 최신순으로 정렬한다', async () => {
        const intersection = makeCase(6100, '2026-06-01');
        const issueOnly = makeCase(6200, '2026-07-01');
        const lawOnly = makeCase(6300, '2026-08-01');
        const allCases = [intersection, issueOnly, lawOnly];
        const detailIds: string[] = [];
        const provider: LegalResearchProviderV1 = {
            async searchCurrentLaws() {
                return { totalCount: 1, page: 1, items: [lawSummary] };
            },
            async getCurrentLawDetail() {
                return lawDetail;
            },
            async searchCurrentOrdinances() {
                throw new Error('자치법규 검색은 호출되지 않아야 합니다.');
            },
            async getCurrentOrdinanceDetail() {
                throw new Error('자치법규 상세는 호출되지 않아야 합니다.');
            },
            async searchCases(search) {
                if (search.referenceLawName) {
                    return { totalCount: 2, page: 1, items: [lawOnly, intersection] };
                }
                return { totalCount: 2, page: 1, items: [issueOnly, intersection] };
            },
            async getCaseDetail({ caseSerialId }) {
                detailIds.push(caseSerialId);
                const summary = allCases.find((candidate) =>
                    candidate.caseSerialId === caseSerialId);
                if (!summary) throw new Error('missing provenance fixture case');
                return detailFor(summary);
            },
        };

        const packet = await buildOrchestratorWithProvider(provider).research(input);

        assert.deepEqual(detailIds, [
            intersection.caseSerialId,
            issueOnly.caseSerialId,
            lawOnly.caseSerialId,
        ]);
        assert.deepEqual(packet.cases.map((legalCase) => legalCase.caseSerialId), [
            lawOnly.caseSerialId,
            issueOnly.caseSerialId,
            intersection.caseSerialId,
        ]);
        assert.equal(packet.caseSearchAudit.upstreamComplete, true);
    });

    it('다중 쟁점 stream에서는 선택적 검색 후보를 포괄 교집합보다 먼저 검증한다', async () => {
        const broadIntersection = Array.from({ length: 100 }, (_, index) =>
            makeCase(6400 + index, '2026-08-30'));
        const broadIssueOnly = Array.from({ length: 20 }, (_, index) =>
            makeCase(6600 + index, '2026-08-29'));
        const selective = Array.from({ length: 10 }, (_, index) =>
            makeCase(6800 + index, `2026-08-${String(20 - index).padStart(2, '0')}`));
        const allCases = [...broadIntersection, ...broadIssueOnly, ...selective];
        const detailIds: string[] = [];
        const provider: LegalResearchProviderV1 = {
            async searchCurrentLaws() {
                return { totalCount: 1, page: 1, items: [lawSummary] };
            },
            async getCurrentLawDetail() {
                return lawDetail;
            },
            async searchCurrentOrdinances() {
                throw new Error('자치법규 검색은 호출되지 않아야 합니다.');
            },
            async getCurrentOrdinanceDetail() {
                throw new Error('자치법규 상세는 호출되지 않아야 합니다.');
            },
            async searchCases(search) {
                if (search.referenceLawName) {
                    return {
                        totalCount: broadIntersection.length,
                        page: 1,
                        items: broadIntersection,
                    };
                }
                if (search.query === '조합설립') {
                    return { totalCount: selective.length, page: 1, items: selective };
                }
                if (search.query === '요건') {
                    return {
                        totalCount: broadIssueOnly.length,
                        page: 1,
                        items: broadIssueOnly,
                    };
                }
                return {
                    totalCount: broadIntersection.length,
                    page: 1,
                    items: broadIntersection,
                };
            },
            async getCaseDetail({ caseSerialId }) {
                detailIds.push(caseSerialId);
                const summary = allCases.find((candidate) =>
                    candidate.caseSerialId === caseSerialId);
                if (!summary) throw new Error('missing multi-stream fixture case');
                const detail = detailFor(summary);
                return selective.includes(summary)
                    ? detail
                    : { ...detail, referenceProvisions: '도시 및 주거환경정비법 제35조의2' };
            },
        };
        const multiIssueInput: LegalResearchInputV1 = {
            ...input,
            researchPlan: {
                ...input.researchPlan,
                caseQueries: [{
                    ...input.researchPlan.caseQueries[0],
                    issueTerms: ['조합설립', '동의', '요건'],
                }],
            },
        };

        const packet = await buildOrchestratorWithProvider(provider).research(multiIssueInput);

        assert.deepEqual(detailIds.slice(0, 10), selective.map((item) => item.caseSerialId));
        assert.equal(detailIds.length, 120);
        assert.deepEqual(
            packet.cases.map((legalCase) => legalCase.caseSerialId),
            selective.map((item) => item.caseSerialId)
        );
        assert.equal(packet.caseSearchAudit.candidateCount, 120);
        assert.equal(packet.caseSearchAudit.upstreamComplete, false);
    });

    it('120건 예산에서 쟁점어 후보를 법령명-only 후보보다 먼저 검증해 적격 12건을 보존한다', async () => {
        const lawOnly = Array.from({ length: 120 }, (_, index) =>
            makeCase(7000 + index, '2026-08-30'));
        const issueCandidates = Array.from({ length: 12 }, (_, index) =>
            makeCase(8000 + index, `2026-08-${String(20 - index).padStart(2, '0')}`));
        const allCases = [...lawOnly, ...issueCandidates];
        const detailIds: string[] = [];
        const searchCalls: string[] = [];
        const provider: LegalResearchProviderV1 = {
            async searchCurrentLaws() {
                return { totalCount: 1, page: 1, items: [lawSummary] };
            },
            async getCurrentLawDetail() {
                return lawDetail;
            },
            async searchCurrentOrdinances() {
                throw new Error('자치법규 검색은 호출되지 않아야 합니다.');
            },
            async getCurrentOrdinanceDetail() {
                throw new Error('자치법규 상세는 호출되지 않아야 합니다.');
            },
            async searchCases(search) {
                const page = search.page ?? 1;
                if (search.referenceLawName) {
                    searchCalls.push(`law:${page}`);
                    return {
                        totalCount: lawOnly.length,
                        page,
                        items: page === 1 ? lawOnly.slice(0, 100) : lawOnly.slice(100),
                    };
                }
                searchCalls.push(`issue:${page}`);
                return {
                    totalCount: issueCandidates.length,
                    page,
                    items: page === 1 ? issueCandidates : [],
                };
            },
            async getCaseDetail({ caseSerialId }) {
                detailIds.push(caseSerialId);
                const summary = allCases.find((candidate) =>
                    candidate.caseSerialId === caseSerialId);
                if (!summary) throw new Error('missing recall fixture case');
                const detail = detailFor(summary);
                return lawOnly.includes(summary)
                    ? { ...detail, referenceProvisions: '도시 및 주거환경정비법 제35조의2' }
                    : detail;
            },
        };

        const packet = await buildOrchestratorWithProvider(provider).research(input);

        assert.deepEqual(detailIds.slice(0, 12), issueCandidates.map((item) => item.caseSerialId));
        assert.ok(searchCalls.includes('law:2'));
        assert.equal(detailIds.length, 120);
        assert.equal(packet.cases.length, 12);
        assert.deepEqual(
            packet.cases.map((legalCase) => legalCase.caseSerialId),
            issueCandidates.map((item) => item.caseSerialId)
        );
        assert.equal(packet.caseSearchAudit.candidateCount, 120);
        assert.equal(packet.caseSearchAudit.upstreamComplete, false);
    });

    it('상세 후보 120건 상한에 도달하면 더 오래된 후보를 채우지 않고 upstream_incomplete로 닫는다', async () => {
        const caseItems = Array.from({ length: 121 }, (_, index) =>
            makeCase(1000 + index, '2026-08-20'));
        const provider = new FakeProvider(caseItems, {
            detailFactory(summary) {
                return {
                    ...detailFor(summary),
                    referenceProvisions: '도시 및 주거환경정비법 제35조의2',
                };
            },
        });

        const packet = await buildOrchestratorWithProvider(provider).research(input);

        assert.equal(packet.status, 'partial');
        assert.equal(packet.cases.length, 0);
        assert.equal(packet.caseSearchAudit.candidateCount, 120);
        assert.equal(packet.caseSearchAudit.upstreamComplete, false);
        assert.equal(packet.caseSearchAudit.shortfallReason, 'upstream_incomplete');
        assert.equal(provider.caseDetailIds.length, 120);
        assert.ok(provider.caseSearchPages.includes(2));
    });
});
