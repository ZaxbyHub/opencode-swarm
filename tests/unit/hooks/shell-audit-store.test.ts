/**
 * Store-contract tests for src/hooks/guardrails/shell-audit-store.ts
 * (issue #2040): budgets, decision-class priority, torn tails, corrupt lines,
 * oversize lines, lock contention, maintenance triggering, legacy migration,
 * and manifest counters.
 *
 * Budget tests override `_internals.limits` (AGENTS.md invariant 7 DI seam)
 * and restore in afterEach.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	_internals,
	_resetMaintenanceCounters,
	appendShellAuditLineSync,
	compactShellAudit,
	finalizeShellAuditForClose,
	getShellAuditFoldedSummary,
	readShellAuditTail,
	shellAuditFilePath,
	withShellAuditStoreLock,
	SHELL_AUDIT_LIMITS,
	SHELL_AUDIT_LINE_TOO_LARGE,
	SHELL_AUDIT_STORE_LOCKED,
} from '../../../src/hooks/guardrails/shell-audit-store';

const REAL_LIMITS = _internals.limits;

async function mkTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'shell-audit-store-test-'));
}

const FRESH_TS = new Date().toISOString();

function legacyShellLine(i: number, ts = FRESH_TS): string {
	return `${JSON.stringify({
		ts,
		sessionID: 's',
		agent: 'coder',
		tool: 'bash',
		command: `echo ${i}`,
	})}\n`;
}

function securityLine(i: number, ts = FRESH_TS): string {
	return `${JSON.stringify({
		type: 'destructive_block',
		ts,
		sessionID: 's',
		agent: 'coder',
		tool: 'bash',
		command: `rm -rf /${i}`,
		destructiveCategory: 'dangerous_delete',
	})}\n`;
}

function fileSize(dir: string): number {
	return readFileSync(shellAuditFilePath(dir), 'utf-8').length;
}

function decisionLines(dir: string): string[] {
	return readFileSync(shellAuditFilePath(dir), 'utf-8')
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.slice(1); // strip manifest header
}

/** Accelerate `now` so age-based folding sees old timestamps. */
function ageEverything(dir: string): void {
	// Rewrite every ts 30 days in the past, preserving structure.
	const p = shellAuditFilePath(dir);
	const lines = readFileSync(p, 'utf-8').split('\n');
	const out: string[] = [];
	for (const line of lines) {
		if (line.trim() === '') {
			out.push(line);
			continue;
		}
		try {
			const obj = JSON.parse(line) as Record<string, unknown>;
			if (typeof obj.ts === 'string') {
				obj.ts = new Date(
					Date.parse(obj.ts) - 30 * 24 * 60 * 60 * 1000,
				).toISOString();
			}
			out.push(JSON.stringify(obj));
		} catch {
			out.push(line);
		}
	}
	writeFileSync(p, out.join('\n'), 'utf-8');
}

beforeEach(() => {
	_resetMaintenanceCounters();
});

afterEach(() => {
	_internals.limits = REAL_LIMITS;
	_resetMaintenanceCounters();
});

