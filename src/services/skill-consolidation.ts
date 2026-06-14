/**
 * Scheduled skill-improver consolidation.
 *
 * This module owns cadence state only. The actual queue draining, proposal
 * writing, and draft-skill generation stays in `runSkillImprover`.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { EnrichmentQuotaOptions } from '../hooks/knowledge-curator.js';
import type {
	SkillImproveResult,
	SkillImproverConfigInput,
} from './skill-improver.js';
import { runSkillImprover } from './skill-improver.js';

export interface SkillConsolidationState {
	last_consolidation_at?: string;
	last_source?: SkillConsolidationSource;
	last_ran?: boolean;
	last_reason?: string;
}

export type SkillConsolidationSource = 'startup' | 'phase_complete' | 'manual';

export interface SkillConsolidationRequest {
	directory: string;
	config: SkillImproverConfigInput;
	source: SkillConsolidationSource;
	sessionId?: string;
	force?: boolean;
	now?: Date;
	enrichmentQuota?: EnrichmentQuotaOptions;
	evaluateDrafts?: boolean;
}

export interface SkillConsolidationResult {
	started: boolean;
	reason?: string;
	statePath: string;
	result?: SkillImproveResult;
}

const DEFAULT_CONSOLIDATION_INTERVAL_HOURS = 24;
const DEFAULT_CONSOLIDATION_MAX_CALLS_PER_RUN = 1;
const runningByDirectory = new Map<string, Promise<SkillConsolidationResult>>();

export function consolidationStatePath(directory: string): string {
	return path.join(
		directory,
		'.swarm',
		'skill-improver',
		'consolidation-state.json',
	);
}

async function readState(directory: string): Promise<SkillConsolidationState> {
	const filePath = consolidationStatePath(directory);
	if (!existsSync(filePath)) return {};
	try {
		const parsed = JSON.parse(await readFile(filePath, 'utf-8'));
		if (!parsed || typeof parsed !== 'object') return {};
		return parsed as SkillConsolidationState;
	} catch {
		return {};
	}
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, content, 'utf-8');
	await rename(tmp, filePath);
}

async function writeState(
	directory: string,
	state: SkillConsolidationState,
): Promise<void> {
	await atomicWrite(
		consolidationStatePath(directory),
		`${JSON.stringify(state, null, 2)}\n`,
	);
}

function intervalElapsed(
	state: SkillConsolidationState,
	intervalHours: number,
	now: Date,
): boolean {
	if (!state.last_consolidation_at) return true;
	const last = new Date(state.last_consolidation_at).getTime();
	if (Number.isNaN(last)) return true;
	const elapsedMs = now.getTime() - last;
	return elapsedMs >= intervalHours * 60 * 60 * 1000;
}

export async function shouldRunSkillConsolidation(
	req: SkillConsolidationRequest,
): Promise<{
	shouldRun: boolean;
	reason?: string;
	state: SkillConsolidationState;
}> {
	const state = await readState(req.directory);
	if (!req.config.enabled) {
		return {
			shouldRun: false,
			reason: 'skill_improver.enabled is false',
			state,
		};
	}
	if (!req.force && req.config.trigger !== 'scheduled') {
		return {
			shouldRun: false,
			reason: 'skill_improver.trigger is manual',
			state,
		};
	}
	const intervalHours =
		req.config.consolidation_interval_hours ??
		DEFAULT_CONSOLIDATION_INTERVAL_HOURS;
	if (
		!req.force &&
		!intervalElapsed(state, intervalHours, req.now ?? new Date())
	) {
		return {
			shouldRun: false,
			reason: `last consolidation is newer than ${intervalHours}h`,
			state,
		};
	}
	return { shouldRun: true, state };
}

async function runSkillConsolidationInner(
	req: SkillConsolidationRequest,
): Promise<SkillConsolidationResult> {
	const now = req.now ?? new Date();
	const statePath = consolidationStatePath(req.directory);
	const decision = await shouldRunSkillConsolidation({ ...req, now });
	if (!decision.shouldRun) {
		return { started: false, reason: decision.reason, statePath };
	}

	const maxCalls = Math.max(
		1,
		Math.min(
			req.config.max_calls_per_day,
			req.config.consolidation_max_calls_per_run ??
				DEFAULT_CONSOLIDATION_MAX_CALLS_PER_RUN,
		),
	);
	const result = await runSkillImprover({
		directory: req.directory,
		config: req.config,
		targets: req.config.targets,
		mode: req.config.write_mode,
		maxCalls,
		now,
		sessionId: req.sessionId,
		enrichmentQuota: req.enrichmentQuota,
		evaluateDrafts: req.evaluateDrafts ?? false,
		allowAutoApply: false,
	});

	if (result.ran) {
		await writeState(req.directory, {
			last_consolidation_at: now.toISOString(),
			last_source: req.source,
			last_ran: result.ran,
			last_reason: result.reason,
		});
	}

	return {
		started: result.ran,
		reason: result.reason,
		statePath,
		result,
	};
}

export async function runSkillConsolidation(
	req: SkillConsolidationRequest,
): Promise<SkillConsolidationResult> {
	const key = path.resolve(req.directory);
	const existing = runningByDirectory.get(key);
	if (existing) {
		return {
			started: false,
			reason: 'skill consolidation already running',
			statePath: consolidationStatePath(req.directory),
		};
	}
	const run = runSkillConsolidationInner(req).finally(() => {
		if (runningByDirectory.get(key) === run) {
			runningByDirectory.delete(key);
		}
	});
	runningByDirectory.set(key, run);
	return run;
}

export function runSkillConsolidationFireAndForget(
	req: SkillConsolidationRequest,
	onComplete?: (result: SkillConsolidationResult) => void,
	onError?: (error: unknown) => void,
): void {
	queueMicrotask(() => {
		runSkillConsolidation(req).then(onComplete).catch(onError);
	});
}

export const _internals = {
	readState,
	writeState,
	intervalElapsed,
	runningByDirectory,
};
