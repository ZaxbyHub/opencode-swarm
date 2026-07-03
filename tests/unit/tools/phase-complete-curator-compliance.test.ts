import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as realCurator from '../../../src/hooks/curator';
import * as realCuratorDrift from '../../../src/hooks/curator-drift';
import * as realKnowledgeCurator from '../../../src/hooks/knowledge-curator.js';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
} from '../../../src/state';
import {
	createConfig,
	writeGateEvidence,
	writeRetroBundle,
} from './_phase-complete-test-helpers';

// Mock curator functions BEFORE importing the module under test
const mockRunCuratorPhase = mock(async () => ({
	phase: 1,
	agents_dispatched: ['coder', 'reviewer', 'test_engineer'],
	compliance: [],
	knowledge_recommendations: [],
	summary: 'Test curator phase result',
	timestamp: new Date().toISOString(),
}));

const mockApplyCuratorKnowledgeUpdates = mock(async () => ({
	applied: 0,
	skipped: 0,
}));

const mockRunDeterministicDriftCheck = mock(async () => ({
	phase: 1,
	report: {
		schema_version: 1 as const,
		phase: 1,
		timestamp: new Date().toISOString(),
		alignment: 'ALIGNED' as const,
		drift_score: 0,
		first_deviation: null,
		compounding_effects: [],
		corrections: [],
		requirements_checked: 0,
		requirements_satisfied: 0,
		scope_additions: [],
		injection_summary: '',
	},
	report_path: '',
	injection_text: '',
}));

// Mock the curator modules — spread real exports, override only the mocked functions
mock.module('../../../src/hooks/curator', () => ({
	...realCurator,
	runCuratorPhase: mockRunCuratorPhase,
	applyCuratorKnowledgeUpdates: mockApplyCuratorKnowledgeUpdates,
}));

mock.module('../../../src/hooks/curator-drift', () => ({
	...realCuratorDrift,
	runDeterministicDriftCheck: mockRunDeterministicDriftCheck,
	readPriorDriftReports: mock(async () => []),
}));

// Also mock the knowledge-curator module to avoid interference from curateAndStoreSwarm
mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	...realKnowledgeCurator,
	curateAndStoreSwarm: mock(async () => {}),
}));

// Import the tool after setting up mocks
const { phase_complete } = await import('../../../src/tools/phase-complete');

/**
 * Task 5.3: Curator wiring fix - compliance warnings surfacing
 *
 * Phase 4.2 fix: phase_complete surfaces compliance warnings when suppress_warnings is false.
 *
 * Tests:
 * - phase_complete surfaces compliance warnings when suppress_warnings: false
 * - phase_complete does NOT surface compliance warnings when suppress_warnings: true
 */
