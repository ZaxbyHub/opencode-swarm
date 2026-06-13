/**
 * Tests for src/hooks/review-receipt-collector.ts — reviewer output parsing
 * and durable receipt persistence from returning reviewer Task delegations.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RejectedReviewReceipt } from '../../../src/hooks/review-receipt';
import {
	collectReviewerReceiptAfter,
	parseReviewerOutput,
} from '../../../src/hooks/review-receipt-collector';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-collector-')),
	);
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
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

	test('regression 1a: disagreeing anchored verdict lines are ambiguous → null', () => {
		const ambiguous = [
			'VERDICT: APPROVED | REJECTED', // quoted format spec line
			'My actual conclusion:',
			'VERDICT: REJECTED',
		].join('\n');
		expect(parseReviewerOutput(ambiguous)).toBeNull();
	});

	test('agreeing repeated anchored verdict lines parse normally', () => {
		const repeated = ['VERDICT: REJECTED', 'notes', 'VERDICT: REJECTED'].join(
			'\n',
		);
		expect(parseReviewerOutput(repeated)?.verdict).toBe('rejected');
	});

	test('markdown-bold verdict lines are recognized', () => {
		expect(parseReviewerOutput('**VERDICT**: APPROVED')?.verdict).toBe(
			'approved',
		);
	});

	test('does not match partial words like VERDICT: APPROVEDISH', () => {
		expect(parseReviewerOutput('VERDICT: APPROVEDISH')).toBeNull();
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
			'reviewer-task-prompt',
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
