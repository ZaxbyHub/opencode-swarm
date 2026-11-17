/**
 * COMPILE-TIME probe for the vendored 2.3.0 surface (#3732/#3552).
 *
 * NOT a bun test (no .test.ts suffix): bun test and the CI per-file finder never
 * pick this file up. It exists so `tsc --noEmit` can check the SHIPPED vendored
 * types against FAITHFUL aliases of the published @opencode/*@2.3.0 shapes (the
 * tagged packages themselves are deliberately not repo dependencies; the
 * pre-implementation actual-alias probe against the real tarballs lives in the
 * issue trace). Gate:
 *
 *   bunx tsc --noEmit --strict --skipLibCheck --module esnext \
 *     --moduleResolution bundler --target es2022 \
 *     tests/unit/host/v2/vendored-surface-2-3-0.type-probe.ts
 *
 * Positive rows: a published-shaped implementation/alias must be assignable to
 * each vendored slot. Negative rows: `@ts-expect-error` must fire on wrong
 * shapes (proven to fire — see the trace's failing probe iterations).
 */
import type {
	V2AgentEditor,
	V2CredentialDomain,
	V2EventDomain,
	V2EventEnvelope,
	V2ExperimentalGenerateApi,
	V2JsonValue,
	V2PermissionDomain,
	V2SessionCompactionResult,
	V2SessionDomain,
	V2SessionHook,
	V2SessionIdle,
	V2SessionModelResolve,
} from '../../../../src/host/v2/types';

// ---- faithful aliases of the published @2.3.0 shapes ----

/** Recursive JsonValue (client generated types). */
type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

/** CredentialApi.activate (client): CredentialActivateInput {credentialID} -> void. */
type PublishedCredentialActivate = (input: {
	readonly credentialID: string;
}) => Promise<void>;

/** ExperimentalGenerateApi.text (client): {prompt, model?|null} -> {text}. */
type PublishedGenerateText = (input: {
	readonly prompt: string;
	readonly model?: {
		readonly id: string;
		readonly providerID: string;
		readonly variant?: string;
	} | null;
}) => Promise<{ text: string }>;

