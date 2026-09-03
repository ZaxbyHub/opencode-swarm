/**
 * Re-implementation of OpenCode's permission evaluation, transcribed from the
 * shipped host binary so tests verify our emitted rules against real host
 * semantics instead of against our own assumptions.
 *
 * The four PRIMITIVES below (`hostWildcardMatch`, `hostFromConfig`,
 * `hostMerge`, `hostEvaluate`) are verbatim transcriptions. `hostAgentRuleset`
 * is a COMPOSITION of them modelling the host's agent assembly: it is faithful
 * to the merge order and the tool-output re-append, but the caller must supply
 * the host's base-allowed directories, because those are resolved at runtime by
 * services this helper deliberately does not model.
 *
 * Source: `C:\OpenCode\opencode.exe`, opencode 1.18.10.
 *
 *  - `Wildcard.match`  — offset 100456759
 *  - `Permission.evaluate` / `fromConfig` / `merge` — offset 102984993
 *  - agent ruleset assembly (`l`, per-agent merge, tool-output append)
 *    — offsets 100811506 and 100814474
 *
 * Verbatim host source for the three load-bearing functions:
 *
 * ```js
 * function ql(e,o){ if(e)e=e.replaceAll("\\","/"); if(o)o=o.replaceAll("\\","/");
 *   let l=o.replace(/[.+^${}()|[\]\\]/g,"\\$&").replace(/\*​/g,".*").replace(/\?/g,".");
 *   if(l.endsWith(" .*"))l=l.slice(0,-3)+"( .*)?";
 *   let i="si"; return new RegExp("^"+l+"$",i).test(e) }
 *
 * function RA(j){ let J=[]; for(let[K,z]of Object.entries(j)){
 *   if(typeof z==="string"){J.push({permission:K,action:z,pattern:"*"});continue}
 *   J.push(...Object.entries(z).map(([B,X])=>({permission:K,pattern:LA(B),action:X})))}
 *   return J }
 *
 * function VA(...j){ return j.flat() }
 *
 * function c(j,J,...K){ return K.flat().findLast((z)=>
 *   g.match(j,z.permission)&&g.match(J,z.pattern))
 *   ?? {action:"ask",permission:j,pattern:"*"} }
 * ```
 *
 * If a future OpenCode release changes any of these, the tests built on this
 * helper are the tripwire — re-extract before "fixing" them.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { hostNormalizePathPattern } from '../../src/config/host-path';

export interface PermissionRule {
	permission: string;
	pattern: string;
	action: string;
}

/** Host `Wildcard.match`. `pattern` is the RULE side; `value` is the asked side. */
export function hostWildcardMatch(value: string, pattern: string): boolean {
	const v = value ? value.replaceAll('\\', '/') : value;
	const p = pattern ? pattern.replaceAll('\\', '/') : pattern;
	let compiled = p
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/\?/g, '.');
	if (compiled.endsWith(' .*')) compiled = `${compiled.slice(0, -3)}( .*)?`;
	return new RegExp(`^${compiled}$`, 'si').test(v);
}

/** Host `LA` — the `~` / `$HOME` expansion applied to rule patterns. */
function expandHome(p: string): string {
	if (p.startsWith('~/')) return os.homedir() + p.slice(1);
	if (p === '~') return os.homedir();
	if (p.startsWith('$HOME')) return os.homedir() + p.slice(5);
	return p;
}

/** Host `Permission.fromConfig`. Preserves `Object.entries` order. */
export function hostFromConfig(
	config: Record<string, unknown>,
): PermissionRule[] {
	const out: PermissionRule[] = [];
	for (const [permission, value] of Object.entries(config)) {
		if (typeof value === 'string') {
			out.push({ permission, action: value, pattern: '*' });
			continue;
		}
		for (const [pattern, action] of Object.entries(
			value as Record<string, string>,
		)) {
			out.push({ permission, pattern: expandHome(pattern), action });
		}
	}
	return out;
}

/** Host `Permission.merge` — plain concatenation. */
export function hostMerge(...lists: PermissionRule[][]): PermissionRule[] {
	return lists.flat();
}

