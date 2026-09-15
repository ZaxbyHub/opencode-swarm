import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	isGuidanceCarrier,
	isRenderableGuidance,
	messageTextOf,
} from '../../../src/hooks/system-guidance-carrier';
import { resetSwarmState, swarmState } from '../../../src/state';
import {
	type HostPartsMessage,
	hostToModelMessages,
	renderedText,
} from '../../helpers/host-contract-v1_18_3';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../../helpers/plugin-host';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import {
	createRetroBundle,
	createSwarmFiles,
} from '../../helpers/system-enhancer-test-helpers';

const HOST_CONFIG = {
	version_check: false,
	context_budget: { scoring: { enabled: false } },
	knowledge: { enabled: false, hive_enabled: false },
	memory: { enabled: false },
	hooks: { delegation_gate: false, system_enhancer: true },
};
const BASE_SYSTEM = 'Stable architect system prefix';
const SESSION_ID = 'evidence-mega-architect-session';

describe('System Enhancer — architect evidence guidance host delivery', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createPluginHostProject('swarm-evidence-architect-');
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
		safeRmRecursive(tempDir);
	});

	it('delivers the full mega_architect retrospective through the user-role carrier', async () => {
		await createSwarmFiles(tempDir, 2);
		await createRetroBundle(
			tempDir,
			1,
			'pass',
			['lesson A', 'lesson B'],
			['reason X'],
			'Phase 1 completed successfully.',
		);
		swarmState.activeAgent.set(SESSION_ID, 'mega_architect');
		const host = await bootSwarmPluginHost(tempDir, HOST_CONFIG);
		const messages: HostPartsMessage[] = [
			{
				info: {
					id: 'evidence-mega-architect-user',
					role: 'user',
					agent: 'mega_architect',
					sessionID: SESSION_ID,
				},
				parts: [{ type: 'text', text: 'Continue the active plan.' }],
			},
		];
		await host.hooks['experimental.chat.messages.transform']({}, { messages });
		const system = [BASE_SYSTEM];
		await host.hooks['experimental.chat.system.transform'](
			{ sessionID: SESSION_ID },
			{ system },
		);

		expect(system).toEqual([BASE_SYSTEM]);
		const carrier = messages.find(
			(message) =>
				isGuidanceCarrier(message) &&
				message.info.id === 'swarm-guidance:architect-session',
		);
		expect(carrier).toBeDefined();
		expect(isRenderableGuidance(carrier)).toBe(true);
		expect(carrier?.info.role).toBe('user');
		const guidanceText = messageTextOf(carrier);
		expect(renderedText(hostToModelMessages(messages))).toContain(guidanceText);

		expect(guidanceText).toContain('## Previous Phase Retrospective');
		expect(guidanceText).toContain('Outcome:');
		expect(guidanceText).toContain('Rejection reasons:');
		expect(guidanceText).toContain('Lessons learned:');
		expect(guidanceText).not.toContain('[SWARM RETROSPECTIVE]');
	});
});
