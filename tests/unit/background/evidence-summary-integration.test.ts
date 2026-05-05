import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
	mock,
} from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createEvidenceSummaryIntegration,
	EvidenceSummaryIntegration,
	type EvidenceSummaryIntegrationConfig,
} from '../../../src/background/evidence-summary-integration';
import type { AutomationConfig } from '../../../src/config/schema';

// Mock the event bus
const mockSubscribers: Map<
	string,
	Array<(event: { payload: unknown }) => void>
> = new Map();

mock.module('../../../src/background/event-bus', () => ({
	getGlobalEventBus: () => ({
		subscribe: (
			type: string,
			handler: (event: { payload: unknown }) => void,
		) => {
			if (!mockSubscribers.has(type)) {
				mockSubscribers.set(type, []);
			}
			mockSubscribers.get(type)!.push(handler);
			return () => {
				const handlers = mockSubscribers.get(type);
				if (handlers) {
					const idx = handlers.indexOf(handler);
					if (idx >= 0) handlers.splice(idx, 1);
				}
			};
		},
		publish: jest.fn(),
	}),
}));

// Mock the evidence summary service
mock.module('../../../src/services/evidence-summary-service', () => ({
	buildEvidenceSummary: jest.fn(),
	isAutoSummaryEnabled: jest.fn(),
}));

import {
	buildEvidenceSummary,
	isAutoSummaryEnabled,
} from '../../../src/services/evidence-summary-service';

const mockBuildEvidenceSummary = buildEvidenceSummary as jest.MockedFunction<
	typeof buildEvidenceSummary
>;
const mockIsAutoSummaryEnabled = isAutoSummaryEnabled as jest.MockedFunction<
	typeof isAutoSummaryEnabled
>;

let tempDir: string;
let projectDir: string;

