/**
 * Issue #2501 Part B — Spec-Kit tasks.md check-off round trip
 * (src/sdd/speckit-checkoff.ts).
 *
 * Covers: ledger build from a real resolveSpeckitProjection resolution (incl.
 * the [US n] story-index mapping), the disabled gate, the no-ledger no-op, the
 * happy-path byte-preserving flip (LF and CRLF), idempotency, user-reopen
 * respect, stale-ledger refusal, bare-ref ambiguity, and the applyCheckoffEdit
 * seam. Conventions: bun:test only, canonicalMkdtemp roots, NO mock.module,
 * _internals restored in afterEach, no dynamic timestamps in fixtures.
 *
 * Two probed implementation facts are pinned below (update consciously):
 * 1. SEAM ROUTING: propagateSpeckitCheckoff calls the module-local
 *    applyCheckoffEdit binding directly (NOT through _internals), so a
 *    _internals override does not capture propagation traffic — the same
 *    documented pattern as src/parallel/file-locks.ts:_internals. The seam
 *    test pins the wiring identity, drives the seam with the production
 *    ledger task-entry shape, and pins that a propagation run does not
 *    route through the seam.
 * 2. REPEAT PROPAGATION: the staleness digest is checkbox-insensitive
 *    (normalized `[xX]`→`[ ]` at capture AND recompute), so our own flips and
 *    user reopens never mark a feature stale — a repeat propagation finds the
 *    task already checked (idempotent, no write, bytes stable). The literal
 *    'already-checked' outcome is also reachable with a task captured
 *    pre-checked (initiallyChecked), covered separately.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveSpeckitProjection } from '../../../src/sdd/effective-spec';
import {
	_internals,
	applyCheckoffEdit,
	propagateSpeckitCheckoff,
	SPECKIT_CHECKOFF_LEDGER_REL,
	type SpeckitCheckoffLedger,
	type SpeckitCheckoffResult,
	type SpeckitCheckoffTaskEntry,
	writeSpeckitCheckoffLedger,
} from '../../../src/sdd/speckit-checkoff';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const LOGIN_SPEC =
	'# Login\n\n## Functional Requirements\n\n' +
	'- **FR-001**: The system MUST support login.\n' +
	'- **FR-002**: The system SHALL support logout.\n\n' +
	'## Success Criteria\n\n- User can log in and out.\n';
const LOGIN_TASKS =
	'# Tasks\n\n' +
	'- [ ] T001 [P] [US1] Implement one src/login/one.ts\n' +
	'- [ ] T002 [P] [US2] Implement two src/login/two.ts\n';
const EXPORT_SPEC =
	'# Export\n\n## Functional Requirements\n\n' +
	'- **FR-001**: The system MUST support export.\n' +
	'- **FR-002**: The system SHALL support import.\n\n' +
	'## Success Criteria\n\n- User can export and import.\n';
const EXPORT_TASKS =
	'# Tasks\n\n' +
	'- [ ] T001 [P] [US1] Implement one src/export/one.ts\n' +
	'- [ ] T002 [P] [US2] Implement two src/export/two.ts\n';
const LOGIN_T001_DONE = '- [x] T001 [P] [US1] Implement one src/login/one.ts';

let root = '';
const realApplyCheckoffEdit = _internals.applyCheckoffEdit;

beforeEach(() => {
	root = canonicalMkdtemp('issue-2501-checkoff-');
});

afterEach(() => {
	_internals.applyCheckoffEdit = realApplyCheckoffEdit;
	if (root) fs.rmSync(root, { recursive: true, force: true });
});

function writeFeature(
	dir: string,
	featureId: '001-login' | '002-export',
	opts: { crlfTasks?: boolean } = {},
): void {
	const spec = featureId === '001-login' ? LOGIN_SPEC : EXPORT_SPEC;
	const tasks = featureId === '001-login' ? LOGIN_TASKS : EXPORT_TASKS;
	const featureDir = path.join(dir, 'specs', featureId);
	fs.mkdirSync(featureDir, { recursive: true });
	fs.writeFileSync(path.join(featureDir, 'spec.md'), spec, 'utf-8');
	fs.writeFileSync(
		path.join(featureDir, 'tasks.md'),
		opts.crlfTasks ? tasks.replace(/\n/g, '\r\n') : tasks,
		'utf-8',
	);
}

function buildTwoFeatureRepo(opts: { crlfTasks?: boolean } = {}): void {
	fs.mkdirSync(path.join(root, '.specify'), { recursive: true });
	writeFeature(root, '001-login', opts);
	writeFeature(root, '002-export', opts);
}

/** Build the ledger the way production does: real projection → ledger. */
function buildAndProject(): void {
	const resolution = resolveSpeckitProjection(root);
	if (resolution.kind !== 'ok') {
		throw new Error(`expected ok projection, got: ${resolution.kind}`);
	}
	writeSpeckitCheckoffLedger(root, resolution);
}