/** Host `Permission.evaluate` — `findLast`, so LATER RULES WIN. */
export function hostEvaluate(
	permission: string,
	askedPattern: string,
	...rulesets: PermissionRule[][]
): PermissionRule {
	return (
		rulesets
			.flat()
			.findLast(
				(rule) =>
					hostWildcardMatch(permission, rule.permission) &&
					hostWildcardMatch(askedPattern, rule.pattern),
			) ?? { action: 'ask', permission, pattern: '*' }
	);
}

/**
 * Builds the effective agent ruleset the way the host actually does.
 *
 * Faithful to `Agent.state` (offsets 100811506 and 100814474):
 *
 * ```js
 * q = [A.GLOB, j.join(H.Path.tmp,"*"), ...y.map(n=>j.join(n,"*")),
 *      ...b.map(n=>j.join(n,"*"))]                    // base-allowed dirs
 * c = a.fromConfig({ ..., external_directory:{ "*":"ask",
 *       ...Object.fromEntries(q.map(n=>[n,"allow"])) }, ... })
 * l = a.fromConfig(config.permission ?? {})
 * // per agent:  permission = a.merge(c, ..., l)
 * //             then       = a.merge(permission, a.fromConfig(agent.permission))
 * // finally the host appends external_directory:{ [A.GLOB]:"allow" } unless a
 * // rule already has action==="deny" && pattern===A.GLOB exactly.
 * ```
 *
 * The base allows matter: without them a test cannot distinguish "our rules
 * deny what should be denied" from "our rules revoke something the host had
 * already granted". Pass the host's base-allowed DIRECTORIES via
 * `opts.baseAllowDirs` (patterns are derived as `<dir>/*`, as the host does).
 */
export function hostAgentRuleset(
	topLevelPermission: Record<string, unknown>,
	perAgentPermission: Record<string, unknown> = {},
	opts: { baseAllowDirs?: readonly string[]; toolOutputGlob?: string } = {},
): PermissionRule[] {
	const baseAllows: Record<string, string> = { '*': 'ask' };
	for (const dir of opts.baseAllowDirs ?? []) {
		// The host derives these with `path.join(dir, '*')`; normalise them the
		// same way the asked side is normalised so the model stays comparable.
		baseAllows[hostNormalizePathPattern(path.join(dir, '*'))] = 'allow';
	}
	if (opts.toolOutputGlob) baseAllows[opts.toolOutputGlob] = 'allow';

	const merged = hostMerge(
		hostFromConfig({ external_directory: baseAllows }),
		hostFromConfig(topLevelPermission),
		hostFromConfig(perAgentPermission),
	);

	// Trailing re-append: unless an existing rule denies EXACTLY the tool-output
	// glob, the host adds it back last.
	if (opts.toolOutputGlob) {
		const explicitlyDenied = merged.some(
			(r) =>
				r.permission === 'external_directory' &&
				r.action === 'deny' &&
				r.pattern === opts.toolOutputGlob,
		);
		if (!explicitlyDenied) {
			return hostMerge(
				merged,
				hostFromConfig({
					external_directory: { [opts.toolOutputGlob]: 'allow' },
				}),
			);
		}
	}
	return merged;
}

/**
 * The action the host would take for an `external_directory` request covering
 * `directory`, given a top-level permission block.
 *
 * The asked pattern is produced exactly as the host's own producers do — e.g.
 * `src/tools` (offset 100715012):
 *
 * ```js
 * let u = G.normalizePathPattern(Hr.join(y, "*"));
 * yield* o.ask({ permission: "external_directory", patterns: [u], … });
 * ```
 *
 * A plain string concat here (the previous implementation) made every
 * canonicalisation defect invisible to the suite: it silently agreed with an
 * un-canonicalised rule, so a symlink/junction mismatch could never be
 * observed. `hostNormalizePathPattern` is the transcription used by production
 * too, which is the point — the assertion is that the rule text and the asked
 * text CONVERGE under the host's own normaliser.
 */
