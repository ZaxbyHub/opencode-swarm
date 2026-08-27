/**
 * Bounds/retention tests for src/hooks/guardrails/shell-audit-store.ts
 * (issue #2040): foldPass budgets + decision-class priority, legacy
 * migration (bounded streaming + corrupt-only), locking, and the review-round
 * fixes — append-time byte enforcement (RC-4) and the rotation-race read
 * retry (RC-3).
 *
 * Budget tests override `_internals.limits` (AGENTS.md invariant 7 DI seam)
 * and restore in afterEach.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
	SHELL_AUDIT_LIMITS,
	SHELL_AUDIT_STORE_LOCKED,
	shellAuditFilePath,
	withShellAuditStoreLock,
} from '../../../src/hooks/guardrails/shell-audit-store';

const REAL_LIMITS = _internals.limits;

async function mkTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'shell-audit-bounds-test-'));
}

const FRESH_TS = new Date().toISOString();

function legacyShellLine(i: number, ts = FRESH_TS): string {
	return `${JSON.stringify({
		ts,
		sessionID: 's',
		agent: 'coder',
		tool: 'bash',
		command: `echo ${i}`,
	})}
`;
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
	})}
`;
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

function writeLegacyStore(dir: string, lines: string[]): void {
	const sessionDir = join(dir, '.swarm', 'session');
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(shellAuditFilePath(dir), lines.join(''), 'utf-8');
}

beforeEach(() => {
	_resetMaintenanceCounters();
});

afterEach(() => {
	_internals.limits = REAL_LIMITS;
	_resetMaintenanceCounters();
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
			_internals.limits.activeMaxBytes +
				_internals.limits.headerMaxBytes +
				2_048,
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
		expect(size).toBeLessThanOrEqual(_internals.limits.activeMaxBytes + 2048);
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

	test('a PRE-EXISTING lock file exhausts the bounded retry window (cross-process timeout path)', async () => {
		const dir = await mkTempDir();
		// Simulate another process holding the lock: the file exists and its
		// mtime is FRESH (inside the 5-minute stale window), so every
		// tryLockOnce attempt fails for the full 20×5 ms window.
		const sessionDir = join(dir, '.swarm', 'session');
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, 'shell-audit.lock'), 'held', 'utf-8');

		let threw: unknown = null;
		const t0 = Date.now();
		try {
			appendShellAuditLineSync(dir, legacyShellLine(1));
		} catch (err) {
			threw = err;
		}
		const elapsed = Date.now() - t0;
		expect((threw as Error)?.message).toBe(SHELL_AUDIT_STORE_LOCKED);
		// The bounded retry window actually ran (~100 ms, allow slop).
		expect(elapsed).toBeGreaterThanOrEqual(50);
		// Nothing was written — the store file was never created.
		let exists = true;
		try {
			readFileSync(shellAuditFilePath(dir));
		} catch {
			exists = false;
		}
		expect(exists).toBe(false);

		await rm(dir, { recursive: true, force: true });
	});
});

describe('review-round fixes — RC-4 append-time byte enforcement', () => {
	test('the byte ceiling holds IMMEDIATELY after every append, not only after the maintenance tick', async () => {
		const dir = await mkTempDir();
		_internals.limits = {
			...REAL_LIMITS,
			activeMaxBytes: 2 * 1024,
			checkInterval: 1_000_000, // maintenance NEVER fires in this test
			compactMaxBytes: 64 * 1024,
		};
		// Each security line is ~180 bytes; appends 1..N cross 2 KiB quickly.
		for (let i = 0; i < 40; i += 1) {
			appendShellAuditLineSync(dir, securityLine(i));
			const size = fileSize(dir);
			expect(size).toBeLessThanOrEqual(
				_internals.limits.activeMaxBytes + _internals.limits.headerMaxBytes,
			);
		}
		// Lifetime preserved exactly through the immediate folds.
		const folded = getShellAuditFoldedSummary(dir)!;
		expect(folded.totalDecisions + decisionLines(dir).length).toBe(40);

		await rm(dir, { recursive: true, force: true });
	});
});

describe('review-round fixes — RC-2 bounded streaming legacy migration', () => {
	test('an oversized legacy file migrates through the streaming reader with lifetime counters preserved', async () => {
		const dir = await mkTempDir();
		_internals.limits = {
			...REAL_LIMITS,
			// Tiny migration cap so the 100-line legacy file (≈9 KiB) takes the
			// STREAMING path instead of the materializing read.
			migrationMaxBytes: 4 * 1024,
			checkInterval: 1_000_000,
		};
		const lines = Array.from({ length: 100 }, (_, i) => legacyShellLine(i));
		writeLegacyStore(dir, lines);

		compactShellAudit(dir);

		// The rewrite lands in the bounded manifest+window layout.
		const raw = readFileSync(shellAuditFilePath(dir), 'utf-8');
		const split = raw.split('\n');
		expect(JSON.parse(split[0]!).type).toBe('swarm-shell-audit-manifest');
		expect(raw.length).toBeLessThanOrEqual(
			_internals.limits.activeMaxBytes + _internals.limits.headerMaxBytes,
		);
		// Lifetime preserved EXACTLY: folded prefix + retained window = 100.
		const folded = getShellAuditFoldedSummary(dir)!;
		const retained = split.filter((l) => l.trim().length > 0).length - 1;
		expect(folded.totalDecisions + retained).toBe(100);
		// The NEWEST entries are the retained window.
		const commands = split
			.slice(1)
			.filter((l) => l.trim().length > 0)
			.map((l) => JSON.parse(l).command as string);
		expect(commands[commands.length - 1]).toBe('echo 99');

		await rm(dir, { recursive: true, force: true });
	});

	test('multibyte UTF-8 chars straddling a chunk boundary survive intact (final-critic round)', async () => {
		const dir = await mkTempDir();
		_internals.limits = {
			...REAL_LIMITS,
			migrationMaxBytes: 2 * 1024, // force the streaming path
			compactMaxBytes: 512, // → chunkBytes = max(1 KiB, 1 KiB) = 1 KiB
			checkInterval: 1_000_000,
		};
		// Line 0 places a 3-byte CJK char (你) so its LEAD BYTE sits exactly on
		// the 1024-byte chunk boundary (bytes 1023/1024 straddle). The pad is
		// COMPUTED from the serialized bytes so the geometry is self-verifying
		// and cannot silently drift into chunk 2 (the reviewer round proved a
		// hardcoded pad put the char at offset 1110 — inside chunk 2 — making
		// the assertion vacuous). The pre-fix decoded-length offset advance
		// corrupted the char to U+FFFD and skipped a continuation byte.
		const cjk = '你';
		const envelope = (cmd: string) =>
			`${JSON.stringify({
				ts: FRESH_TS,
				sessionID: 's',
				agent: 'coder',
				tool: 'bash',
				command: cmd,
			})}\n`;
		let pad = 0;
		let leadOffset = -1;
		do {
			pad += 1;
			const probe = envelope(`echo ${'a'.repeat(pad)}${cjk}end`);
			const idx = probe.indexOf(cjk);
			leadOffset = Buffer.byteLength(probe.slice(0, idx), 'utf-8');
		} while (leadOffset < 1023 && pad < 5_000);
		// The pad MUST land the lead byte exactly on the boundary — every pad
		// char is ASCII so the byte offset takes every integer value.
		expect(leadOffset).toBe(1023);
		const longCommand = `echo ${'a'.repeat(pad)}${cjk}end`;
		const straddler = envelope(longCommand);
		const filler = Array.from({ length: 20 }, (_, i) =>
			legacyShellLine(i),
		).join('');
		writeLegacyStore(dir, [straddler, filler]);

		compactShellAudit(dir);

		const raw = readFileSync(shellAuditFilePath(dir), 'utf-8');
		const split = raw.split('\n');
		expect(JSON.parse(split[0]!).type).toBe('swarm-shell-audit-manifest');
		// No replacement characters anywhere — the straddling char survived.
		expect(raw).not.toContain('\uFFFD');
		const folded = getShellAuditFoldedSummary(dir)!;
		const retained = split.filter((l) => l.trim().length > 0).length - 1;
		// Lifetime EXACT — no line lost to the boundary bug (21 lines total).
		expect(folded.totalDecisions + retained).toBe(21);
		expect(folded.corrupt).toBe(0);

		await rm(dir, { recursive: true, force: true });
	});
});

describe('review-round fixes — F12 corrupt-only legacy files', () => {
	test('a legacy file of ONLY corrupt lines is migrated to a manifest store counting the corruption', async () => {
		const dir = await mkTempDir();
		writeLegacyStore(dir, ['not-json-a\n', 'also not json\n', '{bad\n']);

		finalizeShellAuditForClose(dir);

		const raw = readFileSync(shellAuditFilePath(dir), 'utf-8');
		const split = raw.split('\n');
		expect(JSON.parse(split[0]!).type).toBe('swarm-shell-audit-manifest');
		const folded = getShellAuditFoldedSummary(dir)!;
		expect(folded.corrupt).toBe(3);
		// No decision lines retained; the file is now the bounded manifest cut.
		expect(split.filter((l) => l.trim().length > 0).length).toBe(1);

		await rm(dir, { recursive: true, force: true });
	});

	test('PRR-019a: a valid-JSON NON-manifest line 1 is treated as a decision line, not lost', async () => {
		const dir = await mkTempDir();
		// First line is parseable JSON but NOT the manifest discriminator — it
		// must land in the retained window after migration, never silently
		// swallowed as a phantom header.
		writeLegacyStore(dir, [legacyShellLine(0), legacyShellLine(1)]);

		compactShellAudit(dir);

		const raw = readFileSync(shellAuditFilePath(dir), 'utf-8');
		const split = raw.split('\n');
		expect(JSON.parse(split[0]!).type).toBe('swarm-shell-audit-manifest');
		const decisions = split.slice(1).filter((l) => l.trim().length > 0);
		expect(decisions.length).toBe(2);
		expect(JSON.parse(decisions[0]!).command).toBe('echo 0');
		expect(JSON.parse(decisions[1]!).command).toBe('echo 1');
		const folded = getShellAuditFoldedSummary(dir)!;
		expect(folded.totalDecisions).toBe(0); // nothing folded — all retained
		expect(folded.corrupt).toBe(0);

		await rm(dir, { recursive: true, force: true });
	});
});

describe('review-round fixes — RC-3 rotation-race read retry', () => {
	test('a truncated read that comes back EMPTY retries against the current file', async () => {
		const dir = await mkTempDir();
		_internals.limits = {
			...REAL_LIMITS,
			readMaxBytes: 4 * 1024,
			checkInterval: 1_000_000,
		};
		// Build a real store larger than the read bound.
		for (let i = 0; i < 40; i += 1) {
			appendShellAuditLineSync(dir, legacyShellLine(i));
		}
		// Simulate the race: the outer stat sees the OLD (large) size, but the
		// chunk read happens AFTER a compaction shrank the file — the first
		// readSync returns nothing, the retry path re-stats and succeeds.
		const realReadSync = _internals.readSync;
		let firstCall = true;
		(_internals as { readSync: typeof realReadSync }).readSync = (
			fd,
			buffer,
			offset,
			length,
			position,
		) => {
			if (firstCall) {
				firstCall = false;
				return 0; // empty read — stale offset past the new (smaller) file
			}
			return realReadSync(fd, buffer, offset, length, position);
		};
		try {
			const result = readShellAuditTail(dir);
			expect(result.coverage).not.toBe('empty');
			expect(result.text).toContain('echo 39');
		} finally {
			(_internals as { readSync: typeof realReadSync }).readSync = realReadSync;
		}

		await rm(dir, { recursive: true, force: true });
	});
});
