/**
 * `/swarm epic learning` and `/swarm epic prior [show|reset]` (Epic v2 C6)
 * — read-only views of what epics learned, and the one destructive action
 * (`prior reset`, two-step through the shared destructive-confirm
 * primitive: preview + token, then `--confirm=<token>`). See
 * `src/epic/learning.ts` (the model) and
 * `src/epic/learning-store.ts` (prior + posterior). Both work
 * regardless of the Epic config gate, like `status` and `close`.
 */

import * as path from 'node:path';
import {
	type EpicLearningSettings,
	type EpicLearningStats,
	epicHotEvidence,
	summarizeEpicLearning,
} from '../epic/learning.js';
import {
	EPIC_PRIOR_LEARNING_DISPLAY_PATH,
	EPIC_PRIOR_LEARNING_RELATIVE_PATH,
	type EpicLearningSource,
	loadEpicLearningView,
	readEpicPrior,
	resetEpicPrior,
} from '../epic/learning-store.js';
import { getOpenEpic } from '../epic/lifecycle.js';
import { consumeConfirmToken, issueConfirmToken } from './destructive-purge.js';

/** DI seam (AGENTS.md invariant 7). Restore in `afterEach`. */
export const _internals = {
	getOpenEpic,
	issueConfirmToken,
	consumeConfirmToken,
	loadEpicLearningView,
	readEpicPrior,
	resetEpicPrior,
	now: (): number => Date.now(),
};

export const EPIC_PRIOR_USAGE =
	'Usage: /swarm epic prior [show] | /swarm epic prior reset [--confirm=<token>]';

/** Destructive-confirm kind (binds the token to this surface). */
const PRIOR_RESET_KIND = 'epic-prior-reset';

/** `--confirm=<token>` / `--confirm <token>`; no flag ⇒ preview. */
function parseConfirm(
	args: string[],
): { token: string | null } | { error: string } {
	let token: string | null = null;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg.toLowerCase().startsWith('--confirm=')) {
			token = arg.slice('--confirm='.length).trim();
		} else if (arg.toLowerCase() === '--confirm') {
			token = (args[i + 1] ?? '').trim();
			i += 1;
		} else {
			return {
				error: `Unknown option(s) for \`/swarm epic prior reset\`: ${arg}.`,
			};
		}
		if (!token) {
			return {
				error:
					'`--confirm` takes the token the preview printed: run `/swarm epic prior reset` first, then `/swarm epic prior reset --confirm=<token>`.',
			};
		}
	}
	return { token };
}

const SHOWN = 10;

function fmt(value: number): string {
	return (Math.round(value * 100) / 100).toString();
}

function statsLines(
	stats: EpicLearningStats,
	settings: EpicLearningSettings,
): string[] {
	const summary = summarizeEpicLearning(stats, settings.hotExcess, SHOWN);
	const lines = [
		`- ${summary.files} file statistic(s), ${summary.edges} learned co-write(s).`,
		'',
		'### Hot files (a task declaring one runs alone)',
	];
	if (summary.hotFiles.length === 0) {
		lines.push(
			'_None._ A file becomes hot only on excess evidence: at least one full incident (undeclared write, merge conflict, or accumulated Stage B failures / rework / reopens) and an incident rate above the prior mean by more than `hot_excess`. Undeclared writes its strongest learned co-writer explains are discounted (that co-write already keeps the writer apart from the file).',
		);
	} else {
		for (const file of summary.hotFiles.slice(0, SHOWN)) {
			const e = epicHotEvidence(stats, file);
			const discount =
				e.countedAlpha < e.alpha
					? ` (${fmt(e.countedAlpha)} counted after its strongest co-writer)`
					: '';
			lines.push(
				`- \`${file}\` — incidents ${fmt(e.alpha)}${discount}, exposures ${fmt(e.beta)}, rate ${fmt(e.rate)}`,
			);
		}
		if (summary.hotFiles.length > SHOWN) {
			lines.push(`- … +${summary.hotFiles.length - SHOWN} more`);
		}
	}
	lines.push(
		'',
		'### Learned co-writes (scope expansion — planner analysis only, never write authorization)',
	);
	if (summary.topCoWrites.length === 0) {
		lines.push(
			'_None._ Tasks have not written files outside their declared scope.',
		);
	} else {
		for (const edge of summary.topCoWrites) {
			lines.push(
				`- \`${edge.from}\` → \`${edge.to}\` (weight ${fmt(edge.weight)}${edge.weight >= 1 ? '' : ', below 1 — expands only together with other declared files'})`,
			);
		}
		if (summary.edges > summary.topCoWrites.length) {
			lines.push(`- … +${summary.edges - summary.topCoWrites.length} more`);
		}
	}
	return lines;
}

