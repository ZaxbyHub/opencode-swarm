/**
 * #3844 closeout round 6: a review finding's FILE path is model-authored
 * free text, so it is redacted before it is persisted — but only when it
 * names no real file.
 *
 * A real repository path is not a secret, and redacting one BREAKS the
 * review: the redactor's long mixed-class base64 rule counts `/` as a
 * base64 character, so an ordinary deep path matches it — and a redacted
 * path does not resolve, so the finding silently stops anchoring (and stops
 * blocking the phase gate).
 *
 * Synthetic tokens only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import {
	_internals,
	collectReviewerReceiptAfter as collectReviewerReceiptAfterRaw,
} from '../../../src/hooks/review-receipt-collector';
import { canonicalizeValidationCandidates } from '../../../src/review/finding-validator';
import { redactReviewFilePath } from '../../../src/review/review-file-path';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const GH = `ghp_${'q'.repeat(30)}`;
const DEEP_PATH =
	'src/main/java/com/companyname/productname/module/submodule/service/impl/OAuth2TokenService.java';

let projectDir: string;
const originalResolveReviewerTaskScope = _internals.resolveReviewerTaskScope;
const enabledConfig = resolveAutoReviewConfig({ enabled: true });

function reviewerArgs(prompt: string) {
	return { subagent_type: 'reviewer', prompt };
}

beforeEach(() => {
	projectDir = canonicalMkdtemp('sw-3844-file-path-');
	_internals.resolveReviewerTaskScope = async () => ({
		content: 'opencode-swarm-reviewer-task-scope-v1\nfixture\n',
		description: 'reviewer-task-files-v1',
		files: ['src/fixture.ts'],
	});
});

afterEach(() => {
	_internals.resolveReviewerTaskScope = originalResolveReviewerTaskScope;
	fs.rmSync(projectDir, { recursive: true, force: true });
});

describe('#3844 a review finding file path is redacted only when it names no real file', () => {
	test('a path that resolves inside the project is kept verbatim', () => {
		fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
		fs.writeFileSync(path.join(projectDir, 'src', 'a.ts'), 'export {};\n');
		expect(redactReviewFilePath(projectDir, 'src/a.ts')).toBe('src/a.ts');
	});

	test('a model-invented path is redacted', () => {
		const out = redactReviewFilePath(projectDir, `src/${GH}.ts`);
		expect(out).not.toContain(GH);
		expect(out).toContain('REDACTED');
	});

	test('a path the review scope knows is real is kept verbatim', () => {
		// A RANGE diff's paths come from the resolved TARGET commit, not
		// from the checkout, so the scope knows a path the checkout does
		// not contain.
		const known = new Set([DEEP_PATH]);
		expect(redactReviewFilePath(projectDir, DEEP_PATH, known)).toBe(DEEP_PATH);
	});

	test('a LEGACY ISSUES line carries no raw token in its location', async () => {
		// A reviewer that omits the JSON block reports its findings as
		// ISSUES lines, and the location in that line is model-authored free
		// text like any other.
		const output = [
			'VERDICT: REJECTED',
			'REUSE_RE_VERIFICATION: SKIPPED',
			'RISK: HIGH',
			'ISSUES:',
			`- [HIGH] src/${GH}.ts:42 the credential is committed`,
			'SKILL_COMPLIANCE: COMPLIANT',
			'DIRECTIVE_COMPLIANCE: none',
			'FIXES:',
			'- remove the credential',
		].join('\n');

		const receiptPath = await collectReviewerReceiptAfterRaw(
			projectDir,
			{
				tool: 'Task',
				args: reviewerArgs('TASK: Review y'),
				sessionID: 's1',
			},
			{ output },
			{ config: enabledConfig },
		);
		expect(receiptPath).not.toBeNull();
		const receiptText = fs.readFileSync(receiptPath as string, 'utf-8');
		expect(receiptText).not.toContain(GH);
		const receipt = JSON.parse(receiptText);
		for (const finding of receipt.blocking_findings ?? []) {
			expect(String(finding.location)).not.toContain(GH);
		}
		for (const reference of receipt.evidence_references ?? []) {
			expect(String(reference)).not.toContain(GH);
		}
	});

	test('an APPROVED receipt redacts its structured findings too', async () => {
		const output = [
			'VERDICT: APPROVED',
			'REUSE_RE_VERIFICATION: SKIPPED (no new exports)',
			'RISK: LOW',
			'ISSUES: none (see structured findings)',
			'DIRECTIVE_COMPLIANCE: none',
			'FIXES: none',
			'```json',
			JSON.stringify({
				findings: [
					{
						title: 'hardcoded credential in a path',
						body: `the path holds ${GH}`,
						severity: 'high',
						confidence: 0.93,
						file: `src/${GH}.ts`,
						line_start: 42,
						line_end: 43,
					},
				],
				verdict: 'APPROVED',
				overall_confidence: 0.91,
			}),
			'```',
		].join('\n');

		const receiptPath = await collectReviewerReceiptAfterRaw(
			projectDir,
			{
				tool: 'Task',
				args: reviewerArgs('TASK: Review z'),
				sessionID: 's1',
			},
			{ output },
			{ config: enabledConfig },
		);
		expect(receiptPath).not.toBeNull();
		const receiptText = fs.readFileSync(receiptPath as string, 'utf-8');
		expect(receiptText).not.toContain(GH);
	});

	test('the collector finding id describes the PERSISTED finding', async () => {
		// The id is a hash of the title, the body and the file, so it must
		// be derived from the SAME (redacted) payload the receipt persists.
		const output = [
			'VERDICT: REJECTED',
			'REUSE_RE_VERIFICATION: SKIPPED',
			'RISK: HIGH',
			'ISSUES: none (see structured findings)',
			'DIRECTIVE_COMPLIANCE: none',
			'FIXES: remove the credential',
			'```json',
			JSON.stringify({
				findings: [
					{
						title: 'hardcoded credential',
						body: `the path holds ${GH}`,
						severity: 'high',
						confidence: 0.93,
						file: `src/${GH}.ts`,
						line_start: 42,
						line_end: 43,
					},
				],
				verdict: 'REJECTED',
				overall_confidence: 0.91,
			}),
			'```',
		].join('\n');

		const receiptPath = await collectReviewerReceiptAfterRaw(
			projectDir,
			{
				tool: 'Task',
				args: reviewerArgs('TASK: Review w'),
				sessionID: 's1',
			},
			{ output },
			{ config: enabledConfig },
		);
		expect(receiptPath).not.toBeNull();
		const receipt = JSON.parse(fs.readFileSync(receiptPath as string, 'utf-8'));
		const persisted = (receipt.structured_findings ?? [])[0];
		expect(persisted).toBeDefined();
		const [canonical] = canonicalizeValidationCandidates([persisted]);
		const blocking = (receipt.blocking_findings ?? [])[0];
		expect(blocking.finding_id).toBe(canonical.finding_id);
	});

	test('the persisted reviewer receipt carries no raw token in its file or location', async () => {
		const output = [
			'VERDICT: REJECTED',
			'REUSE_RE_VERIFICATION: SKIPPED',
			'RISK: HIGH',
			'ISSUES: none (see structured findings)',
			'DIRECTIVE_COMPLIANCE: none',
			'FIXES: remove the credential',
			'```json',
			JSON.stringify({
				findings: [
					{
						title: 'hardcoded credential in a path',
						body: `the path holds ${GH}`,
						severity: 'high',
						confidence: 0.93,
						file: `src/${GH}.ts`,
						line_start: 42,
						line_end: 43,
					},
				],
				verdict: 'REJECTED',
				overall_confidence: 0.91,
			}),
			'```',
		].join('\n');

		const receiptPath = await collectReviewerReceiptAfterRaw(
			projectDir,
			{
				tool: 'Task',
				args: reviewerArgs('TASK: Review x'),
				sessionID: 's1',
			},
			{ output },
			{ config: enabledConfig },
		);
		expect(receiptPath).not.toBeNull();
		const receiptText = fs.readFileSync(receiptPath as string, 'utf-8');
		expect(receiptText).not.toContain(GH);
		const receipt = JSON.parse(receiptText);
		for (const finding of receipt.blocking_findings ?? []) {
			expect(String(finding.location)).not.toContain(GH);
			expect(String(finding.file)).not.toContain(GH);
		}
		for (const finding of receipt.structured_findings ?? []) {
			expect(String(finding.file)).not.toContain(GH);
		}
	});
});
