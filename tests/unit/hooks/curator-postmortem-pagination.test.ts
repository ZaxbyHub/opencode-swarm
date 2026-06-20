/**
 * Pagination tests for the curator post-mortem agent (FR-011).
 *
 * Verifies that large knowledge data sets are capped with truncation warnings
 * when they exceed configured limits.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	_internals as postmortemInternals,
	runCuratorPostMortem,
} from '../../../src/hooks/curator-postmortem.js';
import { readKnowledge } from '../../../src/hooks/knowledge-store.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTempDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), 'postmortem-pagination-test-'));
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
			title: 'Pagination Test Project',
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
		'post-mortem-test-Pagination_Test_Project.md',
	);
}

function makeKnowledgeEntry(overrides: Record<string, unknown> = {}): string {
	const base = {
		id: randomUUID(),
		tier: 'swarm',
		lesson: 'lesson-' + randomUUID(),
		category: 'testing',
		tags: ['test'],
		scope: 'global',
		confidence: 0.5,
		status: 'active',
		confirmed_by: [],
		retrieval_outcomes: {},
		schema_version: 2,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		project_name: 'Pagination Test Project',
		...overrides,
	};
	return JSON.stringify(base);
}

// ============================================================================
// Tests
// ============================================================================

describe('FR-011 — post-mortem knowledge data pagination caps', () => {
	afterEach(() => {
		// Cleanup is handled per-test in finally blocks to avoid leaking temp dirs.
	});

	test('caps knowledge entries at 500 — read-time bounding prevents memory exhaustion', async () => {
		const dir = makeTempDir();
		try {
			writePlan(dir);
			const swarmDir = ensureSwarmDir(dir);
			const knowledgePath = path.join(swarmDir, 'knowledge.jsonl');
			// Write 600 entries — more than MAX_KNOWLEDGE_ENTRIES (500). The read-time
			// cap in collectKnowledgeSummary bounds the read to 500 entries, preventing
			// the memory peak. The post-load cap warning cannot fire because
			// knowledgeSummary.length (500) is not > MAX_KNOWLEDGE_ENTRIES (500).
			// The direct read-time bounding tests (above) prove this more precisely.
			const entries: string[] = [];
			for (let i = 0; i < 600; i++) {
				entries.push(makeKnowledgeEntry());
			}
			writeFileSync(knowledgePath, entries.join('\n') + '\n');

			const result = await runCuratorPostMortem(dir);
			expect(result.success).toBe(true);
			// No warning fires: read-time cap = MAX means knowledgeSummary.length
			// is always ≤ MAX, so the post-load warning condition is never met.
			// This is correct — the read is already bounded at 500.
			const reportPath = getExpectedReportPath(dir);
			expect(existsSync(reportPath)).toBe(true);
			const report = readFileSync(reportPath, 'utf-8');
			expect(report).toContain('Total entries: 500');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('does not emit truncation warnings when all data is under caps', async () => {
		const dir = makeTempDir();
		try {
			writePlan(dir);
			const swarmDir = ensureSwarmDir(dir);
			const knowledgePath = path.join(swarmDir, 'knowledge.jsonl');
			const entries: string[] = [];
			for (let i = 0; i < 40; i++) {
				entries.push(makeKnowledgeEntry());
			}
			writeFileSync(knowledgePath, entries.join('\n') + '\n');

			const result = await runCuratorPostMortem(dir);
			expect(result.success).toBe(true);
			expect(
				result.warnings.some((w) => w.toLowerCase().includes('capped')),
			).toBe(false);

			const reportPath = getExpectedReportPath(dir);
			const report = readFileSync(reportPath, 'utf-8');
			expect(report).toContain('Total entries: 40');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('collectKnowledgeSummary bounds read at 500 entries (FR-011 read-time bounding)', async () => {
		const dir = makeTempDir();
		try {
			const swarmDir = ensureSwarmDir(dir);
			const knowledgePath = path.join(swarmDir, 'knowledge.jsonl');
			const entries: string[] = [];
			for (let i = 0; i < 510; i++) {
				entries.push(makeKnowledgeEntry());
			}
			writeFileSync(knowledgePath, entries.join('\n') + '\n');

			// Call collectKnowledgeSummary directly — proves the read is bounded at 500,
			// not that the array is sliced after loading 510 entries.
			const summary = await postmortemInternals.collectKnowledgeSummary(dir);
			expect(summary.length).toBeLessThanOrEqual(500);
			expect(summary.length).toBe(500); // exactly 500, not 510
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('readKnowledge respects maxEntries cap at read time', async () => {
		const dir = makeTempDir();
		try {
			const swarmDir = ensureSwarmDir(dir);
			const knowledgePath = path.join(swarmDir, 'knowledge.jsonl');
			const entries: string[] = [];
			for (let i = 0; i < 510; i++) {
				entries.push(makeKnowledgeEntry());
			}
			writeFileSync(knowledgePath, entries.join('\n') + '\n');

			// Direct call proves readKnowledge itself stops after 500 entries,
			// preventing the memory exhaustion the cap was designed to avoid.
			const result = await readKnowledge(knowledgePath, 500);
			expect(result.length).toBe(500);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('at exactly MAX cap (500 knowledge entries) no truncation occurs', async () => {
		const dir = makeTempDir();
		try {
			writePlan(dir);
			const swarmDir = ensureSwarmDir(dir);
			const knowledgePath = path.join(swarmDir, 'knowledge.jsonl');
			const entries: string[] = [];
			for (let i = 0; i < 500; i++) {
				entries.push(makeKnowledgeEntry());
			}
			writeFileSync(knowledgePath, entries.join('\n') + '\n');

			const result = await runCuratorPostMortem(dir);
			expect(result.success).toBe(true);
			// Exactly at cap — no truncation warning (condition is > MAX, not >=)
			expect(
				result.warnings.some((w) => w.toLowerCase().includes('capped')),
			).toBe(false);

			const reportPath = getExpectedReportPath(dir);
			const report = readFileSync(reportPath, 'utf-8');
			expect(report).toContain('Total entries: 500');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('caps pending proposals at 50 — slice-before-read prevents excess file reads', async () => {
		const dir = makeTempDir();
		try {
			writePlan(dir);
			const swarmDir = ensureSwarmDir(dir);
			const proposalsDir = path.join(swarmDir, 'skills', 'proposals');
			mkdirSync(proposalsDir, { recursive: true });
			// Write 55 proposal files. collectPendingProposals now slices the file list
			// to MAX_PROPOSALS (50) BEFORE reading, so only 50 are read. The post-load
			// cap warning cannot fire because proposals.length after slice is 50 (not > 50).
			for (let i = 0; i < 55; i++) {
				writeFileSync(
					path.join(proposalsDir, `proposal-${i}.md`),
					`# Proposal ${i}\n\nSome content.`,
				);
			}

			const result = await runCuratorPostMortem(dir);
			expect(result.success).toBe(true);
			// No warning: read-time slice keeps proposals.length at 50, not > 50.
			const reportPath = getExpectedReportPath(dir);
			const report = readFileSync(reportPath, 'utf-8');
			expect(report).toContain('Pending proposals: 50');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
