import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { normalizeMockTarget } from '../../../scripts/check-invariants';

/**
 * #3710 D5 — normalize_mock_target canonicalization parity (BOTH siblings).
 *
 * The TS sibling (`normalizeMockTarget`, scripts/check-invariants.ts) and the
 * bash sibling (`normalize_mock_target`, scripts/lib/normalize-mock-target.sh)
 * must agree on the #3710 canonicalization rows:
 *
 *   - duplicate separators collapse BEFORE the dotdot loop, so `foo//bar.ts`
 *     normalizes to `src/foo/bar.ts` (declared canonicalization);
 *   - `foo//../bar` collapses to `foo/../bar`, which the dotdot rewrite then
 *     resolves to `bar` → `src/bar`;
 *   - `/../bar` (an unrewritable dotdot form — no non-slash run precedes
 *     `/../`) is a diagnosed bounded rejection: the TS sibling throws with
 *     the `unresolvable dotdot segment` diagnostic, the bash sibling exits
 *     nonzero with the same diagnostic on stderr;
 *   - benign inputs stay byte-identical to the pre-fix behavior.
 *
 * TS rows call the directly-imported `normalizeMockTarget` (the #3710 fix
 * makes every row terminate immediately — the wedge-shaped inputs get a
 * one-pass bounded rejection, and the sibling progress test
 * normalize-mock-target-progress-3710.test.ts separately pins the algorithm
 * bound in killed-if-over-budget children). Bash rows spawn `bash -c` with
 * `source scripts/lib/normalize-mock-target.sh` in a bounded, killable child
 * (explicit cwd, stdin ignored, output capped, best-effort kill in finally).
 */

const REPO_ROOT = path.resolve(__dirname, '../../../');
const BASH_LIB_SPEC = path.join(
	REPO_ROOT,
	'scripts',
	'lib',
	'normalize-mock-target.sh',
);

const KILL_BUDGET_MS = 6000;
const OUTPUT_CAP = 8192;

