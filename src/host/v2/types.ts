/**
 * Vendored structural types for the OpenCode 2 plugin API.
 *
 * Provenance: distilled from `@opencode/plugin@2.0.26`
 * `dist/promise/{plugin,registration,tool,session,worktree,command,agent,event,storage,app,options}.d.ts`
 * and `@opencode/schema@2.0.26` `dist/{tool,agent,location}.d.ts`,
 * `@opencode/client@2.0.26` `dist/promise/generated/{client,types}.d.ts`,
 * `@opencode/ai` `dist/schema/messages.d.ts` (fetched 2026-10-09, issues #3004 / #3169).
 * Structural only — deliberately no runtime dependency on `@opencode/plugin`.
 *
 * Flattening note: the client's Effect-generated input types express optional fields as
 * `{ field: Body["field"] }` records; they are vendored here as plain optional fields of the
 * same types (e.g. `SessionCreateInput` is all-optional in the published form).
 *
 * Drift guard: SHIPPED with the #2910 dual-host work — the check-host-contract-v2 digest leg and the dual-host CI lane landed, and the weekly digest plus the vendored-pin freshness detector (scripts/drift-check.ts, reading this header's pin) now guard this corpus. See docs/host/v2-hook-inventory.md for the full v1-to-v2 map.
 *
 * Host-tolerance contract for the session/worktree method surface (issue #3169):
 * the members below are REQUIRED to mirror the published `SessionDomain`/`WorktreeDomain`.
 * Since Phase 2 the session-client shim (`src/host/v2/session-client.ts`) is the call
 * site — it feature-detects every member it consumes, including `hook` (`typeof
 * ctx.session.create === 'function'`), and returns `undefined` when any is missing, so
 * requiredness stays type-level only and a 2.0.2x host lacking a member must never crash
 * the adapter.
 *
 * Only the surfaces this adapter consumes are typed. Unknown fields are
 * intentionally left off; the adapter never relies on their absence.
 * Upstream: @opencode/plugin@2.0.26, @opencode/schema@2.0.26 and
 * @opencode/client@2.0.26 (MIT, sst/opencode).
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

/**
 * v2 session-call input types (`@opencode/client@2.0.26` generated types, flattened —
 * see the module header's flattening note). Only the fields with published evidence
 * are named; the index signature keeps them structural, not exhaustive.
 */

/** `Model.Ref` (schema/model.d.ts). */
export interface V2ModelRef {
	readonly id: string;
	readonly providerID: string;
	readonly variant?: string;
}

/** Session permission rule (schema/permission.d.ts shape on create/switch inputs). */
export interface V2SessionPermission {
	readonly action: string;
	readonly resource: string;
	readonly effect: 'allow' | 'deny' | 'ask';
}

/** `SessionCreateInput` — all-optional in the published (Effect-generated) form. */
export interface V2SessionCreateInput {
	readonly id?: string | null;
	readonly parentID?: string | null;
	readonly title?: string | null;
	readonly agent?: string | null;
	readonly model?: V2ModelRef | null;
	readonly location?: { readonly directory: string } | null;
	readonly metadata?: Readonly<Record<string, unknown>> | null;
	readonly permissions?: ReadonlyArray<V2SessionPermission> | null;
}

/**
 * `SessionPromptInput` (`@opencode/client@2.0.26` generated, flattened):
 * `sessionID` and `text` are required; `command`/`args` are NOT members of
 * this input (the command shape is `name` + `text` on `SessionCommandInput` —
 * the earlier fabricated members were removed in the PR-review feedback pass).
 * Attachment members are abbreviated structural shapes.
 */
export interface V2SessionPromptCallInput {
	readonly sessionID: string;
	readonly text: string;
	readonly id?: string | null;
	readonly files?: ReadonlyArray<{
		readonly uri: string;
		readonly name?: string;
		readonly description?: string;
	}>;
	readonly agents?: ReadonlyArray<{ readonly name: string }>;
	readonly skills?: ReadonlyArray<{ readonly id: string }>;
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly delivery?: 'steer' | 'queue' | null;
	readonly resume?: boolean | null;
	[key: string]: unknown;
}

/** `SessionSwitchAgentInput`. */
export interface V2SessionSwitchAgentInput {
	readonly sessionID: string;
	readonly agent: string;
}

