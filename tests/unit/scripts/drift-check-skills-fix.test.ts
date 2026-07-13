import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	type DriftFinding,
	detectSkillMirrorDrift,
	fixSkillMirrorDrift,
} from '../../../scripts/drift-check.ts';

// Issue #1781 E3 — `drift:fix` reconciles mirrored skill pairs by copying the
// canonical side to the mirror. Tests cover: env-guard, copy direction
// (canonical-aware), no-op on in-sync + divergent pairs, and the bundled-skill
// cascade non-corruption guarantee.

const tempRoots: string[] = [];

function makeTempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-fix-test-'));
	tempRoots.push(root);
	return root;
}

function writeFile(root: string, relativePath: string, contents: string): void {
	const full = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, contents, 'utf-8');
}

function readFile(root: string, relativePath: string): string {
	return fs.readFileSync(path.join(root, relativePath), 'utf-8');
}

const ORIGINAL_CONFIRM = process.env.SWARM_SKILL_SYNC_CONFIRM;

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) fs.rmSync(root, { recursive: true, force: true });
	}
	if (ORIGINAL_CONFIRM === undefined) {
		delete process.env.SWARM_SKILL_SYNC_CONFIRM;
	} else {
		process.env.SWARM_SKILL_SYNC_CONFIRM = ORIGINAL_CONFIRM;
	}
});

describe('drift:fix skill-mirror — env-guard (AGENTS.md invariant 4)', () => {
	test('throws when SWARM_SKILL_SYNC_CONFIRM is not set', () => {
		delete process.env.SWARM_SKILL_SYNC_CONFIRM;
		const root = makeTempRoot();
		expect(() => fixSkillMirrorDrift(root)).toThrow(/SWARM_SKILL_SYNC_CONFIRM/);
	});

	test('does not throw when SWARM_SKILL_SYNC_CONFIRM=1', () => {
		process.env.SWARM_SKILL_SYNC_CONFIRM = '1';
		const root = makeTempRoot();
		// No files exist → nothing to fix → returns empty, no throw.
		expect(fixSkillMirrorDrift(root)).toEqual([]);
	});
});

describe('drift:fix skill-mirror — MIRRORED pairs (canonical .opencode)', () => {
	test('copies .opencode → .claude when .claude is stale', () => {
		process.env.SWARM_SKILL_SYNC_CONFIRM = '1';
		const root = makeTempRoot();
		const canonical = 'CANONICAL CONTENT v2\n';
		const stale = 'STALE MIRROR v1\n';
		// Pick the first MIRRORED slug ('brainstorm') by constructing its paths.
		writeFile(root, '.opencode/skills/brainstorm/SKILL.md', canonical);
		writeFile(root, '.claude/skills/brainstorm/SKILL.md', stale);

		const synced = fixSkillMirrorDrift(root);

		expect(synced).toHaveLength(1);
		expect(synced[0]?.message).toInclude('brainstorm');
		// Mirror now byte-matches canonical.
		expect(readFile(root, '.claude/skills/brainstorm/SKILL.md')).toBe(
			canonical,
		);
		// Canonical is untouched (copy direction was .opencode → .claude).
		expect(readFile(root, '.opencode/skills/brainstorm/SKILL.md')).toBe(
			canonical,
		);
	});

	test('is a no-op when the pair is already in sync', () => {
		process.env.SWARM_SKILL_SYNC_CONFIRM = '1';
		const root = makeTempRoot();
		const same = 'IDENTICAL CONTENT\n';
		writeFile(root, '.opencode/skills/plan/SKILL.md', same);
		writeFile(root, '.claude/skills/plan/SKILL.md', same);

		const synced = fixSkillMirrorDrift(root);
		expect(synced.find((f) => f.message.includes('"plan"'))).toBeUndefined();
	});

	test('detectSkillMirrorDrift returns zero findings after fix', () => {
		process.env.SWARM_SKILL_SYNC_CONFIRM = '1';
		const root = makeTempRoot();
		writeFile(root, '.opencode/skills/clarify/SKILL.md', 'CANONICAL\n');
		writeFile(root, '.claude/skills/clarify/SKILL.md', 'STALE\n');

		expect(
			detectSkillMirrorDrift(root).filter((f) =>
				f.message.includes('"clarify"'),
			).length,
		).toBeGreaterThan(0);

		fixSkillMirrorDrift(root);

		const remaining = detectSkillMirrorDrift(root).filter((f) =>
			f.message.includes('"clarify"'),
		);
		// Only existence checks remain (no byte-identity finding).
		expect(
			remaining.filter((f) => f.message.includes('byte-identical')),
		).toEqual([]);
	});
});

