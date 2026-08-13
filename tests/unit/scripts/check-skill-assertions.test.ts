/**
 * FR-002 / issue #1746 item 3 — skill-content pre-push check tests.
 *
 * SC-006: detects a test that asserts a phrase no longer present in a changed
 *         skill file.
 * SC-007: completes in <5s on a single-file diff.
 *
 * SC-008 (drift-check entry point) lives in
 * check-skill-assertions-entrypoint.test.ts — split out under FR-006's
 * 500-line cap.
 *
 * These tests use real temp directories with real files (Tier 0 zero-mock pattern)
 * so they exercise the actual assertion-extraction and phrase-checking logic.
 *
 * The git subprocess is tested via real calls in temp repos (not mocked) to
 * verify the Invariant-3 compliant subprocess handling.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkSkillAssertions } from '../../../scripts/check-skill-assertions';

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
// SC-006: detects a test asserting a phrase no longer present in changed file
// ---------------------------------------------------------------------------

describe('SC-006: detects broken skill-file assertions', () => {
	test('no false positive: unrelated toContain is not flagged when skill slug is only mentioned in an import', async () => {
		// Regression: a test file that references the skill slug (e.g. imports it)
		// but has an UNRELATED toContain assertion must NOT report that unrelated
		// assertion as broken — only the skill-targeted one should be flagged.
		const repo = makeGitRepo();

		writeFile(
			repo,
			'.opencode/skills/brainstorm/SKILL.md',
			'# BRAINSTORM\n\nThis skill does NOT delegate to coder.\n',
		);
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add brainstorm skill'], repo);

		// Test file imports the skill (mentions slug) AND has an unrelated assertion
		writeFile(
			repo,
			'tests/unit/agents/brainstorm-false-positive.test.ts',
			`
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Unrelated UI result that has nothing to do with the skill
const uiResult = { label: 'does NOT matter' };

const content = readFileSync(
  join(process.cwd(), '.opencode/skills/brainstorm/SKILL.md'),
  'utf-8',
);

describe('brainstorm skill', () => {
  test('unrelated UI text — must NOT be flagged', () => {
    expect(uiResult.label).toContain('does NOT matter');
  });

  test('skill-targeted: phrase removed from skill must be flagged', () => {
    expect(content).toContain('does NOT delegate to coder');
  });
});
`,
		);

		// Remove the skill phrase (simulating push预备)
		writeFile(
			repo,
			'.opencode/skills/brainstorm/SKILL.md',
			'# BRAINSTORM\n\nThis skill delegates freely.\n',
		);

		const result = await checkSkillAssertions(repo);

		// Only the skill-targeted assertion should be reported
		expect(result.brokenAssertions).toHaveLength(1);
		expect(result.brokenAssertions[0]!.phrase).toBe(
			'does NOT delegate to coder',
		);
		// The unrelated "does NOT matter" must NOT appear in broken list
		const unrelatedPhrases = result.brokenAssertions
			.map((b) => b.phrase)
			.filter((p) => p === 'does NOT matter');
		expect(unrelatedPhrases).toHaveLength(0);
	});

	test('detects skill assertion when path is stored in a variable built with join()', async () => {
		// Regression: variables assigned from path expressions like join(process.cwd(), '...')
		// were not tracked as skill-loading variables. The 2-pass scope tracking now
		// detects path-expression variables (Pass 1) and confirms them via readFileSync usage (Pass 2).
		const repo = makeGitRepo();

		writeFile(
			repo,
			'.opencode/skills/plan/SKILL.md',
			'# PLAN\n\nMODE: PLAN\ndoes NOT delegate to coder.\n',
		);
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add plan skill'], repo);

		// Test file uses a variable to hold the path, built with join()
		writeFile(
			repo,
			'tests/unit/agents/plan-var-path.test.ts',
			`
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Variable assigned from a path expression containing the slug
const SKILL_PATH = join(process.cwd(), '.opencode/skills/plan/SKILL.md');
const skillContent = readFileSync(SKILL_PATH, 'utf-8');

describe('plan skill', () => {
  test('does NOT delegate to coder — variable-path case', () => {
    expect(skillContent).toContain('does NOT delegate to coder');
  });
});
`,
		);

		// Remove the phrase
		writeFile(
			repo,
			'.opencode/skills/plan/SKILL.md',
			'# PLAN\n\nMODE: PLAN\nfreely delegates to coder.\n',
		);

		const result = await checkSkillAssertions(repo);

		// The assertion should be flagged as broken
		expect(result.brokenAssertions).toHaveLength(1);
		expect(result.brokenAssertions[0]!.phrase).toBe(
			'does NOT delegate to coder',
		);
		expect(result.brokenAssertions[0]!.testFile).toMatch(
			/plan-var-path\.test\.ts$/,
		);
	});

	test('reports a broken toContain assertion when the phrase is removed from the skill', async () => {
		const repo = makeGitRepo();

		// Create the skill file and commit it
		writeFile(
			repo,
			'.opencode/skills/brainstorm/SKILL.md',
			'# BRAINSTORM\n\nThis skill does NOT delegate to coder.\n',
		);
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add brainstorm skill'], repo);

		// Create a test that asserts the phrase
		writeFile(
			repo,
			'tests/unit/agents/brainstorm.test.ts',
			`
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const content = readFileSync(
  join(process.cwd(), '.opencode/skills/brainstorm/SKILL.md'),
  'utf-8',
);

describe('brainstorm skill', () => {
  test('does NOT delegate to coder — read-only constraint', () => {
    expect(content).toContain('does NOT delegate to coder');
  });
});
`,
		);

		// Now edit the skill file to remove the phrase (simulating a push预备)
		writeFile(
			repo,
			'.opencode/skills/brainstorm/SKILL.md',
			'# BRAINSTORM\n\nThis skill delegates freely.\n',
		);

		// Run the check
		const result = await checkSkillAssertions(repo);

		expect(result.changedSkillFiles).toContain(
			'.opencode/skills/brainstorm/SKILL.md',
		);
		expect(result.brokenAssertions).toHaveLength(1);
		expect(result.brokenAssertions[0]!.phrase).toBe(
			'does NOT delegate to coder',
		);
		expect(result.brokenAssertions[0]!.testFile).toMatch(
			/brainstorm\.test\.ts$/,
		);
	});

	test('reports a broken toMatch assertion when the regex phrase is removed', async () => {
		const repo = makeGitRepo();

		writeFile(
			repo,
			'.claude/skills/brainstorm/SKILL.md',
			'MODE: BRAINSTORM\nThe critic does DROP irrelevant items.\n',
		);
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add skill'], repo);

		writeFile(
			repo,
			'tests/unit/agents/brainstorm-critic.test.ts',
			`
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const content = readFileSync(
  join(process.cwd(), '.claude/skills/brainstorm/SKILL.md'),
  'utf-8',
);
describe('brainstorm critic', () => {
  test('DROP outcome is documented', () => {
    expect(content).toMatch(/does DROP irrelevant items/);
  });
});
`,
		);

		// Remove the DROP phrase
		writeFile(
			repo,
			'.claude/skills/brainstorm/SKILL.md',
			'MODE: BRAINSTORM\nThe critic does not DROP anything.\n',
		);

		const result = await checkSkillAssertions(repo);

		expect(result.brokenAssertions).toHaveLength(1);
		expect(result.brokenAssertions[0]!.phrase).toBe(
			'does DROP irrelevant items',
		);
	});

	test('C-010: checks committed PR skill changes against the CI base branch', async () => {
		const repo = makeGitRepo();
		runGit(['branch', '-M', 'main'], repo);
		writeFile(
			repo,
			'.opencode/skills/committed/SKILL.md',
			'Original committed phrase.',
		);
		writeFile(
			repo,
			'tests/unit/agents/committed.test.ts',
			`const content = readFileSync('.opencode/skills/committed/SKILL.md', 'utf-8');
expect(content).toContain('Original committed phrase.');
`,
		);
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add committed skill'], repo);
		runGit(['checkout', '-q', '-b', 'feature'], repo);
		writeFile(
			repo,
			'.opencode/skills/committed/SKILL.md',
			'Updated committed phrase.',
		);
		runGit(['add', '.opencode/skills/committed/SKILL.md'], repo);
		runGit(['commit', '-q', '-m', 'update committed skill'], repo);

		const previousBaseRef = process.env.GITHUB_BASE_REF;
		process.env.GITHUB_BASE_REF = 'main';
		try {
			const result = await checkSkillAssertions(repo);
			expect(result.changedSkillFiles).toEqual([
				'.opencode/skills/committed/SKILL.md',
			]);
			expect(result.brokenAssertions).toHaveLength(1);
		} finally {
			if (previousBaseRef === undefined) delete process.env.GITHUB_BASE_REF;
			else process.env.GITHUB_BASE_REF = previousBaseRef;
		}
	});

	test('no broken assertions when skill content still contains the asserted phrase', async () => {
		const repo = makeGitRepo();

		writeFile(
			repo,
			'.opencode/skills/clarify/SKILL.md',
			'MODE: CLARIFY — structured clarification.',
		);
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add skill'], repo);

		writeFile(
			repo,
			'tests/unit/agents/clarify.test.ts',
			`
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const content = readFileSync(
  join(process.cwd(), '.opencode/skills/clarify/SKILL.md'),
  'utf-8',
);
describe('clarify skill', () => {
  test('contains CLARIFY mode documentation', () => {
    expect(content).toContain('MODE: CLARIFY');
  });
});
`,
		);

		// Tweak the skill but keep the phrase
		writeFile(
			repo,
			'.opencode/skills/clarify/SKILL.md',
			'MODE: CLARIFY — structured clarification. Updated.',
		);

		const result = await checkSkillAssertions(repo);

		expect(result.brokenAssertions).toHaveLength(0);
	});

	test('no findings when no skill files have changed', async () => {
		const repo = makeGitRepo();
		// Nothing changed — just run against a clean repo
		const result = await checkSkillAssertions(repo);
		expect(result.changedSkillFiles).toHaveLength(0);
		expect(result.brokenAssertions).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// SC-007: completes in <5s on a typical single-file diff
// ---------------------------------------------------------------------------

describe('SC-007: performance — completes in <5s on single-file diff', () => {
	test('checkSkillAssertions finishes within 5 seconds for a single changed file', async () => {
		const repo = makeGitRepo();

		// Create skill + test
		writeFile(
			repo,
			'.opencode/skills/planner/SKILL.md',
			'The planner agent is responsible for all planning tasks.',
		);
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add skill'], repo);

		writeFile(
			repo,
			'tests/unit/agents/planner.test.ts',
			`
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const content = readFileSync(
  join(process.cwd(), '.opencode/skills/planner/SKILL.md'),
  'utf-8',
);
describe('planner skill', () => {
  test('mentions planning', () => {
    expect(content).toContain('responsible for all planning');
  });
});
`,
		);

		// Edit just one file
		writeFile(
			repo,
			'.opencode/skills/planner/SKILL.md',
			'The architect agent is responsible for all planning.',
		);

		const start = Date.now();
		await checkSkillAssertions(repo);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(5000);
	});
});
