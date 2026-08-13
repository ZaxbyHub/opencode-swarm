import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_SKILL_OPT_CONFIG } from '../../../src/config/schema.js';
import {
	_internals as controllerInternals,
	runOptimizationRound,
	writeConvergenceState,
} from '../../../src/services/skill-optimizer/controller.js';
import { currentCandidateState } from '../../../src/services/skill-optimizer/lifecycle.js';
import {
	appendEvent,
	quarantineSuffix,
	replayCandidate,
	_internals as storeInternals,
	writeArtifact,
	writeStateProjection,
} from '../../../src/services/skill-optimizer/store.js';
import { withSafeTestDir } from '../../helpers/safe-test-dir.js';

const originalTryAcquireLock = controllerInternals.tryAcquireLock;
const originalWithEvidenceLock = storeInternals.withEvidenceLock;

afterEach(() => {
	controllerInternals.tryAcquireLock = originalTryAcquireLock;
	storeInternals.withEvidenceLock = originalWithEvidenceLock;
});

function createOuterProject(base: string): string {
	const outer = path.join(base, 'outer');
	fs.mkdirSync(path.join(outer, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(outer, '.git'));
	return outer;
}

function createNested(
	outer: string,
	name: string,
	boundary?: 'git-file' | 'opencode-dir',
): string {
	const nested = path.join(outer, name);
	fs.mkdirSync(nested, { recursive: true });
	if (boundary === 'git-file') {
		fs.writeFileSync(path.join(nested, '.git'), 'gitdir: ../metadata\n');
	} else if (boundary === 'opencode-dir') {
		fs.mkdirSync(path.join(nested, '.opencode'));
	}
	return nested;
}

function snapshotTree(root: string): string[] {
	const entries: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of fs
			.readdirSync(directory, { withFileTypes: true })
			.sort((left, right) => left.name.localeCompare(right.name))) {
			const absolute = path.join(directory, entry.name);
			const relative = path.relative(root, absolute);
			if (entry.isDirectory()) {
				entries.push(`dir:${relative}`);
				visit(absolute);
			} else {
				entries.push(
					`file:${relative}:${fs.readFileSync(absolute).toString('base64')}`,
				);
			}
		}
	};
	visit(root);
	return entries;
}

async function expectRejectedWithoutMutation(
	directory: string,
	action: () => unknown | Promise<unknown>,
): Promise<number> {
	const before = snapshotTree(directory);
	let rejection: unknown;
	try {
		await action();
	} catch (error) {
		rejection = error;
	}
	expect(rejection).toBeInstanceOf(Error);
	expect((rejection as Error).message).toContain('parent directory');
	expect(snapshotTree(directory)).toEqual(before);
	return 1;
}

function roundInput(directory: string) {
	return {
		directory,
		skillSlug: 'boundary-skill',
		config: { ...DEFAULT_SKILL_OPT_CONFIG },
		models: ['configured'],
		validationTasks: [],
		baselineModel: 'configured',
		candidateModel: 'configured',
		origin: 'command:skill-opt:plan' as const,
		dryRun: true,
	};
}

function eventInput(candidateId: string) {
	return {
		candidateId,
		skillSlug: 'boundary-skill',
		eventType: 'discover',
		fromState: null,
		toState: 'discovered' as const,
		actor: 'containment-test',
		origin: 'containment-test',
		contentHashBefore: null,
		contentHashAfter: null,
		reason: 'exercise direct mutation sink',
		evidenceRefs: [],
	};
}

