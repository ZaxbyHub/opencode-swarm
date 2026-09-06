import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	type PairRunResult,
	main as runCrossContamination,
} from '../../../scripts/check-cross-contamination';
import { spawnUtf8 } from '../../../scripts/gate-utils';
import { bashCommand, resolveBash } from '../../helpers/bash.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';

const REPO_ROOT = path.resolve(__dirname, '../../../');
const CROSS_CONTAMINATION_GATE = path.resolve(
	REPO_ROOT,
	'scripts/check-cross-contamination.ts',
);
const CROSS_CONTAMINATION_TIMEOUT_MS = 180_000;
const hasBash = (() => {
	try {
		resolveBash();
		return true;
	} catch {
		return false;
	}
})();
function tsKnownSharedProcessWarning(actualPasses: number): string {
	return `::warning title=Cross-contamination known issue::Co-run of tests/unit/hooks/knowledge-reader.test.ts + tests/unit/services/skill-generator.test.ts: ${actualPasses} pass meets the minimum 71-pass floor but exits non-zero. Allowed known shared-process outcome: CI runs each discovered unit file in its own process (per-file CI isolation), so this pre-existing mock leak is non-blocking.`;
}

function legacyKnownIssueWarning(actualPasses: number): string {
	return `::warning title=Cross-contamination known issue::Co-run of tests/unit/hooks/knowledge-reader.test.ts + tests/unit/services/skill-generator.test.ts: expected 99 pass, got ${actualPasses} pass (known baseline: 71). Pre-existing vi.mock() leak — tracked in scripts/check-cross-contamination.sh.`;
}

function tsExpected(actualPasses: number): string {
	return `${tsKnownSharedProcessWarning(actualPasses)}\n\nKnown pre-existing cross-contamination present (non-blocking).\nThis shared-process-only outcome remains guarded by its configured pass floor and ceiling in this script.`;
}

function legacyExpected(actualPasses: number): string {
	return `${legacyKnownIssueWarning(actualPasses)}\nKnown pre-existing cross-contamination present (non-blocking).\nExpected passes when fixed: update known_expected in this script.`;
}

function readKnownPairPassCount(output: string): number | undefined {
	const match = output.match(
		/knowledge-reader\.test\.ts \+ tests\/unit\/services\/skill-generator\.test\.ts: (?:expected 99 pass, got )?(\d+) pass/,
	);
	return match ? Number(match[1]) : undefined;
}

function normalizeOutput(text: string): string {
	return text.replace(/\r\n/g, '\n').trimEnd();
}

async function captureLogLines(
	run: (log: (line: string) => void) => number | Promise<number>,
): Promise<{ exitCode: number; stdout: string }> {
	const lines: string[] = [];
	const exitCode = await run((line) => lines.push(line));
	return { exitCode, stdout: lines.join('\n') };
}

async function runTsGate(scriptPath: string, cwd: string, timeout = 30_000) {
	return spawnUtf8([process.execPath, 'run', scriptPath], cwd, timeout);
}

async function runLegacyGate(
	scriptRelativePath: string,
	cwd: string,
	timeout = 30_000,
	scriptRoot: string = path.join(
		REPO_ROOT,
		'tests',
		'fixtures',
		'bash-gates-2094',
		'archive',
	),
) {
	return spawnUtf8(
		bashCommand(path.join(scriptRoot, ...scriptRelativePath.split('/'))),
		cwd,
		timeout,
	);
}

