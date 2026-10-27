/**
 * v2 agent + command registration (issue #3004 / #2910).
 *
 * Single-source design: the v1 `config` hook IS the shared builder. This
 * module invokes `hooks.config` against a synthetic `opencodeConfig` object
 * and registers the resulting `.agent` / `.command` tables onto the v2 agent
 * and command domains — the auto-select promotions and the entire v1 command table are reused with
 * zero extraction from src/index.ts (the v1 TUI shortcut block stays
 * byte-pinned). DELTA: the lane-permission mutations the v1 hook writes into
 * the config object (applyLanePermissions) have no v2 destination here and
 * are dropped - external-directory lane scoping is tracked on #2910 (open)
 * with its disclosure in docs/host/v2-hook-inventory.md row 4.
 *
 * Mappings (docs/host/v2-hook-inventory.md rows 4-5):
 *   - v1 AgentConfig → v2 Agent.Info: `prompt`→`system`, `mode` preserved
 *     (multi-swarm `*_architect` primary semantics — AGENTS.md invariant 11),
 *     `model` string 'provider/model' → Model.Ref, and the v1 `permission`
 *     block → v2 permission rules through the HOST's own v1→v2 migration
 *     (normalizeV2PermissionAction + preserve-and-append merge; #2910 W2).
 *     The legacy `tools` allowlist branch is GONE: getAgentConfigs deletes
 *     `sdkConfig.tools` at the emit site (src/agents/index.ts, issue #2528),
 *     so nothing can ever feed it — the permission block is the only
 *     enforceable tool-gating channel.
 *   - Entries the v1 hook marks `disable: true` (auto-select disabling the
 *     `build`/`plan` built-ins) are REMOVED on the v2 agent editor.
 *   - v1 command entries `{template, description}` → v2 CommandDefinition
 *     whose `execute` natively dispatches through the shared v1 command
 *     handler (`command.execute.before` on the hooks object) and submits the
 *     handler-produced prompt via the v2 session prompt surface; the raw
 *     expanded template survives as the explicit fallback (#3169 Phase 4 —
 *     see deferredV2ExecuteSwarmCommand).
 */

import {
	canonicalCommandKey,
	normalizeSwarmCommandInput,
} from '../../commands/command-dispatch';
import { resolveCommand } from '../../commands/registry';
import { getLastSwallowedCommandError } from '../../hooks/utils';
import { addDeferredWarning } from '../../services/warning-buffer';
import { log } from '../../utils';
import { withTimeout } from '../../utils/timeout';
import type {
	V1HooksSubset,
	V2AgentEditor,
	V2AgentInfo,
	V2CommandDefinition,
	V2CommandInvocation,
	V2PluginContext,
	V2Registration,
} from './types';

/**
 * Per-call budget for the synthetic config-hook run, the agent transform, the
 * command transform and per-command prompt submissions (#3350 AC3: the name
 * is deliberately DISTINCT from setup.ts's 3_500 registration-stage budget
 * constant, which this must never be confused with).
 */
const V2_AGENT_COMMAND_CALL_TIMEOUT_MS = 60_000;
/** Dispatch budget for one /swarm command execution (#3169 Phase 4). */
const V2_COMMAND_DISPATCH_TIMEOUT_MS = 300_000;

/**
 * Test seam (review PRR-002): the dispatch budget is read through this
 * object so the timeout→notice arm is reachable in tests without patching
 * global timers.
 */
export const _internals = {
	dispatchTimeoutMs: V2_COMMAND_DISPATCH_TIMEOUT_MS,
};

/**
 * Operator-warning channel for the v2 command path (#3318): every message
 * carries the single `[opencode-swarm] v2:` prefix and lands on BOTH
 * surfaces — the deferred-warning buffer (`/swarm diagnose`; the only channel
 * the operator can reach when the host runs plugins in a background service)
 * and a quiet-gated console.warn for foreground runs (#3022 precedent).
 *
 * Dedup is BOUNDED (max {@link V2_OPERATOR_WARNING_BOUND} distinct keys,
 * FIFO eviction — AGENTS.md invariant 8) so a repeated failure (e.g. one per
 * command invocation) warns once instead of flooding the buffer. Dedup keys
 * are STABLE arm ids — varying error text must not bypass the dedup and
 * churn the bound (review PRR-008): dispatch arms key on the command
 * (`dispatch-failed:<key>`) or the dispatch pair
 * (`handler-failed:<sid>:<key>`, `prompt-failed:<sid>:<key>`), while
 * registration/refresh arms also carry the project directory
 * (`agent-registration-failed:<directory>`) so distinct projects (and test
 * fixtures with fresh tmp dirs) never starve each other's first warning. NOT
 * reset at v2 setup cleanup: the map is itself bounded FIFO with explicit
 * eviction, and a global clear would cross instance boundaries (review
 * PRR-002) — re-setups inherit only bounded, self-evicting state.
 *
 * #2910 W3/W5 owner scoping: the quiet flag and the config rebuild source
 * live in an OWNER-TOKEN-KEYED map so two concurrent live setups each own
 * their entry — one instance's cleanup removes only its own entry and can
 * never remove another live instance's state. The exported 1-arg forms
 * (`registerV2ConfigRebuildSource`, `setV2OperatorQuiet`) attach to the
 * AMBIENT owner / the currently-resolved owner, which is what direct test
 * calls observe; setup.ts registers through the ForOwner forms under its own
 * per-instance token, and the DISPATCHING ctx is bound to its owner token
 * through {@link ownerTokenByCtx} so a dispatch-driven refresh resolves
 * through the dispatching instance even when a newer setup registered later
 * (review PRR-003).
 */
const V2_OPERATOR_WARNING_BOUND = 32;
const operatorWarningsSeen = new Map<string, true>();

/** Fresh registration tables a rebuild source produces (#2910 W3). */
export interface V2RegistrationTables {
	agentTable: Record<string, unknown>;
	commandTable: Record<string, unknown>;
}

/**
 * Per-setup registration snapshot (#2910 W3): the tables the registration
 * transforms actually iterate (a live holder, so a refresh that swaps the
 * tables makes the next host re-run of the transforms replay the FRESH
 * data), plus per-domain dirty flags for reload retry retention.
 */
