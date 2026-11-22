/**
 * #3844 closeout round 2: the auto-review evidence and the review receipt
 * persist TWO copies of one finding, and the auto-review evidence integrity
 * check compares them.
 *
 * The `finding_id` is a hash of the finding's title and body, and the check
 * RE-DERIVES it from the persisted copy. Redacting AFTER the id was derived
 * therefore left the stored id describing content that no longer existed:
 * a finding that quotes a credential (exactly what a security review
 * produces) was reported as "finding IDs or duplicate counts are invalid",
 * and the phase-completion gate failed closed on every such phase.
 *
 * These pins drive the REAL review engine end to end. Synthetic tokens only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AutoReviewConfigSchema } from '../../../src/config/schema';
import type { ReviewModelDispatcher } from '../../../src/review/contracts';
import type { ReviewDiffResult } from '../../../src/review/diff-source';
import {
	_internals as engineInternals,
	runReviewEngine,
} from '../../../src/review/engine';
import {
	autoReviewEvidenceRelativePath,
	validateAutoReviewEvidenceIntegrity,
} from '../../../src/review/evidence';
import { canonicalizeValidationCandidates } from '../../../src/review/finding-validator';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const GH = `ghp_${'q'.repeat(30)}`;
const SCOPE_HASH = 'a'.repeat(64);
const HEAD_SHA = 'b'.repeat(40);
const CANONICAL_TEXT =
	'diff --git a/src/state.ts b/src/state.ts\n@@ -9,1 +10,1 @@\n-old\n+new\n';

const originalCollect = engineInternals.collectReviewDiff;
let projectDir: string;

function diffResult(): Extract<ReviewDiffResult, { status: 'ok' }> {
	return {
		status: 'ok',
		selector: { kind: 'default' },
		canonicalText: CANONICAL_TEXT,
		reviewTextBytes: CANONICAL_TEXT.length,
		scopeHash: SCOPE_HASH,
		headSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: 'c'.repeat(40),
		mergeBase: 'c'.repeat(40),
		changedLines: new Map([['src/state.ts', [{ start: 10, end: 10 }]]]),
		deletedLines: new Map([['src/state.ts', [{ start: 9, end: 9 }]]]),
		files: new Map([
			[
				'src/state.ts',
				{
					kind: 'modified',
					oldPath: 'src/state.ts',
					newPath: 'src/state.ts',
				},
			],
		]),
		completeness: { complete: true, truncated: false, skipReasons: [] },
		staleness: {
			collectedAt: new Date().toISOString(),
			headSha: HEAD_SHA,
			selectorKey: 'default',
			includesWorkingTree: true,
			scopeHash: SCOPE_HASH,
		},
		manifest: {
			schema_version: 2,
			hash: 'd'.repeat(64),
			content_hash: 'e'.repeat(64),
			selector: { kind: 'default' },
			selector_key: 'default',
			review_target_kind: 'checkout-history-index-working-tree',
			completeness: { complete: true, truncated: false, skip_reason_codes: [] },
			path_records: [],
		},
	} as unknown as Extract<ReviewDiffResult, { status: 'ok' }>;
}

function reviewerOutput(body: string): string {
	return [
		'VERDICT: REJECTED',
		'RISK: HIGH',
		'ISSUES: none',
		'```json',
		JSON.stringify({
			findings: [
				{
					title: 'hardcoded credential',
					body,
					severity: 'high',
					confidence: 0.95,
					file: 'src/state.ts',
					line_start: 10,
					line_end: 10,
				},
			],
			verdict: 'REJECTED',
			overall_confidence: 0.95,
		}),
		'```',
	].join('\n');
}

async function runReview(body: string): Promise<{
	evidence: Record<string, unknown>;
	receiptText: string;
	evidenceText: string;
}> {
	const output = reviewerOutput(body);
	const dispatcher: ReviewModelDispatcher = {
		async dispatch(request) {
			return {
				status: 'completed' as const,
				text: output,
				agentName: request.agentName,
				durationMs: 1,
				promptBytes: request.prompt.length,
				responseBytes: output.length,
				costFields: {
					tokens_input: 10,
					tokens_output: 5,
					tokens_reasoning: 0,
					tokens_cache: 0,
					cost_usd: null,
					cost_source: 'unavailable' as const,
				},
			};
		},
	};
	await runReviewEngine({
		directory: projectDir,
		sessionID: 'auto-review-redaction-3844',
		trigger: 'phase_completion',
		phase: 1,
		config: AutoReviewConfigSchema.parse({ enabled: true }),
		dispatcher,
		reviewerAgent: 'reviewer',
		validatorAgent: 'critic_finding_validator',
		injectAdvisory: () => {},
	});
	const evidencePath = path.join(
		projectDir,
		'.swarm',
		autoReviewEvidenceRelativePath('phase_completion', SCOPE_HASH, 1),
	);
	const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
	const receiptText = fs.readFileSync(evidence.receipt_path, 'utf8');
	return {
		evidence,
		receiptText,
		evidenceText: fs.readFileSync(evidencePath, 'utf8'),
	};
}

beforeEach(() => {
	projectDir = canonicalMkdtemp('sw-3844-auto-review-');
	fs.mkdirSync(path.join(projectDir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
	fs.writeFileSync(path.join(projectDir, 'src', 'state.ts'), 'line\n'.repeat(20));
	engineInternals.collectReviewDiff = async () => diffResult();
});

afterEach(() => {
	engineInternals.collectReviewDiff = originalCollect;
	fs.rmSync(projectDir, { recursive: true, force: true });
});

describe('#3844 the auto-review evidence stays internally consistent when a finding quotes a credential', () => {
	// Both legs use a credential SHAPE the redactor rewrites: a bare family
	// token (the placeholder replaces the secret) and a key/value assignment
	// (the placeholder is inserted AFTER the key). A redactor that is not
	// idempotent changes the finding's body between the canonicalization
	// (which derives the finding_id) and the persistence, and the stored id
	// then describes content that no longer exists.
	for (const [name, body] of [
		['a bare family token', `the literal ${GH} is committed`],
		['a key/value assignment', 'the literal api_key=XYZ123 is committed'],
	] as const) {
		test(`the finding_id describes the PERSISTED content (${name})`, async () => {
			const { evidence, evidenceText, receiptText } = await runReview(body);

			// The credential is gone from BOTH persisted copies.
			expect(evidenceText.includes(GH)).toBe(false);
			expect(receiptText.includes(GH)).toBe(false);
			expect(evidenceText.includes('XYZ123')).toBe(false);
			expect(receiptText.includes('XYZ123')).toBe(false);

			const findings = evidence.findings as Array<{
				title: string;
				body: string;
				severity: string;
				confidence: number;
				file: string;
				line_start: number;
				line_end: number;
				finding_id: string;
			}>;
			const finding = findings[0];
			const [canonical] = canonicalizeValidationCandidates([
				{
					title: finding.title,
					body: finding.body,
					severity: finding.severity,
					confidence: finding.confidence,
					file: finding.file,
					line_start: finding.line_start,
					line_end: finding.line_end,
				},
			]);
			expect(finding.finding_id).toBe(canonical.finding_id);

			const integrity = validateAutoReviewEvidenceIntegrity(
				projectDir,
				evidence as never,
				{
					scopeHash: SCOPE_HASH,
					phase: 1,
					trigger: 'phase_completion',
					policy: evidence.policy as never,
					scopeContent: CANONICAL_TEXT,
				},
			);
			expect(integrity.ok).toBe(true);
		}, 30_000);
	}
});
