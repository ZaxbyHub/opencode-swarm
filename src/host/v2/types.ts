/**
 * Vendored structural types for the OpenCode 2 plugin API.
 *
 * Provenance: distilled from `@opencode/plugin@2.3.0`
 * `dist/promise/{plugin,registration,tool,session,worktree,command,agent,event,storage,app,options}.d.ts`
 * and `@opencode/schema@2.3.0` `dist/{tool,agent,location}.d.ts`,
 * `@opencode/client@2.3.0` `dist/promise/generated/{client,types}.d.ts`,
 * `@opencode/ai` `dist/schema/messages.d.ts` (fetched 2026-10-09, issues #3004 / #3169;
 * the 2.3.0 refresh verified the drifted declarations against the tagged tarballs —
 * issues #3732 / #3552; see the actual-alias probe evidence in that trace).
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
 * Upstream: @opencode/plugin@2.3.0, @opencode/schema@2.3.0 and
 * @opencode/client@2.3.0 (MIT, sst/opencode).
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

/**
 * v2 `ShellCreateBefore` payload (dist/promise/shell.d.ts @2.0.29). The
 * `shell` field is the resolved shell PATH the host will execute the
 * command with (upstream `ShellSelect` resolution) — the authoritative
 * executor report the write gate keys cmd/powershell grammar inheritance
 * on (#3346).
 */
export interface V2ShellCreateBefore {
	readonly command: string;
	readonly cwd: string;
	readonly timeout: number;
	readonly shell: string;
	readonly env: Record<string, string | undefined>;
}

