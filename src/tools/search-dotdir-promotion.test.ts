import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir.js';
import type { ToolResult } from './create-tool';
import { search, _internals as searchInternals } from './search';

function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

async function executeSearch(
	args: Record<string, unknown>,
	directory: string,
): Promise<string> {
	const result = await search.execute(args, {
		directory,
	} as unknown as ToolContext);
	return resultToString(result);
}

let tmpDir: string;
const realResolveRipgrepBinary = searchInternals.resolveRipgrepBinary;
const realRunExternalTool = searchInternals.runExternalTool;
const realFallbackSearch = searchInternals.fallbackSearch;

// Real ripgrep availability, probed before any test stubs _internals.
const hasRealRipgrep = realResolveRipgrepBinary() !== null;

// Symlinks need elevated privileges on Windows; probe once so the alias test
// can skip rather than fail on machines without them.
let canCreateSymlinks = false;
try {
	const probeDir = canonicalMkdtemp('sdp-probe-');
	symlinkSync(
		path.join(probeDir, 'target'),
		path.join(probeDir, 'alias'),
		'file',
	);
	canCreateSymlinks = true;
	rmSync(probeDir, { recursive: true, force: true });
} catch {
	canCreateSymlinks = false;
}

beforeEach(() => {
	tmpDir = canonicalMkdtemp('sdp-test-');
});

