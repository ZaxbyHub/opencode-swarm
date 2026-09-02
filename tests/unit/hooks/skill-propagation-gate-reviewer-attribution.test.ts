import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/hooks/skill-propagation-gate';
import {
	appendSkillUsageEntry,
	readSkillUsageEntries,
} from '../../../src/hooks/skill-usage-log';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const realValidateSkillReference = _internals.validateSkillReference;
const realExtractFileSkillReferences = _internals.extractFileSkillReferences;
const directories: string[] = [];

beforeEach(() => {
	_internals.extractFileSkillReferences = (fieldValue) =>
		_internals.parseSkillPaths(fieldValue);
	_internals.validateSkillReference = (_directory, reference) => ({
		valid: true,
		reason: null,
		skillPath: reference.replace(/^file:/, ''),
	});
});

afterEach(() => {
	_internals.extractFileSkillReferences = realExtractFileSkillReferences;
	_internals.validateSkillReference = realValidateSkillReference;
	for (const directory of directories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

function makeDirectory(prefix: string): string {
	const directory = canonicalMkdtemp(prefix);
	directories.push(directory);
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	return directory;
}

function fixedTimestamp(): string {
	return withFrozenClock(() => new Date().toISOString(), {
		isoNow: '1970-01-01T00:00:00.000Z',
	});
}

function writePlan(directory: string, taskIds: string[]): void {
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Reviewer attribution plan',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: taskIds.map((id) => ({
						id,
						phase: 1,
						status: 'pending',
						size: 'small',
						description: `Task ${id}`,
						depends: [],
						files_touched: [],
					})),
				},
			],
		}),
	);
}

function seedSkillFiles(directory: string, skillPaths: string[]): void {
	for (const skillPath of skillPaths) {
		const absolutePath = path.join(directory, skillPath.replace('file:', ''));
		fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
		fs.writeFileSync(absolutePath, '# Skill\n');
	}
}

function seedDelegation(
	directory: string,
	sessionID: string,
	skillPath: string,
	taskID: string,
): void {
	appendSkillUsageEntry(directory, {
		skillPath,
		agentName: 'coder',
		taskID,
		complianceVerdict: 'not_checked',
		sessionID,
		timestamp: fixedTimestamp(),
	});
}

async function scanReviewer(
	directory: string,
	sessionID: string,
	reviewerText: string,
) {
	await _internals.skillPropagationTransformScan(
		directory,
		{
			messages: [
				{
					info: { role: 'assistant', agent: 'reviewer', sessionID },
					parts: [{ type: 'text', text: reviewerText }],
				},
			] as Parameters<
				typeof _internals.skillPropagationTransformScan
			>[1]['messages'],
		},
		sessionID,
	);
	return readSkillUsageEntries(directory, { sessionID }).filter(
		(entry) => entry.agentName === 'reviewer',
	);
}

describe('reviewer task attribution', () => {
	test('ambiguous TASK markers remain unattributed', async () => {
		const directory = makeDirectory('reviewer-ambiguous-');
		const sessionID = 'reviewer-ambiguous';
		const skillA = 'file:.claude/skills/writing-tests/SKILL.md';
		const skillB = 'file:.claude/skills/engineering-conventions/SKILL.md';
		seedSkillFiles(directory, [skillA, skillB]);
		seedDelegation(directory, sessionID, skillA, 'task-earlier');
		seedDelegation(directory, sessionID, skillB, 'task-latest');

		const entries = await scanReviewer(
			directory,
			sessionID,
			'TASK: task-earlier\nTASK: task-latest\nSKILL_COMPLIANCE: COMPLIANT',
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].skillPath).toBe('__overall__');
		expect(entries[0].taskID).toBe('unknown');
	});

	test('explicit TASK attribution overrides ambiguous history', async () => {
		const directory = makeDirectory('reviewer-explicit-');
		const sessionID = 'reviewer-explicit';
		const skillA = 'file:.claude/skills/writing-tests/SKILL.md';
		const skillB = 'file:.claude/skills/engineering-conventions/SKILL.md';
		seedSkillFiles(directory, [skillA, skillB]);
		seedDelegation(directory, sessionID, skillA, 'task-earlier');
		seedDelegation(directory, sessionID, skillB, 'task-latest');

		const entries = await scanReviewer(
			directory,
			sessionID,
			'TASK: task-earlier\nSKILL_COMPLIANCE: COMPLIANT',
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].skillPath).toBe(skillA.replace('file:', ''));
		expect(entries[0].taskID).toBe('task-earlier');
	});

	test('unknown numeric TASK does not use a unique plan fallback', async () => {
		const directory = makeDirectory('reviewer-unknown-plan-');
		const sessionID = 'reviewer-unknown-plan';
		writePlan(directory, ['1.1']);
		seedDelegation(
			directory,
			sessionID,
			'file:.claude/skills/writing-tests/SKILL.md',
			'1.1',
		);

		const entries = await scanReviewer(
			directory,
			sessionID,
			'TASK: 9.9\nSKILL_COMPLIANCE: COMPLIANT',
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].taskID).toBe('unknown');
		expect(entries[0].skillPath).toBe('__overall__');
	});
});
