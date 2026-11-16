/**
 * Issue #3320 AC3 — v2 plan/build sessions must NOT receive architect-only
 * message directives (registered-host journey).
 *
 * The defect: `onV2ContextEvent` seeds identity from `event.agent`
 * (`{ id: 'plan' }` / `{ id: 'build' }`) but the v1 views built by
 * `toV1MessageView` DROP `info.agent`. Downstream stages key ONLY on
 * `info.agent`:
 *   - src/hooks/pipeline-tracker.ts (~line 122): `const agent =
 *     lastUserMessage.info?.agent; if (agent && agent !== 'architect')
 *     return;` — an absent agent is treated as the architect main session and
 *     the `<swarm_reminder> ... ARCHITECT WORKFLOW REMINDER ...` text is
 *     prepended to the user message.
 *   - src/hooks/delegation-gate.ts messagesTransform (~line 7511): the same
 *     absent-agent pass-through injects the `[NEXT] Begin the first plan task
 *     and run gates sequentially.` guidance carrier, which onV2ContextEvent
 *     re-homes into `event.system`.
 *
 * This boots the REAL plugin (bootSwarmPluginHost) and drives the v2 context
 * event with `.swarm/plan.json` seeded on disk so plan-gated stages see an
 * active Phase 1.
 *
 * RED at base, GREEN after the fix: at base the plan/build sessions receive
 * BOTH the ARCHITECT WORKFLOW REMINDER in the user message and the [NEXT]
 * directive in the re-homed system text; after the fix both injections are
 * suppressed for non-architect native agents.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../src/config/plan-schema';
import { onV2ContextEvent } from '../../src/host/v2/guidance';
import { resetSwarmState } from '../../src/state';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env';
import {
	type BootedPluginHost,
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../helpers/plugin-host';
import { removeTreeWithRetry } from '../helpers/tmpdir';

/** Schema-valid minimal plan with one in-progress phase and one task 1.1. */
function fixturePlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Native agent identity fixture',
		swarm: 'fixture-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						description: 'Fixture task 1.1',
						status: 'pending',
						size: 'small',
						depends: [],
						files_touched: ['src/feature.ts'],
					},
				],
			},
		],
	};
}

interface JourneyResult {
	/** All text parts of the surviving (non-carrier) v2 messages. */
	messageText: string;
	/** All text parts re-homed into / appended to event.system. */
	systemText: string;
}

async function driveContextEvent(
	host: BootedPluginHost,
	agentId: string,
	sessionID: string,
): Promise<JourneyResult> {
	const event = {
		sessionID,
		agent: { id: agentId },
		system: [],
		messages: [
			{
				id: `msg-${sessionID}`,
				role: 'user',
				content: [{ type: 'text', text: 'hello' }],
			},
		],
		model: undefined,
	};
	await onV2ContextEvent(event as never, host.hooks as never, host.directory);
	const messageText = (event.messages ?? [])
		.flatMap((message) => message.content ?? [])
		.filter((part) => part && part.type === 'text')
		.map((part) => part.text ?? '')
		.join('\n');
	const systemText = (event.system ?? [])
		.map((part) => (typeof part?.text === 'string' ? part.text : ''))
		.join('\n');
	return { messageText, systemText };
}

const isolated = createIsolatedTestEnv();
const directory = createPluginHostProject('native-agent-v2-directives-');
let booted: BootedPluginHost | undefined;

afterAll(() => {
	try {
		resetSwarmState();
	} catch {
		// Advisory process state — cleanup must not fail the suite.
	}
	try {
		removeTreeWithRetry(directory);
	} finally {
		isolated.cleanup();
	}
});

describe('issue #3320 AC3 — native plan/build agents get no architect directives on v2', () => {
	test('RED at base, GREEN after the fix — a plan-agent context event carries no ARCHITECT WORKFLOW REMINDER and no [NEXT] directive', async () => {
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(fixturePlan(), null, 2),
		);
		booted ??= await bootSwarmPluginHost(directory, { version_check: false });

		const result = await driveContextEvent(
			booted,
			'plan',
			'v2-directives-plan-session',
		);

		// Base defect: pipeline-tracker sees info.agent === undefined (the view
		// drops it) and injects `<swarm_reminder> ... ARCHITECT WORKFLOW
		// REMINDER (Phase 1) ...` into the last user message.
		expect(result.messageText).not.toContain('ARCHITECT WORKFLOW REMINDER');
		// Base defect: delegation-gate messagesTransform sees the same absent
		// agent, injects the `[NEXT] Begin the first plan task ...` guidance
		// carrier, and onV2ContextEvent re-homes it into event.system.
		expect(result.systemText).not.toContain('[NEXT] Begin the first plan task');
	});

	test('RED at base, GREEN after the fix — a build-agent context event carries no ARCHITECT WORKFLOW REMINDER and no [NEXT] directive', async () => {
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(fixturePlan(), null, 2),
		);
		booted ??= await bootSwarmPluginHost(directory, { version_check: false });

		const result = await driveContextEvent(
			booted,
			'build',
			'v2-directives-build-session',
		);

		expect(result.messageText).not.toContain('ARCHITECT WORKFLOW REMINDER');
		expect(result.systemText).not.toContain('[NEXT] Begin the first plan task');
	});
});
