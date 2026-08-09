import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ReviewModelDispatcher } from '../../../src/review/contracts';
import {
	canonicalizeValidationCandidates,
	createFindingValidationScheduler,
	type FindingValidationResult,
	type FindingValidationScheduler,
	MAX_TRACKED_VALIDATION_SESSIONS,
	runFindingValidation,
} from '../../../src/review/finding-validator';

const FINDING = {
	title: 'State is lost',
	body: 'The assignment overwrites the only retained state.',
	severity: 'high' as const,
	confidence: 0.94,
	file: 'src/state.ts',
	line_start: 10,
	line_end: 11,
};

function dispatcherWith(text: string): {
	dispatcher: ReviewModelDispatcher;
	calls: Array<Record<string, unknown>>;
} {
	const calls: Array<Record<string, unknown>> = [];
	return {
		calls,
		dispatcher: {
			async dispatch(request) {
				calls.push(request as unknown as Record<string, unknown>);
				return {
					status: 'completed' as const,
					text,
					agentName: request.agentName,
					durationMs: 1,
					promptBytes: request.prompt.length,
					responseBytes: text.length,
				};
			},
		},
	};
}

let validationScheduler: FindingValidationScheduler;
function scheduleFindingValidation(
	...args: Parameters<FindingValidationScheduler['schedule']>
): boolean {
	return validationScheduler.schedule(...args);
}

