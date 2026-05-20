/**
 * Tests for the spec-drift structural block (issue #853 Layer B).
 *
 * Covers SPEC_DRIFT_BLOCKED_TOOLS membership (registration-coherent — every
 * blocked tool must exist as a TOOL_NAMES entry) and the runtime behavior of
 * enforceSpecDriftGate against .swarm/spec-staleness.json.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	enforceSpecDriftGate,
	SPEC_DRIFT_BLOCKED_TOOLS,
} from '../../../src/hooks/guardrails';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-drift-block-'));
	await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(async () => {
	try {
		await fs.rm(tmpDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

async function writeStalenessFile(): Promise<void> {
	await fs.writeFile(
		path.join(tmpDir, '.swarm', 'spec-staleness.json'),
		JSON.stringify({
			specHash_plan: 'def456',
			specHash_current: 'abc123',
			reason: 'spec.md changed since plan saved',
		}),
	);
}

async function removeStalenessFile(): Promise<void> {
	try {
		await fs.unlink(path.join(tmpDir, '.swarm', 'spec-staleness.json'));
	} catch {
		// best effort
	}
}

const NON_BLOCKED_TOOLS = [
	'get_approved_plan',
	'lint_spec',
	'set_qa_gates',
	'convene_council',
	'convene_general_council',
	'submit_phase_council_verdicts',
	'lean_turbo_plan_lanes',
	'lean_turbo_runner_status',
	'lean_turbo_review',
];

describe('SPEC_DRIFT_BLOCKED_TOOLS membership', () => {
	test('contains exactly 5 entries (size prevents drift)', () => {
		expect(SPEC_DRIFT_BLOCKED_TOOLS.size).toBe(5);
	});

	test('exact membership: the five known blocked tools', () => {
		const expected = new Set<string>([
			'save_plan',
			'update_task_status',
			'phase_complete',
			'lean_turbo_run_phase',
			'lean_turbo_acquire_locks',
		]);
		expect(SPEC_DRIFT_BLOCKED_TOOLS.size).toBe(expected.size);
		for (const t of expected) {
			expect(SPEC_DRIFT_BLOCKED_TOOLS.has(t)).toBe(true);
		}
	});

	test('NOT-blocked tools: the documented allow-list is excluded', () => {
		for (const tool of NON_BLOCKED_TOOLS) {
			expect(SPEC_DRIFT_BLOCKED_TOOLS.has(tool)).toBe(false);
		}
	});
});

describe('enforceSpecDriftGate', () => {
	test('throws SPEC_DRIFT_BLOCK for every blocked tool when staleness file exists', async () => {
		await writeStalenessFile();
		for (const tool of SPEC_DRIFT_BLOCKED_TOOLS) {
			expect(() => enforceSpecDriftGate(tmpDir, tool)).toThrow(
				/SPEC_DRIFT_BLOCK/,
			);
		}
	});

	test('does NOT throw for non-blocked tools even when staleness file exists', async () => {
		await writeStalenessFile();
		for (const tool of NON_BLOCKED_TOOLS) {
			expect(() => enforceSpecDriftGate(tmpDir, tool)).not.toThrow();
		}
	});

	test('does NOT throw when staleness file is absent', async () => {
		for (const tool of SPEC_DRIFT_BLOCKED_TOOLS) {
			expect(() => enforceSpecDriftGate(tmpDir, tool)).not.toThrow();
		}
	});

	test('immediately unblocks after staleness file is deleted (no cache)', async () => {
		await writeStalenessFile();
		expect(() => enforceSpecDriftGate(tmpDir, 'save_plan')).toThrow(
			/SPEC_DRIFT_BLOCK/,
		);
		await removeStalenessFile();
		expect(() => enforceSpecDriftGate(tmpDir, 'save_plan')).not.toThrow();
	});

	test('no-op when directory is undefined', () => {
		expect(() => enforceSpecDriftGate(undefined, 'save_plan')).not.toThrow();
	});
});
