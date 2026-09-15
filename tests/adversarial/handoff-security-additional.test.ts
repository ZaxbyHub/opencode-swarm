/**
 * Additional handoff edge cases.
 *
 * These cases intentionally drive the registered messages.transform chain so
 * security assertions observe the host-visible user-role carrier, not the
 * internal system-enhancer staging surface.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../src/config';
import {
	isGuidanceCarrier,
	messageTextOf,
} from '../../src/hooks/system-guidance-carrier';
import { resetSwarmState, swarmState } from '../../src/state';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../helpers/plugin-host';
import { safeRmRecursive } from '../helpers/safe-test-dir';

describe('SECURITY: Additional Handoff Attack Vectors', () => {
	let testDir: string;
	let swarmDir: string;
	let host: Awaited<ReturnType<typeof bootSwarmPluginHost>>;

	const config: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		context_budget: { scoring: { enabled: false } },
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_gate: false,
		},
	};

	beforeEach(async () => {
		testDir = createPluginHostProject('handoff-security-extra');
		swarmDir = path.join(testDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		host = await bootSwarmPluginHost(testDir, config);
		resetSwarmState();
		swarmState.activeAgent.set('test-session', 'architect');
	});

	afterEach(() => {
		if (testDir && fs.existsSync(testDir)) {
			try {
				safeRmRecursive(testDir);
			} catch {
				// Best-effort cleanup; registered host workers can briefly hold handles.
			}
		}
		resetSwarmState();
	});

	async function invokeRegisteredMessages() {
		const messages = [
			{
				info: {
					id: 'handoff-extra-user',
					role: 'user' as const,
					sessionID: 'test-session',
					agent: 'architect',
				},
				parts: [{ type: 'text', text: 'Continue the current swarm task.' }],
			},
		];
		await host.hooks['experimental.chat.messages.transform']({}, { messages });
		return messages;
	}

	function deliveredText(messages: Array<{ info: unknown; parts: unknown[] }>) {
		return messages
			.filter((message) => isGuidanceCarrier(message))
			.map((message) => messageTextOf(message as never))
			.join('\n');
	}

	function writePlan() {
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Test',
				swarm: 'test',
				current_phase: 1,
				phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
			}),
		);
	}

	it('handles empty handoff.md without forging a host-visible directive', async () => {
		fs.writeFileSync(path.join(swarmDir, 'handoff.md'), '');
		writePlan();

		const messages = await invokeRegisteredMessages();
		const carriers = messages.filter((message) => isGuidanceCarrier(message));

		// The registered chain may still deliver an architect command carrier, but
		// empty handoff content itself must not appear at the host boundary.
		expect(carriers.length).toBeGreaterThan(0);
		expect(
			carriers.some((message) =>
				messageTextOf(message as never).includes('[HANDOFF BRIEF]'),
			),
		).toBe(false);
	});

	it('wraps whitespace-only handoff content in one host-visible envelope', async () => {
		fs.writeFileSync(path.join(swarmDir, 'handoff.md'), '   \n\n   ');
		writePlan();

		const messages = await invokeRegisteredMessages();
		const handoffCarriers = messages.filter(
			(message) =>
				isGuidanceCarrier(message) &&
				messageTextOf(message as never).includes('[HANDOFF BRIEF]'),
		);
		expect(handoffCarriers).toHaveLength(1);
		expect(deliveredText(messages).match(/\[HANDOFF BRIEF\]/g)).toHaveLength(1);
	});

	it('sanitizes binary-looking handoff data and delivers its payload in a carrier', async () => {
		fs.writeFileSync(
			path.join(swarmDir, 'handoff.md'),
			Buffer.from('\x00\x01BINARY-HANDOFF-PAYLOAD\x02\xff\xfe', 'utf8'),
		);
		writePlan();

		const messages = await invokeRegisteredMessages();
		const handoffCarriers = messages.filter(
			(message) =>
				isGuidanceCarrier(message) &&
				messageTextOf(message as never).includes('BINARY-HANDOFF-PAYLOAD'),
		);
		const delivered = deliveredText(messages);

		// The host boundary must receive the handoff body in a user-role carrier;
		// a command carrier alone would make a vacuous positive assertion here.
		expect(handoffCarriers).toHaveLength(1);
		expect(delivered).toContain('[HANDOFF BRIEF]');
		expect(delivered).toContain('BINARY-HANDOFF-PAYLOAD');
		expect(delivered).not.toContain('\x00');
	});
});
