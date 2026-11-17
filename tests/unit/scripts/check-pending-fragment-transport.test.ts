import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

import {
	REPO_ROOT,
	runCli,
	SCRIPT,
} from './_check-pending-fragment-cli-helpers';

/**
 * Newline-safe input framing for the fragment classifier (issue #3290).
 *
 * A line-delimited transport cannot represent a path containing a newline,
 * and `core.quotePath=false` still C-quotes quote/backslash/control
 * characters — both made the pr-standards arms disagree with the quality
 * gate's `-z` view (a quoted token matches no class row and reads as
 * required=false). These tests pin the `nul` and `jsonl` framings
 * end-to-end through the real CLI: adversarial names must classify
 * identically to the raw view, the mixing contract must refuse ambiguity,
 * and the byte bound must stop an oversized input on stderr with exit 2 —
 * never a verdict line.
 *
 * Separate file (AGENTS.md invariant 7: the helper spawns subprocesses) and
 * named with the 3290 token so the frozen acceptance checks can require
 * these tests by name.
 */

const FRAGMENT = 'docs/releases/pending/mine.md';

/** Directories this process created (issue #3308 AC4: exact-list
 * cleanup — the contract suite's PRR-006 pattern; no cross-process glob). */
const createdTempDirs: string[] = [];

