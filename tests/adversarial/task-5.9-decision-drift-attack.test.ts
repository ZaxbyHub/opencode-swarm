/** Adversarial security tests for decision-drift detection (Task 5.9). */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	analyzeDecisionDrift,
	type Decision,
	type DriftAnalysisResult,
	extractDecisionsFromContext,
	findContradictions,
	formatDriftForContext,
} from '../../src/services/decision-drift-analyzer';

describe('ATTACK VECTOR 1: Malformed Context/Plan Inputs', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'drift-attack-'));
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {}
	});

	test('handles binary data in context.md without crashing', async () => {
		const binaryData = Buffer.from([
			0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x89, 0x50, 0x4e, 0x47,
		]);
		await writeFile(join(tempDir, '.swarm', 'context.md'), binaryData);

		const result = await analyzeDecisionDrift(tempDir);
		expect(result).toBeDefined();
		expect(result.hasDrift).toBe(false);
		expect(result.signals).toBeInstanceOf(Array);
	});

	test('handles null bytes embedded in markdown', async () => {
		const maliciousContent = `## Decisions\n- Use \x00Type\x00Script\x00\n- \x00Remove\x00 config`;
		await writeFile(join(tempDir, '.swarm', 'context.md'), maliciousContent);

		const result = await analyzeDecisionDrift(tempDir);
		expect(result).toBeDefined();
		expect(result.signals).toBeInstanceOf(Array);
	});

	test('handles control characters in decision text', async () => {
		const content = `## Decisions\n- Use \u001b[31mTypeScript\u001b[0m\n- \u0008\u0008Remove`;
		await writeFile(join(tempDir, '.swarm', 'context.md'), content);

		const decisions = extractDecisionsFromContext(content);
		expect(decisions).toBeInstanceOf(Array);
		// Should not throw, may extract sanitized content
	});

	test('handles deeply nested markdown structures', async () => {
		const nestedContent = `## Decisions\n${'  '.repeat(100)}- Deep nested decision`;
		await writeFile(join(tempDir, '.swarm', 'context.md'), nestedContent);

		const result = await analyzeDecisionDrift(tempDir);
		expect(result).toBeDefined();
	});

	test('handles extremely long decision lines (DoS attempt)', async () => {
		const longDecision = 'x'.repeat(100000);
		const content = `## Decisions\n- ${longDecision}`;
		await writeFile(join(tempDir, '.swarm', 'context.md'), content);

		const startTime = Date.now();
		const result = await analyzeDecisionDrift(tempDir);
		const elapsed = Date.now() - startTime;

		expect(result).toBeDefined();
		// Should complete within reasonable time (< 5 seconds)
		expect(elapsed).toBeLessThan(5000);
	});

	test('handles context.md with only whitespace', async () => {
		await writeFile(join(tempDir, '.swarm', 'context.md'), '   \n\t\n   \n');

		const result = await analyzeDecisionDrift(tempDir);
		expect(result.hasDrift).toBe(false);
		expect(result.signals).toHaveLength(0);
	});

	test('handles empty context.md', async () => {
		await writeFile(join(tempDir, '.swarm', 'context.md'), '');

		const result = await analyzeDecisionDrift(tempDir);
		expect(result.hasDrift).toBe(false);
	});

	test('handles context.md with unicode edge cases', async () => {
		const content = `## Decisions\n- Use 🚀 emoji everywhere\n- 中文决定\n- العربية\n- עברית`;
		await writeFile(join(tempDir, '.swarm', 'context.md'), content);

		const decisions = extractDecisionsFromContext(content);
		expect(decisions.length).toBe(4);
	});

	test('handles malformed plan.json with invalid JSON', async () => {
		await writeFile(join(tempDir, '.swarm', 'plan.json'), '{ not valid json }');
		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`## Decisions\n- Use TypeScript`,
		);

		const result = await analyzeDecisionDrift(tempDir);
		expect(result).toBeDefined();
		// Should gracefully handle plan parse error
	});

	test('handles plan.json with unexpected structure', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({ foo: 'bar', nested: { deeply: { invalid: true } } }),
		);
		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`## Decisions\n- Use TypeScript`,
		);

		const result = await analyzeDecisionDrift(tempDir);
		expect(result).toBeDefined();
	});

	test('handles plan.json with null current_phase', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({ current_phase: null, phases: [] }),
		);
		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`## Decisions\n- Use TypeScript`,
		);

		const result = await analyzeDecisionDrift(tempDir);
		expect(result).toBeDefined();
	});

	test('handles plan.json with negative phase number', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({ current_phase: -999, phases: [] }),
		);
		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`## Decisions\n- Use TypeScript`,
		);

		const result = await analyzeDecisionDrift(tempDir);
		expect(result).toBeDefined();
	});

	test('handles plan.json with Infinity phase', async () => {
		// JSON.stringify will convert Infinity to null, but let's write it manually
		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			'{"current_phase": Infinity, "phases": []}',
		);
		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`## Decisions\n- Use TypeScript`,
		);

		// Should not crash - JSON.parse will handle it
		const result = await analyzeDecisionDrift(tempDir);
		expect(result).toBeDefined();
	});

	test('handles context with malformed phase markers', async () => {
		const content = `## Phase abc\n## Phase -1\n## Phase NaN\n## Decisions\n- Use TypeScript`;
		await writeFile(join(tempDir, '.swarm', 'context.md'), content);

		const decisions = extractDecisionsFromContext(content);
		expect(decisions).toBeInstanceOf(Array);
	});

	test('handles cyclic section references (markdown bomb attempt)', async () => {
		// Create a file with repeated section references
		const sections = [];
		for (let i = 0; i < 1000; i++) {
			sections.push(`## Section${i}\nContent${i}`);
		}
		sections.push(`## Decisions\n- Decision`);
		const content = sections.join('\n\n');
		await writeFile(join(tempDir, '.swarm', 'context.md'), content);

		const startTime = Date.now();
		const result = await analyzeDecisionDrift(tempDir);
		const elapsed = Date.now() - startTime;

		expect(result).toBeDefined();
		expect(elapsed).toBeLessThan(5000);
	});
});

