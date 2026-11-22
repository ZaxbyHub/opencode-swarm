/**
 * #3844 final-critic F3: SHIPPED CI-visible pins for the main #3844
 * redaction call sites. The frozen checks C6-C11 live in the git-ignored
 * trace dir and never run in CI; these unit pins exercise each production
 * boundary directly so a refactor that drops a redaction call turns the
 * build red. Synthetic tokens only.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
				{
					title: `structured title ${ANT}`,
					body: `structured body ${GH}`,
					file: 'src/b.ts',
				},
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
		// The evidence STRADDLES the 400-character singleLine cap: a
		// truncate-first mutant would cut the token and publish the PREFIX that
		// survives the cut (14-19 characters of it), so the fixture must place
		// the token past the cap rather than in a 40-character string.
		const filler = 'x'.repeat(375);
		const body = renderPrReviewSubmissionBody({
			verdict: 'REQUEST_CHANGES',
			findings: [
				{
					finding_id: 'F-1',
					status: 'confirmed',
					severity: 'high',
					confidence: 0.9,
					file: 'src/a.ts',
					// A file_line is what reaches the inline-comment site.
					file_line: 'src/a.ts:12',
					line_start: 1,
					line_end: 2,
					evidence: `${filler} ${GH}`,
					next_action: 'fix it',
					effective_severity: 'high',
					duplicate_count: 1,
					anchored: true,
				},
			],
			// A suppressed entry reaches the order-unstable site. The render
			// path FILTERS the suppressed list down to the rows that actually
			// disagree between the presentation orders, so an entry without
			// `order_agreement: 'disagree'` never reaches that site and the
			// pin would be vacuous.
			order_unstable_suppressed: [
				{
					finding_id: 'F-2',
					status: 'confirmed',
					severity: 'low',
					file_line: 'src/b.ts:3',
					order_agreement: 'disagree',
					evidence: `${filler} ${ANT}`,
				},
			],
			summary: `review summary mentions ${ANT}`,
		} as never);
		const text = typeof body === 'string' ? body : JSON.stringify(body);
		expect(text.includes(GH)).toBe(false);
		expect(text.includes(ANT)).toBe(false);
		// No token PREFIX may survive: the family prefix is the observable,
		// not just the full token.
		expect(text.includes('ghp_')).toBe(false);
		expect(text.includes('sk-ant-')).toBe(false);
		// The suppressed (order-unstable) render site was actually reached —
		// without this the two token assertions above could be satisfied by a
		// site that never rendered the suppressed entry at all.
		expect(text).toContain('Order-unstable (not published as findings)');
		expect(text).toContain('F-2');
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

	test('the auto-review evidence path CLAMPS the fields it redacts (a near-limit field stays inside its schema bound)', async () => {
		// A redaction placeholder can be LONGER than the secret it replaces, so
		// a near-limit title/body/evidence is pushed past the bound it is read
		// back against — and the finding is dropped on read-back.
		const { redactAutoReviewEvidenceForCapture } = await import(
			'../../../src/review/evidence'
		);
		const nearCapTitle = `${'x'.repeat(195)}?token=abc`;
		const nearCapBody = `${'y'.repeat(1990)}?token=abc`;
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
			review: { status: 'completed' },
			findings: [
				{
					finding_id: 'f-clamp',
					title: nearCapTitle,
					body: nearCapBody,
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
		} as never;
		const returned = redactAutoReviewEvidenceForCapture(evidence);
		const finding = returned.findings[0]!;
		expect(finding.title.length).toBeLessThanOrEqual(200);
		expect(finding.body.length).toBeLessThanOrEqual(2000);
		expect(finding.title.length).toBeGreaterThan(0);
		expect(finding.body.length).toBeGreaterThan(0);
		expect(finding.title).not.toContain('?token=abc');
	});

	test('the mutation evidence redacts the surviving mutant ids', async () => {
		const { write_mutation_evidence } = await import(
			'../../../src/tools/write-mutation-evidence'
		);
		const dir = canonicalMkdtemp('pins-3844-mutation-');
		const secret = `ghp_${'m'.repeat(30)}`;
		const result = await write_mutation_evidence.execute(
			{
				phase: 1,
				verdict: 'PASS',
				killRate: 100,
				adjustedKillRate: 100,
				summary: 'gate summary',
				survivedMutants: `survivor ${secret}`,
			},
			{ directory: dir } as never,
		);
		expect(String(result)).toContain('"success": true');
		const written = await Bun.file(
			`${dir}/.swarm/evidence/1/mutation-gate.json`,
		).text();
		expect(written).not.toContain(secret);
	}, 30_000);

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

	test('a near-limit forge queue message survives the redaction (the queue clamps it to its own disk bound)', async () => {
		// A redaction placeholder is LONGER than the secret it replaces, so a
		// message that sat exactly on the queue's 20 000-character disk bound
		// was pushed past it by the redaction itself and the schema parse
		// threw before the queue write.
		const dir = canonicalMkdtemp('pins-3844-queue-clamp-');
		mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		await enqueuePrFeedbackMonitorEvent(
			dir,
			'sess-clamp',
			{
				type: 'pr.new.comment',
				repoFullName: 'team/proj',
				prNumber: 7,
				prUrl: 'https://gitlab.example.com/team/proj/-/merge_requests/7',
				message: `${'y'.repeat(19_990)}?token=abc`,
				dedupToken: 'pin-clamp',
				authorized: false,
				queuedAt: '2026-11-21T00:00:00.000Z',
			},
			{
				forge: 'gitlab',
				apiBaseUrl: 'https://gitlab.example.com/api/v4',
				repoFullName: 'team/proj',
			},
		);
		const queue = await readPrFeedbackMonitorQueue(dir, 'sess-clamp');
		const stored = queue?.events?.[0]?.message ?? '';
		expect(stored.length).toBeGreaterThan(0);
		expect(stored.length).toBeLessThanOrEqual(20_000);
	}, 30_000);

	test('the published review body redacts a credential in the finding LOCATION', () => {
		// The location is reviewer-authored free text ("path:line" plus prose)
		// and it reaches BOTH the published body line and the inline-comment
		// path. A legacy artifact written before the redaction can carry a
		// credential in it.
		const rendered = renderPrReviewSubmissionBody({
			verdict: 'REQUEST_CHANGES',
			findings: [
				{
					finding_id: 'F-1',
					status: 'confirmed',
					severity: 'high',
					confidence: 0.9,
					file: 'src/a.ts',
					file_line: `src/a.ts:12 the literal ${GH}`,
					line_start: 1,
					line_end: 2,
					evidence: 'benign evidence',
					next_action: 'fix it',
				},
			],
			order_unstable_suppressed: [
				{
					finding_id: 'F-2',
					status: 'confirmed',
					severity: 'low',
					file_line: `src/b.ts:3 the literal ${ANT}`,
					order_agreement: 'disagree',
					evidence: 'benign evidence',
				},
			],
		} as never);
		const text =
			typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
		expect(text.includes(GH)).toBe(false);
		expect(text.includes(ANT)).toBe(false);
		expect(text.includes('ghp_')).toBe(false);
		expect(text.includes('sk-ant-')).toBe(false);
		// The suppressed (order-unstable) render site was actually reached.
		expect(text).toContain('Order-unstable (not published as findings)');
	});

	test('a credential-shaped PATH keeps the finding body-only (no inline comment on a nonexistent path)', () => {
		// An inline comment targets a REAL repository path. When the
		// redaction changed the path, the path itself carried a
		// credential-shaped component, so the redacted path names a file
		// that does not exist — publishing it would make the submission
		// invalid. The finding then stays a body-only entry.
		const rendered = renderPrReviewSubmissionBody({
			verdict: 'REQUEST_CHANGES',
			findings: [
				{
					finding_id: 'F-1',
					status: 'confirmed',
					severity: 'high',
					confidence: 0.9,
					file: 'src/a.ts',
					file_line: `src/${GH}.ts:12`,
					line_start: 1,
					line_end: 2,
					evidence: 'benign evidence',
					next_action: 'fix it',
				},
			],
		} as never);
		const text =
			typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
		expect(text.includes(GH)).toBe(false);
		// The finding is still published in the body.
		expect(text).toContain('F-1');
		// No inline comment targets the redacted path: the inline comment
		// would name a file that does not exist in the repository.
		expect(rendered.inlineComments).toHaveLength(0);
	});

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

describe('#3844 round-9: the published body keeps a REAL deep path (path-aware location rule)', () => {
	const DEEP =
		'src/main/java/org/springframework/security/oauth2/server/authorization/OAuth2AuthorizationCodeRequestAuthenticationProvider.java';

	test('a real deep path renders verbatim and anchors the inline comment', () => {
		const dir = canonicalMkdtemp('pins-3844-render-');
		try {
			mkdirSync(path.dirname(path.join(dir, DEEP)), { recursive: true });
			writeFileSync(path.join(dir, DEEP), 'class X {}\n');
			const rendered = renderPrReviewSubmissionBody({
				verdict: 'REQUEST_CHANGES',
				directory: dir,
				findings: [
					{
						finding_id: 'F-9',
						status: 'confirmed',
						severity: 'high',
						file: DEEP,
						file_line: `${DEEP}:42`,
						evidence: 'benign evidence',
						next_action: 'fix it',
					},
				],
			} as never);
			const text =
				typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
			expect(text).toContain(`${DEEP}:42`);
			expect(rendered.inlineComments).toHaveLength(1);
			expect(rendered.inlineComments[0]!.path).toBe(DEEP);
			expect(rendered.inlineComments[0]!.line).toBe(42);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('findings in different files whose paths redact alike do NOT collapse (round 10)', () => {
		// The survivor dedupe keys on the RAW location (identity). Three
		// findings in three different unresolvable files with the same
		// evidence redact to the same placeholder text but must all three
		// be published (the round-9 tree collapsed them into one, with no
		// disclosure of the dropped ids).
		const DEEP =
			'src/main/java/org/springframework/security/oauth2/server/authorization/OAuth2AuthorizationCodeRequestAuthenticationProvider';
		const rendered = renderPrReviewSubmissionBody({
			verdict: 'REQUEST_CHANGES',
			findings: ['DeepBeanOne', 'DeepBeanTwo', 'DeepBeanThree'].map(
				(bean, index) => ({
					finding_id: `F-D${index + 1}`,
					status: 'confirmed',
					severity: 'high',
					file: `${DEEP}${bean}.java`,
					file_line: `${DEEP}${bean}.java:42`,
					evidence: 'the same benign evidence',
					next_action: 'fix it',
				}),
			),
		} as never);
		const text =
			typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
		expect(text).toContain('F-D1');
		expect(text).toContain('F-D2');
		expect(text).toContain('F-D3');
	});

	test('a path that names no real file stays redacted at render (directory known)', () => {
		const dir = canonicalMkdtemp('pins-3844-render-miss-');
		try {
			const rendered = renderPrReviewSubmissionBody({
				verdict: 'REQUEST_CHANGES',
				directory: dir,
				findings: [
					{
						finding_id: 'F-10',
						status: 'confirmed',
						severity: 'high',
						file: DEEP,
						file_line: `${DEEP}:42`,
						evidence: 'benign evidence',
						next_action: 'fix it',
					},
				],
			} as never);
			const text =
				typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
			expect(text).not.toContain(
				'OAuth2AuthorizationCodeRequestAuthenticationProvider',
			);
			expect(text).toContain('[REDACTED:base64]');
			// No inline comment targets the redacted path.
			expect(rendered.inlineComments).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('free-text file_line with a credential is redacted even with directory', () => {
		const dir = canonicalMkdtemp('pins-3844-render-prose-');
		try {
			const secret = `ghp_${'s'.repeat(30)}`;
			const rendered = renderPrReviewSubmissionBody({
				verdict: 'REQUEST_CHANGES',
				directory: dir,
				findings: [
					{
						finding_id: 'F-11',
						status: 'confirmed',
						severity: 'high',
						file: 'src/a.ts',
						file_line: `src/a.ts:12 quoting ${secret}`,
						evidence: 'benign evidence',
						next_action: 'fix it',
					},
				],
			} as never);
			const text =
				typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
			expect(text).not.toContain(secret);
			expect(text).not.toContain('ghp_');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
