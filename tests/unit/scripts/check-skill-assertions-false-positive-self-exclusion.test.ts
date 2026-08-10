/**
 * FR-005 regression for the self-exclusion defect class.
 *
 * SC-004: phrases inside the detector's own test file fixture template
 * strings must NOT be reported as broken assertions against any changed skill.
 *
 * HEADER NOTE (unfixed-detector reproduction):
 * The unfixed detector (cycle 1) did not skip its own test directory, so
 * phrases inside the detector's own test fixtures were harvested as real
 * assertions about real skills.
 *
 * CURRENT STATE: scanDirForReferences (line 165) skips tests/unit/scripts/
 * for the detector's own files. This test verifies the skip works.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkSkillAssertions } from '../../../scripts/check-skill-assertions';

const GIT_TIMEOUT_MS = 15_000;
const tempDirs: string[] = [];

function makeGitRepo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'self-excl-'));
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

describe('SC-004: detector skips its own test files', () => {
	test('phrases inside tests/unit/scripts/ fixtures are NOT reported as broken', async () => {
		const repo = makeGitRepo();
		// Create the detector's own test directory tree inside the temp repo
		// and add a fixture file there that mentions the skill slug.
		mkdirSyncLocal(repo, 'tests/unit/scripts/');
		writeFile(
			repo,
			'tests/unit/scripts/detector-self.test.ts',
			`
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// This file lives under tests/unit/scripts/ and contains a fixture phrase.
// The detector should skip this directory entirely when scanning.
const content = readFileSync(
  join(process.cwd(), '.opencode/skills/test/SKILL.md'),
  'utf-8',
);
describe('self', () => {
  test('fake fixture phrase', () => {
    expect(content).toContain('FAKE FIXTURE PHRASE — should not be reported');
  });
});
`,
		);
		// Create a real skill file that the detector will look at
		mkdirSyncLocal(repo, '.opencode/skills/test/');
		writeFile(
			repo,
			'.opencode/skills/test/SKILL.md',
			'# TEST\n\nreal content\n',
		);

		spawnSync('git', ['add', '.'], {
			cwd: repo,
			stdio: 'ignore',
			timeout: GIT_TIMEOUT_MS,
		});
		spawnSync('git', ['commit', '-q', '-m', 'add skill and fixture'], {
			cwd: repo,
			stdio: 'ignore',
			timeout: GIT_TIMEOUT_MS,
		});

		// Modify the skill so the detector runs
		writeFile(
			repo,
			'.opencode/skills/test/SKILL.md',
			'# TEST\n\nreal content updated\n',
		);

		const result = await checkSkillAssertions(repo);
		// The fixture phrase from tests/unit/scripts/detector-self.test.ts
		// must NOT be reported as a broken assertion
		const fixturePhrase = 'FAKE FIXTURE PHRASE — should not be reported';
		const brokenFixturePhrase = result.brokenAssertions.find(
			(b) => b.phrase === fixturePhrase,
		);
		expect(brokenFixturePhrase).toBeUndefined();
	});

	test('phrases inside string-literal regions of test files are NOT reported', async () => {
		const repo = makeGitRepo();
		mkdirSyncLocal(repo, '.opencode/skills/test/');
		writeFile(
			repo,
			'.opencode/skills/test/SKILL.md',
			'# TEST\n\nreal content\n',
		);
		mkdirSyncLocal(repo, 'tests/unit/agents/');
		writeFile(
			repo,
			'tests/unit/agents/string-literal-fixture.test.ts',
			`
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const content = readFileSync(
  join(process.cwd(), '.opencode/skills/test/SKILL.md'),
  'utf-8',
);
// The phrase below is inside a TEMPLATE LITERAL — fixture data, not a real assertion.
const FIXTURE_PHRASE = "expect(content).toContain('fixture-only-phrase')";
describe('lit', () => {
  test('real', () => {
    expect(content).toContain('real content');
  });
});
`,
		);
		spawnSync('git', ['add', '.'], {
			cwd: repo,
			stdio: 'ignore',
			timeout: GIT_TIMEOUT_MS,
		});
		spawnSync('git', ['commit', '-q', '-m', 'add skill and test'], {
			cwd: repo,
			stdio: 'ignore',
			timeout: GIT_TIMEOUT_MS,
		});

		// Modify the skill so the detector runs
		writeFile(
			repo,
			'.opencode/skills/test/SKILL.md',
			'# TEST\n\nreal content updated\n',
		);

		const result = await checkSkillAssertions(repo);
		// 'fixture-only-phrase' is inside a string literal in the test file
		// fixture, NOT a real assertion. It must NOT be reported.
		const fixtureOnlyPhrase = result.brokenAssertions.find(
			(b) => b.phrase === 'fixture-only-phrase',
		);
		expect(fixtureOnlyPhrase).toBeUndefined();
	});
});

// Local helper to avoid importing node:fs.mkdirSync at top
function mkdirSyncLocal(root: string, relPath: string): void {
	const full = path.join(root, relPath);
	fs.mkdirSync(full, { recursive: true });
}
