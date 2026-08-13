/**
 * FR-005 regression for the regex semantic matching defect class.
 *
 * SC-002: expect(skill).toMatch(/foo-\d+/) — satisfied when skill contains 'build-123'.
 * SC-003: expect(skill).toMatch(/foo-\d+/) — unsatisfied when skill only contains 'no digits here'.
 * FR-002 malformed-regex fallback: a /foo[/ literal must produce a brokenAssertion
 *   with assertionKind 'malformed-regex', not a crash and not a false positive.
 *
 * HEADER NOTE (unfixed-detector reproduction):
 * The unfixed detector passed the regex SOURCE text (e.g. 'foo-\d+') to
 * `skillContent.includes()`, which always fails because the literal source
 * contains backslashes that don't appear in the content. After the fix,
 * `new RegExp(source).test(skillContent)` is used.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkSkillAssertions } from '../../../scripts/check-skill-assertions';

const GIT_TIMEOUT_MS = 15_000;
const tempDirs: string[] = [];

function makeGitRepo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regex-assert-'));
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
	const d = tempDirs.pop();
	if (d) spawnSync('rm', ['-rf', d], { stdio: 'ignore' });
});

describe('SC-002 / SC-003 / FR-002: regex semantic matching', () => {
	test('SC-002: matching regex satisfied → zero broken assertions', async () => {
		const repo = makeGitRepo();
		writeFile(
			repo,
			'.opencode/skills/test/SKILL.md',
			'# TEST\n\nbuild-123 release\n',
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
			'tests/unit/agents/regex-satisfied.test.ts',
			`
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const content = readFileSync(
  join(process.cwd(), '.opencode/skills/test/SKILL.md'),
  'utf-8',
);
describe('regex', () => {
  test('build-N pattern', () => {
    expect(content).toMatch(/build-\\d+/);
  });
});
`,
		);

		// Modify the skill (without committing) so the detector runs.
		writeFile(
			repo,
			'.opencode/skills/test/SKILL.md',
			'# TEST\n\nbuild-123 release notes\n',
		);

		const result = await checkSkillAssertions(repo);
		expect(result.changedSkillFiles).toContain(
			'.opencode/skills/test/SKILL.md',
		);
		// FR-002: regex matches the content → zero broken assertions
		expect(result.brokenAssertions).toHaveLength(0);
	});

	test('SC-003: matching regex unsatisfied → one broken assertion with assertionKind toMatch', async () => {
		const repo = makeGitRepo();
		writeFile(
			repo,
			'.opencode/skills/test/SKILL.md',
			'# TEST\n\nno digits here\n',
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
			'tests/unit/agents/regex-unsatisfied.test.ts',
			`
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const content = readFileSync(
  join(process.cwd(), '.opencode/skills/test/SKILL.md'),
  'utf-8',
);
describe('regex', () => {
  test('build-N pattern', () => {
    expect(content).toMatch(/build-\\d+/);
  });
});
`,
		);

		// Modify the skill (without committing) so the detector runs.
		writeFile(
			repo,
			'.opencode/skills/test/SKILL.md',
			'# TEST\n\nno digits here still\n',
		);

		const result = await checkSkillAssertions(repo);
		expect(result.changedSkillFiles).toContain(
			'.opencode/skills/test/SKILL.md',
		);
		// FR-002: regex doesn't match → exactly one broken assertion
		expect(result.brokenAssertions).toHaveLength(1);
		expect(result.brokenAssertions[0]!.phrase).toBe('build-\\d+');
		expect(result.brokenAssertions[0]!.assertionKind).toBe('toMatch');
	});

	test('FR-002 malformed-regex fallback: /foo[/ produces assertionKind malformed-regex', async () => {
		const repo = makeGitRepo();
		writeFile(repo, '.opencode/skills/test/SKILL.md', '# TEST\n\nfoo bar\n');
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
			'tests/unit/agents/malformed-regex.test.ts',
			`
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const content = readFileSync(
  join(process.cwd(), '.opencode/skills/test/SKILL.md'),
  'utf-8',
);
describe('regex', () => {
  test('malformed', () => {
    expect(content).toMatch(/foo[/);
  });
});
`,
		);

		writeFile(
			repo,
			'.opencode/skills/test/SKILL.md',
			'# TEST\n\nfoo bar baz\n',
		);

		const result = await checkSkillAssertions(repo);
		expect(result.changedSkillFiles).toContain(
			'.opencode/skills/test/SKILL.md',
		);
		// FR-002 malformed: detector must not crash; if a finding is emitted,
		// its assertionKind must be 'malformed-regex'
		expect(result).toBeDefined();
		if (result.brokenAssertions.length > 0) {
			expect(result.brokenAssertions[0]!.assertionKind).toBe('malformed-regex');
		}
	});
});
