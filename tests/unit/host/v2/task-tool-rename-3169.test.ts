/**
 * v2 subagent→task identity translation tests (issue #3169 Phase 1 / #3165 §D).
 *
 * OpenCode 2 renamed the native delegation tool (`task`/`subagent_type`/`task_id`
 * → `subagent`/`agent`/`sessionID`) and wraps its result text as
 * `<subagent sessionID="…" state="…">…</subagent>`. The v2 adapter translates
 * at the tool-hook boundary so the entire v1 chain (delegation gate, ack
 * collectors, residue commit, task-envelope parsing) engages unchanged.
 *
 * Test names carry the AC1–AC4 prefixes consumed by the frozen acceptance
 * checks (repro/check-c{1..4}.sh, `bun test -t 'ACn'`).
 *
 * Drives `registerV2ToolHooks` (public surface) with mock v2 contexts per
 * src/host/v2/types.ts provenance; the REAL task-envelope parser
 * (src/background/task-envelope.ts) and the REAL delegation gate
 * (createDelegationGateHook, disabled-gate coder path) are exercised — no
 * mock.module, fakes only, no clock reads, no subprocess.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	extractDispatchIds,
	parseTaskEnvelope,
} from '../../../../src/background/task-envelope';
import { createDelegationGateHook } from '../../../../src/hooks/delegation-gate';
import { registerV2ToolHooks } from '../../../../src/host/v2/hooks';
import type {
	V1HooksSubset,
	V2ToolHookInput,
} from '../../../../src/host/v2/types';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';
import { recordPlanCriticApproval } from '../../hooks/_delegation-gate-helpers';

function toolHookCapture(hooks: V1HooksSubset) {
	const calls: Array<{
		name: 'execute.before' | 'execute.after';
		cb: (event: V2ToolHookInput) => unknown;
	}> = [];
	return {
		calls,
		tool: {
			transform: async () => ({ dispose: async () => {} }),
			reload: async () => {},
			hook: async (
				name: 'execute.before' | 'execute.after',
				cb: (event: V2ToolHookInput) => unknown,
			) => {
				calls.push({ name, cb });
				return { dispose: async () => {} };
			},
		},
		hooks,
	};
}

async function registerAndCapture(hooks: V1HooksSubset) {
	const capture = toolHookCapture(hooks);
	await registerV2ToolHooks(capture as never, capture.hooks, process.cwd(), []);
	return capture;
}

function makeV2SubagentEvent(
	overrides: Partial<V2ToolHookInput> = {},
): V2ToolHookInput {
	return {
		tool: 'subagent',
		sessionID: 'ses_architect_parent',
		agent: 'architect',
		messageID: 'msg_1',
		id: 'call_1',
		input: {
			agent: 'coder',
			description: 'Implement T1',
			prompt: 'FILE: src/a.ts — do the thing',
			sessionID: 'ses_existing_child',
			background: false,
		},
		status: 'completed',
		result: {
			content:
				'<subagent sessionID="ses_existing_child" state="completed">done</subagent>',
			metadata: {},
		},
		...overrides,
	} as V2ToolHookInput;
}

describe('task-tool-rename-3169', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	test('AC1 before-event: v1 handler sees task + subagent_type/task_id from v2 agent/sessionID', async () => {
		const seen: Array<{ tool: string; args: unknown }> = [];
		const hooks = {
			'tool.execute.before': async (
				input: { tool: string },
				output: { args: unknown },
			) => {
				seen.push({
					tool: input.tool,
					args: JSON.parse(JSON.stringify(output.args)),
				});
			},
		} as unknown as V1HooksSubset;
		const capture = await registerAndCapture(hooks);
		const before = capture.calls.find((c) => c.name === 'execute.before');
		expect(before).toBeDefined();

		const event = makeV2SubagentEvent();
		await before!.cb(event);

		expect(seen.length).toBe(1);
		expect(seen[0].tool).toBe('task');
		expect(seen[0].args).toEqual({
			subagent_type: 'coder',
			description: 'Implement T1',
			prompt: 'FILE: src/a.ts — do the thing',
			task_id: 'ses_existing_child',
			background: false,
		});
	});

	test('AC1 name forms: bare/prefixed/dotted/case subagent ids all map to bare task; others pass through', async () => {
		const seen: string[] = [];
		const hooks = {
			'tool.execute.before': async (input: { tool: string }) => {
				seen.push(input.tool);
			},
		} as unknown as V1HooksSubset;
		const capture = await registerAndCapture(hooks);
		const before = capture.calls.find((c) => c.name === 'execute.before')!;

		for (const tool of [
			'subagent',
			'Subagent',
			'opencode:subagent',
			'tool.execute.subagent',
		]) {
			await before.cb(
				makeV2SubagentEvent({
					tool,
					input: { agent: 'coder', prompt: 'p' },
				}) as V2ToolHookInput,
			);
		}
		// Non-subagent tools pass through byte-identically (control).
		await before.cb(
			makeV2SubagentEvent({
				tool: 'write',
				input: { file_path: 'x', content: 'y' },
			}) as V2ToolHookInput,
		);
		// A dot-bearing custom tool is never truncated into the mapping.
		await before.cb(
			makeV2SubagentEvent({
				tool: 'my.subagent.tool',
				input: {},
			}) as V2ToolHookInput,
		);

		expect(seen).toEqual([
			'task',
			'task',
			'task',
			'task',
			'write',
			'my.subagent.tool',
		]);
	});

	test('AC2 write-back: chain mutations land IN PLACE as v2 arg names; v2-only args survive', async () => {
		const hooks = {
			'tool.execute.before': async (
				_input: unknown,
				output: { args: unknown },
			) => {
				// Simulate the v1 chain: worktree isolation rewrites task_id
				// (worktree-isolation.ts) and the prompt is rewritten
				// (:1833 outputArgs.prompt).
				const args = output.args as Record<string, unknown>;
				args.task_id = 'ses_precreated_child';
				args.prompt = 'FILE: src/a.ts — rewritten';
			},
		} as unknown as V1HooksSubset;
		const capture = await registerAndCapture(hooks);
		const before = capture.calls.find((c) => c.name === 'execute.before')!;

		const event = makeV2SubagentEvent();
		const originalInput = event.input as Record<string, unknown>;
		// Retained pre-hook reference: the in-place contract asserts the SAME
		// object identity carries the mapped result (invariant-10 class).
		const retainedRef = originalInput;
		await before.cb(event);

		expect(event.input).toBe(retainedRef);
		expect(retainedRef).toEqual({
			agent: 'coder',
			description: 'Implement T1',
			prompt: 'FILE: src/a.ts — rewritten',
			sessionID: 'ses_precreated_child',
			background: false,
		});
		expect('task_id' in retainedRef).toBe(false);
	});

	test('AC3 after-event: handler input is task + mapped args; completed wrapper parses via the real parseTaskEnvelope', async () => {
		const seen: Array<{
			tool: string;
			args: unknown;
			output: { state: string; output: string };
		}> = [];
		const hooks = {
			'tool.execute.after': async (
				input: { tool: string; args?: unknown },
				output: { state: string; output: string },
			) => {
				seen.push({
					tool: input.tool,
					args: JSON.parse(JSON.stringify(input.args ?? null)),
					output: { ...output },
				});
			},
		} as unknown as V1HooksSubset;
		const capture = await registerAndCapture(hooks);
		const after = capture.calls.find((c) => c.name === 'execute.after')!;

		await after.cb(makeV2SubagentEvent());

		expect(seen.length).toBe(1);
		// AC3(e): identity half — the after chain sees the v1 names.
		expect(seen[0].tool).toBe('task');
		expect(seen[0].args).toEqual({
			subagent_type: 'coder',
			description: 'Implement T1',
			prompt: 'FILE: src/a.ts — do the thing',
			task_id: 'ses_existing_child',
			background: false,
		});
		// AC3(a): output half — the re-rendered envelope parses via the REAL
		// v1 parser.
		const envelope = parseTaskEnvelope(seen[0].output.output);
		expect(envelope).not.toBeNull();
		expect(envelope!.sessionId).toBe('ses_existing_child');
		expect(envelope!.state).toBe('completed');
		expect(envelope!.resultText).toBe('done');
		expect(seen[0].output.state).toBe('completed');
	});

	test('AC3 running wrapper: extractDispatchIds correlates the dispatch (the RC3 consumer)', async () => {
		let capturedOutput: unknown = null;
		const hooks = {
			'tool.execute.after': async (_input: unknown, output: unknown) => {
				capturedOutput = output;
			},
		} as unknown as V1HooksSubset;
		const capture = await registerAndCapture(hooks);
		const after = capture.calls.find((c) => c.name === 'execute.after')!;

		await after.cb(
			makeV2SubagentEvent({
				result: {
					content: '<subagent sessionID="s1" state="running">queued</subagent>',
					metadata: {},
				},
			}) as V2ToolHookInput,
		);

		const out = capturedOutput as { state: string; output: string };
		expect(out.state).toBe('running');
		// extractDispatchIds only correlates on state="running"
		// (task-envelope.ts:144) — the exact consumer RC3 breaks.
		expect(extractDispatchIds(out).subagentSessionId).toBe('s1');
	});

	test('AC3 error precedence: error status wins on BOTH channels (no correlatable envelope)', async () => {
		let capturedOutput: unknown = null;
		const hooks = {
			'tool.execute.after': async (_input: unknown, output: unknown) => {
				capturedOutput = output;
			},
		} as unknown as V1HooksSubset;
		const capture = await registerAndCapture(hooks);
		const after = capture.calls.find((c) => c.name === 'execute.after')!;

		await after.cb(
			makeV2SubagentEvent({
				status: 'error',
				error: { message: 'Subagent failed' },
				result: {
					// Stale running wrapper embedded in an error result must
					// never be re-rendered into a correlatable envelope.
					content: '<subagent sessionID="s1" state="running">queued</subagent>',
					metadata: {},
				},
			}) as V2ToolHookInput,
		);

		const out = capturedOutput as { state: string; output: string };
		expect(out.state).toBe('error');
		expect(out.output).toBe('Subagent failed');
		expect(extractDispatchIds(out).subagentSessionId).toBeNull();
	});

	test('AC3 non-envelope result text passes through unchanged; non-subagent after-events untouched', async () => {
		const outputs: Array<{ tool: string; output: string }> = [];
		const hooks = {
			'tool.execute.after': async (
				input: { tool: string },
				output: { output: string },
			) => {
				outputs.push({ tool: input.tool, output: output.output });
			},
		} as unknown as V1HooksSubset;
		const capture = await registerAndCapture(hooks);
		const after = capture.calls.find((c) => c.name === 'execute.after')!;

		await after.cb(
			makeV2SubagentEvent({
				result: { content: 'plain text, no wrapper', metadata: {} },
			}) as V2ToolHookInput,
		);
		await after.cb(
			makeV2SubagentEvent({
				tool: 'write',
				input: { file_path: 'x' },
				result: { content: 'wrote x', metadata: {} },
			}) as V2ToolHookInput,
		);

		expect(outputs).toEqual([
			{ tool: 'task', output: 'plain text, no wrapper' },
			{ tool: 'write', output: 'wrote x' },
		]);
	});

	test('AC4 real delegation gate: Task branch engages on a v2-shaped event through the adapter (durable scope binding)', async () => {
		const directory = canonicalMkdtemp('v2-task-rename-ac4');
		try {
			// Minimal plan fixture (shape per tests/unit/scope/
			// scope-binding-durability.test.ts): task 1.1 owns src/a.ts, the
			// file the dispatch prompt declares via FILE:.
			const plan = {
				schema_version: '1.0.0',
				title: 'v2 task rename AC4',
				swarm: 'test',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Implementation',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'pending',
								size: 'small',
								description: 'Implement T1',
								depends: [],
								files_touched: ['src/a.ts'],
							},
						],
					},
				],
			};
			fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(directory, '.swarm', 'plan.json'),
				JSON.stringify(plan),
			);
			// Coder Task dispatches over an existing plan require the
			// critic-approval snapshot (PR #1706) — record it exactly as
			// production does.
			await recordPlanCriticApproval(directory, plan as never);

			// Disabled gate → the light toolBefore path publishes the coder
			// scope binding for task+coder dispatches (delegation-gate.ts
			// disabled branch); no client/worktree machinery is needed.
			const config = {
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
				hooks: {
					system_enhancer: true,
					compaction: true,
					agent_activity: true,
					delegation_tracker: false,
					delegation_gate: false,
				},
			} as never;
			const gate = createDelegationGateHook(config, directory);
			const capture = await registerAndCapture({
				'tool.execute.before': gate.toolBefore,
			} as unknown as V1HooksSubset);
			const before = capture.calls.find((c) => c.name === 'execute.before')!;

			const bindingFiles = (): string[] => {
				const found: string[] = [];
				const walk = (dir: string): void => {
					if (!fs.existsSync(dir)) return;
					for (const entry of fs.readdirSync(dir, {
						withFileTypes: true,
					})) {
						const full = path.join(dir, entry.name);
						if (entry.isDirectory()) walk(full);
						else if (
							entry.name.includes('binding') ||
							entry.name.includes('scope')
						) {
							found.push(full);
						}
					}
				};
				walk(path.join(directory, '.swarm'));
				return found;
			};

			// Control leg (pre-fix shape): the gate's toolBefore called
			// DIRECTLY with the raw v2 name — exactly what the adapter fed it
			// before this fix — must NOT engage the Task branch.
			await gate.toolBefore(
				{
					tool: 'subagent',
					sessionID: 'ses_architect_parent',
					callID: 'call_control',
					agent: 'architect',
				},
				{
					args: {
						agent: 'coder',
						description: 'Implement T1',
						prompt: 'TASK: 1.1 FILE: src/a.ts — do the thing',
					},
				},
			);
			expect(
				bindingFiles().length,
				'control leg: unmapped subagent event must not publish a binding',
			).toBe(0);

			// Mapped leg: the same event under the v1 names (what the adapter
			// now produces) engages the gate and publishes durably.
			await before.cb(
				makeV2SubagentEvent({
					id: 'call_mapped',
					input: {
						agent: 'coder',
						description: 'Implement T1',
						prompt: 'TASK: 1.1 FILE: src/a.ts — do the thing',
					},
				}) as V2ToolHookInput,
			);
			expect(
				bindingFiles().length,
				'mapped leg: v2-shaped event through the adapter must publish the coder scope binding',
			).toBeGreaterThan(0);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