export function evaluateExternalDirectory(
	topLevelPermission: Record<string, unknown>,
	directory: string,
	opts: {
		perAgentPermission?: Record<string, unknown>;
		baseAllowDirs?: readonly string[];
		toolOutputGlob?: string;
	} = {},
): string {
	const asked = hostNormalizePathPattern(path.join(directory, '*'));
	return hostEvaluate(
		'external_directory',
		asked,
		hostAgentRuleset(topLevelPermission, opts.perAgentPermission ?? {}, {
			baseAllowDirs: opts.baseAllowDirs,
			toolOutputGlob: opts.toolOutputGlob,
		}),
	).action;
}

// ---------------------------------------------------------------------------
// Per-agent TOOL enforcement (issue #2528). Everything below is transcribed
// from the PINNED host source — github.com/sst/opencode tag v1.18.3, commit
// 127bdb30 — not from the 1.18.10 binary the functions above were taken from.
// The audit (`docs/audits/swarm-plugin-review-2026-09.md`, finding HOST-1,
// branch claude/swarm-plugin-review-ysvk9b) verified 1.18.3 → 1.18.26 drift
// for the agent assembly is zero changed lines, so both provenances agree on
// the shared primitives.
//
// Source files (v1.18.3):
//  - packages/opencode/src/permission/index.ts — `disabled`, alias lists
//  - packages/opencode/src/agent/agent.ts (Agent.state) — host defaults
//  - packages/opencode/src/session/llm/request.ts — `resolveTools`
//
// NOTE ON "real host": this transcription is the repo's established substrate
// for verifying emitted rules against real host semantics (same contract as
// the header above). Spawning a real `opencode` host binary in CI is NOT
// proposed — no test in this repo does it, and driving a session requires an
// LLM. If a future OpenCode release changes any of these, the structural pins
// in tests/unit/agents/agent-permission-enforcement.test.ts are the tripwire
// — re-extract before "fixing" them.
// ---------------------------------------------------------------------------

/**
 * Host `Permission.disabled` alias list, verbatim (v1.18.3
 * packages/opencode/src/permission/index.ts): these TOOL names are evaluated
 * as permission name `edit`. Note `patch` is NOT in this list — `normalize()`
 * (config-file `tools` maps, a different host surface) collapses
 * write/edit/patch, but `disabled()` does not alias `patch`.
 */
export const HOST_DISABLED_EDITS: readonly string[] = [
	'edit',
	'write',
	'apply_patch',
];

/**
 * Host `Permission.disabled` alias list, verbatim: MCP resource-reader tool
 * names evaluated as permission name `read`.
 */
export const HOST_DISABLED_READS: readonly string[] = [
	'list_mcp_resources',
	'list_mcp_resource_templates',
	'read_mcp_resource',
];

/**
 * Host `Permission.disabled`, verbatim transcription (v1.18.3
 * packages/opencode/src/permission/index.ts):
 *
 * ```js
 * function disabled(tools, ruleset) {
 *   const edits = ["edit", "write", "apply_patch"]
 *   const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
 *   return new Set(tools.filter((tool) => {
 *     const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
 *     const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
 *     return rule?.pattern === "*" && rule.action === "deny"
 *   }))
 * }
 * ```
 *
 * A tool is HIDDEN from the request iff the LAST rule whose permission name
 * wildcard-matches the tool's (aliased) permission name has pattern exactly
 * `'*'` and action `'deny'`. This — via `resolveTools` — is the host-side
 * refusal mechanism for plugin-authored per-agent denies (issue #2528).
 */
export function hostDisabled(
	tools: readonly string[],
	ruleset: PermissionRule[],
): Set<string> {
	const edits = HOST_DISABLED_EDITS;
	const reads = HOST_DISABLED_READS;
	return new Set(
		tools.filter((tool) => {
			const permission = edits.includes(tool)
				? 'edit'
				: reads.includes(tool)
					? 'read'
					: tool;
			const rule = ruleset.findLast((rule) =>
				hostWildcardMatch(permission, rule.permission),
			);
			return rule?.pattern === '*' && rule.action === 'deny';
		}),
	);
}