interface V2RegistrationSnapshot {
	agentTable: Record<string, V1AgentConfigLike>;
	commandTable: Record<string, { template?: unknown; description?: unknown }>;
	dirtyAgent: boolean;
	dirtyCommand: boolean;
}

type V2ConfigRebuild = (directory: string) => Promise<V2RegistrationTables>;

interface V2OwnerState {
	rebuild?: V2ConfigRebuild;
	quiet?: boolean;
	snapshot?: V2RegistrationSnapshot;
}

/** Sentinel for direct/test calls that carry no setup owner token. */
const AMBIENT_V2_OWNER = '__ambient__';
const v2OwnerStates = new Map<string, V2OwnerState>();
let currentV2OwnerToken = AMBIENT_V2_OWNER;

/**
 * Dispatching-context → owner-token binding (#2910 W3/W5 / review PRR-003):
 * `registerV2AgentsAndCommands` records the setup instance's token for the
 * ctx it registered under, so a DISPATCH-DRIVEN refresh resolves the
 * dispatching instance's rebuild source/snapshot/quiet instead of the
 * module-global "most recent owner" — instance A's dispatch keeps using A
 * even after instance B registered later. Weak so a dropped host ctx is
 * collectable; the binding is removed at that instance's cleanup
 * (`clearV2CtxOwnerBinding`).
 */
const ownerTokenByCtx = new WeakMap<V2PluginContext, string>();

/**
 * Stable policy-refusal marker for `config doctor --fix` (#2910 W3 / review
 * PRR-005). BOTH refusal arms the v1 command dispatcher can produce for this
 * command share this exact prefix (src/commands/tool-policy.ts): the
 * swarm_command gate ("… is not available through swarm_command. Run the CLI
 * command directly…", classifySwarmCommandToolUse) and the chat-fallback gate
 * ("… is not available through chat fallback because it can modify
 * configuration files…", classifySwarmCommandChatFallbackUse). A genuine
 * executed-doctor output never contains this literal, so its presence in
 * dispatched text identifies a REFUSAL (nothing was fixed — the refresh must
 * not fire).
 */
const CONFIG_DOCTOR_FIX_POLICY_REFUSAL_MARKER =
	'/swarm config doctor --fix is not available through';

function v2OwnerEntry(
	token: string,
	create: boolean,
): V2OwnerState | undefined {
	let entry = v2OwnerStates.get(token);
	if (entry === undefined && create) {
		entry = {};
		v2OwnerStates.set(token, entry);
	}
	return entry;
}

function dropV2OwnerEntryIfEmpty(token: string): void {
	const entry = v2OwnerStates.get(token);
	if (entry === undefined) return;
	if (
		entry.rebuild === undefined &&
		entry.quiet === undefined &&
		entry.snapshot === undefined
	) {
		v2OwnerStates.delete(token);
	}
}

/**
 * The CURRENT owner: the last owner-scoped registration when its entry is
 * still live, else the most recently registered live owner, else ambient.
 */
function resolveCurrentV2OwnerToken(): string {
	if (v2OwnerStates.has(currentV2OwnerToken)) return currentV2OwnerToken;
	const newest = [...v2OwnerStates.keys()]
		.filter((token) => token !== AMBIENT_V2_OWNER)
		.pop();
	return newest ?? AMBIENT_V2_OWNER;
}

/**
 * Owner token for a DISPATCH-driven resolution (#2910 W3/W5 / review
 * PRR-003): the ctx's bound setup token when one exists, else the ambient
 * current-owner chain (direct/test calls that never went through a
 * setup-owned registration — keeps the exported seam contracts intact).
 */
function resolveV2OwnerTokenForCtx(ctx: V2PluginContext): string {
	return ownerTokenByCtx.get(ctx) ?? resolveCurrentV2OwnerToken();
}

/** Rebuild source of one owner token, ambient fallback. */
function resolveV2ConfigRebuildSourceForToken(
	token: string,
): V2ConfigRebuild | undefined {
	const entry = v2OwnerStates.get(token);
	if (entry?.rebuild !== undefined) return entry.rebuild;
	return v2OwnerStates.get(AMBIENT_V2_OWNER)?.rebuild;
}

/** Quiet flag of the current owner, ambient fallback, default false. */
function resolveV2OperatorQuiet(): boolean {
	return resolveV2OperatorQuietForToken(resolveCurrentV2OwnerToken());
}

/** Quiet flag of one owner token, ambient fallback, default false. */
function resolveV2OperatorQuietForToken(token: string): boolean {
	const entry = v2OwnerStates.get(token);
	if (entry?.quiet !== undefined) return entry.quiet;
	return v2OwnerStates.get(AMBIENT_V2_OWNER)?.quiet ?? false;
}

/** Registration snapshot of one owner token, ambient fallback. */
function resolveV2RegistrationSnapshotForToken(
	token: string,
): V2RegistrationSnapshot | undefined {
	const entry = v2OwnerStates.get(token);
	return entry?.snapshot ?? v2OwnerStates.get(AMBIENT_V2_OWNER)?.snapshot;
}

/**
 * Quiet gate for {@link deferredV2WarnOperator}. Writes attach to the
 * CURRENTLY-RESOLVED owner's entry (ambient when no setup owner is live) —
 * setup.ts's startup preflight calls this AFTER openCodeSwarmV2Setup made its
 * per-instance token current, so the value lands on that instance's entry.
 */
export function setV2OperatorQuiet(quiet: boolean): void {
	setV2OperatorQuietForOwner(resolveCurrentV2OwnerToken(), quiet);
}

/**
 * Owner-scoped quiet gate (#2910 W5): writes the given owner's entry and
 * makes it the current owner. `undefined` detaches the owner's quiet value
 * (setup cleanup; the entry drops when it holds nothing else).
 */
export function setV2OperatorQuietForOwner(
	token: string,
	quiet: boolean | undefined,
): void {
	if (quiet === undefined) {
		const existing = v2OwnerStates.get(token);
		if (existing !== undefined) {
			existing.quiet = undefined;
			dropV2OwnerEntryIfEmpty(token);
		}
		return;
	}
	const entry = v2OwnerEntry(token, true);
	if (entry === undefined) return;
	entry.quiet = quiet;
	currentV2OwnerToken = token;
}

