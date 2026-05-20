/**
 * Steering consumed hook for OpenCode Swarm
 *
 * Provides mechanisms for recording and tracking steering directive consumption.
 * Writes steering-consumed events to .swarm/events.jsonl for health check verification.
 */

import * as fs from 'node:fs';
import { bunFile } from '../utils/bun-compat';
import { safeHook, validateSwarmPath } from './utils.js';

/**
 * Event written to .swarm/events.jsonl when a steering directive is consumed
 */
export interface SteeringConsumedEvent {
	type: 'steering-consumed';
	directiveId: string;
	timestamp: string;
}

/**
 * Records a steering-consumed event to the events.jsonl file.
 * Synchronous function that appends a single JSON line.
 *
 * @param directory - The project directory containing the .swarm folder
 * @param directiveId - The ID of the steering directive that was consumed
 */
export function recordSteeringConsumed(
	directory: string,
	directiveId: string,
): void {
	try {
		const eventsPath = validateSwarmPath(directory, 'events.jsonl');
		const event: SteeringConsumedEvent = {
			type: 'steering-consumed',
			directiveId,
			timestamp: new Date().toISOString(),
		};
		fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, 'utf-8');
	} catch {
		// Silently swallow errors - non-fatal operation
	}
}

/**
 * Creates a hook that records steering-consumed events for any unconsumed directives.
 * Reads events.jsonl to find steering-directive events without matching consumed events.
 *
 * @param directory - The project directory containing the .swarm folder
 * @returns A fire-and-forget hook function
 */
export function createSteeringConsumedHook(
	directory: string,
): (input: unknown, output: unknown) => Promise<void> {
	const hook = async (): Promise<void> => {
		try {
			const eventsPath = validateSwarmPath(directory, 'events.jsonl');
			const file = bunFile(eventsPath);
			const content = await file.text();

			if (!content.trim()) {
				return;
			}

			const lines = content.trim().split('\n');
			const directiveIds = new Set<string>();
			const consumedIds = new Set<string>();

			for (const line of lines) {
				if (!line.trim()) {
					continue;
				}

				try {
					const parsed = JSON.parse(line) as {
						type: string;
						directiveId?: string;
					};

					if (parsed.type === 'steering-directive' && parsed.directiveId) {
						directiveIds.add(parsed.directiveId);
					} else if (
						parsed.type === 'steering-consumed' &&
						parsed.directiveId
					) {
						consumedIds.add(parsed.directiveId);
					}
				} catch {
					// Skip malformed lines
				}
			}

			// Find unconsumed directives and record them
			for (const directiveId of directiveIds) {
				if (!consumedIds.has(directiveId)) {
					recordSteeringConsumed(directory, directiveId);
				}
			}
		} catch {
			// Silently swallow errors - non-fatal operation
		}
	};

	return safeHook(hook);
}
