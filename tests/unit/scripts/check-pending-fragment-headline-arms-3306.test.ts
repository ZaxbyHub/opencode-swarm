/**
 * Committed CI regression pins for the headline #3306 strictness arms
 * (FB-001/R-10, swarm-pr-review run pr3697-20261114-breadth): the frozen
 * issue-tracer acceptance checks for these arms live under the gitignored
 * `.agents/issue-traces/` tree, so a revert of any branch here ships
 * CI-green. This sibling file (kept separate from the 500-line frozen
 * battery) pins each arm at the CI surface; every leg names the branch it
 * guards, and the D6-message legs pin the refusal REASON, not just the
 * exit code.
 *
 * Arms covered (critic-narrowed set, R-10):
 *   - list-file strict decode (AC1): invalid-UTF-8 --changed-file exits 2
 *   - stdin strict decode (AC1): invalid-UTF-8 stdin bytes exit 2
 *   - newline-framing NUL refusal (AC2): NUL in --added-file exits 2
 *   - flag-like --added value refusal (AC6): `--added --foo` exits 2
 *   - jsonl post-decode NUL refusal (FB-003): \u0000 escape exits 2
 *   - renderNameForMessage escaping (AC4/FB-001e)
 *   - isPendingFragment predicate rows (AC3/FB-001f): C0/`..`/`./`/`.\`
 *   - D6 refusal-reason discrimination (FB-005/R-06)
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';

import { renderNameForMessage } from '../../../scripts/check-pending-fragment.ts';
import { isPendingFragment } from '../../../scripts/user-visible-paths.ts';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { runCli } from './_check-pending-fragment-cli-helpers';

/** Directories this process created (exact-list cleanup, #3308 pattern). */
const createdTempDirs: string[] = [];

