/**
 * Fragment-gate strictness + pin battery — collated trace
 * 3306-3308-3361-fragment-gate-pins (issues #3306 / #3308 / #3361).
 *
 * Pre-authored acceptance surface, frozen once: the fix changes ONLY
 * production code to make these tests green. Future-red legs (fail at base):
 * the 3306 AC5 in-process leg (no `_internals.readFileSync` seam yet), the
 * D3b uppercase-MD display leg, and the D6 --added strictness legs; every
 * other leg is GREEN at base (pinned; Phase 4.5 mutation probes).
 *
 * argv-source matrix — 11 preserving cells and the recorded exceptions:
 * - direct `--added` x jsonl is INTENTIONALLY NOT a preserving cell: D6
 *   (#3306 AC7, check C7) requires jsonl --added values to be a single
 *   JSON-encoded string (raw values exit 2) — owned by C7, not this matrix.
 * - file inputs WITHOUT --paths-format: unreachable (format-required leg);
 *   stdin with the implicit newline default: pinned by the transport suite
 *   ('3290 legacy modes unchanged'), not duplicated here.
 * - direct `--added` x {newline, nul}: plain-name acceptance keeps holding
 *   after D6 (its JSON requirement is jsonl-only).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as classifierModule from '../../../scripts/check-pending-fragment.ts';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { REPO_ROOT, runCli } from './_check-pending-fragment-cli-helpers';

const FRAGMENT = 'docs/releases/pending/mine.md';
const PR_STANDARDS = path.join(REPO_ROOT, '.github/workflows/pr-standards.yml');

/** Directories this process created (removed in afterAll; PRR-006 shape). */
const createdTempDirs: string[] = [];

