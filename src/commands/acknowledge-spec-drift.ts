import { promises as fsPromises } from 'node:fs';
import { validateSwarmPath } from '../hooks/utils';
import { loadPlanJsonOnly, savePlan } from '../plan/manager';
import type { SpecDriftAcknowledgedEvent } from '../types/events';
import { computeSpecHash } from '../utils/spec-hash';

interface SpecStalenessPayload {
	planTitle: string;
	phase: number;
	specHash_plan: string;
	specHash_current: string | null;
	reason: string;
	timestamp: string;
}

/**
 * Handle /swarm acknowledge-spec-drift command
 * Acknowledges and clears a previously detected spec drift staleness warning
 */
export async function handleAcknowledgeSpecDriftCommand(
	directory: string,
	_args: string[],
): Promise<string> {
	const specStalenessPath = validateSwarmPath(directory, 'spec-staleness.json');

	let stalenessContent: string;
	try {
		stalenessContent = await fsPromises.readFile(specStalenessPath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
			return 'No spec drift detected.';
		}
		throw error;
	}

	let stalenessData: SpecStalenessPayload;
	try {
		stalenessData = JSON.parse(stalenessContent);
	} catch {
		// If the file exists but is malformed, delete it and report
		await fsPromises.unlink(specStalenessPath).catch(() => {});
		return 'Spec staleness file was corrupted. It has been removed.';
	}

	const { planTitle, phase } = stalenessData;

	// Update plan.specHash to current spec hash after acknowledgment
	let currentHash: string | null = null;
	let planUpdateSkipped = false;
	try {
		const plan = await loadPlanJsonOnly(directory);
		if (plan?.specHash) {
			currentHash = await computeSpecHash(directory);
			// Convert null to undefined since plan.specHash is string | undefined
			plan.specHash = currentHash ?? undefined;
			await savePlan(directory, plan);
		}
	} catch (planError) {
		// Non-fatal: spec drift was acknowledged but plan update failed
		console.error(
			'[acknowledge-spec-drift] Failed to update plan specHash:',
			planError instanceof Error ? planError.message : String(planError),
		);
		planUpdateSkipped = true;
	}

	// Only delete spec-staleness.json after plan.specHash update succeeds
	if (!planUpdateSkipped) {
		await fsPromises.unlink(specStalenessPath);
	}

	// Append acknowledgment event to events.jsonl
	const eventsPath = validateSwarmPath(directory, 'events.jsonl');
	const acknowledgmentEvent: SpecDriftAcknowledgedEvent = {
		type: 'spec_drift_acknowledged',
		timestamp: new Date().toISOString(),
		phase,
		planTitle,
		acknowledgedBy: 'architect',
		previousHash: stalenessData.specHash_plan,
		newHash: currentHash,
	};

	let eventWriteFailed = false;
	try {
		await fsPromises.appendFile(
			eventsPath,
			`${JSON.stringify(acknowledgmentEvent)}\n`,
			'utf-8',
		);
	} catch (appendError) {
		// Non-fatal: the spec drift was acknowledged but event logging failed
		console.error(
			'[acknowledge-spec-drift] Failed to write acknowledgment event:',
			appendError instanceof Error ? appendError.message : String(appendError),
		);
		eventWriteFailed = true;
	}

	const warnings: string[] = [];
	if (planUpdateSkipped) {
		warnings.push('Plan specHash update was skipped due to an error.');
	}
	if (eventWriteFailed) {
		warnings.push('Event logging failed — audit trail may be incomplete.');
	}

	const baseMessage = `Spec drift acknowledged for plan "${planTitle}" (phase ${phase}).`;
	const warningMessage =
		warnings.length > 0
			? `\n\n⚠️  Warnings:\n${warnings.map((w) => `  - ${w}`).join('\n')}`
			: '';
	const cautionMessage =
		'\n\n⚠️  Warning: Spec drift was acknowledged — verify that the implementation still matches the spec before proceeding.';
	return baseMessage + warningMessage + cautionMessage;
}
