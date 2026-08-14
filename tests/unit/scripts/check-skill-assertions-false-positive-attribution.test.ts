/**
 * FR-005 regression for the precise target attribution defect class.
 *
 * SC-005: a test file that loads both an architect prompt (variable P) and a
 * skill (variable S) and asserts `expect(P).toContain('prompt phrase')` must
 * NOT report 'prompt phrase' as a broken assertion against S (the assertion
 * targets the prompt, not the skill).
 *
 * HEADER NOTE (unfixed-detector reproduction):
 * The unfixed detector used a ±2 line window for attribution, which could
 * mis-attribute an assertion to a different confirmed variable when both
 * variables were nearby.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkSkillAssertions } from '../../../scripts/check-skill-assertions';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const GIT_TIMEOUT_MS = 15_000;
const tempDirs: string[] = [];

function makeGitRepo(): string {
	const root = canonicalMkdtemp('attr-');
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
	// PRR-007: fs.rmSync, not `rm -rf` — the latter does not exist on Windows,
	// so the temp repo would leak on the Windows CI shards.
	if (d) fs.rmSync(d, { recursive: true, force: true });
});

describe('SC-005: precise target attribution', () => {
	test('assertion on prompt variable is NOT attributed to the skill', async () => {
		const repo = makeGitRepo();
		// Create a fake "architect prompt" file
		mkdirSyncLocal(repo, 'src/agents/');
		writeFile(
			repo,
			'src/agents/architect.ts',
			'# ARCHITECT\n\nthis prompt contains architect-only phrase\n',
		);
		// Create a skill file (separate)
		mkdirSyncLocal(repo, '.opencode/skills/test/');
		writeFile(
			repo,
			'.opencode/skills/test/SKILL.md',
			'# TEST\n\nskill content\n',
		);

		spawnSync('git', ['add', '.'], {
			cwd: repo,
			stdio: 'ignore',
			timeout: GIT_TIMEOUT_MS,
		});
		spawnSync('git', ['commit', '-q', '-m', 'add files'], {
			cwd: repo,
			stdio: 'ignore',
			timeout: GIT_TIMEOUT_MS,
		});

		// Test file that reads both the architect prompt AND the skill content
		mkdirSyncLocal(repo, 'tests/unit/agents/');
		writeFile(
			repo,
			'tests/unit/agents/two-vars.test.ts',
			`
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const prompt = readFileSync(
  join(process.cwd(), 'src/agents/architect.ts'),
  'utf-8',
);
const skill = readFileSync(
  join(process.cwd(), '.opencode/skills/test/SKILL.md'),
  'utf-8',
);
describe('two-vars', () => {
  test('prompt phrase', () => {
    expect(prompt).toContain('architect-only phrase');
  });
  test('skill phrase', () => {
    expect(skill).toContain('skill content');
  });
});
`,
		);

		// Modify the skill so the detector runs, removing 'skill content' so the
		// assertion that DOES target the skill genuinely breaks.
		writeFile(repo, '.opencode/skills/test/SKILL.md', '# TEST\n\nreplaced\n');

		const result = await checkSkillAssertions(repo);
		expect(result.changedSkillFiles).toContain(
			'.opencode/skills/test/SKILL.md',
		);
		// SC-005: 'architect-only phrase' is asserted against `prompt`, not `skill`.
		// It must NOT be reported as a broken assertion against the skill.
		const promptPhraseBroken = result.brokenAssertions.find(
			(b) => b.phrase === 'architect-only phrase',
		);
		expect(promptPhraseBroken).toBeUndefined();

		// PRR-006 positive control: the assertion that genuinely targets the skill
		// MUST be reported. Without this, the negative assertion above would also
		// pass if the detector silently stopped emitting anything at all.
		const skillPhraseBroken = result.brokenAssertions.find(
			(b) => b.phrase === 'skill content',
		);
		expect(skillPhraseBroken).toBeDefined();
		expect(skillPhraseBroken!.assertionKind).toBe('toContain');
		expect(skillPhraseBroken!.skillFile).toBe('.opencode/skills/test/SKILL.md');
	});
});

function mkdirSyncLocal(root: string, relPath: string): void {
	const full = path.join(root, relPath);
	fs.mkdirSync(full, { recursive: true });
}
