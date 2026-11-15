/**
 * Shared harness for the #3177 lean-runner suites (FR-006 split): a real
 * `LeanTurboRunner.runPhase` drive on a single-lane phase with injected
 * session ops (`_sessionOps`, the #3162 fixtures convention — no
 * `mock.module`), the real plan loader/planner/locks/scoped selection, and a
 * production `createAgents`-seeded coder chain (primary `prov/primary`,
 * fallback `prov/fb1`).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgents } from '../../../../src/agents';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../../../src/config/constants';
import { closeAllProjectDbs } from '../../../../src/db/project-db';
import { resetScopedModelSelectionStateForTests } from '../../../../src/models/model-override-state';
import { clearScopeBindings } from '../../../../src/scope/scope-binding';
import { resetSwarmState, startAgentSession } from '../../../../src/state';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import * as leanState from '../../../../src/turbo/lean/state';

export const HARNESS_SESSION_ID = 'sess-runner-3177';
export const PRIMARY_MODEL = 'prov/primary';
export const FALLBACK_MODEL = 'prov/fb1';

/** One queued `session.prompt` answer: `null` = clean reply. */
export type PromptAnswer = { statusCode?: number; message: string } | null;

export interface Runner3177Harness {
	runner: LeanTurboRunner;
	directory: string;
	/** Model label per `session.prompt` call (undefined = primary default). */
	promptModels: Array<string | undefined>;
	/** Replace the queued prompt answers (e.g. between phases). */
	setResponses: (responses: PromptAnswer[]) => void;
	/**
	 * Build a SECOND runner sharing this harness's directory, session, and
	 * seeded agent chain WITHOUT resetting the scoped-selection store — the
	 * shape the lean-turbo-run-phase tool produces on a same-phase re-run in
	 * one process. Its prompt answers track into this sibling's own
	 * promptModels array.
	 */
	makeSiblingRunner: (responses: PromptAnswer[]) => {
		runner: LeanTurboRunner;
		promptModels: Array<string | undefined>;
	};
	cleanup: () => void;
}

function buildPlan(): Record<string, unknown> {
	const task = (
		id: string,
		phase: number,
		file: string,
	): Record<string, unknown> => ({
		id,
		description: `Task ${id}`,
		status: 'pending',
		phase,
		size: 'small',
		depends: [],
		acceptance: 'Done',
		files_touched: [file],
	});
	return {
		schema_version: '1.0.0',
		title: 'runner-3177 two-phase plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [task('1.1', 1, 'src/a.ts')],
			},
			{
				id: 2,
				name: 'Phase 2',
				status: 'pending',
				tasks: [task('2.1', 2, 'src/b.ts')],
			},
		],
	};
}

function modelLabel(model: unknown): string | undefined {
	if (model === undefined || model === null) return undefined;
	if (
		model &&
		typeof model === 'object' &&
		typeof (model as { providerID?: unknown }).providerID === 'string' &&
		typeof (model as { modelID?: unknown }).modelID === 'string'
	) {
		return `${(model as { providerID: string }).providerID}/${(model as { modelID: string }).modelID}`;
	}
	return JSON.stringify(model);
}

/**
 * Build the harness. `responses` queues one answer per `session.prompt`
 * call; calls past the queue answer clean. Follow-up phases (runPhase(2+))
 * reuse the same queue semantics.
 */
