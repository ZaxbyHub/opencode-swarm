/**
 * v2 lifecycle hook adapters — tool execute.before/after, session compaction,
 * session prompt (issue #3151, 8.x port of the 7.x #3004 / #2910 adapter).
 *
 * Each adapter wraps the SAME v1 handler functions with payload translation:
 *
 *   - `tool.execute.before`: v2 `{tool, sessionID, agent, messageID, id,
 *     input}` → v1 `{tool, sessionID, callID, agent}` + mutable output
 *     `{args}`; the v1 chain's `output.args` mutation is applied back onto
 *     `event.input` in place.
 *   - `tool.execute.after`: v1 `{title, output, metadata}` mutable output is
 *     fed a best-effort translation of the v2 completed/error result.
 *     (v2 has no title surface; the translation targets the fields the v1
 *     toolAfter chain reads.)
 *   - `compaction`: translated session/model identity. FB-005: the customizer
 *     receives a REAL `{context: string[]}` output (a bare `{}` turned every
 *     `output.context.push` into a TypeError once a project had plan/context
 *     content), and the collected context lines are mapped onto `event.system`
 *     — the compaction request's mutable system surface, the only
 *     type-declared carrier V2SessionCompactionEvent has for them (the v2
 *     `result?` field is a full skip-the-model short-circuit, not a context
 *     additive, so it is deliberately NOT used).
 *   - `prompt`: the v1 `chat.message` chain (delegation ledger,
 *     cache-cohort seeding) runs against a translated envelope.
 *
 * Denial semantics: a v1 hook throw propagates as the v2 hook error
 * (fail-closed preserved).
 */

import { log } from '@opencode-swarm/core';
import { normalizeV2AgentRef, seedV1SessionState } from './setup';
import { withTimeout } from './timeout';
import type {
	V1HooksSubset,
	V2PluginContext,
	V2Registration,
	V2SessionCompactionEvent,
	V2SessionPromptEvent,
	V2ToolHookInput,
} from './types';

const V2_HOOK_TIMEOUT_MS = 60_000;

/** adapter for tool.execute.before */
async function onV2ToolBefore(
	event: V2ToolHookInput,
	hooks: V1HooksSubset,
	directory: string,
): Promise<void> {
	const handler = hooks['tool.execute.before'];
	if (typeof handler !== 'function') return;
	seedV1SessionState(event.sessionID, event.agent, directory);
	const output = { args: event.input };
	await withTimeout(
		Promise.resolve(
			handler(
				{
					tool: event.tool,
					sessionID: event.sessionID,
					callID: event.id,
					agent: normalizeV2AgentRef(event.agent),
					messageID: event.messageID,
				},
				output,
			),
		),
		V2_HOOK_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: tool.execute.before exceeded budget'),
	);
	event.input = output.args;
}

/** adapter for tool.execute.after */
async function onV2ToolAfter(
	event: V2ToolHookInput,
	hooks: V1HooksSubset,
	directory: string,
): Promise<void> {
	const handler = hooks['tool.execute.after'];
	if (typeof handler !== 'function') return;
	seedV1SessionState(event.sessionID, event.agent, directory);
	const output = translateV2ResultToV1Output(event);
	await withTimeout(
		Promise.resolve(
			handler(
				{
					tool: event.tool,
					sessionID: event.sessionID,
					callID: event.id,
					agent: normalizeV2AgentRef(event.agent),
					messageID: event.messageID,
				},
				output,
			),
		),
		V2_HOOK_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: tool.execute.after exceeded budget'),
	).catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		// Ungated (FB-014/M-16): post-tool chain loss must be visible without
		// OPENCODE_SWARM_DEBUG. One line, no stack.
		console.warn(
			'[opencode-swarm] v2 tool.execute.after hook failed (non-fatal):',
			message,
		);
		log('v2 tool.execute.after failed (non-fatal)', {
			tool: event.tool,
			error: message,
		});
	});
}

function translateV2ResultToV1Output(event: V2ToolHookInput): {
	title: string;
	state: 'error' | 'completed';
	output: string;
	metadata: Record<string, unknown>;
} {
	if (event.status === 'error') {
		const message =
			event.error && typeof event.error.message === 'string'
				? event.error.message
				: 'tool error';
		return { title: 'error', state: 'error', output: message, metadata: {} };
	}
	const result = event.result;
	const content =
		typeof result?.content === 'string'
			? result.content
			: Array.isArray(result?.content)
				? (result?.content as Array<{ type: string; text?: string }>)
						.filter((p) => p.type === 'text' && typeof p.text === 'string')
						.map((p) => p.text)
						.join('\n')
				: '';
	return {
		title: '',
		state: 'completed',
		output: content,
		metadata: (result?.metadata as Record<string, unknown>) ?? {},
	};
}

