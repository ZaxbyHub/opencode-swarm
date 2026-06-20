/**
 * Robustness tests for the curator post-mortem agent (FR-007, FR-008, FR-010).
 *
 * Uses the _internals DI seam — no mock.module.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	_internals,
	runCuratorPostMortem,
} from '../../../src/hooks/curator-postmortem.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTempDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), 'postmortem-robustness-test-'));
}

function ensureSwarmDir(dir: string): string {
	const swarmDir = path.join(dir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	return swarmDir;
}

function writePlan(dir: string): void {
	const swarmDir = ensureSwarmDir(dir);
	writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Robustness Test Project',
			swarm: 'test',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'complete',
					tasks: [],
				},
			],
		}),
	);
}

function getExpectedReportPath(dir: string): string {
	return path.join(
		dir,
		'.swarm',
		'post-mortem-test-Robustness_Test_Project.md',
	);
}

// ============================================================================
// Tests
// ============================================================================

describe('FR-007 — assembleLLMInput truncates long knowledge lessons', () => {
	test('truncates a knowledge lesson longer than 500 chars to exactly 500 chars', () => {
		const longLesson = 'x'.repeat(800);
		const result = _internals.assembleLLMInput(
			'plan-1',
			'Plan summary',
			[
				{
					id: 'K001',
					lesson: longLesson,
					applied: 0,
					violated: 0,
					ignored: 0,
					confidence: 0.5,
					status: 'active',
				},
			],
			null,
			[],
			[],
			[],
			[],
		);

		// Extract the KNOWLEDGE_ENTRIES section
		const knSectionStart = result.indexOf('KNOWLEDGE_ENTRIES:');
		const knSection = result.slice(knSectionStart);

		// Parse out the lesson from the serialized JSON
		const lessonMatch = knSection.match(/"lesson":"(x+)"/);
		expect(lessonMatch).not.toBeNull();
		expect(lessonMatch![1].length).toBeLessThanOrEqual(500);
		expect(lessonMatch![1].length).toBe(500);
	});

	test('also truncates proposal content, retrospectives, and drift reports at 500 chars', () => {
		const longContent = 'y'.repeat(700);
		const longRetro = 'z'.repeat(700);
		const longDrift = 'w'.repeat(700);

		const result = _internals.assembleLLMInput(
			'plan-1',
			'Plan summary',
			[],
			null,
			[{ source: 'proposal.md', content: longContent }],
			[],
			[longRetro],
			[longDrift],
		);

		// Proposal content should be truncated to 500
		const proposalSection = result.slice(result.indexOf('PENDING_PROPOSALS:'));
		const proposalMatch = proposalSection.match(/\[proposal\.md\]\n(y+)/);
		expect(proposalMatch).not.toBeNull();
		expect(proposalMatch![1].length).toBe(500);

		// Retro should be truncated to 500
		const retroSection = result.slice(result.indexOf('RETROSPECTIVES:'));
		const retroEnd = result.indexOf('DRIFT_REPORTS:');
		const retroSlice =
			retroEnd !== -1 ? retroSection.slice(0, retroEnd) : retroSection;
		const retroMatch = retroSlice.match(/(z+)/);
		expect(retroMatch).not.toBeNull();
		expect(retroMatch![1].length).toBe(500);

		// Drift should be truncated to 500
		const driftSection = result.slice(result.indexOf('DRIFT_REPORTS:'));
		const driftMatch = driftSection.match(/(w+)/);
		expect(driftMatch).not.toBeNull();
		expect(driftMatch![1].length).toBe(500);
	});

	test('does not alter lessons shorter than 500 chars', () => {
		const shortLesson = 'short lesson';
		const result = _internals.assembleLLMInput(
			'plan-1',
			'Plan summary',
			[
				{
					id: 'K001',
					lesson: shortLesson,
					applied: 0,
					violated: 0,
					ignored: 0,
					confidence: 0.5,
					status: 'active',
				},
			],
			null,
			[],
			[],
			[],
			[],
		);

		const knSectionStart = result.indexOf('KNOWLEDGE_ENTRIES:');
		const knSection = result.slice(knSectionStart);
		expect(knSection).toContain(`"lesson":"short lesson"`);
	});

	test('lesson exactly at 500 chars is preserved unchanged (boundary — no truncation)', () => {
		// 500 x's: the exact MAX_INPUT_TEXT_CHARS boundary — slice(0,500) returns same string
		const boundaryLesson = 'a'.repeat(500);
		const result = _internals.assembleLLMInput(
			'plan-1',
			'Plan summary',
			[
				{
					id: 'K001',
					lesson: boundaryLesson,
					applied: 0,
					violated: 0,
					ignored: 0,
					confidence: 0.5,
					status: 'active',
				},
			],
			null,
			[],
			[],
			[],
			[],
		);
		const knSectionStart = result.indexOf('KNOWLEDGE_ENTRIES:');
		const knSection = result.slice(knSectionStart);
		const lessonMatch = knSection.match(/"lesson":"(a+)"/);
		expect(lessonMatch).not.toBeNull();
		expect(lessonMatch![1].length).toBe(500);
	});

	test('lesson of 501 chars is truncated to exactly 500 (boundary + 1)', () => {
		// 501 x's → slice(0,500) keeps only first 500
		const longLesson = 'b'.repeat(501);
		const result = _internals.assembleLLMInput(
			'plan-1',
			'Plan summary',
			[
				{
					id: 'K001',
					lesson: longLesson,
					applied: 0,
					violated: 0,
					ignored: 0,
					confidence: 0.5,
					status: 'active',
				},
			],
			null,
			[],
			[],
			[],
			[],
		);
		const knSectionStart = result.indexOf('KNOWLEDGE_ENTRIES:');
		const knSection = result.slice(knSectionStart);
		const lessonMatch = knSection.match(/"lesson":"(b+)"/);
		expect(lessonMatch).not.toBeNull();
		expect(lessonMatch![1].length).toBe(500);
	});

	test('empty string lesson is preserved as empty string (edge case)', () => {
		// slice(0,500) on '' returns '', which serializes as "lesson":""
		const result = _internals.assembleLLMInput(
			'plan-1',
			'Plan summary',
			[
				{
					id: 'K001',
					lesson: '',
					applied: 0,
					violated: 0,
					ignored: 0,
					confidence: 0.5,
					status: 'active',
				},
			],
			null,
			[],
			[],
			[],
			[],
		);
		const knSectionStart = result.indexOf('KNOWLEDGE_ENTRIES:');
		const knSection = result.slice(knSectionStart);
		// Empty string lesson serializes as "" in JSON
		expect(knSection).toContain('"lesson":""');
	});
});

describe('FR-008 — isReportValid verifies report integrity', () => {
	test('returns false for a missing file', () => {
		expect(
			_internals.isReportValid(
				path.join(os.tmpdir(), 'nonexistent-report-md-' + randomUUID() + '.md'),
			),
		).toBe(false);
	});

	test('returns false for an empty file', () => {
		const dir = makeTempDir();
		const reportPath = path.join(dir, 'report.md');
		writeFileSync(reportPath, '');
		try {
			expect(_internals.isReportValid(reportPath)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('returns false for a whitespace-only file', () => {
		const dir = makeTempDir();
		const reportPath = path.join(dir, 'report.md');
		writeFileSync(reportPath, '   \n\n   \t  ');
		try {
			expect(_internals.isReportValid(reportPath)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('returns false for garbage content without the expected header', () => {
		const dir = makeTempDir();
		const reportPath = path.join(dir, 'report.md');
		writeFileSync(
			reportPath,
			'This is corrupted content with no header at all.',
		);
		try {
			expect(_internals.isReportValid(reportPath)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('returns false for unparseable/garbage content', () => {
		const dir = makeTempDir();
		const reportPath = path.join(dir, 'report.md');
		writeFileSync(reportPath, '\x00\x01\x02\xff binary garbage');
		try {
			expect(_internals.isReportValid(reportPath)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('returns true for a valid report starting with the expected header', () => {
		const dir = makeTempDir();
		const reportPath = path.join(dir, 'report.md');
		writeFileSync(
			reportPath,
			'# Post-Mortem Report: test-plan\nGenerated: 2024-01-01T00:00:00Z\n\nSome content.',
		);
		try {
			expect(_internals.isReportValid(reportPath)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('returns true for a valid report with leading whitespace trimmed', () => {
		const dir = makeTempDir();
		const reportPath = path.join(dir, 'report.md');
		writeFileSync(reportPath, '  \n# Post-Mortem Report: test\n');
		try {
			expect(_internals.isReportValid(reportPath)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('FR-008 — runCuratorPostMortem regenerates invalid reports', () => {
	test('regenerates when an empty file exists (overwrites)', async () => {
		const dir = makeTempDir();
		writePlan(dir);
		const reportPath = getExpectedReportPath(dir);

		// Pre-create an empty report file
		writeFileSync(reportPath, '');

		const result = await runCuratorPostMortem(dir);
		expect(result.success).toBe(true);
		expect(result.reportPath).toBe(reportPath);
		expect(existsSync(reportPath)).toBe(true);
		const content = readFileSync(reportPath, 'utf-8');
		expect(content.length).toBeGreaterThan(0);
		expect(content).toContain('Post-Mortem Report');

		rmSync(dir, { recursive: true, force: true });
	});

	test('regenerates when existing report is corrupted (no header)', async () => {
		const dir = makeTempDir();
		writePlan(dir);
		const reportPath = getExpectedReportPath(dir);

		// Pre-create a corrupted report
		writeFileSync(reportPath, 'corrupted content with no header');

		const result = await runCuratorPostMortem(dir);
		expect(result.success).toBe(true);
		expect(result.summary).not.toContain('already exists');
		const content = readFileSync(reportPath, 'utf-8');
		expect(content).toContain('Post-Mortem Report');

		rmSync(dir, { recursive: true, force: true });
	});

	test('skips regeneration when a valid report already exists (idempotent)', async () => {
		const dir = makeTempDir();
		writePlan(dir);
		const reportPath = getExpectedReportPath(dir);

		// First run creates the report
		const result1 = await runCuratorPostMortem(dir);
		expect(result1.success).toBe(true);

		// Get the mtime before the second run
		const stat1 = (await import('node:fs')).statSync(reportPath);

		// Second run should skip (idempotent)
		const result2 = await runCuratorPostMortem(dir);
		expect(result2.success).toBe(true);
		expect(result2.summary).toContain('already exists');
		expect(result2.reportPath).toBe(reportPath);

		// File should not have been rewritten (mtime unchanged)
		const stat2 = (await import('node:fs')).statSync(reportPath);
		expect(stat2.mtimeMs).toBe(stat1.mtimeMs);

		rmSync(dir, { recursive: true, force: true });
	});

	test('--force always regenerates even with valid existing report', async () => {
		const dir = makeTempDir();
		writePlan(dir);
		const reportPath = getExpectedReportPath(dir);

		// First run
		await runCuratorPostMortem(dir);

		// Force regeneration
		const result = await runCuratorPostMortem(dir, { force: true });
		expect(result.success).toBe(true);
		expect(result.summary).not.toContain('already exists');

		rmSync(dir, { recursive: true, force: true });
	});
});

describe('FR-010 — atomic report write', () => {
	test('report file exists and is non-empty after successful run', async () => {
		const dir = makeTempDir();
		writePlan(dir);
		const reportPath = getExpectedReportPath(dir);

		const result = await runCuratorPostMortem(dir);
		expect(result.success).toBe(true);
		expect(result.reportPath).not.toBeNull();
		expect(existsSync(reportPath)).toBe(true);
		const content = readFileSync(reportPath, 'utf-8');
		expect(content.length).toBeGreaterThan(0);

		rmSync(dir, { recursive: true, force: true });
	});

	test('no leftover .tmp. file at the report path after successful run', async () => {
		const dir = makeTempDir();
		writePlan(dir);
		const reportPath = getExpectedReportPath(dir);

		const result = await runCuratorPostMortem(dir);
		expect(result.success).toBe(true);

		// The report path itself should exist and be non-empty
		expect(existsSync(reportPath)).toBe(true);
		const content = readFileSync(reportPath, 'utf-8');
		expect(content.length).toBeGreaterThan(0);

		// No leftover temp file matching the .tmp. pattern in the .swarm dir
		const swarmDir = path.join(dir, '.swarm');
		const entries = existsSync(swarmDir) ? readdirSync(swarmDir) : [];
		const tmpFiles = entries.filter((f) =>
			f.startsWith(path.basename(reportPath) + '.tmp.'),
		);
		expect(tmpFiles.length).toBe(0);

		rmSync(dir, { recursive: true, force: true });
	});
});
