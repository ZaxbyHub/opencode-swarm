/**
 * FR-005 regression for the negation defect class.
 *
 * SC-001: expect(skill).not.toContain('placeholder-X') adjacent to
 * expect(skill).toContain('real-Y') must not report 'placeholder-X' as broken.
 *
 * HEADER NOTE (unfixed-detector reproduction):
 * The unfixed detector (cycle 1) reported 'placeholder-X' as a broken
 * assertion because the negation regex did not filter `.not.toContain`.
 * After the fix (require optional chained access `(?:\w+(?:\.\w+)*\.)?`),
 * the brokenAssertions array is empty for the negated assertion.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkSkillAssertions } from '../../../scripts/check-skill-assertions';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const GIT_TIMEOUT_MS = 15_000;
const tempDirs: string[] = [];

function makeGitRepo(): string {
	const root = canonicalMkdtemp('neg-assert-');
	const runGit = (args: string[]) =>
		spawnSync('git', args, {
			cwd: root,
			stdio: 'ignore',
			timeout: GIT_TIMEOUT_MS,
		});
	runGit(['init', '-q']);
	runGit(['config', 'user.email', 'test@test.com']);
	runGit(['config', 'user.name', 'Test']);
	fs.writeFileSync(path.join(root, 'README.md'), 'initial\n', 'utf-8');
	runGit(['add', 'README.md']);
	runGit(['commit', '-q', '-m', 'initial']);
	tempDirs.push(root);
	return root;
}

function writeFile(root: string, relPath: string, content: string): void {
	const full = path.join(root, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const d = tempDirs.pop()!;
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	}
});

describe('SC-001: negated toContain does not produce false positives', () => {
	test('placeholder-X not reported as broken when skill contains real-Y but not placeholder-X', async () => {
		const repo = makeGitRepo();
		writeFile(
			repo,
			'.opencode/skills/test/SKILL.md',
			'# TEST\n\nreal-Y content here\n',
		);
		spawnSync('git', ['add', '.'], {
			cwd: repo,
			stdio: 'ignore',
			timeout: GIT_TIMEOUT_MS,
		});
		spawnSync('git', ['commit', '-q', '-m', 'add skill'], {
			cwd: repo,
			stdio: 'ignore',
			timeout: GIT_TIMEOUT_MS,
		});

		writeFile(
			repo,
			'tests/unit/agents/negated.test.ts',
			`
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const content = readFileSync(
  join(process.cwd(), '.opencode/skills/test/SKILL.md'),
  'utf-8',
);
describe('neg', () => {
  test('placeholder-X NOT required', () => {
    expect(content).not.toContain('placeholder-X');
  });
  test('real-Y required', () => {
    expect(content).toContain('real-Y');
  });
});
`,
		);

		// Remove real-Y so the positive assertion breaks
		writeFile(
			repo,
			'.opencode/skills/test/SKILL.md',
			'# TEST\n\nplaceholder-X content here\n',
		);

		const result = await checkSkillAssertions(repo);

		// The negated assertion must NOT be reported as broken
		const negPhrases = result.brokenAssertions
			.map((b) => b.phrase)
			.filter((p) => p === 'placeholder-X');
		expect(negPhrases).toHaveLength(0);
		// The positive assertion SHOULD be reported as broken
		expect(result.brokenAssertions.some((b) => b.phrase === 'real-Y')).toBe(
			true,
		);
	});

	test('chained negation: .not.toMatch.toContain also excluded', async () => {
		const repo = makeGitRepo();
		writeFile(
			repo,
			'.opencode/skills/test/SKILL.md',
			'# TEST\n\nreal phrase here\n',
		);
		spawnSync('git', ['add', '.'], {
			cwd: repo,
			stdio: 'ignore',
			timeout: GIT_TIMEOUT_MS,
		});
		spawnSync('git', ['commit', '-q', '-m', 'add skill'], {
			cwd: repo,
			stdio: 'ignore',
			timeout: GIT_TIMEOUT_MS,
		});

		writeFile(
			repo,
			'tests/unit/agents/chained-neg.test.ts',
			`
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const content = readFileSync(
  join(process.cwd(), '.opencode/skills/test/SKILL.md'),
  'utf-8',
);
describe('chained', () => {
  test('not.toMatch.toContain chained', () => {
    expect(content).not.toMatch.toContain('absent phrase');
  });
});
`,
		);

		// The chained-negated assertion must NOT be reported even when the
		// skill no longer contains the phrase being negated
		writeFile(
			repo,
			'.opencode/skills/test/SKILL.md',
			'# TEST\n\nabsent phrase removed\n',
		);

		const result = await checkSkillAssertions(repo);
		expect(result.brokenAssertions).toHaveLength(0);
	});
});