afterAll(() => {
	for (const dir of createdTempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('check-pending-fragment headline arms CI pins (3306 FB-001)', () => {
	test('AC1: an invalid-UTF-8 --changed-file exits 2 with the decode message', () => {
		const dir = canonicalMkdtemp('ha-utf8-file-3306-');
		createdTempDirs.push(dir);
		const changed = `${dir}/changed.bin`;
		// Raw 0xFF byte — a JS-string '\xff' escape would be U+00FF, which is
		// VALID two-byte UTF-8 (0xC3 0xBF) and would not exercise the refusal.
		writeFileSync(
			changed,
			Buffer.concat([
				Buffer.from('docs/a'),
				Buffer.from([0xff]),
				Buffer.from('b.md\0src/x.ts\0'),
			]),
		);
		const result = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'nul',
				'--changed-file',
				changed,
				'--added',
				'docs/releases/pending/ok.md',
			],
			stdin: '',
			timeoutMs: 45_000,
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('--changed-file input is not valid UTF-8');
		expect(result.stdout).not.toContain('required=');
		// Spawned leg: per-test budget must exceed the helper's 30s subprocess
		// timeout (bun's 5s per-test default does not — FB-004/R-05).
	}, 60_000);

	test('AC1: invalid-UTF-8 stdin bytes exit 2 with the decode message', () => {
		// Invalid bytes cannot ride a JS string — the spawned CLI takes the
		// raw bytes via runCli stdinBytes (Bun.spawnSync accepts a Buffer).
		const result = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'newline',
				'--added',
				'docs/releases/pending/ok.md',
			],
			stdin: '',
			stdinBytes: Buffer.concat([
				Buffer.from('docs/a'),
				Buffer.from([0xff]),
				Buffer.from('b.md\n'),
			]),
			timeoutMs: 45_000,
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('stdin input is not valid UTF-8');
		expect(result.stdout).not.toContain('required=');
	}, 60_000);

	test('AC2: a NUL byte in newline-framed --added-file exits 2 with the framing hint', () => {
		const dir = canonicalMkdtemp('ha-nul-newline-3306-');
		createdTempDirs.push(dir);
		const changed = `${dir}/changed.bin`;
		const added = `${dir}/added.bin`;
		writeFileSync(changed, Buffer.from('src/x.ts\n'));
		writeFileSync(
			added,
			Buffer.from('docs/releases/pending/ok.md\0src/y.ts\n'),
		);
		const result = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'newline',
				'--changed-file',
				changed,
				'--added-file',
				added,
			],
			stdin: '',
			timeoutMs: 45_000,
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(
			'newline-framed added list contains a NUL byte — use --paths-format nul',
		);
		expect(result.stdout).not.toContain('required=');
	}, 60_000);

	test('AC6: a flag-like --added value exits 2 with the flag-like message', () => {
		const result = runCli({
			args: ['--print-requirement', '--added', '--paths-format'],
			stdin: '',
			timeoutMs: 45_000,
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(
			'--added requires a value (flag-like token --paths-format follows)',
		);
		expect(result.stdout).not.toContain('required=');
	}, 60_000);

	test('FB-003: a jsonl \\u0000 escape decodes to a NUL-bearing path and exits 2', () => {
		const dir = canonicalMkdtemp('ha-jsonl-nul-3306-');
		createdTempDirs.push(dir);
		const changed = `${dir}/changed.jsonl`;
		// The FILE carries the two-character JSON escape; JSON.parse decodes
		// it to a NUL-bearing string, which the jsonl arm now refuses at the
		// decode layer (mirroring the newline arm's framing-layer refusal).
		writeFileSync(changed, '"src/x\\u0000y.ts"\n');
		const result = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'jsonl',
				'--changed-file',
				changed,
			],
			stdin: '',
			timeoutMs: 45_000,
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(
			'jsonl input is not a JSON-encoded path string',
		);
		expect(result.stdout).not.toContain('required=');
	}, 60_000);

	test('AC4/FB-001e: renderNameForMessage escapes C0 and DEL, leaves plain names unchanged', () => {
		expect(renderNameForMessage('docs/releases/pending/ok.md')).toBe(
			'docs/releases/pending/ok.md',
		);
		// ESC (0x1b) -> literal backslash-x-1b, so a crafted CSI sequence
		// cannot reach the terminal raw.
		expect(renderNameForMessage('a\x1bb.md')).toBe('a\\x1bb.md');
		// DEL (0x7f) -> \\x7f (bare JSON.stringify does not escape DEL).
		expect(renderNameForMessage('a\x7fb.md')).toBe('a\\x7fb.md');
		// NUL -> \\x00.
		expect(renderNameForMessage('a\x00b.md')).toBe('a\\x00b.md');
		// Mutation probes: delete the .map(renderNameForMessage) call at
		// evaluateFragmentCheck (:107 or :113 in the script) — the CI log
		// assertions in the violation/satisfied message legs go red.
	});

	test('AC3/FB-001f: isPendingFragment refuses C0, dotdot, and leading-dot names', () => {
		const refused: Array<[string, string]> = [
			['C0 control (TAB)', 'docs/releases/pending/a\tb.md'],
			['C0 control (ESC)', 'docs/releases/pending/a\x1bb.md'],
			['dotdot segment', 'docs/releases/pending/../pending/x.md'],
			['leading ./', './docs/releases/pending/x.md'],
			['leading .\\', '.\\docs\\releases\\pending\\x.md'],
			['any backslash', 'docs\\releases\\pending\\x.md'],
		];
		for (const [label, name] of refused) {
			expect(isPendingFragment(name)).toBe(false);
		}
		// True controls: the plain form, the case-insensitive suffix, and a
		// DEL-bearing name — DEL (0x7f) is outside C0 and BOTH the gate and
		// the aggregator accept it (parity holds in the accept direction too).
		expect(isPendingFragment('docs/releases/pending/x.md')).toBe(true);
		expect(isPendingFragment('docs/releases/pending/x.MD')).toBe(true);
		expect(isPendingFragment('docs/releases/pending/a\x7fb.md')).toBe(true);
	});

	test('FB-005/R-06: D6 refusal reasons are discriminated, not just exit codes', () => {
		// In-process decodeSinglePath pins the REASON for each refusal shape
		// (the spawned D6 legs in the frozen battery pin rc 2). Each entry
		// names the branch it guards: nul-framing NUL check, jsonl
		// JSON-parse branch, jsonl cardinality branch, newline cardinality.
		const {
			decodeSinglePath,
		} = require('../../../scripts/check-pending-fragment.ts');
		const checks: Array<[string, () => void, RegExp]> = [
			[
				'nul framing refuses an embedded NUL in a direct --added value',
				() => decodeSinglePath('a\0b.md', 'nul', '--added value'),
				/must not contain a NUL byte/,
			],
			[
				'jsonl framing refuses a non-JSON value',
				() => decodeSinglePath('plain.md', 'jsonl', '--added value'),
				/not a JSON-encoded path string/,
			],
			[
				'jsonl framing refuses multi-record values (cardinality)',
				() => decodeSinglePath('"a"\n"b"', 'jsonl', '--added value'),
				/must decode to exactly one path/,
			],
			[
				'newline framing refuses a literal newline byte',
				() => decodeSinglePath('a\nb.md', 'newline', '--added value'),
				/must decode to exactly one path/,
			],
		];
		for (const [label, fn, pattern] of checks) {
			let message = '';
			try {
				fn();
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toMatch(pattern);
		}
		// Sanity: a plain name decodes cleanly under the default framing.
		expect(
			decodeSinglePath('docs/releases/pending/ok.md', 'newline', 'x'),
		).toBe('docs/releases/pending/ok.md');
	});
});
