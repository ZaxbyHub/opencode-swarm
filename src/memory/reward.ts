import type { CouncilVerdict } from '../council/types';
import { type MemoryConfig, resolveMemoryConfig } from './config';
import { createConfiguredMemoryProvider } from './gateway';
import type {
	MemoryProvider,
	MemoryRecallRewardInput,
	MemoryRecallRewardResult,
	MemoryTaskOutcome,
} from './provider';

export function councilVerdictToMemoryOutcome(
	verdict: CouncilVerdict,
): MemoryTaskOutcome {
	switch (verdict) {
		case 'APPROVE':
			return 'approved';
		case 'REJECT':
			return 'rejected';
		case 'CONCERNS':
			return 'concerns';
	}
}

/**
 * Resolve the set of session/run ids whose recall-usage bundles should
 * receive a council-verdict reward, deduplicated and order-preserving.
 *
 * `trustedSessionIds` are host/runtime-derived (e.g. `ctx.sessionID`) and are
 * always included when present — they cannot be spoofed by tool-call
 * arguments. `untrustedSessionIds` are caller-supplied strings (e.g. a
 * `provenanceSessionId` arg or a per-verdict `sessionId` reported by the
 * architect) and are included ONLY when `isKnownSession` returns true — an
 * arbitrary, made-up string is silently dropped rather than trusted as a
 * reward-targeting key.
 *
 * Important scope limitation: `isKnownSession` (backed by `getAgentSession`)
 * proves only that the id belongs to SOME currently-tracked session
 * process-wide — it does NOT prove that session actually participated in
 * THIS council review. There is no swarmId/taskId cross-check available on
 * `AgentSessionState` today, so a hallucinated or copied session id that
 * happens to match a real, unrelated, concurrently-running session's id
 * would still be accepted here. The blast radius is bounded to Q-value
 * corruption of that other session's recalled memories (not privilege
 * escalation or data exfiltration), but this is a real residual gap, not a
 * complete fix — closing it fully requires a session→task ownership
 * registry that does not exist in this codebase yet.
 *
 * A bare swarm identifier is never a valid session id substitute and must
 * never be passed into either list.
 */
export function resolveRewardRunIds(input: {
	trustedSessionIds: Array<string | undefined>;
	untrustedSessionIds: Array<string | undefined>;
	isKnownSession: (sessionId: string) => boolean;
}): string[] {
	const seen = new Set<string>();
	const resolved: string[] = [];
	for (const id of input.trustedSessionIds) {
		if (!id || seen.has(id)) continue;
		seen.add(id);
		resolved.push(id);
	}
	for (const id of input.untrustedSessionIds) {
		if (!id || seen.has(id)) continue;
		if (!input.isKnownSession(id)) continue;
		seen.add(id);
		resolved.push(id);
	}
	return resolved;
}

export async function applyRecallRewardForCouncil(
	directory: string,
	configInput: Partial<MemoryConfig> | undefined,
	input: Omit<MemoryRecallRewardInput, 'outcome'> & {
		verdict: CouncilVerdict;
	},
): Promise<MemoryRecallRewardResult> {
	const config = resolveMemoryConfig(configInput);
	const outcome = councilVerdictToMemoryOutcome(input.verdict);
	if (!config.enabled) {
		return skippedRewardResult(outcome, 'memory_disabled');
	}
	if (input.runIds.length === 0) {
		return skippedRewardResult(outcome, 'no_recall_usage_for_run');
	}
	const provider = createConfiguredMemoryProvider(
		directory,
		config,
	) as MemoryProvider;
	try {
		await provider.initialize?.();
		if (!provider.applyRecallReward) {
			return skippedRewardResult(outcome, 'provider_does_not_support_learning');
		}
		return await provider.applyRecallReward({
			runIds: input.runIds,
			outcome,
			verdictPayload: input.verdictPayload,
			timestamp: input.timestamp,
		});
	} finally {
		await provider.close?.();
	}
}

function skippedRewardResult(
	outcome: MemoryTaskOutcome,
	reason: string,
): MemoryRecallRewardResult {
	return {
		success: false,
		outcome,
		memoryIds: [],
		reward: outcome === 'approved' ? 1 : outcome === 'rejected' ? -1 : 0,
		updatedMemoryIds: [],
		propagatedMemoryIds: [],
		reason,
	};
}
