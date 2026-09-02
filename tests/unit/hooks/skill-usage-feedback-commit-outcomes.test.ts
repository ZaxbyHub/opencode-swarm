/**
 * Tests for `commitFeedbackOutcomes` (issue #2038 PR review, FB-008).
 *
 * `commitFeedbackOutcomes` had zero test references anywhere: the chain
 * `failed:true -> retainWithRetry -> bump_retry -> bump_unrecoverable` was
 * never driven end-to-end through the real consumption path
 * (`applySkillUsageFeedback`) — only `retainWithRetry` in isolation was
 * unit-tested. These tests drive the public entry point with
 * `bumpKnowledgeConfidenceBatchResult` stubbed via the `_internals` DI seam
 * (no `mock.module` — see skill-usage-pending.ts's DI-seam doc comment for
 * why this codebase avoids it).
 *
 * Also covers FB-005: a record that vanishes between claim (Phase A) and
 * commit (Phase C) on a LOSS-bearing branch (retry, applied===0, no source
 * knowledge) is now counted via `bump_unrecoverable` instead of being
 * silently swallowed by a no-op `retainWithRetry` / `dequeueRecords` call.
 * The success branch (`applied > 0`) is deliberately excluded — the delta
 * already landed, so a vanish there loses nothing and must NOT inflate the
 * permanent-loss counter (Stage-B review correction).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BumpKnowledgeConfidenceResult } from '../../../src/hooks/knowledge-store.js';
import { resolveSwarmKnowledgePath } from '../../../src/hooks/knowledge-store.js';
import {
	appendSkillUsageEntry,
	applySkillUsageFeedback,
	_internals as sul_internals,
} from '../../../src/hooks/skill-usage-log.js';
import {
	loadPendingDocument,
	SKILL_USAGE_LIMITS,
	savePendingDocument,
} from '../../../src/hooks/skill-usage-pending.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// =============================================================================
// Helpers
// =============================================================================

function makeTempDir(): string {
	return canonicalMkdtemp('skill-usage-commit-outcomes-test-');
}

function writeSwarmKnowledge(
	dir: string,
	entries: Array<{ id: string; lesson: string; confidence: number }>,
): void {
	const resolved = resolveSwarmKnowledgePath(dir);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
	fs.writeFileSync(resolved, content, 'utf-8');
}

/** Create a real SKILL.md file with generated_from_knowledge UUIDs. */
function writeSkillFile(dir: string, skillRelPath: string, uuids: string[]) {
	const fullPath = path.join(dir, skillRelPath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	const uuidLines = uuids.map((u) => `  - ${u}`).join('\n');
	fs.writeFileSync(
		fullPath,
		`---
name: ${path.basename(path.dirname(fullPath))}
generated_from_knowledge:
${uuidLines}
---

Content
`,
		'utf-8',
	);
}

const SKILL_REL_PATH = '.claude/skills/retry-skill/SKILL.md';
const SOURCE_UUID = 'source-uuid-retry';

function setUpOneCompliantRecord(tempDir: string): void {
	writeSwarmKnowledge(tempDir, [
		{ id: SOURCE_UUID, lesson: 'retry test entry', confidence: 0.5 },
	]);
	writeSkillFile(tempDir, SKILL_REL_PATH, [SOURCE_UUID]);
	appendSkillUsageEntry(tempDir, {
		skillPath: SKILL_REL_PATH,
		agentName: 'test-agent',
		taskID: 'task-001',
		timestamp: '2026-01-01T00:01:00.000Z',
		complianceVerdict: 'compliant',
		sessionID: 'session-abc',
	});
}

// =============================================================================
// Tests
// =============================================================================

describe('commitFeedbackOutcomes (via applySkillUsageFeedback)', () => {
	let tempDir: string;
	const originalBump = sul_internals.bumpKnowledgeConfidenceBatchResult;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		sul_internals.bumpKnowledgeConfidenceBatchResult = originalBump;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('failed:true bump → record retried, not lost, not committed', async () => {
		setUpOneCompliantRecord(tempDir);

		sul_internals.bumpKnowledgeConfidenceBatchResult =
			async (): Promise<BumpKnowledgeConfidenceResult> => ({
				applied: 0,
				failed: true,
			});

		await applySkillUsageFeedback(tempDir);

		const { doc } = loadPendingDocument(tempDir);
		expect(doc.records).toHaveLength(1);
		expect(doc.records[0]!.state).toBe('pending');
		expect(doc.records[0]!.attempts).toBe(1);
		expect(doc.counters.bump_retry).toBe(1);
		expect(doc.counters.bump_unrecoverable).toBe(0);

		// Knowledge confidence was never touched — the delta genuinely failed.
		const swarmPath = resolveSwarmKnowledgePath(tempDir);
		const raw = fs.readFileSync(swarmPath, 'utf-8');
		expect(JSON.parse(raw.trim())!.confidence).toBe(0.5);
	});

	test('maxAttempts consecutive failed:true cycles → terminal bump_unrecoverable, counted not silently retained', async () => {
		setUpOneCompliantRecord(tempDir);

		sul_internals.bumpKnowledgeConfidenceBatchResult =
			async (): Promise<BumpKnowledgeConfidenceResult> => ({
				applied: 0,
				failed: true,
			});

		// Sequential by necessity: each cycle must observe the previous cycle's
		// persisted attempts count before the next claim.
		for (let i = 0; i < SKILL_USAGE_LIMITS.maxAttempts; i++) {
			await applySkillUsageFeedback(tempDir);
		}

		const { doc } = loadPendingDocument(tempDir);
		expect(doc.records).toHaveLength(0); // gone terminal, not retained forever
		expect(doc.counters.bump_retry).toBe(SKILL_USAGE_LIMITS.maxAttempts - 1);
		expect(doc.counters.bump_unrecoverable).toBe(1);

		// One more cycle is a true no-op: nothing left to claim.
		const after = await applySkillUsageFeedback(tempDir);
		expect(after).toEqual({ processed: 0, bumps: 0 });
	});

	test('FB-005: record vanishes between claim and commit → counted via bump_unrecoverable, not silently swallowed', async () => {
		setUpOneCompliantRecord(tempDir);

		// Simulate a concurrent writer (e.g. quarantine collapsing the whole
		// document) removing the claimed record during the window between the
		// Phase A lock release and the Phase C lock re-acquire — exactly the
		// window `bumpKnowledgeConfidenceBatchResult` runs in.
		sul_internals.bumpKnowledgeConfidenceBatchResult =
			async (): Promise<BumpKnowledgeConfidenceResult> => {
				const { doc } = loadPendingDocument(tempDir);
				doc.records = doc.records.filter(
					(record) => record.skillPath !== SKILL_REL_PATH,
				);
				savePendingDocument(tempDir, doc);
				return { applied: 0, failed: true };
			};

		await applySkillUsageFeedback(tempDir);

		const { doc } = loadPendingDocument(tempDir);
		expect(doc.records).toHaveLength(0); // genuinely gone, not resurrected
		expect(doc.counters.bump_retry).toBe(0); // nothing left to retry — no id matched
		expect(doc.counters.bump_unrecoverable).toBe(1); // FIX 1: the mismatch is counted
	});

	test('success branch: record vanishes AFTER a successful bump → dequeueRecords touches 0, but NOTHING was lost so bump_unrecoverable stays 0', async () => {
		setUpOneCompliantRecord(tempDir);

		// The delta genuinely applied (bump succeeded), but a concurrent writer
		// removed the claimed record from the pending doc before Phase C's
		// `dequeueRecords(doc, commit.deltaBearingIds)` could run — the success
		// path's own dequeue call now touches 0 of the 1 id it expected.
		sul_internals.bumpKnowledgeConfidenceBatchResult =
			async (): Promise<BumpKnowledgeConfidenceResult> => {
				const { doc } = loadPendingDocument(tempDir);
				doc.records = doc.records.filter(
					(record) => record.skillPath !== SKILL_REL_PATH,
				);
				savePendingDocument(tempDir, doc);
				return { applied: 1, failed: false };
			};

		await applySkillUsageFeedback(tempDir);

		const { doc } = loadPendingDocument(tempDir);
		expect(doc.records).toHaveLength(0); // genuinely gone, not resurrected
		// Stage-B review (PR #2347): the confidence delta already landed before
		// this dequeue ran, so the vanish loses nothing new. `bump_unrecoverable`
		// is documented and consumed as "this record's feedback is permanently
		// lost" — incrementing it here, where nothing was lost, would make the
		// health telemetry over-report genuine permanent loss. This branch does
		// NOT call the accounting-mismatch helper; only the loss-bearing
		// branches (failed:true retry, applied===0, no-source-knowledge) do.
		expect(doc.counters.bump_unrecoverable).toBe(0);
	});
});
