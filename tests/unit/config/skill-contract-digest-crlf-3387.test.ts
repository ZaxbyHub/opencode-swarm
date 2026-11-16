/**
 * PR #3387 follow-up (pre-existing item FB-028): splitSkillFrontmatter is
 * CRLF-tolerant, so bounded frontmatter surgery works on CRLF files and the
 * reviser's reported version bump matches the file it actually wrote.
 * RED at base fd8532c33 (CRLF input returned no frontmatter at all, so the
 * reviser's version surgery silently no-op'd while the revision notes still
 * claimed a bump), GREEN after the fix.
 */
import { describe, expect, test } from 'bun:test';
import {
	readSkillContractStamp,
	skillContractDigest,
	splitSkillFrontmatter,
} from '../../../src/config/skill-contract-digest.js';
import { buildDeterministicRevision } from '../../../src/services/skill-reviser.js';

const LF_CONTENT = [
	'---',
	'name: demo',
	'description: d',
	'metadata:',
	'  audience: swarm-plugin',
	'  version: "1"',
	'---',
	'Body text.',
].join('\n');

const CRLF_CONTENT = LF_CONTENT.replace(/\n/g, '\r\n');

describe('splitSkillFrontmatter CRLF tolerance (FB-028)', () => {
	test('a CRLF file returns real frontmatter and body slices', () => {
		const split = splitSkillFrontmatter(CRLF_CONTENT);
		expect(split.frontmatter).toContain('name: demo');
		expect(split.frontmatter.startsWith('---\n')).toBe(true);
		expect(split.body).toBe('Body text.');
	});

	test('CRLF and LF content produce identical body digests', () => {
		const crlfDigest = skillContractDigest(
			splitSkillFrontmatter(CRLF_CONTENT).body,
		);
		const lfDigest = skillContractDigest(
			splitSkillFrontmatter(LF_CONTENT).body,
		);
		expect(crlfDigest).toBe(lfDigest);
	});

	test('no-fence CRLF content passes through as the body', () => {
		const content = 'just text\r\nno fences\r\n';
		const split = splitSkillFrontmatter(content);
		expect(split.frontmatter).toBe('');
		expect(split.body).toBe('just text\nno fences\n');
	});

	test('the stamp reader resolves a CRLF frontmatter stamp (parity guard)', () => {
		const stamped = CRLF_CONTENT.replace(
			'  audience: swarm-plugin',
			'  audience: swarm-plugin\n  swarm-contract-digest: "a1b2c3d4e5f6"',
		);
		expect(readSkillContractStamp(stamped)).toBe('a1b2c3d4e5f6');
	});
});

describe('reviser works end-to-end on CRLF files (FB-028)', () => {
	test('version bump lands in the CRLF frontmatter, not just the notes', async () => {
		const out = await buildDeterministicRevision(CRLF_CONTENT, 1, []);
		const split = splitSkillFrontmatter(out);
		expect(split.frontmatter).toContain('  version: "2"');
		expect(split.frontmatter).toContain('  audience: swarm-plugin');
		// The old defect: frontmatter untouched while the notes claimed the bump.
		expect(out).toContain('## Revision Notes');
		expect(out).toContain('### Version 2');
		expect(out).toContain('Body text.');
	});

	test('inline flow metadata in a CRLF file is canonicalized', async () => {
		const content = [
			'---',
			'name: demo',
			'description: d',
			'metadata: {audience: swarm-plugin}',
			'---',
			'Body.',
		].join('\r\n');
		const out = await buildDeterministicRevision(content, 1, []);
		const split = splitSkillFrontmatter(out);
		expect((split.frontmatter.match(/^metadata:/gm) ?? []).length).toBe(1);
		expect(split.frontmatter).toContain('  audience: swarm-plugin');
		expect(split.frontmatter).toContain('  version: "2"');
	});
});
