import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    buildCaseSearchQueriesV1,
    LegalResearchInputV1Schema,
    LegalResearchPlanV1Schema,
} from '../src/services/legal-research/research-plan';

const validPlan = {
    issues: [
        {
            issueId: 'ISSUE-1',
            issue: '조합설립 동의 요건',
            requestedOutcome: 'vote_threshold' as const,
        },
    ],
    lawAnchors: [
        {
            issueIds: ['ISSUE-1'],
            exactName: '도시 및 주거환경정비법',
            lawType: '법률',
            articleLabels: ['제35조'],
            issueTerms: ['조합설립', '동의'],
        },
    ],
    ordinanceRequirement: 'not_required' as const,
    ordinanceAnchors: [],
    caseQueries: [
        {
            issueIds: ['ISSUE-1'],
            lawNames: ['도시 및 주거환경정비법'],
            articleLabels: ['제35조'],
            issueTerms: ['조합설립', '동의'],
        },
    ],
};

describe('LegalResearchPlanV1Schema', () => {
    it('caseQuery 순서대로 법령명+쟁점 복합 검색을 만들고 법령명 보완 stream은 중복 제거한다', () => {
        assert.deepEqual(buildCaseSearchQueriesV1([
            {
                lawNames: ['도시 및 주거환경정비법'],
                issueTerms: ['조합설립', '동의'],
            },
            {
                lawNames: [' 도시  및 주거환경정비법 '],
                issueTerms: ['동의', '대표자 선정'],
            },
        ]), {
            lawNameQueries: ['도시 및 주거환경정비법'],
            issueQueries: [
                '조합설립',
                '동의',
                '대표자 선정',
            ],
            executedBodyQueries: [
                '도시 및 주거환경정비법 조합설립',
                '도시 및 주거환경정비법 동의',
                '도시 및 주거환경정비법 대표자 선정',
            ],
        });
    });

    it('쟁점어에 법령명이 이미 포함되어 있으면 복합 검색에서 법령명을 중복하지 않는다', () => {
        assert.deepEqual(buildCaseSearchQueriesV1([{
            lawNames: ['도시 및 주거환경정비법'],
            issueTerms: ['도시 및 주거환경정비법상 조합설립 동의'],
        }]).executedBodyQueries, [
            '도시 및 주거환경정비법상 조합설립 동의',
        ]);
    });

    it('복합 검색과 법령명 보완 stream 합계가 24개까지이고 25개면 거부한다', () => {
        const issueTerms = Array.from({ length: 24 }, (_, index) =>
            `쟁점검색어${String(index + 1).padStart(2, '0')}`);
        const caseQueries = [
            { ...validPlan.caseQueries[0], issueTerms: issueTerms.slice(0, 12) },
            { ...validPlan.caseQueries[0], issueTerms: issueTerms.slice(12, 23) },
        ];

        assert.equal(LegalResearchPlanV1Schema.safeParse({
            ...validPlan,
            caseQueries,
        }).success, true);
        const overLimit = LegalResearchPlanV1Schema.safeParse({
            ...validPlan,
            caseQueries: [
                caseQueries[0],
                { ...caseQueries[1], issueTerms: issueTerms.slice(12) },
            ],
        });
        assert.equal(overLimit.success, false);
        assert.match(
            JSON.stringify(overLimit.error?.issues ?? []),
            /복합 검색과 법령명 보완 검색을 합쳐/
        );
    });

    it('provider 제어 파라미터를 공개 입력에서 허용하지 않는다', () => {
        assert.equal(
            LegalResearchPlanV1Schema.safeParse({
                ...validPlan,
                target: 'law',
                nw: 1,
                sort: 'lasc',
                maxCases: 100,
            }).success,
            false
        );
    });

    it('정의되지 않은 issueId 참조를 거부한다', () => {
        const result = LegalResearchPlanV1Schema.safeParse({
            ...validPlan,
            caseQueries: [
                {
                    ...validPlan.caseQueries[0],
                    issueIds: ['ISSUE-2'],
                },
            ],
        });

        assert.equal(result.success, false);
    });

    it('한 판례 query가 여러 쟁점을 한꺼번에 참조하는 계획을 거부한다', () => {
        const result = LegalResearchPlanV1Schema.safeParse({
            ...validPlan,
            issues: [
                ...validPlan.issues,
                {
                    issueId: 'ISSUE-2',
                    issue: '대표자 선정 절차',
                    requestedOutcome: 'procedure',
                },
            ],
            lawAnchors: [
                ...validPlan.lawAnchors,
                {
                    ...validPlan.lawAnchors[0],
                    issueIds: ['ISSUE-2'],
                    issueTerms: ['대표자 선정'],
                },
            ],
            caseQueries: [{
                ...validPlan.caseQueries[0],
                issueIds: ['ISSUE-1', 'ISSUE-2'],
            }],
        });

        assert.equal(result.success, false);
    });

    it('한 판례 query에 여러 법령을 넣어 법령별 조문 근거를 교차 차용하지 않는다', () => {
        const result = LegalResearchPlanV1Schema.safeParse({
            ...validPlan,
            lawAnchors: [
                ...validPlan.lawAnchors,
                {
                    ...validPlan.lawAnchors[0],
                    exactName: '주택법',
                    articleLabels: ['제1조'],
                },
            ],
            caseQueries: [{
                ...validPlan.caseQueries[0],
                lawNames: ['도시 및 주거환경정비법', '주택법'],
                articleLabels: ['제1조'],
            }],
        });

        assert.equal(result.success, false);
    });

    it('URL과 인증 query를 검색어로 받지 않는다', () => {
        for (const issueTerm of [
            'https://law.go.kr/DRF/lawSearch.do',
            'query=동의&OC=secret',
        ]) {
            const result = LegalResearchPlanV1Schema.safeParse({
                ...validPlan,
                lawAnchors: [
                    {
                        ...validPlan.lawAnchors[0],
                        issueTerms: [issueTerm],
                    },
                ],
            });
            assert.equal(result.success, false);
        }
    });

    it('현행 법령 anchor에 없는 법령명으로 판례를 검색하지 않는다', () => {
        const result = LegalResearchPlanV1Schema.safeParse({
            ...validPlan,
            caseQueries: [
                {
                    ...validPlan.caseQueries[0],
                    lawNames: ['민법'],
                },
            ],
        });

        assert.equal(result.success, false);
    });

    it('다른 issue에만 연결된 법령 anchor를 판례 검색 근거로 차용하지 않는다', () => {
        const result = LegalResearchPlanV1Schema.safeParse({
            ...validPlan,
            issues: [
                ...validPlan.issues,
                {
                    issueId: 'ISSUE-2',
                    issue: '총회 의결 절차',
                    requestedOutcome: 'procedure',
                },
            ],
            lawAnchors: [
                ...validPlan.lawAnchors,
                {
                    issueIds: ['ISSUE-2'],
                    exactName: '주택법',
                    lawType: '법률',
                    articleLabels: ['제1조'],
                    issueTerms: ['총회 의결'],
                },
            ],
            caseQueries: [
                {
                    ...validPlan.caseQueries[0],
                    lawNames: ['주택법'],
                    articleLabels: ['제1조'],
                },
                {
                    issueIds: ['ISSUE-2'],
                    lawNames: ['주택법'],
                    articleLabels: ['제1조'],
                    issueTerms: ['총회 의결'],
                },
            ],
        });

        assert.equal(result.success, false);
        assert.match(
            JSON.stringify(result.error?.issues ?? []),
            /같은 issueId의 현행 법령 anchor/
        );
    });

    it('같은 법령명이어도 다른 issue의 조문 anchor를 차용하지 않는다', () => {
        const result = LegalResearchPlanV1Schema.safeParse({
            ...validPlan,
            issues: [
                ...validPlan.issues,
                {
                    issueId: 'ISSUE-2',
                    issue: '총회 전자투표 절차',
                    requestedOutcome: 'procedure',
                },
            ],
            lawAnchors: [
                ...validPlan.lawAnchors,
                {
                    ...validPlan.lawAnchors[0],
                    issueIds: ['ISSUE-2'],
                    articleLabels: ['제45조'],
                    issueTerms: ['전자투표'],
                },
            ],
            caseQueries: [
                {
                    ...validPlan.caseQueries[0],
                    articleLabels: ['제45조'],
                },
                {
                    issueIds: ['ISSUE-2'],
                    lawNames: ['도시 및 주거환경정비법'],
                    articleLabels: ['제45조'],
                    issueTerms: ['전자투표'],
                },
            ],
        });

        assert.equal(result.success, false);
        assert.match(
            JSON.stringify(result.error?.issues ?? []),
            /같은 issueId·법령의 anchor/
        );
    });

    it('모든 쟁점이 법령 anchor와 판례 query에 각각 포함되어야 한다', () => {
        const result = LegalResearchPlanV1Schema.safeParse({
            ...validPlan,
            issues: [
                ...validPlan.issues,
                {
                    issueId: 'ISSUE-2',
                    issue: '인가 신청 절차',
                    requestedOutcome: 'procedure',
                },
            ],
        });

        assert.equal(result.success, false);
    });
});

