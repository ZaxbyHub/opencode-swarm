/**
 * `/swarm coupling` — read-only coupling report (Epic mode, Capability B).
 *
 * Computes `p` for the current plan and surfaces the modules that contribute
 * most to detected coupling, with a ranked decoupling roadmap. Read-only:
 * changes no execution behavior; with the optional `--persist` flag, writes
 * a structured JSON report under `.swarm/epic/coupling-report.json` for
 * programmatic consumption.
 *
 * This command always runs independent of `turbo.epic.cochange.enabled`. The
 * config flag gates runtime planner integration (M3); `/swarm coupling` is a
 * diagnostic and what-if tool, so users can see the report before opting in.
 *
 * Flags:
 *   --phase <n>             Scope to one phase (default: whole plan).
 *   --threshold <number>    NPMI floor override (default: EpicConfigSchema 0.6).
 *   --min-co-changes <n>    Co-change-count floor override (default: 5).
 *   --format <fmt>          'markdown' (default) or 'json'.
 *   --persist               Also write JSON to .swarm/epic/coupling-report.json.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPlanJsonOnly } from '../plan/manager.js';
import { getCoChangePairs } from '../turbo/epic/cochange-source.js';
import {
	type CouplingReport,
	type CouplingTask,
	computeCouplingReport,
	formatCouplingReportMarkdown,
} from '../turbo/epic/coupling-report.js';
import { readTaskScopes } from '../turbo/lean/conflicts.js';

interface CouplingCliArgs {
	phase?: number;
	threshold: number;
	minCoChanges: number;
	format: 'markdown' | 'json';
	persist: boolean;
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
function persistReportJson(directory: string, report: CouplingReport): string {
	const epicDir = path.join(directory, '.swarm', 'epic');
	fs.mkdirSync(epicDir, { recursive: true });
	const filePath = path.join(epicDir, 'coupling-report.json');
	const tmpPath = `${filePath}.tmp.${randomBytes(8).toString('hex')}`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
	try {
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		// Clean up the tmp file so a failed rename does not leave stale data.
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// best-effort cleanup
		}
		throw err;
	}
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
		return `Error: ${parsed.parseError}\n\nUsage: /swarm coupling [--phase <n>] [--threshold <-1..1>] [--min-co-changes <n>] [--format markdown|json] [--persist]`;
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

	// Build CouplingTask[] with declared-scope-first resolution (mirrors Lean
	// Turbo's planner — see `src/turbo/lean/planner.ts:getValidatedFiles`).
	const tasks: CouplingTask[] = rawTasks.map((task) => {
		const scopeFiles = readTaskScopes(directory, task.id);
		const scope: string[] = scopeFiles ?? task.files_touched ?? [];
		return { id: task.id, scope };
	});

	const cochangePairs = await _internals.getCoChangePairs(directory);

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

	if (parsed.format === 'json') {
		// Embed persist status inside the JSON envelope so programmatic
		// consumers see persistence failures (previously this returned the
		// report verbatim even when --persist failed, silently misleading
		// the caller).
		return JSON.stringify({ ...report, persist: persistStatus }, null, 2);
	}

	let persistTrailer = '';
	if (persistStatus.requested && persistStatus.written) {
		persistTrailer = `\n\n_Wrote structured report to \`${persistStatus.path}\`._`;
	} else if (persistStatus.requested && !persistStatus.written) {
		persistTrailer = `\n\n_Warning: failed to persist report (${persistStatus.error})._`;
	}
	return `${formatCouplingReportMarkdown(report)}${persistTrailer}`;
}

/**
 * Test-only DI seam. Production code calls `_internals.fn(...)` so tests can
 * replace these without `mock.module` (AGENTS.md invariant 7).
 */
export const _internals: {
	loadPlanJsonOnly: typeof loadPlanJsonOnly;
	getCoChangePairs: typeof getCoChangePairs;
} = {
	loadPlanJsonOnly,
	getCoChangePairs,
};
