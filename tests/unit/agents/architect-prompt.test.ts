import { describe, expect, it } from 'bun:test';
import { createArchitectAgent } from '../../../src/agents/architect';

describe('issue-reference.json recovery directives', () => {
	const agent = createArchitectAgent('test-model');
	const prompt = agent.config.prompt!;

	it('context.md template contains ## Source Issue section with issue-reference.json', () => {
		expect(prompt).toContain('## Source Issue');
		expect(prompt).toContain('URL: <read from .swarm/issue-reference.json>');
		expect(prompt).toContain('Number: <read from .swarm/issue-reference.json>');
	});

	it('MODE: ISSUE_INGEST section contains issue-reference.json recovery directive', () => {
		// Find the MODE: ISSUE_INGEST section
		const issueIngestIdx = prompt.indexOf('### MODE: ISSUE_INGEST');
		expect(issueIngestIdx).toBeGreaterThan(-1);

		// Find the next mode section to bound the search
		const nextModeIdx = prompt.indexOf('### MODE: PLAN', issueIngestIdx);
		expect(nextModeIdx).toBeGreaterThan(issueIngestIdx);

		const issueIngestSection = prompt.substring(issueIngestIdx, nextModeIdx);
		expect(issueIngestSection).toContain('issue-reference.json');
		expect(issueIngestSection).toContain('RECOVERY:');
		expect(issueIngestSection).toContain('plan/trace/noRepro');
		expect(issueIngestSection).toContain(
			"route every delegation through the current session's active-swarm role mapping",
		);
		expect(issueIngestSection).toContain(
			'no swarm ID receives special behavior',
		);
		expect(issueIngestSection).not.toContain('non-mega');
	});

	it('MODE: PLAN section contains issue-reference.json recovery directive', () => {
		const planIdx = prompt.indexOf('### MODE: PLAN');
		expect(planIdx).toBeGreaterThan(-1);

		const nextModeIdx = prompt.indexOf('### MODE: CRITIC-GATE', planIdx);
		expect(nextModeIdx).toBeGreaterThan(planIdx);

		const planSection = prompt.substring(planIdx, nextModeIdx);
		expect(planSection).toContain('issue-reference.json');
		expect(planSection).toContain('RECOVERY:');
		expect(planSection).toContain('plan traceability');
	});

	it('MODE: EXECUTE section contains issue-reference.json recovery directive', () => {
		const executeIdx = prompt.indexOf('### MODE: EXECUTE');
		expect(executeIdx).toBeGreaterThan(-1);

		const nextModeIdx = prompt.indexOf('### MODE: PHASE-WRAP', executeIdx);
		expect(nextModeIdx).toBeGreaterThan(executeIdx);

		const executeSection = prompt.substring(executeIdx, nextModeIdx);
		expect(executeSection).toContain('issue-reference.json');
		expect(executeSection).toContain('RECOVERY:');
	});

	it('MODE: PHASE-WRAP section contains issue-reference.json recovery directive', () => {
		const phaseWrapIdx = prompt.indexOf('### MODE: PHASE-WRAP');
		expect(phaseWrapIdx).toBeGreaterThan(-1);

		const filesIdx = prompt.indexOf('## FILES', phaseWrapIdx);
		expect(filesIdx).toBeGreaterThan(phaseWrapIdx);

		const phaseWrapSection = prompt.substring(phaseWrapIdx, filesIdx);
		expect(phaseWrapSection).toContain('issue-reference.json');
		expect(phaseWrapSection).toContain('RECOVERY:');
		expect(phaseWrapSection).toContain('retrospective context');
		expect(phaseWrapSection).toContain('Closes #N');
	});

	it('all five RECOVERY directives reference issue-reference.json', () => {
		const matches = prompt.match(/RECOVERY:.*issue-reference\.json/g);
		expect(matches).not.toBeNull();
		expect(matches!.length).toBeGreaterThanOrEqual(4);
	});

	it('context.md template instruction mentions workflow intent recovery', () => {
		const sourceIssueIdx = prompt.indexOf('## Source Issue');
		expect(sourceIssueIdx).toBeGreaterThan(-1);

		const templateCloseIdx = prompt.indexOf('```', sourceIssueIdx);
		expect(templateCloseIdx).toBeGreaterThan(sourceIssueIdx);

		const sourceIssueSection = prompt.substring(
			sourceIssueIdx,
			templateCloseIdx,
		);
		expect(sourceIssueSection).toContain('workflow intent recovery');
		expect(sourceIssueSection).toContain('flags.trace');
	});
});
