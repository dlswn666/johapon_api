import {
    LEGAL_DISCLAIMER,
    type CaseShortfallReasonV1,
    type LegalAnswerV1,
    type LegalResearchPacketV1,
    type LegalSourceV1,
    type ProvisionLocatorV1,
    type RenderedLegalAnswerV1,
} from './model';
import {
    LegalContractValidationError,
    assertLegalAnswerV1,
    validateLegalAnswerMarkdownV1,
} from './validator';

function compactText(value: string): string {
    return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function escapeMarkdownText(value: string): string {
    return compactText(value)
        .replace(/\\/g, '\\\\')
        .replace(/([\[\]*_`<>])/g, '\\$1');
}

function escapeLinkLabel(value: string): string {
    return compactText(value)
        .replace(/\\/g, '\\\\')
        .replace(/([\[\]])/g, '\\$1');
}

function compareText(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

function sourceTypeOrder(source: LegalSourceV1): number {
    if (source.sourceType === 'law') return 0;
    if (source.sourceType === 'ordinance') return 1;
    return 2;
}

function sortSources(sources: readonly LegalSourceV1[]): LegalSourceV1[] {
    return [...sources].sort((left, right) => {
        const typeComparison = sourceTypeOrder(left) - sourceTypeOrder(right);
        if (typeComparison !== 0) return typeComparison;
        return compareText(left.sourceId, right.sourceId);
    });
}

function renderBullets(lines: string[]): string {
    if (lines.length === 0) return '해당 없음';
    return lines.map((line) => `- ${line}`).join('\n');
}

function formatLocator(locator: ProvisionLocatorV1): string {
    const parts = [
        locator.article,
        locator.paragraph,
        locator.item,
        locator.subitem,
        locator.addendum,
        locator.appendix,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return parts.map(escapeMarkdownText).join(' ');
}

function sourceLink(source: LegalSourceV1): string {
    return `[${escapeLinkLabel(source.title)}](${source.officialUrl})`;
}

function renderSourceRefs(sourceIds: readonly string[], sourceMap: Map<string, LegalSourceV1>): string {
    return [...sourceIds]
        .sort(compareText)
        .map((sourceId) => {
            const source = sourceMap.get(sourceId);
            return source
                ? `[${escapeLinkLabel(sourceId)}](${source.officialUrl})`
                : escapeMarkdownText(sourceId);
        })
        .join(', ');
}

function renderEvidenceQuotes(
    evidenceQuotes: LegalAnswerV1['conclusion']['evidenceQuotes'],
    sourceMap: Map<string, LegalSourceV1>
): string {
    if (evidenceQuotes.length === 0) return '';
    return evidenceQuotes.map((evidence) => {
        const source = sourceMap.get(evidence.sourceId);
        const label = source
            ? `[${escapeLinkLabel(evidence.sourceId)}](${source.officialUrl})`
            : escapeMarkdownText(evidence.sourceId);
        return `${label} “${escapeMarkdownText(evidence.quote)}”`;
    }).join('; ');
}

function shortfallLabel(reason: CaseShortfallReasonV1 | null): string {
    switch (reason) {
        case null:
            return '해당 없음';
        case 'official_results_exhausted':
            return '관련성 기준을 충족한 공식 검색 결과가 더 없음';
        case 'upstream_incomplete':
            return '공식 상류 조회가 완료되지 않음';
        case 'full_text_unavailable':
            return '일부 후보의 판례 전문을 확인할 수 없음';
        case 'current_law_misaligned':
            return '일부 후보가 현행 규정과 동일·동등하지 않음';
    }
}

function researchStatusLabel(status: LegalAnswerV1['status']): string {
    switch (status) {
        case 'complete':
            return 'complete (조사 계약 완료)';
        case 'partial':
            return 'partial (공식 상류 조회 미완료)';
        case 'clarification_required':
            return 'clarification_required (사용자 확인 필요)';
        case 'temporal_scope_conflict':
            return 'temporal_scope_conflict (과거 시행본 또는 미래 사건일 검토 필요)';
        case 'insufficient_evidence':
            return 'insufficient_evidence (근거 부족)';
    }
}

function renderConclusion(answer: LegalAnswerV1, sourceMap: Map<string, LegalSourceV1>): string {
    const kind = answer.conclusion.kind === 'supported'
        ? '근거 확인'
        : answer.conclusion.kind === 'conditional'
            ? '조건부 판단'
            : '결론 유보';
    const sources = answer.conclusion.sourceIds.length > 0
        ? ` (근거: ${renderSourceRefs(answer.conclusion.sourceIds, sourceMap)})`
        : '';
    const evidence = renderEvidenceQuotes(answer.conclusion.evidenceQuotes, sourceMap);
    return renderBullets([
        `조사 상태: ${researchStatusLabel(answer.status)}`,
        `${kind}: ${escapeMarkdownText(answer.conclusion.text)}${sources}`,
        ...(evidence ? [`결론 원문 인용: ${evidence}`] : []),
    ]);
}

function renderScope(answer: LegalAnswerV1): string {
    const authorities = [...answer.scope.localAuthorities]
        .sort((left, right) => compareText(`${left.code}:${left.name}`, `${right.code}:${right.name}`))
        .map((authority) => `${authority.name} (${authority.code})`)
        .join(', ');
    return renderBullets([
        `적용 기준일: ${answer.scope.asOfDate}`,
        `사건일: ${answer.scope.eventDate ?? '미제공'}`,
        `관할: ${authorities || '미확인'}`,
        `법령 버전 정책: 현재 시행본만 사용 (${answer.scope.lawVersionPolicy})`,
    ]);
}

function renderFacts(answer: LegalAnswerV1): string {
    const originLabel = {
        user: '사용자 제공',
        official_record: '공식 기록',
        assumption: '가정',
    } as const;
    const verificationLabel = {
        verified: '확인',
        unverified: '미확인',
        disputed: '다툼 있음',
    } as const;
    return renderBullets(
        [...answer.facts]
            .sort((left, right) => compareText(left.factId, right.factId))
            .map((fact) =>
                `[${escapeMarkdownText(fact.factId)}] ${escapeMarkdownText(fact.text)}`
                + ` — ${originLabel[fact.origin]}, ${verificationLabel[fact.verification]}`)
    );
}

function renderLaws(answer: LegalAnswerV1, sourceMap: Map<string, LegalSourceV1>): string {
    const laws = sortSources(answer.sourceIndex).filter((source) => source.sourceType === 'law');
    const sourceLines = laws.map((law) =>
        `[${escapeMarkdownText(law.sourceId)}] ${sourceLink(law)}`
        + ` — 시행 ${law.articleEffectiveFrom ?? law.effectiveFrom}; ${formatLocator(law.provision)}`);
    const claimLines = [...answer.ruleClaims]
        .sort((left, right) => compareText(left.claimId, right.claimId))
        .map((claim) =>
            `${escapeMarkdownText(claim.text)} (근거: ${renderSourceRefs(claim.sourceIds, sourceMap)}; `
            + `원문: ${renderEvidenceQuotes(claim.evidenceQuotes, sourceMap)})`);
    return renderBullets([...sourceLines, ...claimLines]);
}

function renderOrdinances(answer: LegalAnswerV1, sourceMap: Map<string, LegalSourceV1>): string {
    const ordinances = sortSources(answer.sourceIndex)
        .filter((source) => source.sourceType === 'ordinance');
    const sourceLines = ordinances.map((ordinance) =>
        `[${escapeMarkdownText(ordinance.sourceId)}] ${sourceLink(ordinance)}`
        + ` — ${escapeMarkdownText(ordinance.localAuthority.name)}`
        + ` (${escapeMarkdownText(ordinance.localAuthority.code)}), 시행 ${ordinance.articleEffectiveFrom ?? ordinance.effectiveFrom};`
        + ` ${formatLocator(ordinance.provision)}`);
    const analysisLines = [...answer.ordinanceAnalysis]
        .sort((left, right) => compareText(left.analysisId, right.analysisId))
        .map((analysis) =>
            `${escapeMarkdownText(analysis.text)} (근거: ${renderSourceRefs(analysis.sourceIds, sourceMap)}; `
            + `원문: ${renderEvidenceQuotes(analysis.evidenceQuotes, sourceMap)})`);
    return renderBullets([...sourceLines, ...analysisLines]);
}

function renderCases(answer: LegalAnswerV1, sourceMap: Map<string, LegalSourceV1>): string {
    const lines: string[] = [
        `반환 판례: ${answer.caseSynthesis.returnedCount}건 (최대 10건)`,
        answer.caseSynthesis.upstreamComplete
            ? '계획된 법령명·쟁점 검색 stream 내 최신순 완결성: 검증됨'
            : '계획된 법령명·쟁점 검색 stream 내 최신순 완결성: 미완료 — 반환 목록은 확보된 후보 안에서만 최신순이며 해당 stream의 최신 10건을 증명하지 못함',
        `검색계획 hash: ${escapeMarkdownText(answer.caseSynthesis.searchScope.normalizedPlanHash)}`,
        `법령명 stream: ${answer.caseSynthesis.searchScope.lawNameQueries.map(escapeMarkdownText).join(', ') || '없음'}`,
        `쟁점 stream: ${answer.caseSynthesis.searchScope.issueQueries.map(escapeMarkdownText).join(', ') || '없음'}`,
    ];
    if (answer.caseSynthesis.summary.trim()) {
        lines.push(`종합: ${escapeMarkdownText(answer.caseSynthesis.summary)}`);
    }
    const caseEvidence = renderEvidenceQuotes(answer.caseSynthesis.evidenceQuotes, sourceMap);
    if (caseEvidence) lines.push(`판례 종합 원문 인용: ${caseEvidence}`);
    answer.caseSynthesis.sourceIds.forEach((sourceId, index) => {
        const source = sourceMap.get(sourceId);
        if (!source || source.sourceType !== 'case') return;
        const fitLabel = source.currentLawFit === 'verified_same_rule'
            ? '현행 규정 동일성 확인'
            : '현행 규정 관련 후보(공식 판례 데이터에 규정 버전 ID 없음)';
        lines.push(
            `${index + 1}. ${sourceLink(source)} — ${source.decisionDate}, `
            + `${escapeMarkdownText(source.court)} ${escapeMarkdownText(source.caseNumber)}; `
            + `${escapeMarkdownText(source.holding)}; ${fitLabel}`
        );
    });
    if (answer.caseSynthesis.returnedCount < 10) {
        lines.push(`10건 미만 사유: ${shortfallLabel(answer.caseSynthesis.shortfallReason)}`);
    }
    return renderBullets(lines);
}

function renderApplications(answer: LegalAnswerV1, sourceMap: Map<string, LegalSourceV1>): string {
    return renderBullets(
        [...answer.applications]
            .sort((left, right) => compareText(left.applicationId, right.applicationId))
            .map((application) =>
                `${escapeMarkdownText(application.issue)}: ${escapeMarkdownText(application.result)} `
                + `(추론: ${escapeMarkdownText(application.inference)}; `
                + `근거: ${renderSourceRefs(application.sourceIds, sourceMap)}; `
                + `원문: ${renderEvidenceQuotes(application.evidenceQuotes, sourceMap)}; `
                + `시점: ${application.temporalApplicability}; 확실성: ${application.confidence})`)
    );
}

function renderTemporalReview(answer: LegalAnswerV1, sourceMap: Map<string, LegalSourceV1>): string {
    const eventDateMissing = answer.scope.eventDate === null;
    const sources = !eventDateMissing && answer.temporalReview.sourceIds.length > 0
        ? ` (근거: ${renderSourceRefs(answer.temporalReview.sourceIds, sourceMap)})`
        : '';
    const evidence = eventDateMissing
        ? ''
        : renderEvidenceQuotes(answer.temporalReview.evidenceQuotes, sourceMap);
    const summary = eventDateMissing
        ? '사건일이 제공되지 않아 사건 당시 시행본 추가 확인 필요 여부를 판단할 수 없습니다.'
        : answer.temporalReview.summary;
    const historicalLawReview = eventDateMissing
        ? '판단 불가 (사건일 미제공)'
        : answer.temporalReview.historicalLawRequired ? '예' : '아니오';
    return renderBullets([
        `${escapeMarkdownText(summary)}${sources}`,
        ...(evidence ? [`시점 검토 원문 인용: ${evidence}`] : []),
        `과거 법령 추가 확인 필요: ${historicalLawReview}`,
    ]);
}

function renderUnknowns(answer: LegalAnswerV1): string {
    const unknownLines = [...answer.unknowns]
        .sort((left, right) => compareText(`${left.code}:${left.text}`, `${right.code}:${right.text}`))
        .map((unknown) =>
            `[${escapeMarkdownText(unknown.code)}] ${escapeMarkdownText(unknown.text)}`
            + ` — 영향: ${escapeMarkdownText(unknown.impact)}`
            + `${unknown.blocking ? ' (결론 차단)' : ''}`);
    const warningLines = [...answer.warnings]
        .sort((left, right) => compareText(`${left.code}:${left.text}`, `${right.code}:${right.text}`))
        .map((warning) => `[경고 ${escapeMarkdownText(warning.code)}] ${escapeMarkdownText(warning.text)}`);
    return renderBullets([...unknownLines, ...warningLines]);
}

function renderSources(answer: LegalAnswerV1): string {
    return renderBullets(
        sortSources(answer.sourceIndex).map((source) => {
            const detail = source.sourceType === 'case'
                ? `${source.court} ${source.caseNumber}, ${source.decisionDate}`
                : source.sourceType === 'ordinance'
                    ? `${source.localAuthority.name}, 시행 ${source.articleEffectiveFrom ?? source.effectiveFrom}`
                    : `시행 ${source.articleEffectiveFrom ?? source.effectiveFrom}`;
            return `[${escapeMarkdownText(source.sourceId)}] ${sourceLink(source)}`
                + ` — ${escapeMarkdownText(detail)}; 조회 ${source.retrievedAt}`;
        })
    );
}

function buildMarkdown(answer: LegalAnswerV1): string {
    const sourceMap = new Map(answer.sourceIndex.map((source) => [source.sourceId, source]));
    const sections = [
        ['## 1. 검토 결론', renderConclusion(answer, sourceMap)],
        ['## 2. 적용 기준일·사건일·관할', renderScope(answer)],
        ['## 3. 확인된 사실과 가정', renderFacts(answer)],
        ['## 4. 현재 시행 법령', renderLaws(answer, sourceMap)],
        ['## 5. 관할 조례·규칙', renderOrdinances(answer, sourceMap)],
        ['## 6. 관련 판례', renderCases(answer, sourceMap)],
        ['## 7. 사실에 대한 적용과 판단', renderApplications(answer, sourceMap)],
        ['## 8. 소급 적용·경과조치 검토', renderTemporalReview(answer, sourceMap)],
        ['## 9. 미확인 사항과 추가 확인', renderUnknowns(answer)],
        ['## 10. 공식 출처', renderSources(answer)],
        ['## 11. 유의사항', LEGAL_DISCLAIMER],
    ];
    return [
        '# 정비사업 법률 검토',
        ...sections.flatMap(([heading, content]) => [heading, content]),
    ].join('\n\n');
}

export function renderLegalAnswerV1(answer: LegalAnswerV1): string;
export function renderLegalAnswerV1(packet: LegalResearchPacketV1, answer: LegalAnswerV1): string;
export function renderLegalAnswerV1(
    packetOrAnswer: LegalResearchPacketV1 | LegalAnswerV1,
    possibleAnswer?: LegalAnswerV1
): string {
    const answer = possibleAnswer ?? packetOrAnswer as LegalAnswerV1;
    const packet = possibleAnswer ? packetOrAnswer as LegalResearchPacketV1 : undefined;
    const validatedAnswer = assertLegalAnswerV1(answer, packet);
    const markdown = buildMarkdown(validatedAnswer);
    const markdownValidation = validateLegalAnswerMarkdownV1(markdown);
    if (!markdownValidation.ok) {
        throw new LegalContractValidationError(markdownValidation.errors);
    }
    return markdown;
}

export function buildRenderedLegalAnswerV1(
    packet: LegalResearchPacketV1,
    answer: LegalAnswerV1
): RenderedLegalAnswerV1 {
    const validatedAnswer = assertLegalAnswerV1(answer, packet);
    return {
        answer: validatedAnswer,
        contractValidationPassed: true,
        markdown: renderLegalAnswerV1(packet, validatedAnswer),
    };
}