const SOURCE_TEXT: Record<EpicLearningSource, string> = {
	posterior:
		"the open epic's posterior (`.swarm/epic/posterior.json`: the project prior it inherited at start + what its closed waves taught)",
	prior: `the project prior (\`${EPIC_PRIOR_LEARNING_DISPLAY_PATH}\`)`,
	none: 'nothing learned yet — a neutral start: no hot files and no learned co-writes',
	'prior-unreadable': `⚠️ the project prior (\`${EPIC_PRIOR_LEARNING_DISPLAY_PATH}\`) is unreadable, so epics plan without learned signals — clear it with \`/swarm epic prior reset\``,
};

/** `/swarm epic learning` — what the Epic planner learned and uses now. */
export function renderEpicLearning(
	directory: string,
	settings: EpicLearningSettings,
): string {
	const lines = ['## Epic Mode — Learning', ''];
	lines.push(
		`Settings: ${settings.enabled ? 'enabled' : '**disabled**'}; decay_per_epic ${settings.decayPerEpic}; half_life_days ${settings.halfLifeDays}; hot_excess ${settings.hotExcess} (\`epic.learning.*\`).`,
	);
	if (!settings.enabled) {
		lines.push(
			'',
			'Learning is disabled: epics plan without learned signals and nothing is learned or written.',
		);
		return lines.join('\n');
	}
	let epic: { epicKey: string; token: string } | null = null;
	try {
		const record = _internals.getOpenEpic(directory);
		epic = record ? { epicKey: record.epicKey, token: record.token } : null;
	} catch {
		epic = null;
	}
	const view = _internals.loadEpicLearningView(
		directory,
		epic,
		settings,
		_internals.now(),
	);
	lines.push(`Source: ${SOURCE_TEXT[view.source]}.`, '');
	lines.push(...statsLines(view.stats, settings));
	lines.push(
		'',
		'Learned from the task outcomes `epic_next_wave` records at each wave close; merged into the project prior at `/swarm epic close`; decayed per epic and by age. See `/swarm epic prior`.',
	);
	return lines.join('\n');
}

/** `/swarm epic prior [show|reset [--confirm=<token>]]`. */
export function renderEpicPrior(
	directory: string,
	args: string[],
	settings: EpicLearningSettings,
): string {
	const sub = (args[0] ?? 'show').toLowerCase();
	const flags = args.slice(1).map((arg) => arg.toLowerCase());
	if (sub === 'show') {
		if (flags.length > 0) {
			return `Unknown option(s) for \`/swarm epic prior show\`: ${flags.join(', ')}.\n\n${EPIC_PRIOR_USAGE}`;
		}
		return renderPriorShow(directory, settings);
	}
	if (sub === 'reset') {
		const parsed = parseConfirm(args.slice(1));
		if ('error' in parsed) return `${parsed.error}\n\n${EPIC_PRIOR_USAGE}`;
		return renderPriorReset(directory, parsed.token);
	}
	return `Unknown \`/swarm epic prior\` subcommand '${sub}'.\n\n${EPIC_PRIOR_USAGE}`;
}