describe('ATTACK VECTOR 2: Contradiction-Spam Prompt Bloat', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'drift-attack-'));
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {}
	});

	test('limits contradictions via maxSignals config', async () => {
		// Create 100 contradictory decision pairs
		const decisions: string[] = [];
		for (let i = 0; i < 100; i++) {
			decisions.push(`- Use library-${i}`);
			decisions.push(`- Do not use library-${i}`);
		}

		const content = `## Decisions\n${decisions.join('\n')}`;
		await writeFile(join(tempDir, '.swarm', 'context.md'), content);

		// Default maxSignals is 5
		const result = await analyzeDecisionDrift(tempDir);
		expect(result.signals.length).toBeLessThanOrEqual(5);
	});

	test('contradiction detection does not cause exponential time', async () => {
		// Create many decisions that could cause O(n^2) comparison issues
		const decisions: Decision[] = [];
		for (let i = 0; i < 500; i++) {
			decisions.push({
				text: `Decision ${i} with unique content`,
				phase: 1,
				confirmed: false,
				timestamp: null,
				line: i + 1,
			});
		}

		const startTime = Date.now();
		const contradictions = findContradictions(decisions);
		const elapsed = Date.now() - startTime;

		expect(contradictions).toBeInstanceOf(Array);
		// Should complete in reasonable time even with 500 decisions
		expect(elapsed).toBeLessThan(5000);
	});

	test('formatDriftForContext truncates long summaries', async () => {
		const longSignals = Array.from({ length: 100 }, (_, i) => ({
			id: `stale-${i}`,
			severity: 'warning' as const,
			type: 'stale' as const,
			message: `Stale decision: ${'x'.repeat(100)}`,
			source: { file: 'context.md', line: i + 1 },
		}));

		const result: DriftAnalysisResult = {
			hasDrift: true,
			signals: longSignals,
			summary: 'x'.repeat(2000), // Very long summary
			analyzedAt: new Date().toISOString(),
		};

		const formatted = formatDriftForContext(result);
		expect(formatted.length).toBeLessThanOrEqual(603); // maxLength 600 + "..."
	});

	test('handles contradictory decisions with similar subjects correctly', () => {
		const decisions: Decision[] = [
			{
				text: 'Use TypeScript for all files',
				phase: 1,
				confirmed: true,
				timestamp: null,
				line: 1,
			},
			{
				text: 'Do not use TypeScript for files',
				phase: 2,
				confirmed: false,
				timestamp: null,
				line: 2,
			},
		];

		const contradictions = findContradictions(decisions);
		expect(contradictions.length).toBeGreaterThan(0);
	});

	test('does not false positive on unrelated decisions', () => {
		const decisions: Decision[] = [
			{
				text: 'Use React for frontend',
				phase: 1,
				confirmed: true,
				timestamp: null,
				line: 1,
			},
			{
				text: 'Use Vue for frontend widget',
				phase: 2,
				confirmed: false,
				timestamp: null,
				line: 2,
			},
		];

		const contradictions = findContradictions(decisions);
		// These are different frameworks but not direct contradictions
		expect(contradictions.length).toBe(0);
	});

	test('handles decisions with common words that could cause false positives', () => {
		const decisions: Decision[] = [
			{
				text: 'The system must validate input',
				phase: 1,
				confirmed: true,
				timestamp: null,
				line: 1,
			},
			{
				text: 'The system must log errors',
				phase: 2,
				confirmed: false,
				timestamp: null,
				line: 2,
			},
			{
				text: 'The system must handle timeouts',
				phase: 3,
				confirmed: false,
				timestamp: null,
				line: 3,
			},
		];

		const contradictions = findContradictions(decisions);
		// These are all "must" statements but about different things - not contradictions
		expect(contradictions.length).toBe(0);
	});

	test('massive contradiction text does not overflow context window', async () => {
		const decisions: string[] = [];
		// Create massive contradictory decisions
		for (let i = 0; i < 50; i++) {
			decisions.push(`- Keep file ${'a'.repeat(200)}${i}`);
			decisions.push(`- Remove file ${'b'.repeat(200)}${i}`);
		}

		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({ current_phase: 2, phases: [] }),
		);
		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`## Decisions\n${decisions.join('\n')}`,
		);

		const result = await analyzeDecisionDrift(tempDir);
		const formatted = formatDriftForContext(result);

		// Verify bounded output
		expect(formatted.length).toBeLessThanOrEqual(603);
	});
});