describe('cross-contamination legacy-oracle compatibility', () => {
	test('reports the allowed known shared-process outcome', async () => {
		const captured = await captureLogLines((log) =>
			runCrossContamination(REPO_ROOT, {
				runPair: (_repoRoot, pair): PairRunResult =>
					pair.fileA.includes('knowledge-reader')
						? {
								exitCode: 1,
								stdout: ' 71 pass\n',
								stderr:
									"ENOENT: no such file or directory, lstat '/tmp/.swarm'\n",
							}
						: { exitCode: 0, stdout: '57 pass\n', stderr: '' },
				log,
			}),
		);

		expect(captured.exitCode).toBe(0);
		expect(normalizeOutput(captured.stdout)).toBe(tsExpected(71));
	});

	test('reports a clean outcome when both pairs pass', async () => {
		const captured = await captureLogLines((log) =>
			runCrossContamination(REPO_ROOT, {
				runPair: (_repoRoot, pair): PairRunResult => ({
					exitCode: 0,
					stdout: `${pair.fileA.includes('knowledge-reader') ? 98 : 57} pass\n`,
					stderr: '',
				}),
				log,
			}),
		);

		expect(captured.exitCode).toBe(0);
		expect(normalizeOutput(captured.stdout)).toBe(
			'No cross-contamination detected: all test pairs pass when co-run.',
		);
	});

	test('preserves the archived Bash owner golden separately when Bash is available', async () => {
		if (!hasBash) return;
		const isolatedEnv = createIsolatedTestEnv();
		try {
			const legacyResult = await runLegacyGate(
				'scripts/check-cross-contamination.sh',
				REPO_ROOT,
				CROSS_CONTAMINATION_TIMEOUT_MS,
			);
			const tsResult = await runTsGate(
				CROSS_CONTAMINATION_GATE,
				REPO_ROOT,
				CROSS_CONTAMINATION_TIMEOUT_MS,
			);

			expect(tsResult.exitCode, tsResult.stderr).toBe(0);
			const tsPasses = readKnownPairPassCount(
				`${tsResult.stdout}\n${tsResult.stderr}`,
			);
			if (tsPasses === undefined) {
				expect(normalizeOutput(tsResult.stdout), tsResult.stderr).toBe(
					'No cross-contamination detected: all test pairs pass when co-run.',
				);
			} else {
				expect(tsPasses).toBeGreaterThanOrEqual(71);
				expect(tsPasses).toBeLessThanOrEqual(98);
				expect(normalizeOutput(tsResult.stdout), tsResult.stderr).toBe(
					tsExpected(tsPasses),
				);
			}
			expect(normalizeOutput(tsResult.stderr)).toBe('');
			expect(legacyResult.exitCode, legacyResult.stderr).toBe(0);
			const normalizedLegacy = normalizeOutput(legacyResult.stdout);
			const legacyPasses = readKnownPairPassCount(
				`${legacyResult.stdout}\n${legacyResult.stderr}`,
			);
			if (legacyPasses === undefined) {
				expect(normalizedLegacy).not.toContain(
					'::warning title=Cross-contamination known issue::',
				);
				expect(normalizedLegacy).toContain(
					'No cross-contamination detected: all test pairs pass when co-run.',
				);
				expect(normalizedLegacy).toEndWith(
					'No cross-contamination detected: all test pairs pass when co-run.',
				);
			} else {
				expect(legacyPasses).toBeGreaterThanOrEqual(71);
				expect(legacyPasses).toBeLessThan(99);
				expect(normalizedLegacy).toStartWith(
					legacyKnownIssueWarning(legacyPasses),
				);
			}
			expect(normalizedLegacy).toContain(
				'::warning title=Mock module not in isolation list::',
			);
			expect(normalizedLegacy).toContain(
				'::notice title=Hook test file not in CI coverage::',
			);
			if (legacyPasses !== undefined) {
				expect(normalizedLegacy).toEndWith(
					legacyExpected(legacyPasses).slice(
						legacyKnownIssueWarning(legacyPasses).length + 1,
					),
				);
			}
			expect(normalizedLegacy).not.toBe(normalizeOutput(tsResult.stdout));
			expect(normalizeOutput(legacyResult.stderr)).toBe('');
		} finally {
			isolatedEnv.cleanup();
		}
	}, 240_000);
});
