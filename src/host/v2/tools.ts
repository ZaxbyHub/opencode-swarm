/**
 * v2 tool registration — issue #3004 / #2910.
 *
 * Registers every tool from the SAME map the v1 host receives
 * (`hooks.tool`, built by `buildPluginToolObject` from `TOOL_MANIFEST` — the
 * single source; scripts/check-tool-registration.ts enforces that no parallel
 * name list exists here).
 *
 * The execute adapter synthesizes the FULL v1 `ToolContext` (AGENTS.md
 * invariant 4: `.swarm/` must resolve against the project root captured at
 * setup, never `process.cwd()`): `directory`/`worktree` are injected, the v2
 * `signal` becomes the v1 `abort`, `progress` bridges v1 `metadata({title?,
 * metadata?})`, and `ask` bridges to the v2 permission domain when available
 * and fails closed otherwise.
 *
 * Result mapping: v1 `string | {title?, output, metadata?, attachments?}` →
 * v2 `{content, metadata}` (v2 has no title/attachment surface — inventory
 * row in docs/host/v2-hook-inventory.md).
 */

import { log } from '../../utils';
import { withTimeout } from '../../utils/timeout';
import { normalizeV2PermissionAction } from './agents-commands';
import {
	normalizeV2AgentRef,
	seedV1SessionState,
	v2ToolInputSchema,
} from './setup';
import type {
	V1HooksSubset,
	V2PluginContext,
	V2Registration,
	V2ToolContext,
	V2ToolInfo,
	V2ToolResult,
} from './types';

/** Bound for a single tool execution on the v2 path (invariant 3: bounded subprocesses/tools). */
const V2_TOOL_EXECUTE_TIMEOUT_MS = 10 * 60_000;

interface V1ToolContextShape {
	sessionID: string;
	messageID: string;
	agent: string;
	directory: string;
	worktree: string;
	abort: AbortSignal;
	metadata: (input: {
		title?: string;
		metadata?: Record<string, unknown>;
	}) => void;
	ask: (input: unknown) => Promise<void>;
}

/** Synthesize the v1 ToolContext the plugin's tools expect (R2 in ADR-0003). */
function synthesizeV1ToolContext(
	context: V2ToolContext,
	projectRoot: string,
	permissionBridge: ((input: unknown) => Promise<void>) | undefined,
): V1ToolContextShape {
	const agentName = normalizeV2AgentRef(context.agent) ?? 'architect';
	return {
		sessionID: context.sessionID,
		messageID: context.messageID,
		agent: agentName,
		// Invariant 4: the project root captured at setup, NOT process.cwd().
		directory: projectRoot,
		worktree: projectRoot,
		abort: context.signal,
		metadata: (input: {
			title?: string;
			metadata?: Record<string, unknown>;
		}) => {
			try {
				const progress = context.progress as
					| ((update: Record<string, unknown>) => Promise<void>)
					| undefined;
				if (typeof progress === 'function') {
					void progress({
						...(input.metadata ?? {}),
						...(input.title !== undefined ? { title: input.title } : {}),
					});
				}
			} catch {
				// Progress is best-effort; never fail a tool on it.
			}
		},
		ask: async (input: unknown): Promise<void> => {
			if (permissionBridge) {
				await withTimeout(
					Promise.resolve(permissionBridge(input)),
					V2_TOOL_EXECUTE_TIMEOUT_MS,
					new Error('[opencode-swarm] v2: permission bridge exceeded budget'),
				);
				return;
			}
			// Fail closed: no interactive permission surface on this host yet.
			throw new Error(
				'[opencode-swarm] v2: interactive tool permission request unavailable (no permission surface); denying by default.',
			);
		},
	};
}

/** Map a v1 ToolResult onto the v2 Result shape (N-a: string arm included). */
function mapV1ToolResult(result: unknown): V2ToolResult {
	if (typeof result === 'string') {
		return { content: result };
	}
	if (result && typeof result === 'object') {
		const rec = result as { output?: unknown; metadata?: unknown };
		return {
			...(typeof rec.output === 'string' ? { content: rec.output } : {}),
			...(rec.metadata && typeof rec.metadata === 'object'
				? { metadata: rec.metadata as Record<string, unknown> }
				: {}),
		};
	}
	return { content: String(result ?? '') };
}

