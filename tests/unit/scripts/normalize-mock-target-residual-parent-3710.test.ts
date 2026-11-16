import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { normalizeMockTarget } from '../../../scripts/check-invariants';

/**
 * #3710 swarm-pr-review R-02 — residual parent segments are a REJECTION, never
 * a traversal-bearing success value.
 *
 * A multi-hop dotdot chain can leave a residual `..` segment that the bounded
 * dotdot rewrite cannot consume: `a/../../b` rewrites to `../b` (the rewrite
 * pattern needs a non-empty non-slash run before `/../`, and `../b` has none),
 * so the loop exits WITHOUT consuming the parent segment. At base both
 * siblings returned `src/../b` with a success status — a value that still
 * carries a parent segment.
 *
 * Both siblings now reject such a target:
 *   - the TS sibling throws with the `residual parent segment` diagnostic;
 *   - the bash sibling prints the `rejecting residual parent segment`
 *     diagnostic on stderr and returns 1 (the child then exits nonzero).
 *
 * The guard is SEGMENT-aware: a benign `..` INSIDE a path segment (e.g.
 * `a..b.ts`) is not a parent segment and still normalizes.
 *
 * Bash rows spawn `bash -c` with `source scripts/lib/normalize-mock-target.sh`
 * in a bounded, killable child (explicit cwd, stdin ignored, output capped,
 * best-effort kill in finally) — AGENTS.md invariant 3.
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

function runBounded(script: string, arg: string): Promise<BoundedResult> {
	return new Promise((resolve) => {
		const child = spawn('bash', ['-c', script, BASH_LIB_SPEC, arg], {
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

const RESIDUAL_CASES = [
	'a/../../b',
	'a/b/../../../c',
	// A TERMINAL parent segment and a SOLE parent segment: the dotdot rewrite
	// loop never enters for these (they carry no '/../'), so they are caught
	// only by the segment-aware residual guard. The bash sibling used to
	// accept both and return a traversal-bearing value ('src/foo/..').
	'foo/..',
	'..',
];

describe('normalize_mock_target rejects a residual parent segment (#3710 R-02)', () => {
	for (const target of RESIDUAL_CASES) {
		test(`TS sibling: ${target} throws with the residual-parent diagnostic`, () => {
			expect(() => normalizeMockTarget(target)).toThrow(
				/residual parent segment in target/,
			);
		}, 30_000);

		test(`bash sibling: ${target} exits nonzero with the stderr diagnostic`, async () => {
			const result = await runBounded(BASH_CHILD_SCRIPT, target);
			expect(
				result.timedOut,
				`bash ${target}: child never exited (wedge)`,
			).toBe(false);
			expect(result.status, `bash ${target}: no exit status`).not.toBe(null);
			expect(result.status, `bash ${target}: expected nonzero exit`).not.toBe(
				0,
			);
			expect(
				result.stderr.includes(
					`rejecting residual parent segment in target: ${target}`,
				),
				`bash ${target}: stderr diagnostic missing: ${result.stderr}`,
			).toBe(true);
			expect(
				result.stdout.includes('OUT:src/..'),
				`bash ${target}: a traversal-bearing value was emitted: ${result.stdout}`,
			).toBe(false);
		}, 60_000);
	}
});

describe('normalize_mock_target keeps a benign in-segment dotdot (#3710 R-02)', () => {
	test('TS sibling: a..b.ts normalizes without a parent segment', () => {
		expect(normalizeMockTarget('a..b.ts')).toBe('src/a..b.ts');
	}, 30_000);

	test('bash sibling: a..b.ts normalizes without a parent segment', async () => {
		const result = await runBounded(BASH_CHILD_SCRIPT, 'a..b.ts');
		expect(result.timedOut).toBe(false);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('OUT:src/a..b.ts');
	}, 60_000);
});
