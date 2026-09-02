/**
 * PR #2347 review (FB-011): `skillPropagationTransformScan`'s per-skill-path
 * recording loop used to `break` on the first `appendSkillUsageEntry`
 * failure, silently discarding the verdict for every REMAINING skill path in
 * the same reviewer message — one transient enqueue failure (lock
 * contention) dropped a whole batch. The fix `continue`s instead, bounding
 * the loss to the path that actually failed.
 *
 * No existing suite (`skill-propagation-gate.test.ts`,
 * `.adversarial.test.ts`) ever injects a throwing `appendSkillUsageEntry`
 * mock, so the break-vs-continue branch had zero coverage. This file fills
 * that gap.
 *
 * Uses the `_internals` DI seam (never `mock.module`), restored in
 * `afterEach`. `parseSkillPaths` / `validateSkillReference` are stubbed
 * directly here (this file has no shared top-level `beforeEach`, unlike
 * `skill-propagation-gate.test.ts`) so `SKILLS_USED_BY_CODER` resolves to
 * both fixture skill paths deterministically.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';

import {
	_internals,
	skillPropagationTransformScan,
} from '../../../src/hooks/skill-propagation-gate.js';
import type { SkillUsageEntry } from '../../../src/hooks/skill-usage-log.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SKILL_A = 'file:.claude/skills/skill-a/SKILL.md';
const SKILL_B = 'file:.claude/skills/skill-b/SKILL.md';

interface RecordedEntry {
	skillPath: string;
	agentName: string;
	taskID: string;
	complianceVerdict: string;
}

function makeMessages(sessionID: string) {
	return [
		{
			info: { role: 'assistant', agent: 'reviewer', sessionID },
			parts: [
				{
					type: 'text',
					text: `SKILLS_USED_BY_CODER: ${SKILL_A},${SKILL_B}\nSKILL_COMPLIANCE: COMPLIANT — both followed`,
				},
			],
		},
	] as unknown as Parameters<
		typeof skillPropagationTransformScan
	>[1]['messages'];
}

describe('skillPropagationTransformScan — enqueue failure isolation (PR #2347 FB-011)', () => {
	let tmp: string;
	const originals = {
		parseSkillPaths: _internals.parseSkillPaths,
		validateSkillReference: _internals.validateSkillReference,
		readSkillUsageEntriesTail: _internals.readSkillUsageEntriesTail,
		appendSkillUsageEntry: _internals.appendSkillUsageEntry,
	};

	beforeEach(() => {
		tmp = canonicalMkdtemp('spg-enqueue-continue-');
		// Deterministic path resolution independent of real skill discovery /
		// audience routing — both fixture paths always validate.
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
		// No prior entries for this session — skip the dedup-preload path
		// entirely so `isDuplicate` never short-circuits before the try block.
		_internals.readSkillUsageEntriesTail = () => [];
	});

	afterEach(() => {
		_internals.parseSkillPaths = originals.parseSkillPaths;
		_internals.validateSkillReference = originals.validateSkillReference;
		_internals.readSkillUsageEntriesTail = originals.readSkillUsageEntriesTail;
		_internals.appendSkillUsageEntry = originals.appendSkillUsageEntry;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('control: with no injected failure both skill paths are recorded', async () => {
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
			{ messages: makeMessages('sess-control') },
			'sess-control',
		);

		// Establishes that both paths reach the recording loop at all (rules
		// out the "everything collapsed to __overall__" false-pass mode before
		// the failure-injection assertion below can mean anything).
		expect(recorded).toHaveLength(2);
		expect(recorded.map((r) => r.skillPath).sort()).toEqual(
			[
				'.claude/skills/skill-a/SKILL.md',
				'.claude/skills/skill-b/SKILL.md',
			].sort(),
		);
	});

	test('first skill path enqueue fails, second is still recorded (continue, not break)', async () => {
		const recorded: RecordedEntry[] = [];
		let callCount = 0;
		_internals.appendSkillUsageEntry = (
			_directory: string,
			entry: Omit<SkillUsageEntry, 'id'>,
		) => {
			callCount += 1;
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

		await skillPropagationTransformScan(
			tmp,
			{ messages: makeMessages('sess-partial-fail') },
			'sess-partial-fail',
		);

		// Both paths were attempted (the failure did not short-circuit the loop).
		expect(callCount).toBe(2);

		// Un-fixed (`break` on the first failure): the loop exits immediately
		// after path A's throw, path B is never attempted, `recorded` stays
		// empty (callCount would also stay 1, not 2).
		// Fixed (`continue`): path A's failure is isolated, path B is still
		// recorded.
		expect(recorded).toHaveLength(1);
		expect(recorded[0]!.skillPath).toBe('.claude/skills/skill-b/SKILL.md');
		expect(recorded[0]!.complianceVerdict).toBe('compliant');
	});
});
