/**
 * Full-Auto v2 subagent outbound and return checks.
 *
 * Composable hook that fires alongside the existing delegation-gate hooks.
 * It does not replace delegation-gate; it adds Full-Auto-specific verification
 * for outbound Task delegations and post-return safety review.
 *
 * Outbound (tool.execute.before, only for Task tool):
 *   - Require valid `subagent_type` matching a registered swarm role.
 *   - For coder delegation, require declared scope (warning if missing).
 *   - Reject delegation that targets a clearly invalid agent or that requests
 *     a write to a protected path inside the prompt body.
 *   - Out-of-policy outbound delegations escalate to the critic via the
 *     permission hook's escalate_critic path; this hook itself records
 *     advisories and structured denials for the most clear-cut cases.
 *
 * Return (tool.execute.after, only for Task tool):
 *   - Inspect subagent result text for skipped tests, tool timeouts, scope
 *     changes, "instructions from external content", missing evidence,
 *     and out-of-scope file generation.
 *   - On detected return warnings, write a `full_auto_subagent_warning`
 *     event and increment a per-session counter so the cadence/escalation
 *     layer can react.
 */
import * as fs from 'node:fs';
import type { PluginConfig } from '../config';
import { ALL_AGENT_NAMES } from '../config/constants';
import {
	getCanonicalAgentRole,
	isKnownCanonicalRole,
	resolveGeneratedAgentRole,
} from '../config/schema';
import { isProtectedPath } from '../full-auto/policy';
import {
	incrementFullAutoCounter,
	loadFullAutoRunState,
	saveFullAutoRunState,
} from '../full-auto/state';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { swarmState } from '../state';
import * as logger from '../utils/logger';
import { normalizeToolName } from './normalize-tool-name';
import { validateSwarmPath } from './utils';

/**
 * The plugin recognises canonical agent ROLES, not full generated agent
 * names. Generated names embed an arbitrary, user-defined swarm ID prefix
 * (e.g. `bananaSwarm_coder`, `acme-prod_reviewer`, `customer123_critic_oversight`).
 * The role-based check uses {@link getCanonicalAgentRole} to extract the
 * canonical role from any user-defined name and validates against
 * {@link ALL_AGENT_NAMES}.
 *
 * Important: the original `subagent_type` is preserved exactly for the
 * actual OpenCode dispatch and for event logging. Only the canonical role
 * is used for policy decisions (scope, role-based denial, severity).
 */

// Patterns that indicate the subagent return contains red flags.
const RETURN_WARNING_PATTERNS: Array<{
	category: string;
	regex: RegExp;
}> = [
	// H3 fix: broaden each pattern to catch common rephrasings that the
	// previous narrow regexes missed (e.g. "bypassed", "extended scope",
	// "per upstream documentation", "deferred verification").
	{
		category: 'skipped_tests',
		regex:
			/\b(?:skipped (?:the )?tests?|tests? (?:were |was )?skipped|did(?:n['']t)? run tests?|tests? not run|bypass(?:ed)? (?:the )?tests?|test (?:step|phase) (?:was )?bypass|tests? (?:are )?failing|tests? (?:are )?broken)\b/i,
	},
	{
		category: 'tool_timeout',
		regex:
			/\b(?:tool|process|command|test|build|lint)\s+(?:timed out|timeout|hung|killed|aborted|terminated|did not (?:complete|finish))/i,
	},
	{
		category: 'scope_changed',
		regex:
			/\b(?:expanded|changed|widened|exceeded|broke|extended|enlarged|grew|altered|adjusted) (?:the )?(?:declared |working |task |allowed )?(?:scope|file ?list|file ?set|working set|set of files)\b|\bscope (?:expansion|creep|drift|change)\b/i,
	},
	{
		category: 'external_instructions',
		regex:
			/\b(?:followed |received |applied |honored |obeyed )?(?:instructions|directives|guidance|orders|commands|hints) (?:from|in|per|according to) (?:the )?(?:tool output|web|search|fetched|fetch|external|untrusted|upstream|page|site|doc|documentation|response|prompt)\b|\bper (?:the )?(?:upstream|external|fetched|web|tool) (?:doc|documentation|page|response|content|guidance)\b/i,
	},
	{
		category: 'unable_to_verify',
		regex:
			/\b(?:unable|could ?n['']t|cannot|can ?not|wasn['']?t able) (?:to )?(?:verify|confirm|reproduce|test|check|validate|prove)\b|\bverification (?:deferred|skipped|postponed|incomplete|pending|impossible)\b/i,
	},
	{
		category: 'missing_evidence',
		regex:
			/\b(?:no |missing |without |lacking )(?:evidence|proof|verification|tests? passing|test results|coverage)\b|\bevidence (?:is )?(?:missing|absent|unavailable)\b/i,
	},
	{
		category: 'out_of_scope_files',
		regex:
			/\b(?:created|generated|wrote|modified|added|edited|patched|touched) (?:files? |code )?(?:outside|beyond|past|not in|that (?:are|were) outside) (?:the )?(?:declared |task |coder |allowed )?(?:scope|file ?list|file ?set|allowed (?:paths|files))\b/i,
	},
];