/**
 * Clear the operator-warning dedup state and the ambient quiet entry (direct
 * test calls). NOT part of setup cleanup anymore (review PRR-002): the dedup
 * map is bounded FIFO with explicit eviction (the invariant-8 strategy) and a
 * per-cleanup global clear would wipe a concurrent live instance's dedup
 * state; per-owner quiet entries are unregistered only by their own
 * instance's cleanup (owner isolation, #2910 W5).
 */
export function resetV2OperatorWarningState(): void {
	operatorWarningsSeen.clear();
	// Administrative ambient reset only — per-owner quiet entries are owned
	// by their setup instances and are unregistered only by that instance's
	// own cleanup (owner isolation, #2910 W5).
	const ambient = v2OwnerStates.get(AMBIENT_V2_OWNER);
	if (ambient !== undefined) {
		ambient.quiet = undefined;
		dropV2OwnerEntryIfEmpty(AMBIENT_V2_OWNER);
	}
}

/**
 * See the block comment above; module-private by design (frozen checks spy
 * the surfaces, not this). `dedupKey` (review PRR-008): STABLE arm id the
 * dedup map keys on — the message itself embeds varying error text and must
 * not be the identity. `ownerToken` (review PRR-003): resolve the quiet gate
 * through the dispatching instance's entry instead of the module-global
 * current-owner chain (refresh-path warnings).
 */
function deferredV2WarnOperator(
	message: string,
	dedupKey?: string,
	ownerToken?: string,
): void {
	const key = dedupKey ?? message;
	if (operatorWarningsSeen.has(key)) return;
	operatorWarningsSeen.set(key, true);
	while (operatorWarningsSeen.size > V2_OPERATOR_WARNING_BOUND) {
		const oldest = operatorWarningsSeen.keys().next().value;
		if (oldest === undefined) break;
		operatorWarningsSeen.delete(oldest);
	}
	addDeferredWarning(message);
	const quiet =
		ownerToken !== undefined
			? resolveV2OperatorQuietForToken(ownerToken)
			: resolveV2OperatorQuiet();
	if (!quiet) {
		// biome-ignore lint/suspicious/noConsole: #3318 operator warnings must be visible without OPENCODE_SWARM_DEBUG (live hosts relay neither debug logs nor background-service stderr), quiet-gated like the #3022 roster warnings
		console.warn(message);
	}
}

/**
 * Release one owner's registration snapshot (#2910 W3 / review PRR-004):
 * setup cleanup calls this after detaching rebuild + quiet so a torn-down
 * instance's entry DROPS instead of staying immortal in `v2OwnerStates`
 * (unbounded across re-setups, and a dead-but-resolvable owner shadows the
 * fallback resolution for surviving instances).
 */
export function clearV2OwnerRegistrationSnapshot(ownerToken: string): void {
	const entry = v2OwnerStates.get(ownerToken);
	if (entry !== undefined) {
		entry.snapshot = undefined;
		dropV2OwnerEntryIfEmpty(ownerToken);
	}
}

/**
 * Remove the ctx→owner-token binding recorded at registration (#2910 W3/W5 /
 * review PRR-003): setup cleanup detaches its ctx so a later dispatch through
 * a re-used host ctx object cannot resolve a torn-down instance's state.
 */
export function clearV2CtxOwnerBinding(ctx: V2PluginContext): void {
	ownerTokenByCtx.delete(ctx);
}

/**
 * Test-only bounded-state proof (review PRR-004): number of live owner
 * entries. Production never calls this; tests assert a setup's cleanup drops
 * its own entry (snapshot released) and a rejected setup leaks none.
 */
export function countV2OwnerStatesForTests(): number {
	return v2OwnerStates.size;
}

interface V1AgentConfigLike {
	mode?: unknown;
	prompt?: unknown;
	description?: unknown;
	model?: unknown;
	disable?: unknown;
	/** v1 permission block: name -> effect ('allow'|'deny'|'ask') or { [resourceGlob]: effect }. */
	permission?: unknown;
}

/**
 * Host v1→v2 permission-action normalization — the EXACT host migration
 * table, captured verbatim from sst/opencode v2.0.29
 * packages/core/src/v1/config/migrate.ts `normalizeAction` (local mirror:
 * .agents/issue-traces/2910-v2-dual-host-plugin-port/probe-v2sdk/migrate-v2.0.29.ts):
 *
 *   write | patch -> edit
 *   task          -> subagent
 *   bash          -> shell
 *   anything else -> VERBATIM (edit stays edit; apply_patch stays
 *     apply_patch — migrate.ts has NO rewrite for it; plugin tool names stay
 *     themselves). There is NO 'tool' catch-all anywhere in the host
 *     migration.
 *
 * Shared by the agent permission port (#2910 W2) and the permission-bridge
 * assert routing (#3351 / #2910 W4).
 */
export function normalizeV2PermissionAction(action: string): string {
	if (action === 'write' || action === 'patch') return 'edit';
	if (action === 'task') return 'subagent';
	if (action === 'bash') return 'shell';
	return action;
}

/**
 * Migrate one v1 permission-block entry to v2 rules, mirroring the host's
 * own `permissions()` migration (migrate-v2.0.29.ts): a STRING effect maps to
 * `resource: '*'` (never the key as resource); a nested per-resource OBJECT
 * (`{ [glob]: effect }` — the real builder shape,
 * tests/unit/agents/getAgentConfigs-task-permission.test.ts:226-244) expands
 * over Object.entries IN INSERTION ORDER, one rule per pair. Effects pass
 * through verbatim ('allow'|'deny'|'ask'); v1 block order (insertion order)
 * is preserved.
 */
function migrateV1PermissionBlock(
	permission: unknown,
): NonNullable<V2AgentInfo['permissions']> {
	const rules: NonNullable<V2AgentInfo['permissions']> = [];
	if (!permission || typeof permission !== 'object') return rules;
	for (const [name, value] of Object.entries(
		permission as Record<string, unknown>,
	)) {
		const action = normalizeV2PermissionAction(name);
		if (typeof value === 'string') {
			// The host migration preserves effects verbatim; the v1 builder
			// (buildPermissionBlock) emits only the three literals.
			rules.push({
				action,
				resource: '*',
				effect: value as NonNullable<
					V2AgentInfo['permissions']
				>[number]['effect'],
			});
			continue;
		}
		if (value && typeof value === 'object') {
			for (const [resource, effect] of Object.entries(
				value as Record<string, unknown>,
			)) {
				if (typeof effect !== 'string') continue;
				rules.push({
					action,
					resource,
					effect: effect as NonNullable<
						V2AgentInfo['permissions']
					>[number]['effect'],
				});
			}
		}
	}
	return rules;
}

