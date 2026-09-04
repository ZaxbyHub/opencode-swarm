#!/usr/bin/env bun
/**
 * Commands reference generator — issue #2493 obligation 4 (source #1648).
 *
 * Renders the FULL `docs/commands.md` from `COMMAND_REGISTRY`
 * (src/commands/registry.ts). The hand-written per-command reference had
 * drifted from the registry (e.g. `/swarm turbo` was documented without the
 * `epic` argument); this generator closes that drift class by construction.
 *
 * Drift enforcement: `tests/unit/scripts/generate-commands-docs.test.ts`
 * imports `buildCommandsDoc()` and asserts the committed `docs/commands.md`
 * matches regeneration byte-for-byte (after CRLF normalization), so editing
 * the registry without rerunning this script fails the unit shards — a
 * required check. This script itself is a developer/CI convenience wrapper
 * around the same comparison. Nothing here runs on the plugin init path
 * (AGENTS.md invariant 1).
 *
 * Usage:
 *   bun run scripts/generate-commands-docs.ts           # check mode: exit 1 on drift
 *   bun run scripts/generate-commands-docs.ts --write   # regenerate docs/commands.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_CODE_CONFLICTS } from '../src/commands/conflict-registry';
import type { CommandCategory, CommandEntry } from '../src/commands/registry';
import { COMMAND_REGISTRY } from '../src/commands/registry';

export const COMMANDS_DOC_RELATIVE_PATH = 'docs/commands.md';

/** Category display order — mirrors buildHelpText (src/commands/index.ts). */
const CATEGORIES: readonly CommandCategory[] = [
	'core',
	'agent',
	'config',
	'diagnostics',
	'utility',
];

const CATEGORY_TITLES: Record<CommandCategory, string> = {
	core: 'Core',
	agent: 'Agent',
	config: 'Config',
	diagnostics: 'Diagnostics',
	utility: 'Utility',
};

/**
 * Registry keys intentionally omitted from the generated reference (#2493
 * obligation 4, source #1648). These are the mechanical compatibility
 * aliases: dash-form TUI shortcuts whose canonical space-form command is
 * documented (`blueprint-validate` → `blueprint validate`, `config-doctor` →
 * `config doctor`, …) plus legacy names (`plan`, `close`, `info`, `doctor`,
 * `health`, `check`, `clear`, `list-agents`, `diagnosis`) and space-form
 * spell-through aliases (`deep dive`, `deep research`, `codebase review`,
 * `design docs`) whose canonical dash-form command is documented.
 *
 * They REMAIN RESOLVABLE at runtime — `resolveCommand` dereferences them
 * through `aliasOf` and emits a deprecation warning — they are only hidden
 * from the docs so the reference lists each command exactly once under its
 * canonical name. A future alias added to COMMAND_REGISTRY but NOT added
 * here renders as a normal entry with a "Deprecated: use … instead" line.
 *
 * The generator cannot add a `hidden` field to `CommandEntry` (the registry
 * shape is owned by src/commands/registry.ts), so the list lives here. Every
 * key MUST exist in COMMAND_REGISTRY — a stale entry throws at generation
 * time so this list cannot silently rot.
 */
export const HIDDEN_COMMAND_KEYS: readonly string[] = [
	'blueprint-validate',
	'blueprint-current',
	'blueprint-history',
	'blueprint-diff',
	'blueprint-export',
	'harness-candidate-validate',
	'harness-candidate-show',
	'harness-candidate-diff',
	'context-map-stats',
	'config-doctor',
	'doctor-tools',
	'guardrail-explain',
	'guardrail-reset',
	'evidence-summary',
	'memory-status',
	'memory-export',
	'memory-import',
	'memory-migrate',
	'sdd-status',
	'sdd-validate',
	'sdd-project',
	'pr-subscribe',
	'pr-unsubscribe',
	'pr-status',
	'diagnosis',
	'list-agents',
	'health',
	'check',
	'clear',
	'doctor',
	'info',
	'plan',
	'close',
	'deep dive',
	'deep research',
	'codebase review',
	'design docs',
];