/** Register all v1 tools on the v2 tool domain. */
export async function registerV2Tools(
	ctx: V2PluginContext,
	hooks: V1HooksSubset,
	projectRoot: string,
	registrations: V2Registration[],
): Promise<void> {
	const toolMap = hooks.tool ?? {};
	const registration = await withTimeout(
		ctx.tool.transform((editor) => {
			for (const [name, definition] of Object.entries(toolMap)) {
				const v1Execute = definition.execute;
				if (typeof v1Execute !== 'function') continue;
				const info: V2ToolInfo = {
					name,
					description: definition.description ?? '',
					input: v2ToolInputSchema(definition.args),
					execute: async (input: unknown, context: V2ToolContext) => {
						seedV1SessionState(context.sessionID, context.agent, projectRoot);
						const result = await withTimeout(
							Promise.resolve(
								v1Execute(
									input,
									synthesizeV1ToolContext(
										context,
										projectRoot,
										// #3351: built PER-EXECUTE — the assert input carries
										// this execution's sessionID/agent.
										buildPermissionBridge(ctx, context),
									),
								),
							),
							V2_TOOL_EXECUTE_TIMEOUT_MS,
							new Error(
								`[opencode-swarm] v2: tool ${name} exceeded execution budget`,
							),
						);
						return mapV1ToolResult(result);
					},
				};
				editor.add(info);
			}
		}),
		V2_TOOL_EXECUTE_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: tool transform exceeded budget'),
	);
	registrations.push(registration);
}

/**
 * Bridge from the v1 `ask()` payload onto the v2 permission domain (#3351
 * fail-closed). Built per-execute so the assert input can carry the CURRENT
 * tool execution's sessionID/agent.
 *
 *  - assert-capable hosts (documented in @opencode/plugin@2.0.29
 *    dist/promise/permission.d.ts; ABSENT at the 2.0.26 vendored pin, hence
 *    the `typeof === 'function'` feature-detect): `ask()` routes through
 *    `permission.assert({ sessionID, agent, action, resources })` — action
 *    normalized by the EXACT host v1→v2 table (normalizeV2PermissionAction,
 *    shared with the #2910 W2 agent permission port), resources = the ask
 *    payload's patterns array (default []). Resolution grants; rejection
 *    denies. `reply` is NOT consulted when assert exists.
 *  - reply-only hosts (the 2.0.26 shape): ANY resolved reply value DENIES —
 *    no grant interpretation at all. reply is the host's ANSWER-side RPC
 *    `{ requestID, reply, message }`, not an ask surface; grant shapes are
 *    deliberately uninterpreted pending the live-host observation recorded on
 *    https://github.com/ZaxbyHub/opencode-swarm/issues/3351#issuecomment-6388938061.
 *    A rejecting reply still denies (the await rejects through).
 *  - No permission domain (or neither member): undefined, which makes ask()
 *    fail closed with the 'denying by default' denial.
 */
function buildPermissionBridge(
	ctx: V2PluginContext,
	context: V2ToolContext,
): ((input: unknown) => Promise<void>) | undefined {
	const permission = ctx.permission;
	if (!permission) return undefined;
	if (typeof permission.assert === 'function') {
		const assert = permission.assert;
		const agentName = normalizeV2AgentRef(context.agent) ?? 'architect';
		return async (input: unknown): Promise<void> => {
			const askInput = input as
				| { permission?: unknown; patterns?: unknown }
				| undefined;
			const action = normalizeV2PermissionAction(
				typeof askInput?.permission === 'string' ? askInput.permission : '',
			);
			const resources = Array.isArray(askInput?.patterns)
				? askInput.patterns
				: [];
			log('v2 permission bridge ask routed through assert', {
				// Minimization: never log the ask payload body (paths, prompt text).
				action,
				resourceCount: resources.length,
			});
			await withTimeout(
				Promise.resolve(
					assert({
						sessionID: context.sessionID,
						agent: agentName,
						action,
						resources,
					}),
				),
				V2_TOOL_EXECUTE_TIMEOUT_MS,
				new Error('[opencode-swarm] v2: permission assert exceeded budget'),
			);
		};
	}
	if (typeof permission.reply === 'function') {
		const reply = permission.reply;
		return async (input: unknown): Promise<void> => {
			log('v2 permission bridge invoked (reply-only host; fail-closed)', {
				// Minimization: never log the ask payload body (paths, prompt text).
				permission:
					typeof (input as { permission?: unknown } | undefined)?.permission ===
					'string'
						? (input as { permission: string }).permission
						: 'unknown',
				patternCount: Array.isArray(
					(input as { patterns?: unknown } | undefined)?.patterns,
				)
					? (input as { patterns: unknown[] }).patterns.length
					: 0,
			});
			await withTimeout(
				Promise.resolve(reply(input)).then(() => {
					// ANY resolution denies: the resolved value is the answer-side
					// RPC's acknowledgement shape, never a grant decision.
					throw new Error(
						'[opencode-swarm] v2: permission ask denied — the reply surface resolved without a grant decision (fail-closed, #3351).',
					);
				}),
				V2_TOOL_EXECUTE_TIMEOUT_MS,
				new Error('[opencode-swarm] v2: permission reply exceeded budget'),
			);
		};
	}
	return undefined;
}

// Test seam (repo _internals convention): the ToolContext synthesis is the
// invariant-4 load-bearing surface (directory must be the setup-captured
// project root, never process.cwd()) — exposed for direct unit assertion.
export const _internals = { synthesizeV1ToolContext };