/** Map one v1 AgentConfig entry to a v2 Agent.Info. */
export function mapV1AgentToV2(
	name: string,
	config: V1AgentConfigLike,
): V2AgentInfo {
	const info: V2AgentInfo = {
		id: name,
		name,
		mode:
			config.mode === 'primary' ||
			config.mode === 'subagent' ||
			config.mode === 'all'
				? config.mode
				: 'subagent',
		hidden: false,
		request: { settings: {}, headers: {}, body: {} },
	};
	if (typeof config.prompt === 'string' && config.prompt.length > 0) {
		info.system = config.prompt;
	}
	if (typeof config.description === 'string' && config.description.length > 0) {
		info.description = config.description;
	}
	if (typeof config.model === 'string' && config.model.includes('/')) {
		const separator = config.model.indexOf('/');
		info.model = {
			providerID: config.model.slice(0, separator),
			id: config.model.slice(separator + 1),
		};
	}
	// #2910 W2: the v1 `permission` block is the ONLY enforceable tool-gating
	// channel (getAgentConfigs deletes `sdkConfig.tools` at the emit site —
	// issue #2528). The former `tools` allowlist branch is removed: nothing
	// can feed it, and its `action: 'tool'` shape exists nowhere in the host
	// migration.
	const rules = migrateV1PermissionBlock(config.permission);
	if (rules.length > 0) info.permissions = rules;
	return info;
}

/** Expand a v1 TUI template for a v2 command execution. */
export function expandV1Template(
	template: string,
	argumentsText: string,
): string {
	return template.replaceAll('$ARGUMENTS', argumentsText).trim();
}

/**
 * Strip one leading `/swarm` (or bare `swarm`) token from a command
 * invocation's raw prompt text (#3318 AC7). The v2 host hands the command's
 * OWN prompt surface text to `execute` — on some hosts that text still
 * carries the leading command token, which the registry handler would then
 * double (`/swarm /swarm status` → "Command not found"). Exactly ONE token
 * equal to `/swarm` or `swarm` is dropped, and only when followed by
 * whitespace or end-of-text; every other shape (near-misses like
 * `swarmish`, other commands, bare arguments) passes through unchanged.
 */
export function normalizeV2CommandArguments(text: string): string {
	const trimmed = text.trim();
	if (trimmed === '/swarm' || trimmed === 'swarm') return '';
	const match = trimmed.match(/^(?:\/swarm|swarm)\s+([\s\S]*)$/);
	return match !== null ? match[1] : trimmed;
}

/**
 * Extract the dispatched prompt text from a command handler's spliced parts.
 * Every part carrying a non-whitespace string `text` and either no `type` or
 * the `text` type contributes (a stricter producer contract — exactly one
 * `{type:'text', text}` part — must survive verbatim; looser shapes degrade
 * gracefully instead of truncating: contributions are joined with a blank
 * line, mirroring the v1 host that submits the whole parts array). Entries
 * that are malformed, foreign-typed (e.g. `tool_result`), or
 * whitespace-only are skipped, never thrown on.
 */
function extractDispatchedPromptText(parts: unknown[]): string | null {
	const texts: string[] = [];
	for (const part of parts) {
		if (!part || typeof part !== 'object') continue;
		const typed = part as { type?: unknown; text?: unknown };
		if (typed.type !== undefined && typed.type !== 'text') continue;
		if (typeof typed.text !== 'string') continue;
		if (typed.text.trim().length === 0) continue;
		texts.push(typed.text);
	}
	if (texts.length === 0) return null;
	return texts.join('\n\n');
}

/**
 * Build the fallback prompt text for an execute whose dispatch produced no
 * handler output. Templates carrying `$ARGUMENTS` expand as before; FIXED
 * templates (no placeholder) append the typed arguments, so a degraded
 * fallback does not silently drop what the user typed (review PRR-003a).
 */
function buildFallbackPromptText(
	template: string,
	argumentsText: string,
): string {
	if (template.includes('$ARGUMENTS')) {
		return expandV1Template(template, argumentsText);
	}
	const trimmed = argumentsText.trim();
	return trimmed.length > 0 ? `${template} ${trimmed}` : template;
}

/**
 * Native /swarm command dispatch for the v2 execute path (#3169 Phase 4).
 *
 * Invokes the shared v1 command handler (`command.execute.before` on the
 * hooks object — the same safeHook-wrapped handler the v1 host runs for a
 * human-typed command: registry resolution, policy refusals, help/not-found,
 * real handler execution, and the canonical output envelope) and submits the
 * handler-produced prompt through the v2 session prompt surface.
 *
 * Fallback arms: an absent hook, an empty parts result, or a swallowed
 * handler error submits the expanded template exactly as the pre-#3169
 * bridge did (production wraps the handler in safeHook, so a handler throw
 * surfaces as empty parts — the same net degradation). A dispatch TIMEOUT
 * submits a distinct bounded notice instead — never the raw template, so
 * the model is not prompted to re-attempt a command that may still be
 * completing in the background.
 *
 * Human provenance: this path is reachable only through the host's
 * command-execute surface. The live A/B on 2.0.26 (issue #3169 comments
 * 6083674508 / 6106407764) verified that a human-typed TUI command reaches
 * this path and that headless prompt text is received as text, not routed as
 * a command; whether ANY model-reachable surface (e.g. the vendored
 * `SessionDomain.command`) can invoke `execute` is open live-verification
 * item (b) on #3169, disclosed in the release fragment — the human-only
 * property rests on that host contract, not on a check in this seam (which
 * has no provenance field to test).
 */
