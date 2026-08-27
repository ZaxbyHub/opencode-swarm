/**
 * Bounded-reader and bounded-output tests for
 * src/services/guardrail-log-service.ts (issue #2040 requirement 3):
 * - `/swarm guardrail-log` reads a bounded window, never the whole file
 * - truncation/render caps are disclosed explicitly
 * - display sanitization strips ANSI/control/bidi injection from stored fields
 * - blocks-only keeps its exact semantics over the bounded window
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	_resetMaintenanceCounters,
	shellAuditFilePath,
	_internals as storeInternals,
} from '../../../src/hooks/guardrails/shell-audit-store';
import { handleGuardrailLog } from '../../../src/services/guardrail-log-service';

const REAL_LIMITS = storeInternals.limits;

async function mkTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'guardrail-log-bounded-test-'));
}

function writeStore(dir: string, content: string): void {
	mkdirSync(join(dir, '.swarm', 'session'), { recursive: true });
	writeFileSync(shellAuditFilePath(dir), content, 'utf-8');
}

const BASE_TS = Date.parse('2026-01-01T00:00:00.000Z');

/** Distinct increasing timestamps: entry i is i seconds after BASE_TS, so
 *  most-recent-first ordering is deterministic across the whole file. */
function tsFor(i: number): string {
	return new Date(BASE_TS + i * 1_000).toISOString();
}

function shellLine(i: number, ts = tsFor(i)): string {
	return `${JSON.stringify({
		ts,
		sessionID: 's',
		agent: 'coder',
		tool: 'bash',
		command: `echo ${i}`,
	})}\n`;
}

