/**
 * PRR-005 — recall boundary of FR-004 exact-line attribution.
 *
 * FR-004 (issue #2069) deliberately narrowed attribution: an assertion counts
 * against a skill ONLY when the assertion's own line chains off a confirmed
 * skill variable. The previous ±2-line proximity window, plus a
 * `// skill-assertion:` comment fallback, were both removed because proximity
 * mis-attributed assertions and produced 68 false positives on a single PR.
 *
 * The cost of that trade is a real recall loss: an assertion split across two
 * lines is no longer attributed, because the line carrying `.toContain(...)`
 * does not itself contain `expect(<skillVar>)`.
 *
 * These tests PIN that trade-off rather than assert it is desirable. Both
 * assertions below are genuinely broken against the skill; only the
 * single-line one is reported. If recall is ever restored, the multi-line
 * expectation here is the one to update — deliberately, with its own review —
 * and reopening proximity-based attribution must not reintroduce #2069.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkSkillAssertions } from '../../../scripts/check-skill-assertions';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const GIT_TIMEOUT_MS = 15_000;
const tempDirs: string[] = [];

function runGit(args: string[], cwd: string): void {
	spawnSync('git', args, { cwd, stdio: 'ignore', timeout: GIT_TIMEOUT_MS });
}

function makeGitRepo(): string {
	const root = canonicalMkdtemp('recall-');
	runGit(['init', '-q'], root);
	runGit(['config', 'user.email', 'test@test.com'], root);
	runGit(['config', 'user.name', 'Test'], root);
	fs.writeFileSync(path.join(root, 'README.md'), 'initial\n', 'utf-8');
	runGit(['add', 'README.md'], root);
	runGit(['commit', '-q', '-m', 'initial'], root);
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
	if (d) fs.rmSync(d, { recursive: true, force: true });
});

describe('PRR-005: FR-004 exact-line attribution recall boundary', () => {
	test('single-line assertion is reported; the equivalent multi-line assertion is not', async () => {
		const repo = makeGitRepo();
		writeFile(
			repo,
			'.opencode/skills/test/SKILL.md',
			'# TEST\n\nsingle-line-phrase and multi-line-phrase\n',
		);

		// Both assertions target the same confirmed skill variable and both
		// phrases are removed from the skill below, so both are genuinely
		// broken. They differ ONLY in line layout.
		writeFile(
			repo,
			'tests/unit/agents/recall.test.ts',
			`
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const content = readFileSync(
  join(process.cwd(), '.opencode/skills/test/SKILL.md'),
  'utf-8',
);
describe('recall', () => {
  test('single line', () => {
    expect(content).toContain('single-line-phrase');
  });
  test('split across lines', () => {
    expect(content)
      .toContain('multi-line-phrase');
  });
});
`,
		);
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add skill and test'], repo);

		// Remove BOTH phrases — both assertions are now broken in fact.
		writeFile(repo, '.opencode/skills/test/SKILL.md', '# TEST\n\nreplaced\n');

		const result = await checkSkillAssertions(repo);
		expect(result.changedSkillFiles).toContain(
			'.opencode/skills/test/SKILL.md',
		);

		// Control: the single-line form IS attributed and reported.
		const singleLine = result.brokenAssertions.find(
			(b) => b.phrase === 'single-line-phrase',
		);
		expect(singleLine).toBeDefined();
		expect(singleLine!.assertionKind).toBe('toContain');

		// PRR-005: the multi-line form is NOT reported — a known false negative,
		// not an accident of this fixture. The control above proves the detector
		// ran against this very file and was capable of reporting.
		const multiLine = result.brokenAssertions.find(
			(b) => b.phrase === 'multi-line-phrase',
		);
		expect(multiLine).toBeUndefined();
	});

	test('a `// skill-assertion:` comment does not restore attribution', async () => {
		const repo = makeGitRepo();
		writeFile(
			repo,
			'.opencode/skills/test/SKILL.md',
			'# TEST\n\ncommented-phrase\n',
		);

		// The detector's docblock previously advertised a `// skill-assertion:`
		// comment fallback. FR-004 removed it; this pins that it is really gone,
		// so the docblock and the code cannot silently disagree again.
		writeFile(
			repo,
			'tests/unit/agents/commented.test.ts',
			`
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const content = readFileSync(
  join(process.cwd(), '.opencode/skills/test/SKILL.md'),
  'utf-8',
);
const other = 'unrelated string';
describe('commented', () => {
  test('comment-attributed', () => {
    // skill-assertion: .opencode/skills/test/SKILL.md
    expect(other).toContain('commented-phrase');
  });
});
`,
		);
		runGit(['add', '.'], repo);
		runGit(['commit', '-q', '-m', 'add skill and test'], repo);

		writeFile(repo, '.opencode/skills/test/SKILL.md', '# TEST\n\nreplaced\n');

		const result = await checkSkillAssertions(repo);
		// The assertion chains off `other`, not the skill variable. The comment
		// does not re-attribute it, so nothing is reported for this phrase.
		const commented = result.brokenAssertions.find(
			(b) => b.phrase === 'commented-phrase',
		);
		expect(commented).toBeUndefined();
	});
});