/**
 * True when a dispatch (registry key + normalized arguments text) canonically
 * resolves to `config doctor` carrying `--fix`/`-f` (#2910 W3 trigger
 * predicate). Canonicalization reuses the repo's own resolver chain —
 * `normalizeSwarmCommandInput` → `resolveCommand` → `canonicalCommandKey`
 * (src/commands/command-dispatch.ts) — so the `swarm-config-doctor` shortcut
 * key and the generic `/swarm config doctor ...` route land on the SAME
 * canonical key (swarm-command-routing.test.ts:303-306 shows the real
 * generic shape). Read-only commands (`swarm status`, plain `swarm config`)
 * never canonicalize to `config doctor` and never trigger.
 */
function isConfigDoctorFixInvocation(
	key: string,
	argumentsText: string,
): boolean {
	const normalized = normalizeSwarmCommandInput(key, argumentsText);
	if (!normalized.isSwarmCommand) return false;
	const resolved = resolveCommand(normalized.tokens);
	if (resolved === null) return false;
	if (canonicalCommandKey(resolved) !== 'config doctor') return false;
	return (
		normalized.tokens.includes('--fix') || normalized.tokens.includes('-f')
	);
}

async function deferredV2ExecuteSwarmCommand(
	hooks: V1HooksSubset,
	key: string,
	template: string,
	ctx: V2PluginContext,
	invocation: V2CommandInvocation,
	directory: string,
	registrations: V2Registration[],
): Promise<void> {
	// #2910 W3/W5 / review PRR-003: every operator warning (and the refresh
	// trigger below) resolves through the DISPATCHING instance's owner entry.
	const dispatchOwnerToken = resolveV2OwnerTokenForCtx(ctx);
	// The prompt-surface check precedes dispatch: a host without the session
	// prompt surface must not run the registry handler (side-effect-free
	// no-op, the pre-#3169 arm) — but #3318 AC4 makes the no-op
	// operator-visible instead of silent.
	const prompt = ctx.session?.prompt;
	if (typeof prompt !== 'function') {
		log('v2 command executed without a session prompt surface', { name: key });
		deferredV2WarnOperator(
			`[opencode-swarm] v2: command ${key} was not run — the host exposes no session prompt surface; the registry handler was skipped.`,
			`no-prompt-surface:${directory}:${key}`,
			dispatchOwnerToken,
		);
		return;
	}
	// Coerce once: a non-string prompt.text (host contract violation) must
	// degrade to empty arguments, not throw out of `execute`.
	const rawArguments = invocation?.prompt?.text;
	const rawText = typeof rawArguments === 'string' ? rawArguments : '';
	const delivery = invocation?.delivery;
	// #3318 AC8: trace the RAW invocation (pre-normalization) under
	// OPENCODE_SWARM_DEBUG — bounded to 200 chars so a pasted log cannot flood.
	log('v2 command invocation', {
		name: key,
		text:
			rawText.length > 200
				? `${rawText.slice(0, 200)}… [+${rawText.length - 200} chars]`
				: rawText,
		delivery,
	});
	const argumentsText = normalizeV2CommandArguments(rawText);
	// Conditional spread keeps the submit shape EXACTLY {sessionID, text} when
	// the host supplied no delivery (#3318 AC9 toEqual pin). The cast is a
	// pass-through of a host-session-provided value between two host surfaces
	// (invocation.delivery is typed string on the command side).
	const deliveryPart =
		delivery !== undefined
			? { delivery: delivery as 'steer' | 'queue' | null }
			: {};
	let dispatched: string | null = null;
	const hook = hooks['command.execute.before'];
	if (typeof hook === 'function') {
		const output: { parts: unknown[] } = { parts: [] };
		const dispatchTimeoutError = new Error(
			`[opencode-swarm] v2: command ${key} dispatch exceeded budget`,
		);
		// #2910 W3 / review PRR-006: dispatch-start timestamp. BOTH
		// swallowed-error consults below pass it as `sinceMs`, so residue a
		// TIMED-OUT dispatch's still-running handler records LATE (after
		// the timeout arm already returned) is stale — consumed-and-ignored
		// — for every LATER dispatch instead of poisoning it with a false
		// "handler failed" warning or a suppressed refresh.
		const dispatchStartedAt = Date.now();
		try {
			await withTimeout(
				Promise.resolve(
					hook(
						{
							command: key,
							sessionID: invocation.sessionID,
							arguments: argumentsText,
						},
						output,
					),
				),
				_internals.dispatchTimeoutMs,
				dispatchTimeoutError,
			);
			// DISPATCH-SUCCESS PATH (#2910 W3 attach point): the handler
			// resolved and its spliced parts carry the prompt text to
			// submit. The W3 config-doctor --fix refresh trigger (landed)
			// sits after the empty-parts consult below, gated on non-empty
			// dispatched parts that are NOT the tool-policy refusal and a
			// clean (post-dispatch-start) swallowed-error registry.
			dispatched = extractDispatchedPromptText(output.parts);
		} catch (err) {
			if (err === dispatchTimeoutError) {
				const budgetSeconds = _internals.dispatchTimeoutMs / 1000;
				try {
					await withTimeout(
						Promise.resolve(
							prompt({
								sessionID: invocation.sessionID,
								text:
									`[opencode-swarm] v2: command ${key} dispatch exceeded its ` +
									`${budgetSeconds}s budget; the command may still be completing ` +
									`in the background — check its status before re-running.`,
								...deliveryPart,
							}),
						),
						V2_AGENT_COMMAND_CALL_TIMEOUT_MS,
						new Error(
							`[opencode-swarm] v2: command ${key} prompt exceeded budget`,
						),
					);
				} catch (noticeErr) {
					// A failed notice submission must not reject `execute` after the
					// handler already ran (review PRR-005): degrade to a log. The
					// notice arm stays debug-only by issue decision (#3318).
					log('v2 command timeout notice submission failed', {
						name: key,
						error:
							noticeErr instanceof Error
								? noticeErr.message
								: String(noticeErr),
					});
				}
				return;
			}
			log('v2 command dispatch failed (falling back to template)', {
				name: key,
				error: err instanceof Error ? err.message : String(err),
			});
			deferredV2WarnOperator(
				`[opencode-swarm] v2: command ${key} dispatch failed (${
					err instanceof Error ? err.message : String(err)
				}); the expanded template fallback was submitted.`,
				`dispatch-failed:${key}`,
				dispatchOwnerToken,
			);
		}
		// #2910 W3 / review PRR-005: a canonicalized `config doctor --fix`
		// dispatch whose non-empty dispatched text carries the tool-policy
		// refusal marker was REFUSED — nothing was fixed. The refusal text
		// is submitted as-is below (the current submit path), the
		// empty-parts warning arm never fires (dispatched is non-null),
		// and the registration refresh does NOT trigger.
		const configDoctorFixInvocation = isConfigDoctorFixInvocation(
			key,
			argumentsText,
		);
		const policyRefused =
			configDoctorFixInvocation &&
			dispatched !== null &&
			dispatched.includes(CONFIG_DOCTOR_FIX_POLICY_REFUSAL_MARKER);
		if (dispatched === null) {
			// #3318 AC6: production installs the handler as safeHook(commandHandler)
			// (src/index.ts ~5054), so a REAL handler failure surfaces here as
			// empty parts, never as the catch arm above. Consult the swallowed-
			// error registry (read-once; records older than this dispatch's start
			// are stale timeout residue — PRR-006): a recorded failure is
			// operator-visible; no record is the designed legitimate-empty
			// degradation and stays silent (no false positives).
			const swallowed = getLastSwallowedCommandError(
				invocation.sessionID,
				key,
				dispatchStartedAt,
			);
			if (swallowed !== undefined) {
				deferredV2WarnOperator(
					`[opencode-swarm] v2: command ${key} handler failed (${swallowed}); the expanded template fallback was submitted.`,
					`handler-failed:${invocation.sessionID}:${key}`,
					dispatchOwnerToken,
				);
			}
		}
		// #2910 W3 TRIGGER (post-review contract, PRR-005): fires ONLY when
		// the (key, args) canonicalize to `config doctor` + `--fix`/`-f`, the
		// dispatched parts are non-empty, the text is NOT the tool-policy
		// refusal (CONFIG_DOCTOR_FIX_POLICY_REFUSAL_MARKER — both the
		// swarm_command and chat-fallback arms refuse in-dispatcher --fix),
		// and no swallowed handler error was recorded for this
		// (sessionID, command) since the dispatch began — a MAY-HAVE-FIXED
		// dispatch refreshes the registration tables INLINE (the live v2
		// plugin realm does not execute post-setup timer callbacks, so the
		// refresh cannot be deferred to a timer). HONEST SCOPE: the v1
		// tool-policy currently refuses in-dispatcher --fix (the human CLI
		// path is the sanctioned fix channel), so this in-process trigger is
		// a policy-permitted-dispatch hook — it exists for a host/policy
		// that ever permits the in-process fix. CLI-path fixes
		// (`bunx opencode-swarm run config doctor --fix`, out-of-process)
		// trigger nothing and apply on HOST RESTART (disclosed limitation,
		// documented in the release fragment and the PR #3444 body — the
		// inventory's ask-bridge paragraph covers the permission contract).
		// The
		// canonical-command check runs FIRST so non-doctor dispatches never
		// consult the read-once swallowed-error registry.
		if (
			configDoctorFixInvocation &&
			!policyRefused &&
			dispatched !== null &&
			getLastSwallowedCommandError(
				invocation.sessionID,
				key,
				dispatchStartedAt,
			) === undefined
		) {
			await deferredV2RefreshRegistrations(
				ctx,
				hooks,
				directory,
				registrations,
			);
		}
	}
	const text = dispatched ?? buildFallbackPromptText(template, argumentsText);
	// 2.0.26 SessionApi shape: one object input carrying
	// sessionID + text (issue #3169; the published surface has
	// been object-input since at least 2.0.20). A rejection here degrades to
	// a warning rather than rejecting `execute` — the handler's side effects are
	// already done and the host must not observe a failed command for a
	// submission-surface error (review PRR-005; #3318 AC5 makes it visible).
	try {
		await withTimeout(
			Promise.resolve(
				prompt({ sessionID: invocation.sessionID, text, ...deliveryPart }),
			),
			V2_AGENT_COMMAND_CALL_TIMEOUT_MS,
			new Error(`[opencode-swarm] v2: command ${key} prompt exceeded budget`),
		);
	} catch (err) {
		log('v2 command prompt submission failed', {
			name: key,
			error: err instanceof Error ? err.message : String(err),
		});
		deferredV2WarnOperator(
			`[opencode-swarm] v2: command ${key} prompt submission failed (${
				err instanceof Error ? err.message : String(err)
			}); the handler output was not delivered to the session.`,
			`prompt-failed:${invocation.sessionID}:${key}`,
			dispatchOwnerToken,
		);
	}
}