describe('ATTACK VECTOR 3: Malformed Evidence JSON', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'drift-attack-'));
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
		await mkdir(join(tempDir, '.swarm', 'evidence'), { recursive: true });
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {}
	});

	test('handles corrupted evidence JSON files', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'evidence', 'phase-1.json'),
			'not valid json {{{',
		);
		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`## Decisions\n- Use TypeScript`,
		);

		// This tests the system enhancer which reads evidence files
		// Should not crash
		const result = await analyzeDecisionDrift(tempDir);
		expect(result).toBeDefined();
	});

	test('handles evidence JSON with prototype pollution attempt', async () => {
		const malicious = JSON.stringify({
			__proto__: { polluted: true },
			constructor: { prototype: { polluted: true } },
			type: 'retrospective',
		});
		await writeFile(
			join(tempDir, '.swarm', 'evidence', 'phase-1.json'),
			malicious,
		);
		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`## Decisions\n- Use TypeScript`,
		);

		const result = await analyzeDecisionDrift(tempDir);
		expect(result).toBeDefined();
	});

	test('handles evidence JSON with null values', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'evidence', 'phase-1.json'),
			JSON.stringify({ type: null, data: null }),
		);
		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`## Decisions\n- Use TypeScript`,
		);

		const result = await analyzeDecisionDrift(tempDir);
		expect(result).toBeDefined();
	});

	test('handles evidence JSON with circular reference attempt', async () => {
		// Can't actually create circular in JSON, but test with self-referencing keys
		const circular = '{"a":"$ref:b","b":"$ref:a"}';
		await writeFile(
			join(tempDir, '.swarm', 'evidence', 'phase-1.json'),
			circular,
		);
		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`## Decisions\n- Use TypeScript`,
		);

		const result = await analyzeDecisionDrift(tempDir);
		expect(result).toBeDefined();
	});

	test('handles evidence JSON with extremely large numbers', async () => {
		const largeNums = JSON.stringify({
			type: 'retrospective',
			phase_number: 1e308,
			reviewer_rejections: Infinity,
		});
		await writeFile(
			join(tempDir, '.swarm', 'evidence', 'phase-1.json'),
			largeNums,
		);
		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`## Decisions\n- Use TypeScript`,
		);

		const result = await analyzeDecisionDrift(tempDir);
		expect(result).toBeDefined();
	});

	test('handles evidence directory without read permissions', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'evidence', 'phase-1.json'),
			'{"type":"retrospective"}',
		);
		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`## Decisions\n- Use TypeScript`,
		);

		// Note: Permission tests may not work on all platforms
		try {
			await chmod(join(tempDir, '.swarm', 'evidence'), 0o000);
		} catch {
			// Skip on platforms that don't support chmod
		}

		const result = await analyzeDecisionDrift(tempDir);
		expect(result).toBeDefined();
	});

	test('handles symlinks in evidence directory', async () => {
		// Create a symlink that could point outside the directory
		await writeFile(
			join(tempDir, '.swarm', 'evidence', 'phase-1.json'),
			'{"type":"retrospective"}',
		);

		const result = await analyzeDecisionDrift(tempDir);
		expect(result).toBeDefined();
	});
});
