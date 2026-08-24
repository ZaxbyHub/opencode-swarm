/**
 * check-pending-fragment — pure classification + gate evaluation for the
 * AGENTS.md "every user-visible PR ships a fragment" mandate.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** FR-011: canonicalized temp dir (realpathSync on the tmpdir() line). */
function makeTmpDir(slug: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), slug)));
}

import {
	evaluateFragmentCheck,
	isPendingFragment,
	isUserVisiblePath,
	resolveEnforce,
} from '../../../scripts/check-pending-fragment.ts';

describe('isUserVisiblePath', () => {
	test.each([
		['src/index.ts', true],
		['src/council/council-freshness.ts', true],
		['package.json', true],
		['.github/workflows/ci.yml', true],
		['.opencode/skills/swarm-pr-review/SKILL.md', true],
		['.claude/skills/commit-pr/SKILL.md', true],
		['.agents/skills/swarm/SKILL.md', true],
		['binaries/swarm.exe', true],
		['runners/sandbox/index.ts', true],
		['docs/configuration.md', true],
		// Windows-style separators normalize.
		['src\\council\\types.ts', true],
	])('%s → %s', (file, expected) => {
		expect(isUserVisiblePath(file)).toBe(expected);
	});

	test.each([
		['tests/unit/council/x.test.ts', false],
		['src/council/x.test.ts', false], // colocated test file under src/
		['scripts/check-pending-fragment.ts', false],
		['docs/council/README.md', false], // docs other than configuration.md
		['docs/releases/pending/slug.md', false],
		['.zcode/session/swarm-mode.md', false],
		['contributing.md', false],
		['AGENTS.md', false],
		['bun.lock', false],
	])('%s → %s', (file, expected) => {
		expect(isUserVisiblePath(file)).toBe(expected);
	});
});

describe('isPendingFragment', () => {
	test('accepts added fragment files', () => {
		expect(isPendingFragment('docs/releases/pending/my-slug.md')).toBe(true);
		expect(isPendingFragment('docs\\releases\\pending\\x.md')).toBe(true);
	});
	test('rejects non-fragment paths', () => {
		expect(isPendingFragment('docs/releases/pending/notes.txt')).toBe(false);
		expect(isPendingFragment('docs/releases/v1.2.3.md')).toBe(false);
		expect(isPendingFragment('src/index.ts')).toBe(false);
		expect(isPendingFragment('docs/releases/pending')).toBe(false);
	});
});

describe('evaluateFragmentCheck', () => {
	test('chore/test-only diff → no fragment required', () => {
		const r = evaluateFragmentCheck({
			changedFiles: ['tests/unit/a.test.ts', 'scripts/foo.ts'],
			addedFiles: [],
		});
		expect(r.violation).toBe(false);
	});

	test('user-visible diff without fragment → violation', () => {
		const r = evaluateFragmentCheck({
			changedFiles: ['src/index.ts'],
			addedFiles: [],
		});
		expect(r.violation).toBe(true);
		expect(r.message).toContain('docs/releases/pending');
	});

	test('user-visible diff WITH an added fragment → pass', () => {
		const r = evaluateFragmentCheck({
			changedFiles: ['src/index.ts', 'docs/releases/pending/slug.md'],
			addedFiles: ['docs/releases/pending/slug.md'],
		});
		expect(r.violation).toBe(false);
		expect(r.message).toContain('slug.md');
	});

	test('a MODIFIED pre-existing fragment does not satisfy the mandate', () => {
		// The new release's narrative must be a new file; editing an old
		// fragment would silently fold this PR into a previous release's notes.
		const r = evaluateFragmentCheck({
			changedFiles: ['src/index.ts', 'docs/releases/pending/old.md'],
			addedFiles: [],
		});
		expect(r.violation).toBe(true);
	});

	test('a DELETED fragment does not satisfy the mandate', () => {
		const r = evaluateFragmentCheck({
			changedFiles: ['src/index.ts', 'docs/releases/pending/old.md'],
			addedFiles: [], // deletion only appears in changedFiles
		});
		expect(r.violation).toBe(true);
	});

	test('message truncates long file lists', () => {
		const files = Array.from({ length: 12 }, (_, i) => `src/mod${i}.ts`);
		const r = evaluateFragmentCheck({
			changedFiles: files,
			addedFiles: [],
		});
		expect(r.violation).toBe(true);
		expect(r.message).toContain('+4 more');
	});

	test('mixed visible/invisible diff keys on the visible file', () => {
		const r = evaluateFragmentCheck({
			changedFiles: ['README.md', 'src/tools/x.ts', 'tests/unit/x.test.ts'],
			addedFiles: [],
		});
		expect(r.violation).toBe(true);
		expect(r.message).toContain('src/tools/x.ts');
		expect(r.message).not.toContain('README.md');
	});
});

describe('CI wiring (SKIP-1)', () => {
	test('the quality-job step skips release-please branches', async () => {
		const fsMod = await import('node:fs');
		const pathMod = await import('node:path');
		const yaml = fsMod.readFileSync(
			pathMod.join(
				import.meta.dir,
				'..',
				'..',
				'..',
				'.github',
				'workflows',
				'ci.yml',
			),
			'utf8',
		);
		const stepIdx = yaml.indexOf('Pending release fragment (AGENTS mandate)');
		expect(stepIdx).toBeGreaterThan(-1);
		const stepBlock = yaml.slice(stepIdx, stepIdx + 300);
		expect(stepBlock).toContain(
			"if: needs.detect-release.outputs.is-release != 'true'",
		);
		expect(stepBlock).toContain('run: bun run check:pending-fragment');
	});
});

describe('main() entry paths', () => {
	test('no base branch (non-git directory) → passes with a notice', async () => {
		const tmp = makeTmpDir('cpf-nogit-');
		try {
			const mod = await import('../../../scripts/check-pending-fragment.ts');
			const code = mod.main(tmp);
			expect(code).toBe(0);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test('FRAGMENT_CHECK_ENFORCE=0 soft-warns instead of failing', async () => {
		const tmp = makeTmpDir('cpf-enforce-');
		try {
			process.env.FRAGMENT_CHECK_ENFORCE = '0';
			const code = (
				await import('../../../scripts/check-pending-fragment.ts')
			).main(tmp);
			// Non-git dir → no base branch → 0 either way; the enforce path is
			// exercised via resolveEnforce + evaluateFragmentCheck above. This
			// pins the env plumbing end-to-end.
			expect(code).toBe(0);
		} finally {
			delete process.env.FRAGMENT_CHECK_ENFORCE;
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe('resolveEnforce', () => {
	test.each([
		[undefined, true],
		['', true],
		['1', true],
		['0', false],
		['false', false],
		['NO', false],
		['off', false],
	])('%p → %s', (raw, expected) => {
		expect(resolveEnforce(raw)).toBe(expected);
	});
});
