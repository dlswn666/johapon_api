import * as z from 'zod/v4';
import { createHash } from 'node:crypto';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISSUE_ID_PATTERN = /^ISSUE-[1-8]$/;
const FACT_ID_PATTERN = /^FACT-[1-9][0-9]*$/;
const ARTICLE_PATTERN = /^제\d+조(?:의\d+)?$/;
const LOCAL_AUTHORITY_CODE_PATTERN = /^\d{2,12}$/;

const forbiddenSearchValue = /(?:https?:\/\/|(?:^|[?&])(oc|token|key|target|nw|sort|display|page)=)/i;

function normalizedSearchText(value: string): string {
    return value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ko-KR');
}

function sortStrings(values: readonly string[]): string[] {
    return [...values].sort((left, right) => left.localeCompare(right, 'ko-KR'));
}

export const LegalDateSchema = z
    .string()
    .regex(DATE_PATTERN, '날짜는 YYYY-MM-DD 형식이어야 합니다.')
    .refine((value) => {
        const parsed = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    }, '유효한 날짜가 아닙니다.');

export const LegalSearchTermSchema = z
    .string()
    .trim()
    .min(2)
    .max(80)
    .refine((value) => !forbiddenSearchValue.test(value), {
        message: 'URL, 인증값, provider 제어 파라미터는 검색어로 사용할 수 없습니다.',
    });

const IssueIdSchema = z.string().regex(ISSUE_ID_PATTERN);
const FactIdSchema = z.string().regex(FACT_ID_PATTERN);

