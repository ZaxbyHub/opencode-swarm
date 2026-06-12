import type { AgentDefinition } from '../agents/index.js';
import { syncBundledProjectSkillsIfMissing } from '../config/bundled-skills.js';
import { handleAcknowledgeSpecDriftCommand } from './acknowledge-spec-drift.js';
import { handleAgentsCommand } from './agents.js';
import { handleAnalyzeCommand } from './analyze.js';
import { handleArchiveCommand } from './archive.js';
import { handleAutoProceedCommand } from './auto-proceed.js';
import { handleBenchmarkCommand } from './benchmark.js';
import { handleBrainstormCommand } from './brainstorm.js';
import { handleCheckpointCommand } from './checkpoint.js';
import { handleClarifyCommand } from './clarify.js';
import { handleCloseCommand } from './close.js';
import { handleCodebaseReviewCommand } from './codebase-review.js';
import { handleConcurrencyCommand } from './concurrency.js';
import { handleConfigCommand } from './config.js';
import { handleCouncilCommand } from './council.js';
import { handleCurateCommand } from './curate.js';
import { handleDarkMatterCommand } from './dark-matter.js';
import { handleDeepDiveCommand } from './deep-dive.js';
import { handleDesignDocsCommand } from './design-docs.js';
import { handleDiagnoseCommand } from './diagnose.js';
import { handleDoctorCommand, handleDoctorToolsCommand } from './doctor.js';
import {
	handleEvidenceCommand,
	handleEvidenceSummaryCommand,
} from './evidence.js';
import { handleExportCommand } from './export.js';
import { handleFullAutoCommand } from './full-auto.js';
import { handleHandoffCommand } from './handoff.js';
import { handleHistoryCommand } from './history.js';
import { handleIssueCommand } from './issue.js';
import {
	handleKnowledgeListCommand,
	handleKnowledgeMigrateCommand,
	handleKnowledgeQuarantineCommand,
	handleKnowledgeRestoreCommand,
	handleKnowledgeRetryHardeningCommand,
	handleKnowledgeUnactionableCommand,
} from './knowledge.js';
import { handleLearningCommand } from './learning.js';
import {
	handleMemoryCommand,
	handleMemoryCompactCommand,
	handleMemoryEvaluateCommand,
	handleMemoryExportCommand,
	handleMemoryImportCommand,
	handleMemoryMigrateCommand,
	handleMemoryPendingCommand,
	handleMemoryRecallLogCommand,
	handleMemoryStaleCommand,
	handleMemoryStatusCommand,
} from './memory.js';
import { handlePlanCommand } from './plan.js';
import { handlePostMortemCommand } from './post-mortem.js';
import { handlePrFeedbackCommand } from './pr-feedback.js';
import { handlePrMonitorStatusCommand } from './pr-monitor-status.js';
import { handlePrReviewCommand } from './pr-review.js';
import { handlePrSubscribeCommand } from './pr-subscribe.js';
import { handlePrUnsubscribeCommand } from './pr-unsubscribe.js';
import { handlePreflightCommand } from './preflight.js';
import { handlePromoteCommand } from './promote.js';
import { handleQaGatesCommand } from './qa-gates.js';
import { handleResetCommand } from './reset.js';
import { handleResetSessionCommand } from './reset-session.js';
import { handleRetrieveCommand } from './retrieve.js';
import { handleRollbackCommand } from './rollback.js';
import {
	handleSddCommand,
	handleSddProjectCommand,
	handleSddStatusCommand,
	handleSddValidateCommand,
} from './sdd.js';
import { handleSimulateCommand } from './simulate.js';
import { handleSpecifyCommand } from './specify.js';
import { handleStatusCommand } from './status.js';
import { handleSyncPlanCommand } from './sync-plan.js';
import { handleTurboCommand } from './turbo.js';
import { handleWriteRetroCommand } from './write-retro.js';

// Inline help handler to avoid circular dependency with index.ts
// Uses registry's own VALID_COMMANDS and COMMAND_REGISTRY
function levenshteinDistance(a: string, b: string): number {
	const matrix: number[][] = [];
	for (let i = 0; i <= b.length; i++) {
		matrix[i] = [i];
	}
	for (let j = 0; j <= a.length; j++) {
		matrix[0][j] = j;
	}
	for (let i = 1; i <= b.length; i++) {
		for (let j = 1; j <= a.length; j++) {
			if (b.charAt(i - 1) === a.charAt(j - 1)) {
				matrix[i][j] = matrix[i - 1][j - 1];
			} else {
				matrix[i][j] = Math.min(
					matrix[i - 1][j - 1] + 1,
					matrix[i][j - 1] + 1,
					matrix[i - 1][j] + 1,
				);
			}
		}
	}
	return matrix[b.length][a.length];
}

function findSimilarCommands(query: string): string[] {
	const q = query.toLowerCase();
	// Early rejection for oversized queries — prevents DoS via pathological inputs
	if (q.length > 500) {
		return [];
	}

	const scored = VALID_COMMANDS.map((cmd) => {
		const cmdLower = cmd.toLowerCase();

		// (a) Full command levenshtein distance
		const fullScore = _internals.levenshteinDistance(q, cmdLower);

		// (b) Token-by-token scoring for compound commands
		let tokenScore = Infinity;
		if (cmd.includes(' ') || cmd.includes('-')) {
			const qTokens = q.split(/[\s-]+/);
			const cmdTokens = cmdLower.split(/[\s-]+/);
			let totalTokenDist = 0;
			for (const qt of qTokens) {
				if (qt.length === 0) continue;
				let minDist = Infinity;
				for (const ct of cmdTokens) {
					if (ct.length === 0) continue;
					const dist = _internals.levenshteinDistance(qt, ct);
					if (dist < minDist) minDist = dist;
				}
				totalTokenDist += minDist;
			}
			tokenScore = totalTokenDist;
		}

		// (c) Dash-stripped comparison
		const dashStrippedQ = q.replace(/-/g, '');
		const dashStrippedCmd = cmdLower.replace(/-/g, '');
		const dashScore = _internals.levenshteinDistance(
			dashStrippedQ,
			dashStrippedCmd,
		);

		// Use minimum across all scoring methods
		const score = Math.min(fullScore, tokenScore, dashScore);

		return { cmd, score };
	});

	scored.sort((a, b) => a.score - b.score);
	return scored.slice(0, 3).map((s) => s.cmd);
}