/**
 * Register agents + commands via the synthetic config-hook run.
 *
 * `ownerToken` (#2910 W3/W5 / review PRR-003): the setup instance's token —
 * binds the ctx (WeakMap) to that instance and stores the registration
 * snapshot on ITS entry, so a dispatch-driven refresh through this ctx
 * resolves this instance's rebuild source and snapshot even after a newer
 * setup registered later. Omitted (direct/test calls): the ambient
 * current-owner resolution, unchanged from the pre-PRR-003 contract.
 */
export async function registerV2AgentsAndCommands(
	ctx: V2PluginContext,
	hooks: V1HooksSubset,
	directory: string,
	registrations: V2Registration[],
	ownerToken?: string,
): Promise<void> {
	if (ownerToken !== undefined) ownerTokenByCtx.set(ctx, ownerToken);
	if (typeof hooks.config !== 'function') return;

	// The v1 config hook mutates this object in place — the shared builder.
	// #3352/#3318: the config-hook run, the agent transform and the command
	// transform are guarded INDEPENDENTLY — a failure in one must not prevent
	// the remaining registrations (a config-hook failure leaves no table to
	// register, so it warns and resolves; the setup-level domain wrapper then
	// records nothing further). Every failure is surfaced through the
	// operator-warning channel, not only the debug-gated log.
	const syntheticConfig: Record<string, unknown> = {};
	try {
		await withTimeout(
			Promise.resolve(hooks.config(syntheticConfig)),
			V2_AGENT_COMMAND_CALL_TIMEOUT_MS,
			new Error(
				'[opencode-swarm] v2: synthetic config-hook run exceeded budget',
			),
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('v2 synthetic config-hook run failed (non-fatal)', {
			error: message,
		});
		deferredV2WarnOperator(
			`[opencode-swarm] v2: command registration failed — the shared config-hook run errored (${message}); no agents or commands were registered.`,
			`registration-config-hook-failed:${directory}`,
			ownerToken,
		);
		return;
	}

	const agentTable = (syntheticConfig.agent ?? {}) as Record<
		string,
		V1AgentConfigLike
	>;
	const commandTable = (syntheticConfig.command ?? {}) as Record<
		string,
		{ template?: unknown; description?: unknown }
	>;

	// #2910 W3: the registration transforms iterate this LIVE holder (not a
	// captured table), so a refresh that swaps the tables makes the host's
	// post-reload re-run of the transforms replay the fresh data. Stored on
	// the OWNING setup instance's entry when an ownerToken was passed (review
	// PRR-003), else the CURRENT owner's (the pre-existing ambient contract
	// for direct/test calls).
	const registrationSnapshot: V2RegistrationSnapshot = {
		agentTable,
		commandTable,
		dirtyAgent: false,
		dirtyCommand: false,
	};
	const ownerEntry = v2OwnerEntry(
		ownerToken ?? resolveCurrentV2OwnerToken(),
		true,
	);
	if (ownerEntry !== undefined) ownerEntry.snapshot = registrationSnapshot;

	let agentLanded = false;
	try {
		const agentRegistration = await withTimeout(
			ctx.agent.transform((editor: V2AgentEditor) => {
				for (const [name, config] of Object.entries(
					registrationSnapshot.agentTable,
				)) {
					if (!config || typeof config !== 'object') continue;
					if (config.disable === true) {
						// v1 auto-select disables competing built-ins by flag; v2 removes.
						editor.remove(name);
						continue;
					}
					const mapped = mapV1AgentToV2(name, config);
					// update(id, fn) is the v2 AgentEditor's create-or-update primitive.
					editor.update(name, (agent: V2AgentInfo) => {
						// #2910 W2 preserve-and-append: the host-shaped agent may
						// ALREADY carry default permission rules (Agent.Info.default's
						// `*/* allow` + read-env asks). v2 is last-match-wins, so the
						// migrated v1 rules are APPENDED AFTER them — the migrated
						// policy overrides the host defaults without erasing them.
						const existingPermissions = Array.isArray(agent.permissions)
							? [...agent.permissions]
							: [];
						Object.assign(agent, mapped);
						if (mapped.permissions !== undefined) {
							agent.permissions = [
								...existingPermissions,
								...mapped.permissions,
							];
						}
					});
				}
			}),
			V2_AGENT_COMMAND_CALL_TIMEOUT_MS,
			new Error('[opencode-swarm] v2: agent transform exceeded budget'),
		);
		registrations.push(agentRegistration);
		agentLanded = true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('v2 agent transform failed (non-fatal)', { error: message });
		deferredV2WarnOperator(
			`[opencode-swarm] v2: agent registration failed (${message}); no v2 agents were registered.`,
			`agent-registration-failed:${directory}`,
			ownerToken,
		);
	}

	let commandLanded = false;
	try {
		const commandRegistration = await withTimeout(
			ctx.command.transform(
				(editor: { add(definition: V2CommandDefinition): void }) => {
					for (const [key, entry] of Object.entries(
						registrationSnapshot.commandTable,
					)) {
						if (!entry || typeof entry !== 'object') continue;
						const template =
							typeof entry.template === 'string' ? entry.template : undefined;
						if (template === undefined) continue;
						const definition: V2CommandDefinition = {
							name: key,
							description:
								typeof entry.description === 'string'
									? entry.description
									: undefined,
							// #3169 Phase 4: native dispatch through the shared v1
							// command handler, with the raw-template bridge as the
							// explicit fallback. Deliberately NOT an async arrow:
							// every await lives in the deferred*-named helper so the
							// C6 no-bare-awaits scan (dual-shape-parity) stays clean —
							// the scanner does not track object-literal method names.
							execute: (invocation) =>
								deferredV2ExecuteSwarmCommand(
									hooks,
									key,
									template,
									ctx,
									invocation,
									directory,
									registrations,
								),
						};
						editor.add(definition);
					}
				},
			),
			V2_AGENT_COMMAND_CALL_TIMEOUT_MS,
			new Error('[opencode-swarm] v2: command transform exceeded budget'),
		);
		registrations.push(commandRegistration);
		commandLanded = true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('v2 command transform failed (non-fatal)', { error: message });
		deferredV2WarnOperator(
			`[opencode-swarm] v2: command registration failed (${message}); the v2 command table was not registered.`,
			`command-registration-failed:${directory}`,
			ownerToken,
		);
	}

	log('v2 agents + commands registered', {
		directory,
		agents: Object.keys(agentTable).length,
		commands: Object.keys(commandTable).length,
	});

	// The function resolves unless BOTH transforms failed (the command table
	// is the load-bearing surface — C10/#3318 AC1 — but an agent-only failure
	// must not fail the whole domain). A both-failed rejection is isolated by
	// setup's runRegistration wrapper, which adds its own domain warning.
	if (!agentLanded && !commandLanded) {
		throw new Error(
			'[opencode-swarm] v2: agent and command registrations both failed',
		);
	}
}

/**
 * Register the AMBIENT owner's config rebuild source (#2910 W3, frozen C5
 * surface): the current-truth table builder a config-writing command path
 * installs. `undefined` detaches it. Setup instances register through
 * {@link registerV2ConfigRebuildSourceForOwner} under their own token.
 */
export function registerV2ConfigRebuildSource(
	rebuild: V2ConfigRebuild | undefined,
): void {
	if (rebuild === undefined) {
		const ambient = v2OwnerStates.get(AMBIENT_V2_OWNER);
		if (ambient !== undefined) {
			ambient.rebuild = undefined;
			dropV2OwnerEntryIfEmpty(AMBIENT_V2_OWNER);
		}
		return;
	}
	const entry = v2OwnerEntry(AMBIENT_V2_OWNER, true);
	if (entry !== undefined) entry.rebuild = rebuild;
}

/**
 * Owner-scoped rebuild-source registration (#2910 W3/W5): attaches the given
 * owner token's rebuild source and makes it the current owner; `undefined`
 * detaches only that owner's source (setup cleanup — a concurrent live
 * instance's entry is never touched).
 */
export function registerV2ConfigRebuildSourceForOwner(
	token: string,
	rebuild: V2ConfigRebuild | undefined,
): void {
	if (rebuild === undefined) {
		const entry = v2OwnerStates.get(token);
		if (entry !== undefined) {
			entry.rebuild = undefined;
			dropV2OwnerEntryIfEmpty(token);
		}
		return;
	}
	const entry = v2OwnerEntry(token, true);
	if (entry === undefined) return;
	entry.rebuild = rebuild;
	currentV2OwnerToken = token;
}

/**
 * Reload ONE host domain (feature-detected), withTimeout-bounded and
 * non-fatal. Returns true when the reload completed; a failed/absent reload
 * leaves the caller's dirty flag set so the next refresh retries it even if
 * the tables are otherwise unchanged (#2910 W3 per-domain dirty retention).
 */
async function deferredV2ReloadRegistrationDomain(
	ctx: V2PluginContext,
	domain: 'agent' | 'command',
): Promise<boolean> {
	const domainObject = (ctx as unknown as Record<string, unknown>)[domain] as
		| { reload?: unknown }
		| undefined;
	const reload = domainObject?.reload;
	if (typeof reload !== 'function') return false;
	try {
		await withTimeout(
			Promise.resolve((reload as () => Promise<void>)()),
			V2_AGENT_COMMAND_CALL_TIMEOUT_MS,
			new Error(
				`[opencode-swarm] v2: ${domain} registration reload exceeded budget`,
			),
		);
		return true;
	} catch (err) {
		log(`v2 ${domain} registration reload failed (non-fatal)`, {
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

/**
 * Refresh the v2 registration tables from the REGISTERED rebuild source
 * (#2910 W3 / frozen C5). `hooks.config` is deliberately NOT re-consulted —
 * the production closure is stale by construction (captured at setup time);
 * the rebuild source is the only current-truth channel. No source or a
 * rejecting source: deferred warning, no reloads, no throw. Unchanged
 * tables: no reloads (idempotent refresh). Changed tables: the snapshot
 * holder is updated FIRST (so the host's post-reload re-run of the
 * registered transforms replays the fresh tables), then feature-detected
 * `ctx.agent.reload()` + `ctx.command.reload()` fire; a failed reload marks
 * its domain dirty for the next refresh.
 *
 * #2910 W3/W5 / review PRR-003: the OWNING instance is resolved through the
 * dispatching ctx's bound owner token (`ownerTokenByCtx`, recorded by
 * registerV2AgentsAndCommands under the setup instance's token), falling
 * back to the ambient current-owner chain when the ctx was never bound
 * (direct/test calls — the frozen C5 arms). Rebuild source, snapshot and the
 * quiet gate all resolve through the SAME token.
 */
export async function deferredV2RefreshRegistrations(
	ctx: V2PluginContext,
	hooks: V1HooksSubset,
	directory: string,
	registrations?: V2Registration[],
): Promise<void> {
	const ownerToken = resolveV2OwnerTokenForCtx(ctx);
	const rebuild = resolveV2ConfigRebuildSourceForToken(ownerToken);
	if (rebuild === undefined) {
		deferredV2WarnOperator(
			'[opencode-swarm] v2: registration refresh skipped — no config rebuild source is registered on this host; the registration tables were not reloaded.',
			`refresh-no-rebuild-source:${directory}`,
			ownerToken,
		);
		return;
	}
	let tables: V2RegistrationTables;
	try {
		tables = await withTimeout(
			Promise.resolve(rebuild(directory)),
			V2_AGENT_COMMAND_CALL_TIMEOUT_MS,
			new Error('[opencode-swarm] v2: registration rebuild exceeded budget'),
		);
	} catch (err) {
		deferredV2WarnOperator(
			`[opencode-swarm] v2: registration refresh failed — the config rebuild source errored (${
				err instanceof Error ? err.message : String(err)
			}); the registration tables were not reloaded.`,
			`refresh-rebuild-failed:${directory}`,
			ownerToken,
		);
		return;
	}
	const snapshot = resolveV2RegistrationSnapshotForToken(ownerToken);
	if (snapshot === undefined) {
		// Nothing was ever registered on this owner: registration is the fresh
		// path; a refresh with no snapshot has nothing to reload.
		log('v2 registration refresh skipped — no registration snapshot', {
			directory,
		});
		return;
	}
	const changed =
		snapshot.dirtyAgent ||
		snapshot.dirtyCommand ||
		JSON.stringify(snapshot.agentTable) !== JSON.stringify(tables.agentTable) ||
		JSON.stringify(snapshot.commandTable) !==
			JSON.stringify(tables.commandTable);
	if (!changed) {
		log('v2 registration refresh — tables unchanged, no reload', {
			directory,
			registrations: registrations?.length ?? 0,
			hooksConfigPresent: typeof hooks.config === 'function',
		});
		return;
	}
	snapshot.agentTable =
		tables.agentTable as V2RegistrationSnapshot['agentTable'];
	snapshot.commandTable =
		tables.commandTable as V2RegistrationSnapshot['commandTable'];
	const agentReloaded = await deferredV2ReloadRegistrationDomain(ctx, 'agent');
	snapshot.dirtyAgent = !agentReloaded;
	const commandReloaded = await deferredV2ReloadRegistrationDomain(
		ctx,
		'command',
	);
	snapshot.dirtyCommand = !commandReloaded;
	if (!agentReloaded || !commandReloaded) {
		const failed = [
			agentReloaded ? undefined : 'agent',
			commandReloaded ? undefined : 'command',
		]
			.filter((domain) => domain !== undefined)
			.join(', ');
		deferredV2WarnOperator(
			`[opencode-swarm] v2: registration tables changed but the ${failed} domain reload failed; the domain stays marked dirty and the next refresh retries it.`,
			`refresh-reload-failed:${directory}`,
			ownerToken,
		);
	}
	log('v2 registration tables refreshed', {
		directory,
		registrations: registrations?.length ?? 0,
		agentReloaded,
		commandReloaded,
	});
}
