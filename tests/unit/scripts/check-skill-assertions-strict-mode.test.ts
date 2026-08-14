/**
 * PRR-006 — coverage for the SKILL_ASSERTIONS_STRICT=1 hard-fail path.
 *
 * FR-006 made skill-assertion findings advisory: the CLI reports them and
 * exits 0, so a broken assertion never blocks a merge on its own.
 * SKILL_ASSERTIONS_STRICT=1 is the documented opt-in that turns the same
 * findings into `process.exit(1)`. That branch had no test.
 *
 * Why a subprocess: the branch under test IS `process.exit(1)`. Calling it
 * in-process would kill the bun test runner mid-suite, and stubbing
 * process.exit would let execution fall through past the call site — a false
 * pass, and a mock.module isolation hazard (AGENTS.md invariant 7). Spawning
 * the real CLI and asserting on its exit code tests the actual behavior with
 * no mocks.
 *
 * The detector resolves REPO_ROOT from its own file location, so the script is
 * copied into the fixture repo. It imports only node builtins, which is what
 * makes that copy safe; if it ever gains a repo-relative import, this test
 * will fail loudly at spawn rather than silently analyzing the wrong tree.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const GIT_TIMEOUT_MS = 15_000;
const CLI_TIMEOUT_MS = 60_000;
const DETECTOR_SRC = path.resolve(
	import.meta.dirname,
	'../../../scripts/check-skill-assertions.ts',
);
const tempDirs: string[] = [];

function runGit(args: string[], cwd: string): void {
	spawnSync('git', args, { cwd, stdio: 'ignore', timeout: GIT_TIMEOUT_MS });
}

function writeFile(root: string, relPath: string, content: string): void {
	const full = path.join(root, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
}

/**
 * Build a repo containing a copy of the detector plus one genuinely broken
 * skill assertion, so the CLI reaches the exit-code branch under test.
 */
function makeRepoWithBrokenAssertion(): string {
	const root = canonicalMkdtemp('strict-');
	tempDirs.push(root);
	runGit(['init', '-q'], root);
	runGit(['config', 'user.email', 'test@test.com'], root);
	runGit(['config', 'user.name', 'Test'], root);

	writeFile(
		root,
		'scripts/check-skill-assertions.ts',
		fs.readFileSync(DETECTOR_SRC, 'utf-8'),
	);
	writeFile(
		root,
		'.opencode/skills/test/SKILL.md',
		'# TEST\n\nstrict-phrase\n',
	);
	writeFile(
		root,
		'tests/unit/agents/strict.test.ts',
		`
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const content = readFileSync(
  join(process.cwd(), '.opencode/skills/test/SKILL.md'),
  'utf-8',
);
describe('strict', () => {
  test('phrase', () => {
    expect(content).toContain('strict-phrase');
  });
});
`,
	);
	runGit(['add', '.'], root);
	runGit(['commit', '-q', '-m', 'initial'], root);

	// Remove the phrase so the assertion is broken against the changed skill.
	writeFile(root, '.opencode/skills/test/SKILL.md', '# TEST\n\nreplaced\n');
	return root;
}

function runDetectorCli(
	repo: string,
	env: Record<string, string>,
): { status: number | null; stdout: string } {
	const result = spawnSync(
		process.execPath,
		[path.join(repo, 'scripts/check-skill-assertions.ts')],
		{
			cwd: repo,
			encoding: 'utf-8',
			timeout: CLI_TIMEOUT_MS,
			env: { ...process.env, ...env },
		},
	);
	return {
		status: result.status,
		stdout: `${result.stdout ?? ''}${result.stderr ?? ''}`,
	};
}

afterEach(() => {
	const d = tempDirs.pop();
	if (d) fs.rmSync(d, { recursive: true, force: true });
});

describe('PRR-006: SKILL_ASSERTIONS_STRICT hard-fail path', () => {
	test('default (advisory) exits 0 even though a broken assertion is found', () => {
		const repo = makeRepoWithBrokenAssertion();
		const { status, stdout } = runDetectorCli(repo, {
			SKILL_ASSERTIONS_STRICT: '',
		});
		// Control: the run must actually FIND the broken assertion, otherwise
		// exit 0 would prove nothing about the advisory default.
		expect(stdout).toContain('broken assertion');
		expect(status).toBe(0);
	});

	test('SKILL_ASSERTIONS_STRICT=1 exits 1 on the same repo', () => {
		const repo = makeRepoWithBrokenAssertion();
		const { status, stdout } = runDetectorCli(repo, {
			SKILL_ASSERTIONS_STRICT: '1',
		});
		expect(stdout).toContain('broken assertion');
		expect(status).toBe(1);
	});

	test('SKILL_ASSERTIONS_STRICT=1 still exits 0 when nothing is broken', () => {
		const repo = makeRepoWithBrokenAssertion();
		// Restore the phrase so the assertion holds again.
		writeFile(
			repo,
			'.opencode/skills/test/SKILL.md',
			'# TEST\n\nstrict-phrase restored\n',
		);
		const { status } = runDetectorCli(repo, { SKILL_ASSERTIONS_STRICT: '1' });
		// Strict mode escalates real findings; it must not fail a clean run.
		expect(status).toBe(0);
	});
});
