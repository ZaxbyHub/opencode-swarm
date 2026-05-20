/**
 * Shared test helpers for system-enhancer tests
 *
 * Provides reusable setup, mock factories, and common fixtures for testing
 * the system-enhancer hook and buildRetroInjection function.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from '../../src/config';
import type { EvidenceBundle } from '../../src/config/evidence-schema';

// =============================================================================
// Temp Directory Setup/Teardown
// =============================================================================

/**
 * Creates a temporary directory for testing.
 * Returns the path and a cleanup function.
 */
export async function setupTempDir(prefix = 'swarm-test-'): Promise<{
	tempDir: string;
	cleanup: () => Promise<void>;
}> {
	const tempDir = await mkdtemp(join(tmpdir(), prefix));
	const cleanup = async (): Promise<void> => {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	};
	return { tempDir, cleanup };
}

/**
 * Writes a retro bundle file to disk.
 */
export async function writeRetroBundle(
	tempDir: string,
	phaseNumber: number,
	bundle: EvidenceBundle,
): Promise<string> {
	const taskDir = join(tempDir, '.swarm', 'evidence', `retro-${phaseNumber}`);
	await mkdir(taskDir, { recursive: true });
	const bundlePath = join(taskDir, 'evidence.json');
	await writeFile(bundlePath, JSON.stringify(bundle, null, 2));
	return bundlePath;
}

// =============================================================================
// Retro Bundle Factories
// =============================================================================

export interface RetroEntryOverrides {
	lessons_learned?: string[];
	top_rejection_reasons?: string[];
	verdict?: 'pass' | 'fail' | 'info';
	summary?: string;
	timestamp?: string;
	phase_number?: number;
	user_directives?: Array<{
		directive: string;
		category: 'tooling' | 'code_style' | 'architecture' | 'process' | 'other';
		scope: 'session' | 'project' | 'global';
	}>;
}

const DEFAULT_RETRO_ENTRY = {
	type: 'retrospective' as const,
	agent: 'architect',
	total_tool_calls: 42,
	coder_revisions: 2,
	test_failures: 0,
	security_findings: 0,
	integration_issues: 0,
	task_count: 5,
	task_complexity: 'moderate' as const,
};

/**
 * Creates a retro bundle data structure (not written to disk).
 */
export function createRetroBundleData(
	phaseNumber: number,
	verdict: 'pass' | 'fail' | 'info' = 'pass',
	lessons: string[] = [],
	rejections: string[] = [],
	summary: string = 'Phase completed.',
	overrides: RetroEntryOverrides = {},
): EvidenceBundle {
	const timestamp = overrides.timestamp ?? new Date().toISOString();

	const retroEntry = {
		...DEFAULT_RETRO_ENTRY,
		task_id: `retro-${phaseNumber}`,
		timestamp,
		verdict,
		summary,
		phase_number: overrides.phase_number ?? phaseNumber,
		reviewer_rejections: rejections.length,
		top_rejection_reasons: rejections,
		lessons_learned: lessons,
		user_directives: overrides.user_directives ?? [],
		...overrides,
	};

	return {
		schema_version: '1.0.0',
		task_id: `retro-${phaseNumber}`,
		created_at: timestamp,
		updated_at: timestamp,
		entries: [retroEntry],
	};
}

/**
 * Creates and writes a retro bundle to disk.
 * Returns the path to the written bundle.
 */
export async function createRetroBundle(
	tempDir: string,
	phaseNumber: number,
	verdict: 'pass' | 'fail' | 'info' = 'pass',
	lessons: string[] = [],
	rejections: string[] = [],
	summary: string = 'Phase completed.',
	overrides: RetroEntryOverrides = {},
): Promise<string> {
	const bundle = createRetroBundleData(
		phaseNumber,
		verdict,
		lessons,
		rejections,
		summary,
		overrides,
	);
	return writeRetroBundle(tempDir, phaseNumber, bundle);
}

// =============================================================================
// Swarm Files Setup
// =============================================================================

/**
 * Creates standard swarm directory structure: .swarm/ with plan.json, plan.md, context.md
 */
export async function createSwarmFiles(
	tempDir: string,
	currentPhase: number = 1,
): Promise<void> {
	const swarmDir = join(tempDir, '.swarm');
	await mkdir(swarmDir, { recursive: true });
	await writeFile(join(swarmDir, 'plan.md'), '# Plan\n');
	await writeFile(join(swarmDir, 'context.md'), '# Context\n');

	const plan = {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: currentPhase,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: currentPhase === 1 ? 'in_progress' : 'complete',
				tasks: [],
			},
			...(currentPhase >= 2
				? [
						{
							id: 2,
							name: 'Phase 2',
							status: currentPhase === 2 ? 'in_progress' : 'complete',
							tasks: [],
						},
					]
				: []),
		],
	};
	await writeFile(join(swarmDir, 'plan.json'), JSON.stringify(plan, null, 2));
}

// =============================================================================
// Hook Invocation Helper
// =============================================================================

/**
 * Creates a default PluginConfig for testing.
 */
export const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
};

import {
	buildRetroInjection,
	createSystemEnhancerHook,
} from '../../src/hooks/system-enhancer';
import { resetSwarmState, swarmState } from '../../src/state';

/**
 * Invokes the system enhancer hook and returns the system output array.
 */
export async function invokeHook(
	config: PluginConfig,
	tempDir: string,
	sessionId: string = 'test-session',
	activeAgent: string | null = null,
): Promise<string[]> {
	resetSwarmState();
	const hooks = createSystemEnhancerHook(config, tempDir);
	const transform = hooks['experimental.chat.system.transform'] as (
		input: { sessionID?: string },
		output: { system: string[] },
	) => Promise<void>;

	if (activeAgent) {
		swarmState.activeAgent.set(sessionId, activeAgent);
	}

	const input = { sessionID: sessionId };
	const output = { system: [] };
	await transform(input, output);
	return output.system;
}

/**
 * Invokes buildRetroInjection directly for targeted tests.
 */
export async function invokeBuildRetroInjection(
	tempDir: string,
	currentPhaseNumber: number,
): Promise<string | null> {
	return buildRetroInjection(tempDir, currentPhaseNumber);
}

// =============================================================================
// Type Exports
// =============================================================================

export type { EvidenceBundle };
