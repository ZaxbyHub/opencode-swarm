/**
 * PR #2347 review (FB-011 follow-up, Stage-B round 2): the reviewer-verdict
 * loop and the architect-delegation (`not_checked`) loop in
 * `skillPropagationTransformScan` both had the same `break`-on-first-failure
 * bug and both were fixed with the same pattern — attempt every skillPath
 * independently, debug-gate the per-path `warn`, and emit one ungated
 * `criticalWarn` summary line after the loop if any path failed.
 *
 * `skill-propagation-gate-enqueue-continue.test.ts` covers the
 * reviewer-verdict loop only. This file covers the delegation loop with the
 * same structure, PLUS two properties neither file previously covered:
 *
 * 1. Log-volume bound: N failed paths in one loop still produce exactly one
 *    `criticalWarn` call (not N), and `warn` is debug-gated (silent when
 *    `OPENCODE_SWARM_DEBUG` is unset).
 * 2. Cross-loop independence: the two loops used to share one
 *    `hadRecordingError` flag gating entry to the delegation scan
 *    (`if (hadRecordingError) return;`), so a reviewer-verdict failure
 *    silently dropped the ENTIRE delegation loop too. That guard is now
 *    removed — each loop has its own local failure counter, and a failure
 *    in one loop no longer collateral-damages the other's independent
 *    successes.
 *
 * Uses the `_internals` DI seam (never `mock.module`), restored in
 * `afterEach`. `warn`/`criticalWarn` are not exposed on `_internals` in this
 * module (they're module-level bindings imported directly from
 * `../utils/logger.js`, so overriding `logger.js`'s own `_internals` would
 * not affect calls made here) — intercepted instead with
 * `spyOn(console, 'warn')`, the pattern already used elsewhere in this test
 * directory (e.g. `tests/unit/hooks/delegation-tracker.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';

import {
	_internals,
	skillPropagationTransformScan,
} from '../../../src/hooks/skill-propagation-gate.js';
import type { SkillUsageEntry } from '../../../src/hooks/skill-usage-log.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SKILL_A = 'file:.claude/skills/skill-a/SKILL.md';
const SKILL_B = 'file:.claude/skills/skill-b/SKILL.md';
const SKILL_C = 'file:.claude/skills/skill-c/SKILL.md';

interface RecordedEntry {
	skillPath: string;
	agentName: string;
	taskID: string;
	complianceVerdict: string;
}

function architectDelegationMessage(sessionID: string, skillsList: string) {
	return {
		info: { role: 'assistant', agent: 'architect', sessionID },
		parts: [
			{
				type: 'text',
				text: `Delegating TO coder\nSKILLS: ${skillsList}\n`,
			},
		],
	};
}

function makeDelegationMessages(sessionID: string, skillsList: string) {
	return [
		architectDelegationMessage(sessionID, skillsList),
	] as unknown as Parameters<
		typeof skillPropagationTransformScan
	>[1]['messages'];
}

function reviewerVerdictMessage(sessionID: string, skillsList: string) {
	return {
		info: { role: 'assistant', agent: 'reviewer', sessionID },
		parts: [
			{
				type: 'text',
				text: `SKILLS_USED_BY_CODER: ${skillsList}\nSKILL_COMPLIANCE: COMPLIANT — all followed`,
			},
		],
	};
}

describe('skillPropagationTransformScan — delegation loop failure isolation (PR #2347 FB-011 follow-up)', () => {
	let tmp: string;
	const originals = {
		parseSkillPaths: _internals.parseSkillPaths,
		validateSkillReference: _internals.validateSkillReference,
		readSkillUsageEntriesTail: _internals.readSkillUsageEntriesTail,
		appendSkillUsageEntry: _internals.appendSkillUsageEntry,
	};
	const originalDebugEnv = process.env.OPENCODE_SWARM_DEBUG;

	beforeEach(() => {
		tmp = canonicalMkdtemp('spg-delegation-continue-');
		_internals.parseSkillPaths = (v: string) =>
			v
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
		_internals.validateSkillReference = (_directory, reference) => ({
			valid: true,
			reason: null,
			skillPath: reference.replace(/^file:/, ''),
		});
		_internals.readSkillUsageEntriesTail = () => [];
		delete process.env.OPENCODE_SWARM_DEBUG;
	});

	afterEach(() => {
		_internals.parseSkillPaths = originals.parseSkillPaths;
		_internals.validateSkillReference = originals.validateSkillReference;
		_internals.readSkillUsageEntriesTail = originals.readSkillUsageEntriesTail;
		_internals.appendSkillUsageEntry = originals.appendSkillUsageEntry;
		if (originalDebugEnv === undefined) {
			delete process.env.OPENCODE_SWARM_DEBUG;
		} else {
			process.env.OPENCODE_SWARM_DEBUG = originalDebugEnv;
		}
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('control: with no injected failure all three delegation skill paths are recorded', async () => {
		const recorded: RecordedEntry[] = [];
		_internals.appendSkillUsageEntry = (
			_directory: string,
			entry: Omit<SkillUsageEntry, 'id'>,
		) => {
			recorded.push({
				skillPath: entry.skillPath as string,
				agentName: entry.agentName as string,
				taskID: entry.taskID as string,
				complianceVerdict: entry.complianceVerdict as string,
			});
		};

		await skillPropagationTransformScan(
			tmp,
			{
				messages: makeDelegationMessages(
					'sess-deleg-control',
					`${SKILL_A},${SKILL_B},${SKILL_C}`,
				),
			},
			'sess-deleg-control',
		);

		expect(recorded).toHaveLength(3);
		expect(recorded.map((r) => r.skillPath).sort()).toEqual(
			[
				'.claude/skills/skill-a/SKILL.md',
				'.claude/skills/skill-b/SKILL.md',
				'.claude/skills/skill-c/SKILL.md',
			].sort(),
		);
		expect(recorded.every((r) => r.complianceVerdict === 'not_checked')).toBe(
			true,
		);
	});

	test('middle skill path enqueue fails, first AND last are still recorded (continue, not break)', async () => {
		const recorded: RecordedEntry[] = [];
		let callCount = 0;
		_internals.appendSkillUsageEntry = (
			_directory: string,
			entry: Omit<SkillUsageEntry, 'id'>,
		) => {
			callCount += 1;
			if (callCount === 2) {
				throw new Error('simulated enqueue failure (lock contention)');
			}
			recorded.push({
				skillPath: entry.skillPath as string,
				agentName: entry.agentName as string,
				taskID: entry.taskID as string,
				complianceVerdict: entry.complianceVerdict as string,
			});
		};

		await skillPropagationTransformScan(
			tmp,
			{
				messages: makeDelegationMessages(
					'sess-deleg-partial',
					`${SKILL_A},${SKILL_B},${SKILL_C}`,
				),
			},
			'sess-deleg-partial',
		);

		// All three paths were attempted (the failure in the middle did not
		// short-circuit the remainder of the loop).
		expect(callCount).toBe(3);

		// Un-fixed (`break` on first failure): loop would stop dead after path
		// A succeeds and path B throws — path C is never attempted, callCount
		// stays 2, recorded stays [A].
		// Fixed (`continue`): path B's failure is isolated; A and C both land.
		expect(recorded).toHaveLength(2);
		expect(recorded.map((r) => r.skillPath).sort()).toEqual(
			[
				'.claude/skills/skill-a/SKILL.md',
				'.claude/skills/skill-c/SKILL.md',
			].sort(),
		);
	});

	test('log volume: three failing paths in one delegation loop produce exactly ONE criticalWarn summary, not three', async () => {
		const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			_internals.appendSkillUsageEntry = () => {
				throw new Error('simulated enqueue failure (lock contention)');
			};

			await skillPropagationTransformScan(
				tmp,
				{
					messages: makeDelegationMessages(
						'sess-deleg-logvol',
						`${SKILL_A},${SKILL_B},${SKILL_C}`,
					),
				},
				'sess-deleg-logvol',
			);

			const criticalCalls = warnSpy.mock.calls.filter((args) =>
				String(args[0]).includes('CRITICAL-WARN'),
			);
			// Un-fixed / naively-fixed regression: emitting one criticalWarn per
			// failed path instead of one summary line would push this to 3,
			// re-introducing unbounded per-path log volume the production fix
			// was explicitly written to avoid.
			expect(criticalCalls).toHaveLength(1);
			expect(String(criticalCalls[0]?.[0])).toContain(
				'3 of 3 delegation skill path(s) failed recording',
			);

			// `warn` (per-path detail) is debug-gated: with
			// OPENCODE_SWARM_DEBUG unset, zero non-critical WARN lines should
			// have been emitted even though three paths failed individually.
			const nonCriticalWarnCalls = warnSpy.mock.calls.filter(
				(args) =>
					String(args[0]).includes(' WARN: ') &&
					!String(args[0]).includes('CRITICAL-WARN'),
			);
			expect(nonCriticalWarnCalls).toHaveLength(0);
		} finally {
			warnSpy.mockRestore();
		}
	});

	test('log volume with debug enabled: per-path warn fires once per failure, criticalWarn summary still fires exactly once', async () => {
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			_internals.appendSkillUsageEntry = () => {
				throw new Error('simulated enqueue failure (lock contention)');
			};

			await skillPropagationTransformScan(
				tmp,
				{
					messages: makeDelegationMessages(
						'sess-deleg-logvol-debug',
						`${SKILL_A},${SKILL_B},${SKILL_C}`,
					),
				},
				'sess-deleg-logvol-debug',
			);

			const criticalCalls = warnSpy.mock.calls.filter((args) =>
				String(args[0]).includes('CRITICAL-WARN'),
			);
			expect(criticalCalls).toHaveLength(1);

			const perPathWarnCalls = warnSpy.mock.calls.filter(
				(args) =>
					String(args[0]).includes(' WARN: ') &&
					!String(args[0]).includes('CRITICAL-WARN'),
			);
			// One `warn` per failed path (three paths, three failures).
			expect(perPathWarnCalls).toHaveLength(3);
		} finally {
			warnSpy.mockRestore();
		}
	});

	test('CROSS-LOOP INDEPENDENCE: a reviewer-verdict recording failure does NOT prevent an unrelated architect-message delegation from being recorded', async () => {
		let callCount = 0;
		const recorded: RecordedEntry[] = [];
		_internals.appendSkillUsageEntry = (
			_directory: string,
			entry: Omit<SkillUsageEntry, 'id'>,
		) => {
			callCount += 1;
			// Fail only the reviewer-verdict path (call #1). The delegation
			// path succeeds unconditionally.
			if (callCount === 1) {
				throw new Error('simulated enqueue failure (lock contention)');
			}
			recorded.push({
				skillPath: entry.skillPath as string,
				agentName: entry.agentName as string,
				taskID: entry.taskID as string,
				complianceVerdict: entry.complianceVerdict as string,
			});
		};

		const sessionID = 'sess-cross-loop';
		const messages = [
			architectDelegationMessage(sessionID, SKILL_B),
			reviewerVerdictMessage(sessionID, SKILL_A),
		] as unknown as Parameters<
			typeof skillPropagationTransformScan
		>[1]['messages'];

		await skillPropagationTransformScan(tmp, { messages }, sessionID);

		// The reviewer-verdict loop attempted its one path (and failed), THEN
		// the delegation loop still ran and attempted skill-b's path too.
		expect(callCount).toBe(2);

		// PR #2347 Stage-B review, round 2: the two loops used to share one
		// `hadRecordingError` flag gating entry to the delegation scan
		// (`if (hadRecordingError) return;`), so a reviewer-verdict failure
		// silently discarded the ENTIRE delegation loop too — even for an
		// unrelated architect message whose own enqueue call would have
		// succeeded. That guard is now removed: each loop is independent, so
		// skill-b's genuinely-successful recording is not collateral damage
		// from skill-a's unrelated lock contention.
		expect(recorded).toHaveLength(1);
		// Recorded entries are canonicalized (the `file:` prefix is stripped at
		// write time), unlike the raw `SKILL_B` fixture constant.
		expect(recorded[0]?.skillPath).toBe('.claude/skills/skill-b/SKILL.md');
		expect(recorded[0]?.complianceVerdict).toBe('not_checked');
	});
});
