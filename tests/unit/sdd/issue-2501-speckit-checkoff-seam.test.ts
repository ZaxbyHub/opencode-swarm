/**
 * Issue #2501 Part B — applyCheckoffEdit seam + pure unit outcomes (FR-006 split
 * of issue-2501-speckit-checkoff.test.ts; see that file's header for the two
 * probed implementation facts this suite pins).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveSpeckitProjection } from '../../../src/sdd/effective-spec';
import {
	_internals,
	applyCheckoffEdit,
	propagateSpeckitCheckoff,
	type SpeckitCheckoffLedger,
	type SpeckitCheckoffTaskEntry,
	writeSpeckitCheckoffLedger,
} from '../../../src/sdd/speckit-checkoff';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const NL = String.fromCharCode(10);
const LOGIN_SPEC = [
	'# Login',
	'',
	'## Functional Requirements',
	'',
	'- **FR-001**: The system MUST support login.',
	'- **FR-002**: The system SHALL support logout.',
	'',
	'## Success Criteria',
	'',
	'- User can log in and out.',
	'',
].join('\n');
const LOGIN_TASKS = [
	'# Tasks',
	'',
	'- [ ] T001 [P] [US1] Implement one src/login/one.ts',
	'- [ ] T002 [P] [US2] Implement two src/login/two.ts',
	'',
].join('\n');
const LOGIN_T001_DONE = '- [x] T001 [P] [US1] Implement one src/login/one.ts';
const EXPORT_SPEC = [
	'# Export',
	'',
	'## Functional Requirements',
	'',
	'- **FR-001**: The system MUST support export.',
	'- **FR-002**: The system SHALL support import.',
	'',
	'## Success Criteria',
	'',
	'- User can export and import.',
	'',
].join(NL);
const EXPORT_TASKS = [
	'# Tasks',
	'',
	'- [ ] T001 [P] [US1] Implement one src/export/one.ts',
	'- [ ] T002 [P] [US2] Implement two src/export/two.ts',
	'',
].join(NL);

let root = '';
const realApplyCheckoffEdit = _internals.applyCheckoffEdit;

beforeEach(() => {
	root = canonicalMkdtemp('issue-2501-checkoff-seam-');
});

afterEach(() => {
	_internals.applyCheckoffEdit = realApplyCheckoffEdit;
	if (root) fs.rmSync(root, { recursive: true, force: true });
});

function setupRepo(): void {
	fs.mkdirSync(path.join(root, '.specify'), { recursive: true });
	// Two features so the projection is multi-mode and the ledger's story-index
	// mapping produces namespaced frRefs (001-login/FR-001), matching the pin.
	for (const [featureId, spec, tasks] of [
		['001-login', LOGIN_SPEC, LOGIN_TASKS],
		['002-export', EXPORT_SPEC, EXPORT_TASKS],
	] as const) {
		const featureDir = path.join(root, 'specs', featureId);
		fs.mkdirSync(featureDir, { recursive: true });
		fs.writeFileSync(path.join(featureDir, 'spec.md'), spec, 'utf-8');
		fs.writeFileSync(path.join(featureDir, 'tasks.md'), tasks, 'utf-8');
	}
	const resolution = resolveSpeckitProjection(root);
	if (resolution.kind !== 'ok') {
		throw new Error(`expected ok projection, got: ${resolution.kind}`);
	}
	writeSpeckitCheckoffLedger(root, resolution);
}

function tasksAbs(): string {
	return path.join(root, 'specs', '001-login', 'tasks.md');
}

function readLedgerAt(dir: string): SpeckitCheckoffLedger {
	return JSON.parse(
		fs.readFileSync(
			path.join(dir, '.swarm', 'speckit-checkoff-ledger.json'),
			'utf-8',
		),
	) as SpeckitCheckoffLedger;
}

async function propagate(completed: {
	taskId: string;
	frRefs: string[];
	text?: string;
}): Promise<{ features: unknown[] }> {
	return propagateSpeckitCheckoff(
		root,
		{ text: '', ...completed },
		{ enabled: true },
	);
}

/** Exactly one '[ ]'→'[x]' delta; every other byte identical. */
function expectSingleCheckboxFlip(before: string, after: string): void {
	expect(before).not.toContain('[x]');
	expect(after.split('[x]')).toHaveLength(2);
	expect(after.replace('[x]', '[ ]')).toBe(before);
}

