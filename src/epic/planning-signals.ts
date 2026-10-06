/**
 * Epic v2 C5/C6 — the planner's inputs beyond the plan, read ONCE per
 * planning call by both callers of the component planner (`epic_next_wave`
 * and the `/swarm epic start` sizing dry-run) so the two plan with the same
 * signals:
 *
 *   - learned signals (`learning.ts`) when `epic.learning.enabled` is
 *     not false: the hot files (tasks declaring one run alone) and the
 *     co-write weights that expand each task's scope in the conflict graph.
 *     Read from the open epic's posterior (`epic_next_wave`), else from the
 *     project prior (the start's sizing, before the epic exists);
 *   - co-change: the git co-change pairs + threshold when
 *     `epic.cochange.enabled` (null otherwise ⇒ path-only conflicts);
 *   - density threshold: the static `epic.mode.activation_threshold`
 *     — the intra-component density above which a component runs serially.
 *
 * A failed read degrades to "no signal" (no learned signal / path-only),
 * the fail-open the planner always had for these optional signals; the
 * wave verdict still guards every issued wave. The sources are injected so
 * each caller keeps its own `_internals` DI seam.
 */

import type { PluginConfig } from '../config/schema.js';
import type { CoChangeData } from './cochange-source.js';
import {
	DEFAULT_EPIC_DENSITY_THRESHOLD,
	type EpicCochangeSignal,
} from './components.js';
import { resolveEpicConfig } from './config.js';
import { isEpicCochangeConfigEnabled } from './config-gate.js';
import {
	type EpicCoWriteIndex,
	type EpicLearningSettings,
	epicHotFiles,
	resolveEpicLearningSettings,
} from './learning.js';
import type { EpicIdentity, EpicLearningView } from './learning-store.js';

/** Default co-change threshold (`epic.cochange.*` schema defaults). */
const DEFAULT_COCHANGE_NPMI = 0.6;
const DEFAULT_MIN_CO_CHANGES = 5;

export interface EpicPlanningSignals {
	hotFiles: string[];
	coWrites: EpicCoWriteIndex | null;
	cochange: EpicCochangeSignal | null;
	densityThreshold: number;
}

export interface EpicPlanningSignalSources {
	loadLearningView: (
		directory: string,
		epic: EpicIdentity | null,
		settings: EpicLearningSettings,
		nowMs: number,
	) => EpicLearningView;
	getCoChangeData: (directory: string) => Promise<CoChangeData>;
	now: () => number;
}

export async function loadEpicPlanningSignals(
	directory: string,
	config: Pick<PluginConfig, 'turbo' | 'epic'>,
	sources: EpicPlanningSignalSources,
	epic: EpicIdentity | null,
): Promise<EpicPlanningSignals> {
	const epicConfig = resolveEpicConfig(config);
	const settings = resolveEpicLearningSettings(config);
	let hotFiles: string[] = [];
	let coWrites: EpicCoWriteIndex | null = null;
	if (settings.enabled) {
		try {
			const view = sources.loadLearningView(
				directory,
				epic,
				settings,
				sources.now(),
			);
			hotFiles = epicHotFiles(view.stats, settings.hotExcess);
			coWrites = view.stats.edges.size > 0 ? view.stats.edges : null;
		} catch {
			hotFiles = [];
			coWrites = null;
		}
	}
	let cochange: EpicCochangeSignal | null = null;
	if (isEpicCochangeConfigEnabled(config)) {
		try {
			const data = await sources.getCoChangeData(directory);
			cochange = {
				pairs: data.pairs,
				threshold: {
					npmi: epicConfig?.cochange?.threshold ?? DEFAULT_COCHANGE_NPMI,
					minCoChanges:
						epicConfig?.cochange?.min_co_changes ?? DEFAULT_MIN_CO_CHANGES,
				},
			};
		} catch {
			cochange = null;
		}
	}
	return {
		hotFiles,
		coWrites,
		cochange,
		densityThreshold:
			epicConfig?.mode?.activation_threshold ?? DEFAULT_EPIC_DENSITY_THRESHOLD,
	};
}