export const LegalResearchPlanV1Schema = z
    .object({
        issues: z
            .array(
                z
                    .object({
                        issueId: IssueIdSchema,
                        issue: z.string().trim().min(3).max(300),
                        requestedOutcome: z.enum([
                            'rule',
                            'procedure',
                            'eligibility',
                            'deadline',
                            'vote_threshold',
                            'remedy',
                            'other',
                        ]),
                    })
                    .strict()
            )
            .min(1)
            .max(8),
        lawAnchors: z
            .array(
                z
                    .object({
                        issueIds: z.array(IssueIdSchema).min(1).max(8),
                        exactName: LegalSearchTermSchema,
                        lawType: LegalSearchTermSchema,
                        articleLabels: z
                            .array(z.string().regex(ARTICLE_PATTERN))
                            .max(12)
                            .default([]),
                        issueTerms: z.array(LegalSearchTermSchema).min(1).max(12),
                    })
                    .strict()
            )
            .min(1)
            .max(12),
        ordinanceRequirement: z
            .enum(['required', 'not_required'])
            .describe(
                '질문의 결론에 관할 자치법규 검토가 필요한지 명시합니다. required인데 관할이 없으면 서버가 clarification_required로 반환하므로 관할을 추정하지 않습니다.'
            ),
        ordinanceAnchors: z
            .array(
                z
                    .object({
                        issueIds: z.array(IssueIdSchema).min(1).max(8),
                        exactName: LegalSearchTermSchema,
                        organizationCode: z.string().regex(LOCAL_AUTHORITY_CODE_PATTERN),
                        organizationName: z.string().trim().min(2).max(80),
                        subOrganizationCode: z
                            .string()
                            .regex(LOCAL_AUTHORITY_CODE_PATTERN)
                            .optional(),
                        subOrganizationName: z.string().trim().min(2).max(80).optional(),
                        articleLabels: z
                            .array(z.string().regex(ARTICLE_PATTERN))
                            .max(12)
                            .default([]),
                        issueTerms: z.array(LegalSearchTermSchema).min(1).max(12),
                    })
                    .strict()
                    .superRefine((value, context) => {
                        const hasCode = value.subOrganizationCode !== undefined;
                        const hasName = value.subOrganizationName !== undefined;
                        if (hasCode !== hasName) {
                            context.addIssue({
                                code: 'custom',
                                message: '하위 관할 코드는 명칭과 함께 지정해야 합니다.',
                                path: ['subOrganizationCode'],
                            });
                        }
                    })
            )
            .max(8)
            .default([]),
        caseQueries: z
            .array(
                z
                    .object({
                        issueIds: z
                            .array(IssueIdSchema)
                            .length(
                                1,
                                '각 판례 query는 정확히 하나의 issueId만 참조해야 합니다.'
                            ),
                        lawNames: z
                            .array(LegalSearchTermSchema)
                            .length(
                                1,
                                '각 판례 query는 조문 근거의 법령별 교차 차용을 막기 위해 정확히 하나의 법령만 참조해야 합니다.'
                            ),
                        articleLabels: z
                            .array(z.string().regex(ARTICLE_PATTERN))
                            .max(12)
                            .default([]),
                        issueTerms: z.array(LegalSearchTermSchema).min(1).max(12),
                    })
                    .strict()
            )
            .min(1)
            .max(12),
    })
    .strict()
    .superRefine((plan, context) => {
        const issueIds = plan.issues.map((issue) => issue.issueId);
        const knownIssueIds = new Set(issueIds);

        if (knownIssueIds.size !== issueIds.length) {
            context.addIssue({
                code: 'custom',
                message: 'issueId는 중복될 수 없습니다.',
                path: ['issues'],
            });
        }

        if (plan.ordinanceRequirement === 'not_required' && plan.ordinanceAnchors.length > 0) {
            context.addIssue({
                code: 'custom',
                message: '자치법규 검토가 필요하지 않으면 ordinanceAnchors는 비워야 합니다.',
                path: ['ordinanceAnchors'],
            });
        }

        const references = [
            ...plan.lawAnchors.map((anchor, index) => ({
                path: ['lawAnchors', index, 'issueIds'] as Array<string | number>,
                ids: anchor.issueIds,
            })),
            ...plan.ordinanceAnchors.map((anchor, index) => ({
                path: ['ordinanceAnchors', index, 'issueIds'] as Array<string | number>,
                ids: anchor.issueIds,
            })),
            ...plan.caseQueries.map((query, index) => ({
                path: ['caseQueries', index, 'issueIds'] as Array<string | number>,
                ids: query.issueIds,
            })),
        ];

        for (const reference of references) {
            if (new Set(reference.ids).size !== reference.ids.length) {
                context.addIssue({
                    code: 'custom',
                    message: '한 검색 항목에서 issueId를 중복 참조할 수 없습니다.',
                    path: reference.path,
                });
            }
            for (const issueId of reference.ids) {
                if (!knownIssueIds.has(issueId)) {
                    context.addIssue({
                        code: 'custom',
                        message: `정의되지 않은 issueId입니다: ${issueId}`,
                        path: reference.path,
                    });
                }
            }
        }

        for (const [index, query] of plan.caseQueries.entries()) {
            const issueId = query.issueIds[0];
            if (!issueId) continue;
            const issueLawAnchors = plan.lawAnchors.filter((anchor) =>
                anchor.issueIds.includes(issueId));
            const queryLawAnchors = issueLawAnchors.filter((anchor) =>
                query.lawNames.includes(anchor.exactName));

            for (const lawName of query.lawNames) {
                if (!issueLawAnchors.some((anchor) => anchor.exactName === lawName)) {
                    context.addIssue({
                        code: 'custom',
                        message: `판례 검색 법령은 같은 issueId의 현행 법령 anchor로 정의해야 합니다: ${issueId} / ${lawName}`,
                        path: ['caseQueries', index, 'lawNames'],
                    });
                }
            }

            const anchoredArticleLabels = new Set(
                queryLawAnchors.flatMap((anchor) => anchor.articleLabels)
            );
            for (const articleLabel of query.articleLabels) {
                if (!anchoredArticleLabels.has(articleLabel)) {
                    context.addIssue({
                        code: 'custom',
                        message: `판례 검색 조문은 같은 issueId·법령의 anchor에 먼저 정의해야 합니다: ${issueId} / ${articleLabel}`,
                        path: ['caseQueries', index, 'articleLabels'],
                    });
                }
            }
        }

        for (const [index, issue] of plan.issues.entries()) {
            if (!plan.lawAnchors.some((anchor) => anchor.issueIds.includes(issue.issueId))) {
                context.addIssue({
                    code: 'custom',
                    message: `모든 쟁점은 최소 한 개의 현행 법령 anchor로 조사해야 합니다: ${issue.issueId}`,
                    path: ['issues', index, 'issueId'],
                });
            }
            if (!plan.caseQueries.some((query) => query.issueIds.includes(issue.issueId))) {
                context.addIssue({
                    code: 'custom',
                    message: `모든 쟁점은 최소 한 개의 판례 query로 조사해야 합니다: ${issue.issueId}`,
                    path: ['issues', index, 'issueId'],
                });
            }
        }

        // 같은 문자열이어도 JO 법령명 stream과 본문 query stream은 별도 요청이다.
        const caseStreamCount = new Set(
            plan.caseQueries.flatMap((query) => query.lawNames)
        ).size + new Set(
            plan.caseQueries.flatMap((query) => query.issueTerms)
        ).size;
        if (caseStreamCount > 24) {
            context.addIssue({
                code: 'custom',
                message: '판례 검색 stream은 중복 제거 후 최대 24개입니다.',
                path: ['caseQueries'],
            });
        }
    });

