/** Regression coverage for the failure-side coder-mutation workflow guard. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import * as logger from '../../../src/utils/logger';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const FAIL_PAYLOAD = JSON.stringify({
	gates_passed: false,
	total_duration_ms: 1,
	batch_status: 'completed',
	lint: { ran: true, duration_ms: 1 },
	secretscan: {
		ran: true,
		duration_ms: 1,
		result: {
			count: 1,
			findings: ['test-secret'],
			files_scanned: 1,
			incomplete_files: 0,
			incomplete_paths: [],
		},
	},
	sast_scan: { ran: true, duration_ms: 1, result: { verdict: 'pass' } },
	quality_budget: { ran: false, duration_ms: 0 },
});

function defaultConfig(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
	};
}

let cleanup: () => void;
let directory: string;

beforeEach(() => {
	({ dir: directory, cleanup } = createSafeTestDir(
		'guardrails-coder-mutation',
	));
	resetSwarmState();
});

afterEach(() => {
	cleanup();
	resetSwarmState();
});

describe('coder-mutation-required Stage A failure guidance', () => {
	test('does not mislabel a failed Stage A write as an attribution miss', async () => {
		ensureAgentSession('architect').currentTaskId = '9.11';
		expect(
			getTaskWorkflowSnapshot(await readTaskEvidence(directory, '9.11')).state,
		).toBe('idle');
		const hooks = createGuardrailsHooks(directory, defaultConfig());
		const criticalWarnSpy = spyOn(logger, 'criticalWarn').mockImplementation(
			() => {},
		);

		try {
			await hooks.toolBefore(
				{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c-fail' },
				{ args: {} },
			);
			await hooks.toolAfter(
				{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c-fail' },
				{ title: '', output: FAIL_PAYLOAD, metadata: null },
			);

			const messages =
				swarmState.agentSessions.get('architect')?.pendingAdvisoryMessages ??
				[];
			const advisory = messages.find((message) =>
				message.includes('TASK_WORKFLOW_CODER_MUTATION_REQUIRED'),
			);
			expect(advisory).toBeDefined();
			expect(advisory).toContain('accepted coder mutation');
			expect(advisory).toContain('before Stage A');
			expect(advisory).not.toContain('NOT attributed');
			expect(advisory).not.toContain('/swarm recover');
			expect(criticalWarnSpy).toHaveBeenCalledTimes(1);
			expect(criticalWarnSpy).toHaveBeenCalledWith(
				expect.stringContaining('accepted coder mutation'),
			);
			expect(criticalWarnSpy.mock.calls[0]?.[0]).not.toContain(
				'NOT attributed',
			);
			expect(criticalWarnSpy.mock.calls[0]?.[0]).not.toContain(
				'/swarm recover',
			);
		} finally {
			criticalWarnSpy.mockRestore();
		}
	});
});
