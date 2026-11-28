/**
 * The skill_propagation_inline trace pin, split out of
 * skill-propagation-gate.test.ts (FR-006 ratchet: the parent file is far over
 * the 500-line cap and must not grow).
 *
 * A present SKILLS value that validated zero file references — the
 * inline-body recovery path, or a bare/free-text value with no path
 * authority — records a bounded skill_propagation_inline trace event
 * (skills_field: 'inline_or_non_file', inline_recovery: true) instead of
 * leaving no trace at all, while the propagation warn stays reserved for the
 * omitted/none shapes (the two cases need different operator responses).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import {
	_internals,
	skillPropagationGateBefore,
} from '../../../src/hooks/skill-propagation-gate';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

type Internals = typeof _internals;
type Override<T> = {
	[P in keyof T]?: T[P];
};

function applyOverrides(
	internals: Internals,
	overrides: Override<Internals>,
): void {
	for (const [k, v] of Object.entries(overrides)) {
		(internals as Record<string, unknown>)[k] = v;
	}
}

function restoreOverrides(
	internals: Internals,
	originals: Override<Internals>,
): void {
	for (const k of Object.keys(originals) as (keyof Internals)[]) {
		(internals as Record<string, unknown>)[k] = originals[k];
	}
}

describe('skillPropagationGateBefore — inline-body trace', () => {
	let tmp: string;
	let originals: Override<Internals>;

	beforeEach(() => {
		tmp = canonicalMkdtemp('skill-inline-trace-');
		originals = {
			parseDelegationArgs: _internals.parseDelegationArgs,
			discoverAvailableSkills: _internals.discoverAvailableSkills,
			extractFileSkillReferences: _internals.extractFileSkillReferences,
			validateSkillReference: _internals.validateSkillReference,
			writeWarnEvent: _internals.writeWarnEvent,
		};
	});

	afterEach(() => {
		restoreOverrides(_internals, originals);
		try {
			fs.rmSync(tmp, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	async function runGate(input: {
		tool?: string;
		agent?: string;
		sessionID?: string;
		args?: unknown;
	}): Promise<{ blocked: boolean; reason: string | null }> {
		return skillPropagationGateBefore(
			tmp,
			{
				tool: input.tool,
				agent: input.agent,
				sessionID: input.sessionID,
				args: input.args,
			} as {
				tool: unknown;
				agent?: unknown;
				sessionID?: unknown;
				args?: unknown;
			},
			{ enabled: true },
		);
	}

	test('records the inline trace when a present SKILLS value carries no file references', async () => {
		const warnEventWritten: Array<Record<string, unknown>> = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'inline skill body text',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			// The parent suite's module-level default: a discovered skill path
			// always validates, so availableSkills is non-empty and the
			// propagation-warning/inline-trace block is reached.
			validateSkillReference: (_d: string, reference: string) => ({
				valid: true,
				reason: null,
				skillPath: reference.replace(/^file:/, ''),
			}),
			// The inline-body shape: nothing file-reference-shaped to extract.
			extractFileSkillReferences: () => [],
			writeWarnEvent: (_d: string, r: Record<string, unknown>) =>
				warnEventWritten.push(r),
		});

		await runGate({
			tool: 'task',
			agent: 'architect',
			args: {
				subagent_type: 'mega_coder',
				prompt: 'SKILLS: inline skill body text\ndo work',
			},
		});

		// Not blocked, no propagation warn (the field is present) — but the
		// distinguishable inline trace records the recovery path.
		expect(
			warnEventWritten.filter(
				(event) => event.type === 'skill_propagation_warn',
			),
		).toHaveLength(0);
		expect(
			warnEventWritten.filter(
				(event) => event.type === 'skill_propagation_inline',
			),
		).toHaveLength(1);
		expect(warnEventWritten[0]).toMatchObject({
			type: 'skill_propagation_inline',
			target_agent: 'coder',
			skills_field: 'inline_or_non_file',
			inline_recovery: true,
		});
	});

	test('warns with skills_field none when SKILLS is explicitly none and skills exist', async () => {
		const warnEventWritten: Array<Record<string, unknown>> = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'none',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			validateSkillReference: (_d: string, reference: string) => ({
				valid: true,
				reason: null,
				skillPath: reference.replace(/^file:/, ''),
			}),
			writeWarnEvent: (_d: string, r: Record<string, unknown>) =>
				warnEventWritten.push(r),
		});

		await runGate({
			tool: 'task',
			agent: 'architect',
			args: {
				subagent_type: 'mega_coder',
				prompt: 'SKILLS: none\ndo work',
			},
		});

		expect(warnEventWritten).toHaveLength(1);
		expect(warnEventWritten[0]).toMatchObject({
			type: 'skill_propagation_warn',
			target_agent: 'coder',
			skills_missing: true,
			skills_field: 'none',
		});
	});

	test('warns with skills_field omitted when the SKILLS field is missing and skills exist', async () => {
		const warnEventWritten: Array<Record<string, unknown>> = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({ targetAgent: 'coder', skillsField: '' }),
			discoverAvailableSkills: () => [
				'.claude/skills/foo/SKILL.md',
				'.claude/skills/bar/SKILL.md',
			],
			validateSkillReference: (_d: string, reference: string) => ({
				valid: true,
				reason: null,
				skillPath: reference.replace(/^file:/, ''),
			}),
			writeWarnEvent: (_d: string, r: Record<string, unknown>) =>
				warnEventWritten.push(r),
		});

		await runGate({
			tool: 'task',
			agent: 'architect',
			args: {
				subagent_type: 'mega_coder',
				prompt: 'do work without SKILLS',
			},
		});

		expect(warnEventWritten).toHaveLength(1);
		expect(warnEventWritten[0]).toMatchObject({
			type: 'skill_propagation_warn',
			target_agent: 'coder',
			skills_missing: true,
			skills_field: 'omitted',
			available_skills: [
				'.claude/skills/foo/SKILL.md',
				'.claude/skills/bar/SKILL.md',
			],
		});
	});
});
