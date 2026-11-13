import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../../helpers/tmpdir.js';

// #3605 AC1/AC6: scripts/ci/run-test-battery.ts is the fail-closed battery
// wrapper. Raw multi-file `bun test` batches silently drop unmatched paths and
// exit 0; the wrapper refuses them at admission, propagates per-file failures,
// refuses empty discovery, and keeps discovered == executed.

const ROOT = path.join(import.meta.dir, '..', '..', '..', '..');

let directory = '';

beforeEach(() => {
	directory = canonicalMkdtemp('battery-wrapper-test-');
});

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

function runBattery(
	args: string[],
	cwd = ROOT,
): { status: number; output: string } {
	// Invoke bun directly: bashCommand() would hand the .ts to bash as a shell
	// script (an explicit interpreter bypasses the shebang), which is how the
	// compat-wiring suite drives the sibling runner too.
	const script = path.join(ROOT, 'scripts', 'ci', 'run-test-battery.ts');
	const result = spawnSync(process.execPath, [script, ...args], {
		cwd,
		encoding: 'utf-8',
		stdin: 'ignore',
		timeout: 180_000,
	});
	return {
		status: result.status ?? -1,
		output: `${result.stdout}${result.stderr}`,
	};
}

// vacuous-ok: fixture FILE CONTENT for a passing bun test, not an assertion in this suite
const PASS_FIXTURE = `import { test, expect } from 'bun:test';\ntest('pass', () => { expect(1).toBe(1); });\n`;
const FAIL_FIXTURE = `import { test, expect } from 'bun:test';\ntest('fail', () => { expect(1).toBe(2); });\n`;

describe('run-test-battery admission (#3605 AC1)', () => {
	test('refuses an unmatched path inside a multi-file batch, naming it', () => {
		const real = path.join(
			ROOT,
			'tests/unit/pr-review/observability-generation-ceiling-3593-r4.test.ts',
		);
		const { status, output } = runBattery([
			'tests/unit/pr-review/no-such-file-3605a.test.ts',
			real,
		]);
		expect(status).toBe(1);
		expect(output).toContain('BATTERY-REFUSED');
		expect(output).toContain('no-such-file-3605a.test.ts');
	}, 60_000);

	test('refuses a literal unmatched glob and a directory argument', () => {
		const glob = path.join(directory, 'no-such-*.test.ts');
		const { status, output } = runBattery([glob, path.join(directory)]);
		expect(status).toBe(1);
		expect(output).toContain('BATTERY-REFUSED');
	}, 60_000);

	test('refuses empty discovery (no positional args)', () => {
		const { status, output } = runBattery([]);
		expect(status).toBe(1);
		expect(output).toContain('BATTERY-REFUSED: no test files discovered');
	}, 30_000);
});

describe('run-test-battery exit semantics (#3605 AC6)', () => {
	test('nonzero when any executed file failed, naming the file', async () => {
		const failPath = path.join(directory, 'fixture-fail.test.ts');
		const passPath = path.join(directory, 'fixture-pass.test.ts');
		await fs.writeFile(failPath, FAIL_FIXTURE, 'utf-8');
		await fs.writeFile(passPath, PASS_FIXTURE, 'utf-8');
		const { status, output } = runBattery([failPath, passPath]);
		expect(status).toBe(1);
		expect(output).toContain('fixture-fail');
		expect(output).toContain('BATTERY pass=1 fail=1');
	}, 180_000);

	test('zero on all-pass with a summary and a tree receipt', async () => {
		const passPath = path.join(directory, 'fixture-pass.test.ts');
		await fs.writeFile(passPath, PASS_FIXTURE, 'utf-8');
		const receiptOut = path.join(directory, 'receipt.json');
		const { status, output } = runBattery([
			passPath,
			'--receipt-out',
			receiptOut,
		]);
		expect(status).toBe(0);
		expect(output).toContain('BATTERY pass=1 fail=0');
		expect(output).toContain('battery-tree-receipt:');
		const receipt = JSON.parse(await fs.readFile(receiptOut, 'utf-8')) as {
			head: string;
			dirty: string;
			files: string[];
		};
		expect(receipt.head).toMatch(/^[0-9a-f]{40}$/);
		expect(Array.isArray(receipt.files)).toBe(true);
		expect(receipt.files.length).toBe(1);
	}, 180_000);
});

describe('assertBatteryAccounting seam', () => {
	// Pure-function import through the source file (absolute path keeps the
	// module graph identical to the script's own resolution).
	test('equal sets pass; disagreeing counts and missing members throw', async () => {
		const mod = await import(path.join(ROOT, 'scripts/ci/run-test-battery.ts'));
		const seam = mod.assertBatteryAccounting as (
			a: readonly string[],
			b: readonly string[],
		) => void;
		expect(() => seam(['a', 'b'], ['a', 'b'])).not.toThrow();
		expect(() => seam(['a'], ['a', 'b'])).toThrow(/executed count disagrees/);
		expect(() => seam(['a', 'b'], ['a', 'c'])).toThrow(
			/executed set is missing/,
		);
	}, 30_000);
});