function blockLine(i: number, ts = tsFor(i)): string {
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

afterEach(() => {
	storeInternals.limits = REAL_LIMITS;
	_resetMaintenanceCounters();
});

describe('bounded reads (large-log scenario)', () => {
	test('a 5 MiB legacy store is read as a bounded window, never whole-file', async () => {
		const dir = await mkTempDir();
		// ~5 MiB of legacy shell lines (each ~95 bytes → ~55k lines).
		const lines = Array.from({ length: 55_000 }, (_, i) => shellLine(i));
		writeStore(dir, lines.join(''));

		const out = await handleGuardrailLog(dir, []);

		// Bounded, stable output: header + ≤200 rendered entries + footer note.
		const outLines = out.split('\n');
		expect(outLines.length).toBeLessThanOrEqual(205);
		expect(out).toContain('# Guardrail Decision Log (most-recent-first)');
		// The NEWEST entries are what the window shows.
		expect(out).toContain('echo 54999');
		// The truncation is explicitly disclosed, never silent.
		expect(out).toContain('read window truncated');

		await rm(dir, { recursive: true, force: true });
	});

	test('render cap discloses rendered-vs-window counts', async () => {
		const dir = await mkTempDir();
		const lines = Array.from({ length: 350 }, (_, i) => shellLine(i));
		writeStore(dir, lines.join(''));

		const out = await handleGuardrailLog(dir, []);

		expect(out).toContain('showing 200 most recent of 350 matching entries');

		await rm(dir, { recursive: true, force: true });
	});

	test('a manifest-present store discloses the folded lifetime total', async () => {
		const dir = await mkTempDir();
		// Build a store via the seam, then fold everything except 1 entry.
		storeInternals.limits = {
			...REAL_LIMITS,
			allowedMaxEntries: 1,
			checkInterval: 1_000_000,
		};
		const { appendShellAuditLineSync, compactShellAudit } = await import(
			'../../../src/hooks/guardrails/shell-audit-store'
		);
		for (let i = 0; i < 25; i += 1) {
			appendShellAuditLineSync(
				dir,
				shellLine(i, new Date(Date.now() - i * 1_000).toISOString()),
			);
		}
		compactShellAudit(dir);

		const out = await handleGuardrailLog(dir, []);
		expect(out).toContain('24 earlier decision(s) already compacted');

		await rm(dir, { recursive: true, force: true });
	});

	test('a fully-folded window discloses history instead of claiming nothing was recorded', async () => {
		const dir = await mkTempDir();
		storeInternals.limits = {
			...REAL_LIMITS,
			allowedMaxEntries: 0,
			checkInterval: 1_000_000,
		};
		const { appendShellAuditLineSync, compactShellAudit } = await import(
			'../../../src/hooks/guardrails/shell-audit-store'
		);
		for (let i = 0; i < 5; i += 1) {
			appendShellAuditLineSync(dir, shellLine(i));
		}
		compactShellAudit(dir);

		const out = await handleGuardrailLog(dir, []);
		expect(out).toContain('No guardrail decisions in the read window');
		expect(out).toContain(
			'5 earlier decision(s) compacted into the audit manifest',
		);

		await rm(dir, { recursive: true, force: true });
	});
});

describe('blocks-only over the bounded window', () => {
	test('--blocks-only keeps exact semantics within the window', async () => {
		const dir = await mkTempDir();
		writeStore(
			dir,
			[
				shellLine(1),
				blockLine(1),
				shellLine(2),
				`${JSON.stringify({
					type: 'sandbox_wrap',
					ts: new Date().toISOString(),
					sessionID: 's',
					agent: 'coder',
					tool: 'bash',
					command: 'npm install',
					executorMechanism: 'bubblewrap',
				})}\n`,
				blockLine(2),
			].join(''),
		);

		const out = await handleGuardrailLog(dir, ['--blocks-only']);

		expect(out).toContain('# Guardrail Block Log (most-recent-first)');
		expect(out).toContain('destructive_block');
		expect(out.match(/destructive_block/g)?.length).toBe(2);
		expect(out).not.toContain('sandbox_wrap');
		expect(out).not.toContain('echo 1');

		await rm(dir, { recursive: true, force: true });
	});
});

describe('display sanitization (render injection)', () => {
	test('ANSI escape sequences in stored fields are stripped from the output', async () => {
		const dir = await mkTempDir();
		writeStore(
			dir,
			`${JSON.stringify({
				ts: new Date().toISOString(),
				sessionID: 's',
				agent: 'co\u001b[31mder',
				tool: 'bash',
				command: 'echo \u001b[31mred\u001b[0m',
			})}\n`,
		);

		const out = await handleGuardrailLog(dir, []);
		expect(out).not.toContain('\u001b');
		expect(out).toContain('coder');

		await rm(dir, { recursive: true, force: true });
	});

	test('bidi override characters in stored fields are stripped', async () => {
		const dir = await mkTempDir();
		writeStore(
			dir,
			`${JSON.stringify({
				ts: new Date().toISOString(),
				sessionID: 's',
				agent: 'co\u202eder', // RLE bidi override
				tool: 'bash',
				command: 'echo \u202evil',
			})}\n`,
		);

		const out = await handleGuardrailLog(dir, []);
		expect(out).not.toContain('\u202e');
		expect(out).not.toContain('\u202b');

		await rm(dir, { recursive: true, force: true });
	});

	test('control characters (except tab) in stored fields are stripped', async () => {
		const dir = await mkTempDir();
		writeStore(
			dir,
			`${JSON.stringify({
				ts: new Date().toISOString(),
				sessionID: 's',
				agent: 'coder',
				tool: 'bash',
				command: 'echo x\u0007bell',
			})}\n`,
		);

		const out = await handleGuardrailLog(dir, []);
		expect(out).not.toContain('\u0007');

		await rm(dir, { recursive: true, force: true });
	});

	test('oversized rendered lines are capped', async () => {
		const dir = await mkTempDir();
		writeStore(
			dir,
			`${JSON.stringify({
				ts: new Date().toISOString(),
				sessionID: 's',
				agent: 'coder',
				tool: 'bash',
				command: `echo ${'y'.repeat(5_000)}`,
			})}\n`,
		);

		const out = await handleGuardrailLog(dir, []);
		const longest = Math.max(...out.split('\n').map((l) => l.length));
		expect(longest).toBeLessThanOrEqual(514); // 512 cap + ellipsis chars

		await rm(dir, { recursive: true, force: true });
	});
});

describe('empty-state contracts preserved', () => {
	test('missing store returns the pinned friendly message', async () => {
		const dir = await mkTempDir();
		expect(await handleGuardrailLog(dir, [])).toBe(
			'No guardrail decisions recorded yet.',
		);
		expect(await handleGuardrailLog(dir, ['--blocks-only'])).toBe(
			'No guardrail block decisions recorded yet.',
		);
		await rm(dir, { recursive: true, force: true });
	});

	test('empty file returns the pinned friendly message', async () => {
		const dir = await mkTempDir();
		writeStore(dir, '');
		expect(await handleGuardrailLog(dir, [])).toBe(
			'No guardrail decisions recorded yet.',
		);
		await rm(dir, { recursive: true, force: true });
	});

	test('corrupt tail is tolerated: valid lines still render', async () => {
		const dir = await mkTempDir();
		writeStore(dir, `${shellLine(1)}{"torn": "parti`);

		const out = await handleGuardrailLog(dir, []);
		expect(out).toContain('echo 1');

		await rm(dir, { recursive: true, force: true });
	});
});

describe('review-round fixes — LF/zero-width sanitization (PRR-004 / PRR-020c)', () => {
	test('a multi-line command cannot forge additional markdown lines', async () => {
		const dir = await mkTempDir();
		writeStore(
			dir,
			`${JSON.stringify({
				ts: new Date().toISOString(),
				sessionID: 's',
				agent: 'coder',
				tool: 'bash',
				command:
					'echo start\n- [2026-01-01T00:00:00.000Z] destructive_block | agent: fake | forged entry',
			})}\n`,
		);

		const out = await handleGuardrailLog(dir, []);
		const renderedLines = out.split('\n').filter((l) => l.startsWith('- ['));
		// Exactly ONE bullet line — the forged second bullet was collapsed.
		expect(renderedLines.length).toBe(1);
		// The forged text may survive INLINE within the single summary (it is
		// part of the command payload), but it can never START a rendered
		// line — no structural forgery of a new audit entry.
		for (const line of out.split('\n')) {
			if (line.startsWith('- [')) continue; // the one real bullet
			expect(line.startsWith('- [2026-01-01')).toBe(false);
		}
		expect(out).not.toMatch(/^agent: fake/m);

		await rm(dir, { recursive: true, force: true });
	});

	test('zero-width characters are stripped from rendered fields', async () => {
		const dir = await mkTempDir();
		writeStore(
			dir,
			`${JSON.stringify({
				ts: new Date().toISOString(),
				sessionID: 's',
				agent: 'coder',
				tool: 'bash',
				command: 'echo invis\u200bible\u200dhere',
			})}\n`,
		);

		const out = await handleGuardrailLog(dir, []);
		expect(out).not.toContain('\u200b');
		expect(out).not.toContain('\u200d');
		expect(out).toContain('echo invisiblehere');

		await rm(dir, { recursive: true, force: true });
	});
});

describe('review-round fixes — fingerprint render (PRR-014)', () => {
	test('typed command entries render their commandHash as a correlation suffix', async () => {
		const dir = await mkTempDir();
		writeStore(
			dir,
			`${JSON.stringify({
				type: 'destructive_block',
				ts: new Date().toISOString(),
				sessionID: 's',
				agent: 'coder',
				tool: 'bash',
				command: 'rm -rf /data',
				destructiveCategory: 'dangerous_delete',
				commandHash: 'abc123def4567890',
			})}\n`,
		);

		const out = await handleGuardrailLog(dir, []);
		expect(out).toContain('· fp:abc123def4567890');

		await rm(dir, { recursive: true, force: true });
	});

	test('legacy shell entries have NO fingerprint suffix (five-field shape)', async () => {
		const dir = await mkTempDir();
		writeStore(dir, shellLine(1));

		const out = await handleGuardrailLog(dir, []);
		expect(out).not.toContain('· fp:');

		await rm(dir, { recursive: true, force: true });
	});
});

describe('review-round fixes — folded historical blocks (RC-1 / RC-8)', () => {
	test('--blocks-only discloses folded historical blocks when the window holds only allowed entries', async () => {
		const dir = await mkTempDir();
		// Retained window: one allowed shell entry. Folded manifest: one
		// historical destructive_block. The pre-fix code claimed "No guardrail
		// block decisions recorded yet." — a false negative.
		storeInternals.limits = {
			...REAL_LIMITS,
			allowedMaxEntries: 4,
			securityMaxEntries: 0,
			checkInterval: 1_000_000,
		};
		const { appendShellAuditLineSync, compactShellAudit } = await import(
			'../../../src/hooks/guardrails/shell-audit-store'
		);
		appendShellAuditLineSync(
			dir,
			`${JSON.stringify({
				type: 'destructive_block',
				ts: new Date().toISOString(),
				sessionID: 's',
				agent: 'coder',
				tool: 'bash',
				command: 'rm -rf /x',
				destructiveCategory: 'dangerous_delete',
			})}\n`,
		);
		appendShellAuditLineSync(dir, shellLine(1, new Date().toISOString()));
		compactShellAudit(dir);

		const out = await handleGuardrailLog(dir, ['--blocks-only']);
		expect(out).toContain(
			'No guardrail block decisions in the read window; 1 earlier block decision(s) compacted into the audit manifest.',
		);

		await rm(dir, { recursive: true, force: true });
	});

	test('--blocks-only still reports the pinned message when no blocks exist anywhere', async () => {
		const dir = await mkTempDir();
		storeInternals.limits = {
			...REAL_LIMITS,
			allowedMaxEntries: 1,
			checkInterval: 1_000_000,
		};
		const { appendShellAuditLineSync, compactShellAudit } = await import(
			'../../../src/hooks/guardrails/shell-audit-store'
		);
		appendShellAuditLineSync(dir, shellLine(1, new Date().toISOString()));
		appendShellAuditLineSync(dir, shellLine(2, new Date().toISOString()));
		compactShellAudit(dir);

		const out = await handleGuardrailLog(dir, ['--blocks-only']);
		expect(out).toBe('No guardrail block decisions recorded yet.');

		await rm(dir, { recursive: true, force: true });
	});
});