afterAll(() => {
	for (const dir of createdTempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('check-pending-fragment transport framing (issue 3290)', () => {
	test('3290 nul framing: a quote-bearing path classifies like the raw view', () => {
		const dir = canonicalMkdtemp('cpf-nul-3290-');
		createdTempDirs.push(dir);
		const changed = `${dir}/changed.bin`;
		const added = `${dir}/added.bin`;
		writeFileSync(changed, Buffer.from('src/we"ird.ts\0docs/x.md\0', 'utf8'));
		writeFileSync(added, Buffer.from(`${FRAGMENT}\0`, 'utf8'));
		const result = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'nul',
				'--changed-file',
				changed,
				'--added-file',
				added,
			],
			stdin: '',
		});
		// The arms' old line-delimited view fed the C-quoted token
		// `"src/we\"ird.ts"` here and got required=false — the exact
		// divergence this framing removes.
		expect(result.stdout.trim()).toBe('required=true satisfied=true');
		expect(result.exitCode).toBe(0);
	});

	test('3290 jsonl framing: a newline-bearing name classifies like the raw view', () => {
		const dir = canonicalMkdtemp('cpf-jsonl-3290-');
		createdTempDirs.push(dir);
		const changed = `${dir}/changed.jsonl`;
		const added = `${dir}/added.jsonl`;
		// JSON-encoded newline inside the path (what `jq -c` emits for such a
		// filename); a line-delimited transport would split this in two.
		writeFileSync(changed, '"src/bad\\nname.ts"\n"src/ok.ts"\n', 'utf8');
		writeFileSync(added, `"${FRAGMENT}"\n`, 'utf8');
		const result = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'jsonl',
				'--changed-file',
				changed,
				'--added-file',
				added,
			],
			stdin: '',
		});
		expect(result.stdout.trim()).toBe('required=true satisfied=true');
		expect(result.exitCode).toBe(0);
	});

	test('3290 jsonl framing: a non-string or malformed line exits 2, not a verdict', () => {
		const dir = canonicalMkdtemp('cpf-badjsonl-3290-');
		createdTempDirs.push(dir);
		const changed = `${dir}/changed.jsonl`;
		writeFileSync(changed, 'not-json\n', 'utf8');
		const result = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'jsonl',
				'--changed-file',
				changed,
			],
			stdin: '',
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(
			'jsonl input is not a JSON-encoded path string',
		);
		expect(result.stdout).not.toContain('required=');
	});

	test('3290 mixing contract: --added with --added-file is refused (exit 2)', () => {
		const result = runCli({
			args: [
				'--print-requirement',
				'--added',
				FRAGMENT,
				'--added-file',
				'somewhere.bin',
			],
			stdin: '',
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('mutually exclusive');
	});

	test('3290 precedence: --changed-file present means stdin is simply not read', () => {
		const dir = canonicalMkdtemp('cpf-prec-3290-');
		createdTempDirs.push(dir);
		const changed = `${dir}/changed.bin`;
		writeFileSync(changed, Buffer.from('src/index.ts\0', 'utf8'));
		const result = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'nul',
				'--changed-file',
				changed,
				'--added',
				FRAGMENT,
			],
			// stdin content is ignored by contract (documented precedence).
			stdin: 'docs/only.md\n',
		});
		expect(result.stdout.trim()).toBe('required=true satisfied=true');
		expect(result.exitCode).toBe(0);
	});

	test('3290 byte bound: an oversized file input exits 2 with a stderr message', () => {
		const dir = canonicalMkdtemp('cpf-cap-3290-');
		createdTempDirs.push(dir);
		const changed = `${dir}/big.bin`;
		// 5 MiB of NUL-framed filler paths — over the 4 MiB bound.
		const filler = 'src/pad/'.padEnd(96, 'x');
		const entries: string[] = [];
		let total = 0;
		while (total < 5 * 1024 * 1024) {
			entries.push(filler);
			total += filler.length + 1;
		}
		writeFileSync(changed, Buffer.from(entries.join('\0') + '\0', 'utf8'));
		const result = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'nul',
				'--changed-file',
				changed,
			],
			stdin: '',
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('read bound');
		expect(result.stdout).not.toContain('required=');
	});

	test('3290 missing-value errors keep the existing shape (no unknown-argument substring)', () => {
		for (const flag of ['--paths-format', '--changed-file', '--added-file']) {
			const result = runCli({
				args: ['--print-requirement', flag],
				stdin: '',
			});
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain(`${flag} requires a value`);
			expect(result.stderr).not.toContain('unknown argument');
		}
	});

	test('3290 legacy modes unchanged: newline stdin plus --added flags', () => {
		const result = runCli({
			args: ['--print-requirement', '--added', FRAGMENT],
			stdin: 'src/index.ts\n',
		});
		expect(result.stdout.trim()).toBe('required=true satisfied=true');
		expect(result.exitCode).toBe(0);
	});

	test('3290 stdin byte bound: an oversized STDIN input exits 2 (PRR-001)', () => {
		// Discriminates readStdinBounded from `Bun.stdin.text()`: the bound
		// path exits 2 with a stderr message; an unbounded read would decode
		// the oversized newline list and print a verdict with exit 0/1. All
		// pre-existing coverage drove the bound through --changed-file.
		const line = 'src/pad/xxxxxxxx\n';
		const oversized = line.repeat(Math.ceil((5 * 1024 * 1024) / line.length));
		const result = runCli({ args: ['--print-requirement'], stdin: oversized });
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('read bound');
		expect(result.stdout).not.toContain('required=');
	}, 60_000);

	test('3290 stdin idle bound: a silent stdin exits 2 instead of hanging (PRR-007, issue #3282 AC3)', async () => {
		// A byte bound cannot stop a hang: stdin that yields no data and no
		// EOF must trip the idle bound. runCli always closes stdin, so this
		// case needs an async spawn that holds the pipe open; the idle bound
		// is env-tunable so the child process can shorten it.
		const proc = Bun.spawn({
			cmd: ['bun', SCRIPT, '--print-requirement'],
			cwd: REPO_ROOT,
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, FRAGMENT_STDIN_IDLE_MS: '300' },
		});
		const exitCode = await Promise.race([
			proc.exited,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('classifier hung past 10s')), 10_000),
			),
		]);
		const stderr = await new Response(proc.stderr).text();
		expect(exitCode).toBe(2);
		expect(stderr).toContain('no data');
	});

	test('3290 nul framing: a multi-entry changed list splits on NUL (PRR-014)', () => {
		// The FIRST entry is deliberately not user-visible: a decoder that
		// failed to split on NUL would return the whole blob as one path
		// starting with docs/ and read required=false.
		const dir = canonicalMkdtemp('cpf-nulmulti-3290-');
		createdTempDirs.push(dir);
		const changed = `${dir}/changed.bin`;
		const added = `${dir}/added.bin`;
		writeFileSync(changed, Buffer.from(`docs/only.md\0src/real.ts\0`, 'utf8'));
		writeFileSync(added, Buffer.from(`${FRAGMENT}\0`, 'utf8'));
		const result = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'nul',
				'--changed-file',
				changed,
				'--added-file',
				added,
			],
			stdin: '',
		});
		expect(result.stdout.trim()).toBe('required=true satisfied=true');
		expect(result.exitCode).toBe(0);
	});

	test('3290 file inputs require an explicit --paths-format (PRR-010)', () => {
		const dir = canonicalMkdtemp('cpf-fmtreq-3290-');
		createdTempDirs.push(dir);
		const changed = `${dir}/changed.bin`;
		writeFileSync(changed, Buffer.from('src/index.ts\0', 'utf8'));
		const result = runCli({
			args: ['--print-requirement', '--changed-file', changed],
			stdin: '',
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('--paths-format is required');
		expect(result.stdout).not.toContain('required=');
	});

	test('3290 error branches: duplicate flags, non-string jsonl, unreadable file exit 2 (PRR-017)', () => {
		const dir = canonicalMkdtemp('cpf-err-3290-');
		createdTempDirs.push(dir);
		const twice = runCli({
			args: [
				'--print-requirement',
				'--added-file',
				`${dir}/a.bin`,
				'--added-file',
				`${dir}/b.bin`,
			],
			stdin: '',
		});
		expect(twice.exitCode).toBe(2);
		expect(twice.stderr).toContain('--added-file may be given only once');

		const twiceChanged = runCli({
			args: [
				'--print-requirement',
				'--changed-file',
				`${dir}/a.bin`,
				'--changed-file',
				`${dir}/b.bin`,
			],
			stdin: '',
		});
		expect(twiceChanged.exitCode).toBe(2);
		expect(twiceChanged.stderr).toContain(
			'--changed-file may be given only once',
		);

		const nonString = `${dir}/nonstring.jsonl`;
		writeFileSync(nonString, '123\n', 'utf8');
		const jsonlResult = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'jsonl',
				'--changed-file',
				nonString,
			],
			stdin: '',
		});
		expect(jsonlResult.exitCode).toBe(2);
		expect(jsonlResult.stderr).toContain(
			'jsonl input is not a JSON-encoded path string',
		);

		const missing = path.join(dir, 'absent.bin');
		const unreadable = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'nul',
				'--changed-file',
				missing,
			],
			stdin: '',
		});
		expect(unreadable.exitCode).toBe(2);
		expect(unreadable.stderr).toContain('cannot read');
	});
});