function buildDetailedHelp(commandName: string, entry: CommandEntry): string {
	const lines: string[] = [];
	lines.push(`## /swarm ${commandName}`, '');
	lines.push(entry.description, '');
	const usage = `/swarm ${commandName}`;
	lines.push(`**Usage:** \`${usage}\``, '');
	const argsDisplay = entry.args || 'None';
	lines.push(`**Args:** ${argsDisplay}`, '');
	lines.push('**Description:**');
	if (entry.details) {
		lines.push(entry.details);
	} else {
		lines.push(entry.description);
	}
	lines.push('');
	return lines.join('\n');
}

export async function handleHelpCommand(ctx: CommandContext): Promise<string> {
	const targetCommand = ctx.args.join(' ');

	if (!targetCommand) {
		// Return full help - but we need to import buildHelpText from index
		// Since we can't, return a simple message pointing to no-arg usage
		// The actual full help is returned by default when command not found
		const { buildHelpText } = await import('./index.js');
		return buildHelpText();
	}

	// Split targetCommand to tokens for resolveCommand
	const tokens = targetCommand.split(/\s+/);
	const resolved = _internals.resolveCommand(tokens);

	if (resolved) {
		return _internals.buildDetailedHelp(resolved.key, resolved.entry);
	}

	// Command not found - suggest similar commands
	const similar = _internals.findSimilarCommands(targetCommand);
	const { buildHelpText: fullHelp } = await import('./index.js');
	if (similar.length > 0) {
		return (
			`Command '/swarm ${targetCommand}' not found.\n` +
			`\n` +
			`Did you mean:\n` +
			similar.map((cmd) => `  - \`/swarm ${cmd}\``).join('\n') +
			`\n` +
			`\n` +
			`Showing full help:\n` +
			`\n` +
			fullHelp()
		);
	}

	return (
		`Command '/swarm ${targetCommand}' not found.\n` +
		`\n` +
		`Showing full help:\n` +
		`\n` +
		fullHelp()
	);
}

export type CommandContext = {
	directory: string;
	args: string[];
	sessionID: string;
	agents: Record<string, AgentDefinition>;
	packageRoot?: string;
	/**
	 * Dispatch path identifier. Issue #890: forensic audit trail for
	 * commands that need to distinguish "user typed /swarm <cmd>" (chat)
	 * from "user ran bunx opencode-swarm run <cmd>" (cli). Handlers that
	 * don't care can ignore this field. Optional for backwards-compatibility
	 * with existing callers.
	 */
	source?: 'cli' | 'chat';
};

export type CommandResult = Promise<string>;

async function handleModeCommandWithBundledSkills(
	ctx: CommandContext,
	handler: (directory: string, args: string[]) => string | CommandResult,
): CommandResult {
	if (ctx.packageRoot) {
		syncBundledProjectSkillsIfMissing(ctx.directory, ctx.packageRoot);
	}
	return Promise.resolve(handler(ctx.directory, ctx.args));
}

export type CommandCategory =
	| 'core'
	| 'agent'
	| 'config'
	| 'diagnostics'
	| 'utility';

export type CommandEntry = {
	handler: (ctx: CommandContext) => CommandResult;
	/** Human-readable description shown in /swarm help and CLI --help */
	description: string;
	/** If true, this command is only accessible as a sub-key of a parent command */
	subcommandOf?: string;
	/**
	 * 2-3 line behavioral summary: what the command does step-by-step,
	 * side effects, and safety guarantees.
	 */
	details?: string;
	/**
	 * Documents flags and positional arguments. Format: flags comma-separated with
	 * double-dash prefix, positional args in angle brackets.
	 * Example: args: '--dry-run, --confirm, <phase-number>'
	 */
	args?: string;
	/** Functional category for organization and filtering */
	category?: CommandCategory;
	/** Canonical command name this entry redirects to */
	aliasOf?: string;
	/** Whether this entry is deprecated — prefer aliasOf target instead */
	deprecated?: boolean;
	/** If set, this command shares a name with a Claude Code built-in slash command */
	clashesWithNativeCcCommand?: string;
};

