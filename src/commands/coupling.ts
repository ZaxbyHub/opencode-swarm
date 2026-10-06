/**
 * `/swarm coupling` — read-only coupling report (Epic mode, Capability B).
 *
 * Computes `p` for the current plan and surfaces the modules that contribute
 * most to detected coupling, with a ranked decoupling roadmap. Read-only:
 * changes no execution behavior; with the optional `--persist` flag, writes
 * a structured JSON report under `.swarm/epic/coupling-report.json` for
 * programmatic consumption.
 *
 * The report itself always runs (it is a diagnostic), but the co-change
 * signal honors the `epic.cochange.enabled` master gate (default
 * false): when it is not `true`, no git history is scanned, `p` reflects
 * declared-path conflicts only, and the report states that the co-change
 * signal is disabled by config (`cochangeSignal: 'disabled-by-config'` in
 * JSON output). Declared task scopes resolve from the authoritative v2
 * scope-binding store (what `declare_scope` writes), then `files_touched`.
 *
 * Flags:
 *   --phase <n>             Scope to one phase (default: whole plan).
 *   --threshold <number>    NPMI floor override (default: EpicConfigSchema 0.6).
 *   --min-co-changes <n>    Co-change-count floor override (default: 5).
 *   --format <fmt>          'markdown' (default) or 'json'.
 *   --persist               Also write JSON to .swarm/epic/coupling-report.json.
 *   --suggest               Also shape the whole plan (Epic v2 C7): the same
 *                           ranked advisory `save_plan` returns as
 *                           `epic_shaping` (`src/epic/shaping.ts`), with
 *                           the start's inputs (live declared scopes, learned
 *                           signals of the project prior, co-change when
 *                           enabled, the epic's wave width). Read-only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPluginConfigWithMeta } from '../config/index.js';
import type { Plan } from '../config/plan-schema.js';
import type { PluginConfig } from '../config/schema.js';
import { getCoChangeData, getCoChangePairs } from '../epic/cochange-source.js';
import { isEpicCochangeConfigEnabled } from '../epic/config-gate.js';
import {
	type CouplingReport,
	type CouplingTask,
	computeCouplingReport,
	type EpicCochangeSignalState,
	formatCouplingReportMarkdown,
} from '../epic/coupling-report.js';
import { resolveEpicDeclaredScopes } from '../epic/declared-scopes.js';
import { loadEpicLearningView } from '../epic/learning-store.js';
import { loadEpicPlanningSignals } from '../epic/planning-signals.js';
import {
	type EpicShapingReport,
	formatEpicShapingLines,
	shapeEpicPlan,
} from '../epic/shaping.js';
import {
	epicSizingContextFor,
	epicWaveWidth,
	isDirectoryOnDisk,
	isEpicPendingStatus,
} from '../epic/shaping-sizing.js';
import { isGitRepo } from '../git/branch.js';
import { loadPlanJsonOnly } from '../plan/manager.js';
import { atomicWriteSwarmFileSync } from '../utils/atomic-write';

interface CouplingCliArgs {
	phase?: number;
	threshold: number;
	minCoChanges: number;
	format: 'markdown' | 'json';
	persist: boolean;
	suggest: boolean;
	parseError?: string;
}

const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_MIN_CO_CHANGES = 5;

function parseArgs(args: string[]): CouplingCliArgs {
	const parsed: CouplingCliArgs = {
		threshold: DEFAULT_THRESHOLD,
		minCoChanges: DEFAULT_MIN_CO_CHANGES,
		format: 'markdown',
		persist: false,
		suggest: false,
	};

	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		const next = args[i + 1];
		switch (flag) {
			case '--phase': {
				if (!next) {
					parsed.parseError = '--phase requires a numeric argument';
					return parsed;
				}
				// Require a pure decimal integer — `parseInt('1.5', 10)` silently
				// truncates to 1, which would accept "--phase 1.5" as phase 1.
				if (!/^\d+$/.test(next)) {
					parsed.parseError = `--phase must be a positive integer (got '${next}')`;
					return parsed;
				}
				const v = Number.parseInt(next, 10);
				if (v < 1) {
					parsed.parseError = `--phase must be a positive integer (got '${next}')`;
					return parsed;
				}
				parsed.phase = v;
				i += 1;
				break;
			}
			case '--threshold': {
				if (!next) {
					parsed.parseError = '--threshold requires a numeric argument';
					return parsed;
				}
				const v = Number.parseFloat(next);
				if (Number.isNaN(v) || v < -1 || v > 1) {
					parsed.parseError = `--threshold must be a number in [-1, 1] (got '${next}')`;
					return parsed;
				}
				parsed.threshold = v;
				i += 1;
				break;
			}
			case '--min-co-changes': {
				if (!next) {
					parsed.parseError = '--min-co-changes requires a numeric argument';
					return parsed;
				}
				// Same rationale as --phase: reject silent truncation of decimals.
				if (!/^\d+$/.test(next)) {
					parsed.parseError = `--min-co-changes must be a positive integer (got '${next}')`;
					return parsed;
				}
				const v = Number.parseInt(next, 10);
				if (v < 1) {
					parsed.parseError = `--min-co-changes must be a positive integer (got '${next}')`;
					return parsed;
				}
				parsed.minCoChanges = v;
				i += 1;
				break;
			}
			case '--format': {
				if (!next || (next !== 'markdown' && next !== 'json')) {
					parsed.parseError = `--format must be 'markdown' or 'json' (got '${next ?? '<missing>'}')`;
					return parsed;
				}
				parsed.format = next;
				i += 1;
				break;
			}
			case '--persist':
				parsed.persist = true;
				break;
			case '--suggest':
				parsed.suggest = true;
				break;
			default:
				parsed.parseError = `unknown argument: ${flag}`;
				return parsed;
		}
	}
	return parsed;
}

/**
 * Atomic JSON write under `.swarm/epic/coupling-report.json` rooted at the
 * project directory. Mirrors the pattern in `src/turbo/lean/state.ts`:
 * tmp file + rename. The project root is the `directory` argument; we never
 * touch `process.cwd()` (AGENTS.md invariant 4).
 *
 * The tmp suffix is a random hex string (not `Date.now()`) so concurrent
 * callers cannot collide on the same path. If `rename` fails, the tmp file
 * is unlinked best-effort to avoid orphan accumulation under `.swarm/epic/`.
 */