afterEach(() => {
	searchInternals.resolveRipgrepBinary = realResolveRipgrepBinary;
	searchInternals.runExternalTool = realRunExternalTool;
	searchInternals.fallbackSearch = realFallbackSearch;
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

function createTestFile(relativePath: string, content: string): void {
	const fullPath = path.join(tmpDir, relativePath);
	mkdirSync(path.dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content);
}

function stubRgCapture(): { args: () => string[] | undefined } {
	let captured: string[] | undefined;
	searchInternals.resolveRipgrepBinary = () => '/usr/bin/rg';
	searchInternals.runExternalTool = async (opts: { args: string[] }) => {
		captured = opts.args;
		return {
			status: 'success' as const,
			stdout: '',
			stderr: '',
			exitCode: 1,
			stdoutTruncated: false,
			stderrTruncated: false,
		};
	};
	return { args: () => captured };
}

// ============ Resolved-path .git guard (#2212 follow-up) ============

describe('search - promotion resolved-path .git guard', () => {
	it('does not promote an exact path resolving into a nested .git directory', async () => {
		createTestFile(
			'.swarm/sub/.git/config',
			'[remote "origin"]\n  url = https://token@github.com/org/repo\n',
		);
		const cap = stubRgCapture();

		await executeSearch(
			{ query: '.*', mode: 'regex', include: '.swarm/sub/.git/config' },
			tmpDir,
		);

		const args = cap.args();
		expect(args).toBeDefined();
		// Not promoted: search roots at '.' and relies on the !.git guard glob.
		expect(args[args.length - 1]).toBe('.');
		expect(args).toContain('--hidden');
		expect(args).toContain('--no-ignore');
		expect(args).toContain('!.git');
	});

	it.skipIf(!canCreateSymlinks)(
		'does not promote an exact path through a symlink aliasing .git',
		async () => {
			createTestFile(
				'.git/config',
				'[remote "origin"]\n  url = https://token@github.com/org/repo\n',
			);
			symlinkSync(path.join(tmpDir, '.git'), path.join(tmpDir, '.foo'), 'dir');
			const cap = stubRgCapture();

			await executeSearch(
				{ query: '.*', mode: 'regex', include: '.foo/config' },
				tmpDir,
			);

			const args = cap.args();
			expect(args).toBeDefined();
			expect(args[args.length - 1]).toBe('.');
			expect(args).toContain('!.git');
		},
	);

	it.skipIf(!hasRealRipgrep)(
		'end-to-end with real ripgrep: finds a dot-dir skill file, never .git content',
		async () => {
			createTestFile(
				'.swarm/bundled-skills/example/SKILL.md',
				'# Example Skill\nNEEDLE_DOTDIR_CONTENT\n',
			);
			createTestFile(
				'.git/config',
				'[remote "origin"]\n  url = https://NEEDLE_GIT_TOKEN@github.com/org/repo\n',
			);

			const found = await executeSearch(
				{
					query: 'NEEDLE_DOTDIR_CONTENT',
					include: '.swarm/bundled-skills/example/SKILL.md',
				},
				tmpDir,
			);
			const parsedFound = JSON.parse(found);
			expect(parsedFound.error).toBeUndefined();
			expect(parsedFound.engine).toBe('ripgrep');
			expect(parsedFound.total).toBe(1);
			expect(parsedFound.matches[0].file).toBe(
				'.swarm/bundled-skills/example/SKILL.md',
			);

			const gitBlocked = await executeSearch(
				{ query: 'NEEDLE_GIT_TOKEN', include: '.git/config' },
				tmpDir,
			);
			const parsedGit = JSON.parse(gitBlocked);
			expect(parsedGit.error).toBeUndefined();
			expect(parsedGit.total).toBe(0);
		},
	);
});

// ============ Promotion shape and error surfacing ============

describe('search - promotion argv shape and hardening', () => {
	it('promotes multiple exact dot-dir includes to operands in caller order', async () => {
		createTestFile('.swarm/a/SKILL.md', 'a\n');
		createTestFile('.swarm/b/SKILL.md', 'b\n');
		const cap = stubRgCapture();

		await executeSearch(
			{
				query: '.*',
				mode: 'regex',
				include: '.swarm/a/SKILL.md,.swarm/b/SKILL.md',
			},
			tmpDir,
		);

		const args = cap.args();
		const dashDashIdx = args.indexOf('--');
		expect(args.slice(dashDashIdx + 2)).toEqual([
			'.swarm/a/SKILL.md',
			'.swarm/b/SKILL.md',
		]);
	});

	it('keeps exclude globs in argv alongside promoted path operands', async () => {
		createTestFile('.swarm/a/SKILL.md', 'a\n');
		const cap = stubRgCapture();

		await executeSearch(
			{
				query: '.*',
				mode: 'regex',
				include: '.swarm/a/SKILL.md',
				exclude: 'OTHER.md',
			},
			tmpDir,
		);

		const args = cap.args();
		expect(args).toContain('!OTHER.md');
		expect(args[args.length - 1]).toBe('.swarm/a/SKILL.md');
	});

	it('nonexistent dot-dir include stays in the glob branch without error', async () => {
		const cap = stubRgCapture();

		const result = await executeSearch(
			{ query: '.*', mode: 'regex', include: '.swarm/missing.md' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.total).toBe(0);
		const args = cap.args();
		expect(args[args.length - 1]).toBe('.');
		expect(args).toContain('--hidden');
	});

	it.skipIf(process.platform !== 'win32')(
		'promotes Windows backslash-form dot-dir includes',
		async () => {
			createTestFile('.swarm\\a\\SKILL.md', 'a\n');
			const cap = stubRgCapture();

			await executeSearch(
				{ query: '.*', mode: 'regex', include: '.swarm\\a\\SKILL.md' },
				tmpDir,
			);

			const args = cap.args();
			expect(args[args.length - 1]).toBe('.swarm\\a\\SKILL.md');
		},
	);

	it('promotes an exact dot-directory include (directory operand)', async () => {
		createTestFile('.swarm/bundled-skills/example/SKILL.md', 'x\n');
		const cap = stubRgCapture();

		await executeSearch(
			{ query: '.*', mode: 'regex', include: '.swarm' },
			tmpDir,
		);

		const args = cap.args();
		expect(args[args.length - 1]).toBe('.swarm');
		expect(args).not.toContain('--hidden');
	});

	it('surfaces ripgrep exit-2 stderr as an error instead of zero matches', async () => {
		createTestFile('.swarm/a/SKILL.md', 'a\n');
		searchInternals.resolveRipgrepBinary = () => '/usr/bin/rg';
		searchInternals.runExternalTool = async () => ({
			status: 'success' as const,
			stdout: '',
			stderr: 'error parsing glob: unexpected character',
			exitCode: 2,
			stdoutTruncated: false,
			stderrTruncated: false,
		});

		const result = await executeSearch(
			{ query: '.*', mode: 'regex', include: '.swarm/**' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('unknown');
		expect(parsed.message).toContain('error parsing glob');
	});

	it('rejects more than 100 include patterns', async () => {
		const many = Array.from({ length: 101 }, (_, i) => `dir${i}/**`).join(',');

		const result = await executeSearch({ query: 'x', include: many }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-query');
		expect(parsed.message).toContain('Too many include patterns');
	});
});

// ============ Fallback engine .git hard block ============

describe('search - fallback .git hard block', () => {
	it('skips a nested .git under an explicitly included dot-directory', async () => {
		searchInternals.resolveRipgrepBinary = () => null;
		createTestFile(
			'.swarm/sub/.git/config',
			'[remote "origin"]\n  url = https://FALLBACK_NESTED_TOKEN@github.com\n',
		);
		createTestFile('.swarm/keep.txt', 'FALLBACK_NESTED_MARKER\n');

		const result = await executeSearch(
			{
				query: 'FALLBACK_NESTED',
				include: '.swarm/**',
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);
		const files = parsed.matches.map((m: { file: string }) => m.file);

		expect(files).toContain('.swarm/keep.txt');
		expect(files).not.toContain('.swarm/sub/.git/config');
	});

	it('skips a case-variant .Git directory (renamed git dir)', async () => {
		searchInternals.resolveRipgrepBinary = () => null;
		createTestFile(
			'.Git/config',
			'[remote "origin"]\n  url = https://FALLBACK_CASE_TOKEN@github.com\n',
		);
		createTestFile('src/app.ts', 'unrelated\n');

		const result = await executeSearch(
			{ query: 'FALLBACK_CASE_TOKEN', include: '.Git/config' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.total).toBe(0);
	});
});
