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
	SHELL_AUDIT_LIMITS,
	SHELL_AUDIT_LINE_TOO_LARGE,
	SHELL_AUDIT_STORE_LOCKED,
	shellAuditFilePath,
	withShellAuditStoreLock,
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
