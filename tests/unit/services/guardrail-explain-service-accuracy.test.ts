import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;

beforeEach(() => {
	tempDir = canonicalMkdtemp('guardrail-explain-accuracy-');
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function extractDecision(markdown: string): 'allow' | 'block' | null {
	const match = markdown.match(/\|\s*Decision\s*\|\s*(\w+)\s*\|/i);
	if (!match) return null;
	const value = match[1]!.toLowerCase();
	return value === 'allow' || value === 'block' ? value : null;
}

function extractFiringRule(markdown: string): string {
	const match = markdown.match(/\|\s*Firing Rule\s*\|\s*(.+?)\s*\|/i);
	return match ? match[1]!.trim() : '';
}

describe('guardrail explain accuracy — destructive commands', () => {
	test('git reset --hard HEAD~1 is blocked', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'git reset --hard HEAD~1',
		]);
		expect(extractDecision(result)).toBe('block');
		expect(extractFiringRule(result).toLowerCase()).toContain('reset');
	});

	test('fork bomb is blocked', async () => {
		const result = await handleGuardrailExplain(tempDir, [':(){ :|:& };:']);
		expect(extractDecision(result)).toBe('block');
		expect(extractFiringRule(result).toLowerCase()).toContain('fork bomb');
	});

	test('forced push is blocked while force-with-lease is allowed', async () => {
		const blocked = await handleGuardrailExplain(tempDir, [
			'git push --force origin main',
		]);
		const allowed = await handleGuardrailExplain(tempDir, [
			'git push --force-with-lease origin feature-branch',
		]);
		expect(extractDecision(blocked)).toBe('block');
		expect(extractDecision(allowed)).toBe('allow');
	});

	test('git clean, filesystem root removal, and SQL truncate are blocked', async () => {
		for (const command of [
			'git clean -fd',
			'rm -rf /',
			'TRUNCATE TABLE users',
		]) {
			const result = await handleGuardrailExplain(tempDir, [command]);
			expect(extractDecision(result)).toBe('block');
		}
	});

	test('safe commands and in-scope writes are allowed', async () => {
		const safe = await handleGuardrailExplain(tempDir, ['echo hello']);
		const write = await handleGuardrailExplain(tempDir, [
			'--scope',
			'build',
			'rm',
			'-rf',
			'build',
		]);
		expect(extractDecision(safe)).toBe('allow');
		expect(extractDecision(write)).toBe('allow');
	});

	test('mkfs only blocks the destructive extension form', async () => {
		const plain = await handleGuardrailExplain(tempDir, ['mkfs /dev/sdb']);
		const extended = await handleGuardrailExplain(tempDir, [
			'mkfs.ext4 /dev/sdb',
		]);
		expect(extractDecision(plain)).toBe('allow');
		expect(extractDecision(extended)).toBe('block');
	});

	test('human-only shell commands and system-managed writes are blocked', async () => {
		const command = await handleGuardrailExplain(tempDir, [
			'bunx opencode-swarm run reset',
		]);
		const write = await handleGuardrailExplain(tempDir, [
			'echo x > .swarm/spec-staleness.json',
		]);
		expect(extractDecision(command)).toBe('block');
		expect(extractFiringRule(command).toLowerCase()).toContain('human-only');
		expect(extractDecision(write)).toBe('block');
		expect(extractFiringRule(write).toLowerCase()).toContain('spec-staleness');
	});

	test('read-only system-managed access is allowed', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'cat .swarm/spec-staleness.json',
		]);
		expect(extractDecision(result)).toBe('allow');
	});
});

describe('guardrail explain redaction', () => {
	test('firing rules do not leak raw home paths', async () => {
		const absolute = await handleGuardrailExplain(tempDir, [
			'rm -rf /tmp/some-dir',
		]);
		const home = await handleGuardrailExplain(tempDir, ['rm -rf ~/some-path']);
		for (const rule of [extractFiringRule(absolute), extractFiringRule(home)]) {
			expect(rule).not.toMatch(/\/home\//);
			expect(rule).not.toMatch(/C:\\\\Users\\/i);
		}
	});

	test('safe command firing rule is also redacted', async () => {
		const result = await handleGuardrailExplain(tempDir, ['ls -la']);
		const rule = extractFiringRule(result);
		expect(extractDecision(result)).toBe('allow');
		expect(rule).not.toMatch(/\/home\//);
		expect(rule).not.toMatch(/C:\\\\Users\\/i);
	});
});

describe('guardrail explain argument parsing', () => {
	test('empty args return usage text', async () => {
		const result = await handleGuardrailExplain(tempDir, []);
		expect(result).toContain('dry-run');
	});

	test('unknown flags remain visible in the rendered command', async () => {
		const result = await handleGuardrailExplain(tempDir, ['--unknown', 'ls']);
		expect(result).toContain('ls');
	});
});
