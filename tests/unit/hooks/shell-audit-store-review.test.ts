/**
 * Review-round regression tests for the shell-audit store (PR #2374
 * feedback): append-time byte enforcement (RC-4), bounded streaming legacy
 * migration incl. the UTF-8 chunk-boundary straddle (RC-2 + final-critic),
 * corrupt-only legacy migration (F12), the rotation-race read retry (RC-3),
 * write-boundary truncation, and appending into a legacy header-less store.
 *
 * Budget tests override `_internals.limits` (AGENTS.md invariant 7 DI seam)
 * and restore in afterEach.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	_internals,
	_resetMaintenanceCounters,
	appendShellAuditLineSync,
	compactShellAudit,
	finalizeShellAuditForClose,
	getShellAuditFoldedSummary,
	readShellAuditTail,
	SHELL_AUDIT_STORE_LOCKED,
	shellAuditFilePath,
} from '../../../src/hooks/guardrails/shell-audit-store';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const REAL_LIMITS = _internals.limits;

async function mkTempDir(): Promise<string> {
	return canonicalMkdtemp('shell-audit-review-test-');
}

const FRESH_NOW = Date.parse('2026-06-01T00:00:00.000Z');
let restoreClock: () => void = () => {};

const FRESH_TS = new Date(FRESH_NOW).toISOString();

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

function writeLegacyStore(dir: string, lines: string[]): void {
	const sessionDir = join(dir, '.swarm', 'session');
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(shellAuditFilePath(dir), lines.join(''), 'utf-8');
}

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: FRESH_NOW });
	_resetMaintenanceCounters();
});

afterEach(() => {
	_internals.limits = REAL_LIMITS;
	_resetMaintenanceCounters();
	restoreClock();
	restoreClock = () => {};
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

describe('write-boundary truncation (moved from audit-log suite)', () => {
	test('giant command is truncated to maxCommandChars with an explicit marker', async () => {
		const dir = await mkTempDir();
		const { appendGuardrailDecision } = await import(
			'../../../src/hooks/guardrails/audit-log'
		);
		await appendGuardrailDecision(
			{
				type: 'shell',
				ts: FRESH_TS,
				sessionID: 'sess-big',
				agent: 'coder',
				tool: 'bash',
				command: `echo ${'a'.repeat(50_000)}`,
			},
			{ directory: dir, enabled: true },
		);
		const lines = readFileSync(shellAuditFilePath(dir), 'utf-8')
			.split('\n')
			.filter((l) => l.trim().length > 0);
		const decision = JSON.parse(lines[lines.length - 1]!) as {
			command: string;
		};
		expect(decision.command.length).toBeLessThan(5_000);
		expect(decision.command).toContain('…[truncated]');
		expect(Buffer.byteLength(lines[lines.length - 1]!)).toBeLessThan(64 * 1024);
		await rm(dir, { recursive: true, force: true });
	});
});

describe('append into a legacy header-less store (MS-gap2, moved from audit-log suite)', () => {
	test('appending keeps the store readable in both forms', async () => {
		const dir = await mkTempDir();
		const legacy = JSON.stringify({
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 's',
			agent: 'coder',
			tool: 'bash',
			command: 'echo legacy',
		});
		const { mkdir } = await import('node:fs/promises');
		await mkdir(join(dir, '.swarm', 'session'), { recursive: true });
		await writeFile(shellAuditFilePath(dir), `${legacy}\n`, 'utf-8');
		const { appendGuardrailDecision } = await import(
			'../../../src/hooks/guardrails/audit-log'
		);
		await appendGuardrailDecision(
			{
				type: 'shell',
				ts: '2026-01-01T00:00:01.000Z',
				sessionID: 's',
				agent: 'coder',
				tool: 'bash',
				command: 'echo new',
			},
			{ directory: dir, enabled: true },
		);
		// Manifest-aware read: the legacy file has NO header; only strip line 1
		// when it IS the manifest.
		const raw = readFileSync(shellAuditFilePath(dir), 'utf-8');
		const nonEmpty = raw.split('\n').filter((l) => l.trim().length > 0);
		const body = nonEmpty[0]!.includes('swarm-shell-audit-manifest')
			? nonEmpty.slice(1)
			: nonEmpty;
		expect(body.length).toBe(2);
		expect(JSON.parse(body[0]!).command).toBe('echo legacy');
		expect(JSON.parse(body[1]!).command).toBe('echo new');
		await rm(dir, { recursive: true, force: true });
	});
});
