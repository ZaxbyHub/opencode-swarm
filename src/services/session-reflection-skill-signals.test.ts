/**
 * Tests for FR-002 skill-violation signal surfacing on SessionReflectionData.
 *
 * Covers: gatherSkillViolationSignals tallying, ranking, legacy verdict
 * handling, fail-open behavior, and call-site fail-open injection in
 * runSessionReflection.
 *
 * Split from session-reflection-signals.test.ts to stay under the
 * FR-006 500-line file cap.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals as skillUsageInternals } from '../hooks/skill-usage-log';
import {
	_internals as reflectionInternals,
	runSessionReflection,
} from './session-reflection';

const { gatherSkillViolationSignals } = reflectionInternals;

describe('gatherSkillViolationSignals — FR-002', () => {
	let tempDir: string;
	let originalExistsSync: typeof fs.existsSync;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-violation-'));
		originalExistsSync = skillUsageInternals.existsSync;
	});

	afterEach(() => {
		// Restore the DI seam
		skillUsageInternals.existsSync = originalExistsSync;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('returns ranked list when entries have violations for multiple skills', async () => {
		skillUsageInternals.existsSync = () => true;

		// Write a skill-usage log with violation entries
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		const entries = [
			{
				id: '1',
				skillPath: '.opencode/skills/writing-tests/SKILL.md',
				agentName: 'coder',
				taskID: '1.1',
				timestamp: '2026-01-01T00:00:00Z',
				complianceVerdict: 'violated',
				sessionID: 'sess-1',
			},
			{
				id: '2',
				skillPath: '.opencode/skills/writing-tests/SKILL.md',
				agentName: 'coder',
				taskID: '1.2',
				timestamp: '2026-01-01T00:01:00Z',
				complianceVerdict: 'violated',
				sessionID: 'sess-1',
			},
			{
				id: '3',
				skillPath: '.opencode/skills/writing-tests/SKILL.md',
				agentName: 'coder',
				taskID: '1.3',
				timestamp: '2026-01-01T00:02:00Z',
				complianceVerdict: 'compliant',
				sessionID: 'sess-1',
			},
			{
				id: '4',
				skillPath: '.opencode/skills/subprocess-safety/SKILL.md',
				agentName: 'coder',
				taskID: '2.1',
				timestamp: '2026-01-01T00:03:00Z',
				complianceVerdict: 'violated',
				sessionID: 'sess-1',
			},
			{
				id: '5',
				skillPath: '.opencode/skills/commit-pr/SKILL.md',
				agentName: 'reviewer',
				taskID: '2.1',
				timestamp: '2026-01-01T00:04:00Z',
				complianceVerdict: 'compliant',
				sessionID: 'sess-1',
			},
		];
		fs.writeFileSync(
			logPath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const signals = await gatherSkillViolationSignals(tempDir, 'sess-1');
		expect(signals).toHaveLength(2);
		// writing-tests has 2 violations, subprocess-safety has 1
		expect(signals[0].skillPath).toBe(
			'.opencode/skills/writing-tests/SKILL.md',
		);
		expect(signals[0].violationCount).toBe(2);
		expect(signals[1].skillPath).toBe(
			'.opencode/skills/subprocess-safety/SKILL.md',
		);
		expect(signals[1].violationCount).toBe(1);
	});

	test('returns empty array when no entries exist', async () => {
		skillUsageInternals.existsSync = () => false;

		const signals = await gatherSkillViolationSignals(tempDir);
		expect(signals).toEqual([]);
	});

	test('fail-open: returns empty array when readSkillUsageEntriesTail throws', async () => {
		const originalStatSync = skillUsageInternals.statSync;
		skillUsageInternals.existsSync = () => true;
		skillUsageInternals.statSync = () => {
			throw new Error('forced stat failure');
		};

		try {
			const signals = await gatherSkillViolationSignals(tempDir);
			expect(signals).toEqual([]);
		} finally {
			skillUsageInternals.statSync = originalStatSync;
		}
	});

	test('includes legacy "violation" verdict as violated', async () => {
		skillUsageInternals.existsSync = () => true;

		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		const entries = [
			{
				id: '1',
				skillPath: '.opencode/skills/test-split/SKILL.md',
				agentName: 'coder',
				taskID: '1.1',
				timestamp: '2026-01-01T00:00:00Z',
				complianceVerdict: 'violation',
				sessionID: 'sess-legacy',
			},
		];
		fs.writeFileSync(
			logPath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const signals = await gatherSkillViolationSignals(tempDir, 'sess-legacy');
		expect(signals).toHaveLength(1);
		expect(signals[0].violationCount).toBe(1);
	});
});

describe('skillViolationSignals on SessionReflectionData — FR-002', () => {
	let tempDir: string;
	let originalExistsSync: typeof fs.existsSync;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-reflection-'));
		originalExistsSync = skillUsageInternals.existsSync;
	});

	afterEach(() => {
		skillUsageInternals.existsSync = originalExistsSync;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('surfaces skillViolationSignals as empty array when no log exists', async () => {
		skillUsageInternals.existsSync = () => false;

		const result = await runSessionReflection({
			directory: tempDir,
			toolAggregates: new Map(),
			agentSessions: new Map(),
		});

		expect(result.data.skillViolationSignals).toEqual([]);
	});

	test('call-site fail-open: injected throwing gather results in empty array', async () => {
		skillUsageInternals.existsSync = () => false;
		const originalGather = reflectionInternals.gatherSkillViolationSignals;
		reflectionInternals.gatherSkillViolationSignals = async () => {
			throw new Error('simulated gather failure');
		};

		try {
			const result = await runSessionReflection({
				directory: tempDir,
				toolAggregates: new Map(),
				agentSessions: new Map(),
			});

			expect(result.data.skillViolationSignals).toEqual([]);
		} finally {
			reflectionInternals.gatherSkillViolationSignals = originalGather;
		}
	});
});
