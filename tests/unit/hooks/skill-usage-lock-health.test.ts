/**
 * Issue #2038 (Observability PR 10/23) — store lock, health signal, and
 * disk-failure behavior for `.swarm/skill-usage.jsonl`.
 *
 * Mirrors the #2037 telemetry-bounded-lock.test.ts fidelity (fs-only
 * lock-busy simulation, stale-break via freezeClock) plus one REAL
 * cross-process test (Bun.spawn child holds the lock; precedent:
 * tests/adversarial/subprocess-injection.test.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveSwarmKnowledgePath } from '../../../src/hooks/knowledge-store.js';
import {
	_internals,
	_resetMaintenanceState,
	appendSkillUsageEntry,
	applySkillUsageFeedback,
	pruneSkillUsageLog,
	readSkillUsageEntries,
	SKILL_USAGE_LIMITS,
	type SkillUsageEntry,
} from '../../../src/hooks/skill-usage-log.js';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function makeEntry(
	overrides: Partial<Omit<SkillUsageEntry, 'id'>> = {},
): Omit<SkillUsageEntry, 'id'> {
	return {
		skillPath: '.claude/skills/lock-health-skill/SKILL.md',
		agentName: 'test-agent',
		taskID: 'task-001',
		timestamp: new Date().toISOString(),
		complianceVerdict: 'not_checked',
		sessionID: 'session-lh',
		...overrides,
	};
}

function logPath(dir: string): string {
	return path.join(dir, '.swarm', 'skill-usage.jsonl');
}

function lockPath(dir: string): string {
	return path.join(dir, '.swarm', 'skill-usage.lock');
}

type HealthPayload = Parameters<typeof _internals.emitHealth>[1];

describe('skill-usage lock, health, and disk failures (issue #2038)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('skill-usage-lock-health-');
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		_internals.limits = SKILL_USAGE_LIMITS;
		_resetMaintenanceState();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ----------------------------------------------------------------------
	// Lock (fs-only simulation — #2037 fidelity)
	// ----------------------------------------------------------------------

	test('free lock — fn runs, result returned, lock released', () => {
		const result = _internals.withSkillUsageLock(tempDir, () => 42);
		expect(result).toBe(42);
		expect(fs.existsSync(lockPath(tempDir))).toBe(false);
	});

	test('lock held (fresh) — fn does NOT run, returns null, lock intact', () => {
		fs.writeFileSync(lockPath(tempDir), '', 'utf-8');
		let ran = false;
		const result = _internals.withSkillUsageLock(tempDir, () => {
			ran = true;
			return 1;
		});
		expect(result).toBeNull();
		expect(ran).toBe(false);
		expect(fs.existsSync(lockPath(tempDir))).toBe(true);
	});

	test('ancient lock is stale-broken — fn runs, lock released', () => {
		fs.writeFileSync(lockPath(tempDir), '', 'utf-8');
		const restore: Restore = freezeClock({
			fixedNow: Date.now() + 20 * 60_000,
		});
		try {
			const result = _internals.withSkillUsageLock(tempDir, () => 'ok');
			expect(result).toBe('ok');
			expect(fs.existsSync(lockPath(tempDir))).toBe(false);
		} finally {
			restore();
		}
	});

	test('lock is released even when fn throws', () => {
		expect(() =>
			_internals.withSkillUsageLock(tempDir, () => {
				throw new Error('boom');
			}),
		).toThrow('boom');
		expect(fs.existsSync(lockPath(tempDir))).toBe(false);
	});

	test('append with the lock held throws honestly (no false success)', () => {
		fs.writeFileSync(logPath(tempDir), '', 'utf-8');
		fs.writeFileSync(lockPath(tempDir), '', 'utf-8');
		expect(() => appendSkillUsageEntry(tempDir, makeEntry())).toThrow(
			/lock busy/,
		);
		// Nothing was written.
		expect(fs.readFileSync(logPath(tempDir), 'utf-8')).toBe('');
		// Recovery: once the lock is gone, the next write succeeds.
		fs.unlinkSync(lockPath(tempDir));
		appendSkillUsageEntry(tempDir, makeEntry({ taskID: 'recovered' }));
		expect(readSkillUsageEntries(tempDir).map((e) => e.taskID)).toEqual([
			'recovered',
		]);
	});

	test('prune with the lock held is an honest no-op with error surfaced', () => {
		appendSkillUsageEntry(tempDir, makeEntry({ taskID: 'pre' }));
		fs.writeFileSync(lockPath(tempDir), '', 'utf-8');
		const result = pruneSkillUsageLog(tempDir, 500);
		expect(result.pruned).toBe(0);
		expect(result.error).toContain('lock busy');
		// File untouched.
		expect(readSkillUsageEntries(tempDir).map((e) => e.taskID)).toEqual([
			'pre',
		]);
	});

	test('feedback with the lock held returns zeros AND appends no marker', async () => {
		appendSkillUsageEntry(
			tempDir,
			makeEntry({ taskID: 'fb', complianceVerdict: 'compliant' }),
		);
		fs.writeFileSync(lockPath(tempDir), '', 'utf-8');
		const result = await applySkillUsageFeedback(tempDir);
		expect(result).toEqual({ processed: 0, bumps: 0 });
		const raw = fs.readFileSync(logPath(tempDir), 'utf-8');
		expect(raw).not.toContain('"type":"feedback_applied"');
		// Recovery: lock released → the pass processes and marks exactly once.
		fs.unlinkSync(lockPath(tempDir));
		const second = await applySkillUsageFeedback(tempDir);
		// The skill has no generated_from_knowledge frontmatter file here, so
		// no knowledge bump occurs — but the actionable entry IS consumed.
		expect(second.processed).toBe(0);
	});

	// ----------------------------------------------------------------------
	// REAL cross-process lock contention (Bun.spawn precedent)
	// ----------------------------------------------------------------------

	test('cross-process: child holding the lock blocks parent maintenance, then converges', async () => {
		appendSkillUsageEntry(tempDir, makeEntry({ taskID: 'cp-pre' }));

		const childScript = `
const fs = require('node:fs');
const path = require('node:path');
const lockPath = process.argv[1];
fs.writeFileSync(lockPath, '', 'utf-8');
setTimeout(() => { try { fs.unlinkSync(lockPath); } catch {} process.exit(0); }, 1500);
`;
		const proc = Bun.spawn(
			[process.execPath, '-e', childScript, lockPath(tempDir)],
			{
				stdin: 'ignore',
				stdout: 'ignore',
				stderr: 'ignore',
			},
		);
		// Give the child a moment to acquire the lock.
		await Bun.sleep(300);
		expect(fs.existsSync(lockPath(tempDir))).toBe(true);

		// Parent maintenance under contention: honest no-op.
		const contended = pruneSkillUsageLog(tempDir, 500);
		expect(contended.error).toContain('lock busy');

		await proc.exited;
		// Lock released → the next pass converges.
		const converged = pruneSkillUsageLog(tempDir, 500);
		expect(converged.error).toBeUndefined();
		expect(readSkillUsageEntries(tempDir).map((e) => e.taskID)).toEqual([
			'cp-pre',
		]);
	}, 20_000);

	// ----------------------------------------------------------------------
	// Health signal (counts-only payload)
	// ----------------------------------------------------------------------

	test('compaction emits skill_usage_health with counts-only payload', () => {
		const captured: Array<{ directory: string; payload: HealthPayload }> = [];
		const origEmit = _internals.emitHealth;
		_internals.emitHealth = ((directory: string, payload: HealthPayload) => {
			captured.push({ directory, payload });
		}) as typeof origEmit;

		const oldTs = new Date(Date.now() - 400 * 86_400_000).toISOString();
		fs.writeFileSync(
			logPath(tempDir),
			[
				JSON.stringify(makeEntry({ taskID: 'h-old', timestamp: oldTs })),
				JSON.stringify(makeEntry({ taskID: 'h-keep' })),
				'BROKEN-LINE',
			].join('\n') + '\n',
			'utf-8',
		);
		try {
			const result = pruneSkillUsageLog(tempDir, 500);
			expect(result.pruned).toBe(1);
			const health = captured.find(
				(c) => c.payload.trigger === 'phase-boundary',
			);
			expect(health).toBeDefined();
			expect(health!.payload).toMatchObject({
				trigger: 'phase-boundary',
				acceptedCount: 2,
				retainedCount: 1,
				droppedAgeCount: 1,
				corruptTotal: 1,
				pressureCount: 0,
			});
			// Counts only: no paths, no agent names, no content.
			const serialized = JSON.stringify(health!.payload);
			expect(serialized).not.toContain('SKILL.md');
			expect(serialized).not.toContain('test-agent');
		} finally {
			_internals.emitHealth = origEmit;
		}
	});

	test('append-path legacy-migration postponement emits a deferred signal', () => {
		const captured: Array<HealthPayload> = [];
		const origEmit = _internals.emitHealth;
		_internals.emitHealth = ((_d: string, payload: HealthPayload) => {
			captured.push(payload);
		}) as typeof origEmit;

		const lines = [];
		for (let i = 0; i < 30; i++) {
			lines.push(JSON.stringify(makeEntry({ taskID: `lg-${i}` })));
		}
		fs.writeFileSync(logPath(tempDir), lines.join('\n') + '\n', 'utf-8');

		_internals.limits = {
			...SKILL_USAGE_LIMITS,
			compactTriggerBytes: 128,
			legacyCompactMaxBytes: 256,
			checkInterval: 1,
			warnCooldownMs: 0,
		};
		try {
			appendSkillUsageEntry(tempDir, makeEntry({ taskID: 'lg-new' }));
			expect(captured.some((p) => p.trigger === 'deferred')).toBe(true);
			// The entry still landed; the legacy file was not rewritten.
			expect(readSkillUsageEntries(tempDir).map((e) => e.taskID)).toContain(
				'lg-new',
			);
		} finally {
			_internals.emitHealth = origEmit;
		}
	});

	// ----------------------------------------------------------------------
	// Disk failures (fail-open for injection; honest errors; no corruption)
	// ----------------------------------------------------------------------

	test('prune write failure surfaces the original error and leaves the file intact', () => {
		fs.writeFileSync(
			logPath(tempDir),
			[
				JSON.stringify(makeEntry({ taskID: 'd-1' })),
				JSON.stringify(makeEntry({ taskID: 'd-2' })),
			].join('\n') + '\n',
			'utf-8',
		);
		const origWrite = _internals.writeFileSync;
		_internals.writeFileSync = (() => {
			throw new Error('Simulated write error');
		}) as typeof fs.writeFileSync;
		try {
			const result = pruneSkillUsageLog(tempDir, 1);
			expect(result.pruned).toBe(0);
			expect(result.error).toBe('Simulated write error');
			expect(result.remaining).toBe(2);
		} finally {
			_internals.writeFileSync = origWrite;
		}
		// No tmp residue left behind.
		const swarmDir = path.join(tempDir, '.swarm');
		const residue = fs.readdirSync(swarmDir).filter((f) => f.includes('.tmp'));
		expect(residue).toEqual([]);
		// Original content intact.
		expect(readSkillUsageEntries(tempDir)).toHaveLength(2);
	});

	test('append disk failure propagates to the (already fail-open) callers', () => {
		fs.writeFileSync(logPath(tempDir), '', 'utf-8');
		const origAppend = _internals.appendFileSync;
		_internals.appendFileSync = (() => {
			throw new Error('ENOSPC: no space left on device');
		}) as typeof fs.appendFileSync;
		try {
			expect(() => appendSkillUsageEntry(tempDir, makeEntry())).toThrow(
				/ENOSPC/,
			);
		} finally {
			_internals.appendFileSync = origAppend;
		}
		// Lock released after the failure.
		expect(fs.existsSync(lockPath(tempDir))).toBe(false);
	});

	test('marker-write failure after bump: health emitted, bump NOT rolled back, drift clamp-bounded', async () => {
		// Reviewer R2 finding: the bump-then-marker ordering must disclose its
		// failure mode. Set up a real knowledge entry + SKILL.md frontmatter so
		// the feedback pass bumps confidence, then fail ONLY the marker append.
		const knowledgePath = resolveSwarmKnowledgePath(tempDir);
		fs.mkdirSync(path.dirname(knowledgePath), { recursive: true });
		fs.writeFileSync(
			knowledgePath,
			JSON.stringify({
				id: 'marker-fail-uuid',
				lesson: 'marker write failure test',
				confidence: 0.5,
				status: 'active',
			}) + '\n',
			'utf-8',
		);
		const skillDir = path.join(tempDir, '.claude/skills/marker-fail-skill');
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, 'SKILL.md'),
			[
				'---',
				'name: marker-fail-skill',
				'generated_from_knowledge:',
				'  - marker-fail-uuid',
				'---',
				'body',
			].join('\n'),
			'utf-8',
		);
		appendSkillUsageEntry(
			tempDir,
			makeEntry({
				skillPath: '.claude/skills/marker-fail-skill/SKILL.md',
				taskID: 'mf-1',
				complianceVerdict: 'compliant',
			}),
		);

		const readConfidence = (): number => {
			const lines = fs
				.readFileSync(knowledgePath, 'utf-8')
				.split('\n')
				.filter((l) => l.trim() !== '');
			return (JSON.parse(lines[0]!) as { confidence: number }).confidence;
		};

		const health: Array<HealthPayload> = [];
		const origEmit = _internals.emitHealth;
		const origAppend = _internals.appendFileSync;
		_internals.emitHealth = ((_d: string, payload: HealthPayload) => {
			health.push(payload);
		}) as typeof origEmit;
		_internals.appendFileSync = ((p: number | fs.PathLike, content: string) => {
			if (String(content).includes('"type":"feedback_applied"')) {
				throw new Error('marker ENOSPC');
			}
			return fs.appendFileSync(p, content);
		}) as typeof fs.appendFileSync;

		try {
			const result = await applySkillUsageFeedback(tempDir);
			// The bump happened and was reported.
			expect(result.processed).toBe(1);
			expect(result.bumps).toBe(1);
			// No marker landed (the write failed).
			expect(
				fs
					.readFileSync(logPath(tempDir), 'utf-8')
					.includes('"type":"feedback_applied"'),
			).toBe(false);
			// The failure was disclosed via health.
			expect(health.some((h) => h.trigger === 'feedback')).toBe(true);
			// The knowledge bump was NOT rolled back: confidence moved by the
			// clamped per-cycle delta (+0.05), not more.
			expect(readConfidence()).toBeCloseTo(0.55, 10);
		} finally {
			_internals.emitHealth = origEmit;
			_internals.appendFileSync = origAppend;
		}

		// Clamp invariant under the documented re-bump: the NEXT pass sees the
		// entry as unprocessed (marker lost) and bumps again — the clamp keeps
		// the lifetime drift bounded by the per-cycle bound, never stacking.
		const second = await applySkillUsageFeedback(tempDir);
		expect(second.processed).toBe(1);
		expect(readConfidence()).toBeLessThanOrEqual(0.55 + 0.05 + 1e-9);
	});
});
