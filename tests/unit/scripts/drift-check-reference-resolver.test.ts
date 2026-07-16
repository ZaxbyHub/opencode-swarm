import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectSkillReferenceDrift } from '../../../scripts/drift-check';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

function makeTempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-check-ref-test-'));
	tempRoots.push(root);
	return root;
}

function writeFile(root: string, relativePath: string, contents: string): void {
	const full = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, contents, 'utf-8');
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) fs.rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// SC-001: Broken bundled-skill reference detected
// ---------------------------------------------------------------------------

describe('SC-001: Broken bundled-skill reference detected', () => {
	test('detectSkillReferenceDrift finds a broken file:.swarm/bundled-skills/<slug>/SKILL.md reference', () => {
		const root = makeTempRoot();

		// Create a real skill in .opencode/skills
		writeFile(root, '.opencode/skills/real-skill/SKILL.md', '# Real Skill\n');

		// Create another skill that references a non-existent bundled skill
		writeFile(
			root,
			'.opencode/skills/referencing-skill/SKILL.md',
			'# Referencing Skill\n\nUse file:.swarm/bundled-skills/nonexistent-skill/SKILL.md for the protocol.\n',
		);

		const findings = detectSkillReferenceDrift(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' &&
				f.category === 'skill-reference' &&
				f.file === '.opencode/skills/referencing-skill/SKILL.md' &&
				f.message.includes('nonexistent-skill') &&
				f.message.includes('file:.swarm/bundled-skills'),
		);
		expect(hit).toBeDefined();
	});

	test('a bundled-skill reference to an existing slug in BUNDLED_PROJECT_SKILLS is valid', () => {
		const root = makeTempRoot();

		// Bundled-skill references must exist in BUNDLED_PROJECT_SKILLS (the runtime
		// list of slugs that are bundled into the plugin).
		// We verify no false-positive on a reference that the real
		// BUNDLED_PROJECT_SKILLS would satisfy — the real repo's
		// BUNDLED_PROJECT_SKILLS is imported at script load time.
		writeFile(
			root,
			'.opencode/skills/test-skill/SKILL.md',
			'# Test Skill\n\nReference: `file:.swarm/bundled-skills/brainstorm/SKILL.md`.\n',
		);

		const findings = detectSkillReferenceDrift(root);
		// "brainstorm" is in BUNDLED_PROJECT_SKILLS in the real repo,
		// so this must NOT produce a finding.
		const hit = findings.find(
			(f) =>
				f.file === '.opencode/skills/test-skill/SKILL.md' &&
				f.message.includes('brainstorm'),
		);
		expect(hit).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// SC-002: Broken sibling reference detected
// ---------------------------------------------------------------------------

describe('SC-002: Broken sibling reference detected', () => {
	test('detectSkillReferenceDrift finds a broken ../<slug>/SKILL.md sibling reference', () => {
		const root = makeTempRoot();

		// Create a skill that references a sibling that does NOT exist
		writeFile(
			root,
			'.opencode/skills/existing-skill/SKILL.md',
			'# Existing Skill\n\nSee `../nonexistent-sibling/SKILL.md` for details.\n',
		);

		const findings = detectSkillReferenceDrift(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' &&
				f.category === 'skill-reference' &&
				f.file === '.opencode/skills/existing-skill/SKILL.md' &&
				f.message.includes('nonexistent-sibling') &&
				f.message.includes('../'),
		);
		expect(hit).toBeDefined();
	});

	test('a sibling reference to an existing skill passes silently', () => {
		const root = makeTempRoot();

		// Both the referencing skill and the target exist
		writeFile(
			root,
			'.claude/skills/skill-a/SKILL.md',
			'# Skill A\n\nSee `../skill-b/SKILL.md` for details.\n',
		);
		writeFile(root, '.claude/skills/skill-b/SKILL.md', '# Skill B\n');

		const findings = detectSkillReferenceDrift(root);
		const hits = findings.filter(
			(f) => f.file === '.claude/skills/skill-a/SKILL.md',
		);
		expect(hits).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// SC-003: Valid cross-skill reference passes
// ---------------------------------------------------------------------------

describe('SC-003: Valid cross-skill reference passes', () => {
	test('no findings when all references resolve correctly across trees', () => {
		const root = makeTempRoot();

		// .opencode tree
		writeFile(root, '.opencode/skills/alpha/SKILL.md', '# Alpha\n');
		writeFile(
			root,
			'.opencode/skills/beta/SKILL.md',
			'# Beta\n\nSee `../alpha/SKILL.md`.\n',
		);

		// .claude tree
		writeFile(root, '.claude/skills/gamma/SKILL.md', '# Gamma\n');
		writeFile(
			root,
			'.claude/skills/delta/SKILL.md',
			'# Delta\n\nSee `../gamma/SKILL.md`.\n',
		);

		// .agents tree
		writeFile(root, '.agents/skills/epsilon/SKILL.md', '# Epsilon\n');

		// .github tree
		writeFile(root, '.github/skills/zeta/SKILL.md', '# Zeta\n');

		const findings = detectSkillReferenceDrift(root);
		// All references are valid (siblings exist, no broken bundled-skill refs)
		const errors = findings.filter((f) => f.severity === 'error');
		expect(errors).toEqual([]);
	});

	test('mixed valid bundled-skill and sibling references produce no errors', () => {
		const root = makeTempRoot();

		// bundled-skill reference to brainstorm (in BUNDLED_PROJECT_SKILLS)
		writeFile(
			root,
			'.opencode/skills/mixed-refs/SKILL.md',
			[
				'# Mixed Refs',
				'',
				'Runtime: `file:.swarm/bundled-skills/brainstorm/SKILL.md`',
				'',
				'Sibling: `../sibling-skill/SKILL.md`',
			].join('\n'),
		);
		writeFile(root, '.opencode/skills/sibling-skill/SKILL.md', '# Sibling\n');

		const findings = detectSkillReferenceDrift(root);
		const errors = findings.filter(
			(f) =>
				f.severity === 'error' &&
				f.file === '.opencode/skills/mixed-refs/SKILL.md',
		);
		expect(errors).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// SC-004: All four trees scanned
// ---------------------------------------------------------------------------

describe('SC-004: All four trees scanned', () => {
	test('.opencode tree is scanned', () => {
		const root = makeTempRoot();
		writeFile(
			root,
			'.opencode/skills/bad-ref/SKILL.md',
			'# Bad Ref\n\nSee `../does-not-exist/SKILL.md`.\n',
		);

		const findings = detectSkillReferenceDrift(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' &&
				f.file === '.opencode/skills/bad-ref/SKILL.md',
		);
		expect(hit).toBeDefined();
	});

	test('.claude tree is scanned', () => {
		const root = makeTempRoot();
		writeFile(
			root,
			'.claude/skills/bad-ref/SKILL.md',
			'# Bad Ref\n\nSee `../does-not-exist/SKILL.md`.\n',
		);

		const findings = detectSkillReferenceDrift(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' && f.file === '.claude/skills/bad-ref/SKILL.md',
		);
		expect(hit).toBeDefined();
	});

	test('.agents tree is scanned', () => {
		const root = makeTempRoot();
		writeFile(
			root,
			'.agents/skills/bad-ref/SKILL.md',
			'# Bad Ref\n\nSee `../does-not-exist/SKILL.md`.\n',
		);

		const findings = detectSkillReferenceDrift(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' && f.file === '.agents/skills/bad-ref/SKILL.md',
		);
		expect(hit).toBeDefined();
	});

	test('.github tree is scanned', () => {
		const root = makeTempRoot();
		writeFile(
			root,
			'.github/skills/bad-ref/SKILL.md',
			'# Bad Ref\n\nSee `../does-not-exist/SKILL.md`.\n',
		);

		const findings = detectSkillReferenceDrift(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' && f.file === '.github/skills/bad-ref/SKILL.md',
		);
		expect(hit).toBeDefined();
	});

	test('a broken reference in any single tree is detectable without affecting others', () => {
		const root = makeTempRoot();

		// Only .opencode has a bad reference; .claude, .agents, .github are clean
		writeFile(
			root,
			'.opencode/skills/bad/SKILL.md',
			'# Bad\n\nSee `../no-sibling/SKILL.md`.\n',
		);
		writeFile(root, '.claude/skills/good/SKILL.md', '# Good\n');
		writeFile(root, '.agents/skills/good/SKILL.md', '# Good\n');
		writeFile(root, '.github/skills/good/SKILL.md', '# Good\n');

		const findings = detectSkillReferenceDrift(root);
		const errorFiles = findings
			.filter((f) => f.severity === 'error')
			.map((f) => f.file);

		expect(errorFiles).toHaveLength(1);
		expect(errorFiles[0]).toBe('.opencode/skills/bad/SKILL.md');
	});
});

// ---------------------------------------------------------------------------
// SC-005: Proof-of-guard — deliberately break a reference and verify detection
// ---------------------------------------------------------------------------

describe('SC-005: Proof-of-guard — broken reference is always detected as error', () => {
	test('a single broken bundled-skill reference produces exactly one error finding', () => {
		const root = makeTempRoot();

		writeFile(
			root,
			'.opencode/skills/guard-test/SKILL.md',
			[
				'# Guard Test',
				'',
				'Runtime: `file:.swarm/bundled-skills/this-slug-does-not-exist/SKILL.md`',
			].join('\n'),
		);

		const findings = detectSkillReferenceDrift(root);
		const errors = findings.filter((f) => f.severity === 'error');

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({
			category: 'skill-reference',
			severity: 'error',
			file: '.opencode/skills/guard-test/SKILL.md',
		});
		expect(errors[0].message).toContain('this-slug-does-not-exist');
		expect(errors[0].message).toContain(
			'file:.swarm/bundled-skills/this-slug-does-not-exist/SKILL.md',
		);
	});

	test('a single broken sibling reference produces exactly one error finding', () => {
		const root = makeTempRoot();

		writeFile(
			root,
			'.claude/skills/guard-test/SKILL.md',
			'# Guard Test\n\nSee `../broken-sibling-ref/SKILL.md`.\n',
		);

		const findings = detectSkillReferenceDrift(root);
		const errors = findings.filter((f) => f.severity === 'error');

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({
			category: 'skill-reference',
			severity: 'error',
			file: '.claude/skills/guard-test/SKILL.md',
		});
		expect(errors[0].message).toContain('broken-sibling-ref');
		expect(errors[0].message).toContain('../broken-sibling-ref/SKILL.md');
	});

	test('multiple broken references in the same skill file each produce a separate finding', () => {
		const root = makeTempRoot();

		writeFile(
			root,
			'.opencode/skills/multi-bad/SKILL.md',
			[
				'# Multi Bad',
				'',
				'Ref 1: `file:.swarm/bundled-skills/nonexistent-a/SKILL.md`',
				'Ref 2: `../also-does-not-exist/SKILL.md`',
				'Ref 3: `file:.swarm/bundled-skills/nonexistent-b/SKILL.md`',
			].join('\n'),
		);

		const findings = detectSkillReferenceDrift(root);
		const errors = findings.filter(
			(f) =>
				f.severity === 'error' &&
				f.file === '.opencode/skills/multi-bad/SKILL.md',
		);

		expect(errors).toHaveLength(3);
		const slugs = errors
			.map((f) => {
				// Extract the slug from each message
				const m = f.message;
				if (m.includes('nonexistent-a')) return 'nonexistent-a';
				if (m.includes('nonexistent-b')) return 'nonexistent-b';
				if (m.includes('also-does-not-exist')) return 'also-does-not-exist';
				return '';
			})
			.filter(Boolean);
		expect(slugs).toContain('nonexistent-a');
		expect(slugs).toContain('nonexistent-b');
		expect(slugs).toContain('also-does-not-exist');
	});

	test('restoring a broken reference removes the finding', () => {
		const root = makeTempRoot();

		// Step 1: create a bad reference
		writeFile(
			root,
			'.opencode/skills/restore-test/SKILL.md',
			'# Restore Test\n\nSee `../missing-sibling/SKILL.md`.\n',
		);

		let findings = detectSkillReferenceDrift(root);
		expect(findings.some((f) => f.severity === 'error')).toBe(true);

		// Step 2: create the missing sibling — the reference is now valid
		writeFile(root, '.opencode/skills/missing-sibling/SKILL.md', '# Sibling\n');

		findings = detectSkillReferenceDrift(root);
		const errors = findings.filter(
			(f) => f.file === '.opencode/skills/restore-test/SKILL.md',
		);
		expect(errors).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
	test('skill with no references produces no findings', () => {
		const root = makeTempRoot();
		writeFile(
			root,
			'.opencode/skills/lonely/SKILL.md',
			'# Lonely\n\nNo references here.\n',
		);

		const findings = detectSkillReferenceDrift(root);
		expect(findings).toEqual([]);
	});

	test('an empty skill tree directory is skipped gracefully', () => {
		const root = makeTempRoot();
		// Create the directory but no SKILL.md files
		fs.mkdirSync(path.join(root, '.opencode/skills/empty-skill'), {
			recursive: true,
		});
		writeFile(root, '.opencode/skills/other-skill/SKILL.md', '# Other\n');

		// Must not throw
		const findings = detectSkillReferenceDrift(root);
		expect(findings).toEqual([]);
	});

	test('non-skill files in a skills directory are ignored', () => {
		const root = makeTempRoot();
		writeFile(root, '.opencode/skills/real/SKILL.md', '# Real\n');
		// Write a non-SKILL.md file in the skills directory
		writeFile(
			root,
			'.opencode/skills/real/README.md',
			'# Readme — not a skill\n',
		);
		writeFile(root, '.opencode/skills/real/notes.txt', 'Some notes\n');

		const findings = detectSkillReferenceDrift(root);
		expect(findings).toEqual([]);
	});

	test('a skill that references itself via ../<itself>/SKILL.md is NOT flagged (file exists)', () => {
		// The implementation only checks if the target file exists; a self-reference
		// points to the same file which by definition exists, so no error is raised.
		const root = makeTempRoot();
		writeFile(
			root,
			'.opencode/skills/self-ref/SKILL.md',
			'# Self Ref\n\nSee ../self-ref/SKILL.md — circular but file exists.\n',
		);

		const findings = detectSkillReferenceDrift(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' &&
				f.file === '.opencode/skills/self-ref/SKILL.md',
		);
		// Implementation does not flag self-references since the file exists
		expect(hit).toBeUndefined();
	});
});

describe('SC-006: Multi-level ../../ sibling reference resolution', () => {
	test('valid ../../<slug>/SKILL.md multi-level reference resolves correctly', () => {
		const root = makeTempRoot();
		writeFile(
			root,
			'.opencode/skills/nested/deep/SKILL.md',
			'See `../../target-skill/SKILL.md`.\n',
		);
		writeFile(root, '.opencode/skills/target-skill/SKILL.md', '# Target\n');
		const findings = detectSkillReferenceDrift(root);
		expect(findings).toEqual([]);
	});

	test('broken ../../<slug>/SKILL.md multi-level reference is detected as error', () => {
		const root = makeTempRoot();
		writeFile(
			root,
			'.opencode/skills/nested/deep/SKILL.md',
			'See `../../nonexistent/SKILL.md`.\n',
		);
		const findings = detectSkillReferenceDrift(root);
		expect(findings.some((f) => f.severity === 'error')).toBe(true);
	});
});