export function makeRunner3177Harness(
	responses: PromptAnswer[],
): Runner3177Harness {
	resetSwarmState();
	resetScopedModelSelectionStateForTests();
	clearScopeBindings();
	startAgentSession(HARNESS_SESSION_ID, 'architect');
	const directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'runner-3177-')),
	);
	fs.mkdirSync(path.join(directory, '.swarm', 'scopes'), { recursive: true });
	fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, 'src', 'a.ts'),
		'export const a = 1;\n',
	);
	fs.writeFileSync(
		path.join(directory, '.swarm', 'scopes', 'scope-1.1.json'),
		JSON.stringify({ files: ['src/a.ts'] }),
	);
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(buildPlan(), null, 2),
	);
	leanState.repairStateUnreadable(directory);
	// Seed the default swarm's coder chain through the production config path
	// (legacy single-swarm mode populates getSwarmAgents('default')).
	createAgents({
		agents: {
			coder: { model: PRIMARY_MODEL, fallback_models: [FALLBACK_MODEL] },
		},
	} as unknown as Parameters<typeof createAgents>[0]);

	const runner = new LeanTurboRunner({
		directory,
		sessionID: HARNESS_SESSION_ID,
		generatedAgentNames: ['coder'],
		leanConfig: {
			...DEFAULT_LEAN_TURBO_CONFIG,
			worktree_isolation: false,
			require_declared_scope: false,
		} as never,
	});

	const promptModels: Array<string | undefined> = [];
	const queue = [...responses];
	let sticky: PromptAnswer =
		responses.length > 0 ? responses[responses.length - 1] : null;
	(runner as unknown as { _sessionOps: unknown })._sessionOps = {
		create: async () => ({
			data: { id: `lane-child-${promptModels.length + 1}` },
			error: null,
		}),
		prompt: async (args: {
			body?: { model?: unknown };
		}): Promise<{
			data: {
				id: string;
				info: Record<string, unknown>;
				parts: Array<{ type: string; text: string }>;
			};
			error: null;
		}> => {
			promptModels.push(modelLabel(args?.body?.model));
			// Past the queue, the LAST queued answer repeats (a refusal stays a
			// refusal) unless it was an explicit clean answer.
			const answer = queue.length > 0 ? queue.shift()! : sticky;
			const id = `msg_${promptModels.length}`;
			if (answer === null) {
				return {
					data: { id, info: { id }, parts: [{ type: 'text', text: 'done' }] },
					error: null,
				};
			}
			return {
				data: {
					id,
					info: {
						id,
						error: {
							name: 'AI_APICallError',
							data: {
								...(answer.statusCode === undefined
									? {}
									: { statusCode: answer.statusCode }),
								message: answer.message,
							},
						},
					},
					parts: [{ type: 'text', text: '' }],
				},
				error: null,
			};
		},
		delete: async () => undefined,
	};

	const makeRunnerWithOps = (
		responses: PromptAnswer[],
		track: Array<string | undefined>,
	): LeanTurboRunner => {
		const r = new LeanTurboRunner({
			directory,
			sessionID: HARNESS_SESSION_ID,
			generatedAgentNames: ['coder'],
			leanConfig: {
				...DEFAULT_LEAN_TURBO_CONFIG,
				worktree_isolation: false,
				require_declared_scope: false,
			} as never,
		});
		const queue2 = [...responses];
		const sticky2: PromptAnswer =
			responses.length > 0 ? responses[responses.length - 1] : null;
		(r as unknown as { _sessionOps: unknown })._sessionOps = {
			create: async () => ({
				data: { id: `lane-child-${track.length + 1}` },
				error: null,
			}),
			prompt: async (args: {
				body?: { model?: unknown };
			}): Promise<{
				data: {
					id: string;
					info: Record<string, unknown>;
					parts: Array<{ type: string; text: string }>;
				};
				error: null;
			}> => {
				track.push(modelLabel(args?.body?.model));
				const answer = queue2.length > 0 ? queue2.shift()! : sticky2;
				const id = `msg_${track.length}`;
				if (answer === null) {
					return {
						data: { id, info: { id }, parts: [{ type: 'text', text: 'done' }] },
						error: null,
					};
				}
				return {
					data: {
						id,
						info: {
							id,
							error: {
								name: 'AI_APICallError',
								data: {
									...(answer.statusCode === undefined
										? {}
										: { statusCode: answer.statusCode }),
									message: answer.message,
								},
							},
						},
						parts: [{ type: 'text', text: '' }],
					},
					error: null,
				};
			},
			delete: async () => undefined,
		};
		return r;
	};

	return {
		runner,
		directory,
		promptModels,
		makeSiblingRunner: (responses: PromptAnswer[]) => {
			const siblingModels: Array<string | undefined> = [];
			const sibling = makeRunnerWithOps(responses, siblingModels);
			return { runner: sibling, promptModels: siblingModels };
		},
		setResponses: (next: PromptAnswer[]) => {
			queue.length = 0;
			queue.push(...next);
			sticky = next.length > 0 ? next[next.length - 1] : null;
		},
		cleanup: () => {
			resetScopedModelSelectionStateForTests();
			clearScopeBindings();
			resetSwarmState();
			leanState.repairStateUnreadable(directory);
			closeAllProjectDbs();
			try {
				fs.rmSync(directory, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		},
	};
}
