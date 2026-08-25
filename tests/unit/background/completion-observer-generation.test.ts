/**
 * Issue #2104 — completion-observer generation fencing and post-terminal
 * maintenance (points P2).
 *
 * A trusted terminal for an older generation must NOT release a reservation
 * the store now owns at a newer generation, and a settled terminal must
 * leave a maintenance observation in the durable facts ring.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import { readDelegationHealthArtifact } from '../../../src/background/delegation-health';
import {
	bindBackgroundCoderReservation,
	recordPendingDelegation,
	reserveBackgroundCoderSlot,
	scanBackgroundCoderReservationsForAdmission,
} from '../../../src/background/pending-delegations';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function errorEvent(subagentSessionId: string, parentSessionId = 'parent') {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: parentSessionId,
					text: `<task id="${subagentSessionId}" state="error">\n<task_error>boom</task_error>\n</task>`,
				},
			},
		},
	};
}

describe('completion observer generation fencing (issue #2104)', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		resetSwarmState();
		const safe = createSafeTestDir('swarm-obs-gen-');
		directory = safe.dir;
		cleanup = safe.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('an older-generation terminal cannot release a newer-generation reservation', async () => {
		ensureAgentSession('parent', 'architect');
		const claim = await reserveBackgroundCoderSlot(directory, {
			parentSessionId: 'parent',
			planTaskId: '1.1',
			callID: 'coder-call',
			maxConcurrent: 4,
		});
		expect(claim.ok).toBe(true);
		if (!claim.ok) return;
		const bound = await bindBackgroundCoderReservation(directory, {
			reservationId: claim.reservation.reservationId,
			parentSessionId: 'parent',
			planTaskId: '1.1',
			callID: 'coder-call',
			correlationId: 'coder-session',
			generation: 2,
		});
		expect(bound?.generation).toBe(2);

		// The durable record carries generation 1 — a stale first attempt.
		await recordPendingDelegation(directory, {
			correlationId: 'coder-session',
			jobId: 'job-coder',
			subagentSessionId: 'coder-session',
			parentSessionId: 'parent',
			callID: 'coder-call',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			coderReservationId: claim.reservation.reservationId,
			generation: 1,
		});

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(errorEvent('coder-session'));

		// The terminal was claimed (record is terminal) but the reservation
		// survives: generation 1 must not release generation 2.
		const scan = scanBackgroundCoderReservationsForAdmission(directory);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.reservations).toHaveLength(1);
			expect(scan.reservations[0]?.generation).toBe(2);
		}
	});

	test('a settled terminal leaves a durable maintenance observation', async () => {
		ensureAgentSession('parent', 'architect');
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await recordPendingDelegation(directory, {
			correlationId: 'coder-session',
			jobId: 'job-coder',
			subagentSessionId: 'coder-session',
			parentSessionId: 'parent',
			callID: 'coder-call',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			generation: 1,
		});

		await observer.event(errorEvent('coder-session'));

		const health = readDelegationHealthArtifact(directory);
		expect(health?.maintenance?.lastRunAt).toBeDefined();
		expect(health?.maintenance?.lastOkAt).not.toBeNull();
	});
});