// The registry is the single source of truth.
// Adding a command here automatically makes it available in both
// the in-session hook AND the standalone CLI run() entry point.
export const COMMAND_REGISTRY = {
	'acknowledge-spec-drift': {
		handler: (ctx) =>
			handleAcknowledgeSpecDriftCommand(
				ctx.directory,
				ctx.args,
				ctx.source === 'cli'
					? 'cli'
					: ctx.source === 'chat'
						? 'user'
						: 'unknown',
			),
		description:
			'Acknowledge that the spec has drifted from the plan and suppress further warnings',
		args: '',
		category: 'diagnostics',
	},
	status: {
		handler: (ctx) => handleStatusCommand(ctx.directory, ctx.agents),
		description: 'Show current swarm state',
		category: 'core',
		clashesWithNativeCcCommand: '/status',
	},
	'show-plan': {
		handler: (ctx) => handlePlanCommand(ctx.directory, ctx.args),
		description: 'Show current plan (optionally filter by phase number)',
		category: 'core',
		args: '[phase-number]',
	},
	plan: {
		handler: (ctx) => handlePlanCommand(ctx.directory, ctx.args),
		description: 'Show current plan (deprecated alias for /swarm show-plan)',
		category: 'core',
		clashesWithNativeCcCommand: '/plan',
		aliasOf: 'show-plan',
		deprecated: true,
	},
	agents: {
		// handleAgentsCommand is synchronous — wrap in Promise.resolve
		handler: (ctx) =>
			Promise.resolve(handleAgentsCommand(ctx.agents, undefined)),
		description: 'List registered agents',
		category: 'core',
		clashesWithNativeCcCommand: '/agents',
	},
	help: {
		handler: (ctx) => _internals.handleHelpCommand(ctx),
		description: 'Show help for swarm commands',
		category: 'core',
		args: '[command]',
		details:
			'Without argument, shows full command listing. With argument, shows detailed help for a specific command.',
	},
	history: {
		handler: (ctx) => handleHistoryCommand(ctx.directory, ctx.args),
		description: 'Show completed phases summary',
		category: 'utility',
		clashesWithNativeCcCommand: '/history',
	},
	config: {
		handler: (ctx) => handleConfigCommand(ctx.directory, ctx.args),
		description: 'Show current resolved configuration',
		category: 'config',
		clashesWithNativeCcCommand: '/config',
	},
	'config doctor': {
		handler: (ctx) => handleDoctorCommand(ctx.directory, ctx.args),
		description: 'Run config doctor checks',
		subcommandOf: 'config',
		category: 'diagnostics',
	},
	// Alias for TUI shortcut 'swarm-config-doctor' which extracts subcommand as 'config-doctor' (dash).
	// Without this alias the shortcut resolves to null and shows help text instead of running the command.
	'config-doctor': {
		handler: (ctx) => handleDoctorCommand(ctx.directory, ctx.args),
		description: 'Run config doctor checks',
		subcommandOf: 'config',
		category: 'diagnostics',
		aliasOf: 'config doctor',
		deprecated: true,
	},
	'doctor tools': {
		handler: (ctx) => handleDoctorToolsCommand(ctx.directory, ctx.args),
		description: 'Run tool registration coherence check',
		category: 'diagnostics',
	},
	diagnose: {
		handler: (ctx) => handleDiagnoseCommand(ctx.directory, ctx.args),
		description: 'Run health check on swarm state',
		category: 'diagnostics',
	},
	// Alias: users commonly type 'diagnosis' — route to the same handler as 'diagnose'.
	diagnosis: {
		handler: (ctx) => handleDiagnoseCommand(ctx.directory, ctx.args),
		description: 'Run health check on swarm state',
		category: 'diagnostics',
		aliasOf: 'diagnose',
		deprecated: true,
	},
	preflight: {
		handler: (ctx) => handlePreflightCommand(ctx.directory, ctx.args),
		description: 'Run preflight automation checks',
		category: 'diagnostics',
	},
	'sync-plan': {
		handler: (ctx) => handleSyncPlanCommand(ctx.directory, ctx.args),
		description: 'Ensure plan.json and plan.md are synced',
		args: '',
		category: 'config',
	},
	benchmark: {
		handler: (ctx) => handleBenchmarkCommand(ctx.directory, ctx.args),
		description: 'Show performance metrics [--cumulative] [--ci-gate]',
		args: '--cumulative, --ci-gate',
		category: 'diagnostics',
	},
	learning: {
		handler: (ctx) => handleLearningCommand(ctx.directory, ctx.args),
		description: 'Show learning metrics and violation trends',
		args: '--json, --phase <N>',
		details:
			'Computes aggregate learning metrics from knowledge events: violation-rate trends, directive application rates, escalation frequency, per-entry ROI, and never-applied entries. Surfaces a learning summary for the curator digest.',
		category: 'diagnostics',
	},
	export: {
		handler: (ctx) => handleExportCommand(ctx.directory, ctx.args),
		description: 'Export plan and context as JSON',
		args: '',
		details:
			'Exports the current plan and context as JSON to stdout. Useful for piping to external tools or debugging swarm state.',
		category: 'utility',
		clashesWithNativeCcCommand: '/export',
	},
	evidence: {
		handler: (ctx) => handleEvidenceCommand(ctx.directory, ctx.args),
		description: 'Show evidence bundles [taskId]',
		args: '<taskId>',
		details:
			'Displays review results, test verdicts, and other evidence bundles for the given task ID (e.g., "2.1").',
		category: 'utility',
	},
	'evidence summary': {
		handler: (ctx) => handleEvidenceSummaryCommand(ctx.directory),
		description: 'Generate evidence summary with completion ratio and blockers',
		subcommandOf: 'evidence',
		args: '',
		details:
			'Generates a summary showing completion ratio across all tasks, lists blockers, and identifies missing evidence.',
		category: 'utility',
	},
	// Alias for TUI shortcut 'swarm-evidence-summary' which extracts subcommand as 'evidence-summary' (dash).
	// Without this alias the shortcut resolves to null and shows help text instead of running the command.
	'evidence-summary': {
		handler: (ctx) => handleEvidenceSummaryCommand(ctx.directory),
		description: 'Generate evidence summary with completion ratio and blockers',
		subcommandOf: 'evidence',
		args: '',
		details:
			'Generates a summary showing completion ratio across all tasks, lists blockers, and identifies missing evidence.',
		category: 'utility',
		aliasOf: 'evidence summary',
		deprecated: true,
	},
	// Deprecation aliases for confusing command names
	doctor: {
		handler: (ctx) => handleDoctorCommand(ctx.directory, ctx.args),
		description: 'Run config doctor checks',
		category: 'diagnostics',
		aliasOf: 'config doctor',
		deprecated: true,
		clashesWithNativeCcCommand: '/doctor',
	},
	info: {
		handler: (ctx) => handleStatusCommand(ctx.directory, ctx.agents),
		description: 'Show current swarm state',
		category: 'core',
		aliasOf: 'status',
		deprecated: true,
	},
	'list-agents': {
		handler: (ctx) =>
			Promise.resolve(handleAgentsCommand(ctx.agents, undefined)),
		description: 'List registered agents',
		category: 'core',
		aliasOf: 'agents',
		deprecated: true,
	},
	health: {
		handler: (ctx) => handleDiagnoseCommand(ctx.directory, ctx.args),
		description: 'Run health check on swarm state',
		category: 'diagnostics',
		aliasOf: 'diagnose',
		deprecated: true,
	},
	check: {
		handler: (ctx) => handlePreflightCommand(ctx.directory, ctx.args),
		description: 'Run preflight automation checks',
		category: 'diagnostics',
		aliasOf: 'preflight',
		deprecated: true,
	},
	clear: {
		handler: (ctx) => handleResetSessionCommand(ctx.directory, ctx.args),
		description:
			'Clear session state while preserving plan, evidence, and knowledge',
		category: 'utility',
		aliasOf: 'reset-session',
		deprecated: true,
	},
	archive: {
		handler: (ctx) => handleArchiveCommand(ctx.directory, ctx.args),
		description: 'Archive old evidence bundles [--dry-run]',
		details:
			'Archives evidence bundles older than max_age_days (config, default 90) or beyond max_bundles cap (config, default 1000). --dry-run previews which bundles would be archived without deleting them. Applies two-tier retention: age-based first, then count-based on oldest remaining.',
		args: '--dry-run',
		category: 'utility',
	},
	curate: {
		handler: (ctx) => handleCurateCommand(ctx.directory, ctx.args),
		description: 'Run knowledge curation and hive promotion review',
		args: '',
		category: 'utility',
	},
	'dark-matter': {
		handler: (ctx) => handleDarkMatterCommand(ctx.directory, ctx.args),
		description: 'Detect hidden file couplings via co-change NPMI analysis',
		args: '--threshold <number>, --min-commits <number>',
		category: 'diagnostics',
	},
	finalize: {
		handler: (ctx) =>
			handleCloseCommand(ctx.directory, ctx.args, {
				sessionID: ctx.sessionID,
			}),
		description:
			'Use /swarm finalize to finalize the swarm project and archive evidence',
		details:
			'Idempotent 4-stage terminal finalization: (1) finalize writes retrospectives for in-progress phases, (2) archive creates timestamped bundle of swarm artifacts and evidence, (3) clean removes active-state files for a clean slate, (4) align performs safe git ff-only to main. Resets agent sessions and delegation chains. Reads .swarm/close-lessons.md for explicit lessons and runs curation. Use --skill-review to run the quota-bounded skill_improver in proposal mode.',
		args: '--prune-branches, --skill-review',
		category: 'core',
	},
	close: {
		handler: (ctx) =>
			handleCloseCommand(ctx.directory, ctx.args, {
				sessionID: ctx.sessionID,
			}),
		description:
			'Use /swarm close (deprecated alias) to finalize and archive swarm state',
		details:
			'Deprecated alias for /swarm finalize. Preserved for backward compatibility.',
		args: '--prune-branches, --skill-review',
		category: 'core',
		aliasOf: 'finalize',
		deprecated: true,
	},
	'post-mortem': {
		handler: (ctx) =>
			handlePostMortemCommand(ctx.directory, ctx.args, {
				sessionID: ctx.sessionID,
			}),
		description:
			'Run the post-mortem agent: project-end synthesis, queue triage, and final curation pass',
		details:
			'Reads .swarm/ evidence (knowledge entries, events, curator digests, proposals, retrospectives, drift reports) and produces a post-mortem report at .swarm/post-mortem-{planId}.md. Idempotent: re-runs skip if report exists unless --force is passed.',
		args: '--force',
		category: 'core',
	},
	concurrency: {
		handler: (ctx) =>
			handleConcurrencyCommand(ctx.directory, ctx.args, ctx.sessionID),
		description:
			'Manage runtime concurrency override for plan execution [set|status|reset]',
		args: 'set <N|preset>, status, reset',
		details:
			'Sets, queries, or clears a session-scoped concurrency override for max_concurrent_tasks during plan execution.\n' +
			"When set, the override takes precedence over the plan's locked execution_profile.max_concurrent_tasks.\n" +
			'The override is session-scoped — it does not modify the plan and is cleared on session reset.\n' +
			'\n' +
			'Subcommands:\n' +
			'  concurrency set <N>          — Set session concurrency to N (1-64)\n' +
			'  concurrency set <preset>      — Set to preset: min (1), medium (3), max (8)\n' +
			'  concurrency status            — Show effective concurrency (override, plan baseline, operational effective)\n' +
			'  concurrency reset             — Clear the session concurrency override\n' +
			'\n' +
			'Session-scoped — resets on new session.',
		category: 'utility',
	},
	simulate: {
		handler: (ctx) => handleSimulateCommand(ctx.directory, ctx.args),
		description:
			'Dry-run hidden coupling analysis with configurable thresholds',
		args: '--threshold <number>, --min-commits <number>',
		category: 'diagnostics',
	},
	sdd: {
		handler: (ctx) => handleSddCommand(ctx.directory, ctx.args),
		description:
			'Manage OpenSpec-compatible SDD artifacts and effective spec projection',
		args: 'status|validate|project [--json] [--change <id>] [--dry-run]',
		details:
			'Parent command for spec-driven development artifacts. Use sdd status to inspect .swarm/spec.md plus openspec/ artifacts, sdd validate to validate OpenSpec-compatible deltas, and sdd project to materialize the effective spec into .swarm/spec.md for planning.',
		category: 'utility',
	},
	'sdd status': {
		handler: (ctx) => handleSddStatusCommand(ctx.directory, ctx.args),
		description:
			'Show OpenSpec-compatible SDD status and effective spec source',
		subcommandOf: 'sdd',
		args: '[--json]',
		category: 'utility',
	},
	'sdd validate': {
		handler: (ctx) => handleSddValidateCommand(ctx.directory, ctx.args),
		description:
			'Validate OpenSpec-compatible artifacts and effective spec projection',
		subcommandOf: 'sdd',
		args: '[--json] [--change <id>]',
		category: 'utility',
	},
	'sdd project': {
		handler: (ctx) => handleSddProjectCommand(ctx.directory, ctx.args),
		description:
			'Materialize the OpenSpec-compatible effective spec into .swarm/spec.md',
		subcommandOf: 'sdd',
		args: '[--dry-run] [--json] [--change <id>]',
		category: 'utility',
	},
	analyze: {
		handler: (ctx) => handleAnalyzeCommand(ctx.directory, ctx.args),
		description: 'Analyze spec.md vs plan.md for requirement coverage gaps',
		args: '',
		category: 'agent',
	},
	clarify: {
		handler: (ctx) =>
			handleModeCommandWithBundledSkills(ctx, handleClarifyCommand),
		description: 'Clarify and refine an existing feature specification',
		args: '[description-text]',
		category: 'agent',
	},
	specify: {
		handler: (ctx) =>
			handleModeCommandWithBundledSkills(ctx, handleSpecifyCommand),
		description: 'Generate or import a feature specification [description]',
		args: '[description-text]',
		category: 'agent',
	},
	brainstorm: {
		handler: (ctx) =>
			handleModeCommandWithBundledSkills(ctx, handleBrainstormCommand),
		description:
			'Enter architect MODE: BRAINSTORM — structured seven-phase planning workflow [topic]',
		args: '[topic-text]',
		details:
			'Triggers the architect to run the brainstorm workflow: CONTEXT SCAN, single-question DIALOGUE, APPROACHES, DESIGN SECTIONS, SPEC WRITE + SELF-REVIEW, QA GATE SELECTION, TRANSITION. Use for new plans where requirements need to be drawn out before writing spec.md / plan.md.',
		category: 'agent',
	},
	council: {
		handler: (ctx) =>
			handleModeCommandWithBundledSkills(ctx, handleCouncilCommand),
		description:
			'Enter architect MODE: COUNCIL — multi-model deliberation [question] [--preset <name>] [--spec-review]',
		args: '<question> [--preset <name>] [--spec-review]',
		details:
			'Triggers the architect to convene a three-agent General Council: ' +
			'Generalist (reviewer model), Skeptic (critic model), and Domain Expert (SME model). ' +
			'Use --preset <name> to choose a named member preset from council.general.presets. ' +
			'The architect first runs 1–3 targeted web searches and passes a compiled RESEARCH CONTEXT ' +
			'to all three agents before dispatching them in parallel. ' +
			'Agents deliberate using the NSED peer-review protocol (Round 1 independent analysis, ' +
			'Round 2 MAINTAIN/CONCEDE/NUANCE for disagreements). ' +
			'The architect synthesizes the final answer directly from convene_general_council output. ' +
			'--spec-review switches to single-pass advisory mode for spec review. ' +
			'Requires council.general.enabled: true and a search API key in the resolved config: global ~/.config/opencode/opencode-swarm.json, then project .opencode/opencode-swarm.json overrides.',
		category: 'agent',
	},
	'pr-review': {
		handler: (ctx) =>
			handleModeCommandWithBundledSkills(ctx, handlePrReviewCommand),
		description:
			'Launch deep PR review with multi-lane analysis [url] [--council]',
		args: '<pr-url|owner/repo#N|N> [--council]',
		details:
			'Launches a structured PR review: reconstructs PR intent via obligation extraction cascade, runs 6 parallel explorer lanes (correctness, security, dependencies, docs-intent-vs-actual, tests, performance-architecture), validates findings through independent reviewer confirmation, applies critic challenge to HIGH/CRITICAL findings, synthesizes structured report. --council variant fires adversarial multi-model review. Supports full GitHub URL, owner/repo#N shorthand, or bare PR number (resolves against origin remote).',
		category: 'agent',
	},
	'pr-feedback': {
		handler: (ctx) =>
			handleModeCommandWithBundledSkills(ctx, handlePrFeedbackCommand),
		description:
			'Ingest and close known PR feedback (review comments, CI failures, conflicts) [pr] [instructions]',
		args: '[url|owner/repo#N|N] [instructions...]',
		details:
			'Triggers MODE: PR_FEEDBACK — ingests existing pull-request feedback (review threads, requested changes, CI/check failures, merge conflicts, stale branch state, pasted notes), verifies every claim against source, clusters related problems, fixes confirmed items, validates the branch, and reports closure status for every ledger item. Distinct from /swarm pr-review, which discovers new findings. The PR reference is optional: with none, the architect builds the ledger from the current PR/branch; text after the reference is forwarded as extra instructions. Supports full GitHub URL, owner/repo#N shorthand, or bare PR number (resolved against origin).',
		category: 'agent',
	},
	'pr subscribe': {
		handler: (ctx) =>
			handlePrSubscribeCommand(ctx.directory, ctx.args, ctx.sessionID),
		description:
			'Subscribe the current session to PR state-change notifications',
		args: '<pr-url|owner/repo#N|N>',
		details:
			'Subscribes the current session to receive advisory notifications for the specified PR. When pr_monitor.enabled is true, the background polling worker will detect CI failures, new comments, merge conflicts, review state changes, and merge/close events. Notifications are delivered as session-scoped advisories with dedup tokens. Supports full GitHub URL, owner/repo#N shorthand, or bare PR number (resolved against origin). Requires pr_monitor.enabled: true in config.',
		category: 'agent',
	},
	'pr unsubscribe': {
		handler: (ctx) =>
			handlePrUnsubscribeCommand(ctx.directory, ctx.args, ctx.sessionID),
		description:
			'Unsubscribe the current session from PR state-change notifications',
		args: '<pr-url|owner/repo#N|N>',
		details:
			'Unsubscribes the current session from receiving advisory notifications for the specified PR. Removes the active subscription record. Supports full GitHub URL, owner/repo#N shorthand, or bare PR number (resolved against origin).',
		category: 'agent',
	},
	'pr status': {
		handler: (ctx) =>
			handlePrMonitorStatusCommand(ctx.directory, ctx.args, ctx.sessionID),
		description: 'Show PR monitor subscription status for the current session',
		args: '',
		details:
			'Displays all active PR subscriptions for the current session. Shows PR URL, last checked time, watching status, and error count per subscription. Also shows total active subscriptions across all sessions.',
		category: 'agent',
	},
	'deep-dive': {
		handler: (ctx) =>
			handleModeCommandWithBundledSkills(ctx, handleDeepDiveCommand),
		description:
			'Launch deep codebase audit with parallel explorer waves, dual reviewers, and critic challenge [scope]',
		args: '<scope> [--profile standard|security|ux|architecture|full] [--max-explorers 1..8] [--json] [--skip-update] [--allow-dirty]',
		details:
			'Runs a read-only deep audit of the specified scope using parallel explorer waves (8-file cap per mission, ~3500 line guardrail), always 2 parallel reviewers for verification, and sequential critic challenge on HIGH/CRITICAL findings. Profiles select explorer lanes: standard (5 lanes), security, ux, architecture, full (all 8 lanes). Emits a structured findings report without mutating source code.',
		category: 'agent',
	},
	'deep dive': {
		handler: (ctx) =>
			handleModeCommandWithBundledSkills(ctx, handleDeepDiveCommand),
		description: 'Alias for /swarm deep-dive — launch deep codebase audit',
		args: '<scope> [--profile standard|security|ux|architecture|full] [--max-explorers 1..8] [--json] [--skip-update] [--allow-dirty]',
		category: 'agent',
		aliasOf: 'deep-dive',
	},
	'codebase-review': {
		handler: (ctx) =>
			handleModeCommandWithBundledSkills(ctx, handleCodebaseReviewCommand),
		description:
			'Launch codebase-review-swarm for a quote-grounded full-repo or large-subsystem audit',
		args: '[scope] [--mode phase0|complete|defect|security|correctness|testing|ui|performance|ai-slop|enhancements|custom] [--tracks <list>] [--continue <run-id>] [--json] [--skip-update] [--allow-dirty]',
		details:
			'Runs the codebase-review-swarm workflow: Phase 0 inventory, selected-track depth planning, non-diluting review passes, coverage closure, reviewer validation, critic challenge, and .swarm/review-v8 artifacts. Materializes the bundled skill package if missing, then emits a MODE signal; the architect workflow must not mutate source files.',
		category: 'agent',
	},
	'codebase review': {
		handler: (ctx) =>
			handleModeCommandWithBundledSkills(ctx, handleCodebaseReviewCommand),
		description:
			'Alias for /swarm codebase-review - launch codebase-review-swarm',
		args: '[scope] [--mode phase0|complete|defect|security|correctness|testing|ui|performance|ai-slop|enhancements|custom] [--tracks <list>] [--continue <run-id>] [--json] [--skip-update] [--allow-dirty]',
		category: 'agent',
		aliasOf: 'codebase-review',
	},
	'design-docs': {
		handler: (ctx) =>
			handleModeCommandWithBundledSkills(ctx, handleDesignDocsCommand),
		description:
			'Generate or sync language-agnostic design docs (domain, technical-spec, behavior-spec, reference/) for the project under build [description]',
		args: '<description> [--out <dir>] [--lang <name>] [--update]',
		details:
			'Triggers the architect to enter MODE: DESIGN_DOCS — delegates to the docs_design agent to author/sync docs/domain.md, docs/technical-spec.md, docs/behavior-spec.md, and docs/reference/* (plus reference/traceability.json and design-changelog.md). Normative docs are 100% language-agnostic; all framework-specific material is quarantined under reference/. --update syncs existing docs to current code/spec instead of generating fresh. Requires design_docs.enabled: true.',
		category: 'agent',
	},
	'design docs': {
		handler: (ctx) =>
			handleModeCommandWithBundledSkills(ctx, handleDesignDocsCommand),
		description: 'Alias for /swarm design-docs — generate or sync design docs',
		args: '<description> [--out <dir>] [--lang <name>] [--update]',
		category: 'agent',
		aliasOf: 'design-docs',
	},
	issue: {
		handler: (ctx) =>
			handleModeCommandWithBundledSkills(ctx, handleIssueCommand),
		description:
			'Ingest a GitHub issue into the swarm workflow [url] [--plan] [--trace] [--no-repro]',
		args: '<issue-url|owner/repo#N|N> [--plan] [--trace] [--no-repro]',
		details:
			'Triggers the architect to enter MODE: ISSUE_INGEST — ingests a GitHub issue, restructures it into a normalized intake note, localizes root cause through hypothesis-driven tracing, and outputs a resolution spec. --plan transitions to plan creation after spec generation. --trace runs the full fix-and-PR workflow (implies --plan). --no-repro skips the reproduction step. Supports full GitHub URL, owner/repo#N shorthand, or bare issue number (resolves against origin remote).',
		category: 'agent',
	},
	'qa-gates': {
		handler: (ctx) =>
			handleQaGatesCommand(ctx.directory, ctx.args, ctx.sessionID),
		description:
			'View or modify QA gate profile for the current plan [enable|override <gate>...]',
		args: '[show|enable|override] <gate>...',
		details:
			'show: display spec-level, session-override, and effective QA gates for the current plan. enable: persist gate(s) into the locked-once profile (architect; rejected after critic approval lock). override: session-only ratchet-tighter enable. Valid gates: reviewer, test_engineer, council_mode, sme_enabled, critic_pre_plan, hallucination_guard, sast_enabled, mutation_test, phase_council, drift_check, final_council.',
		category: 'config',
	},
	promote: {
		handler: (ctx) => handlePromoteCommand(ctx.directory, ctx.args),
		description: 'Manually promote lesson to hive knowledge',
		details:
			'Promotes a lesson directly to hive knowledge (--category flag sets category) or references an existing swarm lesson by ID (--from-swarm). Validates lesson text before promotion. Either direct text or --from-swarm ID is required.',
		args: '--category <category>, --from-swarm <lesson-id>, <lesson-text>',
		category: 'utility',
	},
	reset: {
		handler: (ctx) => handleResetCommand(ctx.directory, ctx.args),
		description: 'Clear swarm state files [--confirm]',
		details:
			'DELETES plan.md, context.md, and summaries/ directory from .swarm/. Stops background automation and clears in-memory queues. SAFETY: requires --confirm flag — without it, displays a warning and tips to export first.',
		args: '--confirm (required)',
		category: 'utility',
		clashesWithNativeCcCommand: '/reset',
	},
	'reset-session': {
		handler: (ctx) => handleResetSessionCommand(ctx.directory, ctx.args),
		description:
			'Clear session state while preserving plan, evidence, and knowledge',
		details:
			'Deletes only .swarm/session/state.json and any other session files. Clears in-memory agent sessions and delegation chains. Preserves plan, evidence, and knowledge for cross-session continuity.',
		args: '',
		category: 'utility',
	},
	rollback: {
		handler: (ctx) => handleRollbackCommand(ctx.directory, ctx.args),
		description: 'Restore swarm state to a checkpoint <phase>',
		details:
			'Restores .swarm/ state by directly overwriting files from a checkpoint directory (checkpoints/phase-<N>). Writes rollback event to events.jsonl. Without phase argument, lists available checkpoints. Partial failures are reported but processing continues.',
		args: '<phase-number>',
		category: 'utility',
	},
	retrieve: {
		handler: (ctx) => handleRetrieveCommand(ctx.directory, ctx.args),
		description: 'Retrieve full output from a summary <id>',
		args: '<summary-id>',
		details:
			'Loads the full tool output that was previously summarized (referenced by IDs like S1, S2). Use when you need the complete output instead of the truncated summary.',
		category: 'utility',
	},
	handoff: {
		handler: (ctx) => handleHandoffCommand(ctx.directory, ctx.args),
		description: 'Prepare state for clean model switch (new session)',
		args: '',
		details:
			'Generates handoff.md with full session state snapshot, including plan progress, recent decisions, and agent delegation history. Prepended to the next session prompt for seamless model switches.',
		category: 'core',
	},
	turbo: {
		handler: (ctx) =>
			handleTurboCommand(ctx.directory, ctx.args, ctx.sessionID),
		description:
			'Toggle Turbo Mode strategy for the active session [on|off|lean|standard|status]',
		args: 'on, off, lean, standard, status',
		details:
			'Toggles Turbo Mode for the current session. Supports two strategies:\n' +
			'\n' +
			'**Standard turbo** — skips non-critical QA gates for faster iteration.\n' +
			'**Lean turbo** — parallel lane execution with per-lane reviewer gates and file-lock conflict detection.\n' +
			'\n' +
			'Subcommands:\n' +
			'  turbo on           — enable turbo (uses lean when config turbo.strategy is "lean", otherwise standard)\n' +
			'  turbo off          — disable all turbo modes\n' +
			'  turbo lean on      — enable Lean Turbo explicitly\n' +
			'  turbo lean off     — disable Lean Turbo\n' +
			'  turbo lean         — toggle Lean Turbo on/off\n' +
			'  turbo standard on  — force standard turbo (disables lean even if config says lean)\n' +
			'  turbo standard off — disable all turbo modes (standard + lean)\n' +
			'  turbo status       — show detailed status including active strategy and lanes\n' +
			'\n' +
			'Session-scoped — resets on new session.',
		category: 'utility',
	},
	'full-auto': {
		handler: (ctx) =>
			handleFullAutoCommand(ctx.directory, ctx.args, ctx.sessionID),
		description: 'Toggle Full-Auto Mode for the active session [on|off]',
		args: 'on, off',
		details:
			'Toggles Full-Auto Mode which enables autonomous execution without confirmation prompts. When enabled, the architect proceeds through implementation steps automatically. Session-scoped — resets on new session. Use "on" or "off" to set explicitly, or toggle with no argument.',
		category: 'utility',
	},
	'auto-proceed': {
		handler: (ctx: CommandContext) =>
			handleAutoProceedCommand(ctx.directory, ctx.args, ctx.sessionID),
		description: 'Toggle or set auto-proceed override for the active session',
		args: '[on|off]',
		category: 'config',
		details:
			'Without argument, toggles auto-proceed mode. With "on" or "off", sets the state explicitly.',
	},
	'write-retro': {
		handler: (ctx) => handleWriteRetroCommand(ctx.directory, ctx.args),
		description:
			'Write a retrospective evidence bundle for a completed phase <json>',
		details:
			'Writes retrospective evidence bundle to .swarm/evidence/retro-{phase}/evidence.json. Required JSON: phase, summary, task_count, task_complexity, total_tool_calls, coder_revisions, reviewer_rejections, test_failures, security_findings, integration_issues. Optional: lessons_learned (max 5), top_rejection_reasons, task_id, metadata.',
		args: '<json: {phase, summary, task_count, task_complexity, ...}>',
		category: 'utility',
	},
	'knowledge migrate': {
		handler: (ctx) => handleKnowledgeMigrateCommand(ctx.directory, ctx.args),
		description: 'Migrate knowledge entries to the current format',
		subcommandOf: 'knowledge',
		details:
			'One-time migration from .swarm/context.md SME cache to .swarm/knowledge.jsonl. Skips if sentinel file .swarm/.knowledge-migrated exists, if context.md is absent, or if context.md is empty. Reports entries migrated, dropped (validation/dedup), and total processed.',
		args: '<directory>',
		category: 'utility',
	},
	'knowledge quarantine': {
		handler: (ctx) => handleKnowledgeQuarantineCommand(ctx.directory, ctx.args),
		description: 'Move a knowledge entry to quarantine <id> [reason]',
		subcommandOf: 'knowledge',
		details:
			'Moves a knowledge entry to quarantine with optional reason string (defaults to "Quarantined via /swarm knowledge quarantine command"). Validates entry ID format (1-64 alphanumeric/hyphen/underscore). Quarantined entries are excluded from knowledge queries.',
		args: '<entry-id> [reason]',
		category: 'utility',
	},
	'knowledge restore': {
		handler: (ctx) => handleKnowledgeRestoreCommand(ctx.directory, ctx.args),
		description: 'Restore a quarantined knowledge entry <id>',
		subcommandOf: 'knowledge',
		details:
			'Restores a quarantined knowledge entry back to the active knowledge store by ID. Validates entry ID format (1-64 alphanumeric/hyphen/underscore). Entry must currently be in quarantine state.',
		args: '<entry-id>',
		category: 'utility',
	},
	'knowledge unactionable': {
		handler: (ctx) =>
			handleKnowledgeUnactionableCommand(ctx.directory, ctx.args),
		description: 'List unactionable knowledge entries pending hardening',
		subcommandOf: 'knowledge',
		details:
			'Lists entries from .swarm/knowledge-unactionable.jsonl that failed the actionability gate. Shows pending entries (awaiting next hardening pass) and retire candidates (hardening failed). Use `/swarm knowledge retry-hardening` to reset retire candidates.',
		category: 'utility',
	},
	'knowledge retry-hardening': {
		handler: (ctx) =>
			handleKnowledgeRetryHardeningCommand(ctx.directory, ctx.args),
		description: 'Reset retire candidates for re-hardening [id]',
		subcommandOf: 'knowledge',
		details:
			'Resets the retire_candidate flag on unactionable entries so the next scheduled hardening pass re-attempts LLM enrichment. Without arguments, resets all retire candidates. With an ID prefix, resets only the matching entry.',
		args: '[entry-id]',
		category: 'utility',
	},
	knowledge: {
		handler: (ctx) => handleKnowledgeListCommand(ctx.directory, ctx.args),
		description: 'List knowledge entries',
		category: 'utility',
	},
	memory: {
		handler: (ctx) => handleMemoryCommand(ctx.directory, ctx.args),
		description: 'Show Swarm memory commands',
		category: 'utility',
	},
	'memory status': {
		handler: (ctx) => handleMemoryStatusCommand(ctx.directory, ctx.args),
		description: 'Show Swarm memory provider, JSONL, and migration status',
		subcommandOf: 'memory',
		args: '',
		category: 'diagnostics',
	},
	'memory pending': {
		handler: (ctx) => handleMemoryPendingCommand(ctx.directory, ctx.args),
		description: 'Show pending Swarm memory proposals and rejection reasons',
		subcommandOf: 'memory',
		args: '--limit <n>',
		category: 'diagnostics',
	},
	'memory recall-log': {
		handler: (ctx) => handleMemoryRecallLogCommand(ctx.directory, ctx.args),
		description: 'Summarize Swarm memory recall usage',
		subcommandOf: 'memory',
		args: '--limit <n>',
		category: 'diagnostics',
	},
	'memory compact': {
		handler: (ctx) => handleMemoryCompactCommand(ctx.directory, ctx.args),
		description: 'Compact deleted, superseded, and expired scratch memories',
		subcommandOf: 'memory',
		args: '--confirm',
		category: 'utility',
	},
	'memory stale': {
		handler: (ctx) => handleMemoryStaleCommand(ctx.directory, ctx.args),
		description: 'List stale and low-utility Swarm memories',
		subcommandOf: 'memory',
		args: '--limit <n>',
		category: 'diagnostics',
	},
	'memory export': {
		handler: (ctx) => handleMemoryExportCommand(ctx.directory, ctx.args),
		description: 'Export current Swarm memory to JSONL files',
		subcommandOf: 'memory',
		args: '',
		category: 'utility',
	},
	'memory evaluate': {
		handler: (ctx) => handleMemoryEvaluateCommand(ctx.directory, ctx.args),
		description: 'Run golden Swarm memory recall evaluation fixtures',
		subcommandOf: 'memory',
		args: '--json, --fixtures <directory>',
		category: 'diagnostics',
	},
	'memory import': {
		handler: (ctx) => handleMemoryImportCommand(ctx.directory, ctx.args),
		description: 'Import legacy JSONL memory into SQLite',
		subcommandOf: 'memory',
		args: '',
		category: 'utility',
	},
	'memory migrate': {
		handler: (ctx) => handleMemoryMigrateCommand(ctx.directory, ctx.args),
		description: 'Run the one-time legacy JSONL to SQLite migration',
		subcommandOf: 'memory',
		args: '',
		category: 'utility',
	},
	checkpoint: {
		handler: (ctx) => handleCheckpointCommand(ctx.directory, ctx.args),
		description:
			'Manage project checkpoints [save|restore|delete|list] <label>',
		details:
			'save: creates named snapshot of current .swarm/ state. restore: soft-resets to checkpoint by overwriting current .swarm/ files. delete: removes named checkpoint. list: shows all checkpoints with timestamps. All subcommands require a label except list.',
		args: '<save|restore|delete|list> <label>',
		category: 'utility',
		clashesWithNativeCcCommand: '/checkpoint',
	},
} as const satisfies Record<string, CommandEntry>;