describe('appendShellAuditLineSync — first write + framing', () => {
	test('first write creates manifest header + decision atomically; line preserved byte-for-byte', async () => {
		const dir = await mkTempDir();
		const line = securityLine(1);
		appendShellAuditLineSync(dir, line);

		const raw = readFileSync(shellAuditFilePath(dir), 'utf-8');
		const lines = raw.split('\n');
		expect(JSON.parse(lines[0]!).type).toBe('swarm-shell-audit-manifest');
		expect(`${lines[1]}\n`).toBe(line);
		expect(lines[lines.length - 1]).toBe(''); // trailing newline

		await rm(dir, { recursive: true, force: true });
	});

	test('legacy shell lines and security lines both append verbatim', async () => {
		const dir = await mkTempDir();
		const l1 = legacyShellLine(1);
		const l2 = securityLine(1);
		appendShellAuditLineSync(dir, l1);
		appendShellAuditLineSync(dir, l2);

		const lines = decisionLines(dir);
		expect(lines.length).toBe(2);
		expect(`${lines[0]}\n`).toBe(l1);
		expect(`${lines[1]}\n`).toBe(l2);

		await rm(dir, { recursive: true, force: true });
	});

	test('oversize line throws the typed error and writes nothing', async () => {
		const dir = await mkTempDir();
		const huge = `${JSON.stringify({
			type: 'sandbox_wrap',
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 's',
			agent: 'a',
			tool: 't',
			command: 'x'.repeat(200_000),
			executorMechanism: 'm',
		})}\n`;
		expect(() => appendShellAuditLineSync(dir, huge)).toThrow(
			SHELL_AUDIT_LINE_TOO_LARGE,
		);
		expect(existsSync(shellAuditFilePath(dir))).toBe(false);

		await rm(dir, { recursive: true, force: true });
	});

	test('torn tail (crash mid-line) is re-framed on next append, not concatenated', async () => {
		const dir = await mkTempDir();
		const l1 = legacyShellLine(1);
		appendShellAuditLineSync(dir, l1);
		// Simulate a crash mid-append: strip the trailing newline.
		const p = shellAuditFilePath(dir);
		writeFileSync(p, readFileSync(p, 'utf-8').replace(/\n$/, ''), 'utf-8');

		const l2 = legacyShellLine(2);
		appendShellAuditLineSync(dir, l2);

		const lines = decisionLines(dir);
		expect(lines.length).toBe(2);
		expect(JSON.parse(lines[1]!).command).toBe('echo 2');

		await rm(dir, { recursive: true, force: true });
	});
});

describe('readShellAuditTail — bounded reads + coverage', () => {
	test('absent file → empty coverage', async () => {
		const dir = await mkTempDir();
		expect(readShellAuditTail(dir)).toEqual({
			text: '',
			truncated: false,
			coverage: 'empty',
		});
		await rm(dir, { recursive: true, force: true });
	});

	test('small store → complete coverage, manifest stripped', async () => {
		const dir = await mkTempDir();
		appendShellAuditLineSync(dir, legacyShellLine(1));
		const result = readShellAuditTail(dir);
		expect(result.coverage).toBe('complete');
		expect(result.truncated).toBe(false);
		expect(result.text).toContain('echo 1');
		expect(result.text).not.toContain('swarm-shell-audit-manifest');

		await rm(dir, { recursive: true, force: true });
	});

	test('legacy header-less file is read as-is (no manifest required)', async () => {
		const dir = await mkTempDir();
		const p = shellAuditFilePath(dir);
		const dirSession = join(dir, '.swarm', 'session');
		const { mkdirSync } = await import('node:fs');
		mkdirSync(dirSession, { recursive: true });
		writeFileSync(p, legacyShellLine(1) + legacyShellLine(2), 'utf-8');

		const result = readShellAuditTail(dir);
		expect(result.coverage).toBe('complete');
		expect(result.text).toContain('echo 1');
		expect(result.text).toContain('echo 2');

		await rm(dir, { recursive: true, force: true });
	});

	test('oversized legacy file → truncated coverage, torn first line dropped, only tail bytes read', async () => {
		const dir = await mkTempDir();
		const dirSession = join(dir, '.swarm', 'session');
		const { mkdirSync } = await import('node:fs');
		mkdirSync(dirSession, { recursive: true });
		const p = shellAuditFilePath(dir);
		// ~600 KiB of legacy lines — beyond the 256 KiB read bound.
		const chunk = Array.from({ length: 6_000 }, (_, i) =>
			legacyShellLine(i),
		).join('');
		writeFileSync(p, chunk, 'utf-8');

		const result = readShellAuditTail(dir, 64 * 1024);
		expect(result.coverage).toBe('truncated');
		expect(result.truncated).toBe(true);
		// The window NEVER contains a torn first line: every line parses.
		for (const line of result.text.split('\n')) {
			if (line.trim() === '') continue;
			expect(() => JSON.parse(line)).not.toThrow();
		}
		// The newest entries are in the window, the oldest are not.
		expect(result.text).toContain('echo 5999');
		expect(result.text).not.toContain('echo 0\n');
		expect(result.text.length).toBeLessThanOrEqual(64 * 1024);

		await rm(dir, { recursive: true, force: true });
	});
});

