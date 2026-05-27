/**
 * Verifies the phase-monitor hook triggers cheap architecture-summary aggregation on a
 * phase boundary only when architectural_supervision.enabled, using real temp dirs (no
 * module mocks) to avoid cross-file mock leakage.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	CuratorConfig,
	CuratorInitResult,
} from '../../../src/hooks/curator-types';
import { createPhaseMonitorHook } from '../../../src/hooks/phase-monitor';
import { normalizeAgentWorkSummary } from '../../../src/summaries/schema';
import {
	readPhaseArchitectureSummary,
	writeAgentSummary,
} from '../../../src/summaries/store';

const stubCuratorRunner = jest.fn<
	(_d: string, _c: CuratorConfig) => Promise<CuratorInitResult>
>(
	async () =>
		({
			briefing: '',
			knowledge_entries_reviewed: 0,
			prior_phases_covered: 0,
			contradictions: [],
		}) as unknown as CuratorInitResult,
);

let tempDir: string;

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-pm-arch-')),
	);
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	stubCuratorRunner.mockClear();
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeConfig(enabled: boolean): void {
	const dir = path.join(tempDir, '.opencode');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, 'opencode-swarm.json'),
		JSON.stringify({
			curator: { enabled: false },
			architectural_supervision: { enabled },
		}),
		'utf-8',
	);
}

function writePlan(currentPhase: number, phaseIds: number[]): void {
	const plan = {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: currentPhase,
		phases: phaseIds.map((id) => ({
			id,
			name: `Phase ${id}`,
			status: id < currentPhase ? 'completed' : 'in_progress',
			tasks: [
				{
					id: `${id}.1`,
					phase: id,
					// Prior phases are fully completed; the current phase stays pending so
					// PlanSchema derives current_phase correctly.
					status: id < currentPhase ? 'completed' : 'pending',
					agent: 'coder',
					size: 'small',
					description: `Task ${id}.1`,
					depends: [],
					files_touched: [],
				},
			],
		})),
	};
	fs.writeFileSync(
		path.join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify(plan),
		'utf-8',
	);
	fs.writeFileSync(
		path.join(tempDir, '.swarm', 'plan.md'),
		`# Plan\n## Phase ${currentPhase}\n`,
		'utf-8',
	);
}

async function seedSummary(phase: number): Promise<void> {
	await writeAgentSummary(
		tempDir,
		normalizeAgentWorkSummary({
			phase,
			task_id: `${phase}.1`,
			session_id: 's1',
			agent: 'coder',
			summary: 'did work',
			key_decisions: ['use redis'],
		}),
	);
}

describe('phase-monitor architecture summary aggregation', () => {
	it('writes the phase summary sidecar on phase change when enabled', async () => {
		writeConfig(true);
		await seedSummary(1);
		writePlan(1, [1]);

		const hook = createPhaseMonitorHook(tempDir, undefined, stubCuratorRunner);
		await hook({}, {}); // init phase 1
		writePlan(2, [1, 2]);
		await hook({}, {}); // transition 1 -> 2 triggers aggregation of phase 1

		const summary = readPhaseArchitectureSummary(tempDir, 1);
		expect(summary).not.toBeNull();
		expect(summary?.agents_seen).toEqual(['coder']);
		expect(summary?.key_decisions).toEqual(['use redis']);
	});

	it('does NOT aggregate when disabled', async () => {
		writeConfig(false);
		await seedSummary(1);
		writePlan(1, [1]);

		const hook = createPhaseMonitorHook(tempDir, undefined, stubCuratorRunner);
		await hook({}, {});
		writePlan(2, [1, 2]);
		await hook({}, {});

		expect(readPhaseArchitectureSummary(tempDir, 1)).toBeNull();
	});
});