export type RegisteredCommand = keyof typeof COMMAND_REGISTRY;

export const VALID_COMMANDS = Object.keys(
	COMMAND_REGISTRY,
) as RegisteredCommand[];

/**
 * Validates alias configuration in COMMAND_REGISTRY.
 * Checks for:
 * - aliasOf pointing to an existing command
 * - circular alias chains (A → B → C → A)
 * - duplicate alias targets (multiple aliases for different commands) — logged as warning, not error
 */
export function validateAliases(): {
	valid: boolean;
	errors: string[];
	warnings: string[];
} {
	const errors: string[] = [];
	const warnings: string[] = [];
	const aliasTargets = new Map<string, string[]>(); // aliasOf target → list of aliases

	for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
		const cmdEntry = entry as CommandEntry;
		if (cmdEntry.aliasOf) {
			const target = cmdEntry.aliasOf;

			// Check if alias target exists
			if (!Object.hasOwn(COMMAND_REGISTRY, target)) {
				errors.push(
					`Alias '${name}' points to non-existent command '${target}'`,
				);
				continue;
			}

			// Track alias targets for duplicate detection
			if (!aliasTargets.has(target)) {
				aliasTargets.set(target, []);
			}
			aliasTargets.get(target)!.push(name);

			// Check for circular aliases
			const visited = new Set<string>();
			const path: string[] = [];
			let current: string = target;
			while (current) {
				// Cast to CommandEntry to avoid type narrowing issues from `as const satisfies`
				const currentEntry = COMMAND_REGISTRY[
					current as RegisteredCommand
				] as CommandEntry;
				if (!currentEntry) break;

				if (visited.has(current)) {
					// Report full chain: start → ... → cycle_point → ...
					const cycleStart = path.indexOf(current);
					const fullChain = [
						name,
						...path.slice(0, cycleStart > 0 ? cycleStart : path.length),
						current,
					].join(' → ');
					errors.push(`Circular alias detected: ${fullChain}`);
					break;
				}
				visited.add(current);
				path.push(current);
				current = currentEntry.aliasOf || '';
			}
		}
	}

	// Check for duplicate alias targets — warn but don't fail
	for (const [target, aliases] of aliasTargets.entries()) {
		if (aliases.length > 1) {
			warnings.push(
				`Multiple aliases point to '${target}': ${aliases.join(', ')}`,
			);
		}
	}

	return { valid: errors.length === 0, errors, warnings };
}

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	handleHelpCommand: typeof handleHelpCommand;
	validateAliases: typeof validateAliases;
	resolveCommand: typeof resolveCommand;
	levenshteinDistance: typeof levenshteinDistance;
	findSimilarCommands: typeof findSimilarCommands;
	buildDetailedHelp: typeof buildDetailedHelp;
} = {
	handleHelpCommand,
	validateAliases,
	resolveCommand,
	levenshteinDistance,
	findSimilarCommands,
	buildDetailedHelp,
} as const;

