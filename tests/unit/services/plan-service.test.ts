import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import type { PlanData } from '../../../src/services/plan-service';
import {
	_internals,
	formatPlanMarkdown,
	getPlanData,
} from '../../../src/services/plan-service';

// Minimal Plan object matching PlanSchema
function makePlan(overrides: Partial<Plan> = {}): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [],
		...overrides,
	} as Plan;
}

// ── formatPlanMarkdown tests ────────────────────────────────────────────────────

describe('formatPlanMarkdown', () => {
	test('hasPlan false → no plan message', () => {
		const input: PlanData = {
			hasPlan: false,
			fullMarkdown: '',
			requestedPhase: null,
			phaseMarkdown: null,
			errorMessage: null,
			isLegacy: false,
		};
		expect(formatPlanMarkdown(input)).toBe('No active swarm plan found.');
	});

	test('hasPlan true with errorMessage → returns error message', () => {
		const input: PlanData = {
			hasPlan: true,
			fullMarkdown: '# My Plan',
			requestedPhase: null,
			phaseMarkdown: null,
			errorMessage: 'Invalid phase number: "abc"',
			isLegacy: false,
		};
		expect(formatPlanMarkdown(input)).toBe('Invalid phase number: "abc"');
	});

	test('hasPlan true with requestedPhase and phaseMarkdown → returns phase markdown', () => {
		const input: PlanData = {
			hasPlan: true,
			fullMarkdown: '# My Plan\n\n## Phase 1\n\n## Phase 2',
			requestedPhase: 2,
			phaseMarkdown: '## Phase 2\nTask 2.1',
			errorMessage: null,
			isLegacy: false,
		};
		expect(formatPlanMarkdown(input)).toBe('## Phase 2\nTask 2.1');
	});

	test('hasPlan true with no error and no phase requested → returns full markdown', () => {
		const input: PlanData = {
			hasPlan: true,
			fullMarkdown: '# My Plan\n\n## Phase 1\n\n## Phase 2',
			requestedPhase: null,
			phaseMarkdown: null,
			errorMessage: null,
			isLegacy: false,
		};
		expect(formatPlanMarkdown(input)).toBe(
			'# My Plan\n\n## Phase 1\n\n## Phase 2',
		);
	});
});

// ── getPlanData tests ──────────────────────────────────────────────────────────