function setupRepo(opts: { crlfTasks?: boolean } = {}): void {
	buildTwoFeatureRepo(opts);
	buildAndProject();
}

/** propagateSpeckitCheckoff against the current test root (default enabled). */
async function propagate(
	completed: { taskId: string; frRefs: string[]; text?: string },
	enabled = true,
): Promise<SpeckitCheckoffResult> {
	return propagateSpeckitCheckoff(
		root,
		{ text: '', ...completed },
		{ enabled },
	);
}

function tasksAbs(featureId: string): string {
	return path.join(root, 'specs', featureId, 'tasks.md');
}

function readLedgerAt(dir: string): SpeckitCheckoffLedger {
	return JSON.parse(
		fs.readFileSync(path.join(dir, SPECKIT_CHECKOFF_LEDGER_REL), 'utf-8'),
	) as SpeckitCheckoffLedger;
}

/** rel-posix-path → utf-8 content for every file under dir (write detection). */
function snapshotTree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (rel: string): void => {
		for (const entry of fs
			.readdirSync(path.join(dir, rel), { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name))) {
			const relChild = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(relChild);
			else if (entry.isFile()) {
				out[relChild] = fs.readFileSync(path.join(dir, relChild), 'utf-8');
			}
		}
	};
	walk('');
	return out;
}

/** Exactly one '[ ]'→'[x]' delta; every other byte identical. */
function expectSingleCheckboxFlip(before: string, after: string): void {
	expect(before).not.toContain('[x]');
	expect(after.split('[x]')).toHaveLength(2);
	expect(after.replace('[x]', '[ ]')).toBe(before);
}

