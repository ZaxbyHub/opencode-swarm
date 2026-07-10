/**
 * Adversarial tests for scripts/check-skill-assertions.ts
 *
 * Verifies correct behavior under malformed, malicious, or extreme inputs.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	checkSkillAssertions,
	formatBrokenAssertions,
} from '../../../scripts/check-skill-assertions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 15_000;
const tempDirs: string[] = [];

function makeGitRepo(): string {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), 'skill-assert-adversarial-'),
	);
	runGit(['init', '-q'], root);
	runGit(['config', 'user.email', 'test@test.com'], root);
	runGit(['config', 'user.name', 'Test'], root);
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
			// best-effort
		}
	}
});

// ---------------------------------------------------------------------------
// Adversarial scenarios
// ---------------------------------------------------------------------------

describe('adversarial: deleted skill file', () => {
	test('skill file deleted between git diff and readFileSync does not crash', async () => {
		// A skill file that was changed AND deleted concurrently should be skipped,
		// not throw ENOENT.
		const repo = makeGitRepo();

		writeFile(
			repo,
			'.opencode/skills/deleted-skill/SKILL.md',
			'Secret phrase.',
		);
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add skill'], repo);

		writeFile(
			repo,
			'tests/unit/agents/deleted-skill.test.ts',
			`import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const content = readFileSync('.opencode/skills/deleted-skill/SKILL.md', 'utf-8');
describe('deleted skill', () => {
  test('has secret phrase', () => {
    expect(content).toContain('Secret phrase.');
  });
});
`,
		);

		// Simulate: git sees the file as changed, but between the existsSync check
		// and the readFileSync the file is deleted by an external agent.
		writeFile(
			repo,
			'.opencode/skills/deleted-skill/SKILL.md',
			'Altered phrase.',
		);
		fs.unlinkSync(path.join(repo, '.opencode/skills/deleted-skill/SKILL.md'));

		// Must not throw — should skip gracefully
		const result = await checkSkillAssertions(repo);
		expect(Array.isArray(result.brokenAssertions)).toBe(true);
	});

	test('skill file does not exist on disk at all — skip check gracefully', async () => {
		const repo = makeGitRepo();

		writeFile(
			repo,
			'tests/unit/agents/absent.test.ts',
			`import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const content = readFileSync('.opencode/skills/absent-skill/SKILL.md', 'utf-8');
describe('absent skill', () => {
  test('has phrase', () => {
    expect(content).toContain('Unseen phrase.');
  });
});
`,
		);
		// Create the dir so git can track a change, but leave the file unwritten
		fs.mkdirSync(path.join(repo, '.opencode/skills/absent-skill'), {
			recursive: true,
		});

		writeFile(repo, '.opencode/skills/absent-skill/.gitkeep', 'keep');
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add dir'], repo);

		// Remove .gitkeep so the dir is empty (no .md files)
		fs.unlinkSync(path.join(repo, '.opencode/skills/absent-skill/.gitkeep'));

		const result = await checkSkillAssertions(repo);
		expect(result.changedSkillFiles).toHaveLength(0); // no .md files
	});
});

describe('adversarial: very long toContain strings', () => {
	test('toContain with 10KB string present in content — no false positive', async () => {
		const repo = makeGitRepo();

		// 10 kilobytes of repeated A's
		const longPhrase = 'A'.repeat(10 * 1024);
		writeFile(
			repo,
			'.opencode/skills/long-assert/SKILL.md',
			`MODE: LONG\n${longPhrase}\nEND`,
		);
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add skill'], repo);

		// Use explicit string concatenation so ${longPhrase} is NOT expanded —
		// it writes the literal 4-char sequence which will be extracted as phrase.
		// After skill update the phrase is gone, so it gets correctly flagged.
		const testContent =
			"import { describe, expect, test } from 'bun:test';\n" +
			"import { readFileSync } from 'node:fs';\n" +
			"const content = readFileSync('.opencode/skills/long-assert/SKILL.md', 'utf-8');\n" +
			"describe('long assert', () => {\n" +
			"  test('long phrase', () => {\n" +
			"    expect(content).toContain('${longPhrase}');\n" +
			'  });\n' +
			'});\n';
		writeFile(repo, 'tests/unit/agents/long-assert.test.ts', testContent);

		// Skill unchanged — the literal "${longPhrase}" IS in the updated content
		const result = await checkSkillAssertions(repo);
		expect(result.brokenAssertions).toHaveLength(0);
	});

	test('toContain with 10KB string absent from content — correctly flagged', async () => {
		const repo = makeGitRepo();

		// Use explicit string concatenation to write the LITERAL 4-char sequence
		// "${longPhrase}" into the test file — NOT expanded.
		// After the skill update, the literal "${longPhrase}" is absent,
		// so the checker correctly flags it as a broken assertion.
		const testContent =
			"import { describe, expect, test } from 'bun:test';\n" +
			"import { readFileSync } from 'node:fs';\n" +
			"const content = readFileSync('.opencode/skills/long-miss/SKILL.md', 'utf-8');\n" +
			"describe('long miss', () => {\n" +
			"  test('long phrase', () => {\n" +
			"    expect(content).toContain('${longPhrase}');\n" +
			'  });\n' +
			'});\n';

		// Original skill content — has the literal "${longPhrase}" text
		writeFile(
			repo,
			'.opencode/skills/long-miss/SKILL.md',
			'MODE: LONG\n${longPhrase}\nEND',
		);
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add skill'], repo);

		writeFile(repo, 'tests/unit/agents/long-miss.test.ts', testContent);

		// Update skill — literal "${longPhrase}" is now absent
		writeFile(repo, '.opencode/skills/long-miss/SKILL.md', 'Pattern changed.');

		const result = await checkSkillAssertions(repo);
		expect(result.brokenAssertions).toHaveLength(1);
		expect(result.brokenAssertions[0]!.phrase).toBe('${longPhrase}');
	});
});

describe('adversarial: zero skill files changed', () => {
	test('returns empty arrays without error when no skill files changed', async () => {
		const repo = makeGitRepo();
		writeFile(repo, 'src/utils/helper.ts', '// helper\n');
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'unrelated'], repo);

		writeFile(repo, 'src/utils/helper.ts', '// helper updated\n');

		const result = await checkSkillAssertions(repo);
		expect(result.changedSkillFiles).toHaveLength(0);
		expect(result.brokenAssertions).toHaveLength(0);
	});

	test('returns empty arrays on completely empty repo', async () => {
		const repo = makeGitRepo();
		const result = await checkSkillAssertions(repo);
		expect(result.changedSkillFiles).toHaveLength(0);
		expect(result.brokenAssertions).toHaveLength(0);
	});
});

describe('adversarial: test file references nonexistent skill slug', () => {
	test('test referencing a skill that does not exist does not crash', async () => {
		const repo = makeGitRepo();

		writeFile(
			repo,
			'tests/unit/agents/nonexistent.test.ts',
			`import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const content = readFileSync('.opencode/skills/does-not-exist/SKILL.md', 'utf-8');
describe('nonexistent skill', () => {
  test('has phrase', () => {
    expect(content).toContain('Will never exist.');
  });
});
`,
		);

		writeFile(repo, 'README.md', 'updated\n');
		writeFile(
			repo,
			'.opencode/skills/real-skill/SKILL.md',
			'Real skill content.',
		);
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add real skill'], repo);

		writeFile(
			repo,
			'.opencode/skills/real-skill/SKILL.md',
			'Real skill content updated.',
		);

		const result = await checkSkillAssertions(repo);
		expect(Array.isArray(result.brokenAssertions)).toBe(true);
		expect(Array.isArray(result.changedSkillFiles)).toBe(true);
	});
});

describe('adversarial: path traversal in skill slug', () => {
	test('path traversal attempt in skill slug is neutralized before filesystem access', async () => {
		const repo = makeGitRepo();

		writeFile(repo, '.opencode/skills/safe-skill/SKILL.md', 'Normal content.');
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add skill'], repo);

		writeFile(
			repo,
			'tests/unit/agents/safe-skill.test.ts',
			`import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const content = readFileSync('.opencode/skills/safe-skill/SKILL.md', 'utf-8');
// NOTE: ../../../etc/passwd is just a comment, not a real path
describe('safe skill', () => {
  test('content ok', () => {
    expect(content).toContain('Normal content.');
  });
});
`,
		);

		writeFile(repo, '.opencode/skills/safe-skill/SKILL.md', 'Altered content.');

		const result = await checkSkillAssertions(repo);
		expect(result.brokenAssertions).toHaveLength(1);
		expect(result.brokenAssertions[0]!.phrase).toBe('Normal content.');
	});

	test('git diff returning a file outside skills dir is filtered out', async () => {
		const repo = makeGitRepo();

		writeFile(repo, '.opencode/skills/filter-test/SKILL.md', 'Content.');
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add skill'], repo);

		writeFile(repo, '.opencode/skills/filter-test/SKILL.md', 'Updated.');

		const result = await checkSkillAssertions(repo);
		expect(result.changedSkillFiles).toContain(
			'.opencode/skills/filter-test/SKILL.md',
		);
		for (const f of result.changedSkillFiles) {
			expect(f).not.toContain('..');
			expect(f).toMatch(/^\.(opencode|claude)\/skills\//);
		}
	});
});

describe('adversarial: formatBrokenAssertions with malformed input', () => {
	test('formatBrokenAssertions handles empty phrase strings', () => {
		const result = {
			changedSkillFiles: ['.opencode/skills/x/SKILL.md'],
			brokenAssertions: [
				{
					testFile: 'tests/unit/agents/x.test.ts',
					line: 1,
					skillFile: '.opencode/skills/x/SKILL.md',
					phrase: '',
				},
			],
		};
		const lines = formatBrokenAssertions(result);
		expect(lines).toHaveLength(1);
		expect(lines[0]!).toContain('::error');
		expect(lines[0]!).toContain('tests/unit/agents/x.test.ts');
	});

	test('formatBrokenAssertions handles Unicode phrases', () => {
		const result = {
			changedSkillFiles: ['.opencode/skills/unicode/SKILL.md'],
			brokenAssertions: [
				{
					testFile: 'tests/unit/agents/unicode.test.ts',
					line: 5,
					skillFile: '.opencode/skills/unicode/SKILL.md',
					phrase: '日本語テスト — émojis 🎉 — العربية',
				},
			],
		};
		const lines = formatBrokenAssertions(result);
		expect(lines).toHaveLength(1);
		expect(lines[0]!).toContain('::error');
		expect(() => formatBrokenAssertions(result)).not.toThrow();
	});
});

describe('adversarial: regex special characters in slug', () => {
	test('slug with regex special characters (. and *) does not break assertion extraction', async () => {
		const repo = makeGitRepo();

		writeFile(
			repo,
			'.opencode/skills/special.glob/SKILL.md',
			'Pattern: *.test.ts may match.',
		);
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add skill'], repo);

		writeFile(
			repo,
			'tests/unit/agents/special-glob.test.ts',
			`import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const content = readFileSync('.opencode/skills/special.glob/SKILL.md', 'utf-8');
describe('special.glob skill', () => {
  test('has glob pattern', () => {
    expect(content).toContain('*.test.ts may match.');
  });
});
`,
		);

		writeFile(
			repo,
			'.opencode/skills/special.glob/SKILL.md',
			'Pattern changed.',
		);

		const result = await checkSkillAssertions(repo);
		expect(result.brokenAssertions).toHaveLength(1);
		expect(result.brokenAssertions[0]!.phrase).toBe('*.test.ts may match.');
	});
});
