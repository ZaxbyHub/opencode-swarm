import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { ExecutionProfile, Plan } from '../../../src/config/plan-schema';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { resetSwarmState, swarmState } from '../../../src/state';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

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

function config(
	executionMode: 'balanced' | 'strict',
	scoring: boolean,
): PluginConfig {
	return {
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
	} as PluginConfig;
}

describe('system-enhancer planning-profile runtime injection', () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(
			join(canonicalTmpDir(), 'planning-profile-prompt-'),
		);
		resetSwarmState();
		resetStartupLedgerCheck();
		await mkdir(join(directory, '.swarm'), { recursive: true });
		await writeFile(join(directory, '.swarm', 'context.md'), '# Context\n');
	});

	afterEach(async () => {
		resetSwarmState();
		resetStartupLedgerCheck();
		await rm(directory, { recursive: true, force: true });
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

		const hook = createSystemEnhancerHook(
			config(executionMode, scoring),
			directory,
		);
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID: string },
			output: { system: string[] },
		) => Promise<void>;
		const output = { system: ['base'] };
		await transform({ sessionID: 'profile-session' }, output);
		return output.system.join('\n');
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
