/** Issue #3215: readSkillContractStamp must not read stamps inside block scalars — RED at base, GREEN after the fix. */
import { describe, expect, test } from 'bun:test';
import { readSkillContractStamp } from '../../../src/config/skill-contract-digest.js';

// ---------------------------------------------------------------------------
// RED drivers — stamp-shaped lines that sit INSIDE a YAML block scalar
// (folded `>` or literal `|` description content) must never resolve. The
// current line-oriented matcher accepts the two-space form anywhere, so these
// fail at base; a stateful read that only accepts the two-space form inside a
// `metadata:` block (plus legacy column-0 anywhere) turns them green.
// ---------------------------------------------------------------------------

describe('readSkillContractStamp block-scalar rejection (issue #3215)', () => {
	test('a two-space stamp line inside a folded (>) description is not a stamp', () => {
		const frontmatter = [
			'---',
			'name: spoofed',
			'description: >',
			'  This description embeds a stamp-shaped line.',
			'  swarm-contract-digest: "deadbeef1234"',
			'---',
			'Body.',
		].join('\n');
		expect(readSkillContractStamp(frontmatter)).toBeUndefined();
	});

	test('a two-space stamp line inside a literal (|) description is not a stamp', () => {
		const frontmatter = [
			'---',
			'name: spoofed',
			'description: |',
			'  swarm-contract-digest: "deadbeef1234"',
			'---',
			'Body.',
		].join('\n');
		expect(readSkillContractStamp(frontmatter)).toBeUndefined();
	});

	test('a spoof inside a folded description never wins over the real metadata child', () => {
		// The spoof line appears FIRST so a first-match-wins reader (the base
		// implementation) would return the spoof digest.
		const frontmatter = [
			'---',
			'name: spoof-plus-real',
			'description: >',
			'  swarm-contract-digest: "deadbeef1234"',
			'metadata:',
			'  swarm-contract-digest: "a1b2c3d4e5f6"',
			'---',
			'Body.',
		].join('\n');
		expect(readSkillContractStamp(frontmatter)).toBe('a1b2c3d4e5f6');
	});
});

// ---------------------------------------------------------------------------
// Preserving controls — every shape the stamp writer ships must keep
// resolving, at base AND after the fix. These pin the fix so the stateful
// rewrite cannot over-reject.
// ---------------------------------------------------------------------------

describe('readSkillContractStamp shipped forms keep resolving (issue #3215 controls)', () => {
	test('deeper-indented spoof lines inside a folded scalar never resolve', () => {
		for (const indent of ['   ', '    ', '\t']) {
			const frontmatter = [
				'---',
				'name: deep-spoof',
				'description: >',
				`${indent}swarm-contract-digest: "deadbeef1234"`,
				'---',
				'Body.',
			].join('\n');
			expect(readSkillContractStamp(frontmatter)).toBeUndefined();
		}
	});

	test('all four shipped stamp forms resolve (metadata child and column-0)', () => {
		const cases: Array<{ label: string; frontmatter: string[] }> = [
			{
				label: 'metadata child, quoted',
				frontmatter: [
					'---',
					'name: s',
					'metadata:',
					'  swarm-contract-digest: "aabbccddee00"',
					'---',
				],
			},
			{
				label: 'metadata child, bare',
				frontmatter: [
					'---',
					'name: s',
					'metadata:',
					'  swarm-contract-digest: aabbccddee00',
					'---',
				],
			},
			{
				label: 'column-0, quoted',
				frontmatter: [
					'---',
					'name: s',
					'swarm-contract-digest: "aabbccddee00"',
					'---',
				],
			},
			{
				label: 'column-0, bare',
				frontmatter: [
					'---',
					'name: s',
					'swarm-contract-digest: aabbccddee00',
					'---',
				],
			},
		];
		for (const { label, frontmatter } of cases) {
			expect(readSkillContractStamp(frontmatter.join('\n')), label).toBe(
				'aabbccddee00',
			);
		}
	});

	test('CRLF input resolves identically to LF', () => {
		const frontmatter = [
			'---',
			'name: s',
			'metadata:',
			'  swarm-contract-digest: "aabbccddee00"',
			'---',
		].join('\r\n');
		expect(readSkillContractStamp(frontmatter)).toBe('aabbccddee00');
	});

	test('a blank line inside the metadata block does not break the scan', () => {
		const frontmatter = [
			'---',
			'name: s',
			'metadata:',
			'',
			'  swarm-contract-digest: "aabbccddee00"',
			'---',
		].join('\n');
		expect(readSkillContractStamp(frontmatter)).toBe('aabbccddee00');
	});
});
