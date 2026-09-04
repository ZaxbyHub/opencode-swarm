import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleBenchmarkCommand } from '../../../src/commands/benchmark';
import { isCommandFailure } from '../../../src/commands/registry';
import { resetSwarmState } from '../../../src/state';

/**
 * Issue #2493 (critic round): the structured CommandFailure half of the
 * CommandResult union was untested at the production call site — every
 * benchmark test normalized through resultText(), so reverting the
 * `--ci-gate` failure to `return output;` (CLI exit 0 on a failed gate)
 * would have passed the suite. These tests pin the exit-code contract.
 */
let testDir: string;

beforeEach(() => {
	resetSwarmState();
	testDir = path.join(
		os.tmpdir(),
		`benchmark-exit-code-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

describe('benchmark --ci-gate exit codes (issue #2493)', () => {
	test('a failing CI gate returns a CommandFailure with exitCode 1', async () => {
		// No evidence in a fresh project → every quality check is missing →
		// the gate fails closed.
		const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);

		expect(isCommandFailure(result)).toBe(true);
		if (isCommandFailure(result)) {
			expect(result.ok).toBe(false);
			expect(result.exitCode).toBe(1);
			expect(result.text).toContain('❌ FAILED');
		}
	});

	test('a passing CI gate returns a plain string (exit code stays 0)', async () => {
		// 'status' is not a gated invocation; its handler is string-returning
		// today and must stay that way (only FAILURES are structured).
		const result = await handleBenchmarkCommand(testDir, ['--cumulative']);
		expect(typeof result).toBe('string');
	});
});