describe('foldPass — budgets + decision-class priority', () => {
	test('allowed-class entries age-fold; security-class entries survive the same age', async () => {
		const dir = await mkTempDir();
		for (let i = 0; i < 5; i += 1) {
			appendShellAuditLineSync(dir, legacyShellLine(i));
			appendShellAuditLineSync(dir, securityLine(i));
		}
		ageEverything(dir);
		compactShellAudit(dir);

		const lines = decisionLines(dir);
		// All security lines survive; all allowed lines aged out.
		expect(lines.length).toBe(5);
		for (const line of lines) {
			expect(JSON.parse(line).type).toBe('destructive_block');
		}
		const folded = getShellAuditFoldedSummary(dir)!;
		expect(folded.totalDecisions).toBe(5);
		expect(folded.byType['shell']).toBe(5);
		expect(folded.dropped).toBe(5);

		await rm(dir, { recursive: true, force: true });
	});

	test('allowed-class count cap folds oldest allowed entries, security entries keep claiming budget', async () => {
		const dir = await mkTempDir();
		// 8 old allowed + 4 security, allowedMaxEntries shrunk to 3.
		_internals.limits = {
			...REAL_LIMITS,
			allowedMaxEntries: 3,
			checkInterval: 1_000_000, // maintenance only via compactShellAudit
		};
		for (let i = 0; i < 8; i += 1) {
			appendShellAuditLineSync(dir, legacyShellLine(i));
		}
		for (let i = 0; i < 4; i += 1) {
			appendShellAuditLineSync(dir, securityLine(i));
		}
		compactShellAudit(dir);

		const lines = decisionLines(dir);
		const byType = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
		// NEWEST 3 allowed survive (echo 5,6,7), all 4 security survive.
		const allowed = byType.filter((e) => e.type === undefined);
		const security = byType.filter((e) => e.type === 'destructive_block');
		expect(allowed.length).toBe(3);
		expect(security.length).toBe(4);
		expect(allowed.map((e) => e.command)).toEqual([
			'echo 5',
			'echo 6',
			'echo 7',
		]);

		await rm(dir, { recursive: true, force: true });
	});

	test('the byte ceiling is sovereign: oversized security lines fold oldest-first', async () => {
		const dir = await mkTempDir();
		_internals.limits = {
			...REAL_LIMITS,
			activeMaxBytes: 2_048,
			checkInterval: 1_000_000,
		};
		// Each security line ~180 bytes; 30 lines blow past 2 KiB.
		for (let i = 0; i < 30; i += 1) {
			appendShellAuditLineSync(dir, securityLine(i));
		}
		compactShellAudit(dir);

		expect(fileSize(dir)).toBeLessThanOrEqual(
			_internals.limits.activeMaxBytes + _internals.limits.headerMaxBytes + 2_048,
		);
		const folded = getShellAuditFoldedSummary(dir)!;
		expect(folded.totalDecisions).toBeGreaterThan(0);
		const lines = decisionLines(dir);
		// The NEWEST security lines survive preferentially.
		const commands = lines.map((l) => JSON.parse(l).command as string);
		expect(commands[commands.length - 1]).toBe('rm -rf /29');

		await rm(dir, { recursive: true, force: true });
	});

	test('corrupt lines fold counted corrupt; valid lines untouched', async () => {
		const dir = await mkTempDir();
		appendShellAuditLineSync(dir, legacyShellLine(1));
		appendShellAuditLineSync(dir, securityLine(1));
		// Corrupt the tail with a partial line.
		const p = shellAuditFilePath(dir);
		const raw = readFileSync(p, 'utf-8');
		writeFileSync(p, `${raw}{"torn": "partial`, 'utf-8');

		compactShellAudit(dir);

		const folded = getShellAuditFoldedSummary(dir)!;
		expect(folded.corrupt).toBe(1);
		const lines = decisionLines(dir);
		expect(lines.length).toBe(2); // both valid lines retained

		await rm(dir, { recursive: true, force: true });
	});

	test('maintenance triggers every checkInterval appends and converges an over-budget store', async () => {
		const dir = await mkTempDir();
		_internals.limits = {
			...REAL_LIMITS,
			allowedMaxEntries: 10,
			checkInterval: 5,
		};
		// 40 allowed appends → maintenance fires at 5,10,...,40 and the
		// allowed cap keeps the window at ≤10 retained.
		for (let i = 0; i < 40; i += 1) {
			appendShellAuditLineSync(dir, legacyShellLine(i));
		}

		const lines = decisionLines(dir);
		expect(lines.length).toBeLessThanOrEqual(10);
		const folded = getShellAuditFoldedSummary(dir)!;
		expect(folded.totalDecisions).toBeGreaterThanOrEqual(30);
		// Lifetime is preserved: folded + retained = 40.
		expect(folded.totalDecisions + lines.length).toBe(40);

		await rm(dir, { recursive: true, force: true });
	});

	test('checkInterval-driven maintenance converges a BYTE-over-budget store under its ceiling (reviewer round R4)', async () => {
		const dir = await mkTempDir();
		// Tiny byte ceiling with a large count budget: only the BYTE budget
		// binds, exercising the runMaintenance convergence loop's designed
		// scenario (drain below activeMaxBytes with repeated bounded passes).
		_internals.limits = {
			...REAL_LIMITS,
			activeMaxBytes: 3 * 1024,
			securityMaxEntries: 10_000,
			allowedMaxEntries: 10_000,
			checkInterval: 5,
			compactMaxBytes: 8 * 1024,
		};
		// Each security line is ~180 bytes; 60 lines is well over 3 KiB.
		// The pass budget exceeds the overshoot so a single maintenance
		// invocation converges (the amortized multi-pass path is covered by
		// the drain-threshold design; this test pins the converged bound).
		for (let i = 0; i < 60; i += 1) {
			appendShellAuditLineSync(dir, securityLine(i));
		}

		const size = fileSize(dir);
		// Tight bound: the foldPass byte budget bounds manifest + retained
		// lines, so a converged store sits just over activeMaxBytes — the
		// looser runMaintenance drain threshold must NOT be the excuse.
		expect(size).toBeLessThanOrEqual(
			_internals.limits.activeMaxBytes + 2048,
		);
		const folded = getShellAuditFoldedSummary(dir)!;
		const retained = decisionLines(dir).length;
		// Lifetime preserved exactly through the byte-pressure drain.
		expect(folded.totalDecisions + retained).toBe(60);
		// The NEWEST entries survive the drain.
		const commands = decisionLines(dir).map(
			(l) => JSON.parse(l).command as string,
		);
		expect(commands[commands.length - 1]).toBe('rm -rf /59');

		await rm(dir, { recursive: true, force: true });
	});
});