interface BoundedResult {
	status: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/**
 * Bounded, non-interactive, killable child runner (AGENTS.md invariant 3):
 * explicit cwd, stdin ignored, output capped, best-effort kill in finally.
 */
function runBounded(script: string, arg: string): Promise<BoundedResult> {
	return new Promise((resolve) => {
		const child = spawn('bash', ['-c', script, BASH_LIB_SPEC, arg], {
			cwd: REPO_ROOT,
			// node:child_process's spawn takes stdio, not stdin: a
			// `stdin: 'ignore'` option is IGNORED there, so the child keeps an
			// OPEN PIPE on stdin (it can block waiting for input). stdio slot 0
			// is the way to close the child's stdin (AGENTS.md invariant 3).
			stdio: ['ignore', 'pipe', 'pipe'],
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
			finish({ status: null, stdout, stderr, timedOut: true });
		}, KILL_BUDGET_MS);
		child.on('error', (error) => {
			finish({
				status: null,
				stdout,
				stderr: `${stderr}${String(error)}`,
				timedOut: false,
			});
		});
		child.on('close', (code) => {
			finish({ status: code, stdout, stderr, timedOut: false });
		});
	});
}

// $0 = library path, $1 = target. Prints RC:<n> and OUT:<normalized> so the
// value and the exit status are both observable from the parent, and exits
// WITH the function's status so a bounded rejection is a nonzero child exit.
const BASH_CHILD_SCRIPT = [
	'source "$0" >/dev/null 2>&1 || { echo "SOURCE_FAILED" >&2; exit 9; }',
	'out="$(normalize_mock_target "$1")"',
	'rc=$?',
	'printf \'RC:%d\\nOUT:%s\\n\' "$rc" "$out"',
	'exit "$rc"',
].join('\n');

interface BashOutcome {
	rc: number;
	out: string;
}

async function runBashSibling(target: string): Promise<BashOutcome> {
	const result = await runBounded(BASH_CHILD_SCRIPT, target);
	expect(result.timedOut, `bash ${target}: child never exited (wedge)`).toBe(
		false,
	);
	expect(
		result.status,
		`bash ${target}: child produced no exit status`,
	).not.toBe(null);
	const rcMatch = result.stdout.match(/RC:(\d+)\nOUT:([^\n]*)/);
	expect(
		rcMatch,
		`bash ${target}: no RC/OUT line in child output`,
	).not.toBeNull();
	if (rcMatch === null) throw new Error('unreachable after expect');
	return { rc: Number(rcMatch[1]), out: rcMatch[2] };
}

async function expectBashValue(
	target: string,
	expected: string,
): Promise<void> {
	const { rc, out } = await runBashSibling(target);
	expect(rc, `bash ${target}: nonzero rc`).toBe(0);
	expect(out, `bash ${target}: normalized value mismatch`).toBe(expected);
}

// ─── Row 1: `foo//bar.ts` → `src/foo/bar.ts` (declared canonicalization) ─────

describe('normalize_mock_target collapses duplicate slashes (#3710 D5)', () => {
	test('TS sibling: foo//bar.ts → src/foo/bar.ts', () => {
		expect(normalizeMockTarget('foo//bar.ts')).toBe('src/foo/bar.ts');
	}, 30_000);

	test('bash sibling: foo//bar.ts → src/foo/bar.ts', async () => {
		await expectBashValue('foo//bar.ts', 'src/foo/bar.ts');
	}, 60_000);
});

// ─── Row 2: `foo//../bar` → `src/bar` (collapse lets the dotdot rewrite fire) ─

describe('normalize_mock_target resolves collapsed dotdot (#3710 D5)', () => {
	test('TS sibling: foo//../bar → src/bar', () => {
		expect(normalizeMockTarget('foo//../bar')).toBe('src/bar');
	}, 30_000);

	test('bash sibling: foo//../bar → src/bar', async () => {
		await expectBashValue('foo//../bar', 'src/bar');
	}, 60_000);
});

// ─── Row 3: `/../bar` → bounded rejection with a diagnostic ───────────────────

describe('normalize_mock_target bounded-rejects unrewritable dotdot (#3710 D5)', () => {
	test('TS sibling: /../bar throws with the unresolvable-dotdot diagnostic', () => {
		expect(() => normalizeMockTarget('/../bar')).toThrow(
			/unresolvable dotdot segment in target: \/..\/bar/,
		);
	}, 30_000);

	test('bash sibling: /../bar exits nonzero with the stderr diagnostic', async () => {
		const result = await runBounded(BASH_CHILD_SCRIPT, '/../bar');
		expect(result.timedOut, 'bash /../bar: child never exited (wedge)').toBe(
			false,
		);
		expect(result.status).not.toBe(null);
		expect(result.status, 'bash /../bar: expected nonzero exit').not.toBe(0);
		const rcMatch = result.stdout.match(/RC:(\d+)\nOUT:/);
		expect(rcMatch, 'bash /../bar: no RC line in child output').not.toBeNull();
		if (rcMatch !== null) {
			expect(Number(rcMatch[1]), 'bash /../bar: function rc was zero').not.toBe(
				0,
			);
		}
		expect(
			result.stderr.includes('unresolvable dotdot segment in target: /../bar'),
			`bash /../bar: stderr diagnostic missing: ${result.stderr}`,
		).toBe(true);
	}, 60_000);
});

// ─── Row 4: benign inputs stay byte-identical ─────────────────────────────────

describe('normalize_mock_target benign inputs unchanged (#3710 D5)', () => {
	const BENIGN_CASES: Array<[string, string]> = [
		['src/utils/logger.ts', 'src/utils/logger.ts'],
		['a/b/c.ts', 'src/a/b/c.ts'],
		['../x/y.ts', 'src/x/y.ts'],
	];

	test('TS sibling: benign inputs normalize identically', () => {
		for (const [input, expected] of BENIGN_CASES) {
			expect(normalizeMockTarget(input), `ts ${input}`).toBe(expected);
		}
	}, 30_000);

	test('bash sibling: benign inputs normalize identically', async () => {
		for (const [input, expected] of BENIGN_CASES) {
			await expectBashValue(input, expected);
		}
	}, 60_000);
});
