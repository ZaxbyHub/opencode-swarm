import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	AutomationStatusArtifact,
	getSharedAutomationStatusArtifact,
	type StatusWriteFailureCategory,
} from '../../../src/background/status-artifact.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Issue #2669: optional automation-status persistence must be non-fatal.
 *
 * `AutomationStatusArtifact`'s write path is a pure side-effect surface (no
 * production reader), so ANY filesystem failure must be contained inside the
 * writer: no mutator may throw, the in-memory snapshot must still advance,
 * and the failure must surface as exactly one bounded, categorized,
 * debug-gated diagnostic — never a raw stack or an escaping error.
 *
 * Observability seam: the writer logs through `_internals.log`, overridden
 * in beforeEach and restored in afterEach (repo DI convention; no
 * mock.module).
 */

interface CapturedLog {
	message: string;
	data: unknown;
}

describe('AutomationStatusArtifact non-fatal writes (issue #2669)', () => {
	let tmpRoot = '';
	let logs: CapturedLog[];
	const originalLog = _internals.log;

	beforeEach(() => {
		tmpRoot = canonicalMkdtemp('status-artifact-2669-');
		logs = [];
		_internals.log = (message: string, data?: unknown) => {
			logs.push({ message, data });
		};
	});

	afterEach(() => {
		_internals.log = originalLog;
		// POSIX-only fixture may leave a read-only dir behind; widen first.
		fs.chmodSync(tmpRoot, 0o700);
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	const failureLogs = (): {
		category: StatusWriteFailureCategory;
		code: string;
	}[] =>
		logs
			.filter((entry) => entry.message.includes('status artifact write failed'))
			.map(
				(entry) =>
					entry.data as { category: StatusWriteFailureCategory; code: string },
			);

	test('`.swarm` path occupied by a regular file: mutators do not throw, snapshot advances, one bounded categorized diagnostic', () => {
		const conflict = path.join(tmpRoot, 'swarm-is-file');
		fs.writeFileSync(conflict, 'not a directory');
		const artifact = new AutomationStatusArtifact(conflict);

		expect(() =>
			artifact.updateConfig('hybrid', {
				plan_sync: false,
				phase_preflight: false,
				config_doctor_on_startup: false,
				config_doctor_autofix: false,
				evidence_auto_summaries: false,
				decision_drift_detection: false,
			}),
		).not.toThrow();
		expect(() => artifact.updatePhase(2)).not.toThrow();
		expect(() => artifact.recordOutcome('success', 2, 'ok')).not.toThrow();

		// The in-memory snapshot still advances while persistence fails.
		expect(artifact.getSnapshot().mode).toBe('hybrid');
		expect(artifact.getSnapshot().currentPhase).toBe(2);

		const failures = failureLogs();
		expect(failures.length).toBeGreaterThan(0);
		for (const failure of failures) {
			// Windows surfaces ENOENT (path traverses the file); POSIX ENOTDIR.
			expect(['missing_path', 'dir_conflict']).toContain(failure.category);
			expect(['ENOENT', 'ENOTDIR']).toContain(failure.code);
		}
		// Bounded: no stack, no raw message, only category+code fields.
		const serialized = JSON.stringify(logs);
		expect(serialized.includes('at Module.writeFileSync')).toBe(false);
	});

	test('artifact path occupied by a directory: contained write failure classified path_is_directory', () => {
		const swarmDir = path.join(tmpRoot, '.swarm');
		fs.mkdirSync(path.join(swarmDir, 'automation-status.json'), {
			recursive: true,
		});
		const artifact = new AutomationStatusArtifact(swarmDir);

		expect(() =>
			artifact.updateConfig('auto', {
				plan_sync: false,
				phase_preflight: false,
				config_doctor_on_startup: false,
				config_doctor_autofix: false,
				evidence_auto_summaries: false,
				decision_drift_detection: false,
			}),
		).not.toThrow();

		const failures = failureLogs();
		expect(failures.length).toBeGreaterThan(0);
		// POSIX surfaces EISDIR here; Windows surfaces ENOTDIR/EEXIST — either
		// way it must be a bounded directory-conflict category, never a throw.
		expect(['path_is_directory', 'dir_conflict']).toContain(
			failures[0].category,
		);
		expect(['EISDIR', 'ENOTDIR', 'EEXIST', 'EPERM']).toContain(
			failures[0].code,
		);
	});

	test('healthy write lands the JSON artifact and emits no failure diagnostic', () => {
		const swarmDir = path.join(tmpRoot, '.swarm');
		const artifact = new AutomationStatusArtifact(swarmDir);

		artifact.updateConfig('hybrid', {
			plan_sync: true,
			phase_preflight: false,
			config_doctor_on_startup: false,
			config_doctor_autofix: false,
			evidence_auto_summaries: false,
			decision_drift_detection: false,
		});

		const artifactPath = path.join(swarmDir, 'automation-status.json');
		expect(fs.existsSync(artifactPath)).toBe(true);
		const persisted = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as {
			mode: string;
		};
		expect(persisted.mode).toBe('hybrid');
		expect(failureLogs()).toEqual([]);
	});

	test('read-only swarm directory (POSIX): contained failure classified permission', async () => {
		if (process.platform === 'win32') {
			console.warn('[status-artifact-2669] SKIP readonly fixture on win32');
			return;
		}
		const { chmodSync } = await import('node:fs');
		const swarmDir = path.join(tmpRoot, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		chmodSync(swarmDir, 0o500);
		const artifact = new AutomationStatusArtifact(swarmDir);

		expect(() =>
			artifact.updateConfig('hybrid', {
				plan_sync: false,
				phase_preflight: false,
				config_doctor_on_startup: false,
				config_doctor_autofix: false,
				evidence_auto_summaries: false,
				decision_drift_detection: false,
			}),
		).not.toThrow();

		const failures = failureLogs();
		expect(failures.length).toBeGreaterThan(0);
		expect(failures[0].category).toBe('permission');
	});
	test('shared-instance registry: preflight-side recordOutcome cannot clobber deferred init config', () => {
		const swarmDir = path.join(tmpRoot, '.swarm-shared');
		// Production init ordering: the preflight integration constructs its
		// artifact DURING init (before the deferred task runs), so a raw
		// constructor here holds the pre-init (manual) snapshot.
		const staleSibling = new AutomationStatusArtifact(swarmDir);

		const artifact = getSharedAutomationStatusArtifact(swarmDir);

		// Deferred init task writes the opt-in config...
		artifact.updateConfig('hybrid', {
			plan_sync: false,
			phase_preflight: true,
			config_doctor_on_startup: false,
			config_doctor_autofix: false,
			evidence_auto_summaries: false,
			decision_drift_detection: false,
		});

		// ...the preflight integration resolves the SAME instance (it
		// constructs during init, before the deferred task runs)...
		expect(getSharedAutomationStatusArtifact(swarmDir)).toBe(artifact);

		// ...so a later handler-time recordOutcome preserves the config
		// instead of clobbering it with a stale snapshot.
		artifact.recordOutcome('success', 2, 'ok');
		const persisted = JSON.parse(
			fs.readFileSync(path.join(swarmDir, 'automation-status.json'), 'utf-8'),
		) as {
			mode: string;
			enabled: boolean;
			lastOutcome: { state: string } | null;
		};
		expect(persisted.mode).toBe('hybrid');
		expect(persisted.enabled).toBe(true);
		expect(persisted.lastOutcome?.state).toBe('success');
		expect(failureLogs()).toEqual([]);

		// Hazard pin: had the integration kept its own instance, its stale
		// manual snapshot would clobber the deferred config — this is why
		// production sites must go through the shared registry.
		staleSibling.recordOutcome('failure', 1, 'stale');
		const clobbered = JSON.parse(
			fs.readFileSync(path.join(swarmDir, 'automation-status.json'), 'utf-8'),
		) as { mode: string; enabled: boolean };
		expect(clobbered.mode).toBe('manual');
		expect(clobbered.enabled).toBe(false);
	});
});