/**
 * Persist the coupling report atomically via the canonical helper (issue
 * #2035): registered `canonical-v1` temp grammar (unique, non-predictable),
 * fsync, bounded rename retry, and exact own-temp cleanup — replacing the
 * previous local `target.tmp.<hex8>` temp whose grammar stays registered for
 * residue discovery.
 */
function persistReportJson(directory: string, report: CouplingReport): string {
	const epicDir = path.join(directory, '.swarm', 'epic');
	fs.mkdirSync(epicDir, { recursive: true });
	const filePath = path.join(epicDir, 'coupling-report.json');
	atomicWriteSwarmFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`);
	return filePath;
}

/**
 * Entry point invoked from the command registry. Returns the report
 * formatted per the `--format` flag, plus a one-line "wrote to ..." trailer
 * when `--persist` is on.
 */
export async function handleCouplingCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseArgs(args);
	if (parsed.parseError) {
		return `Error: ${parsed.parseError}\n\nUsage: /swarm coupling [--phase <n>] [--threshold <-1..1>] [--min-co-changes <n>] [--format markdown|json] [--persist] [--suggest]`;
	}

	const plan = await _internals.loadPlanJsonOnly(directory);
	if (plan === null) {
		return 'No plan found at `.swarm/plan.json`. Run `/swarm plan` to create one before measuring coupling.';
	}

	// Resolve task list. `--phase N` scopes to one phase; default = whole plan.
	let rawTasks: Array<{
		id: string;
		files_touched?: string[];
	}> = [];
	if (parsed.phase !== undefined) {
		const phase = plan.phases.find((p) => p.id === parsed.phase);
		if (!phase) {
			const available = plan.phases.map((p) => p.id).join(', ') || '(none)';
			return `Phase ${parsed.phase} not found. Available phases: ${available}`;
		}
		rawTasks = phase.tasks;
	} else {
		for (const phase of plan.phases) {
			for (const task of phase.tasks) {
				rawTasks.push(task);
			}
		}
	}

	// Build CouplingTask[] with declared-scope-first resolution (mirrors the
	// shared planner preflight in `src/turbo/lean/partition-common.ts`). ONE
	// plan-identity + v2 binding-set read for every task.
	const declaredScopes = resolveEpicDeclaredScopes(
		directory,
		plan,
		rawTasks.map((task) => task.id),
	);
	const tasks: CouplingTask[] = rawTasks.map((task) => {
		const scopeFiles = declaredScopes[task.id] ?? [];
		const scope: string[] =
			scopeFiles.length > 0 ? scopeFiles : (task.files_touched ?? []);
		return { id: task.id, scope };
	});

	// Co-change master gate. A config load failure fails closed (signal off).
	let cochangeEnabled = false;
	let config: PluginConfig | null = null;
	try {
		config = _internals.loadPluginConfigWithMeta(directory).config;
		cochangeEnabled = isEpicCochangeConfigEnabled(config);
	} catch {
		cochangeEnabled = false;
	}
	const cochangeSignal: EpicCochangeSignalState = cochangeEnabled
		? 'enabled'
		: 'disabled-by-config';
	const cochangePairs = cochangeEnabled
		? await _internals.getCoChangePairs(directory)
		: [];

	const report = computeCouplingReport(tasks, cochangePairs, {
		npmi: parsed.threshold,
		minCoChanges: parsed.minCoChanges,
	});

	let persistStatus:
		| { requested: false }
		| { requested: true; written: true; path: string }
		| { requested: true; written: false; error: string } = {
		requested: false,
	};
	if (parsed.persist) {
		try {
			const writtenAt = persistReportJson(directory, report);
			persistStatus = {
				requested: true,
				written: true,
				path: path.relative(directory, writtenAt).replace(/\\/g, '/'),
			};
		} catch (err) {
			persistStatus = {
				requested: true,
				written: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	const shaping = parsed.suggest
		? await shapeCurrentPlan(directory, plan, config ?? ({} as PluginConfig))
		: null;

	if (parsed.format === 'json') {
		// Embed persist status inside the JSON envelope so programmatic
		// consumers see persistence failures (previously this returned the
		// report verbatim even when --persist failed, silently misleading
		// the caller).
		return JSON.stringify(
			{
				...report,
				cochangeSignal,
				persist: persistStatus,
				...(shaping ? { shaping } : {}),
			},
			null,
			2,
		);
	}

	let persistTrailer = '';
	if (persistStatus.requested && persistStatus.written) {
		persistTrailer = `\n\n_Wrote structured report to \`${persistStatus.path}\`._`;
	} else if (persistStatus.requested && !persistStatus.written) {
		persistTrailer = `\n\n_Warning: failed to persist report (${persistStatus.error})._`;
	}
	const signalTrailer =
		cochangeSignal === 'disabled-by-config'
			? '\n\n_Co-change signal: disabled by config (`epic.cochange.enabled` is not true) — p reflects declared-path conflicts only._'
			: '\n\n_Co-change signal: enabled._';
	const shapingSection = shaping
		? `\n\n## Plan shaping (whole plan)\n\n${formatEpicShapingLines(shaping).join('\n')}`
		: '';
	return `${formatCouplingReportMarkdown(report)}${signalTrailer}${persistTrailer}${shapingSection}`;
}