describe('drift:fix skill-mirror — divergent pairs are untouched', () => {
	test('does not modify a divergent-by-design pair (engineering-conventions)', () => {
		process.env.SWARM_SKILL_SYNC_CONFIRM = '1';
		const root = makeTempRoot();
		const opencodeContent = 'OPENCODE VARIANT\n';
		const claudeContent = 'CLAUDE VARIANT (different by design)\n';
		writeFile(
			root,
			'.opencode/skills/engineering-conventions/SKILL.md',
			opencodeContent,
		);
		writeFile(
			root,
			'.claude/skills/engineering-conventions/SKILL.md',
			claudeContent,
		);

		const synced = fixSkillMirrorDrift(root);
		expect(
			synced.find((f) => f.message.includes('engineering-conventions')),
		).toBeUndefined();
		// Both sides unchanged.
		expect(
			readFile(root, '.opencode/skills/engineering-conventions/SKILL.md'),
		).toBe(opencodeContent);
		expect(
			readFile(root, '.claude/skills/engineering-conventions/SKILL.md'),
		).toBe(claudeContent);
	});
});

describe('drift:fix skill-mirror — ADDITIONAL identical pairs', () => {
	// #1692: commit-pr is now `divergent` — .claude is the repo-internal
	// publication protocol and .opencode is the portable version bundled into
	// user projects. drift:fix MUST NOT sync them, or it would clobber the
	// generic bundled copy with this repo's internal one (or vice versa).
	test('does NOT sync divergent commit-pr (portable .opencode vs repo-internal .claude preserved)', () => {
		process.env.SWARM_SKILL_SYNC_CONFIRM = '1';
		const root = makeTempRoot();
		const claudeInternal = 'CLAUDE repo-internal protocol\n';
		const opencodePortable = 'OPENCODE portable, project-agnostic\n';
		writeFile(root, '.claude/skills/commit-pr/SKILL.md', claudeInternal);
		writeFile(root, '.opencode/skills/commit-pr/SKILL.md', opencodePortable);

		const synced = fixSkillMirrorDrift(root);
		// No sync finding for commit-pr — divergent pairs are left alone.
		expect(
			synced.find((f) => f.message.includes('"commit-pr"')),
		).toBeUndefined();
		// Both sides untouched — the intentional divergence is preserved.
		expect(readFile(root, '.opencode/skills/commit-pr/SKILL.md')).toBe(
			opencodePortable,
		);
		expect(readFile(root, '.claude/skills/commit-pr/SKILL.md')).toBe(
			claudeInternal,
		);
	});

	test('respects canonical .opencode + extra mirror for test-file-split', () => {
		process.env.SWARM_SKILL_SYNC_CONFIRM = '1';
		const root = makeTempRoot();
		const canonical = 'OPENCODE CANONICAL\n';
		writeFile(root, '.opencode/skills/test-file-split/SKILL.md', canonical);
		writeFile(root, '.claude/skills/test-file-split/SKILL.md', 'STALE\n');
		writeFile(root, '.agents/skills/test-file-split/SKILL.md', 'STALE\n');

		const synced = fixSkillMirrorDrift(root);
		const splitSyncs = synced.filter((f) =>
			f.message.includes('"test-file-split"'),
		);
		expect(splitSyncs.length).toBeGreaterThan(0);
		expect(readFile(root, '.claude/skills/test-file-split/SKILL.md')).toBe(
			canonical,
		);
		expect(readFile(root, '.agents/skills/test-file-split/SKILL.md')).toBe(
			canonical,
		);
	});
});
