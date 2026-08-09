import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runExternalTool } from '../../../src/utils/external-tool-runner.js';

const packageRoot = path.resolve(import.meta.dir, '../../..');
const fixtureRoot = path.join(
	packageRoot,
	'evaluation-fixtures',
	'pr-review-recovery',
);
const scorer = path.join(fixtureRoot, 'environment', 'score-recovery.cjs');

async function scoreFixture(name: string) {
	const artifactDirectory = path.join(fixtureRoot, 'scorer-fixtures', name);
	const result = await runExternalTool({
		executable: process.execPath,
		args: [scorer],
		cwd: path.join(fixtureRoot, 'environment'),
		timeoutMs: 10_000,
		maxStdoutBytes: 16 * 1024,
		maxStderrBytes: 16 * 1024,
		env: {
			...process.env,
			SWARM_EVAL_ARTIFACT_DIR: artifactDirectory,
		},
	});
	expect(result.status).toBe('completed');
	expect(result.exitCode).toBe(0);
	return JSON.parse(result.stdout) as {
		score: number;
		metadata?: { failures?: string[] };
	};
}

describe('PR-review recovery project scorer', () => {
	test('accepts the constrained recovery response', async () => {
		const result = await scoreFixture('passing');
		expect(result.score).toBe(1);
		expect(result.metadata?.failures).toEqual([]);
	});

	for (const [name, expectedFailure] of [
		['blind-full-wave-retry', 'blind-full-wave-retry-forbidden'],
		['profile-b-fallback', 'profile-b-fallback-forbidden'],
		['missing-reproduction', 'missing-correct-minimal-reproduction'],
		['copied-contract', 'contract-source-drift'],
		['parser-only', 'parser-only-oracle-forbidden'],
		['underclaimed-harm', 'harm-not-demonstrated-workflow-blocked'],
		['invented-harm', 'harm-not-demonstrated-workflow-blocked'],
		['unsupported-severity', 'severity-not-supported-high'],
		['critical-without-harm', 'critical-without-demonstrated-harm'],
		['premature-systemic-claim', 'premature-systemic-defect-claim'],
		['contradictory', 'contradictory-systemic-claim'],
	] as const) {
		test(`rejects ${name}`, async () => {
			const result = await scoreFixture(name);
			expect(result.score).toBe(0);
			expect(result.metadata?.failures).toContain(expectedFailure);
		});
	}

	test('rejects malformed JSON without failing the scorer process', async () => {
		const result = await scoreFixture('malformed');
		expect(result.score).toBe(0);
		expect(result.metadata?.failures).toContain('invalid-json');
	});
});
