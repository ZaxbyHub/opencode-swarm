/**
 * Preflight Background Integration
 *
 * Wires the preflight service to background automation:
 * - Subscribes to preflight.requested events
 * - Runs preflight checks
 * - Updates status artifact with results
 */

import {
	type AutomationStatusArtifact,
	getSharedAutomationStatusArtifact,
} from '../background/status-artifact';
import {
	type PreflightHandler,
	type PreflightRequest,
	PreflightTriggerManager,
} from '../background/trigger';
import type { AutomationConfig } from '../config/schema';
import {
	type PreflightConfig,
	type PreflightReport,
	runPreflight,
} from '../services/preflight-service';
import * as logger from '../utils/logger';

/** Integration configuration */
export interface PreflightIntegrationConfig {
	/** Automation configuration (required for capability gating) */
	automationConfig: AutomationConfig;
	/** Directory to run preflight in */
	directory: string;
	/** Swarm directory for status artifact */
	swarmDir: string;
	/** Preflight check configuration */
	preflightConfig?: PreflightConfig;
	/** Whether to update status artifact (default true) */
	updateStatusArtifact?: boolean;
}

/**
 * Create preflight integration
 *
 * Sets up the handler that will be called when preflight is requested.
 * Returns the trigger manager and cleanup function.
 */
export function createPreflightIntegration(
	config: PreflightIntegrationConfig,
): {
	manager: PreflightTriggerManager;
	cleanup: () => void;
} {
	const {
		automationConfig,
		directory,
		swarmDir,
		preflightConfig,
		updateStatusArtifact = true,
	} = config;

	// Validate that preflight is enabled in automation config
	// Use optional chaining to fail-safe when config is malformed
	const phasePreflightEnabled =
		automationConfig?.capabilities?.phase_preflight === true;
	if (!phasePreflightEnabled) {
		throw new Error(
			'Preflight is not enabled in automation capabilities. Set automation.capabilities.phase_preflight to true.',
		);
	}

	// Create trigger manager with real automation config
	const triggerConfig = {
		directory,
	};

	const manager = new PreflightTriggerManager(
		automationConfig,
		undefined,
		triggerConfig,
	);

	// Create status artifact if enabled
	let statusArtifact: AutomationStatusArtifact | null = null;
	if (updateStatusArtifact && swarmDir) {
		statusArtifact = getSharedAutomationStatusArtifact(swarmDir);
	}

	// Create preflight handler
	const preflightHandler: PreflightHandler = async (
		request: PreflightRequest,
	): Promise<void> => {
		logger.log('[PreflightIntegration] Handling preflight request', {
			requestId: request.id,
			phase: request.currentPhase,
			source: request.source,
		});

		// Run preflight checks
		const report = await runPreflight(
			directory,
			request.currentPhase,
			preflightConfig,
		);

		// Update status artifact if available. The artifact is optional output:
		// a persistence failure must never reject the preflight handler (the
		// scheduler wrapper's catch does not apply to handler-time calls), so
		// this carries its own bounded non-fatal catch (issue #2669, Change 1b)
		// in addition to the writer's containment.
		if (statusArtifact) {
			const state = report.overall === 'pass' ? 'success' : 'failure';
			try {
				statusArtifact.recordOutcome(
					state,
					request.currentPhase,
					report.message,
				);
				// Success line lives inside the try so a contained failure is
				// never followed by a misleading "updated" record (PR review
				// PRR-001 on #2669).
				logger.log('[PreflightIntegration] Status artifact updated', {
					state,
					phase: request.currentPhase,
					message: report.message,
				});
			} catch (err) {
				const code =
					typeof err === 'object' && err !== null && 'code' in err
						? String((err as { code?: unknown }).code ?? 'unknown')
						: 'unknown';
				logger.log(
					'[PreflightIntegration] Status artifact update failed (non-fatal)',
					{ code },
				);
			}
		}

		logger.log('[PreflightIntegration] Preflight complete', {
			requestId: request.id,
			overall: report.overall,
			message: report.message,
			durationMs: report.totalDurationMs,
		});
	};

	// Register the handler
	manager.registerHandler(preflightHandler);

	// Return cleanup function
	const cleanup = () => {
		manager.unregisterHandler();
	};

	return {
		manager,
		cleanup,
	};
}

/**
 * Run preflight manually (for testing or CLI)
 */
export async function runManualPreflight(
	directory: string,
	phase: number,
	config?: PreflightConfig,
): Promise<PreflightReport> {
	return runPreflight(directory, phase, config);
}
