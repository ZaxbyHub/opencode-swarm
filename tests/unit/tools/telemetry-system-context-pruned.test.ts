import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	addTelemetryListener,
	initTelemetry,
	resetTelemetryForTesting,
	telemetry,
} from '../../../src/telemetry';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

describe('telemetry context_pruned integration', () => {
	let cleanupTestDir: () => void;

	beforeEach(() => {
		resetTelemetryForTesting();
		const testDir = createSafeTestDir('telemetry-context-pruned-');
		cleanupTestDir = testDir.cleanup;
		initTelemetry(testDir.dir);
	});

	afterEach(() => {
		resetTelemetryForTesting();
		cleanupTestDir();
	});

	test('contextPruned emits the complete public aggregate', () => {
		const receivedEvents: string[] = [];
		addTelemetryListener((event) => receivedEvents.push(event));

		telemetry.contextPruned({
			sessionId: 's-context-pruned',
			agentName: 'agent',
			trigger: 'critical_threshold',
			usageSource: 'estimated',
			beforeTokens: 900,
			afterTokens: 500,
			modelLimit: 1000,
			maskedMessages: 1,
			maskedToolParts: 2,
			maskedTokensFreed: 150,
			prunedMessages: 3,
			prunedTextParts: 2,
			prunedToolParts: 1,
			prunedTokensFreed: 250,
		});

		expect(receivedEvents).toEqual(['context_pruned']);
	});
});