// Validate at module load time — throw if invalid, log warnings
const validation = _internals.validateAliases();
if (!validation.valid) {
	throw new Error(
		`COMMAND_REGISTRY alias validation failed:\n${validation.errors.join('\n')}`,
	);
}
if (validation.warnings.length > 0) {
	console.warn(
		`COMMAND_REGISTRY alias warnings:\n${validation.warnings.join('\n')}`,
	);
}

/**
 * Resolves compound commands like "evidence summary" and "config doctor".
 * Tries a two-token compound key first, then falls back to a single-token key.
 * Returns a warning if the resolved command is a deprecated alias.
 */
export function resolveCommand(tokens: string[]): {
	entry: CommandEntry;
	remainingArgs: string[];
	key: string;
	warning?: string;
} | null {
	if (tokens.length === 0) return null;

	// Try two-token compound key first (e.g. "evidence summary")
	// Use Object.hasOwn to avoid prototype pollution via keys like "__proto__"
	if (tokens.length >= 2) {
		const compound = `${tokens[0]} ${tokens[1]}` as RegisteredCommand;
		if (Object.hasOwn(COMMAND_REGISTRY, compound)) {
			const entry = COMMAND_REGISTRY[compound] as CommandEntry;
			const warning = entry.deprecated
				? `⚠️ "/swarm ${compound}" is deprecated. Use "/swarm ${entry.aliasOf}" instead.`
				: undefined;
			return {
				entry,
				remainingArgs: tokens.slice(2),
				key: compound,
				warning,
			};
		}
	}

	// Fall back to single-token key
	const key = tokens[0] as RegisteredCommand;
	if (Object.hasOwn(COMMAND_REGISTRY, key)) {
		const entry = COMMAND_REGISTRY[key] as CommandEntry;
		const warning = entry.deprecated
			? `⚠️ "/swarm ${key}" is deprecated. Use "/swarm ${entry.aliasOf}" instead.`
			: undefined;
		return {
			entry,
			remainingArgs: tokens.slice(1),
			key,
			warning,
		};
	}

	return null;
}