describe('LegalResearchInputV1Schema', () => {
    it('조사계획의 자치법규 관할과 요청 관할이 정확히 일치해야 한다', () => {
        const result = LegalResearchInputV1Schema.safeParse({
            question: '서울시 재건축 조합설립 동의 요건은?',
            jurisdiction: {
                countryCode: 'KR',
                organizationCode: '6110000',
                organizationName: '서울특별시',
            },
            projectType: 'reconstruction',
            projectStage: 'association_establishment',
            facts: [],
            researchPlan: {
                ...validPlan,
                ordinanceRequirement: 'required',
                ordinanceAnchors: [
                    {
                        issueIds: ['ISSUE-1'],
                        exactName: '도시 및 주거환경정비 조례',
                        organizationCode: '6260000',
                        organizationName: '부산광역시',
                        articleLabels: [],
                        issueTerms: ['조합설립'],
                    },
                ],
            },
        });

        assert.equal(result.success, false);
    });

    it('필수 자치법규 검토에서 관할이 없으면 빈 anchor 상태를 수용한다', () => {
        const result = LegalResearchInputV1Schema.safeParse({
            question: '조합설립 절차에 관할 조례 요건이 있는가?',
            projectType: 'reconstruction',
            projectStage: 'association_establishment',
            facts: [],
            researchPlan: {
                ...validPlan,
                ordinanceRequirement: 'required',
                ordinanceAnchors: [],
            },
        });

        assert.equal(result.success, true);
    });

    it('질문 원문과 exact 연관 검색어가 없는 다른 쟁점 조사계획을 거부한다', () => {
        const result = LegalResearchInputV1Schema.safeParse({
            question: '분양신청 기간과 통지 절차는 무엇인가?',
            jurisdiction: { countryCode: 'KR' },
            projectType: 'reconstruction',
            projectStage: 'management_disposition',
            facts: [],
            researchPlan: validPlan,
        });

        assert.equal(result.success, false);
    });

    it('자치법규 검토가 필요하지 않으면 ordinance anchor를 거부한다', () => {
        const result = LegalResearchPlanV1Schema.safeParse({
            ...validPlan,
            ordinanceAnchors: [{
                issueIds: ['ISSUE-1'],
                exactName: '서울특별시 도시 및 주거환경정비 조례',
                organizationCode: '6110000',
                organizationName: '서울특별시',
                articleLabels: [],
                issueTerms: ['조합설립'],
            }],
        });

        assert.equal(result.success, false);
    });

    it('하위 시·군·구 관할만 단독 지정해 필수 조례 검토를 우회할 수 없다', () => {
        const parsed = LegalResearchInputV1Schema.safeParse({
            question: '강남구 조합설립 조례 요건은?',
            jurisdiction: {
                countryCode: 'KR',
                subOrganizationCode: '3220000',
                subOrganizationName: '서울특별시 강남구',
            },
            projectType: 'reconstruction',
            projectStage: 'association_establishment',
            facts: [],
            researchPlan: {
                ...validPlan,
                ordinanceRequirement: 'required',
                ordinanceAnchors: [],
            },
        });
        assert.equal(parsed.success, false);
    });

    it('유효한 현행법 조사 입력을 수용한다', () => {
        const result = LegalResearchInputV1Schema.safeParse({
            question: '재건축 조합설립 동의 요건은?',
            jurisdiction: { countryCode: 'KR' },
            projectType: 'reconstruction',
            projectStage: 'association_establishment',
            facts: [
                {
                    factId: 'FACT-1',
                    text: '조합설립 동의서를 징구 중이다.',
                    provenance: 'USER_STATED',
                },
            ],
            researchPlan: validPlan,
        });

        assert.equal(result.success, true);
    });
});