export const LegalResearchInputV1Schema = z
    .object({
        question: z.string().trim().min(1).max(4000),
        jurisdiction: z
            .object({
                countryCode: z.literal('KR'),
                organizationCode: z.string().regex(LOCAL_AUTHORITY_CODE_PATTERN).optional(),
                organizationName: z.string().trim().min(2).max(80).optional(),
                subOrganizationCode: z
                    .string()
                    .regex(LOCAL_AUTHORITY_CODE_PATTERN)
                    .optional(),
                subOrganizationName: z.string().trim().min(2).max(80).optional(),
            })
            .strict()
            .superRefine((value, context) => {
                const pairs: Array<[unknown, unknown, string]> = [
                    [value.organizationCode, value.organizationName, 'organizationCode'],
                    [value.subOrganizationCode, value.subOrganizationName, 'subOrganizationCode'],
                ];
                for (const [code, name, path] of pairs) {
                    if ((code === undefined) !== (name === undefined)) {
                        context.addIssue({
                            code: 'custom',
                            message: '관할 코드는 명칭과 함께 지정해야 합니다.',
                            path: [path],
                        });
                    }
                }
                if (
                    value.subOrganizationCode !== undefined
                    && value.organizationCode === undefined
                ) {
                    context.addIssue({
                        code: 'custom',
                        message: '시·군·구 관할을 지정하려면 상위 시·도 코드와 명칭도 필요합니다.',
                        path: ['organizationCode'],
                    });
                }
            })
            .optional(),
        projectType: z.enum([
            'redevelopment',
            'reconstruction',
            'small_scale_renewal',
            'other',
        ]),
        projectStage: z.enum([
            'renewal_plan',
            'promotion_committee',
            'association_establishment',
            'project_implementation',
            'management_disposition',
            'liquidation',
            'other',
        ]),
        facts: z
            .array(
                z
                    .object({
                        factId: FactIdSchema,
                        text: z.string().trim().min(1).max(1000),
                        provenance: z.literal('USER_STATED'),
                    })
                    .strict()
            )
            .max(50)
            .default([]),
        eventDate: LegalDateSchema.optional(),
        researchPlan: LegalResearchPlanV1Schema,
    })
    .strict()
    .superRefine((input, context) => {
        const factIds = input.facts.map((fact) => fact.factId);
        if (new Set(factIds).size !== factIds.length) {
            context.addIssue({
                code: 'custom',
                message: 'factId는 중복될 수 없습니다.',
                path: ['facts'],
            });
        }

        const ordinanceRequired = input.researchPlan.ordinanceRequirement === 'required';
        const hasLocalJurisdiction = Boolean(
            input.jurisdiction?.organizationCode
            && input.jurisdiction.organizationName
        );
        if (
            ordinanceRequired
            && hasLocalJurisdiction
            && input.researchPlan.ordinanceAnchors.length === 0
        ) {
            context.addIssue({
                code: 'custom',
                message: '관할이 확인된 필수 자치법규 검토에는 하나 이상의 ordinanceAnchor가 필요합니다.',
                path: ['researchPlan', 'ordinanceAnchors'],
            });
        }

        for (const anchor of input.researchPlan.ordinanceAnchors) {
            if (!input.jurisdiction) {
                context.addIssue({
                    code: 'custom',
                    message: '자치법규 검색에는 관할 정보가 필요합니다.',
                    path: ['jurisdiction'],
                });
                break;
            }
            if (
                anchor.organizationCode !== input.jurisdiction.organizationCode ||
                anchor.organizationName !== input.jurisdiction.organizationName ||
                anchor.subOrganizationCode !== input.jurisdiction.subOrganizationCode ||
                anchor.subOrganizationName !== input.jurisdiction.subOrganizationName
            ) {
                context.addIssue({
                    code: 'custom',
                    message: '자치법규 검색 관할은 요청 관할과 정확히 일치해야 합니다.',
                    path: ['researchPlan', 'ordinanceAnchors'],
                });
            }
        }

        const normalizedQuestion = normalizedSearchText(input.question);
        for (const [index, issue] of input.researchPlan.issues.entries()) {
            const linkedTerms = [
                ...input.researchPlan.lawAnchors
                    .filter((anchor) => anchor.issueIds.includes(issue.issueId))
                    .flatMap((anchor) => anchor.issueTerms),
                ...input.researchPlan.ordinanceAnchors
                    .filter((anchor) => anchor.issueIds.includes(issue.issueId))
                    .flatMap((anchor) => anchor.issueTerms),
                ...input.researchPlan.caseQueries
                    .filter((query) => query.issueIds.includes(issue.issueId))
                    .flatMap((query) => query.issueTerms),
            ];
            if (!linkedTerms.some((term) => normalizedQuestion.includes(normalizedSearchText(term)))) {
                context.addIssue({
                    code: 'custom',
                    message: `질문 원문과 exact 연관된 쟁점 검색어가 필요합니다: ${issue.issueId}`,
                    path: ['researchPlan', 'issues', index, 'issue'],
                });
            }
        }
    });

