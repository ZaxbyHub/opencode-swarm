/**
 * FR-002 / issue #1746 item 3 — skill-content pre-push check tests.
 *
 * SC-008: the skill check is invoked from the existing drift-check entry point,
 *         and its findings format into valid GitHub Actions annotations.
 *
 * Split out of check-skill-assertions.test.ts under FR-006 (500-line cap): that
 * file is over cap, so the issue-#2069 severity assertions could not grow it.
 *
 * These tests use real temp directories with real files (Tier 0 zero-mock pattern)
 * so they exercise the actual assertion-extraction and phrase-checking logic.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	formatBrokenAssertions,
	type SkillAssertionResult,
} from '../../../scripts/check-skill-assertions';
import { detectSkillAssertionDrift } from '../../../scripts/drift-check';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 15_000;

/** Paths that must be cleaned up after each test. */
const tempDirs: string[] = [];

/** Create an isolated git repo for testing git-diff operations. */
function makeGitRepo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-assert-'));
	// Init a bare git repo (required for `git diff HEAD` to work)
	runGit(['init', '-q'], root);
	// Set identity so git doesn't complain
	runGit(['config', 'user.email', 'test@test.com'], root);
	runGit(['config', 'user.name', 'Test'], root);
	// Create an initial commit so HEAD exists
	fs.writeFileSync(path.join(root, 'README.md'), 'initial\n', 'utf-8');
	runGit(['add', 'README.md'], root);
	runGit(['commit', '-q', '-m', 'initial'], root);
	tempDirs.push(root);
	return root;
}

function runGit(args: string[], cwd: string): void {
	const result = spawnSync('git', args, {
		stdin: 'ignore',
		cwd,
		timeout: GIT_TIMEOUT_MS,
	});
	if (result.status !== 0) {
		const errMsg = result.stderr?.toString() ?? '';
		throw new Error(`git ${args.join(' ')} failed: ${errMsg.trim()}`);
	}
}

/** Write a file relative to a root, creating parent dirs. */
function writeFile(root: string, relPath: string, content: string): void {
	const full = path.join(root, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	}
});

// ---------------------------------------------------------------------------
// SC-008: skill check is invoked from existing drift-check entry point
// ---------------------------------------------------------------------------

describe('SC-008: skill check is part of drift-check.ts entry point', () => {
	test('detectSkillAssertionDrift is called by runAllDetectors and returns findings', async () => {
		// This test verifies that when drift-check.ts runs its full suite,
		// it also calls the skill-assertion detector.  We test the exported
		// detectSkillAssertionDrift directly since runAllDetectors requires
		// the full repo context.
		//
		// We create a minimal scenario: a skill with a phrase, a test asserting
		// it, then remove the phrase — and verify detectSkillAssertionDrift
		// surfaces the broken assertion as a DriftFinding.

		const repo = makeGitRepo();

		writeFile(
			repo,
			'.opencode/skills/design-docs/SKILL.md',
			'MODE: DESIGN_DOCS — this mode does NOT delegate to coder.',
		);
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add skill'], repo);

		writeFile(
			repo,
			'tests/unit/agents/design-docs.test.ts',
			`
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const content = readFileSync(
  join(process.cwd(), '.opencode/skills/design-docs/SKILL.md'),
  'utf-8',
);
describe('design-docs skill', () => {
  test('does NOT delegate to coder', () => {
    expect(content).toContain('does NOT delegate to coder');
  });
});
`,
		);

		// Remove the phrase
		writeFile(
			repo,
			'.opencode/skills/design-docs/SKILL.md',
			'MODE: DESIGN_DOCS — delegates freely.',
		);

		const findings = await detectSkillAssertionDrift(repo);

		const skillAssertionFindings = findings.filter(
			(f) => f.category === 'skill-assertion',
		);
		expect(skillAssertionFindings).toHaveLength(1);
		expect(skillAssertionFindings[0]!.severity).toBe('notice');
		expect(skillAssertionFindings[0]!.message).toContain(
			'does NOT delegate to coder',
		);
		expect(skillAssertionFindings[0]!.message).toContain(
			'.opencode/skills/design-docs/SKILL.md',
		);
	});

	test('formatBrokenAssertions produces valid GitHub Actions annotations', () => {
		const result: SkillAssertionResult = {
			changedSkillFiles: ['.opencode/skills/x/SKILL.md'],
			brokenAssertions: [
				{
					testFile: 'tests/unit/agents/x.test.ts',
					line: 14,
					skillFile: '.opencode/skills/x/SKILL.md',
					phrase: 'does NOT delegate',
					assertionKind: 'toContain',
				},
			],
		};
		const lines = formatBrokenAssertions(result);
		expect(lines).toHaveLength(1);
		expect(lines[0]!).toContain('::notice');
		expect(lines[0]!).toContain('tests/unit/agents/x.test.ts');
		expect(lines[0]!).toContain('does NOT delegate');
	});

	test('formatBrokenAssertions returns empty array when no broken assertions', () => {
		const result: SkillAssertionResult = {
			changedSkillFiles: [],
			brokenAssertions: [],
		};
		expect(formatBrokenAssertions(result)).toEqual([]);
	});
});
