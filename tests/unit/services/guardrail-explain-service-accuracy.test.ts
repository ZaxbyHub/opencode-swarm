/**
 * Accuracy and regression coverage for src/services/guardrail-explain-service.ts.
 *
 * Split from guardrail-explain-service.test.ts to keep each test file under the
 * FR-006 size cap while preserving the existing coverage set.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;

beforeEach(async () => {
	tempDir = canonicalMkdtemp('guardrail-explain-accuracy-test-');
	await mkdir(join(tempDir, '.swarm'), { recursive: true });
});

afterEach(async () => {
	if (existsSync(tempDir)) {
		await rm(tempDir, { recursive: true, force: true });
	}
	mock.restore();
});

function extractDecision(markdown: string): 'allow' | 'block' | null {
	const match = markdown.match(/\|\s*Decision\s*\|\s*(\w+)\s*\|/i);
	if (!match) return null;
	const val = match[1]!.toLowerCase();
	if (val === 'allow' || val === 'block') return val;
	return null;
}

function extractFiringRule(markdown: string): string {
	const match = markdown.match(/\|\s*Firing Rule\s*\|\s*(.+?)\s*\|/i);
	return match ? match[1]!.trim() : '';
}

describe('Guardrail explain accuracy — destructive commands', () => {
	test('git reset --hard HEAD~1 → decision === block (destructive git operation)', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'git reset --hard HEAD~1',
		]);
		const decision = extractDecision(result);
		expect(decision).toBe('block');
		const firingRule = extractFiringRule(result);
		expect(firingRule).toBe('shared_classifier: destructive');
	});

	test('fork bomb :(){ :|:& };: → decision === block', async () => {
		const result = await handleGuardrailExplain(tempDir, [':(){ :|:& };:']);
		const decision = extractDecision(result);
		expect(decision).toBe('block');
		const firingRule = extractFiringRule(result);
		expect(firingRule).toBe('shared_classifier: catastrophic');
	});

	test('git push --force origin main → decision === block', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'git push --force origin main',
		]);
		const decision = extractDecision(result);
		expect(decision).toBe('block');
		const firingRule = extractFiringRule(result);
		expect(firingRule).toBe('shared_classifier: catastrophic');
	});

	test('git push --force-with-lease origin br → decision === allow', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'git push --force-with-lease origin feature-branch',
		]);
		const decision = extractDecision(result);
		expect(decision).toBe('allow');
	});

	test('git clean -fd → decision === block', async () => {
		const result = await handleGuardrailExplain(tempDir, ['git clean -fd']);
		const decision = extractDecision(result);
		expect(decision).toBe('block');
		const firingRule = extractFiringRule(result);
		expect(firingRule).toBe('shared_classifier: destructive');
	});

	test('rm -rf / → decision === block', async () => {
		const result = await handleGuardrailExplain(tempDir, ['rm -rf /']);
		const decision = extractDecision(result);
		expect(decision).toBe('block');
		const firingRule = extractFiringRule(result);
		expect(firingRule.toLowerCase()).toContain('filesystem root');
	});

	test('rm -rf build with --scope build → decision === allow (in-scope safe target)', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'--scope',
			'build',
			'rm',
			'-rf',
			'build',
		]);
		const decision = extractDecision(result);
		expect(decision).toBe('allow');
	});

	test('echo hello → decision === allow', async () => {
		const result = await handleGuardrailExplain(tempDir, ['echo hello']);
		const decision = extractDecision(result);
		expect(decision).toBe('allow');
	});

	test('TRUNCATE TABLE users → decision === block (destructive SQL DDL)', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'TRUNCATE TABLE users',
		]);
		const decision = extractDecision(result);
		expect(decision).toBe('block');
		const firingRule = extractFiringRule(result);
		expect(firingRule).toBe('shared_classifier: destructive');
	});

	test('fork bomb with whitespace after ":" (": () { :|:& };:") → decision === block', async () => {
		const result = await handleGuardrailExplain(tempDir, [': () { :|:& };:']);
		const decision = extractDecision(result);
		expect(decision).toBe('block');
	});

	test('mkfs with space ("mkfs /dev/sdb") → decision === allow (real only blocks mkfs[./])', async () => {
		const result = await handleGuardrailExplain(tempDir, ['mkfs /dev/sdb']);
		const decision = extractDecision(result);
		expect(decision).toBe('allow');
	});

	test('mkfs.ext4 → decision === block (real blocks mkfs[./])', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'mkfs.ext4 /dev/sdb',
		]);
		const decision = extractDecision(result);
		expect(decision).toBe('block');
	});

	test('in-project write WITHOUT --scope (echo hi > local.txt) → decision === allow', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'echo hi > local.txt',
		]);
		const decision = extractDecision(result);
		expect(decision).toBe('allow');
	});

	test('human-only swarm command via shell (bunx opencode-swarm run reset) → decision === block', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'bunx opencode-swarm run reset',
		]);
		const decision = extractDecision(result);
		expect(decision).toBe('block');
		const firingRule = extractFiringRule(result);
		expect(firingRule.toLowerCase()).toContain('human-only');
	});

	test('shell write to .swarm/spec-staleness.json → decision === block (system-managed file)', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'echo x > .swarm/spec-staleness.json',
		]);
		const decision = extractDecision(result);
		expect(decision).toBe('block');
		const firingRule = extractFiringRule(result);
		expect(firingRule.toLowerCase()).toContain('spec-staleness');
	});

	test('read-only cat of .swarm/spec-staleness.json → decision === allow (not a write)', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'cat .swarm/spec-staleness.json',
		]);
		const decision = extractDecision(result);
		expect(decision).toBe('allow');
	});
});

describe('Guardrail explain redaction — firingRule does not leak home directory', () => {
	test('firingRule for rm -rf /tmp/absolute does not contain raw /home/<user> or C:\\Users\\<user> path', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'rm -rf /tmp/some-dir',
		]);
		const firingRule = extractFiringRule(result);
		expect(firingRule).not.toMatch(/\/home\//);
		expect(firingRule).not.toMatch(/C:\\Users\\/i);
	});

	test('firingRule output uses tilde notation or safe form for home-adjacent paths', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'rm -rf ~/some-path',
		]);
		const firingRule = extractFiringRule(result);
		const containsRawHome =
			/\/home\/[^/]+/.test(firingRule) || /C:\\Users\\[^/]+/.test(firingRule);
		expect(containsRawHome).toBe(false);
	});

	test('safe command fires no blocking rule and allow rule is clean', async () => {
		const result = await handleGuardrailExplain(tempDir, ['ls -la']);
		const decision = extractDecision(result);
		expect(decision).toBe('allow');
		const firingRule = extractFiringRule(result);
		expect(firingRule).not.toMatch(/\/home\//);
		expect(firingRule).not.toMatch(/C:\\Users\\/i);
	});
});

describe('Argument parsing', () => {
	test('empty args returns usage message', async () => {
		const result = await handleGuardrailExplain(tempDir, []);
		expect(result).toContain('dry-run');
	});

	test('unknown flag is ignored and joined as shell command', async () => {
		const result = await handleGuardrailExplain(tempDir, ['--unknown', 'ls']);
		expect(typeof result).toBe('string');
		expect(result).toContain('ls');
	});
});
