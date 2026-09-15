import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionProfile, Plan } from '../../../src/config/plan-schema';
import {
	isGuidanceCarrier,
	isRenderableGuidance,
	messageTextOf,
} from '../../../src/hooks/system-guidance-carrier';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { resetSwarmState, swarmState } from '../../../src/state';
import type { HostPartsMessage } from '../../helpers/host-contract-v1_18_3';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../../helpers/plugin-host';
import { safeRmRecursive } from '../../helpers/safe-test-dir';

function executionProfile(
	planningProfile?: 'balanced' | 'strict',
	locked = true,
): ExecutionProfile {
	return {
		parallelization_enabled: true,
		max_concurrent_tasks: 2,
		council_parallel: false,
		locked,
		auto_proceed: false,
		commit_after_each_completed_task: false,
		...(planningProfile ? { planning_profile: planningProfile } : {}),
	};
}

function planWithProfile(profile: ExecutionProfile): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Planning Profile Runtime',
		swarm: 'test-swarm',
		current_phase: 1,
		execution_profile: profile,
		phases: [
			{
				id: 1,
				name: 'Planning',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Plan the work',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

describe('system-enhancer planning-profile runtime injection', () => {
	let directory: string;

	beforeEach(async () => {
		directory = createPluginHostProject('planning-profile-prompt-');
		resetSwarmState();
		resetStartupLedgerCheck();
		await mkdir(join(directory, '.swarm'), { recursive: true });
		await writeFile(join(directory, '.swarm', 'context.md'), '# Context\n');
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		try {
			safeRmRecursive(directory);
		} catch {
			// Best-effort cleanup; registered host workers can briefly hold handles.
		}
	});

	async function invoke(
		profile: ExecutionProfile,
		executionMode: 'balanced' | 'strict',
		scoring: boolean,
		agent = 'architect',
	): Promise<string> {
		const plan = planWithProfile(profile);
		await writeFile(
			join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
			'utf8',
		);
		await writeFile(
			join(directory, '.swarm', 'plan.md'),
			'# Planning Profile Runtime\n',
			'utf8',
		);
		swarmState.activeAgent.set('profile-session', agent);

		const host = await bootSwarmPluginHost(directory, {
			execution_mode: executionMode,
			hooks: {
				system_enhancer: true,
				agent_activity: false,
				compaction: false,
				delegation_tracker: false,
			},
			context_budget: {
				scoring: { enabled: scoring },
			},
		});
		const messages: HostPartsMessage[] = [
			{
				info: {
					id: 'planning-profile-user',
					role: 'user',
					agent,
					sessionID: 'profile-session',
				},
				parts: [{ type: 'text', text: 'Continue the active plan.' }],
			},
		];
		await host.hooks['experimental.chat.messages.transform']({}, { messages });
		const carrier = messages.find(
			(message) =>
				isGuidanceCarrier(message) &&
				isRenderableGuidance(message) &&
				messageTextOf(message).includes(
					'[PLANNING PROFILE — CURRENT RUNTIME AUTHORITY]',
				),
		);
		if (agent === 'architect') {
			expect(carrier).toBeDefined();
			expect(carrier?.info.role).toBe('user');
		} else {
			expect(carrier).toBeUndefined();
		}

		const system = ['base'];
		await host.hooks['experimental.chat.system.transform'](
			{ sessionID: 'profile-session' },
			{ system },
		);
		if (agent === 'architect') {
			expect(system[0]).toBe('base');
			expect(system.join('\n')).not.toContain(
				'[PLANNING PROFILE — CURRENT RUNTIME AUTHORITY]',
			);
		} else {
			expect(system[0]).toBe('base');
		}
		return carrier ? messageTextOf(carrier) : '';
	}

	for (const scoring of [false, true]) {
		test(`persisted strict overrides balanced repository default (scoring=${scoring})`, async () => {
			const prompt = await invoke(
				executionProfile('strict'),
				'balanced',
				scoring,
			);
			expect(prompt).toContain('effective=strict source=persisted');
			expect(prompt).toContain(
				'This runtime resolution supersedes any planning-profile default in the base prompt.',
			);
			expect(prompt).toContain('STRICT ceremony: require an effective spec');
		});

		test(`persisted balanced overrides strict repository default (scoring=${scoring})`, async () => {
			const prompt = await invoke(
				executionProfile('balanced'),
				'strict',
				scoring,
			);
			expect(prompt).toContain('effective=balanced source=persisted');
			expect(prompt).toContain('without pausing for the full questionnaire');
		});
	}

	test('locked legacy profile resolves strict without materializing a field', async () => {
		const prompt = await invoke(
			executionProfile(undefined, true),
			'balanced',
			false,
		);
		expect(prompt).toContain('effective=strict source=legacy_locked_default');
		expect(prompt).toContain('without materializing a new hash field');
	});

	test('planning directive is architect-only', async () => {
		const prompt = await invoke(
			executionProfile('strict'),
			'balanced',
			false,
			'coder',
		);
		expect(prompt).not.toContain(
			'[PLANNING PROFILE — CURRENT RUNTIME AUTHORITY]',
		);
	});
});
