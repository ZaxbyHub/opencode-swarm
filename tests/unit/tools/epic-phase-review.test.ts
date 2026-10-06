/**
 * epic_phase_review tool — registration reachability + execute contract.
 *
 * Removing any registration line (metadata, manifest, barrel, plugin-object
 * override with the injected review dispatcher) fails this file. The
 * end-to-end case drives the REAL plugin tool object with a fake
 * ReviewModelDispatcher to prove the dispatcher is actually injected.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	AGENT_TOOL_MAP,
	EPIC_AGENT_TOOL_MAP,
} from '../../../src/config/constants';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import type {
	ReviewDispatchRequest,
	ReviewModelDispatcher,
} from '../../../src/review/contracts';
import {
	_internals,
	epic_phase_review,
	executeEpicPhaseReview,
} from '../../../src/tools/epic-phase-review';
import * as toolIndex from '../../../src/tools/index';
import { TOOL_MANIFEST } from '../../../src/tools/manifest';
import { buildPluginToolObject } from '../../../src/tools/plugin-registration';
import { TOOL_METADATA, TOOL_NAME_SET } from '../../../src/tools/tool-metadata';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalInternals = { ..._internals };

describe('epic_phase_review registration', () => {
	test('metadata and derived name set include the tool; the architect gets it only via the Epic opt-in map', () => {
		expect(TOOL_METADATA.epic_phase_review.description).toContain(
			'epic-phase-review.json',
		);
		expect(TOOL_METADATA.epic_phase_review.agents).toEqual([]);
		expect(TOOL_NAME_SET.has('epic_phase_review')).toBe(true);
		expect(AGENT_TOOL_MAP.architect).not.toContain('epic_phase_review');
		expect(EPIC_AGENT_TOOL_MAP.architect).toContain('epic_phase_review');
	});

	test('manifest thunk and barrel export resolve to executable tools', () => {
		expect(typeof TOOL_MANIFEST.epic_phase_review().execute).toBe('function');
		expect((toolIndex as Record<string, unknown>).epic_phase_review).toBe(
			epic_phase_review,
		);
	});

	test('the tool accepts only a phase — no verdict argument can be supplied', () => {
		expect(Object.keys(epic_phase_review.args).sort()).toEqual(['phase']);
	});
});

describe('executeEpicPhaseReview', () => {
	let dir: string;

	beforeEach(() => {
		dir = canonicalMkdtemp('epic-phase-review-tool-');
		fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Tool Plan',
				swarm: 'mega',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{ id: '1.1', phase: 1, status: 'completed', description: 'T' },
						],
					},
				],
			}),
		);
	});

	afterEach(() => {
		Object.assign(_internals, originalInternals);
		closeAllProjectDbs();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	test('refuses when Epic Mode is not active for the project', async () => {
		_internals.isEpicOpenForProject = () => false;
		let dispatched = false;
		_internals.runEpicPhaseReview = async () => {
			dispatched = true;
			throw new Error('must not run');
		};
		expect(await executeEpicPhaseReview({ phase: 1 }, dir, 's')).toMatchObject({
			success: false,
			reason: 'epic-mode-not-active',
		});
		expect(dispatched).toBe(false);
	});

	test('refuses without a session or with an invalid phase', async () => {
		_internals.isEpicOpenForProject = () => true;
		expect(
			await executeEpicPhaseReview({ phase: 1 }, dir, undefined),
		).toMatchObject({ success: false, reason: 'no-session' });
		expect(await executeEpicPhaseReview({ phase: 0 }, dir, 's')).toMatchObject({
			success: false,
			reason: 'invalid-phase',
		});
	});

	test('plugin tool object injects the review dispatcher end to end', async () => {
		_internals.isEpicOpenForProject = () => true;
		const calls: ReviewDispatchRequest[] = [];
		const dispatcher: ReviewModelDispatcher = {
			dispatch: async (request) => {
				calls.push(request);
				return {
					status: 'completed',
					agentName: request.agentName,
					text: 'VERDICT: APPROVED\nREASON: fine',
					durationMs: 1,
					promptBytes: 0,
					responseBytes: 0,
				};
			},
		};
		const tools = buildPluginToolObject({}, undefined, undefined, dispatcher, [
			'architect',
			'reviewer',
			'critic',
		]);
		const raw = await tools.epic_phase_review.execute({ phase: 1 }, {
			directory: dir,
			sessionID: 'arch-1',
			agent: 'architect',
		} as never);
		const result = JSON.parse(String(raw));
		expect(result).toMatchObject({ success: true, ready: true, phase: 1 });
		expect(calls.map((call) => call.agentName)).toEqual(['reviewer', 'critic']);
		const stored = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', 'evidence', '1', 'epic-phase-review.json'),
				'utf-8',
			),
		);
		expect(stored.parent_session_id).toBe('arch-1');
	});

	test('the static (non-injected) tool reports the dispatcher as unavailable', async () => {
		_internals.isEpicOpenForProject = () => true;
		const raw = await epic_phase_review.execute({ phase: 1 }, {
			directory: dir,
			sessionID: 'arch-1',
		} as never);
		expect(JSON.parse(String(raw))).toMatchObject({
			success: false,
			reason: 'dispatcher-unavailable',
		});
	});
});
