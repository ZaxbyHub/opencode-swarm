/**
 * v2 tool registration — issue #3151 (8.x port of the 7.x #3004 / #2910
 * adapter).
 *
 * Registers every tool from the SAME map the v1 host receives
 * (`hooks.tool` — the single source; the v1 factory's `tool: {...}` block and
 * this transform share the identical map).
 *
 * The execute adapter synthesizes the FULL v1 `ToolContext` (AGENTS.md
 * invariant 4: `.swarm/` must resolve against the project root captured at
 * setup, never `process.cwd()`): `directory`/`worktree` are injected, the v2
 * `signal` becomes the v1 `abort`, `progress` bridges v1 `metadata({title?,
 * metadata?})`, and `ask` bridges to the v2 permission domain when available
 * and fails closed otherwise.
 *
 * Result mapping: v1 `string | {title?, output, metadata?, attachments?}` →
 * v2 `{content, metadata}` (v2 has no title/attachment surface).
 */

import { log } from '@opencode-swarm/core';
import {
	normalizeV2AgentRef,
	seedV1SessionState,
	v2ToolInputSchema,
} from './setup';
import { withTimeout } from './timeout';
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

/** Synthesize the v1 ToolContext the plugin's tools expect. */
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

/** Map a v1 ToolResult onto the v2 Result shape (string arm included). */
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
	const permissionBridge = buildPermissionBridge(ctx);
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
										permissionBridge,
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
 * Best-effort bridge from the v1 `ask()` shape onto the v2 permission
 * domain. The v2 permission surface (ask/reply) differs structurally from the
 * v1 AskInput; until the per-tool permission port lands, presence of a
 * reply-capable domain is required to even attempt a bridge — otherwise
 * undefined, which makes ask() fail closed.
 */
function buildPermissionBridge(
	ctx: V2PluginContext,
): ((input: unknown) => Promise<void>) | undefined {
	const permission = ctx.permission;
	if (!permission || typeof permission.reply !== 'function') return undefined;
	return async (input: unknown): Promise<void> => {
		const askInput = input as
			| { permission?: unknown; patterns?: unknown }
			| undefined;
		log('v2 permission bridge invoked (best-effort passthrough)', {
			// Minimization: never log the ask payload body (paths, prompt text).
			permission:
				typeof askInput?.permission === 'string'
					? askInput.permission
					: 'unknown',
			patternCount: Array.isArray(askInput?.patterns)
				? askInput.patterns.length
				: 0,
		});
		await withTimeout(
			Promise.resolve(permission.reply?.(input)),
			V2_TOOL_EXECUTE_TIMEOUT_MS,
			new Error('[opencode-swarm] v2: permission reply exceeded budget'),
		);
	};
}

// Test seam (repo _internals convention): the ToolContext synthesis is the
// invariant-4 load-bearing surface (directory must be the setup-captured
// project root, never process.cwd()) — exposed for direct unit assertion.
export const _internals = { synthesizeV1ToolContext };