describe('applyCheckoffEdit seam (_internals, plan F5 pin)', () => {
	test('seam receives the production task-entry shape (taskId/lineSnapshot/frRefs from the ledger) plus (baseline, current) strings', async () => {
		setupRepo();
		const entry = readLedgerAt(root).features[0]!.tasks.find(
			(t) => t.taskId === 'T001',
		)!;
		const before = fs.readFileSync(tasksAbs('001-login'), 'utf-8');

		// Wiring pin: the seam default is the exact function production calls
		// (propagateSpeckitCheckoff binds applyCheckoffEdit directly).
		expect(_internals.applyCheckoffEdit).toBe(applyCheckoffEdit);

		const recorded: {
			task: SpeckitCheckoffTaskEntry;
			baseline: string;
			current: string;
		}[] = [];
		_internals.applyCheckoffEdit = (task, baseline, current) => {
			recorded.push({ task, baseline, current });
			return realApplyCheckoffEdit(task, baseline, current);
		};

		// Drive the seam with the production arguments: a real ledger entry
		// and the real file bytes as baseline AND current.
		const outcome = _internals.applyCheckoffEdit(entry, before, before);
		expect(outcome.applied).toBe(true);
		expect(outcome.reason).toBe('ok');
		expectSingleCheckboxFlip(before, outcome.content);

		expect(recorded).toHaveLength(1);
		const call = recorded[0]!;
		expect(call.task.taskId).toBe('T001');
		expect(call.task.lineSnapshot).toBe(
			'- [ ] T001 [P] [US1] Implement one src/login/one.ts',
		);
		expect(call.task.frRefs).toEqual(['001-login/FR-001']);
		expect(call.baseline).toBe(before);
		expect(call.current).toBe(before);

		// Routing pin (probed): propagation does NOT call through the seam —
		// production binds applyCheckoffEdit module-locally. If this pin flips,
		// the seam became an interception point; update it consciously.
		await propagate({ taskId: '1.1', frRefs: ['001-login/FR-001'] });
		expect(recorded).toHaveLength(1);
		expect(fs.readFileSync(tasksAbs('001-login'), 'utf-8')).toContain(
			LOGIN_T001_DONE,
		);
	});
});

describe('applyCheckoffEdit unit outcomes (pure, no I/O)', () => {
	const entry: SpeckitCheckoffTaskEntry = {
		taskId: 'T001',
		frRefs: ['001-login/FR-001'],
		lineSnapshot: '- [ ] T001 [P] [US1] Implement one src/login/one.ts',
		initiallyChecked: false,
	};

	test('task-line-not-found when the captured line was deleted', () => {
		const content =
			'# Tasks\n\n- [ ] T002 [P] [US2] Implement two src/login/two.ts\n';
		const out = applyCheckoffEdit(entry, content, content);
		expect(out.applied).toBe(false);
		expect(out.reason).toBe('task-line-not-found');
		expect(out.content).toBe(content);
	});

	test('task-line-changed when the same T### id has different text', () => {
		const content =
			'# Tasks\n\n- [ ] T001 [P] [US1] Implement RENAMED one src/login/one.ts\n';
		const out = applyCheckoffEdit(entry, content, content);
		expect(out.applied).toBe(false);
		expect(out.reason).toBe('task-line-changed');
		expect(out.content).toBe(content);
	});

	test('already-checked when the ledger captured the task pre-checked', () => {
		const checkedEntry: SpeckitCheckoffTaskEntry = {
			...entry,
			lineSnapshot: entry.lineSnapshot.replace('[ ]', '[x]'),
			initiallyChecked: true,
		};
		const content = `# Tasks\n\n${checkedEntry.lineSnapshot}\n`;
		const out = applyCheckoffEdit(checkedEntry, content, content);
		expect(out.applied).toBe(false);
		expect(out.reason).toBe('already-checked');
		expect(out.content).toBe(content);
	});
});
