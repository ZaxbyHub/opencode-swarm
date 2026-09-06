/**
 * Close-integration tests for the shell-audit store (issue #2040):
 * - finalizeShellAuditForClose produces an archived-readable, validated cut
 *   from legacy header-less and over-budget stores
 * - the /swarm close seam (`src/commands/close.ts` `_internals.finalizeShellAudit`)
 *   delegates to the store implementation
 * - the finalized cut survives the manifest round-trip the archive relies on
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
	_resetMaintenanceCounters,
	compactShellAudit,
	finalizeShellAuditForClose,
	getShellAuditFoldedSummary,
	readShellAuditTail,
	shellAuditFilePath,
	_internals as storeInternals,
} from '../../../src/hooks/guardrails/shell-audit-store';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const FRESH_NOW = Date.parse('2026-06-01T00:00:00.000Z');
const REAL_LIMITS = storeInternals.limits;

async function mkTempDir(): Promise<string> {
	return canonicalMkdtemp('shell-audit-close-test-');
}

function writeLegacyStore(dir: string, lines: string[]): void {
	const sessionDir = join(dir, '.swarm', 'session');
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(shellAuditFilePath(dir), lines.join(''), 'utf-8');
}

function legacyShell(
	i: number,
	ts = new Date(FRESH_NOW).toISOString(),
): string {
	return `${JSON.stringify({
		ts,
		sessionID: 's',
		agent: 'coder',
		tool: 'bash',
		command: `echo ${i}`,
	})}\n`;
}

let restoreClock: () => void = () => {};

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: FRESH_NOW });
	_resetMaintenanceCounters();
});

afterEach(() => {
	storeInternals.limits = REAL_LIMITS;
	_resetMaintenanceCounters();
	restoreClock();
	restoreClock = () => {};
});

describe('finalizeShellAuditForClose — the archived cut', () => {
	test('a legacy header-less multi-KiB store drains to a manifest-headed, validated cut the archive can copy verbatim', async () => {
		const dir = await mkTempDir();
		const lines = Array.from({ length: 200 }, (_, i) => legacyShell(i));
		writeLegacyStore(dir, lines);

		finalizeShellAuditForClose(dir);

		const raw = readFileSync(shellAuditFilePath(dir), 'utf-8');
		const split = raw.split('\n');
		expect(JSON.parse(split[0]!).type).toBe('swarm-shell-audit-manifest');
		expect(split[split.length - 1]).toBe(''); // trailing newline — clean JSONL cut
		// Every retained line parses and is byte-identical to what was written.
		const retained = split.slice(1, -1);
		for (const line of retained) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		// All 200 lines survive under the default budgets.
		expect(retained.length).toBe(200);

		await rm(dir, { recursive: true, force: true });
	});

	test('an over-budget store finalizes to within the byte ceiling with lifetime totals preserved', async () => {
		const dir = await mkTempDir();
		storeInternals.limits = {
			...REAL_LIMITS,
			activeMaxBytes: 4_096,
			securityMaxEntries: 5,
		};
		const lines = Array.from(
			{ length: 60 },
			(_, i) =>
				`${JSON.stringify({
					type: 'scope_violation',
					ts: new Date(FRESH_NOW).toISOString(),
					sessionID: 's',
					agent: 'coder',
					tool: 'bash',
					path: `/etc/x/${i}`,
					declaredScope: '/project',
					resolvedScope: '/etc',
					action: 'write',
				})}\n`,
		);
		writeLegacyStore(dir, lines);

		finalizeShellAuditForClose(dir);

		const folded = getShellAuditFoldedSummary(dir)!;
		const raw = readFileSync(shellAuditFilePath(dir), 'utf-8');
		const retained = raw.split('\n').filter((l) => l.trim()).length - 1;
		// Lifetime preserved exactly: folded + retained = 60.
		expect(folded.totalDecisions + retained).toBe(60);
		// Count cap enforced (5 security entries retained).
		expect(retained).toBeLessThanOrEqual(5);

		await rm(dir, { recursive: true, force: true });
	});

	test('the finalized cut is readable by the bounded reader with complete coverage', async () => {
		const dir = await mkTempDir();
		writeLegacyStore(dir, [legacyShell(1), legacyShell(2)]);

		finalizeShellAuditForClose(dir);

		const window = readShellAuditTail(dir);
		expect(window.coverage).toBe('complete');
		expect(window.text).toContain('echo 1');
		expect(window.text).toContain('echo 2');

		await rm(dir, { recursive: true, force: true });
	});

	test('finalize is fail-open: it never throws, even on a corrupt store', async () => {
		const dir = await mkTempDir();
		const sessionDir = join(dir, '.swarm', 'session');
		mkdirSync(sessionDir, { recursive: true });
		// Entirely unparseable content — finalize must not propagate errors.
		writeFileSync(shellAuditFilePath(dir), '{{{not json', 'utf-8');

		expect(() => finalizeShellAuditForClose(dir)).not.toThrow();

		await rm(dir, { recursive: true, force: true });
	});

	test('no lock file remains after finalize (stale locks are never archived)', async () => {
		const dir = await mkTempDir();
		writeLegacyStore(dir, [legacyShell(1)]);

		finalizeShellAuditForClose(dir);

		expect(existsSync(join(dir, '.swarm', 'session', 'shell-audit.lock'))).toBe(
			false,
		);

		await rm(dir, { recursive: true, force: true });
	});
});

describe('close archive-stage ordering source-contract (issue #2040)', () => {
	test('the shell-audit finalize runs BEFORE both archive loops (validated cut before copy)', () => {
		const closeSource = readFileSync(
			join(
				import.meta.dir,
				'..',
				'..',
				'..',
				'src',
				'commands',
				'close',
				'archive-stage.ts',
			),
			'utf-8',
		);
		// The finalize-before-archive wiring must EXIST and be ORDERED ahead of
		// both the flat-artifact copy loop and the session/ directory copy loop.
		// A refactor that moves the call after the copies, or into a dead
		// branch, must fail here (the #2037 close-context-telemetry-archive
		// precedent).
		const finalizeIndex = closeSource.indexOf('_internals.finalizeShellAudit(');
		const flatLoopIndex = closeSource.indexOf(
			'for (const artifact of ARCHIVE_ARTIFACTS)',
		);
		const dirLoopIndex = closeSource.indexOf(
			'for (const dirName of ACTIVE_STATE_DIRS_TO_CLEAN)',
		);
		expect(finalizeIndex).toBeGreaterThan(-1);
		expect(flatLoopIndex).toBeGreaterThan(-1);
		expect(dirLoopIndex).toBeGreaterThan(-1);
		expect(finalizeIndex).toBeLessThan(flatLoopIndex);
		expect(finalizeIndex).toBeLessThan(dirLoopIndex);
	});
});

describe('close.ts seam delegation', () => {
	test('close _internals.finalizeShellAudit delegates to the store finalize (observable via the manifest cut)', async () => {
		const dir = await mkTempDir();
		writeLegacyStore(dir, [legacyShell(1), legacyShell(2)]);

		const closeInternals = (await import('../../../src/commands/close.js'))
			._internals;
		closeInternals.finalizeShellAudit(dir);

		const firstLine = readFileSync(shellAuditFilePath(dir), 'utf-8').split(
			'\n',
		)[0]!;
		expect(JSON.parse(firstLine).type).toBe('swarm-shell-audit-manifest');

		await rm(dir, { recursive: true, force: true });
	});
});

describe('compactShellAudit — external trigger parity', () => {
	test('compactShellAudit is fail-open on a corrupt store', async () => {
		const dir = await mkTempDir();
		const sessionDir = join(dir, '.swarm', 'session');
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(shellAuditFilePath(dir), 'not-json-at-all\n', 'utf-8');

		expect(() => compactShellAudit(dir)).not.toThrow();

		await rm(dir, { recursive: true, force: true });
	});
});

describe('review-round fixes — archive-boundary re-redaction (F4 / RC-gap1)', () => {
	test('the close seam re-redacts a weakly-redacted legacy line in the archived cut', async () => {
		const dir = await mkTempDir();
		// Pre-#2040 legacy line: URL credentials the old writer never redacted.
		writeLegacyStore(dir, [
			`${JSON.stringify({
				ts: new Date(FRESH_NOW).toISOString(),
				sessionID: 's',
				agent: 'coder',
				tool: 'bash',
				command: 'curl https://alice:archivesecret7@example.com/api',
			})}\n`,
		]);

		const closeInternals = (await import('../../../src/commands/close.js'))
			._internals;
		closeInternals.finalizeShellAudit(dir);

		const raw = readFileSync(shellAuditFilePath(dir), 'utf-8');
		const firstLine = raw.split('\n')[0]!;
		expect(JSON.parse(firstLine).type).toBe('swarm-shell-audit-manifest');
		// The archived cut re-redacts the legacy line — no archive bypass.
		expect(raw).not.toContain('archivesecret7');
		expect(raw).toContain('[REDACTED]');

		await rm(dir, { recursive: true, force: true });
	});

	test('finalizeShellAuditForClose applies an explicit lineTransform under the lock', async () => {
		const dir = await mkTempDir();
		writeLegacyStore(dir, [legacyShell(1)]);

		finalizeShellAuditForClose(dir, {
			lineTransform: (line) => line.replace('echo 1', 'echo [transformed]'),
		});

		const raw = readFileSync(shellAuditFilePath(dir), 'utf-8');
		expect(raw).toContain('echo [transformed]');

		await rm(dir, { recursive: true, force: true });
	});
});