describe('Task 5.3: curator compliance warnings surfacing', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		mockRunCuratorPhase.mockClear();
		mockApplyCuratorKnowledgeUpdates.mockClear();
		mockRunDeterministicDriftCheck.mockClear();

		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-compliance-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });

		writeRetroBundle(tempDir, 1, 'pass');
		writeGateEvidence(tempDir, 1);
		writeRetroBundle(tempDir, 2, 'pass');
		writeGateEvidence(tempDir, 2);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
		resetSwarmState();
		// Restore cross-module mocks per two-tier DI convention
		mock.restore();
	});

	describe('compliance warnings are surfaced when suppress_warnings: false', () => {
		test('phase_complete surfaces compliance warnings in result when curator returns compliance observations', async () => {
			// Set up config with curator enabled and suppress_warnings: false
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			// Create custom config with suppress_warnings: false
			const customConfig = {
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
				curator: {
					enabled: true,
					phase_enabled: true,
					init_enabled: true,
					max_summary_tokens: 2000,
					min_knowledge_confidence: 0.7,
					compliance_report: true,
					suppress_warnings: false, // Key setting for this test
					drift_inject_max_chars: 500,
				},
			};
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify(customConfig),
			);

			// Set up runCuratorPhase to return compliance observations
			mockRunCuratorPhase.mockResolvedValueOnce({
				phase: 1,
				agents_dispatched: ['coder'],
				compliance: [
					{ severity: 'warning', description: 'Reviewer skipped for task 1.1' },
					{
						severity: 'error',
						description: 'No retrospective written for phase 1',
					},
				],
				knowledge_recommendations: [],
				summary: 'Test phase result',
				timestamp: new Date().toISOString(),
			});

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.warnings).toBeDefined();

			// Compliance warnings should be surfaced
			const complianceWarning = parsed.warnings.find((w: string) =>
				w.includes('Curator compliance'),
			);
			expect(complianceWarning).toBeDefined();
			expect(complianceWarning).toContain('Reviewer skipped');
			expect(complianceWarning).toContain('No retrospective');
		});

		test('compliance warnings are capped at 5 observations', async () => {
			// Set up config with curator enabled and suppress_warnings: false
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			// Create custom config with suppress_warnings: false
			const customConfig = {
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
				curator: {
					enabled: true,
					phase_enabled: true,
					init_enabled: true,
					max_summary_tokens: 2000,
					min_knowledge_confidence: 0.7,
					compliance_report: true,
					suppress_warnings: false, // Key setting for this test
					drift_inject_max_chars: 500,
				},
			};
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify(customConfig),
			);

			// Set up runCuratorPhase to return more than 5 compliance observations
			const manyObservations = Array.from({ length: 10 }, (_, i) => ({
				severity: 'warning' as const,
				description: `Compliance observation ${i + 1}`,
			}));

			mockRunCuratorPhase.mockResolvedValueOnce({
				phase: 1,
				agents_dispatched: ['coder'],
				compliance: manyObservations,
				knowledge_recommendations: [],
				summary: 'Test phase result',
				timestamp: new Date().toISOString(),
			});

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// Find the curator compliance warning
			const complianceWarning = parsed.warnings.find((w: string) =>
				w.includes('Curator compliance'),
			);
			expect(complianceWarning).toBeDefined();

			// Should contain only 5 observations (capped)
			const warningText = complianceWarning as string;
			// Each observation appears as [WARNING] or [ERROR] description
			const warningCount = (warningText.match(/\[WARNING\]/g) || []).length;
			const errorCount = (warningText.match(/\[ERROR\]/g) || []).length;
			expect(warningCount + errorCount).toBeLessThanOrEqual(5);
		});
	});

	describe('compliance warnings are NOT surfaced when suppress_warnings: true', () => {
		test('phase_complete does NOT surface compliance warnings when suppress_warnings: true', async () => {
			// Set up config with curator enabled and suppress_warnings: true (default)
			// createConfig already sets suppress_warnings: true by default
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

			// Set up runCuratorPhase to return compliance observations
			mockRunCuratorPhase.mockResolvedValueOnce({
				phase: 1,
				agents_dispatched: ['coder'],
				compliance: [
					{ severity: 'warning', description: 'Reviewer skipped for task 1.1' },
				],
				knowledge_recommendations: [],
				summary: 'Test phase result',
				timestamp: new Date().toISOString(),
			});

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.warnings).toBeDefined();

			// Compliance warnings should NOT be surfaced
			const complianceWarning = parsed.warnings.find((w: string) =>
				w.includes('Curator compliance'),
			);
			expect(complianceWarning).toBeUndefined();
		});

		test('phase_complete does NOT surface compliance warnings when curator returns empty compliance array', async () => {
			// Set up config with curator enabled
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

			// Set up runCuratorPhase to return empty compliance array
			mockRunCuratorPhase.mockResolvedValueOnce({
				phase: 1,
				agents_dispatched: ['coder'],
				compliance: [],
				knowledge_recommendations: [],
				summary: 'Test phase result',
				timestamp: new Date().toISOString(),
			});

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.warnings).toBeDefined();

			// Compliance warnings should NOT be surfaced (empty array)
			const complianceWarning = parsed.warnings.find((w: string) =>
				w.includes('Curator compliance'),
			);
			expect(complianceWarning).toBeUndefined();
		});
	});
});