export type LegalResearchPlanV1 = z.infer<typeof LegalResearchPlanV1Schema>;
export type LegalResearchInputV1 = z.infer<typeof LegalResearchInputV1Schema>;

export function normalizeLegalResearchPlanV1(
    plan: LegalResearchPlanV1
): LegalResearchPlanV1 {
    const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim();
    const normalized: LegalResearchPlanV1 = {
        issues: [...plan.issues]
            .map((issue) => ({ ...issue, issue: normalize(issue.issue) }))
            .sort((left, right) => left.issueId.localeCompare(right.issueId)),
        lawAnchors: plan.lawAnchors.map((anchor) => ({
            ...anchor,
            issueIds: sortStrings(anchor.issueIds),
            exactName: normalize(anchor.exactName),
            lawType: normalize(anchor.lawType),
            articleLabels: sortStrings(anchor.articleLabels),
            issueTerms: sortStrings(anchor.issueTerms.map(normalize)),
        })),
        ordinanceRequirement: plan.ordinanceRequirement,
        ordinanceAnchors: plan.ordinanceAnchors.map((anchor) => ({
            ...anchor,
            issueIds: sortStrings(anchor.issueIds),
            exactName: normalize(anchor.exactName),
            organizationName: normalize(anchor.organizationName),
            ...(anchor.subOrganizationName
                ? { subOrganizationName: normalize(anchor.subOrganizationName) }
                : {}),
            articleLabels: sortStrings(anchor.articleLabels),
            issueTerms: sortStrings(anchor.issueTerms.map(normalize)),
        })),
        caseQueries: plan.caseQueries.map((query) => ({
            ...query,
            issueIds: sortStrings(query.issueIds),
            lawNames: sortStrings(query.lawNames.map(normalize)),
            articleLabels: sortStrings(query.articleLabels),
            issueTerms: sortStrings(query.issueTerms.map(normalize)),
        })),
    };
    const sortObjects = <T>(values: T[]) => [...values].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right), 'ko-KR'));
    normalized.lawAnchors = sortObjects(normalized.lawAnchors);
    normalized.ordinanceAnchors = sortObjects(normalized.ordinanceAnchors);
    normalized.caseQueries = sortObjects(normalized.caseQueries);
    return normalized;
}

export function hashLegalResearchPlanV1(plan: LegalResearchPlanV1): string {
    const hash = createHash('sha256');
    hash.write(JSON.stringify(normalizeLegalResearchPlanV1(plan)), 'utf8');
    return hash.digest('hex');
}

export function questionMatchedTermsForIssueV1(
    question: string,
    plan: LegalResearchPlanV1,
    issueId: string
): string[] {
    const candidates = [
        ...plan.lawAnchors.filter((anchor) => anchor.issueIds.includes(issueId))
            .flatMap((anchor) => anchor.issueTerms),
        ...plan.ordinanceAnchors.filter((anchor) => anchor.issueIds.includes(issueId))
            .flatMap((anchor) => anchor.issueTerms),
        ...plan.caseQueries.filter((query) => query.issueIds.includes(issueId))
            .flatMap((query) => query.issueTerms),
    ];
    const normalizedQuestion = normalizedSearchText(question);
    return sortStrings([...new Set(candidates.filter((term) =>
        normalizedQuestion.includes(normalizedSearchText(term))))]);
}

export function buildLegalPlanCoverageAuditV1(
    question: string,
    plan: LegalResearchPlanV1
) {
    const normalizedPlan = normalizeLegalResearchPlanV1(plan);
    const issues = normalizedPlan.issues.map((issue) => ({
        issueId: issue.issueId,
        questionMatchedTerms: questionMatchedTermsForIssueV1(
            question,
            normalizedPlan,
            issue.issueId
        ),
        lawAnchorCount: normalizedPlan.lawAnchors.filter((anchor) =>
            anchor.issueIds.includes(issue.issueId)).length,
        ordinanceAnchorCount: normalizedPlan.ordinanceAnchors.filter((anchor) =>
            anchor.issueIds.includes(issue.issueId)).length,
        caseQueryCount: normalizedPlan.caseQueries.filter((query) =>
            query.issueIds.includes(issue.issueId)).length,
    }));
    return {
        normalizedPlan,
        normalizedPlanHash: hashLegalResearchPlanV1(normalizedPlan),
        reviewStatus: 'mechanically_validated_controlled_taxonomy_not_legal_reviewed' as const,
        allIssuesQuestionMatched: issues.every((issue) =>
            issue.questionMatchedTerms.length > 0),
        allIssuesLawCovered: issues.every((issue) => issue.lawAnchorCount > 0),
        allIssuesCaseCovered: issues.every((issue) => issue.caseQueryCount > 0),
        issues,
    };
}
