/**
 * Issue #2907: behavior tests for the `skill-frontmatter` drift detector.
 * Pins the three error classes (non-spec top-level keys, name ≠ directory,
 * bare non-string metadata scalars) plus the host-consumed allowlist, and
 * proves the detector is reachable through the DETECTORS registry.
 *
 * Updated for the #3216 post-migration decision (the generated-tree exemption
 * is REMOVED — generated SKILL.md files are enforced like every other tracked
 * skill) and the #3217 detector alignment (a non-empty inline flow-map
 * `metadata:` value is a finding).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	DETECTORS,
	detectSkillFrontmatterSpecDrift,
} from '../../../scripts/drift-check.ts';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makeTree(files: Record<string, string>): string {
	const root = canonicalMkdtemp('skill-fm-2907-');
	try {
		for (const [rel, content] of Object.entries(files)) {
			const target = join(root, rel);
			mkdirSync(join(target, '..'), { recursive: true });
			writeFileSync(target, content, 'utf-8');
		}
	} catch (error) {
		// Never orphan the temp root when a fixture write fails (PRR-025).
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
	return root;
}

const CLEAN = [
	'---',
	'name: demo-skill',
	'description: A conformant skill.',
	'license: MIT',
	'compatibility: Designed for opencode-swarm hosts',
	'allowed-tools: Bash(git:*) Read',
	'metadata:',
	'  audience: swarm-plugin',
	'  version: "2"',
	'---',
	'Body.',
].join('\n');

describe('detectSkillFrontmatterSpecDrift (issue #2907)', () => {
	test('clean spec-conformant tree produces zero findings', () => {
		const root = makeTree({ '.opencode/skills/demo-skill/SKILL.md': CLEAN });
		try {
			expect(detectSkillFrontmatterSpecDrift(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('non-spec top-level key is an error', () => {
		const root = makeTree({
			'.opencode/skills/demo-skill/SKILL.md': [
				'---',
				'name: demo-skill',
				'description: x',
				'audience: swarm-plugin',
				'---',
			].join('\n'),
		});
		try {
			const findings = detectSkillFrontmatterSpecDrift(root);
			expect(findings).toHaveLength(1);
			expect(findings[0].category).toBe('skill-frontmatter');
			expect(findings[0].severity).toBe('error');
			expect(findings[0].message).toContain('audience');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('host-consumed top-level keys are allowlisted', () => {
		const root = makeTree({
			'.claude/skills/demo-skill/SKILL.md': [
				'---',
				'name: demo-skill',
				'description: x',
				'disable-model-invocation: true',
				'argument-hint: "[task]"',
				'---',
			].join('\n'),
			'.agents/skills/demo-skill/SKILL.md': [
				'---',
				'name: demo-skill',
				'description: x',
				'context: fork',
				'agent: Explore',
				'---',
			].join('\n'),
		});
		try {
			expect(detectSkillFrontmatterSpecDrift(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('name mismatch with the parent directory is an error', () => {
		const root = makeTree({
			'.opencode/skills/demo-skill/SKILL.md': [
				'---',
				'name: other-name',
				'description: x',
				'---',
			].join('\n'),
		});
		try {
			const findings = detectSkillFrontmatterSpecDrift(root);
			expect(findings).toHaveLength(1);
			expect(findings[0].message).toContain('other-name');
			expect(findings[0].message).toContain('demo-skill');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('bare non-string metadata scalars are errors (numeric, bool, timestamp)', () => {
		const root = makeTree({
			'.opencode/skills/demo-skill/SKILL.md': [
				'---',
				'name: demo-skill',
				'description: x',
				'metadata:',
				'  confidence: 0.9',
				'  status: true',
				'  generated_at: 2026-06-14T16:50:00Z',
				'---',
			].join('\n'),
		});
		try {
			const findings = detectSkillFrontmatterSpecDrift(root);
			expect(findings).toHaveLength(3);
			expect(findings.map((f) => f.message).join('\n')).toContain('confidence');
			expect(findings.map((f) => f.message).join('\n')).toContain('status');
			expect(findings.map((f) => f.message).join('\n')).toContain(
				'generated_at',
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('quoted metadata scalars pass', () => {
		const root = makeTree({
			'.opencode/skills/demo-skill/SKILL.md': [
				'---',
				'name: demo-skill',
				'description: x',
				'metadata:',
				'  confidence: "0.9"',
				'  generated_at: "2026-06-14T16:50:00Z"',
				'  audience: \'["swarm-plugin"]\'',
				'---',
			].join('\n'),
		});
		try {
			expect(detectSkillFrontmatterSpecDrift(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// Issue #3216: the generated-tree exemption is REMOVED post-migration.
	// Generated SKILL.md files are held to the same spec-conformance rules as
	// every other tracked skill: non-spec top-level keys and name ≠ directory
	// are errors there too. RED at base (the detector still skips the tree).
	test('the generated tree is enforced (issue #3216)', () => {
		const root = makeTree({
			'.opencode/skills/generated/legacy/SKILL.md': [
				'---',
				'name: legacy',
				'description: x',
				'audience: anything',
				'---',
			].join('\n'),
			'.opencode/skills/generated/mismatched/SKILL.md': [
				'---',
				'name: other-name',
				'description: x',
				'---',
			].join('\n'),
		});
		try {
			const findings = detectSkillFrontmatterSpecDrift(root);
			// Exactly one finding per fixture file: the legacy file's
			// non-spec top-level `audience:` key, the mismatched file's
			// name ≠ directory violation.
			expect(findings).toHaveLength(2);
			const messages = findings.map((f) => f.message).join('\n');
			expect(messages).toContain(
				'non-spec top-level frontmatter key "audience"',
			);
			expect(messages).toContain('does not match the parent directory');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// Issue #3217 detector alignment: a non-empty inline flow-map `metadata:`
	// value is a finding. Exact message substring asserted: 'block form' —
	// the implementer's finding message must contain it (suggested full shape:
	// `metadata: value must use the block form (inline flow maps are not
	// string-typed scalars)`). RED at base (the inline value is ignored).
	test('inline flow-map metadata value is a finding (issue #3217)', () => {
		const root = makeTree({
			'.opencode/skills/demo-skill/SKILL.md': [
				'---',
				'name: demo-skill',
				'description: x',
				'metadata: {audience: swarm-plugin}',
				'---',
			].join('\n'),
		});
		try {
			const findings = detectSkillFrontmatterSpecDrift(root);
			expect(findings).toHaveLength(1);
			expect(findings[0].message).toContain('block form');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// Plan-critic Round 3: a value that is entirely a comment is an EMPTY
	// value (valid YAML `metadata: # note`) and must NOT be flagged.
	test('comment-only metadata value is not a finding (Round 3)', () => {
		const root = makeTree({
			'.opencode/skills/demo-skill/SKILL.md': [
				'---',
				'name: demo-skill',
				'description: x',
				'metadata: # note',
				'---',
			].join('\n'),
		});
		try {
			expect(detectSkillFrontmatterSpecDrift(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('the detector is registered under the skill-frontmatter category', () => {
		const entry = DETECTORS.find(([name]) => name === 'skill-frontmatter');
		expect(entry).toBeDefined();
		expect(entry?.[1]).toBe(detectSkillFrontmatterSpecDrift);
	});
});