/** PersistentPty read (client): {sessionID, lines?} -> structured screen | null. */
type PublishedTerminalRead = (input: {
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

/** ModelHooks<SessionHooks>-shaped hook over the vendored payload map. */
type PublishedSessionHook<Hooks> = <Name extends keyof Hooks & string>(
	name: Name,
	callback: (input: Hooks[Name]) => Promise<void> | void,
	options?: Hooks[Name] extends { readonly experimental: unknown } | undefined
		? Record<string, never>
		: Record<string, never>,
) => Promise<{ dispose: () => Promise<void> }>;

/** EventDomain.subscribe (plugin): optional SubscribeOptions, async iterable. */
type PublishedSubscribe = <Type extends string = string>(options?: {
	readonly types?: ReadonlyArray<Type>;
	readonly signal?: AbortSignal;
	readonly onActivity?: () => void;
}) => AsyncIterable<{
	readonly type?: string;
	readonly [key: string]: unknown;
}>;

// ---- positive assignments: published shapes fit the vendored slots ----

const _credSlot: V2CredentialDomain['activate'] =
	null as unknown as PublishedCredentialActivate;

const _generateSlot: V2ExperimentalGenerateApi['text'] =
	null as unknown as PublishedGenerateText;

const _terminalReadSlot: V2ExperimentalTerminalReadSlot = null as unknown as {
	read: PublishedTerminalRead;
};
interface V2ExperimentalTerminalReadSlot {
	read: (input: {
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
}

const _subscribeSlot: V2EventDomain['subscribe'] =
	null as unknown as PublishedSubscribe;

const _jsonSlot: V2JsonValue = {
	a: [1, 'two', null, { b: true }],
} satisfies JsonValue;
const _jsonAliasFits: V2JsonValue = null as unknown as JsonValue;

// Whole published-shaped hook (incl. compaction payload) fits the vendored hook.
interface ProbeHookMap {
	context: {
		readonly sessionID: string;
		agent: string;
		model?: { id?: string; providerID?: string };
		system: Array<{ type: 'text'; text: string }>;
		messages: Array<{
			readonly id?: string;
			role: 'system' | 'user' | 'assistant' | 'tool';
			readonly content: ReadonlyArray<{
				readonly type: string;
				readonly text?: string | null;
			}>;
		}>;
		options: Record<string, unknown>;
		tools: Record<string, { description: string; input: unknown }>;
	};
	compaction: {
		readonly sessionID: string;
		agent: string;
		model?: { id?: string; providerID?: string };
		system: Array<{ type: 'text'; text: string }>;
		messages: Array<{
			readonly id?: string;
			role: 'system' | 'user' | 'assistant' | 'tool';
			readonly content: ReadonlyArray<{
				readonly type: string;
				readonly text?: string | null;
			}>;
		}>;
		options: Record<string, unknown>;
		tools: Record<string, { description: string; input: unknown }>;
		result?: { summary: string; native?: Record<string, unknown> };
	};
	prompt: {
		readonly sessionID: string;
		readonly messageID: string;
		prompt: {
			text: string;
			files?: unknown[];
			agents?: unknown[];
			skills?: unknown[];
		};
		readonly delivery?: string;
	};
	fork: { readonly sessionID: string };
	'experimental.model.resolve': {
		readonly sessionID: string;
		readonly agent: string;
		kind: 'primary' | 'compaction' | 'title' | 'generate';
		model: { readonly id: string; readonly providerID: string };
	};
	'experimental.idle': {
		readonly sessionID: string;
		readonly background: ReadonlyArray<
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
			  }
		>;
	};
}
const _hookSlot: V2SessionHook =
	null as unknown as PublishedSessionHook<ProbeHookMap>;

const _listSlot: V2SessionDomain['list'] = null as unknown as (input?: {
	readonly limit?: number;
	readonly order?: 'asc' | 'desc';
	readonly search?: string;
	readonly parentID?: string | null;
	readonly archived?: boolean;
	readonly directory?: string;
	readonly project?: string;
	readonly subpath?: string;
	readonly cursor?: string;
}) => Promise<{
	data: Array<{
		readonly id: string;
		readonly projectID: string;
		readonly location: { readonly directory: string };
		[key: string]: unknown;
	}>;
	cursor: { previous?: unknown; next?: unknown };
}>;

const _putSlot: V2SessionDomain['instructions']['entry']['put'] =
	null as unknown as (input: {
		readonly sessionID: string;
		readonly key: string;
		readonly value: JsonValue;
	}) => Promise<void>;

const _editorSlot: V2AgentEditor = {
	list: () => [],
	get: (id: string) => undefined,
	default: () => undefined,
	update: () => undefined,
	remove: () => undefined,
};

const _assertSlot: Parameters<NonNullable<V2PermissionDomain['assert']>>[0] = {
	sessionID: 's',
	action: 'tool',
	resources: ['a', 'b'] as readonly string[],
};

const _compactionResult: V2SessionCompactionResult = {
	summary: 'sum',
	native: { messages: [] },
	metadata: { k: 'v' },
};

const _modelResolve: V2SessionModelResolve = {
	sessionID: 's',
	agent: 'architect',
	kind: 'compaction',
	model: { id: 'm', providerID: 'p' },
};

const _idle: V2SessionIdle = {
	sessionID: 's',
	background: [{ kind: 'shell', sessionID: 's', shellID: 'sh', command: 'ls' }],
};

const _envelope: V2EventEnvelope = { type: 'session.idle', sessionID: 's' };

// ---- negative rows: wrong shapes must NOT fit (each must fire a TS error) ----

// @ts-expect-error — undefined is not JsonValue
const _jsonBad: V2JsonValue = undefined;

const wrongGenerate = (input: {
	readonly prompt: number;
}): Promise<{ text: string }> =>
	Promise.resolve({ text: String(input.prompt) });
// @ts-expect-error — wrong-shape generate.text (prompt: number) must not fit
const _generateBad: V2ExperimentalGenerateApi['text'] = wrongGenerate;

const wrongList = (): Promise<Array<{ readonly id: string }>> =>
	Promise.resolve([]);
// @ts-expect-error — array-returning session.list must not fit the vendored slot
const _listBad: V2SessionDomain['list'] = wrongList;

const wrongPut = (input: {
	readonly sessionID: string;
	readonly key: string;
	readonly value: () => number;
}): Promise<void> => Promise.resolve();
// @ts-expect-error — non-JSON put value must not fit
const _putBad: V2SessionDomain['instructions']['entry']['put'] = wrongPut;

const _compactionBad: V2SessionCompactionResult = {
	summary: 's',
	// @ts-expect-error — excess/foreign property must not satisfy the explicit-field
	// result (directive sits on the property line: tsc reports TS2353 there, and a
	// directive above the multi-line literal does not cover it — impl-review r2 F1)
	somethingElse: 1,
};

void [
	_credSlot,
	_generateSlot,
	_terminalReadSlot,
	_subscribeSlot,
	_jsonSlot,
	_jsonAliasFits,
	_hookSlot,
	_listSlot,
	_putSlot,
	_editorSlot,
	_assertSlot,
	_compactionResult,
	_modelResolve,
	_idle,
	_envelope,
	_jsonBad,
	_generateBad,
	_listBad,
	_putBad,
	_compactionBad,
];
