import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	consolidationStatePath,
	runSkillConsolidation,
	shouldRunSkillConsolidation,
} from '../../../src/services/skill-consolidation';
import type { SkillImproverConfigInput } from '../../../src/services/skill-improver';

let tmp: string;

beforeEach(() => {
	mock.restore();
	tmp = mkdtempSync(path.join(tmpdir(), 'skill-consolidation-'));
});

afterEach(() => {
	_internals.runningByDirectory.clear();
	rmSync(tmp, { recursive: true, force: true });
	mock.restore();
});

const config: SkillImproverConfigInput = {
	enabled: true,
	model: null,
	fallback_models: [],
	max_calls_per_day: 5,
	trigger: 'scheduled',
	consolidation_interval_hours: 24,
	consolidation_max_calls_per_run: 1,
	targets: ['skills', 'spec', 'architect_prompt', 'knowledge'],
	write_mode: 'proposal',
	require_user_approval: true,
	quota_window: 'utc',
	allow_deterministic_fallback: true,
};

describe('skill consolidation cadence', () => {
	it('runs scheduled consolidation and writes cadence state', async () => {
		const result = await runSkillConsolidation({
			directory: tmp,
			config,
			source: 'startup',
			now: new Date('2026-06-14T12:00:00.000Z'),
		});

		expect(result.started).toBe(true);
		expect(result.result?.ran).toBe(true);
		expect(existsSync(result.result!.proposalPath!)).toBe(true);
		expect(existsSync(consolidationStatePath(tmp))).toBe(true);
		const state = JSON.parse(
			readFileSync(consolidationStatePath(tmp), 'utf-8'),
		);
		expect(state.last_source).toBe('startup');
		expect(state.last_consolidation_at).toBe('2026-06-14T12:00:00.000Z');
	});

	it('skips opportunistic run inside the configured interval', async () => {
		await runSkillConsolidation({
			directory: tmp,
			config,
			source: 'startup',
			now: new Date('2026-06-14T12:00:00.000Z'),
		});

		const decision = await shouldRunSkillConsolidation({
			directory: tmp,
			config,
			source: 'phase_complete',
			now: new Date('2026-06-14T13:00:00.000Z'),
		});

		expect(decision.shouldRun).toBe(false);
		expect(decision.reason).toContain('newer than 24h');
	});

	it('manual force runs even when trigger is manual', async () => {
		const result = await runSkillConsolidation({
			directory: tmp,
			config: { ...config, trigger: 'manual' },
			source: 'manual',
			force: true,
			now: new Date('2026-06-14T12:00:00.000Z'),
		});

		expect(result.started).toBe(true);
		expect(result.result?.autoApply).toBeUndefined();
	});

	it('manual force does not bypass the in-flight run guard', async () => {
		_internals.runningByDirectory.set(path.resolve(tmp), new Promise(() => {}));

		const result = await runSkillConsolidation({
			directory: tmp,
			config: { ...config, trigger: 'manual' },
			source: 'manual',
			force: true,
			now: new Date('2026-06-14T12:00:00.000Z'),
		});

		expect(result.started).toBe(false);
		expect(result.reason).toBe('skill consolidation already running');
	});
});