beforeEach(() => {
	tempDir = join(
		tmpdir(),
		`evidence-integration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	projectDir = tempDir;
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	mockSubscribers.clear();
	jest.clearAllMocks();
});

// Cross-module mocks via mock.module must be restored after each test to prevent
// cross-test contamination. Per the two-tier DI convention, cross-module mocks
// (source imports directly, not via _internals) require explicit cleanup.
afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	mock.restore();
});

function createMockAutomationConfig(
	overrides: Partial<AutomationConfig> = {},
): AutomationConfig {
	return {
		mode: 'hybrid',
		capabilities: {
			plan_sync: false,
			phase_preflight: false,
			config_doctor_on_startup: false,
			config_doctor_autofix: false,
			evidence_auto_summaries: true,
			decision_drift_detection: false,
		},
		...overrides,
	} as AutomationConfig;
}

function createIntegrationConfig(
	overrides: Partial<EvidenceSummaryIntegrationConfig> = {},
): EvidenceSummaryIntegrationConfig {
	return {
		automationConfig: createMockAutomationConfig(),
		directory: tempDir,
		projectDir,
		...overrides,
	};
}

describe('EvidenceSummaryIntegration', () => {
	describe('isEnabled', () => {
		it('returns true when feature flag is enabled', () => {
			mockIsAutoSummaryEnabled.mockReturnValue(true);
			const config = createIntegrationConfig();
			const integration = new EvidenceSummaryIntegration(config);

			expect(integration.isEnabled()).toBe(true);
			expect(mockIsAutoSummaryEnabled).toHaveBeenCalledWith(
				config.automationConfig,
			);
		});

		it('returns false when feature flag is disabled', () => {
			mockIsAutoSummaryEnabled.mockReturnValue(false);
			const config = createIntegrationConfig({
				automationConfig: {
					mode: 'manual',
					capabilities: {
						plan_sync: false,
						phase_preflight: false,
						config_doctor_on_startup: false,
						config_doctor_autofix: false,
						evidence_auto_summaries: false,
						decision_drift_detection: false,
					},
				},
			});
			const integration = new EvidenceSummaryIntegration(config);

			expect(integration.isEnabled()).toBe(false);
		});
	});

	describe('initialize', () => {
		it('does not subscribe to events when disabled', () => {
			mockIsAutoSummaryEnabled.mockReturnValue(false);
			const config = createIntegrationConfig();
			const integration = new EvidenceSummaryIntegration(config);

			integration.initialize();

			expect(mockSubscribers.size).toBe(0);
		});

		it('subscribes to preflight.completed event when enabled', () => {
			mockIsAutoSummaryEnabled.mockReturnValue(true);
			const config = createIntegrationConfig();
			const integration = new EvidenceSummaryIntegration(config);

			integration.initialize();

			expect(mockSubscribers.has('preflight.completed')).toBe(true);
		});

		it('subscribes to phase.boundary.detected event when enabled', () => {
			mockIsAutoSummaryEnabled.mockReturnValue(true);
			const config = createIntegrationConfig();
			const integration = new EvidenceSummaryIntegration(config);

			integration.initialize();

			expect(mockSubscribers.has('phase.boundary.detected')).toBe(true);
		});
	});

	describe('generateSummary', () => {
		it('returns null when no plan found', async () => {
			mockIsAutoSummaryEnabled.mockReturnValue(true);
			mockBuildEvidenceSummary.mockResolvedValue(null);

			const config = createIntegrationConfig();
			const integration = new EvidenceSummaryIntegration(config);

			const result = await integration.generateSummary(
				1,
				'preflight.completed',
			);

			expect(result).toBeNull();
			expect(mockBuildEvidenceSummary).toHaveBeenCalledWith(tempDir, 1);
		});

		it('generates and persists summary artifact', async () => {
			mockIsAutoSummaryEnabled.mockReturnValue(true);
			mockBuildEvidenceSummary.mockResolvedValue({
				schema_version: '1.0.0',
				generated_at: new Date().toISOString(),
				planTitle: 'Test Plan',
				currentPhase: 1,
				phaseSummaries: [],
				overallCompletionRatio: 0.5,
				overallBlockers: [],
				summaryText: 'Test summary',
			});

			const config = createIntegrationConfig();
			const integration = new EvidenceSummaryIntegration(config);

			const result = await integration.generateSummary(
				1,
				'preflight.completed',
			);

			expect(result).not.toBeNull();
			expect(result!.planTitle).toBe('Test Plan');

			// Verify artifact was persisted
			const artifactPath = join(projectDir, '.swarm', 'evidence-summary.json');
			expect(existsSync(artifactPath)).toBe(true);

			const content = JSON.parse(readFileSync(artifactPath, 'utf-8'));
			expect(content.planTitle).toBe('Test Plan');
		});

		it('uses custom filename when provided', async () => {
			mockIsAutoSummaryEnabled.mockReturnValue(true);
			mockBuildEvidenceSummary.mockResolvedValue({
				schema_version: '1.0.0',
				generated_at: new Date().toISOString(),
				planTitle: 'Test Plan',
				currentPhase: 1,
				phaseSummaries: [],
				overallCompletionRatio: 0.5,
				overallBlockers: [],
				summaryText: 'Test summary',
			});

			const config = createIntegrationConfig({
				summaryFilename: 'custom-summary.json',
			});
			const integration = new EvidenceSummaryIntegration(config);

			await integration.generateSummary(1, 'preflight.completed');

			const artifactPath = join(projectDir, '.swarm', 'custom-summary.json');
			expect(existsSync(artifactPath)).toBe(true);
		});

		it('creates .swarm directory if it does not exist', async () => {
			// Remove the .swarm directory
			rmSync(join(projectDir, '.swarm'), { recursive: true, force: true });
			expect(existsSync(join(projectDir, '.swarm'))).toBe(false);

			mockIsAutoSummaryEnabled.mockReturnValue(true);
			mockBuildEvidenceSummary.mockResolvedValue({
				schema_version: '1.0.0',
				generated_at: new Date().toISOString(),
				planTitle: 'Test Plan',
				currentPhase: 1,
				phaseSummaries: [],
				overallCompletionRatio: 0.5,
				overallBlockers: [],
				summaryText: 'Test summary',
			});

			const config = createIntegrationConfig();
			const integration = new EvidenceSummaryIntegration(config);

			await integration.generateSummary(1, 'preflight.completed');

			expect(existsSync(join(projectDir, '.swarm'))).toBe(true);
		});

		it('handles errors gracefully', async () => {
			mockIsAutoSummaryEnabled.mockReturnValue(true);
			mockBuildEvidenceSummary.mockRejectedValue(new Error('Test error'));

			const config = createIntegrationConfig();
			const integration = new EvidenceSummaryIntegration(config);

			const result = await integration.generateSummary(
				1,
				'preflight.completed',
			);

			expect(result).toBeNull();
		});
	});

	describe('triggerManual', () => {
		it('generates summary even when feature is disabled', async () => {
			mockIsAutoSummaryEnabled.mockReturnValue(false);
			mockBuildEvidenceSummary.mockResolvedValue({
				schema_version: '1.0.0',
				generated_at: new Date().toISOString(),
				planTitle: 'Test Plan',
				currentPhase: 1,
				phaseSummaries: [],
				overallCompletionRatio: 0.5,
				overallBlockers: [],
				summaryText: 'Test summary',
			});

			const config = createIntegrationConfig();
			const integration = new EvidenceSummaryIntegration(config);

			const result = await integration.triggerManual(1);

			expect(result).not.toBeNull();
			expect(mockBuildEvidenceSummary).toHaveBeenCalled();
		});

		it('uses phase 1 as default when no phase specified', async () => {
			mockIsAutoSummaryEnabled.mockReturnValue(true);
			mockBuildEvidenceSummary.mockResolvedValue({
				schema_version: '1.0.0',
				generated_at: new Date().toISOString(),
				planTitle: 'Test Plan',
				currentPhase: 1,
				phaseSummaries: [],
				overallCompletionRatio: 0.5,
				overallBlockers: [],
				summaryText: 'Test summary',
			});

			const config = createIntegrationConfig();
			const integration = new EvidenceSummaryIntegration(config);

			await integration.triggerManual();

			expect(mockBuildEvidenceSummary).toHaveBeenCalledWith(tempDir, 1);
		});
	});

	describe('cleanup', () => {
		it('removes all subscriptions', () => {
			mockIsAutoSummaryEnabled.mockReturnValue(true);
			const config = createIntegrationConfig();
			const integration = new EvidenceSummaryIntegration(config);

			integration.initialize();
			expect(mockSubscribers.get('preflight.completed')?.length).toBe(1);

			integration.cleanup();
			expect(mockSubscribers.get('preflight.completed')?.length).toBe(0);
		});
	});
});

describe('createEvidenceSummaryIntegration', () => {
	it('creates integration without auto-initialization', () => {
		mockIsAutoSummaryEnabled.mockReturnValue(true);
		const config = createIntegrationConfig();

		const integration = createEvidenceSummaryIntegration(config, false);

		expect(integration).toBeInstanceOf(EvidenceSummaryIntegration);
		expect(mockSubscribers.size).toBe(0);
	});

	it('creates and initializes integration by default', () => {
		mockIsAutoSummaryEnabled.mockReturnValue(true);
		const config = createIntegrationConfig();

		const integration = createEvidenceSummaryIntegration(config);

		expect(integration).toBeInstanceOf(EvidenceSummaryIntegration);
		expect(mockSubscribers.has('preflight.completed')).toBe(true);
	});
});