/** v2 `ShellDomain` (dist/promise/shell.d.ts @2.0.29) — hook payloads inline. */
export interface V2ShellDomain {
	readonly hook: <K extends 'create.before'>(
		event: K,
		handler: (payload: V2ShellCreateBefore) => Promise<void> | void,
	) => Promise<unknown> | unknown;
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

/** v2 `SessionRequestMessage` (@2.3.0 `Message & { readonly metadata? }`). Standalone
 *  (not extending V2Message): the published Message carries a READONLY content array
 *  with nullable part text and sealed part interfaces (no index signature), so the
 *  V2Message-based shape broke published-payload assignability (probe-verified in the
 *  #3732/#3552 trace). */
export interface V2SessionRequestMessage {
	id?: string;
	role: 'system' | 'user' | 'assistant' | 'tool';
	readonly content: ReadonlyArray<{
		readonly type: string;
		readonly text?: string | null;
	}>;
	readonly metadata?: Record<string, unknown>;
}

/** v2 `SessionContext` event (dist/promise/session.d.ts). The published message content is readonly @2.3.0; the adapter mutates the `system`/`messages` ARRAYS in place and replaces claimed message elements inside them. */
export interface V2SessionContextEvent {
	readonly sessionID: string;
	readonly agent: unknown;
	readonly model?: { id?: string; providerID?: string; [key: string]: unknown };
	system: V2SystemPart[];
	messages: V2SessionRequestMessage[];
	options: Record<string, unknown>;
	tools: Record<string, { description: string; input: unknown }>;
}

/** v2 `SessionCompactionResult` (@2.3.0) — explicit fields, NO index signature: the
 *  published interface has none, and the old `[key: string]: unknown` blocked the
 *  whole published-hook assignment (probe-verified in the #3732/#3552 trace). */
export interface V2SessionCompactionResult {
	summary: string;
	/** Provider replacement window (`SessionMessage.Native` is a plain record at
	 *  2.3.0); replays instead of `summary` when set. */
	native?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	tokens?: unknown;
}

/** v2 `SessionCompaction` event (extends SessionContext + settable result). */
export interface V2SessionCompactionEvent extends V2SessionContextEvent {
	result?: V2SessionCompactionResult;
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

/** Tagged client `JsonValue` (@2.3.0), recursive — the input type of
 *  `session.instructions.entry.put`. */
export type V2JsonValue =
	| null
	| boolean
	| number
	| string
	| V2JsonValue[]
	| { [key: string]: V2JsonValue };

/** @2.3.0 `SessionRequestKind` — why a Session request is being made. */
export type V2SessionRequestKind =
	| 'primary'
	| 'compaction'
	| 'title'
	| 'generate';

/**
 * @2.3.0 `SessionModelResolve` (`experimental.model.resolve` hook payload): runs
 * whenever a Session resolves the model for a request; `model` is mutable — change it
 * to serve the request with another model while the Session keeps its selection.
 * Experimental upstream. Adoption is tracked under #3642 (not consumed here).
 */
export interface V2SessionModelResolve {
	readonly sessionID: string;
	readonly agent: string;
	readonly kind: V2SessionRequestKind;
	model: {
		readonly id: string;
		readonly providerID: string;
		[key: string]: unknown;
	};
}

/**
 * @2.3.0 `SessionIdleBackground` — background work still running for the idle Session
 * or one of its descendants; `sessionID` names the owning Session.
 */
export type V2SessionIdleBackground =
	| {
			readonly kind: 'shell';
			readonly sessionID: string;
			readonly shellID: string;
			readonly command: string;
	  }
	| {
			readonly kind: 'subagent';
			readonly sessionID: string;
			readonly childSessionID: string;
			readonly agent: string;
			readonly description: string;
	  }
	| {
			readonly kind: 'image';
			readonly sessionID: string;
			readonly path: string;
			readonly model: string;
	  };

/**
 * @2.3.0 `SessionIdle` (`experimental.idle` payload): runs when a Session finishes
 * model work with no pending input, just before it goes idle. Semantically distinct
 * from the v1 `session.idle` event the adapter already translates
 * (src/host/v2/events.ts): the hook carries background-work state and runs on a
 * different schedule. Adoption is tracked under #3642 (not consumed here).
 */
export interface V2SessionIdle {
	readonly sessionID: string;
	readonly background: ReadonlyArray<V2SessionIdleBackground>;
}

/** @2.3.0 client `SessionListInput` (paginated list filters; all optional). */
export interface V2SessionListInput {
	readonly limit?: number;
	readonly order?: 'asc' | 'desc';
	readonly search?: string;
	readonly parentID?: string | null;
	readonly archived?: boolean;
	readonly directory?: string;
	readonly project?: string;
	readonly subpath?: string;
	readonly cursor?: string;
}

/** @2.3.0 client `SessionsResponse` — a `data` page plus cursors. */
export interface V2SessionsResponse {
	data: V2SessionInfo[];
	cursor: { previous?: unknown; next?: unknown };
}

/** Payload map for the session hook names this file types (@2.3.0 `SessionHooks`
 *  subset + the fork/experimental additions). The adapter registers only
 *  context/compaction/prompt today. */
export interface V2SessionHookPayloadMap {
	context: V2SessionContextEvent;
	compaction: V2SessionCompactionEvent;
	prompt: V2SessionPromptEvent;
	fork: { readonly sessionID: string };
	'experimental.model.resolve': V2SessionModelResolve;
	'experimental.idle': V2SessionIdle;
}

export type V2SessionHookName = keyof V2SessionHookPayloadMap;

/** The @2.3.0 session hook registration function (published ModelHooks shape,
 *  minus the optional third options parameter — a function with an optional
 *  parameter stays assignable to this slot). */
export type V2SessionHook = <Name extends V2SessionHookName>(
	name: Name,
	callback: (event: V2SessionHookPayloadMap[Name]) => Promise<void> | void,
) => Promise<V2Registration>;

/**
 * v2 session-call input types (`@opencode/client@2.3.0` generated types, flattened —
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
 * `SessionPromptInput` (`@opencode/client@2.3.0` generated, flattened):
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
 * v2 `SessionDomain` (dist/promise/session.d.ts 2.3.0): `Pick<SessionApi, "list" | "create" |
 * "get" | "remove" | "switchAgent" | "switchModel" | "prompt" | "generate" | "command" |
 * "compact" | "synthetic" | "interrupt" | "update" | "move" | "context"> &
 * Pick<ExperimentalSessionApi, "wait" | "instructions"> & { hook }`.
 *
 * `hook` payload map: the published `SessionHooks` has grown to fork /
 * experimental.model.resolve / experimental.idle (plus model.request / http / ws / retry /
 * generate / title, which this file does not type); the adapter registers only
 * context/compaction/prompt today — the new names are typed so later adoption is
 * compile-checked (issues #3732 / #3552).
 */
export interface V2SessionDomain {
	readonly hook: V2SessionHook;
	/** @2.3.0: paginated session list (optional filters + cursor in, `{data, cursor}` out). */
	readonly list: (input?: V2SessionListInput) => Promise<V2SessionsResponse>;
	/** @2.3.0 (deprecated upstream: "Removed in the next minor"; still on the domain). */
	readonly instructions: {
		readonly entry: {
			readonly list: (input: {
				readonly sessionID: string;
			}) => Promise<ReadonlyArray<{ key: string; value: unknown }>>;
			readonly put: (input: {
				readonly sessionID: string;
				readonly key: string;
				readonly value: V2JsonValue;
			}) => Promise<void>;
			readonly remove: (input: {
				readonly sessionID: string;
				readonly key: string;
			}) => Promise<void>;
		};
	};
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
 * v2 worktree types (`@opencode/plugin@2.3.0` + `@opencode/client@2.3.0`).
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
 * v2 `WorktreeDomain` (dist/promise/worktree.d.ts 2.3.0): the client
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

/** v2 `AgentEditor` (dist/promise/agent.d.ts @2.3.0: `readonly Types.DeepMutable<
 *  Agent.Info>[]` returns; DeepMutable noted here, the vendored info stays plain). */
export interface V2AgentEditor {
	list(): readonly V2AgentInfo[];
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

/** v2 `EventDomain.subscribe` — async iterable of host events. @2.3.0: the published
 *  generic takes an optional `SubscribeOptions` bag (`types`/`signal`/`onActivity`);
 *  this distillation types only the NO-ARGUMENT call the adapter makes
 *  (src/host/v2/events.ts `subscribe()`) — the published function stays assignable
 *  because its parameter is optional (probe-verified, #3732/#3552). */
export interface V2EventEnvelope {
	readonly type?: string;
	readonly [key: string]: unknown;
}
export interface V2EventDomain {
	readonly subscribe?: () =>
		| AsyncIterable<V2EventEnvelope>
		| Promise<AsyncIterable<V2EventEnvelope>>;
}

/**
 * v2 `PermissionDomain` (only used for the v1 ask() bridge, best-effort).
 * `assert` is IN the published @2.3.0 domain (`dist/promise/permission.d.ts`
 * AssertInput: optional `agent`/`save`/`metadata`/`source`, readonly arrays); it
 * first appeared at 2.0.29, ABSENT at the 2.0.26 pin, and the call site still
 * feature-detects it (`typeof === 'function'`) for older hosts
 * (src/host/v2/tools.ts buildPermissionBridge, #3351).
 */
export interface V2PermissionDomain {
	/**
	 * Ask-side permission assertion: input carries `sessionID`/`action`/`resources`
	 * plus the @2.3.0 optional fields; a resolution grants the request, a rejection
	 * denies it. Vendored input keeps the published readonly arrays
	 * (probe-verified, #3732/#3552).
	 */
	assert?: (input: {
		sessionID: string;
		agent?: string;
		action: string;
		resources: readonly string[];
		save?: readonly string[];
		metadata?: Record<string, unknown>;
		source?: { type: 'tool'; messageID: string; id: string };
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

/** v2 `CredentialApi` activate member (@2.3.0 `Pick<CredentialApi, "activate">`). */
export interface V2CredentialDomain {
	readonly activate: (input: {
		readonly credentialID: string;
	}) => Promise<void>;
}

/** v2 `ExperimentalGenerateApi` text member (@2.3.0) — shared by
 *  `Context.experimental.generate` and the deprecated top-level `Context.generate`. */
export interface V2ExperimentalGenerateApi {
	readonly text: (input: {
		readonly prompt: string;
		readonly model?: {
			readonly id: string;
			readonly providerID: string;
			readonly variant?: string;
		} | null;
	}) => Promise<{ text: string }>;
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
	/**
	 * @2.3.0 additions (optional here = the documented older-host deviation; the
	 * published `Context` requires both). `credential` is `Pick<CredentialApi,
	 * "activate">`; `experimental` carries terminal read / stateless generate /
	 * artifact (artifact's shape is a domain the adapter never touches — left
	 * unknown with this note); `generate` is the DEPRECATED top-level alias of
	 * `experimental.generate.text`. None consumed by the adapter today; adoption
	 * assessment lives in docs/host/v2-hook-inventory.md (#3642).
	 */
	readonly credential?: V2CredentialDomain;
	readonly experimental?: {
		readonly terminal?: {
			readonly read: (input: {
				readonly sessionID: string;
				readonly lines?: number;
			}) => Promise<{
				readonly ptyID: string;
				readonly title: string;
				readonly cwd: string;
				readonly foregroundProcess: string | null;
				readonly screen: {
					readonly text: string;
					readonly cols: number;
					readonly rows: number;
					readonly cursor: { readonly x: number; readonly y: number };
				};
			} | null>;
		};
		readonly generate?: V2ExperimentalGenerateApi;
		readonly artifact?: unknown;
	};
	/** @deprecated upstream ("Use `experimental.generate.text`"). @2.3.0 shape. */
	readonly generate?: V2ExperimentalGenerateApi;
	/** Present on 2.0.26+ hosts; no Phase 1 code path consumes it (issue #3169). */
	readonly worktree?: V2WorktreeDomain;
	/**
	 * v2 `ShellDomain` (dist/promise/shell.d.ts @2.0.29; the
	 * `shell.create.before` hook was added upstream 2026-07-29 and is present
	 * across the vendored 2.0.26 pin). OPTIONAL: hosts predating the domain —
	 * and the structural-type discipline of this file — treat it as absent.
	 * Consumed by `registerV2ShellHooks` (src/host/v2/hooks.ts) to observe
	 * the shell the `shell` tool actually executes (#3346).
	 */
	readonly shell?: V2ShellDomain;
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