/**
 * `--suggest`: shape the whole plan with `/swarm epic start`'s inputs —
 * live declared scopes, the project prior's learned signals, co-change
 * (fresh, when enabled) and the epic's wave width.
 */
async function shapeCurrentPlan(
	directory: string,
	plan: Plan,
	config: PluginConfig,
): Promise<EpicShapingReport> {
	const signals = await loadEpicPlanningSignals(
		directory,
		config,
		{
			loadLearningView: _internals.loadEpicLearningView,
			getCoChangeData: _internals.getCoChangeData,
			now: () => Date.now(),
		},
		null,
	);
	const pendingIds = plan.phases.flatMap((phase) =>
		phase.tasks
			.filter((task) => isEpicPendingStatus(task.status))
			.map((task) => task.id),
	);
	return shapeEpicPlan({
		...epicSizingContextFor(
			directory,
			config,
			epicWaveWidth(config, _internals.isGitRepo(directory)),
			signals,
		),
		phases: plan.phases,
		declared: resolveEpicDeclaredScopes(directory, plan, pendingIds),
		isDirectory: (entry) => isDirectoryOnDisk(directory, entry),
	});
}

/**
 * Test-only DI seam. Production code calls `_internals.fn(...)` so tests can
 * replace these without `mock.module` (AGENTS.md invariant 7).
 */
export const _internals: {
	loadPlanJsonOnly: typeof loadPlanJsonOnly;
	getCoChangePairs: typeof getCoChangePairs;
	getCoChangeData: typeof getCoChangeData;
	loadPluginConfigWithMeta: typeof loadPluginConfigWithMeta;
	loadEpicLearningView: typeof loadEpicLearningView;
	isGitRepo: typeof isGitRepo;
} = {
	loadPlanJsonOnly,
	getCoChangePairs,
	getCoChangeData,
	loadPluginConfigWithMeta,
	loadEpicLearningView,
	isGitRepo,
};
