/**
 * Vendored structural types for the OpenCode 2 plugin API.
 *
 * Provenance: distilled from `@opencode/plugin@2.0.20`
 * `dist/promise/{plugin,registration,tool,session,command,agent,event,storage,app,options}.d.ts`
 * and `@opencode/schema@2.0.20` `dist/{tool,agent,location}.d.ts`,
 * `@opencode/ai` `dist/schema/messages.d.ts` (fetched 2026-09-30, issue #3004).
 * Structural only — deliberately no runtime dependency on `@opencode/plugin`.
 *
 * Drift guard: DEFERRED to the #2910 follow-up PR (a check-host-contract v2 digest leg over this corpus, plus the dual-host CI lane); until it lands, type truth rests on this provenance pin and the live-host smoke. See docs/host/v2-hook-inventory.md for the full v1-to-v2 map.
 *
 * Only the surfaces this adapter consumes are typed. Unknown fields are
 * intentionally left off; the adapter never relies on their absence.
 * Upstream: @opencode/plugin@2.0.20 and @opencode/schema@2.0.20 (MIT, sst/opencode).
 */

/** v2 `App` — host identity (dist/app.d.ts). */
export interface V2App {
	readonly name: string;
	readonly version: string;
	readonly channel: string;
}

/** v2 `Location.Info` — project anchor (dist/location.d.ts). */
export interface V2Location {
	readonly directory: string;
	readonly workspaceID?: string;
	readonly project?: {
		readonly id?: string;
		readonly directory?: string;
		readonly canonical?: string;
	};
}

/** v2 `PluginOptions` (dist/options.d.ts). */
export type V2PluginOptions = Readonly<Record<string, unknown>>;

/** v2 `Registration` (dist/promise/registration.d.ts). */
export interface V2Registration {
	readonly dispose: () => Promise<void>;
}

/** v2 `Tool.Result` content parts (schema/tool.d.ts). */
export type V2ToolContent =
	| { readonly type: 'text'; readonly text: string }
	| {
			readonly type: 'file';
			readonly uri: string;
			readonly mime: string;
			readonly name?: string;
	  };