// Severity classification — these categories are severe and pause Full-Auto.
const SEVERE_CATEGORIES = new Set<string>([
	'external_instructions',
	'out_of_scope_files',
]);

const CANONICAL_ROLES_LOWER = new Set<string>(
	(ALL_AGENT_NAMES as readonly string[]).map((s) => s.toLowerCase()),
);

function isExactCanonicalRole(name: string): boolean {
	return CANONICAL_ROLES_LOWER.has(name.toLowerCase());
}

function isTaskTool(toolName: string): boolean {
	const lower = toolName?.toLowerCase() ?? '';
	return lower === 'task' || lower === 'agent' || lower === 'delegate';
}

function extractText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object') {
		const o = value as Record<string, unknown>;
		if (typeof o.output === 'string') return o.output;
		if (typeof o.text === 'string') return o.text;
		if (typeof o.summary === 'string') return o.summary;
		try {
			return JSON.stringify(o);
		} catch {
			return '';
		}
	}
	return '';
}

function detectReturnWarnings(text: string): Array<{
	category: string;
	matched: string;
}> {
	const warnings: Array<{ category: string; matched: string }> = [];
	if (!text) return warnings;
	const seen = new Set<string>();
	for (const { category, regex } of RETURN_WARNING_PATTERNS) {
		const m = text.match(regex);
		if (!m) continue;
		const key = `${category}:${m[0].toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		warnings.push({ category, matched: m[0] });
	}
	return warnings;
}

async function writeDelegationEvent(
	directory: string,
	event: Record<string, unknown>,
): Promise<void> {
	const lockTaskId = `full-auto-delegation-${Date.now()}`;
	let lockResult: Awaited<ReturnType<typeof tryAcquireLock>> | undefined;
	try {
		lockResult = await tryAcquireLock(
			directory,
			'events.jsonl',
			'full-auto-delegation',
			lockTaskId,
		);
	} catch (error) {
		logger.warn(
			`[full-auto/delegation] failed to acquire lock: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		const eventsPath = validateSwarmPath(directory, 'events.jsonl');
		fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, 'utf-8');
	} catch (error) {
		logger.error(
			`[full-auto/delegation] failed to write event: ${error instanceof Error ? error.message : String(error)}`,
		);
		throw error;
	} finally {
		if (lockResult?.acquired && lockResult.lock._release) {
			try {
				await lockResult.lock._release();
			} catch (releaseError) {
				logger.error(
					'[full-auto/delegation] lock release failed:',
					releaseError,
				);
			}
		}
	}
}

export interface FullAutoDelegationHookOptions {
	config: PluginConfig;
	directory: string;
}

interface ToolBeforeInput {
	tool: string;
	sessionID: string;
	callID?: string;
}

interface ToolBeforeOutput {
	args: unknown;
}

interface ToolAfterInput {
	tool: string;
	sessionID: string;
	callID?: string;
	args?: unknown;
}

interface ToolAfterOutput {
	output?: unknown;
	error?: unknown;
}

