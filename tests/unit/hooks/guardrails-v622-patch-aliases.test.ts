import { beforeEach, describe, expect, it } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';

// Split out of guardrails-v622-adversarial.test.ts (FR-006 500-line cap /
// test-file-split skill): that file was already 569 lines (pre-existing
// over-cap) at PR base, so appending here instead of there avoids tripping
// the FR-006 diff-scoped growth ratchet (check-test-file-cap.sh).
//
// FB-014: guardrail-layer (real hooks.toolBefore) coverage for the 5
// non-legacy patch-payload aliases consumed by extractAllPatchPayloads /
// extractPatchTargetPaths (tool-before.ts ~1462, ~1547). Previously only the
// resolver was covered for these aliases (write-target-resolver.test.ts:
// 185-189); the guardrail layer itself only ever exercised the legacy
// `input` key (guardrails-v622-adversarial.test.ts, "OBJECTIVE 2: patch
// path extraction").

function defaultConfig(
	overrides?: Partial<GuardrailsConfig>,
): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...overrides,
	};
}

function makeInput(
	sessionID = 'test-session',
	tool = 'read',
	callID = 'call-1',
) {
	return { tool, sessionID, callID };
}

function makeOutput(args: unknown = { filePath: '/test.ts' }) {
	return { args };
}

const ORCHESTRATOR_NAME = 'architect';

describe('guardrails - v6.22 OBJECTIVE 2: patch path extraction alias coverage (FB-014)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it.each([
		['patchText' as const],
		['patch_text' as const],
		['patchPayload' as const],
		['text' as const],
		['content' as const],
	])('%s alias targeting .swarm/plan.json → throws PLAN STATE VIOLATION', async (aliasKey) => {
		const config = defaultConfig();
		const hooks = createGuardrailsHooks(config);
		const sessionId = 'test-session';

		startAgentSession(sessionId, ORCHESTRATOR_NAME);
		const { swarmState } = await import('../../../src/state');
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);

		const patchContent = `*** Begin Patch
*** Update File: .swarm/plan.json
-old
+new
*** End Patch`;

		const input = makeInput(sessionId, 'apply_patch', 'call-1');
		const output = makeOutput({ [aliasKey]: patchContent });

		await expect(hooks.toolBefore(input, output)).rejects.toThrow(
			'PLAN STATE VIOLATION',
		);
	});

	it.each([
		['patchText' as const],
		['patch_text' as const],
		['patchPayload' as const],
		['text' as const],
		['content' as const],
	])('%s alias targeting a non-plan file → not blocked', async (aliasKey) => {
		const config = defaultConfig();
		const hooks = createGuardrailsHooks(config);
		const sessionId = 'test-session';

		startAgentSession(sessionId, ORCHESTRATOR_NAME);
		const { swarmState } = await import('../../../src/state');
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);

		const patchContent = `*** Begin Patch
*** Update File: src/test.ts
-old
+new
*** End Patch`;

		const input = makeInput(sessionId, 'apply_patch', 'call-1');
		const output = makeOutput({ [aliasKey]: patchContent });

		// Should NOT throw - targeting a non-.swarm file is allowed.
		await hooks.toolBefore(input, output);
	});
});
