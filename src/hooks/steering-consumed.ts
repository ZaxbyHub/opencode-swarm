/**
 * Steering consumed hook for OpenCode Swarm
 *
 * Provides mechanisms for recording and tracking steering directive consumption.
 * Writes steering-consumed events to the core event store for health check
 * verification.
 *
 * ISSUE #2039: the reconciliation read is now the bounded core event window
 * (manifest-stripped, hard read bound) instead of the whole file. Directives
 * issued before the retained window cannot be reconciled by design; the
 * window's coverage is observable via the core event store (diagnose Check E
 * discloses it).
 */

import {
	appendCoreEventSync,
	appendCoreEventsSync,
	readCoreEvents,
} from '../events/core-events.js';
import { safeHook } from './utils.js';

/**
 * Event written when a steering directive is consumed
 */
export interface SteeringConsumedEvent {
	type: 'steering-consumed';
	directiveId: string;
	timestamp: string;
}

/**
 * Records a steering-consumed event to the core event store.
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
		appendCoreEventSync(directory, {
			type: 'steering-consumed',
			directiveId,
			timestamp: new Date().toISOString(),
		});
	} catch {
		// Silently swallow errors - non-fatal operation
	}
}

/**
 * Creates a hook that records steering-consumed events for any unconsumed directives.
 * Reads the bounded core event window to find steering-directive events without
 * matching consumed events (issue #2039).
 *
 * @param directory - The project directory containing the .swarm folder
 * @returns A fire-and-forget hook function
 */
export function createSteeringConsumedHook(
	directory: string,
): (input: unknown, output: unknown) => Promise<void> {
	const hook = async (): Promise<void> => {
		try {
			const window = readCoreEvents(directory);
			if (!window.text.trim()) {
				return;
			}

			const lines = window.text.trim().split('\n');
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

			// Find unconsumed directives and record them as ONE batch (a
			// single store-lock acquisition — issue #2039).
			const unconsumed = [...directiveIds].filter((id) => !consumedIds.has(id));
			if (unconsumed.length > 0) {
				appendCoreEventsSync(
					directory,
					unconsumed.map((directiveId) => ({
						type: 'steering-consumed' as const,
						directiveId,
						timestamp: new Date().toISOString(),
					})),
				);
			}
		} catch {
			// Silently swallow errors - non-fatal operation
		}
	};

	return safeHook(hook);
}
