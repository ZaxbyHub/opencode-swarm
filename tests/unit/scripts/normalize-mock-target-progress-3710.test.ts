import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { normalizeMockTarget } from '../../../scripts/check-invariants';

/**
 * #3710 D1 — normalize_mock_target guaranteed progress (BOTH siblings).
 *
 * The TS sibling (`normalizeMockTarget` in scripts/check-invariants.ts) and
 * the bash sibling (`normalize_mock_target` in
 * scripts/lib/normalize-mock-target.sh) both rewrite `foo//../bar` in a loop
 * whose pattern `[^/]+/\.\./` cannot match when the segment before `..` is
 * empty — the rewrite makes no progress and the loop never terminates.
 *
 * Frozen contract (issue #3710 AC1): the wedge input must yield a normalized
 * result OR a bounded rejection within 2s of algorithm time in BOTH siblings.
 * The progress legs are RED at base (the child never exits — killed by the
 * bounded runner's timeout) and GREEN after the fix; the benign-input rows
 * are pinned byte-identical and stay GREEN at base and after the fix.
 *
 * Wedge legs call each sibling in a KILLED-if-over-budget child process
 * (never in-process: an in-process call would hang the test runner itself).
 * The 2s bound is measured INSIDE the child (algorithm time), so CI spawn
 * overhead cannot flake it. All tokens/fixtures below are synthetic.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../');
const TS_SPEC = './scripts/check-invariants.ts';
const BASH_LIB_SPEC = path.join(
	REPO_ROOT,
	'scripts',
	'lib',
	'normalize-mock-target.sh',
);

const WEDGE_INPUT = 'foo//../bar';
const KILL_BUDGET_MS = 6000;
const ALGORITHM_BOUND_MS = 2000;
const OUTPUT_CAP = 8192;

interface BoundedResult {
	status: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	elapsedMs: number;
}

/**
 * Bounded, non-interactive, killable child runner (AGENTS.md invariant 3):
 * explicit cwd, stdin ignored, output capped, best-effort kill in finally.
 */
function runBounded(
	cmd: string,
	args: string[],
	timeoutMs: number,
): Promise<BoundedResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const child = spawn(cmd, args, {
			cwd: REPO_ROOT,
			stdin: 'ignore',
			windowsHide: true,
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: BoundedResult) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			try {
				child.kill();
			} catch {
				// best-effort kill
			}
			resolve(result);
		};
		child.stdout?.on('data', (chunk: Buffer) => {
			if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf-8');
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			if (stderr.length < OUTPUT_CAP) stderr += chunk.toString('utf-8');
		});
		timer = setTimeout(() => {
			finish({
				status: null,
				stdout,
				stderr,
				timedOut: true,
				elapsedMs: Date.now() - startedAt,
			});
		}, timeoutMs);
		child.on('error', (error) => {
			finish({
				status: null,
				stdout,
				stderr: `${stderr}${String(error)}`,
				timedOut: false,
				elapsedMs: Date.now() - startedAt,
			});
		});
		child.on('close', (code) => {
			finish({
				status: code,
				stdout,
				stderr,
				timedOut: false,
				elapsedMs: Date.now() - startedAt,
			});
		});
	});
}

function tsChildCode(input: string): string {
	return [
		`const mod = await import(${JSON.stringify(TS_SPEC)});`,
		'const t0 = Date.now();',
		'try {',
		`	const result = mod.normalizeMockTarget(${JSON.stringify(input)});`,
		"	process.stdout.write('RESULT:' + result + String.fromCharCode(10) + 'MS:' + (Date.now() - t0) + String.fromCharCode(10));",
		'} catch (error) {',
		"	process.stdout.write('REJECTED:' + ((error && error.message) || String(error)) + String.fromCharCode(10) + 'MS:' + (Date.now() - t0) + String.fromCharCode(10));",
		'}',
	].join('\n');
}

// $0 = library path, $1 = target. Sub-second timing via EPOCHREALTIME (bash
// 5+; degrades to 0ms on bash 3.2 where the wedge leg still discriminates
// through the kill budget). The function is called DIRECTLY (no command
// substitution) so killing the child stops the loop with it.
const BASH_CHILD_SCRIPT = [
	'source "$0" >/dev/null 2>&1 || { echo "SOURCE_FAILED" >&2; exit 9; }',
	't0=${EPOCHREALTIME:-0}',
	'normalize_mock_target "$1"',
	'rc=$?',
	't1=${EPOCHREALTIME:-0}',
	'awk -v a="$t0" -v b="$t1" -v rc="$rc" \'BEGIN { printf "PROBE_RC:%d MS:%d\\n", rc, (b-a)*1000 }\'',
].join('\n');

function bashResultLine(stdout: string): RegExpMatchArray | null {
	return stdout.match(/PROBE_RC:(\d+) MS:(\d+)\s*$/);
}