function renderPriorShow(
	directory: string,
	settings: EpicLearningSettings,
): string {
	const lines = [
		'## Epic Mode — Project prior',
		'',
		`File: \`${EPIC_PRIOR_LEARNING_DISPLAY_PATH}\` (survives \`/swarm close\`; every \`/swarm epic close\` merges the epic's learning into it).`,
	];
	const read = _internals.readEpicPrior(directory);
	if (read.status === 'absent') {
		lines.push(
			'',
			'No project prior yet — the next epic starts neutral (no hot files, no learned co-writes).',
		);
		return lines.join('\n');
	}
	if (read.status === 'unreadable') {
		lines.push(
			'',
			`⚠️ Unreadable (${read.reason}). Epics plan without learned signals and closes do not merge into it until it is cleared: \`/swarm epic prior reset\`.`,
		);
		return lines.join('\n');
	}
	const prior = read.prior;
	lines.push(
		`Updated: ${prior.updatedAt}; ${prior.mergedEpics.length} epic(s) merged (newest ${prior.mergedEpics.length > 0 ? prior.mergedEpics[prior.mergedEpics.length - 1] : '—'}).`,
	);
	if (prior.importedFrom?.source === 'epic-v1-import') {
		lines.push(
			`Imported once from Epic v1 at ${prior.importedFrom.at}: ${prior.importedFrom.calibrationHotModules} hot module(s), ${prior.importedFrom.divergenceRecords} divergence record(s).`,
		);
	} else if (prior.importedFrom?.source === 'reset') {
		lines.push(
			`Reset at ${prior.importedFrom.at} (no Epic v1 import will follow).`,
		);
	}
	lines.push(
		'',
		'As stored (planning applies the age decay — see `/swarm epic learning`):',
	);
	lines.push(...statsLines(prior.stats, settings));
	return lines.join('\n');
}

/**
 * Two-step reset through the shared destructive-confirm primitive
 * (`destructive-purge.ts`, issue #2946): the preview arms a single-use,
 * 15-minute token bound to this surface AND to the prior's current content
 * digest (an epic close that changes the prior in between invalidates it);
 * `--confirm=<token>` consumes it and clears the prior.
 */
function renderPriorReset(directory: string, token: string | null): string {
	const read = _internals.readEpicPrior(directory);
	let openEpic: string | null = null;
	try {
		openEpic = _internals.getOpenEpic(directory)?.epicKey ?? null;
	} catch {
		openEpic = null;
	}
	const what =
		read.status === 'ok'
			? `${read.prior.stats.files.size} file statistic(s) and ${[...read.prior.stats.edges.values()].reduce((n, t) => n + t.size, 0)} learned co-write(s)`
			: read.status === 'unreadable'
				? `an unreadable prior (${read.reason})`
				: 'nothing (no project prior yet)';
	const openNote = openEpic
		? ` The open epic \`${openEpic}\` keeps its posterior and merges it into the cleared prior when it closes.`
		: '';
	const priorFile = path.join(directory, EPIC_PRIOR_LEARNING_RELATIVE_PATH);
	const scope = {
		kind: `${PRIOR_RESET_KIND}:${read.digest ?? read.status}`,
		candidates: [{ path: priorFile, reason: 'Epic learning prior' }],
	};
	if (token === null) {
		const armed = _internals.issueConfirmToken(priorFile, directory, scope);
		return [
			'## Epic Mode — Project prior reset (preview)',
			'',
			`This would clear ${what} from \`${EPIC_PRIOR_LEARNING_DISPLAY_PATH}\`; later epics start neutral.${openNote}`,
			'',
			`Nothing changed. To clear it, run \`/swarm epic prior reset --confirm=${armed}\` (single use, valid 15 minutes).`,
		].join('\n');
	}
	const verdict = _internals.consumeConfirmToken(
		priorFile,
		directory,
		token,
		scope,
	);
	if (!verdict.ok) {
		return `Project prior NOT reset: ${verdict.reason}. Run \`/swarm epic prior reset\` again for a fresh token.`;
	}
	const result = _internals.resetEpicPrior(directory, _internals.now());
	if (result.status === 'failed') {
		return `Project prior NOT reset: ${result.detail}`;
	}
	return [
		'## Epic Mode — Project prior reset',
		'',
		`Cleared ${what} from \`${EPIC_PRIOR_LEARNING_DISPLAY_PATH}\`. Later epics start neutral (no hot files, no learned co-writes); an Epic v1 import is never repeated.${openNote}`,
	].join('\n');
}