/**
 * Human-only escape hatches documented in their own dedicated section instead
 * of their category group, so they are findable when a workflow is wedged.
 * Both must exist in the registry as non-hidden standalone commands with
 * `toolPolicy: 'restricted'` — the generator throws otherwise.
 */
const ESCAPE_HATCH_COMMANDS: readonly string[] = [
	'abort-pr-workflow',
	'approve-plan-critic',
];

const HIDDEN_SET: ReadonlySet<string> = new Set(HIDDEN_COMMAND_KEYS);
const ESCAPE_HATCH_SET: ReadonlySet<string> = new Set(ESCAPE_HATCH_COMMANDS);

/** Escape a description for a markdown table cell (pipes and newlines). */
function escapeCell(text: string): string {
	return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function entry(key: string): CommandEntry {
	return COMMAND_REGISTRY[key as keyof typeof COMMAND_REGISTRY] as CommandEntry;
}

/** Fail fast on a stale HIDDEN/ESCAPE_HATCH list or a removed command. */
function validateGeneratorInputs(): void {
	for (const key of HIDDEN_COMMAND_KEYS) {
		if (!Object.hasOwn(COMMAND_REGISTRY, key)) {
			throw new Error(
				`HIDDEN_COMMAND_KEYS lists "${key}" which is not in COMMAND_REGISTRY — remove the stale entry from scripts/generate-commands-docs.ts`,
			);
		}
	}
	for (const key of ESCAPE_HATCH_COMMANDS) {
		const cmd = entry(key);
		if (!Object.hasOwn(COMMAND_REGISTRY, key) || !cmd) {
			throw new Error(
				`ESCAPE_HATCH_COMMANDS lists "${key}" which is not in COMMAND_REGISTRY`,
			);
		}
		if (HIDDEN_SET.has(key) || cmd.subcommandOf || cmd.aliasOf) {
			throw new Error(
				`Escape hatch "${key}" must be a non-hidden standalone command`,
			);
		}
		if (cmd.toolPolicy !== 'restricted') {
			throw new Error(
				`Escape hatch "${key}" must declare toolPolicy: 'restricted' (got '${String(cmd.toolPolicy)}')`,
			);
		}
	}
}

/**
 * Render one command entry (description, args, details, CC-conflict note,
 * and — for a non-hidden alias — the deprecation line). Shared by the
 * category reference, subcommand nesting, and the escape-hatch section.
 */
function pushEntry(
	lines: string[],
	key: string,
	cmd: CommandEntry,
	options: { headingLevel: 3 | 4; escapeHatch?: boolean } = { headingLevel: 3 },
): void {
	const heading = options.headingLevel === 3 ? '###' : '####';
	lines.push(`${heading} /swarm ${key}`, '');
	lines.push(cmd.description, '');
	if (cmd.args && cmd.args.trim() !== '') {
		lines.push(`**Args:** \`${cmd.args}\``, '');
	}
	if (options.escapeHatch) {
		lines.push(
			'**Human-only restricted command.** An agent cannot run this command itself through `swarm_command` (`toolPolicy: \'restricted\'`); when the situation above applies, the agent asks you to run it in chat (or uses its dedicated tool path).',
			'',
		);
	}
	if (cmd.details) {
		lines.push(cmd.details, '');
	}
	if (cmd.clashesWithNativeCcCommand) {
		lines.push(
			`**Claude Code conflict:** name clash with \`${cmd.clashesWithNativeCcCommand}\` — always use the full \`/swarm ${key}\` form.`,
			'',
		);
	}
	if (cmd.aliasOf) {
		lines.push(`Deprecated: use \`/swarm ${cmd.aliasOf}\` instead.`, '');
	}
}

function pushPreamble(lines: string[]): void {
	lines.push(
		'<!-- GENERATED FILE: docs/commands.md is fully generated from COMMAND_REGISTRY (src/commands/registry.ts) by scripts/generate-commands-docs.ts. Do not hand-edit. Regenerate with: bun run scripts/generate-commands-docs.ts --write -->',
		'',
		'# Commands Reference',
		'',
		'All `/swarm` subcommands available in the current OpenCode Swarm source tree. The authoritative source is `src/commands/registry.ts`; this page is generated from that registry, so the reference below cannot drift from the shipped commands. Edit the registry, then regenerate with `bun run scripts/generate-commands-docs.ts --write`.',
		'',
		'Commands are grouped by function (core, agent, config, diagnostics, utility). Compound commands (e.g., `/swarm config doctor`) resolve the two-word form first, then fall back to the first token. Additional deprecated compatibility aliases (dash-form TUI shortcuts and legacy names) still resolve to their canonical command with a deprecation warning but are intentionally not documented individually.',
		'',
		'First-class MODE commands are repo-agnostic. The npm package ships the built-in OpenCode mode skills and materializes private runtime copies under `.swarm/bundled-skills/` before emitting a MODE signal. Native project skill roots (`.opencode/skills/`, `.claude/skills/`, and `.agents/skills/`) remain project-owned and are never overwritten.',
		'',
		'## Running commands',
		'',
		'- **Inside an OpenCode session:** type `/swarm <subcommand>` in the chat. Session-scoped commands (`turbo`, `full-auto`) require an active session and only work here.',
		'- **Standalone CLI:** `opencode-swarm run <subcommand>` (e.g. `opencode-swarm run status`, `opencode-swarm run show-plan 2`). Both routes share the same registry; see `src/cli/index.ts` for the standalone dispatcher.',
		'',
		'## Claude Code Command Conflicts',
		'',
		'Several swarm subcommands share exact names with Claude Code built-in slash commands. This is a known source of model confusion — AI agents trained on Claude Code may try to invoke the CC built-in instead of the swarm subcommand. All swarm commands must use the full `/swarm <subcommand>` form; never reference a conflicting swarm subcommand by its bare name inside a swarm agent context.',
		'',
		'| Swarm Command | Conflicts With | Severity | CC Behavior |',
		'|---|---|---|---|',
	);
	for (const conflict of CLAUDE_CODE_CONFLICTS) {
		lines.push(
			`| \`/swarm ${conflict.swarmCommand}\` | \`${conflict.ccCommand}\` | ${conflict.severity} | ${escapeCell(conflict.ccBehavior)} |`,
		);
	}
	lines.push(
		'',
		'For contributors: adding a new swarm command that matches a CC built-in requires updating `src/commands/conflict-registry.ts` with an explicit severity and disambiguation note; the CI gate test in `src/commands/conflict-registry.test.ts` fails until this is done.',
		'',
	);
}

function pushEscapeHatchSection(lines: string[]): void {
	lines.push(
		'## Escape Hatches',
		'',
		'Two human-only restricted commands exist as escape hatches for wedged mechanical gates. They are documented here — not buried in a category group — because you need them exactly when a workflow is stuck. Both append an audit event to `.swarm/events.jsonl`.',
		'',
	);
	for (const key of ESCAPE_HATCH_COMMANDS) {
		pushEntry(lines, key, entry(key), { headingLevel: 3, escapeHatch: true });
	}
}

function pushCategoryReference(lines: string[]): void {
	// Group non-hidden, non-escape-hatch, non-subcommand commands by category
	// in registry (insertion) order — the same grouping buildHelpText uses.
	const byCategory = new Map<CommandCategory, string[]>();
	for (const cat of CATEGORIES) {
		byCategory.set(cat, []);
	}
	const subcommandsOf = new Map<string, string[]>();
	for (const key of Object.keys(COMMAND_REGISTRY)) {
		if (HIDDEN_SET.has(key) || ESCAPE_HATCH_SET.has(key)) continue;
		const cmd = entry(key);
		if (cmd.aliasOf && cmd.subcommandOf) continue; // hidden-style alias of a subcommand
		if (cmd.subcommandOf) {
			const list = subcommandsOf.get(cmd.subcommandOf) ?? [];
			list.push(key);
			subcommandsOf.set(cmd.subcommandOf, list);
			continue;
		}
		const category = (cmd.category ?? 'utility') as CommandCategory;
		const list = byCategory.get(category);
		if (list) list.push(key);
	}

	for (const cat of CATEGORIES) {
		const keys = byCategory.get(cat) ?? [];
		if (keys.length === 0) continue;
		lines.push(`## ${CATEGORY_TITLES[cat]}`, '');
		for (const key of keys) {
			pushEntry(lines, key, entry(key), { headingLevel: 3 });
			// Subcommands (subcommandOf === key) render nested under their
			// parent, mirroring buildHelpText's parent/subcommand grouping.
			for (const sub of subcommandsOf.get(key) ?? []) {
				pushEntry(lines, sub, entry(sub), { headingLevel: 4 });
			}
		}
	}
}

/**
 * Render the full docs/commands.md content (LF line endings, trailing
 * newline). Pure function of COMMAND_REGISTRY + CLAUDE_CODE_CONFLICTS —
 * deterministic across runs and platforms.
 */
export function buildCommandsDoc(): string {
	validateGeneratorInputs();
	const lines: string[] = [];
	pushPreamble(lines);
	pushEscapeHatchSection(lines);
	pushCategoryReference(lines);
	lines.push('<!-- end of generated commands reference -->');
	return `${lines.join('\n')}\n`;
}

export interface CommandsDocCheckResult {
	ok: boolean;
	message: string;
}

/**
 * Compare the committed docs/commands.md content (raw, possibly CRLF) against
 * regeneration. Exported so the check-mode message is testable without
 * spawning the script.
 */
export function checkCommandsDoc(
	committedRaw: string,
): CommandsDocCheckResult {
	const committed = committedRaw.replace(/\r\n/g, '\n');
	const generated = buildCommandsDoc();
	if (committed === generated) {
		return {
			ok: true,
			message: `${COMMANDS_DOC_RELATIVE_PATH} matches COMMAND_REGISTRY regeneration.`,
		};
	}
	const genLines = generated.split('\n');
	const comLines = committed.split('\n');
	let firstDiff = -1;
	for (
		let i = 0;
		i < Math.max(genLines.length, comLines.length) && firstDiff === -1;
		i++
	) {
		if (genLines[i] !== comLines[i]) firstDiff = i;
	}
	return {
		ok: false,
		message:
			`${COMMANDS_DOC_RELATIVE_PATH} is stale: regeneration from COMMAND_REGISTRY produces different content ` +
			`(${genLines.length} generated lines vs ${comLines.length} committed; first divergence at line ${firstDiff + 1}):\n` +
			`  generated: ${JSON.stringify(genLines[firstDiff] ?? '<eof>')}\n` +
			`  committed: ${JSON.stringify(comLines[firstDiff] ?? '<eof>')}\n` +
			`Regenerate with: bun run scripts/generate-commands-docs.ts --write`,
	};
}

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);

if (import.meta.main) {
	const docPath = path.join(REPO_ROOT, COMMANDS_DOC_RELATIVE_PATH);
	const write = process.argv.includes('--write');
	const unknownFlags = process.argv
		.slice(2)
		.filter((arg) => arg !== '--write');
	if (unknownFlags.length > 0) {
		console.error(`Unknown argument(s): ${unknownFlags.join(' ')}`);
		console.error('Usage: bun run scripts/generate-commands-docs.ts [--write]');
		process.exit(2);
	}
	if (write) {
		fs.writeFileSync(docPath, buildCommandsDoc(), 'utf-8');
		console.log(`commands docs: regenerated (${docPath})`);
		process.exit(0);
	}
	let committed: string;
	try {
		committed = fs.readFileSync(docPath, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			console.error(
				`${COMMANDS_DOC_RELATIVE_PATH} not found at ${docPath} — run with --write to generate it`,
			);
			process.exit(1);
		}
		throw err;
	}
	const result = checkCommandsDoc(committed);
	console.log(result.message);
	process.exit(result.ok ? 0 : 1);
}