export function createFullAutoDelegationHook(
	options: FullAutoDelegationHookOptions,
): {
	toolBefore: (
		input: ToolBeforeInput,
		output: ToolBeforeOutput,
	) => Promise<void>;
	toolAfter: (input: ToolAfterInput, output: ToolAfterOutput) => Promise<void>;
} {
	const { config, directory } = options;
	// First-class toggle: always armed; both handlers below gate at runtime on
	// the durable per-session run state (status !== 'running' → return).
	return {
		toolBefore: async (input, output) => {
			const tool = (
				normalizeToolName(input.tool) ??
				input.tool ??
				''
			).toLowerCase();
			if (!isTaskTool(tool)) return;
			const sessionID = input.sessionID;
			if (!sessionID) return;
			const runState = loadFullAutoRunState(directory, sessionID);
			if (!runState || runState.status !== 'running') return;

			const args = (output.args as Record<string, unknown> | undefined) ?? {};
			// Preserve the original generated subagent name EXACTLY for the
			// real OpenCode dispatch. The plugin must not rewrite or mutate
			// `subagent_type`; only inspect it for policy decisions.
			const subagentRaw =
				(typeof args.subagent_type === 'string' && args.subagent_type) ||
				(typeof args.agent === 'string' && args.agent) ||
				'';
			// Adversarial review C1+H3 fix: use the registry-aware strict
			// canonical role extractor when a generated-agent registry is
			// available, AND additionally reject names whose prefix portion
			// is empty / whitespace-only / separator-only. This blocks two
			// classes of bypass:
			//   * `not_an_architect` collapsing to `architect` via the
			//     bare suffix scan (the strict variant requires the name
			//     to be in the registry of actually-generated agents).
			//   * `_coder`, `-coder`, ` coder` (separator-only prefix)
			//     resolving to `coder` regardless of registry.
			const generatedAgentRegistry = swarmState.generatedAgentNames;
			const canonicalRole =
				generatedAgentRegistry.length > 0
					? resolveGeneratedAgentRole(subagentRaw, generatedAgentRegistry)
					: getCanonicalAgentRole(subagentRaw);
			// Reject delegations whose prefix portion is missing or contains
			// only separator characters. Real generated names always have a
			// non-trivial swarm-ID prefix (e.g. `banana_coder`).
			if (
				subagentRaw &&
				canonicalRole !== subagentRaw &&
				!isExactCanonicalRole(subagentRaw)
			) {
				const prefix = subagentRaw.slice(
					0,
					subagentRaw.length - canonicalRole.length - 1,
				);
				if (!prefix || !/[A-Za-z0-9]/.test(prefix)) {
					throw new Error(
						`FULL_AUTO_DELEGATION_DENY: subagent name '${subagentRaw}' has no valid prefix before the canonical role '${canonicalRole}'. Generated agent names must include a non-empty swarm prefix.`,
					);
				}
			}
			const promptText =
				(typeof args.prompt === 'string' && args.prompt) ||
				(typeof args.message === 'string' && args.message) ||
				(typeof args.task === 'string' && args.task) ||
				'';

			incrementFullAutoCounter(directory, sessionID, 'coderDelegations');

			// Outbound check 1: subagent must resolve to a canonical role the
			// plugin understands. Rejects unknown roles regardless of which
			// swarm ID the user picks.
			if (!subagentRaw || !isKnownCanonicalRole(canonicalRole)) {
				throw new Error(
					`FULL_AUTO_DELEGATION_DENY: unknown subagent '${subagentRaw}' (canonical role '${canonicalRole}' is not a registered plugin role). Choose a generated agent whose suffix matches one of the canonical roles.`,
				);
			}

			// Outbound check 2: coder delegation must include declared scope —
			// either via prior declare_scope (session.declaredCoderScope) or in
			// the args.files / args.scope payload. The check is keyed on the
			// CANONICAL role, so `bananaSwarm_coder` is treated identically to
			// the unprefixed `coder` for the scope requirement.
			if (canonicalRole === 'coder') {
				const session = swarmState.agentSessions.get(sessionID);
				const declared = session?.declaredCoderScope;
				const argScope =
					Array.isArray((args as Record<string, unknown>).files) ||
					Array.isArray((args as Record<string, unknown>).scope);
				if ((!declared || declared.length === 0) && !argScope) {
					throw new Error(
						`FULL_AUTO_DELEGATION_DENY: coder delegation '${subagentRaw}' requires declared scope. Call declare_scope first or include 'files' in the Task arguments.`,
					);
				}
			}

			// Outbound check 3: protected paths in delegation prompt.
			if (promptText && typeof promptText === 'string') {
				// Heuristic: look for explicit file paths in the prompt and check
				// whether any of them are protected.
				const candidatePaths = promptText.match(
					/\b[A-Za-z0-9._/-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|toml|lock|sh|env)\b/g,
				);
				if (candidatePaths) {
					for (const p of candidatePaths) {
						if (isProtectedPath(p, config.full_auto)) {
							// Record advisory, then return — let the permission hook's
							// escalate_critic path handle the actual decision when the
							// subagent's first write fires.
							await writeDelegationEvent(directory, {
								type: 'full_auto_subagent_warning',
								timestamp: new Date().toISOString(),
								session_id: sessionID,
								// Log both the original generated name (dispatch identity)
								// and the canonical role (policy attribution).
								subagent: subagentRaw,
								canonical_role: canonicalRole,
								phase: 'outbound',
								category: 'protected_path_in_prompt',
								matched: p,
							});
						}
					}
				}
			}
		},

		toolAfter: async (input, output) => {
			const tool = (
				normalizeToolName(input.tool) ??
				input.tool ??
				''
			).toLowerCase();
			if (!isTaskTool(tool)) return;
			const sessionID = input.sessionID;
			if (!sessionID) return;
			const runState = loadFullAutoRunState(directory, sessionID);
			if (!runState || runState.status !== 'running') return;

			const text = extractText(output.output);
			const warnings = detectReturnWarnings(text);
			if (warnings.length === 0) return;

			const severe = warnings.some((w) => SEVERE_CATEGORIES.has(w.category));

			await writeDelegationEvent(directory, {
				type: 'full_auto_subagent_warning',
				timestamp: new Date().toISOString(),
				session_id: sessionID,
				phase: 'return',
				warnings,
				severe,
			});

			runState.counters.consecutiveNoProgressTurns = severe
				? runState.counters.consecutiveNoProgressTurns + 1
				: runState.counters.consecutiveNoProgressTurns;
			saveFullAutoRunState(directory, runState);

			if (severe) {
				// Pause the run so the next risky action surfaces a re-enable prompt.
				const updated = loadFullAutoRunState(directory, sessionID);
				if (updated && updated.status === 'running') {
					updated.status = 'paused';
					updated.pauseReason = `severe subagent return warning: ${warnings
						.filter((w) => SEVERE_CATEGORIES.has(w.category))
						.map((w) => w.category)
						.join(',')}`;
					saveFullAutoRunState(directory, updated);
				}
			}
		},
	};
}
