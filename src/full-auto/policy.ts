/**
 * Full-Auto v2 deterministic policy engine.
 *
 * Classifies tool actions BEFORE any LLM critic call. The classifier is pure:
 * it reasons exclusively from user intent, plan/task/scope, tool name, args,
 * trusted config and known protected paths. It explicitly does NOT consume
 * raw assistant prose or raw tool output as authorization evidence.
 *
 * Decisions:
 *   - allow             — deterministically safe, no critic needed
 *   - deny              — deterministically unsafe (out-of-scope/repo, secrets,
 *                         destructive shell, prod deploys, guardrail bypass).
 *                         Recoverable means the agent can choose another path.
 *   - escalate_critic   — ambiguous or medium/high risk; requires a read-only
 *                         critic verdict before proceeding.
 *   - escalate_human    — irreversible/external/product-design decision;
 *                         pause and surface to a human.
 *   - pause             — Full-Auto run must pause durably (denial threshold,
 *                         fail-closed condition).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	AGENT_TOOL_MAP,
	COUNCIL_AGENT_TOOL_MAP,
	EXTERNAL_SKILL_AGENT_TOOL_MAP,
	GENERAL_COUNCIL_AGENT_TOOL_MAP,
	MEMORY_AGENT_TOOL_MAP,
	SKILL_AGENT_TOOL_MAP,
	SKILL_TOOL_NAMES,
	TURBO_AGENT_TOOL_MAP,
	WRITE_TOOL_NAMES,
} from '../config/constants';
import {
	getCanonicalAgentRole,
	isKnownCanonicalRole,
	resolveGeneratedAgentRole,
} from '../config/schema';
import { classifyCommand } from '../security/command-classifier.js';
import { isPolicyProtectedPath } from '../security/protected-path-policy.js';
import { normalizePath } from '../utils/path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FullAutoActionTier = 'safe' | 'local' | 'medium' | 'high';

export type FullAutoDecision =
	| { action: 'allow'; reason: string; tier: 'safe' | 'local' }
	| {
			action: 'deny';
			reason: string;
			code: string;
			recoverable: boolean;
	  }
	| {
			action: 'escalate_critic';
			reason: string;
			risk: 'medium' | 'high';
			context: Record<string, unknown>;
	  }
	| { action: 'escalate_human'; reason: string; code: string }
	| { action: 'pause'; reason: string; code: string };

export interface FullAutoPolicyConfig {
	enabled?: boolean;
	mode?: 'assisted' | 'supervised' | 'strict';
	permission_policy?: {
		enabled?: boolean;
		trusted_roots?: string[];
		trusted_domains?: string[];
		protected_paths?: string[];
		allow_defaults?: boolean;
	};
	oversight?: {
		on_high_risk_action?: boolean;
		on_task_completion?: boolean;
	};
}

export interface FullAutoClassifierInput {
	sessionID: string;
	agentName?: string;
	normalizedAgentName?: string;
	generatedAgentNames?: string[];
	toolName: string;
	args: Record<string, unknown> | undefined;
	directory: string;
	workingDirectory?: string;
	declaredScope?: string[] | null;
	currentTaskID?: string | null;
	currentPhase?: number;
	planSummary?: string;
	changedFiles?: string[];
	fullAutoConfig: FullAutoPolicyConfig | undefined;
	pluginConfig?: {
		memory?: { enabled?: boolean };
		external_skills?: { curation_enabled?: boolean };
		council?: { enabled?: boolean; general?: { enabled?: boolean } };
		turbo?: unknown;
		skills?: { enabled?: boolean };
		tool_filter?: { overrides?: Record<string, string[]> };
	};
}

// ---------------------------------------------------------------------------
// Tool classification helpers
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS = new Set<string>([
	// swarm read-only / verification tools
	'check_gate_status',
	'completion_verify',
	'evidence_check',
	'get_approved_plan',
	'get_qa_gate_profile',
	'diff',
	'diff_summary',
	'imports',
	'symbols',
	'batch_symbols',
	'search',
	'repo_map',
	'retrieve_summary',
	'knowledge_recall',
	'knowledge_query',
	'co_change_analyzer',
	'complexity_hotspots',
	'detect_domains',
	// extract_code_blocks removed (issue #1778 C1): it writes files and must not
	// be auto-allowed as a read-only tool by the full-auto permission hook.
	// gitingest removed (M4): it performs a network fetch (gitingest.com) and
	// must NOT short-circuit as safe/allow. It now lives in NETWORK_TOOLS so
	// full-auto escalates it to the critic instead of auto-approving.
	'lint',
	'lint_spec',
	'pkg_audit',
	'placeholder_scan',
	'pre_check_batch',
	'quality_budget',
	'sast_scan',
	'sbom_generate',
	'schema_drift',
	'secretscan',
	'syntax_check',
	'test_impact',
	'todo_extract',
	'doc_scan',
	'doc_extract',
	'req_coverage',
	'req_coverage'.toLowerCase(),
	// opencode native read tools (opaque to the swarm but commonly reachable)
	'read',
	'glob',
	'grep',
	'list',
	'ls',
	'view',
]);

const WRITE_LIKE_TOOLS = new Set<string>([
	...WRITE_TOOL_NAMES,
	'multiedit',
	'multi_edit',
	'todo_write',
	'save_plan',
	'update_task_status',
	'phase_complete',
	'declare_scope',
	'declare_council_criteria',
	'submit_council_verdicts',
	'submit_phase_council_verdicts',
	'set_qa_gates',
	'write_retro',
	'write_drift_evidence',
	'write_hallucination_evidence',
	'write_mutation_evidence',
	'knowledge_add',
	'knowledge_remove',
	'curator_analyze',
	// Issue #1821 Workstream C: writes an immutable report under
	// `.swarm/evolution/consensus/`. Classified here so it never falls through
	// to the unknown-tool branch below, which escalates to the critic on EVERY
	// invocation.
	'consensus_mine',
	'suggest_patch',
]);

const SHELL_TOOLS = new Set<string>(['bash', 'shell', 'exec', 'run']);

const NETWORK_TOOLS = new Set<string>([
	'web_search',
	'webfetch',
	'web_fetch',
	'fetch',
	'http',
	'request',
	// M4: gitingest fetches an external repository over the network
	// (gitingest.com). Classify it as a network tool so full-auto escalates
	// it to the critic rather than auto-allowing it as read-only.
	'gitingest',
]);

const SUBAGENT_TOOLS = new Set<string>(['task', 'agent', 'delegate']);

const HIGH_RISK_BUILD_PATHS = [
	'src/index.ts',
	'src/hooks/guardrails.ts',
	'src/hooks/delegation-gate.ts',
	'src/hooks/scope-guard.ts',
	'src/hooks/full-auto-permission.ts',
	'src/hooks/full-auto-intercept.ts',
	'src/full-auto/',
	'src/config/schema.ts',
	'src/config/constants.ts',
	'src/tools/phase-complete.ts',
	'src/tools/index.ts',
	'package.json',
	'package-lock.json',
	'bun.lock',
	'biome.json',
	'tsconfig.json',
	'CHANGELOG.md',
	'.release-please-manifest.json',
	'release-please-config.json',
	'dist/',
	'.github/workflows/',
];

const ALWAYS_PROTECTED_PREFIXES = ['.git/', '.git\\'];

const PROTECTED_PATH_DEFAULTS = [
	'.git',
	'.github/workflows',
	// Plugin config — a full-auto agent must not edit the config that
	// controls full-auto itself (e.g. clearing `full_auto.locked`).
	'.opencode',
	'.swarm',
	'package.json',
	'package-lock.json',
	'bun.lock',
	'CHANGELOG.md',
	'.release-please-manifest.json',
	'release-please-config.json',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isReadOnlyTool(toolName: string): boolean {
	if (!toolName) return false;
	return READ_ONLY_TOOLS.has(toolName.toLowerCase());
}

export function isWriteLikeTool(toolName: string): boolean {
	if (!toolName) return false;
	return WRITE_LIKE_TOOLS.has(toolName.toLowerCase());
}

export function isSubagentDelegation(
	toolName: string,
	args: Record<string, unknown> | undefined,
): boolean {
	const lower = toolName?.toLowerCase() ?? '';
	if (SUBAGENT_TOOLS.has(lower)) return true;
	if (lower === 'task' && args && typeof args === 'object') return true;
	return false;
}

function isWithinDirectory(target: string, root: string): boolean {
	if (!target || !root) return false;
	const resolvedTarget = path.resolve(target);
	const resolvedRoot = path.resolve(root);
	if (resolvedTarget === resolvedRoot) return true;
	const withSep = resolvedRoot.endsWith(path.sep)
		? resolvedRoot
		: resolvedRoot + path.sep;
	if (process.platform === 'win32') {
		return resolvedTarget.toLowerCase().startsWith(withSep.toLowerCase());
	}
	return resolvedTarget.startsWith(withSep);
}

export function isProtectedPath(
	filePath: string,
	config: FullAutoPolicyConfig | undefined,
): boolean {
	if (!filePath) return false;
	const normalized = normalizePath(filePath);
	for (const prefix of ALWAYS_PROTECTED_PREFIXES) {
		const np = normalizePath(prefix);
		if (normalized === np || normalized.startsWith(`${np}/`)) return true;
	}
	const allowDefaults = config?.permission_policy?.allow_defaults !== false;
	return isPolicyProtectedPath(normalized, {
		includeDefaults: allowDefaults,
		additional: [
			...(allowDefaults ? PROTECTED_PATH_DEFAULTS : []),
			...((config?.permission_policy?.protected_paths as string[]) ?? []),
		],
	});
}

export function classifyPathRisk(
	filePath: string,
	context: { directory: string; declaredScope?: string[] | null },
): {
	withinProjectRoot: boolean;
	withinDeclaredScope: boolean | null;
	protected: boolean;
	highRiskBuild: boolean;
} {
	if (!filePath) {
		return {
			withinProjectRoot: false,
			withinDeclaredScope: null,
			protected: false,
			highRiskBuild: false,
		};
	}
	const absolute = path.isAbsolute(filePath)
		? filePath
		: path.resolve(context.directory, filePath);
	// H1 fix: resolve symlinks for the deepest existing ancestor of the
	// target — but ONLY when that ancestor is inside the project root.
	// Symlink-escape risk only exists for symlinks placed INSIDE the
	// project root (e.g. `<root>/passwd-link -> /etc/passwd`); if the
	// deepest existing ancestor is at or above the project root, the
	// target is being created fresh and there is nothing to resolve.
	// Falling back to the unresolved absolute when no in-root ancestor
	// exists keeps the test-friendly "non-existent path under fake root"
	// case working.
	const resolvedAbsolute = (() => {
		try {
			let candidate = absolute;
			let depth = 0;
			while (depth < 32) {
				if (fs.existsSync(candidate)) {
					if (isWithinDirectory(candidate, context.directory)) {
						try {
							return fs.realpathSync(candidate);
						} catch {
							return candidate;
						}
					}
					// Existing ancestor is at/above the project root — no
					// in-root symlink chain to resolve.
					return absolute;
				}
				const parent = path.dirname(candidate);
				if (parent === candidate) break;
				candidate = parent;
				depth += 1;
			}
			return absolute;
		} catch {
			return absolute;
		}
	})();
	// withinProjectRoot must hold for BOTH the unresolved absolute AND the
	// resolved variant. A symlink target outside the project root means
	// `resolvedAbsolute` will fall outside even when `absolute` is inside.
	const withinProjectRoot =
		isWithinDirectory(absolute, context.directory) &&
		isWithinDirectory(resolvedAbsolute, context.directory);
	const relative = normalizePath(path.relative(context.directory, absolute));
	let withinDeclaredScope: boolean | null = null;
	if (Array.isArray(context.declaredScope)) {
		withinDeclaredScope =
			context.declaredScope.length === 0
				? false
				: context.declaredScope.some((scope) => {
						const s = normalizePath(scope);
						if (!s) return false;
						return relative === s || relative.startsWith(`${s}/`);
					});
	}
	const highRiskBuild = HIGH_RISK_BUILD_PATHS.some((entry) => {
		const e = normalizePath(entry);
		if (e.endsWith('/')) {
			return relative.startsWith(e);
		}
		return relative === e || relative.startsWith(`${e}/`);
	});
	return {
		withinProjectRoot,
		withinDeclaredScope,
		protected: false,
		highRiskBuild,
	};
}

const FULL_AUTO_SECRET_READ_PATTERN =
	/\b(?:cat|head|tail|less|more)\s+[^\n]*(?:\.env|credentials|id_rsa|id_ed25519|\.pem|\.key)\b/i;
const FULL_AUTO_SECRET_ENV_PATTERN =
	/\bprintenv\b.*(?:SECRET|TOKEN|KEY|PASSWORD)/i;
const FULL_AUTO_PRIMARY_PUSH_PATTERN =
	/\bgit\s+push\s+(?:[^\s]+\s+)?(?:main|master|production|prod)\b/i;

export function classifyCommandRisk(
	command: string,
	_cwd: string,
	_context: { directory: string },
): { decision: 'allow' | 'deny' | 'escalate_critic'; reason: string } {
	if (
		FULL_AUTO_SECRET_READ_PATTERN.test(command) ||
		FULL_AUTO_SECRET_ENV_PATTERN.test(command) ||
		FULL_AUTO_PRIMARY_PUSH_PATTERN.test(command)
	) {
		return {
			decision: 'deny',
			reason:
				'full-auto consumer policy: command reads secrets or targets a primary branch push',
		};
	}
	const classification = classifyCommand(command);
	if (
		classification.aggregate === 'catastrophic' ||
		classification.aggregate === 'destructive'
	) {
		return {
			decision: 'deny',
			reason: `shared classifier: ${classification.aggregate}`,
		};
	}
	if (classification.aggregate === 'safe') {
		return { decision: 'allow', reason: 'shared classifier: safe' };
	}
	return {
		decision: 'escalate_critic',
		reason: `shared classifier: ${classification.aggregate}`,
	};
}

// ---------------------------------------------------------------------------
// Path extraction from tool args
// ---------------------------------------------------------------------------

const PATH_ARG_KEYS = [
	'file_path',
	'filepath',
	'path',
	'file',
	'target',
	'to',
	'dest',
	'destination',
	'output_path',
];

function extractPathArgs(
	toolName: string,
	args: Record<string, unknown> | undefined,
): string[] {
	if (!args || typeof args !== 'object') return [];
	const found: string[] = [];
	for (const key of PATH_ARG_KEYS) {
		const v = args[key];
		if (typeof v === 'string' && v.trim()) found.push(v);
	}
	const filesArg = args.files;
	if (Array.isArray(filesArg)) {
		for (const f of filesArg) {
			if (typeof f === 'string' && f.trim()) found.push(f);
			else if (
				f &&
				typeof f === 'object' &&
				typeof (f as Record<string, unknown>).path === 'string'
			) {
				found.push((f as Record<string, string>).path);
			}
		}
	}
	const editsArg = args.edits;
	if (Array.isArray(editsArg)) {
		for (const e of editsArg) {
			if (
				e &&
				typeof e === 'object' &&
				typeof (e as Record<string, unknown>).file_path === 'string'
			) {
				found.push((e as Record<string, string>).file_path);
			}
		}
	}
	if (toolName === 'declare_scope' && Array.isArray(args.files)) {
		// already captured above
	}
	return found;
}

function extractCommandArg(
	args: Record<string, unknown> | undefined,
): string | undefined {
	if (!args || typeof args !== 'object') return undefined;
	const command =
		(typeof args.command === 'string' && args.command) ||
		(typeof args.cmd === 'string' && args.cmd) ||
		(typeof args.script === 'string' && args.script);
	return command || undefined;
}

function extractURLArg(
	args: Record<string, unknown> | undefined,
): string | undefined {
	if (!args || typeof args !== 'object') return undefined;
	const url =
		(typeof args.url === 'string' && args.url) ||
		(typeof args.uri === 'string' && args.uri) ||
		(typeof args.endpoint === 'string' && args.endpoint);
	return url || undefined;
}

function isTrustedDomain(
	url: string,
	config: FullAutoPolicyConfig | undefined,
): boolean {
	const domains = config?.permission_policy?.trusted_domains ?? [];
	if (domains.length === 0) return false;
	let host = '';
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	return domains.some((d) => {
		const dl = d.toLowerCase();
		return host === dl || host.endsWith(`.${dl}`);
	});
}

function resolveAgentCapabilityTools(
	roleName: string,
	pluginConfig: FullAutoClassifierInput['pluginConfig'],
): string[] {
	const override = pluginConfig?.tool_filter?.overrides?.[roleName];
	let tools =
		override ?? AGENT_TOOL_MAP[roleName as keyof typeof AGENT_TOOL_MAP] ?? [];

	if (pluginConfig?.memory?.enabled === true) {
		tools = Array.from(
			new Set([
				...tools,
				...(MEMORY_AGENT_TOOL_MAP[
					roleName as keyof typeof MEMORY_AGENT_TOOL_MAP
				] ?? []),
			]),
		);
	}
	if (pluginConfig?.external_skills?.curation_enabled === true) {
		tools = Array.from(
			new Set([
				...tools,
				...(EXTERNAL_SKILL_AGENT_TOOL_MAP[
					roleName as keyof typeof EXTERNAL_SKILL_AGENT_TOOL_MAP
				] ?? []),
			]),
		);
	}
	if (pluginConfig?.council?.enabled === true) {
		tools = Array.from(
			new Set([
				...tools,
				...(COUNCIL_AGENT_TOOL_MAP[
					roleName as keyof typeof COUNCIL_AGENT_TOOL_MAP
				] ?? []),
			]),
		);
	}
	if (pluginConfig?.council?.general?.enabled === true) {
		tools = Array.from(
			new Set([
				...tools,
				...(GENERAL_COUNCIL_AGENT_TOOL_MAP[
					roleName as keyof typeof GENERAL_COUNCIL_AGENT_TOOL_MAP
				] ?? []),
			]),
		);
	}
	if (pluginConfig?.turbo !== undefined) {
		tools = Array.from(
			new Set([
				...tools,
				...(TURBO_AGENT_TOOL_MAP[
					roleName as keyof typeof TURBO_AGENT_TOOL_MAP
				] ?? []),
			]),
		);
	}
	const skillTools =
		SKILL_AGENT_TOOL_MAP[roleName as keyof typeof SKILL_AGENT_TOOL_MAP] ?? [];
	if (skillTools.length > 0) {
		if (pluginConfig?.skills?.enabled === true) {
			tools = Array.from(new Set([...tools, ...skillTools]));
		} else {
			const skillSet = new Set<string>(skillTools);
			tools = tools.filter((tool) => !skillSet.has(tool));
		}
	}
	// Extended FR-004 hard gate, mirroring getAgentConfigs (issue #2528): with
	// skills disabled the skill tools are denied for every role except
	// skill_improver, even when a tool_filter override names them. Keeps this
	// derivation input-identical to the emission (anti-drift parity test).
	if (pluginConfig?.skills?.enabled !== true && roleName !== 'skill_improver') {
		const allSkillTools = new Set<string>(SKILL_TOOL_NAMES);
		tools = tools.filter((tool) => !allSkillTools.has(tool));
	}
	return tools;
}

function resolveDelegationRisk(
	input: FullAutoClassifierInput,
	subagentName: string,
): {
	risk: 'medium' | 'high';
	reason: string;
	role: string;
	tools: string[];
	safeReadOnly: boolean;
} {
	const role =
		input.generatedAgentNames && input.generatedAgentNames.length > 0
			? resolveGeneratedAgentRole(subagentName, input.generatedAgentNames)
			: getCanonicalAgentRole(subagentName);
	if (!isKnownCanonicalRole(role)) {
		return {
			risk: 'high',
			reason: 'subagent role is unknown or not registry-backed',
			role,
			tools: [],
			safeReadOnly: false,
		};
	}
	const tools = resolveAgentCapabilityTools(role, input.pluginConfig);
	if (tools.length === 0) {
		return {
			risk: 'high',
			reason: 'subagent has no registered capability map',
			role,
			tools,
			safeReadOnly: false,
		};
	}
	const dangerous = tools.some(
		(tool) =>
			isWriteLikeTool(tool) ||
			SHELL_TOOLS.has(tool) ||
			NETWORK_TOOLS.has(tool) ||
			tool === 'swarm_command' ||
			tool === 'Task' ||
			tool === 'task',
	);
	const unknown = tools.some(
		(tool) =>
			!isReadOnlyTool(tool) &&
			!isWriteLikeTool(tool) &&
			!SHELL_TOOLS.has(tool) &&
			!NETWORK_TOOLS.has(tool) &&
			tool !== 'swarm_command',
	);
	if (dangerous || unknown) {
		return {
			risk: 'high',
			reason: dangerous
				? 'delegated role can write, execute, publish, or recurse'
				: 'delegated role exposes non-read-only unknown capabilities',
			role,
			tools,
			safeReadOnly: false,
		};
	}
	return {
		risk: 'medium',
		reason: 'delegated role is limited to registered read-only capabilities',
		role,
		tools,
		safeReadOnly: true,
	};
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

export function classifyFullAutoToolAction(
	input: FullAutoClassifierInput,
): FullAutoDecision {
	const tool = input.toolName?.toLowerCase() ?? '';
	const config = input.fullAutoConfig;
	const mode = config?.mode ?? 'supervised';
	// Adversarial review H2 fix: in strict mode, `permission_policy.enabled
	// = false` MUST NOT short-circuit the classifier. Strict mode is the
	// most-restrictive autonomy level and a typo in `permission_policy.
	// enabled` should not silently disable it. The override is honored only
	// in `assisted` and `supervised` modes.
	const policyEnabled =
		mode === 'strict' || config?.permission_policy?.enabled !== false;

	if (!policyEnabled) {
		return {
			action: 'allow',
			reason: 'permission policy disabled by config',
			tier: 'local',
		};
	}

	// 1. Read-only tools — always allow at safe tier (regardless of paths).
	if (isReadOnlyTool(tool)) {
		return {
			action: 'allow',
			reason: 'read-only tool',
			tier: 'safe',
		};
	}

	// 2. Subagent delegation — always escalate to critic so it can verify the
	//    delegation matches the plan/task and the subagent has declared scope.
	if (isSubagentDelegation(tool, input.args)) {
		const subagentName =
			(typeof input.args?.subagent_type === 'string' &&
				input.args.subagent_type) ||
			(typeof input.args?.agent === 'string' && input.args.agent) ||
			'unknown';
		const delegationRisk = resolveDelegationRisk(input, subagentName);
		if (mode !== 'strict' && delegationRisk.safeReadOnly) {
			return {
				action: 'allow',
				reason: `read-only subagent delegation allowed (${delegationRisk.role})`,
				tier: 'local',
			};
		}
		return {
			action: 'escalate_critic',
			reason: `subagent delegation requires plan/scope verification (${delegationRisk.reason})`,
			risk: mode === 'strict' ? 'high' : delegationRisk.risk,
			context: {
				tool,
				subagent: subagentName,
				canonicalRole: delegationRisk.role,
				registeredTools: delegationRisk.tools,
				currentTaskID: input.currentTaskID,
				currentPhase: input.currentPhase,
			},
		};
	}

	// 3. Phase-complete / task-completion / plan mutation are always escalated.
	if (tool === 'phase_complete') {
		return {
			action: 'escalate_critic',
			reason: 'phase_complete requires Full-Auto approval evidence',
			risk: 'high',
			context: { tool, currentPhase: input.currentPhase },
		};
	}
	if (tool === 'update_task_status') {
		const status =
			(typeof input.args?.status === 'string' && input.args.status) || '';
		if (status === 'completed') {
			if (mode === 'strict' || config?.oversight?.on_task_completion === true) {
				return {
					action: 'escalate_critic',
					reason: 'task completion requires Full-Auto critic verification',
					risk: 'medium',
					context: { tool, status },
				};
			}
			// supervised mode: completed status without on_task_completion
			// falls through to the safe-pathless-write allow path below.
		} else {
			// Adversarial review M3 fix: in strict mode, ALL plan-mutation
			// status changes escalate to the critic. Strict mode is the
			// most-restrictive autonomy level; even routine state-change
			// operations should be auditable.
			if (mode === 'strict') {
				return {
					action: 'escalate_critic',
					reason: `strict mode: update_task_status with status=${status} requires critic verification`,
					risk: 'medium',
					context: { tool, status },
				};
			}
			// M2 fix (supervised/assisted): non-completed status changes
			// are routine plan-management operations and should not
			// escalate to the critic. Allow.
			return {
				action: 'allow',
				reason: `update_task_status with status=${status} is a routine state change`,
				tier: 'local',
			};
		}
	}
	if (tool === 'save_plan') {
		return {
			action: 'escalate_critic',
			reason: 'plan mutation requires Full-Auto critic verification',
			risk: 'high',
			context: { tool },
		};
	}

	// 4. Network/web tools.
	if (NETWORK_TOOLS.has(tool)) {
		const url = extractURLArg(input.args);
		if (url && isTrustedDomain(url, config)) {
			return {
				action: 'allow',
				reason: 'network tool with trusted domain',
				tier: 'local',
			};
		}
		return {
			action: 'escalate_critic',
			reason: 'network/web tool — verify intent and target',
			risk: 'medium',
			context: { tool, url },
		};
	}

	// 5. Shell commands — classify the command string deterministically.
	if (SHELL_TOOLS.has(tool)) {
		const command = extractCommandArg(input.args);
		if (!command) {
			return {
				action: 'deny',
				reason: 'shell tool invoked without a command argument',
				code: 'shell_no_command',
				recoverable: true,
			};
		}
		const cmdRisk = classifyCommandRisk(command, input.workingDirectory ?? '', {
			directory: input.directory,
		});
		if (cmdRisk.decision === 'deny') {
			return {
				action: 'deny',
				reason: cmdRisk.reason,
				code: 'shell_deny',
				recoverable: true,
			};
		}
		if (cmdRisk.decision === 'allow') {
			return {
				action: 'allow',
				reason: cmdRisk.reason,
				tier: 'local',
			};
		}
		return {
			action: 'escalate_critic',
			reason: cmdRisk.reason,
			risk: 'medium',
			context: { tool, command },
		};
	}

	// 6. Write-like tools — path-based reasoning.
	if (isWriteLikeTool(tool) || tool === 'patch' || tool === 'edit') {
		const paths = extractPathArgs(tool, input.args);
		// Tools without paths (e.g. write_retro, set_qa_gates) are still write-like;
		// treat them as medium-risk and escalate so the critic can verify intent.
		if (paths.length === 0) {
			// Some write-like tools have well-defined effects and are integral to
			// the plan workflow. Allow when explicitly safe; otherwise escalate.
			const SAFE_PATHLESS_WRITES = new Set<string>([
				'declare_scope',
				'declare_council_criteria',
				'submit_council_verdicts',
				'submit_phase_council_verdicts',
				'set_qa_gates',
				'write_retro',
				'write_drift_evidence',
				'write_hallucination_evidence',
				'write_mutation_evidence',
				'knowledge_add',
				'knowledge_remove',
				'curator_analyze',
				// Pathless by construction — which is the property this set is
				// actually about. It takes no path argument, and every target it
				// touches is derived from mined content or from configuration, never
				// from caller input. That set is NOT a single file, and an earlier
				// version of this comment claiming it was made this auto-allow rest on
				// a false premise: `consensus_mine` writes its own
				// `.swarm/evolution/consensus/<reportId>.json`, DELETES its own older
				// reports past `consensus.report_retention`, rewrites the shared
				// recommendation dedup ledger whole (with FIFO eviction), leaves a lock
				// sentinel under `.swarm/locks/`, and — when `memory.enabled` — creates
				// a pending memory proposal. Under a knowledge or memory link the
				// ledger and memory store resolve to the shared cohort root rather than
				// this project's `.swarm/`.
				//
				// The classification still holds, for the same reason `knowledge_add`
				// and `knowledge_remove` sit in this set with the identical
				// cohort-redirection behaviour: none of those targets is a project
				// file, none is caller-supplied, and the redirection is operator
				// configuration. See `src/tools/consensus-mine.ts`'s module header for
				// the full enumerated effect list.
				'consensus_mine',
			]);
			if (SAFE_PATHLESS_WRITES.has(tool)) {
				return {
					action: 'allow',
					reason: `pathless plan/evidence tool '${tool}' allowed under Full-Auto`,
					tier: 'local',
				};
			}
			return {
				action: 'escalate_critic',
				reason: 'write-like tool without explicit path — verify side effects',
				risk: 'medium',
				context: { tool, args: input.args },
			};
		}
		for (const p of paths) {
			const risk = classifyPathRisk(p, {
				directory: input.directory,
				declaredScope: input.declaredScope ?? null,
			});
			if (!risk.withinProjectRoot) {
				return {
					action: 'deny',
					reason: `write target outside project root: ${p}`,
					code: 'path_out_of_root',
					recoverable: true,
				};
			}
			if (
				isProtectedPath(
					path.relative(input.directory, path.resolve(input.directory, p)),
					config,
				)
			) {
				return {
					action: 'escalate_critic',
					reason: `write to protected path requires critic approval: ${p}`,
					risk: 'high',
					context: { tool, path: p },
				};
			}
			if (risk.highRiskBuild) {
				return {
					action: 'escalate_critic',
					reason: `write to high-risk build/plugin path requires critic approval: ${p}`,
					risk: 'high',
					context: { tool, path: p },
				};
			}
			// Coder writes must respect declared scope. Architect/test_engineer/etc.
			// are not bound by declared coder scope.
			if (
				input.normalizedAgentName === 'coder' &&
				Array.isArray(input.declaredScope) &&
				input.declaredScope.length > 0 &&
				risk.withinDeclaredScope === false
			) {
				return {
					action: 'deny',
					reason: `coder write outside declared scope: ${p}`,
					code: 'path_out_of_scope',
					recoverable: true,
				};
			}
		}
		return {
			action: 'allow',
			reason: 'write within project root and declared scope',
			tier: 'local',
		};
	}

	// 7. Unknown tool — escalate to critic. We do not allow unknown tools by
	//    default in Full-Auto.
	return {
		action: 'escalate_critic',
		reason: `tool '${tool || '<empty>'}' not deterministically classifiable`,
		risk: 'medium',
		context: { tool },
	};
}

export interface StructuredDenial {
	full_auto_denial: true;
	tool?: string;
	code: string;
	reason: string;
	recoverable: boolean;
	guidance: string;
}

export function buildStructuredDenial(
	decision: Extract<FullAutoDecision, { action: 'deny' }>,
	tool?: string,
): StructuredDenial {
	return {
		full_auto_denial: true,
		tool,
		code: decision.code,
		reason: decision.reason,
		recoverable: decision.recoverable,
		guidance: decision.recoverable
			? 'Choose a safer path: stay within the project root, respect declared scope, avoid destructive shell, and avoid protected paths. Consider declaring scope or escalating to a human.'
			: 'This action cannot be retried under Full-Auto. Ask a human to authorize it.',
	};
}

/**
 * Tier-0 test seam (see the writing-tests skill): pure functions with no
 * external dependencies, exposed for direct testing. `resolveAgentCapabilityTools`
 * is the full-auto policy's parallel derivation of each role's effective tool
 * allow-list; tests pin it against getAgentConfigs' emission (issue #2528
 * anti-drift — the two derivations must stay input-identical).
 */
export const _test_exports = { resolveAgentCapabilityTools };
