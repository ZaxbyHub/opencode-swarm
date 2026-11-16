/**
 * PR #3392 follow-up review (F-013, pre-existing): insertStamp's close-fence
 * fallback searched the WHOLE file for `\n---\n`, so a fence-less skill with
 * a body horizontal rule got a stamp-shaped line injected into body text and
 * the write reported `stamped`. The helper now fails closed (returns input
 * unchanged when frontmatter is absent) so the caller's existing guard skips
 * the slug. The script body is gated on import.meta.main so the helper is
 * importable for direct unit tests.
 */
import { describe, expect, test } from 'bun:test';
import { insertStamp } from '../../../scripts/stamp-skill-contracts.ts';
import { SKILL_CONTRACT_DIGEST_KEY } from '../../../src/config/skill-contract-digest.js';

describe('insertStamp insertion fallback (PR #3392 follow-up)', () => {
	test('a fence-less skill with a body horizontal rule is returned unchanged', () => {
		const content = '# Title\n\n---\n\nBody after a rule\n';
		expect(insertStamp(content, 'abc123def456')).toBe(content);
	});

	test('frontmatter without a metadata map inserts the stamp before the closing fence', () => {
		const content = '---\nname: demo\n---\nBody\n';
		expect(insertStamp(content, 'abc123def456')).toBe(
			`---\nname: demo\n${SKILL_CONTRACT_DIGEST_KEY}: "abc123def456"\n---\nBody\n`,
		);
	});

	test('a metadata map inserts the stamp as its first child', () => {
		const content = '---\nname: demo\nmetadata:\n  audience: x\n---\nBody\n';
		const next = insertStamp(content, 'abc123def456');
		expect(next).toBe(
			`---\nname: demo\nmetadata:\n  ${SKILL_CONTRACT_DIGEST_KEY}: "abc123def456"\n  audience: x\n---\nBody\n`,
		);
	});
});