describe('legacy migration', () => {
	test('a legacy header-less file migrates to the manifest store on the first maintenance fold', async () => {
		const dir = await mkTempDir();
		const dirSession = join(dir, '.swarm', 'session');
		const { mkdirSync } = await import('node:fs');
		mkdirSync(dirSession, { recursive: true });
		const p = shellAuditFilePath(dir);
		writeFileSync(
			p,
			Array.from({ length: 4 }, (_, i) => legacyShellLine(i)).join(''),
			'utf-8',
		);

		compactShellAudit(dir);

		const firstLine = readFileSync(p, 'utf-8').split('\n')[0]!;
		expect(JSON.parse(firstLine).type).toBe('swarm-shell-audit-manifest');
		expect(decisionLines(dir).length).toBe(4);
		const folded = getShellAuditFoldedSummary(dir)!;
		expect(folded.totalDecisions).toBe(0); // nothing folded yet, just migrated

		await rm(dir, { recursive: true, force: true });
	});

	test('appending to a legacy header-less file keeps it readable in both forms', async () => {
		const dir = await mkTempDir();
		const dirSession = join(dir, '.swarm', 'session');
		const { mkdirSync } = await import('node:fs');
		mkdirSync(dirSession, { recursive: true });
		const p = shellAuditFilePath(dir);
		writeFileSync(p, legacyShellLine(0), 'utf-8');

		appendShellAuditLineSync(dir, legacyShellLine(1));

		const result = readShellAuditTail(dir);
		expect(result.text).toContain('echo 0');
		expect(result.text).toContain('echo 1');

		await rm(dir, { recursive: true, force: true });
	});
});

