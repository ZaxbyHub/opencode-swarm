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