/** `SessionSwitchModelInput`. */
export interface V2SessionSwitchModelInput {
	readonly sessionID: string;
	readonly model: V2ModelRef;
}

/** `SessionInterruptInput`. */
export interface V2SessionInterruptInput {
	readonly sessionID: string;
	readonly resume?: boolean;
}

/** `SessionInfo` — fields with published evidence; structural, not exhaustive. */
export interface V2SessionInfo {
	readonly id: string;
	readonly parentID?: string;
	readonly projectID: string;
	readonly agent?: string;
	readonly model?: V2ModelRef;
	readonly title?: string;
	readonly location: {
		readonly directory: string;
		[key: string]: unknown;
	};
	readonly time?: {
		readonly created: number;
		readonly updated: number;
		readonly idle?: number;
	};
	readonly outcome?: 'succeeded' | 'failed' | 'interrupted';
	[key: string]: unknown;
}

/** `SessionMessageInfo` union member (abbreviated; consumers read type + text). */
export interface V2SessionMessageInfo {
	readonly type?: string;
	[key: string]: unknown;
}

/**
 * v2 `SessionDomain` (dist/promise/session.d.ts 2.0.26): `Pick<SessionApi, "create" | "get" |
 * "remove" | "switchAgent" | "switchModel" | "prompt" | "generate" | "command" | "compact" |
 * "synthetic" | "interrupt" | "update" | "move" | "wait" | "context"> & { hook }`.
 *
 * `hook` names stay the 2.0.20-era three this adapter registers (context/compaction/prompt;
 * the published SessionHooks map has grown, but the adapter only registers these).
 */
export interface V2SessionDomain {
	readonly hook: (
		name: 'context' | 'compaction' | 'prompt',
		callback: (event: never) => Promise<void> | void,
	) => Promise<V2Registration>;
	readonly create: (input?: V2SessionCreateInput) => Promise<V2SessionInfo>;
	readonly get: (input: {
		readonly sessionID: string;
	}) => Promise<V2SessionInfo>;
	readonly remove: (input: { readonly sessionID: string }) => Promise<void>;
	readonly switchAgent: (input: V2SessionSwitchAgentInput) => Promise<void>;
	readonly switchModel: (input: V2SessionSwitchModelInput) => Promise<void>;
	/** Asynchronous: returns an inbox entry; pair with `wait` (issue #3169 Phase 2). */
	readonly prompt: (input: V2SessionPromptCallInput) => Promise<unknown>;
	readonly generate: (input: {
		readonly sessionID: string;
		[key: string]: unknown;
	}) => Promise<{ text: string }>;
	readonly command: (input: {
		readonly sessionID: string;
		[key: string]: unknown;
	}) => Promise<void>;
	readonly compact: (input: {
		readonly sessionID: string;
		[key: string]: unknown;
	}) => Promise<unknown>;
	readonly synthetic: (input: {
		readonly sessionID: string;
		[key: string]: unknown;
	}) => Promise<unknown>;
	readonly interrupt: (input: V2SessionInterruptInput) => Promise<unknown>;
	readonly update: (input: {
		readonly sessionID: string;
		[key: string]: unknown;
	}) => Promise<void>;
	readonly move: (input: {
		readonly sessionID: string;
		[key: string]: unknown;
	}) => Promise<void>;
	readonly wait: (input: { readonly sessionID: string }) => Promise<void>;
	readonly context: (input: {
		readonly sessionID: string;
	}) => Promise<V2SessionMessageInfo[]>;
}

/**
 * v2 worktree types (`@opencode/plugin@2.0.26` + `@opencode/client@2.0.26`).
 * The host publishes TWO distinct flavors — the client `WorktreeApi` inputs
 * (project-id keyed) and the plugin `WorktreeDefinition` callback inputs
 * (source-directory keyed) — and they must not be merged (PR-review feedback
 * FB-003): a caller against either flavor would compile and then fail
 * host-side at runtime.
 */

/** Client `WorktreeListInput` / `WorktreeRefreshInput` (project-id keyed). */
export interface V2WorktreeProjectInput {
	readonly projectID: string;
}

/** Client `WorktreeCreateInput`. */
export interface V2WorktreeCreateInput {
	readonly projectID: string;
	readonly from?: string;
	readonly branch?: string;
	readonly directory?: string;
	readonly name?: string;
	[key: string]: unknown;
}

