/**
 * Epic Mode `epic_next_wave` tool (Epic v2 C2) — architect-only, gated by
 * `epic.mode.enabled` through `EPIC_AGENT_TOOL_MAP`.
 *
 * The single way forward while an epic is open: it closes the active wave
 * when every task is resolved (recording outcomes and divergence), keeps
 * phases in order, and issues the next wave with dispatch instructions.
 * Idempotent: calling it again while a wave runs returns `in-progress` for
 * the same wave. See `src/epic/next-wave.ts` for the full contract.
 */

import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { runEpicNextWave } from '../epic/next-wave.js';
import { createSwarmTool } from './create-tool.js';

/**
 * DI seam (AGENTS.md invariant 7); restore in afterEach.
 * @tool-opt-out Test-only dependency-injection seam; not a public tool.
 */
export const _internals = { runEpicNextWave };

export const epic_next_wave: ToolDefinition = createSwarmTool({
	description:
		'Epic Mode: the ONLY way forward while an epic is open. Call it and do exactly what its `status` says: `dispatch` (follow `instructions` — one Task per taskId, all in ONE message; per-task Stage A/B; update_task_status; then call again), `declare-scopes` (declare_scope per listed task, then call again), `in-progress` (finish the listed tasks), `blocked` (relay `message` and apply its remedy), `phase-ready-for-review` (epic_phase_review → the normal PHASE-WRAP: phase-wrap skill, docs agent, write_retro → phase_complete), `epic-complete` (tell the user to run /swarm epic close), `refused` (no usable epic: relay `message`). Idempotent; it closes finished waves (recording outcomes and divergence automatically) and never runs phase N+1 before phase N is complete. Takes no arguments.',
	args: {},
	execute: async (_args: unknown, directory: string, ctx) => {
		const result = await _internals.runEpicNextWave(
			directory,
			ctx?.sessionID && ctx.sessionID.length > 0 ? ctx.sessionID : undefined,
		);
		return JSON.stringify(result, null, 2);
	},
});
