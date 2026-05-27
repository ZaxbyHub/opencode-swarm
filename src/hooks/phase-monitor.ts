/**
 * Phase Monitor Hook
 *
 * Detects phase transitions by reading plan state on each system prompt transform.
 * When a phase change is detected, triggers preflight via PreflightTriggerManager.
 * Wrapped in safeHook — errors must never propagate.
 */

import * as path from 'node:path';
import type { PreflightTriggerManager } from '../background/trigger';
import { CuratorConfigSchema } from '../config/schema';
import { loadPlan } from '../plan/manager';
import {
	type CuratorLLMDelegate,
	runCuratorInit as defaultRunCuratorInit,
} from './curator';
import type { CuratorConfig, CuratorInitResult } from './curator-types';
import { safeHook } from './utils';

/** Injectable curator runner type — allows test injection without module mocking. */
export type CuratorInitRunner = (
	directory: string,
	config: CuratorConfig,
	llmDelegate?: CuratorLLMDelegate,
) => Promise<CuratorInitResult>;

/** Factory that creates a CuratorLLMDelegate for a given session — enables session-aware resolution. */
export type CuratorDelegateFactory = (
	sessionId?: string,
) => CuratorLLMDelegate | undefined;

/**
 * Creates a hook that monitors plan phase transitions and triggers preflight.
 *
 * @param directory - Project directory (where .swarm/ lives)
 * @param preflightManager - Optional PreflightTriggerManager to call on phase change.
 *   When undefined, preflight checks are skipped but curator initialization still runs
 *   at session start (useful when knowledge.enabled but phase_preflight is disabled).
 * @param curatorRunner - Optional curator init runner (defaults to runCuratorInit; injectable for tests)
 * @param delegateFactory - Optional factory that creates a CuratorLLMDelegate for the calling session.
 *   Called lazily at hook invocation time with the session ID extracted from the hook input,
 *   enabling correct multi-swarm curator resolution. For test injection of a pre-built delegate,
 *   pass `() => myDelegate`.
 * @returns A safeHook-wrapped system.transform handler
 */
export function createPhaseMonitorHook(
	directory: string,
	preflightManager?: PreflightTriggerManager,
	curatorRunner?: CuratorInitRunner,
	delegateFactory?: CuratorDelegateFactory,
): (input: unknown, output: unknown) => Promise<void> {
	let lastKnownPhase: number | null = null;

	const handler = async (input: unknown, _output: unknown): Promise<void> => {
		const runner = curatorRunner ?? defaultRunCuratorInit;
		// Extract sessionID from hook input for session-aware curator resolution
		const sessionId =
			typeof input === 'object' && input !== null
				? (input as { sessionID?: string }).sessionID
				: undefined;
		const plan = await loadPlan(directory);
		if (!plan) return;

		const currentPhase = plan.current_phase ?? 1;

		// First call: initialize without triggering
		if (lastKnownPhase === null) {
			lastKnownPhase = currentPhase;
			try {
				const { loadPluginConfigWithMeta } = await import('../config/index.js');
				const { config } = loadPluginConfigWithMeta(directory);
				const curatorConfig = CuratorConfigSchema.parse(config.curator ?? {});
				if (curatorConfig.enabled && curatorConfig.init_enabled) {
					const llmDelegate = delegateFactory?.(sessionId);
					const initResult = await runner(
						directory,
						curatorConfig,
						llmDelegate,
					);
					if (initResult.briefing) {
						const briefingPath = path.join(
							directory,
							'.swarm',
							'curator-briefing.md',
						);
						const { mkdir, writeFile } = await import('node:fs/promises');
						await mkdir(path.dirname(briefingPath), { recursive: true });
						await writeFile(briefingPath, initResult.briefing, 'utf-8');
						// Persist init receipt for drift context (best-effort)
						const { buildApprovedReceipt, persistReviewReceipt } = await import(
							'./review-receipt.js'
						);
						const initReceipt = buildApprovedReceipt({
							agent: 'curator',
							scopeContent: initResult.briefing,
							scopeDescription: 'curator-init-briefing',
							checkedAspects: [
								'knowledge_entries',
								'prior_phase_summaries',
								'contradiction_detection',
							],
							validatedClaims: [
								`knowledge_entries_reviewed: ${initResult.knowledge_entries_reviewed}`,
								`prior_phases_covered: ${initResult.prior_phases_covered}`,
								`contradictions: ${initResult.contradictions.length}`,
							],
						});
						persistReviewReceipt(directory, initReceipt).catch(() => {});
					}
				}
			} catch {
				// curator init failures must never propagate
			}
			return;
		}

		// Phase changed: trigger preflight
		if (currentPhase !== lastKnownPhase) {
			const previousPhase = lastKnownPhase;
			lastKnownPhase = currentPhase;

			// Architectural supervision (issue #893): cheap, deterministic rollup of the
			// just-completed phase's agent summaries. Opt-in, isolated, and best-effort —
			// must never disrupt preflight.
			try {
				const { loadPluginConfigWithMeta } = await import('../config/index.js');
				const { config } = loadPluginConfigWithMeta(directory);
				if (config.architectural_supervision?.enabled) {
					const { aggregatePhaseSummary } = await import(
						'../summaries/aggregate.js'
					);
					await aggregatePhaseSummary(directory, previousPhase, {
						maxPhaseSummaryWords:
							config.architectural_supervision.max_phase_summary_words,
					});
				}
			} catch {
				// summary aggregation failures must never propagate
			}

			// Count completed and total tasks for the previous phase
			const phase = plan.phases.find((p) => p.id === previousPhase);
			const completedTasks =
				phase?.tasks.filter((t) => t.status === 'completed').length ?? 0;
			const totalTasks = phase?.tasks.length ?? 0;

			if (preflightManager) {
				await preflightManager.checkAndTrigger(
					currentPhase,
					completedTasks,
					totalTasks,
				);
			}
		}
	};

	return safeHook(handler);
}