/**
 * The host's hardcoded per-agent default permission config, verbatim from
 * Agent.state (v1.18.3 packages/opencode/src/agent/agent.ts:105-129):
 *
 * ```js
 * const defaults = Permission.fromConfig({
 *   "*": "allow",
 *   doom_loop: "ask",
 *   external_directory: { "*": "ask", ...whitelistedDirs → "allow" },
 *   question: "deny",
 *   plan_enter: "deny",
 *   plan_exit: "deny",
 *   read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
 * })
 * ```
 *
 * `whitelistedDirs` is resolved at runtime (Truncate.GLOB, the host temp dir,
 * `Skill.dirs()`, reference dirs); callers may pass the equivalent patterns
 * via `extraExternalAllowDirs`. The static entries — including the
 * `read` `.env` asks the plugin must not flatten — are the load-bearing part
 * for issue #2528's tests.
 */
export function hostDefaultPermissionConfig(
	opts: { extraExternalAllowDirs?: readonly string[] } = {},
): Record<string, unknown> {
	const external: Record<string, string> = { '*': 'ask' };
	for (const dir of opts.extraExternalAllowDirs ?? []) {
		external[dir] = 'allow';
	}
	return {
		'*': 'allow',
		doom_loop: 'ask',
		external_directory: external,
		question: 'deny',
		plan_enter: 'deny',
		plan_exit: 'deny',
		read: {
			'*': 'allow',
			'*.env': 'ask',
			'*.env.*': 'ask',
			'*.env.example': 'allow',
		},
	};
}

/**
 * Builds the effective ruleset for a PLUGIN-INJECTED agent exactly as the
 * host's merge loop does (v1.18.3 packages/opencode/src/agent/agent.ts:267-294):
 *
 * ```js
 * item = { permission: Permission.merge(defaults, user) }        // new agent
 * item.permission = Permission.merge(item.permission,
 *                                    Permission.fromConfig(value.permission ?? {}))
 * ```
 *
 * so the flattened order is `[defaults, userTopLevel, agentOwn]` — the
 * agent's own block is LAST and therefore wins under `findLast`. This
 * ordering is why plugin agent blocks must not carry entries for
 * pattern-gated permissions (`external_directory`, `read` sub-patterns):
 * they would override both the user's top-level config and lane rules.
 */
export function hostAgentRulesetForPluginAgent(
	userTopLevelPermission: Record<string, unknown> | undefined,
	agentPermission: Record<string, unknown> | undefined,
	opts: {
		extraExternalAllowDirs?: readonly string[];
	} = {},
): PermissionRule[] {
	return hostMerge(
		hostFromConfig(hostDefaultPermissionConfig(opts)),
		hostFromConfig(userTopLevelPermission ?? {}),
		hostFromConfig(agentPermission ?? {}),
	);
}

/**
 * Host `resolveTools`, verbatim model (v1.18.3
 * packages/opencode/src/session/llm/request.ts:210-215):
 *
 * ```js
 * function resolveTools(input) {
 *   const disabled = Permission.disabled(
 *     Object.keys(input.tools),
 *     Permission.merge(input.agent.permission, input.permission ?? []),
 *   )
 *   return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
 * }
 * ```
 *
 * `input.agent.permission` is the agent ruleset (already `[defaults, user,
 * agentOwn]` — pass the output of {@link hostAgentRulesetForPluginAgent}).
 * `input.permission` is the per-request permission (usually empty).
 * `input.user.tools` is the user MESSAGE's tools map — pass `undefined` to
 * model the common case. Returns the tool names the host would keep in the
 * LLM request: everything else is hidden — the model never sees its schema
 * and cannot call it.
 */
export function hostResolveTools(
	tools: readonly string[],
	agentRuleset: PermissionRule[],
	requestPermission?: Record<string, unknown>,
): Set<string> {
	const disabled = hostDisabled(
		tools,
		hostMerge(agentRuleset, hostFromConfig(requestPermission ?? {})),
	);
	return new Set(tools.filter((tool) => !disabled.has(tool)));
}