describe('ledger build (resolveSpeckitProjection → writeSpeckitCheckoffLedger)', () => {
	test('multi-feature: file at .swarm/speckit-checkoff-ledger.json; story-index-mapped frRefs are namespaced', () => {
		setupRepo();
		expect(fs.existsSync(path.join(root, SPECKIT_CHECKOFF_LEDGER_REL))).toBe(
			true,
		);
		const ledger = readLedgerAt(root);
		expect(ledger.version).toBe(1);
		expect(ledger.namespaced).toBe(true);
		expect(typeof ledger.projectedAt).toBe('string');
		expect(ledger.features.map((f) => f.featureId)).toEqual([
			'001-login',
			'002-export',
		]);

		const login = ledger.features[0]!;
		expect(login.tasksRelPath).toBe('specs/001-login/tasks.md');
		expect(login.taskLinesDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(login.tasks.map((t) => t.taskId)).toEqual(['T001', 'T002']);
		// Story-index mapping: [US1] → 1st requirement, [US2] → 2nd.
		expect(login.tasks[0]!.frRefs).toEqual(['001-login/FR-001']);
		expect(login.tasks[1]!.frRefs).toEqual(['001-login/FR-002']);
		for (const task of login.tasks) {
			expect(task.lineSnapshot).toBe(
				task.taskId === 'T001'
					? '- [ ] T001 [P] [US1] Implement one src/login/one.ts'
					: '- [ ] T002 [P] [US2] Implement two src/login/two.ts',
			);
			expect(task.initiallyChecked).toBe(false);
			expect(task.swarmCheckedAt).toBeUndefined();
		}
	});

	test('single-feature: frRefs stay bare (v1 single-feature mode)', () => {
		const single = canonicalMkdtemp('issue-2501-single-');
		try {
			fs.mkdirSync(path.join(single, '.specify'), { recursive: true });
			writeFeature(single, '001-login');
			const resolution = resolveSpeckitProjection(single);
			expect(resolution.kind).toBe('ok');
			if (resolution.kind !== 'ok') return;
			expect(resolution.namespaced).toBe(false);
			writeSpeckitCheckoffLedger(single, resolution);
			const ledger = readLedgerAt(single);
			expect(ledger.namespaced).toBe(false);
			expect(ledger.features).toHaveLength(1);
			const rec = ledger.features[0]!;
			expect(rec.tasksRelPath).toBe('specs/001-login/tasks.md');
			expect(rec.tasks[0]!.frRefs).toEqual(['FR-001']);
			expect(rec.tasks[1]!.frRefs).toEqual(['FR-002']);
		} finally {
			fs.rmSync(single, { recursive: true, force: true });
		}
	});
});

describe('opt-in gates', () => {
	test('enabled:false → {ran:false, reason:"disabled"}, zero file writes (tree snapshot equal)', async () => {
		setupRepo();
		const before = snapshotTree(root);
		const result = await propagate(
			{ taskId: '1.1', frRefs: ['001-login/FR-001'] },
			false,
		);
		expect(result).toEqual({ ran: false, reason: 'disabled', features: [] });
		expect(snapshotTree(root)).toEqual(before);
	});

	test('enabled:true but no ledger → {ran:false, reason:"no-ledger"}, no .swarm created', async () => {
		buildTwoFeatureRepo(); // full Spec-Kit repo, ledger deliberately absent
		expect(fs.existsSync(path.join(root, '.swarm'))).toBe(false);
		const result = await propagate({
			taskId: '1.1',
			frRefs: ['001-login/FR-001'],
		});
		expect(result).toEqual({ ran: false, reason: 'no-ledger', features: [] });
		// No writes anywhere — not even the lock dir under .swarm/.
		expect(fs.existsSync(path.join(root, '.swarm'))).toBe(false);
	});
});

describe('happy-path propagation', () => {
	test('LF tasks.md: T001 flips [ ]→[x]; every other byte identical; other feature untouched; ledger gains swarmCheckedAt', async () => {
		setupRepo();
		const loginBefore = fs.readFileSync(tasksAbs('001-login'), 'utf-8');
		const exportBefore = fs.readFileSync(tasksAbs('002-export'));

		const result = await propagate({
			taskId: '1.1',
			frRefs: ['001-login/FR-001'],
		});

		expect(result.ran).toBe(true);
		expect(result.unmatched).toBeUndefined();
		const login = result.features.find((f) => f.featureId === '001-login')!;
		expect(login.checked).toEqual(['T001']);
		expect(login.stale).toBe(false);
		expect(login.refused).toEqual([]);
		const exportFeature = result.features.find(
			(f) => f.featureId === '002-export',
		)!;
		expect(exportFeature.checked).toEqual([]);

		const loginAfter = fs.readFileSync(tasksAbs('001-login'), 'utf-8');
		expectSingleCheckboxFlip(loginBefore, loginAfter);
		expect(loginAfter).toContain(LOGIN_T001_DONE);
		// 002-export/tasks.md byte-identical (Buffer compare).
		expect(fs.readFileSync(tasksAbs('002-export')).equals(exportBefore)).toBe(
			true,
		);

		// Ledger updated with swarmCheckedAt for T001 only.
		const ledger = readLedgerAt(root);
		const t001 = ledger.features[0]!.tasks.find((t) => t.taskId === 'T001')!;
		const t002 = ledger.features[0]!.tasks.find((t) => t.taskId === 'T002')!;
		expect(typeof t001.swarmCheckedAt).toBe('string');
		expect(t002.swarmCheckedAt).toBeUndefined();
	});

	test('CRLF tasks.md: checkbox flips and CRLF line endings are preserved byte-for-byte', async () => {
		setupRepo({ crlfTasks: true });
		const before = fs.readFileSync(tasksAbs('001-login'), 'utf-8');
		expect(before).toContain('\r\n');

		const result = await propagate({
			taskId: '1.1',
			frRefs: ['001-login/FR-001'],
		});

		expect(result.features[0]!.checked).toEqual(['T001']);
		const after = fs.readFileSync(tasksAbs('001-login'), 'utf-8');
		expectSingleCheckboxFlip(before, after);
		// The flipped line itself still terminates with CRLF.
		expect(after).toContain(`${LOGIN_T001_DONE}\r\n`);
	});
});

describe('idempotency', () => {
	test('propagating the same completion twice: no double flip, bytes stable (idempotent already-checked)', async () => {
		setupRepo();
		const original = fs.readFileSync(tasksAbs('001-login'), 'utf-8');

		const run1 = await propagate({
			taskId: '1.1',
			frRefs: ['001-login/FR-001'],
		});
		expect(run1.features[0]!.checked).toEqual(['T001']);
		const afterRun1 = fs.readFileSync(tasksAbs('001-login'), 'utf-8');
		expectSingleCheckboxFlip(original, afterRun1);

		const run2 = await propagate({
			taskId: '1.1',
			frRefs: ['001-login/FR-001'],
		});
		// Corrected contract: the staleness digest is checkbox-insensitive, so our
		// own flip does NOT make the feature stale. The repeat run finds the task
		// already checked — idempotent, no re-flip, no write, not stale.
		expect(run2.ran).toBe(true);
		expect(run2.features[0]!.checked).toEqual([]);
		expect(run2.features[0]!.stale).toBe(false);
		expect(run2.features[0]!.refused).toEqual([]);
		const afterRun2 = fs.readFileSync(tasksAbs('001-login'), 'utf-8');
		expect(afterRun2).toBe(afterRun1);
		expect(afterRun2.split('[x]')).toHaveLength(2);
	});

	test('pre-checked task (initiallyChecked): already-checked semantics — no write on either run, ledger records swarmCheckedAt once', async () => {
		buildTwoFeatureRepo();
		// Pre-check T001 BEFORE the ledger is built so the captured snapshot
		// itself contains [x] — one of two paths to 'already-checked' (the
		// other is a repeat propagation after our own flip, covered above).
		fs.writeFileSync(
			tasksAbs('001-login'),
			LOGIN_TASKS.replace('- [ ] T001', '- [x] T001'),
			'utf-8',
		);
		buildAndProject();
		const before = fs.readFileSync(tasksAbs('001-login'), 'utf-8');

		const run1 = await propagate({
			taskId: '1.1',
			frRefs: ['001-login/FR-001'],
		});
		expect(run1.features[0]!.checked).toEqual([]);
		expect(run1.features[0]!.refused).toEqual([]);
		expect(run1.features[0]!.stale).toBe(false);
		expect(fs.readFileSync(tasksAbs('001-login'), 'utf-8')).toBe(before);
		const ledger1 = readLedgerAt(root);
		expect(typeof ledger1.features[0]!.tasks[0]!.swarmCheckedAt).toBe('string');

		const run2 = await propagate({
			taskId: '1.1',
			frRefs: ['001-login/FR-001'],
		});
		expect(run2.features[0]!.checked).toEqual([]);
		expect(run2.features[0]!.refused).toEqual([]);
		expect(fs.readFileSync(tasksAbs('001-login'), 'utf-8')).toBe(before);
		expect(readLedgerAt(root)).toEqual(ledger1); // no further ledger churn
	});
});

describe('user reopen', () => {
	test('task the user reopened to [ ] stays [ ] and is reported in reopenedSkipped when a different task propagates', async () => {
		setupRepo();
		const originalBytes = fs.readFileSync(tasksAbs('001-login'), 'utf-8');

		// Check T002 through the production path.
		const runT002 = await propagate({
			taskId: '2.1',
			frRefs: ['001-login/FR-002'],
		});
		expect(runT002.features[0]!.checked).toEqual(['T002']);

		// User reopens T002 (restore the exact original bytes, keeping the
		// ledger — the digest matches again because the file is pristine).
		fs.writeFileSync(tasksAbs('001-login'), originalBytes, 'utf-8');

		const runT001 = await propagate({
			taskId: '1.1',
			frRefs: ['001-login/FR-001'],
		});
		const login = runT001.features[0]!;
		expect(login.checked).toEqual(['T001']);
		expect(login.reopenedSkipped).toEqual(['T002']);
		expect(login.stale).toBe(false);

		const content = fs.readFileSync(tasksAbs('001-login'), 'utf-8');
		expect(content).toContain(LOGIN_T001_DONE);
		expect(content).toContain(
			'- [ ] T002 [P] [US2] Implement two src/login/two.ts',
		);
	});
});

describe('staleness and refusal', () => {
	test('renumbered task lines (T101): stale:true for that feature, refused, zero writes to it', async () => {
		setupRepo();
		fs.writeFileSync(
			tasksAbs('001-login'),
			LOGIN_TASKS.replaceAll('T001', 'T101').replaceAll('T002', 'T102'),
			'utf-8',
		);
		const before = fs.readFileSync(tasksAbs('001-login'));

		const result = await propagate({
			taskId: '1.1',
			frRefs: ['001-login/FR-001'],
		});

		const login = result.features[0]!;
		expect(login.stale).toBe(true);
		expect(login.checked).toEqual([]);
		expect(login.refused).toContain('T001');
		// Zero writes: the renumbered file is byte-identical after the run.
		expect(fs.readFileSync(tasksAbs('001-login')).equals(before)).toBe(true);
	});

	test('same id, different text: digest changes → refused with no write', async () => {
		setupRepo();
		fs.writeFileSync(
			tasksAbs('001-login'),
			LOGIN_TASKS.replace('Implement one', 'Implement RENAMED one'),
			'utf-8',
		);
		const before = fs.readFileSync(tasksAbs('001-login'));

		const result = await propagate({
			taskId: '1.1',
			frRefs: ['001-login/FR-001'],
		});

		const login = result.features[0]!;
		expect(login.stale).toBe(true);
		expect(login.checked).toEqual([]);
		expect(login.refused).toContain('T001');
		expect(fs.readFileSync(tasksAbs('001-login')).equals(before)).toBe(true);
	});
});

describe('ref matching across features', () => {
	test('bare FR-001 matches T001 in BOTH features: both checked, byte parity per file', async () => {
		setupRepo();
		const loginBefore = fs.readFileSync(tasksAbs('001-login'), 'utf-8');
		const exportBefore = fs.readFileSync(tasksAbs('002-export'), 'utf-8');

		const result = await propagate({ taskId: '1.1', frRefs: ['FR-001'] });

		expect(result.ran).toBe(true);
		expect(result.unmatched).toBeUndefined();
		for (const feature of result.features) {
			expect(feature.checked).toEqual(['T001']);
			expect(feature.stale).toBe(false);
		}
		expectSingleCheckboxFlip(
			loginBefore,
			fs.readFileSync(tasksAbs('001-login'), 'utf-8'),
		);
		expectSingleCheckboxFlip(
			exportBefore,
			fs.readFileSync(tasksAbs('002-export'), 'utf-8'),
		);
	});

	test('refs matching no ledger task: unmatched:true, no writes anywhere (ledger bytes included)', async () => {
		setupRepo();
		const before = snapshotTree(root);

		const result = await propagate({ taskId: '9.9', frRefs: ['FR-999'] });

		expect(result.ran).toBe(true);
		expect(result.unmatched).toBe(true);
		for (const feature of result.features) {
			expect(feature.checked).toEqual([]);
			expect(feature.refused).toEqual([]);
			expect(feature.stale).toBe(false);
		}
		expect(snapshotTree(root)).toEqual(before);
	});
});