describe('getPlanData', () => {
	let tmpDir: string;
	let origLoadPlanJsonOnly: typeof _internals.loadPlanJsonOnly;
	let origDerivePlanMarkdown: typeof _internals.derivePlanMarkdown;
	let origReadSwarmFileAsync: typeof _internals.readSwarmFileAsync;

	beforeEach(async () => {
		tmpDir = await fsPromises.mkdtemp(
			path.join(os.tmpdir(), 'plan-service-test-'),
		);
		// Save originals for restoration
		origLoadPlanJsonOnly = _internals.loadPlanJsonOnly;
		origDerivePlanMarkdown = _internals.derivePlanMarkdown;
		origReadSwarmFileAsync = _internals.readSwarmFileAsync;
	});

	afterEach(async () => {
		// Restore originals
		_internals.loadPlanJsonOnly = origLoadPlanJsonOnly;
		_internals.derivePlanMarkdown = origDerivePlanMarkdown;
		_internals.readSwarmFileAsync = origReadSwarmFileAsync;
		// Clean up temp directory
		try {
			await fsPromises.rm(tmpDir, { recursive: true });
		} catch {
			// Best-effort cleanup
		}
	});

	test('no plan.json and no plan.md → hasPlan false (legacy fallback path returns isLegacy true)', async () => {
		_internals.loadPlanJsonOnly = mock(() => Promise.resolve(null));
		_internals.readSwarmFileAsync = mock(() => Promise.resolve(null));

		const result = await getPlanData(tmpDir);

		expect(result.hasPlan).toBe(false);
		// isLegacy: true because the function falls through the legacy path even when
		// plan.md is absent — the isLegacy flag reflects "this is the legacy code path",
		// not "a legacy plan was found".
		expect(result.isLegacy).toBe(true);
		expect(result.fullMarkdown).toBe('');
		expect(result.requestedPhase).toBeNull();
		expect(result.phaseMarkdown).toBeNull();
		expect(result.errorMessage).toBeNull();
	});

	test('plan.json exists, no phase arg → returns full markdown, isLegacy false', async () => {
		const plan = makePlan({
			title: 'My Swarm',
			swarm: 'my-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase One',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: 'Do the thing',
						},
					],
				},
			],
		});

		_internals.loadPlanJsonOnly = mock(() => Promise.resolve(plan));
		_internals.derivePlanMarkdown = mock(
			() => '# My Swarm\nSwarm: my-swarm\nPhase: 1 [IN PROGRESS]',
		);
		_internals.readSwarmFileAsync = mock(() => Promise.resolve(null));

		const result = await getPlanData(tmpDir);

		expect(result.hasPlan).toBe(true);
		expect(result.isLegacy).toBe(false);
		expect(result.requestedPhase).toBeNull();
		expect(result.phaseMarkdown).toBeNull();
		expect(result.errorMessage).toBeNull();
		expect(result.fullMarkdown).toBe(
			'# My Swarm\nSwarm: my-swarm\nPhase: 1 [IN PROGRESS]',
		);
	});

	test('plan.json exists, invalid phase arg (NaN) → error message', async () => {
		const plan = makePlan({
			title: 'My Plan',
			swarm: 'my-swarm',
			phases: [{ id: 1, name: 'P1', status: 'pending', tasks: [] }],
		});

		_internals.loadPlanJsonOnly = mock(() => Promise.resolve(plan));
		_internals.derivePlanMarkdown = mock(() => '# My Plan');
		_internals.readSwarmFileAsync = mock(() => Promise.resolve(null));

		const result = await getPlanData(tmpDir, 'not-a-number');

		expect(result.hasPlan).toBe(true);
		expect(result.isLegacy).toBe(false);
		expect(result.requestedPhase).toBeNull();
		expect(result.errorMessage).toBe('Invalid phase number: "not-a-number"');
	});

	test('plan.json exists, phase number not found → error message', async () => {
		const plan = makePlan({
			title: 'My Plan',
			swarm: 'my-swarm',
			phases: [{ id: 1, name: 'Phase One', status: 'pending', tasks: [] }],
		});

		_internals.loadPlanJsonOnly = mock(() => Promise.resolve(plan));
		_internals.derivePlanMarkdown = mock(() => '# My Plan\n\n## Phase 1');
		_internals.readSwarmFileAsync = mock(() => Promise.resolve(null));

		const result = await getPlanData(tmpDir, 99);

		expect(result.hasPlan).toBe(true);
		expect(result.isLegacy).toBe(false);
		expect(result.requestedPhase).toBe(99);
		expect(result.phaseMarkdown).toBeNull();
		expect(result.errorMessage).toBe('Phase 99 not found in plan.');
	});

	test('plan.json exists, valid phase found → returns phase markdown', async () => {
		const plan = makePlan({
			title: 'My Plan',
			swarm: 'my-swarm',
			current_phase: 1,
			phases: [
				{ id: 1, name: 'Phase One', status: 'pending', tasks: [] },
				{
					id: 2,
					name: 'Phase Two',
					status: 'pending',
					tasks: [
						{
							id: '2.1',
							phase: 2,
							status: 'pending',
							size: 'small',
							description: 'Task 2.1',
						},
					],
				},
			],
		});

		_internals.loadPlanJsonOnly = mock(() => Promise.resolve(plan));
		_internals.derivePlanMarkdown = mock(
			() => '# My Plan\n\n## Phase 1\n\n## Phase 2',
		);
		_internals.readSwarmFileAsync = mock(() => Promise.resolve(null));

		const result = await getPlanData(tmpDir, 2);

		expect(result.hasPlan).toBe(true);
		expect(result.isLegacy).toBe(false);
		expect(result.requestedPhase).toBe(2);
		expect(result.phaseMarkdown).not.toBeNull();
		expect(result.errorMessage).toBeNull();
	});

	test('no plan.json, legacy plan.md exists, no phase arg → isLegacy true', async () => {
		_internals.loadPlanJsonOnly = mock(() => Promise.resolve(null));
		_internals.readSwarmFileAsync = mock(() =>
			Promise.resolve('# Legacy Plan\n\n## Phase 1\nDo stuff'),
		);

		const result = await getPlanData(tmpDir);

		expect(result.hasPlan).toBe(true);
		expect(result.isLegacy).toBe(true);
		expect(result.requestedPhase).toBeNull();
		expect(result.phaseMarkdown).toBeNull();
		expect(result.errorMessage).toBeNull();
		expect(result.fullMarkdown).toBe('# Legacy Plan\n\n## Phase 1\nDo stuff');
	});

	test('no plan.json, legacy plan.md exists, valid phase → extracts phase markdown', async () => {
		const legacyMd = `# Legacy Plan

## Phase 1
Task 1.1

## Phase 2
Task 2.1`;

		_internals.loadPlanJsonOnly = mock(() => Promise.resolve(null));
		_internals.readSwarmFileAsync = mock(() => Promise.resolve(legacyMd));

		const result = await getPlanData(tmpDir, 2);

		expect(result.hasPlan).toBe(true);
		expect(result.isLegacy).toBe(true);
		expect(result.requestedPhase).toBe(2);
		expect(result.phaseMarkdown).not.toBeNull();
		expect(result.errorMessage).toBeNull();
	});

	test('phase arg as number type is handled correctly', async () => {
		const plan = makePlan({
			title: 'My Plan',
			swarm: 'my-swarm',
			current_phase: 1,
			phases: [{ id: 1, name: 'Phase One', status: 'pending', tasks: [] }],
		});

		_internals.loadPlanJsonOnly = mock(() => Promise.resolve(plan));
		_internals.derivePlanMarkdown = mock(() => '# My Plan');
		_internals.readSwarmFileAsync = mock(() => Promise.resolve(null));

		const result = await getPlanData(tmpDir, 1);

		expect(result.hasPlan).toBe(true);
		expect(result.requestedPhase).toBe(1);
	});
});

