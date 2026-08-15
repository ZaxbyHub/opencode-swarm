import { describe, expect, test } from 'bun:test';
import { createAgents } from '../../../src/agents';
import { createArchitectAgent } from '../../../src/agents/architect';
import type { PluginConfig } from '../../../src/config';
import type { ResolvedPlanningProfile } from '../../../src/plan/planning-profile';

function createPrompt(resolution: ResolvedPlanningProfile): string {
	return (
		createArchitectAgent(
			'test-model',
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			false,
			false,
			false,
			false,
			resolution,
		).config.prompt ?? ''
	);
}

describe('architect planning-profile prompt selection', () => {
	test('balanced runtime prompt skips the strict questionnaire ceremony', () => {
		const prompt = createPrompt({
			effective: 'balanced',
			persisted: 'balanced',
			source: 'persisted',
		});

		expect(prompt).toContain(
			'[PLANNING PROFILE DEFAULT — USE ONLY WHEN NO RUNTIME RESOLUTION EXISTS] effective=balanced source=persisted',
		);
		expect(prompt).toContain(
			'BALANCED ceremony: use durable QA and execution defaults without pausing for the full questionnaire',
		);
		expect(prompt).toContain('BALANCED does not pause for this questionnaire');
		expect(prompt).not.toContain(
			'QA AND EXECUTION PROFILE SELECTION -- the exact plan identity is frozen. You MUST ask now.',
		);
	});

	test('strict runtime prompt requires the full ceremony', () => {
		const prompt = createPrompt({
			effective: 'strict',
			persisted: 'strict',
			source: 'persisted',
		});

		expect(prompt).toContain(
			'[PLANNING PROFILE DEFAULT — USE ONLY WHEN NO RUNTIME RESOLUTION EXISTS] effective=strict source=persisted',
		);
		expect(prompt).toContain('STRICT ceremony: require an effective spec');
		expect(prompt).toContain(
			'STRICT-ONLY PAUSE: Present the gate question and wait',
		);
	});

	test('repository execution_mode is resolved into the generated architect prompt', () => {
		const balancedArchitect = createAgents({
			execution_mode: 'balanced',
		} as PluginConfig).find((agent) => agent.name === 'architect');
		const strictArchitect = createAgents({
			execution_mode: 'strict',
		} as PluginConfig).find((agent) => agent.name === 'architect');

		expect(balancedArchitect?.config.prompt).toContain(
			'effective=balanced source=repository_default',
		);
		expect(strictArchitect?.config.prompt).toContain(
			'effective=strict source=repository_default',
		);
	});

	test('custom prompts cannot omit the resolved planning profile', () => {
		const prompt =
			createArchitectAgent(
				'test-model',
				'Custom architect instructions.',
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				false,
				false,
				false,
				false,
				{
					effective: 'balanced',
					persisted: 'balanced',
					source: 'incoming',
				},
			).config.prompt ?? '';

		expect(prompt).toContain('Custom architect instructions.');
		expect(prompt).toContain('effective=balanced source=incoming');
	});

	test('architect never authorizes self-implementation after retry exhaustion', () => {
		const prompt = createPrompt({
			effective: 'strict',
			persisted: 'strict',
			source: 'incoming',
		});

		expect(prompt).toContain('Never implement source changes yourself');
		expect(prompt).toContain('Do not write the code yourself');
		expect(prompt).not.toContain('Only code yourself after');
		expect(prompt).not.toContain('before writing code yourself');
	});

	test('distinguishes empty failures from failed settlements that left mutations', () => {
		const prompt = createPrompt({
			effective: 'strict',
			persisted: 'strict',
			source: 'incoming',
		});

		expect(prompt).toContain(
			'An empty/no-mutation coder\n    settlement creates retry evidence but no reviewer debt',
		);
		expect(prompt).toContain(
			'A failed or cancelled\n    settlement that left a safely attributed mutation rotates the generation',
		);
		expect(prompt).toContain(
			'invalidates prior proof, and enters rework_required',
		);
	});
});