function tsResult(stdout: string): RegExpMatchArray | null {
	return stdout.match(/(?:RESULT:([^\n]*)|REJECTED:([^\n]*))\nMS:(\d+)/);
}

/** Pass = sibling exited on its own and produced a result or a bounded
 * rejection within the 2s algorithm budget. Base wedge = timedOut. */
function expectBoundedTs(label: string, result: BoundedResult): void {
	expect(result.timedOut, `${label}: child never exited (wedge)`).toBe(false);
	expect(
		result.status,
		`${label}: child produced no exit status`,
	).not.toBeNull();
	const match = tsResult(result.stdout);
	expect(
		match,
		`${label}: no RESULT/REJECTED line in child output`,
	).not.toBeNull();
	if (match === null) return;
	const algorithmMs = Number(match[3]);
	expect(
		algorithmMs,
		`${label}: algorithm exceeded the 2s bound (${algorithmMs}ms)`,
	).toBeLessThan(ALGORITHM_BOUND_MS);
	const rejected = match[2] !== undefined;
	if (!rejected) {
		expect(
			match[1].trim().length,
			`${label}: normalized result was empty`,
		).toBeGreaterThan(0);
	}
}

function expectBoundedBash(label: string, result: BoundedResult): void {
	expect(result.timedOut, `${label}: child never exited (wedge)`).toBe(false);
	expect(
		result.status,
		`${label}: child produced no exit status`,
	).not.toBeNull();
	const match = bashResultLine(result.stdout);
	expect(match, `${label}: no PROBE_RC/MS line in child output`).not.toBeNull();
	if (match === null) return;
	const algorithmMs = Number(match[2]);
	expect(
		algorithmMs,
		`${label}: algorithm exceeded the 2s bound (${algorithmMs}ms)`,
	).toBeLessThan(ALGORITHM_BOUND_MS);
	const rc = Number(match[1]);
	if (rc === 0) {
		const normalized = result.stdout.split('PROBE_RC:')[0].trim();
		expect(
			normalized.length,
			`${label}: normalized result was empty`,
		).toBeGreaterThan(0);
	} else {
		expect(
			/reject|invalid|malformed|unsupported/i.test(result.stderr),
			`${label}: nonzero exit without a bounded-rejection message`,
		).toBe(true);
	}
}

describe('normalize_mock_target guaranteed progress (#3710 D1, both siblings)', () => {
	test('TS sibling terminates on foo//../bar within the 2s algorithm bound', async () => {
		const result = await runBounded(
			process.execPath,
			['--eval', tsChildCode(WEDGE_INPUT)],
			KILL_BUDGET_MS,
		);
		expectBoundedTs('ts foo//../bar', result);
	}, 30_000);

	test('bash sibling terminates on foo//../bar within the 2s algorithm bound', async () => {
		const result = await runBounded(
			'bash',
			['-c', BASH_CHILD_SCRIPT, BASH_LIB_SPEC, WEDGE_INPUT],
			KILL_BUDGET_MS,
		);
		expectBoundedBash('bash foo//../bar', result);
	}, 30_000);
});

describe('normalize_mock_target benign inputs stay byte-identical (#3710 D1)', () => {
	test('TS sibling: already-normalized src/ path is unchanged', () => {
		expect(normalizeMockTarget('src/utils/logger.ts')).toBe(
			'src/utils/logger.ts',
		);
	});

	test('TS sibling: bare relative path gains the src/ prefix', () => {
		expect(normalizeMockTarget('a/b/c.ts')).toBe('src/a/b/c.ts');
	});

	test('TS sibling: leading parent hops are stripped', () => {
		expect(normalizeMockTarget('../x/y.ts')).toBe('src/x/y.ts');
	});

	test('bash sibling: benign inputs normalize identically', async () => {
		const cases: Array<[string, string]> = [
			['src/utils/logger.ts', 'src/utils/logger.ts'],
			['a/b/c.ts', 'src/a/b/c.ts'],
			['../x/y.ts', 'src/x/y.ts'],
		];
		for (const [input, expected] of cases) {
			const result = await runBounded(
				'bash',
				['-c', BASH_CHILD_SCRIPT, BASH_LIB_SPEC, input],
				KILL_BUDGET_MS,
			);
			expect(result.timedOut, `bash ${input}: child never exited`).toBe(false);
			const match = bashResultLine(result.stdout);
			expect(match, `bash ${input}: no PROBE_RC/MS line`).not.toBeNull();
			if (match === null) continue;
			expect(Number(match[1]), `bash ${input}: nonzero rc`).toBe(0);
			const normalized = result.stdout.split('PROBE_RC:')[0].trim();
			expect(normalized).toBe(expected);
		}
	}, 30_000);
});
