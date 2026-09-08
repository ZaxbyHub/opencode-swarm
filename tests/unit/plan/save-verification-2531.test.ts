import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	_internals,
	loadPlan,
	PlanWriteVerificationError,
	resetStartupLedgerCheck,
	type SavePlanResult,
	savePlan,
} from '../../../src/plan/manager';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Real seam bindings captured at module scope (AGENTS.md invariant 7: restore
// in afterEach so Bun's shared test-runner process never leaks the mutation).
const realVerifyWrittenPlanJson = _internals.verifyWrittenPlanJson;
const realReadPlanFileUtf8 = _internals.readPlanFileUtf8;

function makePlan(title: string): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'save-verify-2531',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Verify the save',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	} as Plan;
}

describe('savePlan durability verification (#2531 AC5)', () => {
	let directory: string;

	beforeEach(async () => {
		directory = canonicalMkdtemp('save-verify-2531-');
		await mkdir(join(directory, '.swarm'), { recursive: true });
		await mkdir(join(directory, '.git'));
		resetStartupLedgerCheck();
	});

	afterEach(async () => {
		_internals.verifyWrittenPlanJson = realVerifyWrittenPlanJson;
		_internals.readPlanFileUtf8 = realReadPlanFileUtf8;
		resetStartupLedgerCheck();
		try {
			await rm(directory, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 100,
			});
		} catch {
			/* best-effort on Windows swarm.db handles */
		}
	});

	test('a clean save reports complete durability', async () => {
		const result = await savePlan(directory, makePlan('Clean save'));
		expect(result.durability).toBe('complete');
		expect(result.degraded_surfaces).toEqual([]);
		expect(existsSync(join(directory, '.swarm', 'plan.json'))).toBe(true);
	});

	test('unreadable plan.md projection yields an explicit incomplete-durability result', async () => {
		// plan.md as a directory: the advisory markdown projection cannot be
		// written, but the authoritative pair (ledger + plan.json) succeeds.
		await mkdir(join(directory, '.swarm', 'plan.md'));
		const result = await savePlan(directory, makePlan('Degraded md save'));
		expect(result.durability).toBe('incomplete');
		expect(result.degraded_surfaces).toEqual(['plan.md']);
		expect(typeof result.md_write_error).toBe('string');
		expect(existsSync(join(directory, '.swarm', 'plan.json'))).toBe(true);
	});

	test('a save that cannot verify its written plan.json reports failure (PlanWriteVerificationError)', async () => {
		// Fault injection through the _internals seam: the read-back cannot
		// decode the freshly written file. The save must throw instead of
		// claiming successful readable state.
		_internals.readPlanFileUtf8 = () =>
			Promise.reject(new Error('injected: unreadable read-back'));
		let threw: unknown = null;
		try {
			await savePlan(directory, makePlan('Unverifiable save'));
		} catch (error) {
			threw = error;
		}
		expect(threw).toBeInstanceOf(PlanWriteVerificationError);
		expect((threw as Error).message).toContain(
			'PLAN_WRITE_VERIFICATION_FAILED',
		);
	});

	test('a read-back whose content differs from the projected plan fails verification', async () => {
		// Corrupt the freshly written plan.json between the write and the
		// read-back by intercepting the fatal decode to return other content.
		_internals.readPlanFileUtf8 = () =>
			Promise.resolve(JSON.stringify(makePlan('Tampered content')));
		let threw: unknown = null;
		try {
			await savePlan(directory, makePlan('Original content'));
		} catch (error) {
			threw = error;
		}
		expect(threw).toBeInstanceOf(PlanWriteVerificationError);
	});

	test('save-boundary extension of the C3 guarantee: valid literal U+FFFD and escaped text round-trip', async () => {
		const plan = makePlan('Round trip plan');
		// Literal U+FFFD character in the description (valid UTF-8 data) and
		// the six escaped characters \uFFFD in acceptance (JSON escape form).
		plan.phases[0].tasks[0].description = 'keeps literal \uFFFD data';
		plan.phases[0].tasks[0].acceptance = 'keeps escaped \\ufffd text';
		const result: SavePlanResult = await savePlan(directory, plan);
		expect(result.durability).toBe('complete');
		const loaded = await loadPlan(directory);
		expect(loaded?.phases[0].tasks[0].description).toBe(
			'keeps literal \uFFFD data',
		);
		expect(loaded?.phases[0].tasks[0].acceptance).toBe(
			'keeps escaped \\ufffd text',
		);
	});

	test('plan.json written by savePlan is fatally decodable and parseable', async () => {
		await savePlan(directory, makePlan('Decode check'));
		await expect(_internals.readPlanJsonUtf8(directory)).resolves.toContain(
			'Decode check',
		);
	});
});

// Silence unused-import lint when types are only used in annotations.
void writeFile;
