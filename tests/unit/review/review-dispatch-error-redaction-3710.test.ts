import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AutoReviewConfigSchema } from '../../../src/config/schema';
import type { ReviewDiffResult } from '../../../src/review/diff-source';
import { _internals, runReviewEngine } from '../../../src/review/engine';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * #3710 swarm-pr-review R-08 — the auto/final-review dispatch family is a
 * PERSISTENCE sink for provider error text.
 *
 * `runReviewEngine` dispatches the reviewer, and when that dispatch fails the
 * raw `dispatched.result.error` used to reach BOTH:
 *   - the persisted evidence (`evidence.review.error` ->
 *     `.swarm/evidence/<phase>/auto-review.json`), and
 *   - the core events log (via src/hooks/auto-review.ts).
 *
 * The fix sanitizes the detail ONCE, AFTER the `isQuotaError` classifier has
 * read the raw value (so quota/failover classification is unchanged), and uses
 * the sanitized value for both the advisory message and the persisted error.
 *
 * This test drives the REAL engine through the REAL `persistEvidence`
 * boundary (the seam is wrapped, not replaced: the original writer still runs
 * so the on-disk artifact is asserted too).
 *
 * All tokens below are synthetic.
 */

const SYNTH_TOKEN = 'sk-Synth0q9Xb2Lw4R5tY8uI1oP3sD6fG';
const SYNTH_PLACEHOLDER = '[REDACTED:openai]';
const SESSION_ID = 'sess-review-redact-3710';

let tmpDir: string;
const originalCollect = _internals.collectReviewDiff;
const originalPersist = _internals.persistEvidence;

function diffStub(): Extract<ReviewDiffResult, { status: 'ok' }> {
	const canonicalText =
		'diff --git a/src/state.ts b/src/state.ts\n@@ -9,1 +10,1 @@\n-old\n+new\n';
	return {
		status: 'ok',
		selector: { kind: 'default' },
		canonicalText,
		reviewTextBytes: canonicalText.length,
		scopeHash: 'a'.repeat(64),
		headSha: 'b'.repeat(40),
		baseRef: 'origin/main',
		baseSha: 'c'.repeat(40),
		mergeBase: 'c'.repeat(40),
		changedLines: new Map([['src/state.ts', [{ start: 10, end: 10 }]]]),
		deletedLines: new Map([['src/state.ts', [{ start: 9, end: 9 }]]]),
		files: new Map([
			[
				'src/state.ts',
				{ kind: 'modified', oldPath: 'src/state.ts', newPath: 'src/state.ts' },
			],
		]),
		completeness: { complete: true, truncated: false, skipReasons: [] },
		staleness: {
			collectedAt: '2026-01-15T12:00:00.000Z',
			headSha: 'b'.repeat(40),
			selectorKey: 'default',
			includesWorkingTree: true,
			scopeHash: 'a'.repeat(64),
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
	};
}

beforeEach(() => {
	tmpDir = canonicalMkdtemp('swarm-review-redact-3710-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	_internals.collectReviewDiff = (async () =>
		diffStub()) as unknown as typeof _internals.collectReviewDiff;
});

afterEach(() => {
	_internals.collectReviewDiff = originalCollect;
	_internals.persistEvidence = originalPersist;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('review engine dispatch failure persists redacted evidence (#3710 R-08)', () => {
	test('evidence.review.error carries the placeholder, not the token cleartext', async () => {
		const captured: { review?: { error?: string } } = {};
		const realPersist = originalPersist;
		// Wrap (do not replace) the persistence seam: the captured value is the
		// exact argument handed to the boundary, and the original writer still
		// produces the on-disk artifact.
		_internals.persistEvidence = (async (
			directory: string,
			evidence: { review?: { error?: string } },
		) => {
			captured.review = evidence.review;
			return realPersist(
				directory,
				evidence as Parameters<typeof realPersist>[1],
			);
		}) as unknown as typeof _internals.persistEvidence;

		const advisories: string[] = [];
		const result = await runReviewEngine({
			directory: tmpDir,
			sessionID: SESSION_ID,
			trigger: 'manual',
			config: AutoReviewConfigSchema.parse({
				enabled: true,
				validate_findings: false,
				final_review: { mode: 'advisory' },
			}),
			dispatcher: {
				async dispatch(request: { agentName: string; prompt: string }) {
					return {
						status: 'error' as const,
						agentName: request.agentName,
						text: '',
						error: `Provider authentication rejected: invalid API key ${SYNTH_TOKEN} for model access`,
						durationMs: 1,
						promptBytes: request.prompt.length,
						responseBytes: 0,
					};
				},
			},
			reviewerAgent: 'reviewer',
			validatorAgent: 'critic_finding_validator',
			injectAdvisory: (_sessionID: string, message: string) => {
				advisories.push(message);
			},
		} as never);

		// Fail-closed posture preserved under redaction.
		expect(result.status).toBe('error');

		const persistedError = captured.review?.error;
		expect(persistedError, 'evidence.review.error missing').toBeDefined();
		expect(
			persistedError?.includes(SYNTH_TOKEN),
			`persisted evidence error carries token cleartext: ${persistedError}`,
		).toBe(false);
		expect(persistedError).toContain(SYNTH_PLACEHOLDER);

		// The advisory message (same sanitized detail) is redacted too.
		expect(advisories.join('\n')).not.toContain(SYNTH_TOKEN);

		// The on-disk artifact is redacted as well.
		expect(result.evidencePath).toBeDefined();
		const onDisk = fs.readFileSync(result.evidencePath!, 'utf8') as string;
		expect(onDisk).not.toContain(SYNTH_TOKEN);
		expect(onDisk).toContain(SYNTH_PLACEHOLDER);
	}, 60_000);
});