describe('getPlanData — corruption and error handling', () => {
	let tmpDir: string;
	let origLoadPlanJsonOnly: typeof _internals.loadPlanJsonOnly;
	let origDerivePlanMarkdown: typeof _internals.derivePlanMarkdown;
	let origReadSwarmFileAsync: typeof _internals.readSwarmFileAsync;

	beforeEach(async () => {
		tmpDir = await fsPromises.mkdtemp(
			path.join(os.tmpdir(), 'plan-service-test-'),
		);
		origLoadPlanJsonOnly = _internals.loadPlanJsonOnly;
		origDerivePlanMarkdown = _internals.derivePlanMarkdown;
		origReadSwarmFileAsync = _internals.readSwarmFileAsync;
	});

	afterEach(async () => {
		_internals.loadPlanJsonOnly = origLoadPlanJsonOnly;
		_internals.derivePlanMarkdown = origDerivePlanMarkdown;
		_internals.readSwarmFileAsync = origReadSwarmFileAsync;
		await fsPromises
			.rm(tmpDir, { recursive: true, force: true })
			.catch(() => {});
	});

	test('loadPlanJsonOnly throws on malformed JSON → propagates SyntaxError', async () => {
		_internals.loadPlanJsonOnly = mock(() => {
			throw new SyntaxError('Unexpected token in JSON');
		});
		_internals.readSwarmFileAsync = mock(() => Promise.resolve(null));

		// getPlanData does not catch exceptions from loadPlanJsonOnly
		await expect(getPlanData(tmpDir)).rejects.toThrow(SyntaxError);
	});

	test('loadPlanJsonOnly returns plan missing required fields → still loads', async () => {
		// Plan with missing schema_version — should still load since validation is elsewhere
		const incompletePlan = {
			title: 'Incomplete Plan',
			swarm: 'test',
			phases: [],
			// schema_version intentionally missing
		};
		_internals.loadPlanJsonOnly = mock(() =>
			Promise.resolve(incompletePlan as any),
		);
		_internals.derivePlanMarkdown = mock(() => '# Incomplete Plan');
		_internals.readSwarmFileAsync = mock(() => Promise.resolve(null));

		const result = await getPlanData(tmpDir);
		expect(result.hasPlan).toBe(true);
		expect(result.isLegacy).toBe(false);
	});

	test('readSwarmFileAsync throws permission error → propagates Error', async () => {
		_internals.loadPlanJsonOnly = mock(() => Promise.resolve(null));
		_internals.readSwarmFileAsync = mock(() => {
			const err = new Error('EACCES: permission denied');
			(err as any).code = 'EACCES';
			throw err;
		});

		// getPlanData does not catch exceptions from readSwarmFileAsync
		await expect(getPlanData(tmpDir)).rejects.toThrow('EACCES');
	});
});