/** adapter for session compaction */
async function onV2Compaction(
	event: V2SessionCompactionEvent,
	hooks: V1HooksSubset,
	directory: string,
): Promise<void> {
	const handler = hooks['experimental.session.compacting'];
	if (typeof handler !== 'function') return;
	seedV1SessionState(event.sessionID, event.agent, directory);
	const model = event.model as { id?: string; providerID?: string } | undefined;
	// FB-005: real output shape. The v1 customizer pushes directive lines onto
	// output.context (packages/core compaction-customizer.ts) — a bare `{}`
	// output made each push a TypeError as soon as plan/context content
	// existed, and the .catch below silently ate it. (The customizer never
	// writes output.prompt; the field stays open on the object anyway.)
	const output = { context: [] as string[] };
	await withTimeout(
		Promise.resolve(
			handler(
				{
					sessionID: event.sessionID,
					providerID:
						typeof model?.providerID === 'string'
							? model.providerID
							: 'unknown',
					modelID: typeof model?.id === 'string' ? model.id : 'unknown',
				},
				output,
			),
		),
		V2_HOOK_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: compaction hook exceeded budget'),
	).catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		// Ungated (FB-014/M-16): compaction-context loss must be visible
		// without OPENCODE_SWARM_DEBUG. One line, no stack.
		console.warn(
			'[opencode-swarm] v2 compaction hook failed (non-fatal):',
			message,
		);
		log('v2 compaction hook failed (non-fatal)', { error: message });
	});
	// Map the collected context lines onto event.system: V2SessionCompactionEvent
	// carries no `context` field, and its `result?` is a skip-the-model
	// short-circuit — system is the compaction request's mutable prompt surface
	// and the faithful carrier for the customizer's preserve-directives.
	event.system = event.system ?? [];
	for (const line of output.context) {
		if (typeof line === 'string' && line.length > 0) {
			event.system.push({ type: 'text', text: line });
		}
	}
}

/** adapter for session prompt (v1 chat.message chain) */
async function onV2Prompt(
	event: V2SessionPromptEvent,
	hooks: V1HooksSubset,
): Promise<void> {
	const handler = hooks['chat.message'];
	if (typeof handler !== 'function') return;
	const text = event.prompt?.text ?? '';
	const message = {
		id: event.messageID,
		role: 'user',
		sessionID: event.sessionID,
	};
	const parts = [{ type: 'text', text }];
	// Delta D8 (FB-014): the v2 prompt event carries no agent field, so the v1
	// delegation tracker's per-prompt agent input cannot be forwarded from v2
	// (tracker resets to architect per prompt; session identity still seeds via
	// tool hooks). Registration of the agent surface is tracked in #3160.
	const input = {
		sessionID: event.sessionID,
		message: { ...message },
		parts: [...parts],
	};
	const output = { message: { ...message }, parts: [...parts] };
	await withTimeout(
		Promise.resolve(handler(input, output)),
		V2_HOOK_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: prompt hook exceeded budget'),
	).catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		// Ungated (FB-014/M-16): prompt-chain loss must be visible without
		// OPENCODE_SWARM_DEBUG. One line, no stack.
		console.warn(
			'[opencode-swarm] v2 prompt hook failed (non-fatal):',
			message,
		);
		log('v2 prompt (chat.message) hook failed (non-fatal)', {
			error: message,
		});
	});
	// The v1 chain mutates output.message/output.parts in place; the v2
	// SessionPrompt's own fields stay authoritative.
	if (typeof event.prompt === 'object' && event.prompt !== null) {
		const rewritten = (
			output.parts as Array<{ type: string; text?: string }>
		).find((p) => p.type === 'text' && typeof p.text === 'string');
		if (
			rewritten &&
			typeof rewritten.text === 'string' &&
			rewritten.text !== text
		) {
			event.prompt.text = rewritten.text;
		}
	}
}

/** Register the tool hooks (execute.before/after). */
export async function registerV2ToolHooks(
	ctx: V2PluginContext,
	hooks: V1HooksSubset,
	directory: string,
	registrations: V2Registration[],
): Promise<void> {
	const before: Promise<V2Registration> = ctx.tool.hook(
		'execute.before',
		async (event: unknown) => {
			return onV2ToolBefore(event as V2ToolHookInput, hooks, directory);
		},
	);
	// Track the moment each registration resolves (M-7): a late resolve after
	// a timeout win must still reach the cleanup list. Rejection pushes nothing.
	before
		.then((reg) => {
			registrations.push(reg);
		})
		.catch(() => {
			// withTimeout surfaces the rejection below; nothing to track.
		});
	await withTimeout(
		before,
		V2_HOOK_TIMEOUT_MS,
		new Error(
			'[opencode-swarm] v2: execute.before registration exceeded budget',
		),
	);
	const after: Promise<V2Registration> = ctx.tool.hook(
		'execute.after',
		async (event: unknown) => {
			return onV2ToolAfter(event as V2ToolHookInput, hooks, directory);
		},
	);
	after
		.then((reg) => {
			registrations.push(reg);
		})
		.catch(() => {
			// withTimeout surfaces the rejection below; nothing to track.
		});
	await withTimeout(
		after,
		V2_HOOK_TIMEOUT_MS,
		new Error(
			'[opencode-swarm] v2: execute.after registration exceeded budget',
		),
	);
}

/** Register the compaction + prompt session hooks. */
export async function registerV2SessionHooks(
	ctx: V2PluginContext,
	hooks: V1HooksSubset,
	directory: string,
	registrations: V2Registration[],
): Promise<void> {
	const compaction: Promise<V2Registration> = ctx.session.hook(
		'compaction',
		(async (event: unknown) => {
			return onV2Compaction(
				event as V2SessionCompactionEvent,
				hooks,
				directory,
			);
		}) as never,
	);
	compaction
		.then((reg) => {
			registrations.push(reg);
		})
		.catch(() => {
			// withTimeout surfaces the rejection below; nothing to track.
		});
	await withTimeout(
		compaction,
		V2_HOOK_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: compaction registration exceeded budget'),
	);
	const prompt: Promise<V2Registration> = ctx.session.hook('prompt', (async (
		event: unknown,
	) => {
		return onV2Prompt(event as V2SessionPromptEvent, hooks);
	}) as never);
	prompt
		.then((reg) => {
			registrations.push(reg);
		})
		.catch(() => {
			// withTimeout surfaces the rejection below; nothing to track.
		});
	await withTimeout(
		prompt,
		V2_HOOK_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: prompt registration exceeded budget'),
	);
}
