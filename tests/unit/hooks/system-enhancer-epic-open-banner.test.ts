/**
 * Epic v2: EPIC_MODE_BANNER delivery follows the project's OPEN epic
 * (sentinel-first `isEpicOpenForProject`), not a per-session flag.
 *
 * Driven through the REGISTERED plugin host (real system-enhancer hook):
 *  - no epic (config on or off) → no Epic banner (non-Epic guidance unchanged);
 *  - epic open (config on) → Epic banner delivered for any architect session;
 *  - epic open but the config gate closed → no Epic banner;
 *  - a Lean session while an epic is open → the Lean banner is suppressed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	_internals,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import { openEpicForTest } from '../../helpers/epic-lifecycle';
import {
	type HostPartsMessage,
	hostToModelMessages,
	renderedText,
} from '../../helpers/host-contract-v1_18_3';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../../helpers/plugin-host';

const SESSION_ID = 'sess-epic-open-banner';
const EPIC_HEADER = 'EPIC MODE ACTIVE';
const BASE_CONFIG = {
	version_check: false,
	knowledge: { enabled: false, hive_enabled: false },
	memory: { enabled: false },
	hooks: { delegation_gate: false, system_enhancer: true },
};
const EPIC_CONFIG = {
	...BASE_CONFIG,
	epic: { mode: { enabled: true } },
};

let tempDir: string;

beforeEach(() => {
	tempDir = createPluginHostProject('swarm-epic-open-banner-');
	resetSwarmState();
	startAgentSession(SESSION_ID, 'architect');
	const swarmDir = join(tempDir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	writeFileSync(
		join(swarmDir, 'plan.md'),
		'# Plan\n\n## Phase 1 [IN PROGRESS]\n\nTest phase.\n',
	);
	writeFileSync(
		join(swarmDir, 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Epic banner plan',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
		}),
	);
});

afterEach(() => {
	resetSwarmState();
	closeAllProjectDbs();
	try {
		rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup; registered host workers can briefly hold handles.
	}
});

async function renderedGuidance(
	config: Record<string, unknown>,
	openEpic: boolean,
): Promise<string> {
	const host = await bootSwarmPluginHost(tempDir, config);
	if (openEpic) openEpicForTest(tempDir);
	const messages: HostPartsMessage[] = [
		{
			info: {
				id: 'epic-banner-user',
				role: 'user',
				agent: 'architect',
				sessionID: SESSION_ID,
			},
			parts: [{ type: 'text', text: 'Continue the active plan.' }],
		},
	];
	await host.hooks['experimental.chat.messages.transform']({}, { messages });
	return renderedText(hostToModelMessages(messages));
}

describe('Epic banner delivery follows the open epic', () => {
	it('no epic (config off) → no Epic banner', async () => {
		const text = await renderedGuidance(BASE_CONFIG, false);
		expect(text).not.toContain(EPIC_HEADER);
	});

	it('no epic (config on) → no Epic banner', async () => {
		const text = await renderedGuidance(EPIC_CONFIG, false);
		expect(text).not.toContain(EPIC_HEADER);
	});

	it('epic open (config on) → Epic banner delivered', async () => {
		const text = await renderedGuidance(EPIC_CONFIG, true);
		expect(text).toContain(EPIC_HEADER);
		expect(text).toContain('THE USER ALWAYS COMES FIRST');
	});

	it('epic open but config gate closed → no Epic banner', async () => {
		const text = await renderedGuidance(BASE_CONFIG, true);
		expect(text).not.toContain(EPIC_HEADER);
	});

	it('Lean session while an epic is open → Lean banner suppressed', async () => {
		const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
		session.turboMode = true;
		session.turboStrategy = 'lean';
		session.leanTurboActive = true;
		const text = await renderedGuidance(EPIC_CONFIG, true);
		expect(text).toContain(EPIC_HEADER);
		expect(text).not.toContain('LEAN TURBO ACTIVE');
	});
});
