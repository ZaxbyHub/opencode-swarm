import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Evidence } from '../../../src/config/evidence-schema';
import { saveEvidence } from '../../../src/evidence/manager';
import { writeCheckpoint } from '../../../src/plan/checkpoint';
import { initLedger, quarantineLedgerSuffix } from '../../../src/plan/ledger';
import {
	closePlanTerminalState,
	loadPlan,
	rebuildPlan,
	regeneratePlanMarkdown,
	savePlan,
	updateTaskStatus,
} from '../../../src/plan/manager';
import { createScopeBinding } from '../../../src/scope/scope-binding';
import {
	clearAllScopes,
	clearScopeBindingFromDisk,
	clearScopeForTask,
	replaceExistingScopeDeclaration,
	resolveScopeBindingFromDisk,
	tombstoneScopeBinding,
	writeScopeBindingToDisk,
	writeScopeToDisk,
} from '../../../src/scope/scope-persistence';
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
		expect(update.message).toContain('project root');
	});

	it('rejects tool writes when an unrelated fallback cannot identify the descendant', async () => {
		const { nested: unrelatedFallback, ordinary } = fixture();
		writeNestedPlan(ordinary);
		fs.writeFileSync(
			path.join(ordinary, '.swarm', 'spec.md'),
			'# Ordinary child spec',
		);
		fs.writeFileSync(
			path.join(ordinary, '.swarm', 'context.md'),
			'## Pending QA Gate Selection\n',
		);

		const save = await executeSavePlan(
			savePlanArgs(ordinary),
			unrelatedFallback,
		);
		const update = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress', working_directory: ordinary },
			unrelatedFallback,
		);

		expect(save.success).toBe(false);
		expect(save.message).toContain('project root');
		expect(update.success).toBe(false);
		expect(update.message).toContain('project root');
		expect(
			fs.existsSync(path.join(ordinary, '.swarm', 'spec-snapshot.md')),
		).toBe(false);
		expect(
			fs.existsSync(path.join(ordinary, '.swarm', 'evidence', '1.1.json')),
		).toBe(false);
	});

	it('guards direct ledger creation and quarantine sinks', async () => {
		const { ordinary } = fixture();

		await expect(initLedger(ordinary, 'ordinary-plan')).rejects.toThrow(
			'Cannot write runtime state',
		);
		expect(fs.existsSync(path.join(ordinary, '.swarm'))).toBe(false);

		fs.mkdirSync(path.join(ordinary, '.swarm'));
		const quarantine = await quarantineLedgerSuffix(ordinary, '{"seq":1}\n');
		expect(quarantine.path).toBeNull();
		expect(fs.readdirSync(path.join(ordinary, '.swarm'))).toEqual([]);
	});

	it('keeps direct ledger sinks writable at explicit nested boundaries', async () => {
		const { nested } = fixture('opencode');

		await initLedger(nested, 'nested-plan');
		const quarantine = await quarantineLedgerSuffix(nested, '{"seq":1}\n');

		expect(
			fs.existsSync(path.join(nested, '.swarm', 'plan-ledger.jsonl')),
		).toBe(true);
		expect(quarantine.path).not.toBeNull();
		if (quarantine.path) expect(fs.existsSync(quarantine.path)).toBe(true);
	});

	it('prevents checkpoint and load-time plan mutations in ordinary descendants', async () => {
		const { ordinary } = fixture();
		const plan = { ...makeNestedPlan(), specHash: 'stale-spec-hash' };
		fs.mkdirSync(path.join(ordinary, '.swarm'));
		fs.writeFileSync(
			path.join(ordinary, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
		fs.writeFileSync(
			path.join(ordinary, '.swarm', 'spec.md'),
			'# Changed spec\n',
		);
		const beforePlan = fs.readFileSync(
			path.join(ordinary, '.swarm', 'plan.json'),
			'utf8',
		);

		const loaded = await loadPlan(ordinary);
		await writeCheckpoint(ordinary);
		await expect(
			updateTaskStatus(ordinary, '1.1', 'in_progress'),
		).rejects.toThrow('Cannot write runtime state');

		expect(loaded?.specHash).toBe('stale-spec-hash');
		expect(
			fs.readFileSync(path.join(ordinary, '.swarm', 'plan.json'), 'utf8'),
		).toBe(beforePlan);
		expect(fs.existsSync(path.join(ordinary, '.swarm', 'plan-export'))).toBe(
			false,
		);
		expect(
			fs.existsSync(path.join(ordinary, '.swarm', 'spec-staleness.json')),
		).toBe(false);
		expect(fs.existsSync(path.join(ordinary, '.swarm', 'events.jsonl'))).toBe(
			false,
		);
	});

	it('keeps checkpoint and load-time plan mutations available at explicit roots', async () => {
		const { nested } = fixture('git-directory');
		const plan = { ...makeNestedPlan(), specHash: 'stale-spec-hash' };
		fs.mkdirSync(path.join(nested, '.swarm'));
		fs.writeFileSync(
			path.join(nested, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
		fs.writeFileSync(
			path.join(nested, '.swarm', 'spec.md'),
			'# Changed spec\n',
		);

		await loadPlan(nested);
		await writeCheckpoint(nested);
		const updated = await updateTaskStatus(nested, '1.1', 'in_progress');

		expect(updated.phases[0]?.tasks[0]?.status).toBe('in_progress');
		expect(
			fs.existsSync(path.join(nested, '.swarm', 'spec-staleness.json')),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(nested, '.swarm', 'plan-export', 'SWARM_PLAN.json'),
			),
		).toBe(true);
	});

	it('reasserts project-root containment at low-level plan and scope sinks (PRR-001)', async () => {
		const { ordinary } = fixture();
		const plan = makeNestedPlan();
		const binding = createScopeBinding({
			directory: ordinary,
			plan,
			taskId: '1.1',
			files: ['src/nested.ts'],
			ownerSessionId: 'issue-2127-session',
			ownerMessageId: 'issue-2127-message',
			source: 'declare_scope',
		});
		if (!binding) throw new Error('scope binding fixture failed');

		// Previous code let direct sink callers bypass the tool-layer root guard.
		await expect(savePlan(ordinary, plan)).rejects.toThrow(
			'Cannot write runtime state',
		);
		await expect(rebuildPlan(ordinary, plan)).rejects.toThrow(
			'Cannot write runtime state',
		);
		await expect(
			closePlanTerminalState(ordinary, plan, {
				closedPhaseIds: [],
				closedTaskIds: [],
			}),
		).rejects.toThrow('Cannot write runtime state');
		await expect(regeneratePlanMarkdown(ordinary, plan)).rejects.toThrow(
			'Cannot write runtime state',
		);
		const scope = await writeScopeBindingToDisk(ordinary, binding);
		const declaration = await replaceExistingScopeDeclaration({
			directory: ordinary,
			binding,
			replaceExisting: false,
		});
		const tombstone = await tombstoneScopeBinding(ordinary, binding, 'revoked');
		await writeScopeToDisk(ordinary, '1.1', ['src/nested.ts']);

		expect(scope.ok).toBe(false);
		if (!scope.ok) expect(scope.message).toContain('project-root validation');
		expect(declaration.ok).toBe(false);
		if (!declaration.ok)
			expect(declaration.message).toContain('project-root validation');
		expect(tombstone.ok).toBe(false);
		expect(fs.existsSync(path.join(ordinary, '.swarm'))).toBe(false);
	});

	it('keeps explicit nested boundaries writable through low-level sinks (PRR-001)', async () => {
		const { nested } = fixture('git-file');
		const plan = makeNestedPlan();
		const binding = createScopeBinding({
			directory: nested,
			plan,
			taskId: '1.1',
			files: ['src/nested.ts'],
			ownerSessionId: 'issue-2127-session',
			ownerMessageId: 'issue-2127-message',
			source: 'declare_scope',
		});
		if (!binding) throw new Error('scope binding fixture failed');

		await savePlan(nested, plan);
		const scope = await writeScopeBindingToDisk(nested, binding);
		await writeScopeToDisk(nested, '1.1', ['src/nested.ts']);

		expect(scope.ok).toBe(true);
		expect(fs.existsSync(path.join(nested, '.swarm', 'plan.json'))).toBe(true);
		expect(fs.existsSync(path.join(nested, '.swarm', 'scopes'))).toBe(true);
		expect(
			fs.existsSync(path.join(nested, '.swarm', 'scopes', 'scope-1.1.json')),
		).toBe(true);
	});

	it('rejects retirement before writing an intent into a pre-existing descendant store', () => {
		const { ordinary } = fixture();
		const binding = createScopeBinding({
			directory: ordinary,
			plan: makeNestedPlan(),
			taskId: '1.1',
			files: ['src/nested.ts'],
			ownerSessionId: 'issue-2127-session',
			ownerMessageId: 'issue-2127-message',
			source: 'declare_scope',
		});
		if (!binding) throw new Error('scope binding fixture failed');
		const scopesDir = path.join(ordinary, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });

		const cleared = clearScopeBindingFromDisk({ directory: ordinary, binding });

		expect(cleared.ok).toBe(false);
		if (!cleared.ok)
			expect(cleared.message).toContain('project-root validation');
		expect(fs.readdirSync(scopesDir)).toEqual([]);
	});

	it('does not migrate or delete a pre-existing descendant scope store', () => {
		const { ordinary } = fixture();
		const scopesDir = path.join(ordinary, '.swarm', 'scopes');
		const legacyPath = path.join(
			scopesDir,
			`binding-1.1-${'a'.repeat(24)}.json`,
		);
		const legacyProjection = path.join(scopesDir, 'scope-1.1.json');
		fs.mkdirSync(scopesDir, { recursive: true });
		fs.writeFileSync(legacyPath, '{}');
		fs.writeFileSync(legacyProjection, '{}');

		const resolution = resolveScopeBindingFromDisk({
			directory: ordinary,
			taskId: '1.1',
			plan: makeNestedPlan(),
			ownerSessionId: 'issue-2127-session',
		});
		clearScopeForTask(ordinary, '1.1');
		clearAllScopes(ordinary);

		expect(resolution.status).toBe('overloaded');
		expect(fs.readFileSync(legacyPath, 'utf8')).toBe('{}');
		expect(fs.readFileSync(legacyProjection, 'utf8')).toBe('{}');
		expect(fs.existsSync(path.join(scopesDir, 'archive'))).toBe(false);
	});
});
