import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Issue #3299: the cleanup-release-fragments arm must feed the classifier a
 * NUL-end-to-end path list. The pre-fix producer round-tripped `git status
 * --porcelain` through a newline-delimited shell scalar and `cut -c4-`, which
 * C-quotes and splits adversarial paths before the classifier ever sees
 * them — a `src/` path containing a quote or newline silently classified as
 * not-required (fail-open). These tests extract the REAL conversion pipeline
 * and invocation from the workflow and execute both: the reducer must carry
 * every byte faithfully, and the classifier verdict must flip to required on
 * a faithful user-visible path (so a dropped or mangled entry cannot fake
 * required=false).
 */

const root = path.resolve(import.meta.dir, '../../..');
const releaseWorkflowPath = path.join(
	root,
	'.github',
	'workflows',
	'release-and-publish.yml',
);
const releaseWorkflow = parse(readFileSync(releaseWorkflowPath, 'utf8'));

const createdTempDirs: string[] = [];

afterAll(() => {
	for (const dir of createdTempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function cleanupStepRunBlock(): string {
	const steps: Array<{ name?: string; run?: string }> =
		releaseWorkflow.jobs['cleanup-release-fragments'].steps;
	const step = steps.find(
		(s) => s.name === 'Open cleanup PR and dispatch required checks',
	);
	if (typeof step?.run !== 'string') throw new Error('cleanup step not found');
	return step.run;
}

/**
 * The `git status --porcelain=v1 -z | jq ... > $cleanup_paths` pipeline,
 * verbatim. The producer runs `git status` itself (stdin is not consulted),
 * so the reducer is exercised separately (see runReducer) and the full
 * composition on a real scratch repository (see the composition test).
 */
function conversionPipeline(block: string): string {
	const lines = block.split('\n');
	const start = lines.findIndex((l) =>
		l.includes('git status --porcelain=v1 -z'),
	);
	if (start === -1) throw new Error('NUL producer not found in cleanup step');
	const end = lines.findIndex(
		(l, i) => i >= start && l.includes('> "$cleanup_paths"'),
	);
	if (end === -1) throw new Error('conversion output redirect not found');
	return lines.slice(start, end + 1).join('\n');
}

/** The jq reducer program text extracted from the pipeline (test input). */
function reducerProgram(block: string): string {
	const pipeline = conversionPipeline(block);
	const open = pipeline.indexOf("jq -R -s -c '");
	const close = pipeline.indexOf('\' > "$cleanup_paths"');
	if (open === -1 || close === -1 || close <= open) {
		throw new Error('jq reducer program not found in pipeline');
	}
	return pipeline.slice(open + "jq -R -s -c '".length, close);
}

/** Runs the extracted reducer over synthetic porcelain -z bytes. */
function runReducer(nulRecords: string[]): string {
	const program = reducerProgram(cleanupStepRunBlock());
	const input = Buffer.from(`${nulRecords.join('\0')}\0`, 'utf8');
	const result = runBash(`jq -R -s -c '${program}'`, { stdin: input });
	expect(result.exitCode).toBe(0);
	// On Windows the bash shim layers CRLF over jq's LF output; the
	// classifier's jsonl decoder accepts \r as JSON whitespace, and the
	// workflow itself runs on LF runners — normalize for comparison only.
	return result.stdout.replace(/\r/g, '');
}

function runBash(
	script: string,
	opts: { stdin?: Buffer; cwd?: string } = {},
): { exitCode: number; stdout: string; stderr: string } {
	const proc = Bun.spawnSync({
		cmd: bashCommand('-c', script),
		cwd: opts.cwd ?? root,
		stdin: opts.stdin ?? Buffer.from('', 'utf8'),
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	return {
		exitCode: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

/** Runs the extracted pipeline over synthetic porcelain -z bytes. */
function convert(nulRecords: string[]): string {
	const input = Buffer.from(`${nulRecords.join('\0')}\0`, 'utf8');
	const dir = canonicalMkdtemp('cleanup-3299-');
	createdTempDirs.push(dir);
	const out = path.join(dir, 'out.jsonl');
	const result = runBash(
		`${conversionPipeline(cleanupStepRunBlock()).replace(
			/> "\$cleanup_paths"/,
			`> '${out.replace(/'/g, "'\\''")}'`,
		)}`,
		{ stdin: input },
	);
	expect(result.exitCode).toBe(0);
	return readFileSync(out, 'utf8');
}

describe('cleanup arm transport (#3299)', () => {
	const block = cleanupStepRunBlock();

	test('the invocation uses the newline-safe framing, not a stdin pipe', () => {
		expect(block).toContain('--paths-format jsonl');
		expect(block).toContain('--changed-file "$cleanup_paths"');
		// The pre-#3299 shape piped a newline list straight into the CLI.
		expect(block).not.toMatch(/\|\s*bun\s+scripts\/check-pending-fragment\.ts/);
	});

	test('the step traps cleanup of the temp file and snapshots before commit', () => {
		expect(block).toContain(`trap 'rm -f "\${cleanup_paths:-}"' EXIT`);
		// The snapshot must stay before the cleanup branch checkout/commit —
		// after them the worktree is clean and the check goes vacuous.
		const conversionIndex = block.indexOf('git status --porcelain=v1 -z');
		const commitIndex = block.indexOf('git checkout -b');
		expect(conversionIndex).toBeGreaterThan(-1);
		expect(commitIndex).toBeGreaterThan(conversionIndex);
	});

	test('ordinary cleanup records convert byte-faithfully', () => {
		// porcelain v1 records are `XY <path>`: two status columns plus the
		// separator (3 chars) before the path — staged-only D/A carry a blank
		// second column.
		const jsonl = runReducer([
			'D  docs/releases/pending/old-fragment.md',
			'A  docs/releases/pending/new-archive.md',
		]);
		expect(jsonl.split('\n').filter(Boolean)).toEqual([
			'"docs/releases/pending/old-fragment.md"',
			'"docs/releases/pending/new-archive.md"',
		]);
	});

	test('adversarial paths survive: quotes, newlines, rename pair, state reset, copy', () => {
		// Windows cannot host quote/newline filenames, so the reducer runs on
		// synthetic porcelain -z bytes — exactly the byte shapes git emits on
		// Linux CI where the cleanup step actually executes.
		const jsonl = runReducer([
			'M  src/we"ird.ts',
			'M  src/a\nb.ts',
			'R  src/new.ts',
			'src/old.ts',
			'?? docs/other.md',
			'C  src/copy-dst.ts',
			'src/copy-src.ts',
		]);
		expect(jsonl.split('\n').filter(Boolean)).toEqual([
			'"src/we\\"ird.ts"',
			'"src/a\\nb.ts"',
			'"src/new.ts"',
			'"src/old.ts"',
			'"docs/other.md"',
			'"src/copy-dst.ts"',
			'"src/copy-src.ts"',
		]);
	});

	test('the full producer pipeline composes on a real repository', () => {
		const dir = canonicalMkdtemp('cleanup-3299-compose-');
		createdTempDirs.push(dir);
		const git = (...args: string[]) => {
			const proc = Bun.spawnSync({
				cmd: ['git', ...args],
				cwd: dir,
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: 30_000,
			});
			if (proc.exitCode !== 0) {
				throw new Error(`git ${args.join(' ')}: ${proc.stderr.toString()}`);
			}
		};
		git('init', '-b', 'main');
		git('config', 'user.email', 't@t');
		git('config', 'user.name', 't');
		mkdirSync(path.join(dir, 'docs', 'releases', 'pending'), {
			recursive: true,
		});
		writeFileSync(
			path.join(dir, 'docs', 'releases', 'pending', 'gone.md'),
			'# gone\n',
		);
		git('add', '.');
		git('commit', '-m', 'base');
		rmSync(path.join(dir, 'docs', 'releases', 'pending', 'gone.md'));
		git('add', '.');
		// Staged deletion → porcelain -z emits `D ` for the file. The output
		// file lives OUTSIDE the scratch repo so it cannot appear in the
		// status listing itself.
		const outDir = canonicalMkdtemp('cleanup-3299-out-');
		createdTempDirs.push(outDir);
		const out = path.join(outDir, 'converted.jsonl');
		const pipeline = conversionPipeline(cleanupStepRunBlock()).replace(
			/> "\$cleanup_paths"/,
			`> '${out.replace(/'/g, "'\\''")}'`,
		);
		const result = runBash(pipeline, { cwd: dir });
		expect(result.exitCode).toBe(0);
		// CRLF-normalized for the same Windows-shim reason as runReducer.
		expect(readFileSync(out, 'utf8').replace(/\r/g, '').trim()).toBe(
			'"docs/releases/pending/gone.md"',
		);
	});

	test('the classifier accepts the converted list and flips on a faithful src path', () => {
		const dir = canonicalMkdtemp('cleanup-3299-classifier-');
		createdTempDirs.push(dir);
		const runClassifier = (jsonl: string): { code: number; out: string } => {
			const list = path.join(dir, 'paths.jsonl');
			writeFileSync(list, jsonl, 'utf8');
			const proc = Bun.spawnSync({
				cmd: bashCommand(
					'-c',
					`bun scripts/check-pending-fragment.ts --print-requirement --paths-format jsonl --changed-file '${list.replace(/'/g, "'\\''")}'`,
				),
				cwd: root,
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: 30_000,
			});
			return { code: proc.exitCode ?? 1, out: proc.stdout.toString() };
		};
		// Cleanup-shaped list: not required, exit 0.
		const cleanup = runClassifier('"docs/releases/pending/x.md"\n');
		expect(cleanup.code).toBe(0);
		expect(cleanup.out).toContain('required=false');
		// A faithful user-visible path (with a byte that the old transport
		// would have mangled into required=false): required and unsatisfied.
		const adversarial = runClassifier('"src/we\\"ird.ts"\n');
		expect(adversarial.code).toBe(1);
		expect(adversarial.out).toContain('required=true satisfied=false');
	});

	test('a missing --changed-file target stays a fail-closed classifier error', () => {
		const proc = Bun.spawnSync({
			cmd: bashCommand(
				'-c',
				'bun scripts/check-pending-fragment.ts --print-requirement --paths-format jsonl --changed-file does-not-exist.jsonl',
			),
			cwd: root,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 30_000,
		});
		expect(proc.exitCode ?? 1).toBe(2);
	});
});
