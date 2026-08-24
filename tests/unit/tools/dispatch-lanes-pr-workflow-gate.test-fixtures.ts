import { mock } from 'bun:test';
import { _internals as dispatchInternals } from '../../../src/tools/dispatch-lanes.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

const originalLoadPluginConfig = dispatchInternals.loadPluginConfig;

export function installLegacyPrReviewPolicy(): void {
	dispatchInternals.loadPluginConfig = (directory) => ({
		...originalLoadPluginConfig(directory),
		pr_review_resilience: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
}

export function restorePrReviewPolicy(): void {
	dispatchInternals.loadPluginConfig = originalLoadPluginConfig;
}

export function uniqueSessionOps(): void {
	let sessionIndex = 0;
	dispatchInternals.getSessionOps = () => ({
		create: mock(async () => ({
			data: { id: `tier-lane-session-${sessionIndex++}` },
		})),
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		delete: mock(async () => undefined),
	});
}
