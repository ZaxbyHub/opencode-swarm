/**
 * #3844 rounds 9-10: the published body keeps a REAL deep repository path
 * (the path-aware location rule) and findings whose paths redact alike do
 * NOT collapse in the survivor dedupe. Split from
 * persisted-redaction-ci-pins-3844.test.ts for the FR-006 500-line cap.
 * Synthetic tokens only.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { renderPrReviewSubmissionBody } from '../../../src/pr-review/render-review-body';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

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
