import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Evidence } from '../../../src/config/evidence-schema';
import { saveEvidence } from '../../../src/evidence/manager';
import { resetSwarmState } from '../../../src/state';
import { executeDeclareScope } from '../../../src/tools/declare-scope';
import {
	executeSavePlan,
	type SavePlanArgs,
} from '../../../src/tools/save-plan';
import { executeUpdateTaskStatus } from '../../../src/tools/update-task-status';
import {
	createNestedBoundaryFixture,
	makeNestedPlan,
	type NestedBoundaryFixture,
	removeNestedBoundaryFixture,
	writeNestedPlan,
} from '../../helpers/nested-project-boundary';

const fixtures: NestedBoundaryFixture[] = [];

afterEach(() => {
	resetSwarmState();
	for (const fixture of fixtures.splice(0)) {
		removeNestedBoundaryFixture(fixture);
	}
});

function fixture(
	marker: 'git-directory' | 'git-file' | 'opencode' = 'git-directory',
): NestedBoundaryFixture {
	const created = createNestedBoundaryFixture(marker);
	fixtures.push(created);
	return created;
}

function noteEvidence(): Evidence {
	return {
		task_id: '1.1',
		type: 'note',
		timestamp: '2026-01-01T00:00:00.000Z',
		agent: 'issue-2127-test',
		verdict: 'info',
		summary: 'Nested root evidence stays nested',
	};
}

function savePlanArgs(workingDirectory: string): SavePlanArgs {
	return {
		title: 'Nested project plan',
		swarm_id: 'nested-boundary',
		working_directory: workingDirectory,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				tasks: [{ id: '1.1', description: 'Keep state in nested root' }],
			},
		],
	};
}

describe('nested project boundary writers — regression: parent .swarm poison (#2127)', () => {
	it('saveEvidence writes only beneath a nested Git worktree-style root', async () => {
		const { outer, nested } = fixture('git-file');
		const bundle = await saveEvidence(nested, '1.1', noteEvidence());

		expect(bundle.task_id).toBe('1.1');
		expect(
			fs.existsSync(
				path.join(nested, '.swarm', 'evidence', '1.1', 'evidence.json'),
			),
		).toBe(true);
		expect(fs.existsSync(path.join(outer, '.swarm', 'evidence'))).toBe(false);
	});

	it('executeSavePlan persists the ledger and projections only in the nested root', async () => {
		const { outer, nested } = fixture('opencode');
		fs.mkdirSync(path.join(nested, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(nested, '.swarm', 'spec.md'),
			'# Nested spec\nKeep plan state in this project.',
		);
		fs.writeFileSync(
			path.join(nested, '.swarm', 'context.md'),
			'## Pending QA Gate Selection\n',
		);

		const result = await executeSavePlan(savePlanArgs(nested), outer);

		expect(result.success).toBe(true);
		expect(
			fs.existsSync(path.join(nested, '.swarm', 'plan-ledger.jsonl')),
		).toBe(true);
		expect(fs.existsSync(path.join(nested, '.swarm', 'plan.json'))).toBe(true);
		expect(fs.existsSync(path.join(outer, '.swarm', 'plan.json'))).toBe(false);
	});

	it('executeDeclareScope persists an owner-bound scope only in the nested root', async () => {
		const { outer, nested } = fixture('git-directory');
		writeNestedPlan(nested);

		const result = await executeDeclareScope(
			{
				taskId: '1.1',
				files: ['src/nested.ts'],
				working_directory: nested,
			},
			outer,
			{
				sessionID: 'issue-2127-session',
				messageID: 'issue-2127-message',
				agentName: 'architect',
			},
		);

		expect(result.success).toBe(true);
		const nestedScopes = path.join(nested, '.swarm', 'scopes');
		expect(fs.existsSync(nestedScopes)).toBe(true);
		expect(
			fs
				.readdirSync(nestedScopes)
				.some((name) => name.startsWith('binding-1.1-')),
		).toBe(true);
		expect(fs.existsSync(path.join(outer, '.swarm', 'scopes'))).toBe(false);
	});

	it('executeUpdateTaskStatus mutates only the nested plan state', async () => {
		const { outer, nested } = fixture('git-directory');
		writeNestedPlan(nested);
		const outerPlan = makeNestedPlan();
		fs.writeFileSync(
			path.join(outer, '.swarm', 'plan.json'),
			JSON.stringify(outerPlan, null, 2),
		);

		const result = await executeUpdateTaskStatus(
			{
				task_id: '1.1',
				status: 'in_progress',
				working_directory: nested,
			},
			outer,
		);

		expect(result.success).toBe(true);
		const nestedPlan = JSON.parse(
			fs.readFileSync(path.join(nested, '.swarm', 'plan.json'), 'utf8'),
		);
		const unchangedOuter = JSON.parse(
			fs.readFileSync(path.join(outer, '.swarm', 'plan.json'), 'utf8'),
		);
		expect(nestedPlan.phases[0].tasks[0].status).toBe('in_progress');
		expect(unchangedOuter.phases[0].tasks[0].status).toBe('pending');
	});

	it('keeps ordinary descendants rejected by every writer entry path', async () => {
		const { outer, ordinary } = fixture();
		writeNestedPlan(ordinary);
		fs.writeFileSync(
			path.join(ordinary, '.swarm', 'spec.md'),
			'# Ordinary child spec',
		);

		await expect(saveEvidence(ordinary, '1.1', noteEvidence())).rejects.toThrow(
			'Cannot write evidence',
		);
		const save = await executeSavePlan(savePlanArgs(ordinary), outer);
		const scope = await executeDeclareScope(
			{ taskId: '1.1', files: ['src/nested.ts'], working_directory: ordinary },
			outer,
		);
		const update = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress', working_directory: ordinary },
			outer,
		);

		expect(save.success).toBe(false);
		expect(save.message).toContain('project root');
		expect(scope.success).toBe(false);
		expect(scope.message).toContain('subdirectory');
		expect(update.success).toBe(false);
		expect(update.message).toContain('subdirectory');
	});
});