describe('finding validator', () => {
	beforeEach(() => {
		validationScheduler = createFindingValidationScheduler();
	});
	afterEach(() => validationScheduler.reset());

	test('assigns stable harness IDs and collapses byte-identical candidates', () => {
		const first = canonicalizeValidationCandidates([
			FINDING,
			{ ...FINDING },
			{ ...FINDING, line_start: 12, line_end: 12 },
		]);
		const second = canonicalizeValidationCandidates([
			{ ...FINDING, line_start: 12, line_end: 12 },
			FINDING,
		]);

		expect(first).toHaveLength(2);
		expect(
			first.find((item) => item.line_start === FINDING.line_start)
				?.duplicate_count,
		).toBe(2);
		expect(first[0].finding_id).toMatch(/^[a-f0-9]{64}$/);
		expect(new Set(first.map((item) => item.finding_id))).toEqual(
			new Set(second.map((item) => item.finding_id)),
		);
	});

	test('makes zero calls when no candidates qualify', async () => {
		const { dispatcher, calls } = dispatcherWith('{}');
		const result = await runFindingValidation({
			dispatcher,
			directory: 'C:\\repo',
			parentSessionId: 'parent',
			agentName: 'critic_finding_validator',
			timeoutMs: 30_000,
			findings: [],
		});
		expect(result.complete).toBe(true);
		expect(result.validations).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	test('accepts a reordered exact echoed-ID set', async () => {
		const candidates = canonicalizeValidationCandidates([
			FINDING,
			{ ...FINDING, file: 'src/other.ts', line_start: 2, line_end: 2 },
		]);
		const { dispatcher } = dispatcherWith(
			JSON.stringify({
				validations: [...candidates].reverse().map((candidate) => ({
					finding_id: candidate.finding_id,
					disposition: 'CONFIRMED',
					confidence: 0.9,
					evidence: `${candidate.file}:${candidate.line_start} reproduces`,
				})),
			}),
		);
		const result = await runFindingValidation({
			dispatcher,
			directory: 'C:\\repo',
			parentSessionId: 'parent',
			agentName: 'critic_finding_validator',
			timeoutMs: 30_000,
			findings: candidates,
		});
		expect(result.complete).toBe(true);
		expect(result.validations).toHaveLength(2);
	});

	test('requires exactly one fenced JSON wrapper and no other JSON in the prompt', async () => {
		const candidates = canonicalizeValidationCandidates([FINDING]);
		const { dispatcher, calls } = dispatcherWith(
			JSON.stringify({
				validations: [
					{
						finding_id: candidates[0].finding_id,
						disposition: 'DISPROVED',
						confidence: 0.9,
						evidence: 'The assignment preserves the retained state.',
					},
				],
			}),
		);
		await runFindingValidation({
			dispatcher,
			directory: 'C:\\repo',
			agentName: 'critic_finding_validator',
			timeoutMs: 30_000,
			findings: candidates,
		});

		expect(calls[0].system).toContain(
			'exactly one fenced ```json ... ``` wrapper',
		);
		expect(calls[0].system).toContain('Do not emit any other JSON');
	});

	test('marks conflicting valid validator wrappers incomplete', async () => {
		const candidates = canonicalizeValidationCandidates([FINDING]);
		const wrapper = (disposition: 'CONFIRMED' | 'DISPROVED') =>
			JSON.stringify({
				validations: [
					{
						finding_id: candidates[0].finding_id,
						disposition,
						confidence: 0.99,
						evidence: `${disposition} from direct repository evidence.`,
					},
				],
			});
		const { dispatcher } = dispatcherWith(
			[
				'```json',
				wrapper('CONFIRMED'),
				'```',
				'```json',
				wrapper('DISPROVED'),
				'```',
			].join('\n'),
		);
		const result = await runFindingValidation({
			dispatcher,
			directory: 'C:\\repo',
			agentName: 'critic_finding_validator',
			timeoutMs: 30_000,
			findings: candidates,
		});

		expect(result.complete).toBe(false);
		expect(result.validations).toEqual([]);
		expect(result.error).toContain('found 2');
	});

	test.each([
		['missing', (ids: string[]) => [ids[0]]],
		['duplicate', (ids: string[]) => [ids[0], ids[0]]],
		['unknown', (ids: string[]) => [ids[0], 'f'.repeat(64)]],
	])('marks %s validator ID sets incomplete', async (_name, selectIds) => {
		const candidates = canonicalizeValidationCandidates([
			FINDING,
			{ ...FINDING, file: 'src/other.ts', line_start: 2, line_end: 2 },
		]);
		const ids = selectIds(candidates.map((candidate) => candidate.finding_id));
		const { dispatcher } = dispatcherWith(
			JSON.stringify({
				validations: ids.map((finding_id) => ({
					finding_id,
					disposition: 'DISPROVED',
					confidence: 0.9,
					evidence: 'not reproduced',
				})),
			}),
		);
		const result = await runFindingValidation({
			dispatcher,
			directory: 'C:\\repo',
			agentName: 'critic_finding_validator',
			timeoutMs: 30_000,
			findings: candidates,
		});
		expect(result.complete).toBe(false);
		expect(result.error).toBeDefined();
	});

	test('preserves explicit UNVERIFIED without treating it as confirmed', async () => {
		const candidates = canonicalizeValidationCandidates([FINDING]);
		const { dispatcher } = dispatcherWith(
			JSON.stringify({
				validations: [
					{
						finding_id: candidates[0].finding_id,
						disposition: 'UNVERIFIED',
						confidence: 0.4,
						evidence: 'runtime precondition unavailable',
					},
				],
			}),
		);
		const result = await runFindingValidation({
			dispatcher,
			directory: 'C:\\repo',
			agentName: 'critic_finding_validator',
			timeoutMs: 30_000,
			findings: candidates,
		});
		expect(result.complete).toBe(true);
		expect(result.validations[0].disposition).toBe('UNVERIFIED');
	});

	test('malformed output is incomplete even when dispatch succeeds', async () => {
		const candidates = canonicalizeValidationCandidates([FINDING]);
		const { dispatcher } = dispatcherWith('{"validations":[{"bad":true}]}');
		const result = await runFindingValidation({
			dispatcher,
			directory: 'C:\\repo',
			agentName: 'critic_finding_validator',
			timeoutMs: 30_000,
			findings: candidates,
		});
		expect(result.complete).toBe(false);
		expect(result.error).toMatch(/validation/i);
	});

	test('does not evict active work when the session capacity is reached', async () => {
		const resolvers: Array<() => void> = [];
		const completed: string[] = [];
		for (let index = 0; index < MAX_TRACKED_VALIDATION_SESSIONS; index += 1) {
			const sessionID = `session-${index}`;
			expect(
				scheduleFindingValidation(
					sessionID,
					() =>
						new Promise((resolve) => {
							resolvers.push(() =>
								resolve({
									complete: true,
									candidates: [],
									validations: [],
									attempts: [],
								}),
							);
						}),
					() => completed.push(sessionID),
				),
			).toBe(true);
		}

		expect(
			scheduleFindingValidation(
				'overflow',
				async () => ({
					complete: true,
					candidates: [],
					validations: [],
					attempts: [],
				}),
				() => completed.push('overflow'),
			),
		).toBe(false);
		expect(
			scheduleFindingValidation(
				'session-0',
				async () => ({
					complete: true,
					candidates: [],
					validations: [],
					attempts: [],
				}),
				() => completed.push('duplicate'),
			),
		).toBe(false);

		for (const resolve of resolvers) resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(completed).toHaveLength(MAX_TRACKED_VALIDATION_SESSIONS);
		expect(
			scheduleFindingValidation(
				'after-capacity',
				async () => ({
					complete: true,
					candidates: [],
					validations: [],
					attempts: [],
				}),
				() => completed.push('after-capacity'),
			),
		).toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(completed).toContain('after-capacity');
	});

	test('one saturated scheduler cannot consume another instance capacity', () => {
		const saturated = createFindingValidationScheduler();
		const independent = createFindingValidationScheduler();
		const neverCompletes = () => new Promise<FindingValidationResult>(() => {});
		for (let index = 0; index < MAX_TRACKED_VALIDATION_SESSIONS; index += 1) {
			expect(
				saturated.schedule(`occupied-${index}`, neverCompletes, () => {}),
			).toBe(true);
		}

		// Previous module-global capacity rejected this independent plugin's work.
		expect(saturated.pendingCount).toBe(MAX_TRACKED_VALIDATION_SESSIONS);
		expect(
			independent.schedule('same-host-other-plugin', neverCompletes, () => {}),
		).toBe(true);
		expect(independent.pendingCount).toBe(1);
		saturated.reset();
		independent.reset();
	});

	test('deduplicates concurrent validation for the same session', async () => {
		let resolveFirst!: () => void;
		let runs = 0;
		const first = scheduleFindingValidation(
			'session-shared',
			() => {
				runs += 1;
				return new Promise((resolve) => {
					resolveFirst = () =>
						resolve({
							complete: true,
							candidates: [],
							validations: [],
							attempts: [],
						});
				});
			},
			() => {},
		);
		const duplicate = scheduleFindingValidation(
			'session-shared',
			async () => {
				runs += 1;
				return {
					complete: true,
					candidates: [],
					validations: [],
					attempts: [],
				};
			},
			() => {},
		);

		expect(first).toBe(true);
		expect(duplicate).toBe(false);
		expect(runs).toBe(1);
		resolveFirst();
		await Promise.resolve();
		await Promise.resolve();
	});

	describe('scheduler rejection containment — regression F-final-review', () => {
		test('reports a rejected validation run and releases the session slot', async () => {
			// Previous code attached only then/finally, so a rejected run became an
			// unhandled fire-and-forget rejection with no durable caller callback.
			let reportError!: (error: unknown) => void;
			const errorReported = new Promise<unknown>((resolve) => {
				reportError = resolve;
			});
			expect(
				scheduleFindingValidation(
					'rejected-run',
					async () => {
						throw new Error('validator transport failed');
					},
					() => {},
					reportError,
				),
			).toBe(true);
			expect(await errorReported).toBeInstanceOf(Error);
			let rescheduled = false;
			for (let attempt = 0; attempt < 10 && !rescheduled; attempt += 1) {
				await Promise.resolve();
				rescheduled = scheduleFindingValidation(
					'rejected-run',
					async () => ({
						complete: true,
						candidates: [],
						validations: [],
						attempts: [],
					}),
					() => {},
				);
			}
			expect(rescheduled).toBe(true);
		});

		test('contains rejected completion and error callbacks', async () => {
			// Previous code let a throwing onComplete callback reject the stored
			// promise. The scheduler must consume both callback failure layers.
			let errorObserved!: () => void;
			const observed = new Promise<void>((resolve) => {
				errorObserved = resolve;
			});
			expect(
				scheduleFindingValidation(
					'rejected-callback',
					async () => ({
						complete: true,
						candidates: [],
						validations: [],
						attempts: [],
					}),
					async () => {
						throw new Error('completion callback failed');
					},
					async () => {
						errorObserved();
						throw new Error('error callback also failed');
					},
				),
			).toBe(true);
			await observed;
			let rescheduled = false;
			for (let attempt = 0; attempt < 10 && !rescheduled; attempt += 1) {
				await Promise.resolve();
				rescheduled = scheduleFindingValidation(
					'rejected-callback',
					async () => ({
						complete: true,
						candidates: [],
						validations: [],
						attempts: [],
					}),
					() => {},
				);
			}
			expect(rescheduled).toBe(true);
		});
	});
});
