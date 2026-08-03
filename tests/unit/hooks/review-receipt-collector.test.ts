import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import type { RejectedReviewReceipt } from '../../../src/hooks/review-receipt';
import {
	_internals,
	collectReviewerReceiptAfter as collectReviewerReceiptAfterRaw,
	parseReviewerOutput,
} from '../../../src/hooks/review-receipt-collector';
import { createFindingValidationScheduler } from '../../../src/review/finding-validator';

let tmpDir: string;
const originalResolveReviewerTaskScope = _internals.resolveReviewerTaskScope;
const enabledConfig = resolveAutoReviewConfig({ enabled: true });
const validationScheduler = createFindingValidationScheduler();
async function collectReviewerReceiptAfter(
	...args: Parameters<typeof collectReviewerReceiptAfterRaw>
): Promise<string | null> {
	return collectReviewerReceiptAfterRaw(
		args[0],
		args[1],
		args[2],
		args[3] ?? { config: enabledConfig },
	);
}
beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-collector-')),
	);
	_internals.resolveReviewerTaskScope = async () => ({
		content: 'opencode-swarm-reviewer-task-scope-v1\nfixture\n',
		description: 'reviewer-task-files-v1',
		files: ['src/fixture.ts'],
	});
});

afterEach(() => {
	_internals.resolveReviewerTaskScope = originalResolveReviewerTaskScope;
	validationScheduler.reset();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const APPROVED_OUTPUT = [
	'VERDICT: APPROVED',
	'REUSE_RE_VERIFICATION: SKIPPED (no new exports)',
	'RISK: LOW',
	'ISSUES: none',
	'SKILL_COMPLIANCE: COMPLIANT — all rules followed',
	'DIRECTIVE_COMPLIANCE: none',
	'NO ISSUES FOUND — Reviewed 2 changed functions.',
].join('\n');

const REJECTED_OUTPUT = [
	'VERDICT: REJECTED',
	'REUSE_RE_VERIFICATION: SKIPPED',
	'RISK: HIGH',
	'ISSUES:',
	'- [HIGH] src/utils/parse.ts:42 off-by-one in loop bound drops the last element',
	'- [MEDIUM] missing null check on optional input',
	'SKILL_COMPLIANCE: COMPLIANT',
	'DIRECTIVE_COMPLIANCE: none',
	'FIXES:',
	'- change `< len - 1` to `< len` at src/utils/parse.ts:42',
	'- guard `input?.value` before dereference',
].join('\n');

const STRUCTURED_REJECTED_OUTPUT = [
	'VERDICT: REJECTED',
	'REUSE_RE_VERIFICATION: SKIPPED',
	'RISK: HIGH',
	'ISSUES: none (see structured findings)',
	'DIRECTIVE_COMPLIANCE: none',
	'FIXES: correct the loop bound',
	'```json',
	JSON.stringify({
		findings: [
			{
				title: 'Final record is dropped',
				body: 'The loop exits before processing the final record.',
				severity: 'high',
				confidence: 0.93,
				file: 'src/utils/parse.ts',
				line_start: 42,
				line_end: 43,
			},
		],
		verdict: 'REJECTED',
		overall_confidence: 0.91,
	}),
	'```',
].join('\n');

// Mirrors the real field order mandated by src/agents/reviewer.ts's OUTPUT
// FORMAT block: ISSUES is immediately followed by ACCEPTANCE_SATISFACTION,
// then TASK, then SKILL_COMPLIANCE. Regression coverage for the bug where
// ACCEPTANCE_SATISFACTION (and the TASK line after it) were swallowed into
// the ISSUES section because ACCEPTANCE_SATISFACTION was missing from
// SECTION_FIELDS.
const APPROVED_WITH_ACCEPTANCE_OUTPUT = [
	'VERDICT: APPROVED',
	'REUSE_RE_VERIFICATION: SKIPPED (no new exports)',
	'RISK: LOW',
	'ISSUES: none',
	'ACCEPTANCE_SATISFACTION: SATISFIED - FR-002 implemented at src/foo.ts:10',
	'TASK: 2.2',
	'SKILL_COMPLIANCE: COMPLIANT — all rules followed',
	'DIRECTIVE_COMPLIANCE: none',
	'FIXES: none',
].join('\n');

describe('parseReviewerOutput', () => {
	test('parses an APPROVED verdict with risk and empty issues', () => {
		const parsed = parseReviewerOutput(APPROVED_OUTPUT);
		expect(parsed).not.toBeNull();
		expect(parsed?.verdict).toBe('approved');
		expect(parsed?.risk).toBe('LOW');
		expect(parsed?.issues).toEqual([]);
		expect(parsed?.fixes).toEqual([]);
	});

	test('parses a REJECTED verdict with issues, severities, locations, and fixes', () => {
		const parsed = parseReviewerOutput(REJECTED_OUTPUT);
		expect(parsed?.verdict).toBe('rejected');
		expect(parsed?.risk).toBe('HIGH');
		expect(parsed?.issues).toHaveLength(2);
		expect(parsed?.issues[0].severity).toBe('high');
		expect(parsed?.issues[0].location).toBe('src/utils/parse.ts:42');
		expect(parsed?.issues[1].severity).toBe('medium');
		expect(parsed?.issues[1].location).toBeUndefined();
		expect(parsed?.fixes).toHaveLength(2);
		expect(parsed?.fixes[0]).toContain('src/utils/parse.ts:42');
	});

	test('is case-insensitive and tolerates surrounding prose', () => {
		const parsed = parseReviewerOutput(
			'Here is my review.\n\nverdict: approved\nrisk: medium\n',
		);
		expect(parsed?.verdict).toBe('approved');
		expect(parsed?.risk).toBe('MEDIUM');
	});

	test('returns null when no VERDICT line exists', () => {
		expect(parseReviewerOutput('Looks good to me!')).toBeNull();
		expect(parseReviewerOutput('')).toBeNull();
	});

	test('regression 1a: mid-line quoted VERDICT tokens do not override the anchored verdict', () => {
		// Previous code used an unanchored first-match regex, so a reviewer
		// quoting evidence like a test fixture containing 'VERDICT: APPROVED'
		// before its real REJECTED verdict produced a false APPROVED receipt
		// and suppressed the rejection advisory.
		const quoted = [
			"Citing tests/fixtures.ts:154: const APPROVED = 'VERDICT: APPROVED' is a fixture.",
			'I could not find the mandated VERDICT: APPROVED line behavior to be correct.',
			'',
			'VERDICT: REJECTED',
			'RISK: HIGH',
		].join('\n');
		const parsed = parseReviewerOutput(quoted);
		expect(parsed?.verdict).toBe('rejected');
		expect(parsed?.risk).toBe('HIGH');
	});

	test('regression 1a: diff context lines (+/-) never count as verdict lines', () => {
		const diffEcho = [
			'+const APPROVED = "VERDICT: APPROVED";',
			'-const REJECTED = "VERDICT: REJECTED";',
			'VERDICT: APPROVED',
		].join('\n');
		expect(parseReviewerOutput(diffEcho)?.verdict).toBe('approved');
	});

	test('regression 1a: format-spec line VERDICT: APPROVED | REJECTED does not match — actual VERDICT: REJECTED wins', () => {
		// The \s*$ trailing anchor (finding 1b fix) ensures that the format-spec
		// line "VERDICT: APPROVED | REJECTED" does NOT match the pattern (the
		// "| REJECTED" suffix prevents \s*$ from anchoring). Previously, without
		// \s*$, the line matched as APPROVED, disagreed with REJECTED, and returned
		// null — silently suppressing the real rejection (fail-open). Now the
		// format-spec line is simply ignored and the real verdict is returned.
		const quoted = [
			'VERDICT: APPROVED | REJECTED', // format-spec line — must NOT match
			'My actual conclusion:',
			'VERDICT: REJECTED',
		].join('\n');
		expect(parseReviewerOutput(quoted)?.verdict).toBe('rejected');
	});

	test('regression 1a: two truly disagreeing anchored verdict lines are ambiguous → null', () => {
		const ambiguous = [
			'VERDICT: APPROVED',
			'My actual conclusion:',
			'VERDICT: REJECTED',
		].join('\n');
		expect(parseReviewerOutput(ambiguous)).toBeNull();
	});

	test('duplicate agreeing anchored verdict lines are ambiguous', () => {
		const repeated = ['VERDICT: REJECTED', 'notes', 'VERDICT: REJECTED'].join(
			'\n',
		);
		expect(parseReviewerOutput(repeated)).toBeNull();
	});

	test('markdown-bold verdict lines are recognized', () => {
		expect(parseReviewerOutput('**VERDICT**: APPROVED')?.verdict).toBe(
			'approved',
		);
	});

	test('does not match partial words like VERDICT: APPROVEDISH', () => {
		expect(parseReviewerOutput('VERDICT: APPROVEDISH')).toBeNull();
	});

	test('regression: ACCEPTANCE_SATISFACTION and TASK lines between ISSUES and SKILL_COMPLIANCE do not leak into issues', () => {
		const parsed = parseReviewerOutput(APPROVED_WITH_ACCEPTANCE_OUTPUT);
		expect(parsed).not.toBeNull();
		expect(parsed?.verdict).toBe('approved');
		// ISSUES: none -> empty issues array, not swallowing ACCEPTANCE_SATISFACTION/TASK
		expect(parsed?.issues).toEqual([]);
		// FIXES: none -> empty fixes array, unaffected by the new section
		expect(parsed?.fixes).toEqual([]);
	});

	test('regression: real ISSUES content is not extended by a following ACCEPTANCE_SATISFACTION section', () => {
		const rejectedWithAcceptance = [
			'VERDICT: REJECTED',
			'REUSE_RE_VERIFICATION: SKIPPED',
			'RISK: HIGH',
			'ISSUES:',
			'- [HIGH] src/utils/parse.ts:42 off-by-one in loop bound drops the last element',
			'ACCEPTANCE_SATISFACTION: NOT_SATISFIED - FR-002 not implemented (no corresponding implementation found)',
			'TASK: 2.2',
			'SKILL_COMPLIANCE: COMPLIANT',
			'DIRECTIVE_COMPLIANCE: none',
			'FIXES:',
			'- implement FR-002 at src/foo.ts',
		].join('\n');
		const parsed = parseReviewerOutput(rejectedWithAcceptance);
		expect(parsed?.verdict).toBe('rejected');
		// Only the single real ISSUES line — ACCEPTANCE_SATISFACTION/TASK content
		// must not be appended to the ISSUES collection.
		expect(parsed?.issues).toHaveLength(1);
		expect(parsed?.issues[0].text).toContain('off-by-one');
		expect(
			parsed?.issues.some((i) => i.text.includes('ACCEPTANCE_SATISFACTION')),
		).toBe(false);
		expect(parsed?.issues.some((i) => i.text.includes('NOT_SATISFIED'))).toBe(
			false,
		);
		expect(parsed?.issues.some((i) => i.text.startsWith('TASK'))).toBe(false);
		// FIXES section still parses correctly after the new section.
		expect(parsed?.fixes).toHaveLength(1);
		expect(parsed?.fixes[0]).toContain('src/foo.ts');
	});

	test('prefers structured findings over the legacy ISSUES fallback', () => {
		const parsed = parseReviewerOutput(STRUCTURED_REJECTED_OUTPUT);
		expect(parsed?.verdict).toBe('rejected');
		expect(parsed?.outputMode).toBe('structured');
		expect(parsed?.overallConfidence).toBe(0.91);
		expect(parsed?.fixes).toEqual(['correct the loop bound']);
		expect(parsed?.issues).toEqual([
			{
				text: 'Final record is dropped: The loop exits before processing the final record.',
				severity: 'high',
				location: 'src/utils/parse.ts:42',
				finding: {
					title: 'Final record is dropped',
					body: 'The loop exits before processing the final record.',
					severity: 'high',
					confidence: 0.93,
					file: 'src/utils/parse.ts',
					line_start: 42,
					line_end: 43,
				},
			},
		]);
	});

	test.each([
		[
			'contradictory',
			STRUCTURED_REJECTED_OUTPUT.replace(
				'VERDICT: REJECTED',
				'VERDICT: APPROVED',
			),
		],
		['duplicate', `VERDICT: REJECTED\n${STRUCTURED_REJECTED_OUTPUT}`],
		['missing', STRUCTURED_REJECTED_OUTPUT.replace('VERDICT: REJECTED\n', '')],
	])('rejects %s legacy verdicts beside valid structured output', (_name, output) => {
		expect(parseReviewerOutput(output)).toBeNull();
	});

	test('falls back to legacy parsing when a structured block is malformed', () => {
		const output = `${REJECTED_OUTPUT}\n\`\`\`json\n{"findings":"bad"}\n\`\`\``;
		const parsed = parseReviewerOutput(output);
		expect(parsed?.outputMode).toBe('legacy');
		expect(parsed?.issues).toHaveLength(2);
		expect(parsed?.issues[0].location).toBe('src/utils/parse.ts:42');
	});
});

describe('collectReviewerReceiptAfter', () => {
	const reviewerArgs = (prompt: string) => ({
		subagent_type: 'reviewer',
		prompt,
	});

	test('persists an approved receipt for a returning reviewer Task', async () => {
		const receiptPath = await collectReviewerReceiptAfter(
			tmpDir,
			{ tool: 'Task', args: reviewerArgs('TASK: Review x'), sessionID: 's1' },
			{ output: APPROVED_OUTPUT },
		);
		expect(receiptPath).not.toBeNull();
		const receipt = JSON.parse(fs.readFileSync(receiptPath as string, 'utf-8'));
		expect(receipt.verdict).toBe('approved');
		expect(receipt.reviewer.agent).toBe('reviewer');
		expect(receipt.scope_fingerprint.scope_description).toBe(
			'reviewer-task-files-v1',
		);
		// Index updated
		const index = JSON.parse(
			fs.readFileSync(
				path.join(tmpDir, '.swarm', 'review-receipts', 'index.json'),
				'utf-8',
			),
		);
		expect(index.entries).toHaveLength(1);
	});

	test('persists a rejected receipt with blocking findings and pass conditions', async () => {
		const receiptPath = await collectReviewerReceiptAfter(
			tmpDir,
			{
				tool: 'Task',
				args: reviewerArgs('TASK: Review y'),
				sessionID: 's1',
			},
			{ output: REJECTED_OUTPUT },
		);
		expect(receiptPath).not.toBeNull();
		const receipt = JSON.parse(
			fs.readFileSync(receiptPath as string, 'utf-8'),
		) as RejectedReviewReceipt;
		expect(receipt.verdict).toBe('rejected');
		expect(receipt.blocking_findings).toHaveLength(2);
		expect(receipt.blocking_findings[0].severity).toBe('high');
		expect(receipt.blocking_findings[0].location).toBe('src/utils/parse.ts:42');
		expect(receipt.pass_conditions).toHaveLength(2);
	});

	test('persists additive structured fields without changing receipt schema v1', async () => {
		const receiptPath = await collectReviewerReceiptAfter(
			tmpDir,
			{
				tool: 'Task',
				args: reviewerArgs('TASK: Review structured output'),
				sessionID: 's-structured',
			},
			{ output: STRUCTURED_REJECTED_OUTPUT },
		);
		const receipt = JSON.parse(
			fs.readFileSync(receiptPath as string, 'utf-8'),
		) as RejectedReviewReceipt;
		expect(receipt.schema_version).toBe(1);
		expect(receipt.structured_findings).toHaveLength(1);
		expect(receipt.review_overall_confidence).toBe(0.91);
		expect(receipt.blocking_findings[0]).toMatchObject({
			location: 'src/utils/parse.ts:42',
			title: 'Final record is dropped',
			confidence: 0.93,
			file: 'src/utils/parse.ts',
			line_start: 42,
			line_end: 43,
		});
	});

	test('validates structured HIGH findings in a separate paired critic context', async () => {
		let dispatchedAgent = '';
		const receiptPath = await collectReviewerReceiptAfter(
			tmpDir,
			{
				tool: 'Task',
				args: {
					subagent_type: 'mega_reviewer',
					prompt: 'TASK: Review structured output',
				},
				sessionID: 's-validate',
			},
			{ output: STRUCTURED_REJECTED_OUTPUT },
			{
				config: resolveAutoReviewConfig({
					enabled: true,
					validate_findings: true,
				}),
				validationScheduler,
				generatedAgentNames: ['mega_reviewer', 'mega_critic_finding_validator'],
				dispatcher: {
					async dispatch(request) {
						dispatchedAgent = request.agentName;
						const id = request.prompt.match(
							/"finding_id":\s*"([a-f0-9]{64})"/,
						)?.[1];
						const text = JSON.stringify({
							validations: [
								{
									finding_id: id,
									disposition: 'CONFIRMED',
									confidence: 0.96,
									evidence: 'The loop bound excludes the last record.',
								},
							],
						});
						return {
							status: 'completed',
							text,
							agentName: request.agentName,
							durationMs: 1,
							promptBytes: request.prompt.length,
							responseBytes: text.length,
						};
					},
				},
			},
		);
		expect(receiptPath).not.toBeNull();
		for (let attempt = 0; attempt < 20; attempt++) {
			const receipt = JSON.parse(
				fs.readFileSync(receiptPath as string, 'utf-8'),
			) as RejectedReviewReceipt;
			if (receipt.finding_validations?.length) break;
			await Bun.sleep(5);
		}
		const receipt = JSON.parse(
			fs.readFileSync(receiptPath as string, 'utf-8'),
		) as RejectedReviewReceipt;
		expect(dispatchedAgent).toBe('mega_critic_finding_validator');
		expect(receipt.finding_validations?.[0].disposition).toBe('CONFIRMED');
		expect(receipt.blocking_findings[0].validator_disposition).toBe(
			'CONFIRMED',
		);
	});

	test('handles multi-swarm prefixed reviewer names', async () => {
		const receiptPath = await collectReviewerReceiptAfter(
			tmpDir,
			{
				tool: 'Task',
				args: { subagent_type: 'mega_reviewer', prompt: 'TASK: Review z' },
				sessionID: 's1',
			},
			{ output: APPROVED_OUTPUT },
		);
		expect(receiptPath).not.toBeNull();
	});

	test('no-op for non-Task tools, non-reviewer delegations, and unparseable output', async () => {
		expect(
			await collectReviewerReceiptAfter(
				tmpDir,
				{ tool: 'write', args: reviewerArgs('x') },
				{ output: APPROVED_OUTPUT },
			),
		).toBeNull();
		expect(
			await collectReviewerReceiptAfter(
				tmpDir,
				{ tool: 'Task', args: { subagent_type: 'coder', prompt: 'x' } },
				{ output: APPROVED_OUTPUT },
			),
		).toBeNull();
		expect(
			await collectReviewerReceiptAfter(
				tmpDir,
				{ tool: 'Task', args: reviewerArgs('x') },
				{ output: 'free-form prose with no verdict' },
			),
		).toBeNull();
		// No receipts directory created by no-ops
		expect(fs.existsSync(path.join(tmpDir, '.swarm', 'review-receipts'))).toBe(
			false,
		);
	});

	test('never throws on malformed input', async () => {
		await expect(
			collectReviewerReceiptAfter(
				tmpDir,
				{ tool: 'Task', args: null },
				{ output: 42 },
			),
		).resolves.toBeNull();
	});
});
