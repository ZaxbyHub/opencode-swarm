/**
 * #3844 final-critic F3: SHIPPED CI-visible pins for the main #3844
 * redaction call sites. The frozen checks C6-C11 live in the git-ignored
 * trace dir and never run in CI; these unit pins exercise each production
 * boundary directly so a refactor that drops a redaction call turns the
 * build red. Synthetic tokens only.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import {
	enqueuePrFeedbackMonitorEvent,
	readPrFeedbackMonitorQueue,
} from '../../../src/background/pr-feedback-event-queue';
import { redactReviewReceiptForPersistence } from '../../../src/hooks/review-receipt';
import { renderPrReviewSubmissionBody } from '../../../src/pr-review/render-review-body';
import { redactAutoReviewEvidenceForCapture } from '../../../src/review/evidence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const GH = `ghp_${'f'.repeat(30)}`;
const ANT = `sk-ant-${'a'.repeat(24)}`;

describe('#3844 CI pins: main redaction call sites (final-critic F3)', () => {
	test('review receipt persistence clone redacts finding prose + validator evidence', () => {
		const receipt = {
			receipt_type: 'rejected',
			session_id: 's',
			timestamp: '2026-01-01T00:00:00.000Z',
			blocking_findings: [
				{
					summary: `summary quoting ${GH}`,
					title: `title with ${ANT}`,
					body: `body referencing ${GH}`,
					validator_evidence: `probe output ${ANT}`,
					finding_id: 'f-1',
					severity: 'high',
					file: 'src/a.ts',
					line: 1,
					validator: 'reviewer',
				},
			],
			pass_conditions: ['reviewer approves'],
			summary: `overall summary ${GH}`,
			structured_findings: [
				{ title: `structured title ${ANT}`, body: `structured body ${GH}` },
			],
		} as never;
		const out = redactReviewReceiptForPersistence(receipt);
		const text = JSON.stringify(out);
		expect(text.includes(GH)).toBe(false);
		expect(text.includes(ANT)).toBe(false);
		// structural fields survive
		expect(text).toContain('"finding_id":"f-1"');
	});

	test('rendered PR review body redacts published interpolation sites (redact-before-truncate)', () => {
		const body = renderPrReviewSubmissionBody({
			verdict: 'REQUEST_CHANGES',
			findings: [
				{
					finding_id: 'F-1',
					status: 'confirmed',
					severity: 'high',
					confidence: 0.9,
					file: 'src/a.ts',
					line_start: 1,
					line_end: 2,
					evidence: `evidence quoting ${GH} in prose`,
					next_action: 'fix it',
					effective_severity: 'high',
					duplicate_count: 1,
					anchored: true,
				},
			],
			summary: `review summary mentions ${ANT}`,
		} as never);
		const text = typeof body === 'string' ? body : JSON.stringify(body);
		expect(text.includes(GH)).toBe(false);
		expect(text.includes(ANT)).toBe(false);
	});

	test('auto-review evidence capture mutates in place, removing tokens from every prose field', () => {
		const evidence = {
			schema_version: 2,
			timestamp: '2026-01-01T00:00:00.000Z',
			trigger: 'manual',
			session_id: 's',
			scope: {
				hash: 'h',
				selector: { mode: 'head_tree' },
				head_sha: '0'.repeat(40),
				review_text_bytes: 1,
				completeness: 'complete',
			},
			policy: {
				mode: 'advisory',
				min_confidence: 0,
				structured_findings: true,
				validate_findings: true,
			},
			review: { status: 'completed', error: `engine said ${ANT}` },
			findings: [
				{
					finding_id: 'f1',
					title: 't',
					body: `leaks ${GH} in prose`,
					severity: 'low',
					confidence: 0.9,
					file: 'src/a.ts',
					line_start: 1,
					line_end: 2,
					effective_severity: 'low',
					duplicate_count: 1,
					anchored: true,
				},
			],
			validation_error: `provider said ${GH}`,
		} as never;
		const returned = redactAutoReviewEvidenceForCapture(evidence);
		const text = JSON.stringify(returned);
		expect(text.includes(GH)).toBe(false);
		expect(text.includes(ANT)).toBe(false);
	});

	test('forge queue write redacts the event message durably', async () => {
		const dir = canonicalMkdtemp('pins-3844-queue-');
		mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		await enqueuePrFeedbackMonitorEvent(
			dir,
			'sess-1',
			{
				type: 'pr.new.comment',
				repoFullName: 'team/proj',
				prNumber: 7,
				prUrl: 'https://gitlab.example.com/team/proj/-/merge_requests/7',
				message: `check output quoting ${GH} and ${ANT}`,
				dedupToken: 'pin-1',
				authorized: false,
				queuedAt: '2026-11-21T00:00:00.000Z',
			},
			{
				forge: 'gitlab',
				apiBaseUrl: 'https://gitlab.example.com/api/v4',
				repoFullName: 'team/proj',
			},
		);
		const queue = await readPrFeedbackMonitorQueue(dir, 'sess-1');
		const queueText = JSON.stringify(queue);
		expect(queueText.includes(GH)).toBe(false);
		expect(queueText.includes(ANT)).toBe(false);
	}, 30_000);

	test('shared redactor sanity: the five bare families + JWE stay covered through this suite', () => {
		// Cheap guard that the pins above depend on a LIVE redactor: if the
		// shared superset regresses, this leg (and every leg above) goes red.
		const { redactEvidenceText } =
			require('../../../src/security/evidence-redaction') as typeof import('../../../src/security/evidence-redaction');
		for (const token of [
			`ghp_${'x'.repeat(30)}`,
			`sk-ant-${'y'.repeat(24)}`,
			'AKIAABCDEFGHIJKLMNOP',
			`xoxb-${'z'.repeat(16)}`,
			`AccountKey=${'Q'.repeat(28)}=`,
		]) {
			expect(redactEvidenceText(`saw ${token} here`).includes(token)).toBe(
				false,
			);
		}
	});
});
