/**
 * #1692 acceptance lock: the `commit-pr` skill bundled into end-user projects
 * (the `.opencode` copy, materialized via BUNDLED_PROJECT_SKILLS) must be
 * portable — it must NOT carry this repository's internal publication protocol.
 * The repo-internal `.claude` copy is unaffected and intentionally still does.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { BUNDLED_PROJECT_SKILLS } from '../../../src/config/bundled-skills';

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const bundledCommitPr = readFileSync(
	path.join(REPO_ROOT, '.opencode/skills/commit-pr/SKILL.md'),
	'utf-8',
);
const claudeCommitPr = readFileSync(
	path.join(REPO_ROOT, '.claude/skills/commit-pr/SKILL.md'),
	'utf-8',
);

describe('bundled commit-pr is portable (#1692)', () => {
	test('is still bundled to end-user projects', () => {
		expect(BUNDLED_PROJECT_SKILLS).toContain('commit-pr');
	});

	test("does NOT reference this repo's internal specifics", () => {
		for (const forbidden of [
			'AGENTS.md',
			'bun run',
			'biome',
			'docs/releases/pending',
			'release-please',
			'ZaxbyHub',
			'zaxbysauce',
			'engineering-invariants',
		]) {
			expect(bundledCommitPr).not.toContain(forbidden);
		}
	});

	test('never mandates a bare `git push --force` (prefers --force-with-lease)', () => {
		// A bare force push is guardrail-blocked; the generic skill must not tell
		// users to run one. --force-with-lease guidance is allowed. (regex held in
		// a variable so the skill-assertion drift checker does not treat it as a
		// literal phrase expected to appear in the skill.)
		const bareForcePush = /git push[^\n]*--force(?!-with-lease)/;
		expect(bundledCommitPr).not.toMatch(bareForcePush);
	});

	test('still covers the essentials (conventional commit, verify, PR body)', () => {
		// Literals below genuinely appear in the bundled skill.
		expect(bundledCommitPr).toContain('conventional');
		expect(bundledCommitPr).toContain('Test plan');
		expect(bundledCommitPr).toContain('name: commit-pr');
	});

	test('diverges from the repo-internal .claude copy (not byte-identical)', () => {
		// The two are classified `divergent` in skill-mirrors.ts; they must differ.
		expect(bundledCommitPr).not.toBe(claudeCommitPr);
	});

	test('the repo-internal .claude copy still carries the internal protocol', () => {
		// Marker held in a variable so the skill-assertion drift checker does not
		// attribute this .claude-only phrase to the bundled .opencode skill.
		const repoInternalMarker = 'AGENTS.md';
		expect(claudeCommitPr).toContain(repoInternalMarker);
	});
});