describe('locking', () => {
	test('a held lock makes the append throw the typed locked error (fail-open is the caller contract)', async () => {
		const dir = await mkTempDir();
		const acquired = withShellAuditStoreLock(dir, () => {
			// Lock is HELD here: a second acquisition attempt must fail.
			let threw: unknown = null;
			try {
				appendShellAuditLineSync(dir, legacyShellLine(99));
			} catch (err) {
				threw = err;
			}
			expect((threw as Error)?.message).toBe(SHELL_AUDIT_STORE_LOCKED);
			return true;
		});
		expect(acquired).toBe(true);
		// After release, the append succeeds.
		appendShellAuditLineSync(dir, legacyShellLine(99));
		expect(decisionLines(dir).length).toBe(1);

		await rm(dir, { recursive: true, force: true });
	});
});

describe('finalizeShellAuditForClose', () => {
	test('drains a legacy header-less file to a validated manifest cut and is idempotent', async () => {
		const dir = await mkTempDir();
		const dirSession = join(dir, '.swarm', 'session');
		const { mkdirSync } = await import('node:fs');
		mkdirSync(dirSession, { recursive: true });
		const p = shellAuditFilePath(dir);
		writeFileSync(
			p,
			Array.from({ length: 6 }, (_, i) => legacyShellLine(i)).join('') +
				securityLine(0),
			'utf-8',
		);

		finalizeShellAuditForClose(dir);

		const firstLine = readFileSync(p, 'utf-8').split('\n')[0]!;
		expect(JSON.parse(firstLine).type).toBe('swarm-shell-audit-manifest');
		expect(decisionLines(dir).length).toBe(7);

		// Idempotent: a second finalize does not lose or duplicate anything.
		finalizeShellAuditForClose(dir);
		expect(decisionLines(dir).length).toBe(7);
		const folded = getShellAuditFoldedSummary(dir)!;
		expect(folded.totalDecisions + decisionLines(dir).length).toBe(7);

		await rm(dir, { recursive: true, force: true });
	});

	test('absent store is a safe no-op', async () => {
		const dir = await mkTempDir();
		expect(() => finalizeShellAuditForClose(dir)).not.toThrow();
		expect(existsSync(shellAuditFilePath(dir))).toBe(false);
		await rm(dir, { recursive: true, force: true });
	});

	test('finalize releases the store lock (a stale lock is never left behind)', async () => {
		const dir = await mkTempDir();
		appendShellAuditLineSync(dir, legacyShellLine(1));
		finalizeShellAuditForClose(dir);
		const lockPath = join(dir, '.swarm', 'session', 'shell-audit.lock');
		expect(existsSync(lockPath)).toBe(false);

		await rm(dir, { recursive: true, force: true });
	});
});

describe('SHELL_AUDIT_LIMITS sanity', () => {
	test('limits match the documented contract (issue #2040)', () => {
		const limits = SHELL_AUDIT_LIMITS;
		expect(limits.activeMaxBytes).toBe(1024 * 1024);
		expect(limits.securityMaxEntries).toBe(4_000);
		expect(limits.allowedMaxEntries).toBe(2_000);
		expect(limits.allowedAgeMaxMs).toBe(72 * 60 * 60 * 1000);
		expect(limits.readMaxBytes).toBe(256 * 1024);
		expect(limits.maxLineBytes).toBe(64 * 1024);
	});
});
