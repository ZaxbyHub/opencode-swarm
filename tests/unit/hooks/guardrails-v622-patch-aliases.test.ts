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

describe('guardrails - #2206: indented patch payloads and no phantom context-line paths', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	async function startArchitect(sessionId: string) {
		startAgentSession(sessionId, ORCHESTRATOR_NAME);
		const { swarmState } = await import('../../../src/state');
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
	}

	it('an indented patchText targeting .swarm/plan.json → throws PLAN STATE VIOLATION (#2206)', async () => {
		const hooks = createGuardrailsHooks(defaultConfig());
		const sessionId = 'test-2206-indented';
		await startArchitect(sessionId);

		// Uniformly 2-space-indented unified diff (e.g. pasted inside a fenced
		// block). Pre-#2206 the column-0 anchored extraction regexes found no
		// paths and the plan-state guard was silently bypassed.
		const patchContent = [
			'  --- a/.swarm/plan.json',
			'  +++ b/.swarm/plan.json',
			'  @@ -1 +1 @@',
			'  -old',
			'  +new',
		].join('\n');

		const input = makeInput(sessionId, 'apply_patch', 'call-1');
		const output = makeOutput({ patchText: patchContent });

		await expect(hooks.toolBefore(input, output)).rejects.toThrow(
			'PLAN STATE VIOLATION',
		);
	});

	it('a column-0 patch whose CONTEXT line mentions --- .swarm/plan.json → NOT blocked (no phantom header match)', async () => {
		const hooks = createGuardrailsHooks(defaultConfig());
		const sessionId = 'test-2206-phantom';
		await startArchitect(sessionId);

		// A README patch whose context line documents the plan path with a
		// markdown horizontal-rule prefix: ` --- .swarm/plan.json`. The line's
		// single leading space is the diff CONTEXT marker, so it must never be
		// parsed as a `---` header — otherwise the guard would extract a phantom
		// plan-state target and block a legitimate documentation patch.
		const patchContent = [
			'--- a/README.md',
			'+++ b/README.md',
			'@@ -1,3 +1,3 @@',
			' # Project',
			' --- .swarm/plan.json holds the plan',
			'+ # Project (docs updated)',
		].join('\n');

		const input = makeInput(sessionId, 'patch', 'call-1');
		const output = makeOutput({ patch: patchContent });

		// must not throw: the context line is body content, never a header, so
		// no phantom plan-state target is extracted. The sibling test above
		// ('an indented patchText targeting .swarm/plan.json → throws PLAN STATE
		// VIOLATION') is the positive control proving extraction + the plan-state
		// guard ARE active for this harness — so this not-throwing means the
		// context line genuinely contributed no path.
		await hooks.toolBefore(input, output);
	});

	it('positive control: a REAL column-0 --- header for .swarm/plan.json → throws PLAN STATE VIOLATION', async () => {
		const hooks = createGuardrailsHooks(defaultConfig());
		const sessionId = 'test-2206-positive';
		await startArchitect(sessionId);

		// Identical patch, but the plan path sits on a genuine --- header line
		// instead of a space-prefixed context line — extraction must see it and
		// the plan-state guard must block.
		const patchContent = [
			'--- .swarm/plan.json',
			'+++ .swarm/plan.json',
			'@@ -1 +1 @@',
			'-old',
			'+new',
		].join('\n');

		const input = makeInput(sessionId, 'patch', 'call-1');
		const output = makeOutput({ patch: patchContent });

		await expect(hooks.toolBefore(input, output)).rejects.toThrow(
			'PLAN STATE VIOLATION',
		);
	});
});
