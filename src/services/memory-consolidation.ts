/**
 * Memory consolidation trigger (issue #1464, Phase 3).
 *
 * Thin, fail-open wrapper that runs the episodic→semantic consolidation engine
 * at a phase boundary. Mirrors `runSkillConsolidationFireAndForget`: it is
 * launched off the phase_complete success path, holds a per-directory in-flight
 * guard, and never throws into the caller.
 *
 * Cancellation is cooperative: a deadline aborts an AbortController whose signal
 * the engine checks before each write, and the wrapper always AWAITS the pass to
 * settle before disposing the gateway and releasing the in-flight guard. This
 * avoids orphaning the pass (using the gateway after dispose / racing a second
 * pass on the same store) that a bare Promise.race timeout would cause.
 */

import { createCuratorLLMDelegate } from '../hooks/curator-llm-factory.js';
import type { MemoryConfig } from '../memory/config.js';
import {
	type ConsolidationResult,
	runConsolidationPass,
} from '../memory/consolidation.js';
import {
	appendConsolidationLog,
	readConsolidationLog,
} from '../memory/consolidation-log.js';
import { createMemoryGateway } from '../memory/gateway.js';
import { appendMemoryRunLog } from '../memory/run-log.js';

export interface MemoryConsolidationRequest {
	directory: string;
	config: MemoryConfig;
	phase: number;
	sessionId?: string;
}

export interface MemoryConsolidationOutcome {
	started: boolean;
	reason?: string;
	result?: ConsolidationResult;
}

const CONSOLIDATION_TIMEOUT_MS = 5 * 60 * 1000;
const runningByDirectory = new Map<
	string,
	Promise<MemoryConsolidationOutcome>
>();

export async function runMemoryConsolidation(
	req: MemoryConsolidationRequest,
): Promise<MemoryConsolidationOutcome> {
	// Coalesce by directory, not by phase: the memory store is shared per
	// directory, so two passes must never write it concurrently. If a pass is
	// already in flight when a later phase completes, that later phase is
	// intentionally coalesced into the running one — its still-pending proposals
	// carry over and are consolidated by the next pass (no loss, just deferral).
	const existing = runningByDirectory.get(req.directory);
	if (existing) return existing;
	const run = (async (): Promise<MemoryConsolidationOutcome> => {
		if (!req.config.enabled || !req.config.consolidation.enabled) {
			return { started: false, reason: 'disabled' };
		}
		const gateway = createMemoryGateway(
			{
				directory: req.directory,
				sessionID: req.sessionId,
				runId: req.sessionId,
				agentRole: 'curator_consolidation',
			},
			{ config: req.config },
		);
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			CONSOLIDATION_TIMEOUT_MS,
		);
		// Never keep the process alive solely for this timer.
		(timer as { unref?: () => void }).unref?.();
		try {
			if (!gateway.isEnabled()) return { started: false, reason: 'disabled' };
			const llmDelegate = createCuratorLLMDelegate(
				req.directory,
				'consolidation',
				req.sessionId,
			);
			// Await the pass to completion (it honors controller.signal) so the
			// gateway is disposed and the in-flight guard released only after all
			// writes have actually settled.
			const result = await runConsolidationPass(
				{
					directory: req.directory,
					phaseNumber: req.phase,
					runId: req.sessionId,
					config: req.config,
				},
				{
					gateway,
					llmDelegate,
					now: () => new Date(),
					logEvent: (event) =>
						appendMemoryRunLog(req.directory, req.sessionId, event),
					readLog: () => readConsolidationLog(req.directory),
					appendLog: (record) => appendConsolidationLog(req.directory, record),
					signal: controller.signal,
				},
			);
			return { started: !result.skipped, reason: result.skipReason, result };
		} finally {
			clearTimeout(timer);
			await gateway.dispose();
		}
	})();
	runningByDirectory.set(req.directory, run);
	try {
		return await run;
	} finally {
		runningByDirectory.delete(req.directory);
	}
}

export function runMemoryConsolidationFireAndForget(
	req: MemoryConsolidationRequest,
	onComplete?: (outcome: MemoryConsolidationOutcome) => void,
	onError?: (error: unknown) => void,
): void {
	queueMicrotask(() => {
		runMemoryConsolidation(req).then(onComplete).catch(onError);
	});
}

export const _internals = {
	runningByDirectory,
};