/** v2 `Tool.Result` (schema/tool.d.ts). */
export interface V2ToolResult {
	readonly output?: unknown;
	readonly content?: string | ReadonlyArray<V2ToolContent>;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

/** v2 tool `ToolContext` (dist/promise/tool.d.ts). */
export interface V2ToolContext {
	readonly sessionID: string;
	readonly agent: unknown;
	readonly messageID: string;
	readonly id: string;
	readonly signal: AbortSignal;
	readonly progress: (
		update: Readonly<Record<string, unknown>>,
	) => Promise<void>;
}

/** v2 `Tool.Info` shape accepted by `ToolEditor.add` (dist/promise/tool.d.ts). */
export interface V2ToolInfo {
	readonly name: string;
	readonly description: string;
	readonly input: unknown;
	readonly execute: (
		input: unknown,
		context: V2ToolContext,
	) => Promise<V2ToolResult>;
}

/** v2 `ToolEditor` (dist/promise/tool.d.ts). */
export interface V2ToolEditor {
	add(tool: V2ToolInfo): void;
	list(): Array<V2ToolInfo & { readonly id: string }>;
	get(id: string): (V2ToolInfo & { readonly id: string }) | undefined;
	update(id: string, update: (tool: unknown) => void): void;
	remove(id: string): void;
	namespace(namespace: {
		readonly name: string;
		readonly description: string;
	}): void;
}

/** v2 `ToolDomain` (dist/promise/tool.d.ts) — hook payloads inline. */
export interface V2ToolDomain {
	readonly transform: (
		callback: (editor: V2ToolEditor) => void,
	) => Promise<V2Registration>;
	readonly reload: () => Promise<void>;
	readonly hook: (
		name: 'execute.before' | 'execute.after',
		callback: (input: V2ToolHookInput) => Promise<void> | void,
	) => Promise<V2Registration>;
}

export interface V2ToolHookInput {
	readonly tool: string;
	readonly sessionID: string;
	readonly agent: unknown;
	readonly messageID: string;
	readonly id: string;
	input?: unknown;
	readonly status?: 'completed' | 'error';
	readonly result?: V2ToolResult;
	readonly error?: { message?: string; [key: string]: unknown };
}

/** v2 text part on the system surface (`SystemPart`, @opencode/ai messages.d.ts). */
export interface V2SystemPart {
	type: 'text';
	text: string;
	cache?: unknown;
	metadata?: Record<string, unknown>;
}

/** v2 `Message` (abbreviated to the text-relevant surface). */
export interface V2Message {
	id?: string;
	role: 'system' | 'user' | 'assistant' | 'tool';
	/**
	 * Producing agent id (v2 SDK UserMessage requires `agent: string` —
	 * @opencode/ai messages schema). Optional here: only user-role messages
	 * carry it, and the adapter fails open when absent. The v1 chain's
	 * agent-gated consumers (context-budget, pipeline-tracker) read it through
	 * the translated `info.agent` view field.
	 */
	agent?: string;
	content: Array<{ type: string; text?: string; [key: string]: unknown }>;
	[key: string]: unknown;
}

/** v2 `SessionContext` event (dist/promise/session.d.ts; DeepMutable in place). */
export interface V2SessionContextEvent {
	readonly sessionID: string;
	readonly agent: unknown;
	readonly model?: { id?: string; providerID?: string; [key: string]: unknown };
	system: V2SystemPart[];
	messages: V2Message[];
	options: Record<string, unknown>;
	tools: Record<string, { description: string; input: unknown }>;
}

/** v2 `SessionCompaction` event (extends SessionContext + settable result). */
export interface V2SessionCompactionEvent extends V2SessionContextEvent {
	result?: { summary: string; [key: string]: unknown };
}

/** v2 `SessionPrompt` event (dist/promise/session.d.ts). */
export interface V2SessionPromptEvent {
	readonly sessionID: string;
	readonly messageID: string;
	prompt: {
		text: string;
		files?: unknown[];
		agents?: unknown[];
		skills?: unknown[];
	};
	readonly delivery?: string;
}

/** v2 `SessionDomain` (only surfaces used by this adapter). */
export interface V2SessionDomain {
	readonly hook: (
		name: 'context' | 'compaction' | 'prompt',
		callback: (event: never) => Promise<void> | void,
	) => Promise<V2Registration>;
	readonly prompt?: (
		sessionID: string,
		input: { text: string } | { command: string; args?: string },
	) => Promise<unknown>;
	/**
	 * v2 `session.synthetic` (@opencode/client SessionApi — part of the SDK
	 * SessionDomain `Pick`; typed here only to the subset this adapter
	 * passes). Admits text into the session without persisting it as user
	 * input; `resume: false` declines to wake the model, making it the v2
	 * carrier for deterministic command output (the v1 `output.parts`
	 * analog). Optional: older 2.x hosts lack it; callers must degrade.
	 */
	readonly synthetic?: (input: {
		sessionID: string;
		text: string;
		resume?: boolean;
	}) => Promise<unknown>;
}

/** v2 `CommandDefinition` / `CommandEditor` (dist/promise/command.d.ts). */
export interface V2CommandInvocation {
	readonly sessionID: string;
	readonly prompt: { text: string; [key: string]: unknown };
	readonly delivery?: string;
}
export interface V2CommandDefinition {
	readonly name: string;
	readonly description?: string;
	readonly execute: (input: V2CommandInvocation) => Promise<void>;
}
export interface V2CommandDomain {
	readonly transform: (
		callback: (editor: { add(definition: V2CommandDefinition): void }) => void,
	) => Promise<V2Registration>;
	readonly reload: () => Promise<void>;
}

/** v2 `Agent.Info` (schema/agent.d.ts; only fields this adapter writes). */
export interface V2AgentInfo {
	id: string;
	name: string;
	mode: 'subagent' | 'primary' | 'all';
	hidden: boolean;
	request: {
		settings: Record<string, unknown>;
		headers: Record<string, string>;
		body: Record<string, unknown>;
	};
	system?: string;
	description?: string;
	model?: { id: string; providerID: string; variant?: string };
	permissions?: Array<{
		action: string;
		resource: string;
		effect: 'allow' | 'deny' | 'ask';
	}>;
}

/** v2 `AgentEditor` (dist/promise/agent.d.ts). */
export interface V2AgentEditor {
	list(): V2AgentInfo[];
	get(id: string): V2AgentInfo | undefined;
	default(id: string | undefined): void;
	update(id: string, update: (agent: V2AgentInfo) => void): void;
	remove(id: string): void;
}

/** v2 `AgentDomain`. */
export interface V2AgentDomain {
	readonly transform: (
		callback: (editor: V2AgentEditor) => void,
	) => Promise<V2Registration>;
	readonly reload: () => Promise<void>;
}

/** v2 `EventDomain.subscribe` — async iterable of host events. */
export interface V2EventEnvelope {
	readonly type?: string;
	readonly [key: string]: unknown;
}
export interface V2EventDomain {
	readonly subscribe?: (
		...args: unknown[]
	) => AsyncIterable<V2EventEnvelope> | Promise<AsyncIterable<V2EventEnvelope>>;
}

/** v2 `PermissionDomain` (only used for the v1 ask() bridge, best-effort). */
export interface V2PermissionDomain {
	readonly reply?: (input: unknown) => Promise<unknown>;
	readonly list?: () => Promise<unknown[]>;
	readonly hook?: (
		name: 'evaluate',
		callback: (input: unknown) => Promise<void> | void,
	) => Promise<V2Registration>;
}

/**
 * v2 `Context` (dist/promise/plugin.d.ts) — only the domains this adapter
 * touches; everything else stays reachable through the index signature so a
 * superset host context is accepted.
 */
export interface V2PluginContext {
	readonly app: V2App;
	readonly location: V2Location;
	readonly options: V2PluginOptions;
	readonly tool: V2ToolDomain;
	readonly agent: V2AgentDomain;
	readonly command: V2CommandDomain;
	readonly session: V2SessionDomain;
	readonly event: V2EventDomain;
	readonly permission?: V2PermissionDomain;
	readonly [key: string]: unknown;
}

/** v2 `Cleanup` — the return of `setup`. */
export type V2Cleanup = () => Promise<void> | void;

/** The v1-shaped hooks object the adapter consumes (structural subset). */
export interface V1HooksSubset {
	name?: string;
	tool?: Record<
		string,
		{
			description?: string;
			args?: unknown;
			execute?: (args: unknown, ctx: unknown) => Promise<unknown>;
		}
	>;
	agent?: Record<string, unknown>;
	config?: (opencodeConfig: Record<string, unknown>) => Promise<void>;
	event?: (input: {
		event: { type?: string; properties?: Record<string, unknown> };
	}) => Promise<void>;
	dispose?: () => Promise<void>;
	'command.execute.before'?: (input: unknown, output: unknown) => Promise<void>;
	'tool.execute.before'?: (
		input: unknown,
		output: unknown,
	) => Promise<unknown> | Promise<void>;
	'tool.execute.after'?: (
		input: unknown,
		output: unknown,
	) => Promise<unknown> | Promise<void>;
	'chat.message'?: (
		input: unknown,
		output: unknown,
	) => Promise<unknown> | Promise<void>;
	'experimental.chat.messages.transform'?: (
		input: unknown,
		output: { messages: unknown[] },
	) => Promise<void>;
	'experimental.chat.system.transform'?: (
		input: { sessionID?: string; model?: unknown },
		output: { system: string[] },
	) => Promise<void>;
	'experimental.session.compacting'?: (
		input: unknown,
		output: unknown,
	) => Promise<void>;
}