describe('nested project boundaries — skill optimizer sinks', () => {
	test('rejects every ordinary-descendant mutation before changing state', async () => {
		await withSafeTestDir(async (base) => {
			const outer = createOuterProject(base);
			let rejected = 0;

			const controllerTarget = createNested(outer, 'controller-target');
			let controllerLockAttempts = 0;
			controllerInternals.tryAcquireLock = async () => {
				controllerLockAttempts += 1;
				return { acquired: false };
			};
			rejected += await expectRejectedWithoutMutation(controllerTarget, () =>
				runOptimizationRound(roundInput(controllerTarget)),
			);
			expect(controllerLockAttempts).toBe(0);

			const appendTarget = createNested(outer, 'append-target');
			let appendLockCallbacks = 0;
			storeInternals.withEvidenceLock = ((...args: unknown[]) => {
				appendLockCallbacks += 1;
				return (args[4] as () => Promise<unknown>)();
			}) as typeof storeInternals.withEvidenceLock;
			rejected += await expectRejectedWithoutMutation(appendTarget, () =>
				appendEvent(appendTarget, eventInput('candidate-append')),
			);
			expect(appendLockCallbacks).toBe(0);
			storeInternals.withEvidenceLock = originalWithEvidenceLock;

			const quarantineTarget = createNested(outer, 'quarantine-target');
			rejected += await expectRejectedWithoutMutation(quarantineTarget, () =>
				quarantineSuffix(quarantineTarget, 'boundary-skill', '{broken'),
			);

			const statusTarget = createNested(outer, 'status-target');
			const statusLedgerDir = path.join(
				statusTarget,
				'.swarm',
				'evolution',
				'skills',
				'boundary-skill',
				'candidate-status',
			);
			fs.mkdirSync(statusLedgerDir, { recursive: true });
			fs.writeFileSync(
				path.join(statusLedgerDir, 'lifecycle.jsonl'),
				'{broken',
			);
			rejected += await expectRejectedWithoutMutation(statusTarget, () =>
				currentCandidateState(
					statusTarget,
					'boundary-skill',
					'candidate-status',
				),
			);

			const projectionTarget = createNested(outer, 'projection-target');
			rejected += await expectRejectedWithoutMutation(projectionTarget, () =>
				writeStateProjection(
					projectionTarget,
					'boundary-skill',
					'candidate-projection',
					{
						events: [],
						state: null,
						truncated: false,
						badSuffix: null,
						lastCompleteSeq: 0,
					},
				),
			);

			const artifactTarget = createNested(outer, 'artifact-target');
			rejected += await expectRejectedWithoutMutation(artifactTarget, () =>
				writeArtifact(
					artifactTarget,
					'boundary-skill',
					'candidate-artifact',
					'baseline.md',
					'baseline\n',
				),
			);

			const convergenceTarget = createNested(outer, 'convergence-target');
			rejected += await expectRejectedWithoutMutation(convergenceTarget, () =>
				writeConvergenceState(convergenceTarget, 1),
			);

			// Every asserted path would otherwise create a lock, ledger side file,
			// projection, artifact, or convergence file. A non-zero exact count keeps
			// this behavioral rather than a wiring-only assertion.
			expect(rejected).toBe(7);
		});
	});

	test('allows direct .git-file and .opencode nested roots', async () => {
		await withSafeTestDir(async (base) => {
			const outer = createOuterProject(base);
			let completed = 0;
			let controllerLockAttempts = 0;
			controllerInternals.tryAcquireLock = async () => {
				controllerLockAttempts += 1;
				return { acquired: false };
			};

			for (const [name, boundary] of [
				['git-root', 'git-file'],
				['opencode-root', 'opencode-dir'],
			] as const) {
				const root = createNested(outer, name, boundary);
				const candidateId = `candidate-${name}`;

				const round = await runOptimizationRound(roundInput(root));
				expect(round.stopReason).toBe('project-run-locked');
				completed += 1;

				await appendEvent(root, eventInput(candidateId));
				completed += 1;
				const replay = replayCandidate(root, 'boundary-skill', candidateId);
				writeStateProjection(root, 'boundary-skill', candidateId, replay);
				completed += 1;
				expect(
					writeArtifact(
						root,
						'boundary-skill',
						candidateId,
						'baseline.md',
						'baseline\n',
					),
				).toContain('baseline.md');
				completed += 1;
				expect(quarantineSuffix(root, 'boundary-skill', '{broken')).toContain(
					'lifecycle-quarantine',
				);
				completed += 1;
				writeConvergenceState(root, 2);
				completed += 1;

				expect(
					fs.existsSync(
						path.join(
							root,
							'.swarm',
							'evolution',
							'skills',
							'boundary-skill',
							candidateId,
							'state.json',
						),
					),
				).toBe(true);
				expect(
					fs.existsSync(
						path.join(
							root,
							'.swarm',
							'evolution',
							'skills',
							'.convergence.json',
						),
					),
				).toBe(true);
			}

			expect(controllerLockAttempts).toBe(2);
			expect(completed).toBe(12);
		});
	});
});