afterAll(() => {
	for (const dir of createdTempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(prefix: string): string {
	const dir = canonicalMkdtemp(`cpf-strict-${prefix}`);
	createdTempDirs.push(dir);
	return dir;
}

/** Extract one step's `run:` block from pr-standards.yml by step name. */
function stepRunBlock(stepName: string): string {
	const lines = readFileSync(PR_STANDARDS, 'utf8').split('\n');
	const nameIndex = lines.findIndex((l) => l.includes(`- name: ${stepName}`));
	if (nameIndex === -1) throw new Error(`step not found: ${stepName}`);
	let end = lines.findIndex((l, i) => i > nameIndex && /^ {6}- name: /.test(l));
	if (end === -1) end = lines.length;
	return lines.slice(nameIndex, end).join('\n');
}

/**
 * Slice a step body from a marker line through the esac closing the
 * classifier's `case "$rc"` mapping (same indent matching as the contract
 * suite, so nested case/esac inside arms cannot end the slice early).
 */
function mappingSlice(block: string, startMarker: string): string {
	const lines = block.split('\n');
	const start = lines.findIndex((l) => l.includes(startMarker));
	if (start === -1) throw new Error(`marker not found: ${startMarker}`);
	const caseIndex = lines.findIndex(
		(l, i) => i > start && /^\s*case\s+"\$\w*rc"\s+in\s*$/.test(l),
	);
	if (caseIndex === -1)
		throw new Error('no case "$rc" statement after the marker');
	const caseIndent = lines[caseIndex].match(/^\s*/)?.[0] ?? '';
	let end = -1;
	for (let i = caseIndex + 1; i < lines.length; i++) {
		if (lines[i] === `${caseIndent}esac`) {
			end = i;
			break;
		}
	}
	if (end === -1) throw new Error('no esac terminator for the mapping');
	return ['set -uo pipefail', ...lines.slice(start, end + 1)].join('\n');
}

/**
 * Run an extracted mapping slice with stubbed git/gh/bun (mirrors the
 * contract suite's runMapping). git is stubbed so no real repository
 * operation runs inside the slice; by default it emits an EMPTY diff
 * stream — opts.gitChanged / opts.gitAdded seed the stub's emitted line
 * (bash drops NUL bytes from script seeds, so these arrive NUL-less; the
 * NUL-framed transport runs through the tmp_added FILES). The gh stub writes
 * one `CALL <argv>` line per invocation (call COUNTS assertable; real jq/wc/mktemp/trap run).
 */
function runMapping(
	mapping: string,
	opts: {
		rc: number;
		verdict: string;
		entries?: string[];
		changedFiles?: number;
		captureGhArgs?: string;
		gitChanged?: string;
		gitAdded?: string;
	},
): { exitCode: number; stdout: string; stderr: string } {
	const dir = makeTempDir('3308map-');
	const entries = opts.entries ?? [
		'{"filename":"src/index.ts","status":"modified","changes":3}',
		`{"filename":"${FRAGMENT}","status":"added","changes":10}`,
	];
	const changedFiles = opts.changedFiles ?? entries.length;
	const gitChanged = opts.gitChanged ?? '';
	const gitAdded = opts.gitAdded ?? '';
	const script = [
		`pr_json='{"changed_files":${changedFiles},"head":{"sha":"deadbeefcafe"}}'`,
		'PR_NUMBER=1234',
		'GITHUB_SHA=deadbeefcafe',
		'GITHUB_REPOSITORY=example/example',
		'BASE_REF=main',
		`TEST_ENTRIES='${entries.join('\n')}'`,
		"TEST_HEAD_SHA='deadbeefcafe'",
		`GIT_CHANGED='${gitChanged}'`,
		`GIT_ADDED='${gitAdded}'`,
		opts.captureGhArgs ? `CAPTURE_GH='${opts.captureGhArgs}'` : 'CAPTURE_GH=',
		'git() {',
		'  case "$*" in',
		'    *\'--diff-filter=A\'*) [ -n "$GIT_ADDED" ] && printf \'%s\' "$GIT_ADDED"; return 0 ;;',
		'    *) [ -n "$GIT_CHANGED" ] && printf \'%s\' "$GIT_CHANGED"; return 0 ;;',
		'  esac',
		'}',
		'gh() {',
		'  [ -n "$CAPTURE_GH" ] && printf \'CALL %s\\n\' "$*" >> "$CAPTURE_GH"',
		'  case "$*" in',
		"    *'files?per_page=100'*)",
		'      printf \'%s\\n\' "$TEST_ENTRIES"',
		'      return 0',
		'      ;;',
		'    *)',
		'      printf \'%s\\n\' "$TEST_HEAD_SHA"',
		'      return 0',
		'      ;;',
		'  esac',
		'}',
		'bun() {',
		`  [ -n '${opts.verdict}' ] && printf '%s\\n' '${opts.verdict}'`,
		`  return ${opts.rc}`,
		'}',
		mapping,
	].join('\n');
	const proc = Bun.spawnSync({
		cmd: bashCommand('-s'),
		cwd: REPO_ROOT,
		stdin: Buffer.from(script, 'utf8'),
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

describe('3306 strictness (decode + argv)', () => {
	test('3306 AC5: a stat-able but unreadable list file exits 2 with a usage message, not an uncaught error (in-process DI leg)', () => {
		const dir = makeTempDir('3306ac5-');
		const changed = path.join(dir, 'changed.bin');
		writeFileSync(changed, Buffer.from('src/index.ts\0', 'utf8'));
		const mod = classifierModule as unknown as {
			_internals: { readFileSync?: typeof readFileSync };
			readBoundedFileSync?: (file: string, source: string) => string;
		};
		const seam = mod._internals.readFileSync;
		if (typeof seam !== 'function') {
			throw new Error(
				'RED 3306-AC5: scripts/check-pending-fragment.ts exposes no _internals.readFileSync DI seam — a stat-able but unreadable (EACCES) list file still propagates uncaught (exit 1 + stack) instead of the PathListDecodeError/exit-2 shape',
			);
		}
		const realReadFileSync = readFileSync;
		mod._internals.readFileSync = ((
			file: path.PathOrFileDescriptor,
			options: unknown,
		) => {
			if (String(file) === changed) {
				const error = new Error(
					`EACCES: permission denied, open '${String(file)}'`,
				) as NodeJS.ErrnoException;
				error.code = 'EACCES';
				throw error;
			}
			return realReadFileSync(
				file as unknown as Parameters<typeof realReadFileSync>[0],
				options as Parameters<typeof realReadFileSync>[1],
			);
		}) as typeof readFileSync;
		try {
			let caught: unknown;
			try {
				mod.readBoundedFileSync?.(changed, '--changed-file input');
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(classifierModule.PathListDecodeError);
			expect(String((caught as Error)?.message)).toContain(
				'cannot read --changed-file input',
			);
		} finally {
			mod._internals.readFileSync = seam;
		}
	}, 30_000);

	// Defense in depth only — NOT the discriminating leg (chmod-deny is not
	// portable to Windows and is ineffective under root).
	test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
		'3306 AC5: unreadable list file exits 2 via the spawned CLI (POSIX chmod leg)',
		() => {
			const dir = makeTempDir('3306ac5posix-');
			const changed = path.join(dir, 'changed.bin');
			writeFileSync(changed, Buffer.from('src/index.ts\0', 'utf8'));
			chmodSync(changed, 0o000);
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
			expect(result.stderr).toContain('cannot read');
			expect(result.stdout).not.toContain('required=');
		},
		45_000,
	);

	test('3306 AC13: an invalid --paths-format enum value exits 2 with the enum message', () => {
		const result = runCli({
			args: ['--print-requirement', '--paths-format', 'bogus'],
			stdin: '',
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(
			'--paths-format must be one of: newline, nul, jsonl',
		);
		expect(result.stdout).not.toContain('required=');
	}, 45_000);

	test('3306 preserving: valid U+FFFD bytes (EF BF BD) in a NUL-framed list still classify with a verdict', () => {
		const dir = makeTempDir('3306fffd-');
		const changed = path.join(dir, 'changed.bin');
		const added = path.join(dir, 'added.bin');
		// EF BF BD is VALID UTF-8 (the U+FFFD codepoint): a stricter decoder
		// must not refuse it.
		writeFileSync(changed, Buffer.from('src/a\uFFFDb.ts\0', 'utf8'));
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
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe('required=true satisfied=true');
	}, 45_000);

	test('3306 preserving: a single-hyphen value is not treated as a flag by value parsing', () => {
		const direct = runCli({
			args: ['--print-requirement', '--added', '-note'],
			stdin: 'src/index.ts\n',
		});
		// '-note' is consumed as a path value: a violation verdict (rc 1).
		expect(direct.exitCode).toBe(1);
		expect(direct.stdout.trim()).toBe('required=true satisfied=false');
		expect(direct.stderr).not.toContain('unknown argument');
		const changedFile = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'newline',
				'--changed-file',
				'-note',
			],
			stdin: '',
		});
		// Treated as a filename: the ENOENT decode error, not a flag error.
		expect(changedFile.exitCode).toBe(2);
		expect(changedFile.stderr).toContain('cannot read');
		expect(changedFile.stderr).not.toContain('unknown argument');
	}, 75_000);
});

describe('3306 D6 strictness: --added values per framing (future-red at base)', () => {
	// D6 (#3306 AC7 + argv strictness): a direct --added value must be one
	// well-formed value for the selected framing or the CLI exits 2. These
	// legs assert the DESIRED post-fix behavior, so each FAILS at base
	// (printRequirement returns 0 for every shape below with an empty
	// injected changed list). In-process on purpose: NUL bytes cannot ride
	// execve argv. The fix returns 2 to injected-input callers (stdinText
	// !== undefined) and process.exits only for real CLI stdin reads — see
	// 05 D6 — so every leg passes a stdinText argument.
	const D6_NEGATIVE_CASES: Array<[string, string, string]> = [
		['jsonl', 'empty', ''],
		['jsonl', 'malformed JSON (literal backslash-n)', '"a"\\n"b"'],
		['jsonl', 'not JSON-encoded', 'plain.md'],
		['newline', 'a literal newline byte', 'a\nb'],
		['newline', 'empty', ''],
		['nul', 'an embedded NUL byte', 'a\0b'],
		['nul', 'trailing NUL', 'a\0'],
	];
	for (const [framing, label, value] of D6_NEGATIVE_CASES) {
		test(`3306 D6 strictness: a ${framing} --added value that is ${label} must be refused with exit 2`, async () => {
			const rc = await classifierModule.printRequirement(
				['--paths-format', framing, '--added', value],
				'',
			);
			if (rc !== 2) {
				console.log(
					`RED 3306-D6: ${framing} --added value (${label}) not yet refused — returned ${rc}`,
				);
			}
			expect(rc).toBe(2);
		}, 30_000);
	}
});

describe('3308 pins (listing count + jsonl discrimination)', () => {
	test('dispatched arm 3308: the gh api files listing is called exactly once (one-listing invariant)', () => {
		const dir = makeTempDir('3308count-');
		const capture = path.join(dir, 'ghargs.txt');
		const mapping = mappingSlice(
			stepRunBlock('Validate dispatched PR contract'),
			'rc=0',
		);
		const result = runMapping(mapping, {
			rc: 0,
			verdict: 'required=true satisfied=true',
			captureGhArgs: capture,
		});
		expect(result.exitCode).toBe(0);
		const calls = readFileSync(capture, 'utf8')
			.split('\n')
			.filter((l) => l.startsWith('CALL '));
		// Exactly ONE files-listing invocation, in ANY pulls/<n>/files
		// endpoint form (catches an unpaginated or differently-shaped second
		// call), and it must paginate at 100 per page.
		const listings = calls.filter((l) => /pulls\/[0-9]+\/files/.test(l));
		expect(listings).toHaveLength(1);
		expect(listings[0]).toContain('--paginate');
		expect(listings[0]).toContain('per_page=100');
		// The only other gh call is the head re-assertion (not a listing).
		expect(calls).toHaveLength(2);
	}, 60_000);

	test('3290 jsonl framing: a lone newline-bearing entry discriminates the split reading (3308 AC3)', () => {
		const dir = makeTempDir('3308jsonl-');
		const changed = path.join(dir, 'changed.jsonl');
		// EXACTLY ONE record; the \n inside the quotes is the literal
		// two-character escape, so the decoded name contains a REAL newline.
		// The raw view keeps it one entry (required=false); a split reading
		// of the decoded name sees src/x.ts and reads required=true.
		writeFileSync(changed, '"docs/a-\\nsrc/x.ts"\n', 'utf8');
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
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe('required=false satisfied=false');
		expect(result.stdout).not.toContain('required=true');
	}, 45_000);
});

describe('3361 pins (argv-source matrix + slice coverage)', () => {
	type Framing = 'newline' | 'nul' | 'jsonl';
	type Source = 'stdin' | 'changed-file' | 'added-file' | 'direct-added';

	function frame(name: string, framing: Framing): string {
		if (framing === 'nul') return `${name}\0`;
		if (framing === 'jsonl') return `${JSON.stringify(name)}\n`;
		return `${name}\n`;
	}

	// 11 preserving cells: every source x framing EXCEPT direct-added x jsonl
	// (D6 changes it; owned by check C7 — see the file header).
	const MATRIX_CELLS: Array<{ source: Source; framing: Framing }> = [];
	for (const source of ['stdin', 'changed-file', 'added-file'] as Source[]) {
		for (const framing of ['newline', 'nul', 'jsonl'] as Framing[]) {
			MATRIX_CELLS.push({ source, framing });
		}
	}
	for (const framing of ['newline', 'nul'] as Framing[]) {
		MATRIX_CELLS.push({ source: 'direct-added', framing });
	}

	for (const cell of MATRIX_CELLS) {
		test(`3306 AC15: argv-source matrix ${cell.source} x ${cell.framing} decodes through the selected framing`, () => {
			const dir = makeTempDir('3306mtx-');
			// jsonl cells never pass a raw --added value (D6 refuses those).
			const useAddedFile = cell.framing === 'jsonl';
			let args = ['--print-requirement', '--paths-format', cell.framing];
			let stdin = '';
			if (cell.source === 'stdin') {
				stdin = frame('src/index.ts', cell.framing);
			} else if (cell.source === 'changed-file') {
				const changed = path.join(dir, 'changed.bin');
				writeFileSync(changed, frame('src/index.ts', cell.framing), 'utf8');
				args = [...args, '--changed-file', changed];
			} else if (cell.source === 'added-file') {
				stdin = frame('src/index.ts', cell.framing);
			} else {
				// direct-added x {newline, nul} (D6's JSON requirement is
				// jsonl-only): plain names keep working under these framings
				// at base AND after the fix.
				stdin = frame('src/index.ts', cell.framing);
			}
			if (cell.source === 'added-file' || useAddedFile) {
				const added = path.join(dir, 'added.bin');
				writeFileSync(added, frame(FRAGMENT, cell.framing), 'utf8');
				args = [...args, '--added-file', added];
			} else {
				args = [...args, '--added', FRAGMENT];
			}
			const result = runCli({ args, stdin });
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe('required=true satisfied=true');
		}, 45_000);
	}

	test('3306 AC15: argv-source matrix cross-check — file inputs without --paths-format are refused', () => {
		// Freezes the enumeration shape (11 cells; direct-added x jsonl is C7's).
		expect(MATRIX_CELLS).toHaveLength(11);
		const dir = makeTempDir('3306fmt-');
		const changed = path.join(dir, 'changed.bin');
		const added = path.join(dir, 'added.bin');
		writeFileSync(changed, 'src/index.ts\n', 'utf8');
		writeFileSync(added, `${FRAGMENT}\n`, 'utf8');
		const viaChanged = runCli({
			args: ['--print-requirement', '--changed-file', changed],
			stdin: '',
		});
		expect(viaChanged.exitCode).toBe(2);
		expect(viaChanged.stderr).toContain('--paths-format is required');
		expect(viaChanged.stdout).not.toContain('required=');
		const viaAdded = runCli({
			args: ['--print-requirement', '--added-file', added],
			stdin: '',
		});
		expect(viaAdded.exitCode).toBe(2);
		expect(viaAdded.stderr).toContain('--paths-format is required');
		expect(viaAdded.stdout).not.toContain('required=');
	}, 75_000);

	test('pull_request arm 3308: the extracted slice covers the empty-changed exit before the classifier call', () => {
		// Slice from the mktemp marker (not the rc=0 seed) so the empty-changed
		// exit is INSIDE the executed slice; git emits an empty diff stream.
		const mapping = mappingSlice(
			stepRunBlock('Require pending release fragment'),
			'tmp_changed="$(mktemp)"',
		);
		const result = runMapping(mapping, { rc: 0, verdict: '' });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('No changed files detected');
	}, 60_000);
});

describe('3306 D3b display parity (future-red at base)', () => {
	// Own describe on purpose: bun's -t matches the describe path, so this
	// future-red leg must NOT sit inside the C15-swept 'argv-source matrix'.
	test('pull_request arm 3306 D3b: uppercase MD display — the satisfied arm prints the X.MD fragment name', () => {
		// The REAL display slice greps the NUL-decoded added list with
		// `grep -E '^docs/releases/pending/.+\.[mM][dD]$'`; at base the
		// suffix was case-sensitive `\.md$`. Phase 4.5 mutation: revert it.
		const mapping = mappingSlice(
			stepRunBlock('Require pending release fragment'),
			'tmp_changed="$(mktemp)"',
		);
		const result = runMapping(mapping, {
			rc: 0,
			verdict: 'required=true satisfied=true',
			gitChanged: 'src/index.ts\0',
			gitAdded: 'docs/releases/pending/X.MD\0',
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Release fragment present:');
		expect(result.stdout).toContain('docs/releases/pending/X.MD');
	}, 60_000);
});