/** Client `WorktreeRemoveInput`. */
export interface V2WorktreeRemoveInput {
	readonly projectID: string;
	readonly directory: string;
	readonly force: boolean;
}

/** Client `WorktreeInfo` (create result; `directory` is the only published member). */
export interface V2WorktreeInfo {
	readonly directory: string;
	[key: string]: unknown;
}

/** Plugin `WorktreeCreateInput` (the `../worktree.js` flavor — distinct from the client's). */
export interface V2PluginWorktreeCreateInput {
	readonly sourceDirectory: string;
	readonly directory: string;
	readonly branch?: string;
	[key: string]: unknown;
}

/** Plugin `WorktreeRemoveInput`. */
export interface V2PluginWorktreeRemoveInput {
	readonly directory: string;
	readonly force: boolean;
}

/** Plugin `WorktreeResult` (create return). */
export interface V2WorktreeResult {
	readonly directory: string;
	[key: string]: unknown;
}

/**
 * Plugin `WorktreeEntry` (list item). Only `directory` is published-verified
 * here; the structural index keeps the remaining fields without inventing shapes.
 */
export interface V2WorktreeEntry extends V2WorktreeResult {}

/** Plugin-side `WorktreeDefinition` (registers an implementation via transform). */
export interface V2WorktreeDefinition {
	readonly id: string;
	readonly create: (
		input: V2PluginWorktreeCreateInput,
		context: { readonly signal: AbortSignal },
	) => Promise<V2WorktreeResult>;
	readonly remove: (
		input: V2PluginWorktreeRemoveInput,
		context: { readonly signal: AbortSignal },
	) => Promise<void>;
	readonly list: (
		sourceDirectory: string,
		context: { readonly signal: AbortSignal },
	) => Promise<readonly V2WorktreeEntry[]>;
}

/** v2 `WorktreeEditor` (dist/promise/worktree.d.ts). */
export interface V2WorktreeEditor {
	/** Registers an implementation and selects it as the default. */
	add(definition: V2WorktreeDefinition): void;
}

/**
 * v2 `WorktreeDomain` (dist/promise/worktree.d.ts 2.0.26): the client
 * `WorktreeApi` (`list`/`create`/`remove`/`refresh`) plus `transform` and
 * `reload`. Consumed by no Phase 1 code path; typed so Phase 2+ (issue #3169)
 * sees the surface with the published requiredness intact.
 */
export interface V2WorktreeDomain {
	readonly list: (
		input: V2WorktreeProjectInput,
	) => Promise<readonly V2WorktreeInfo[]>;
	readonly create: (input: V2WorktreeCreateInput) => Promise<V2WorktreeInfo>;
	readonly remove: (input: V2WorktreeRemoveInput) => Promise<void>;
	readonly refresh: (input: V2WorktreeProjectInput) => Promise<void>;
	readonly reload: () => Promise<void>;
	readonly transform: (
		callback: (editor: V2WorktreeEditor) => void,
	) => Promise<V2Registration>;
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

/**
 * v2 `PermissionDomain` (only used for the v1 ask() bridge, best-effort).
 * `assert` is documented in `@opencode/plugin@2.0.29`
 * `dist/promise/permission.d.ts` and ABSENT at the 2.0.26 vendored pin —
 * feature-detected (`typeof === 'function'`) at the call site
 * (src/host/v2/tools.ts buildPermissionBridge, #3351).
 */
export interface V2PermissionDomain {
	/**
	 * Ask-side permission assertion (2.0.29+): input
	 * `{ sessionID: string; agent: string; action: string; resources: string[] }`;
	 * a resolution grants the request, a rejection denies it.
	 */
	assert?: (input: {
		sessionID: string;
		agent: string;
		action: string;
		resources: string[];
	}) => Promise<unknown>;
	/**
	 * Answer-side RPC `{ requestID, reply, message }` — the host's channel for
	 * ANSWERING a permission request, not for raising one. The bridge never
	 * interprets a resolved reply value as a grant (fail-closed; #3351
	 * decision — grant shapes stay uninterpreted pending live-host
	 * observation).
	 */
	reply?: (input: unknown) => Promise<unknown>;
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
	/** Present on 2.0.26 hosts; no Phase 1 code path consumes it (issue #3169). */
	readonly worktree?: V2WorktreeDomain;
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
