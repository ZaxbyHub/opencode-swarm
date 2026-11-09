/**
 * Issue #2969 (fix plan 05 v8 §2.6) — `/swarm config doctor --integrity`:
 * read-only store integrity report. Pins:
 *  - per-category counts + `integrity_issues_total` for a seeded store;
 *  - WHOLE-TREE byte identity before vs after the report (no mutation pin —
 *    every file under the project root is hashed before and after);
 *  - clean store → 0; absent `.swarm` → graceful 0;
 *  - flag exactness (a typo'd longer prefix arg is NOT the flag — mirrors
 *    the PRR-024 shape in tests/unit/commands/doctor-residue.test.ts);
 *  - the REPORT-ONLY pid-alive stale-lock sub-class: listed, never counted
 *    toward the actionable total (plan 05 v8 §1.1, critic r6-#2).
 *
 * The handler is called directly — the registry's toolNoArgs policy blocks
 * agent-passed flags, so the interactive flag surface is tested here.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { handleDoctorCommand } from '../../../src/commands/doctor';
import { resolveLinkDir } from '../../../src/memory/memory-link';
import { _internals as residueInternals } from '../../../src/services/swarm-residue';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const realQueryTracked = residueInternals.queryTracked;

let projectDir: string;
let dataDir: string;
let swarmDir: string;
const prevEnv: Record<string, string | undefined> = {};

function backdate(p: string, hoursAgo = 2): void {
	// Literal fixture timestamp (house convention): the doctor's TTL checks
	// only need an mtime comfortably older than the 5-minute lock TTL, so a
	// fixed 2026 instant is deterministic and never crosses a live boundary.
	// (check:test-clock: new Date(<arg>) is derived, not a raw clock read.)
	const t = new Date('2026-10-01T00:00:00.000Z');
	utimesSync(p, new Date(t.getTime() - hoursAgo * 3_600_000), t);
}

function write(relUnderSwarm: string, content: string): string {
	const abs = path.join(swarmDir, ...relUnderSwarm.split('/'));
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, content, 'utf-8');
	return abs;
}

/** Hash every file under the root (content sha256; symlinks by target) —
 *  the whole-tree byte-identity pin for the read-only contract. */
function hashTree(root: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (abs: string, rel: string): void => {
		for (const dirent of readdirSync(abs, { withFileTypes: true })) {
			const child = path.join(abs, dirent.name);
			const relPath = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
			if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
				walk(child, relPath);
				continue;
			}
			const st = lstatSync(child);
			out.set(
				relPath,
				st.isSymbolicLink()
					? `link:${readlinkSync(child)}`
					: createHash('sha256').update(readFileSync(child)).digest('hex'),
			);
		}
	};
	walk(root, '');
	return out;
}

function assertTreeIdentical(
	before: Map<string, string>,
	after: Map<string, string>,
): void {
	expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
	for (const key of before.keys()) {
		expect(after.get(key)).toBe(before.get(key));
	}
}

beforeEach(() => {
	// Redirect the platform data dir (LOCALAPPDATA / XDG_DATA_HOME / HOME) so
	// resolveLinkDir() is deterministic for the memory-link category (same
	// pattern as tests/unit/commands/memory-link.test.ts).
	for (const key of ['HOME', 'XDG_DATA_HOME', 'LOCALAPPDATA']) {
		prevEnv[key] = process.env[key];
	}
	dataDir = canonicalMkdtemp('doctor-integrity-data-');
	process.env.HOME = dataDir;
	process.env.XDG_DATA_HOME = dataDir;
	process.env.LOCALAPPDATA = dataDir;
	projectDir = canonicalMkdtemp('doctor-integrity-');
	swarmDir = path.join(projectDir, '.swarm');
	residueInternals.queryTracked = () => ({ tracked: new Set<string>() });
});

afterEach(() => {
	for (const [key, value] of Object.entries(prevEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	residueInternals.queryTracked = realQueryTracked;
	removeTreeWithRetry(projectDir);
	removeTreeWithRetry(dataDir);
});

describe('handleDoctorCommand --integrity (issue #2969)', () => {
	test('seeded store: per-category counts, total, and no mutation', async () => {
		// 1 + 2: torn JSONL tails (both torn-tail reasons).
		write('plan-ledger.jsonl', '{"seq":1}\n{"seq":2');
		write('events.jsonl', '{"type":"a"}\nnot json\n');
		// 3: temp artifact matching a registered grammar.
		write('context.md', 'target');
		write('context.md.tmp.1710000000.123456789', 'stale temp');
		// 4: stale locks — unparsable .lck, legacy proper-lockfile dir, and a
		//    pid-ALIVE .lck (the report-only corner).
		const locksDir = path.join(swarmDir, 'locks');
		mkdirSync(locksDir, { recursive: true });
		const deadLck = path.join(locksDir, 'aaaaaaaa.lck');
		writeFileSync(deadLck, '', 'utf-8');
		backdate(deadLck);
		const legacyDir = path.join(locksDir, 'bbbbbbbb.lock.lock');
		mkdirSync(legacyDir);
		backdate(legacyDir);
		const liveLck = path.join(locksDir, 'cccccccc.lck');
		writeFileSync(
			liveLck,
			JSON.stringify({
				v: 1,
				nonce: 'x',
				ownerPid: process.pid,
				startBoundMs: 0,
				agent: 'a',
				taskId: 't',
				acquiredAtMs: 1,
			}),
			'utf-8',
		);
		backdate(liveLck);
		// 5: orphaned .bak (+ the intentional backup-with-sibling control).
		write('orphan.json.bak', 'old');
		write('full-auto-state.json', '{}');
		write('full-auto-state.json.bak', '{}');
		// 6: memory same-id divergence across cohort + local stores.
		write(
			'memory-link.json',
			JSON.stringify({
				version: 2,
				linkId: 'integrity-cohort',
				createdAt: '2026-10-31T00:00:00.000Z',
			}),
		);
		write(
			'memory/memories.jsonl',
			`${JSON.stringify({ id: 'm-1', updatedAt: '2026-10-02T00:00:00.000Z' })}\n`,
		);
		const cohortMem = path.join(resolveLinkDir('integrity-cohort'), 'memory');
		mkdirSync(cohortMem, { recursive: true });
		writeFileSync(
			path.join(cohortMem, 'memories.jsonl'),
			`${JSON.stringify({ id: 'm-1', updatedAt: '2026-10-01T00:00:00.000Z' })}\n`,
			'utf-8',
		);

		// Prime run: the PRE-EXISTING knowledge-receipt section performs its
		// disclosed base-identical bootstrap write on first inspection; pin
		// the tree AFTER it so the no-mutation pin measures THIS feature.
		await handleDoctorCommand(projectDir, []);
		const before = hashTree(projectDir);

		const out = await handleDoctorCommand(projectDir, ['--integrity']);

		assertTreeIdentical(before, hashTree(projectDir));
		expect(existsSync(path.join(swarmDir, 'quarantine'))).toBe(false);

		expect(out).toContain('- ledger_torn_tail: 1');
		expect(out).toContain('(last line not newline-terminated)');
		expect(out).toContain('- events_torn_tail: 1');
		expect(out).toContain('(last line not valid JSON)');
		expect(out).toContain('- temp_artifacts: 1');
		expect(out).toContain('`context.md.tmp.1710000000.123456789`');
		expect(out).toContain('- stale_locks: 2');
		expect(out).toContain('(unparsable owner payload, past TTL)');
		expect(out).toContain('(legacy proper-lockfile dir, past TTL)');
		expect(out).toContain(
			'(report-only: live owner pid — manual recovery; never auto-removed)',
		);
		expect(out).toContain('- orphaned_bak: 1');
		expect(out).toContain('`orphan.json.bak`');
		expect(out).toContain('- memory_same_id_divergences: 1');
		// 1 + 1 + 1 + 2 + 1 + 1 = 7 (the report-only lock is NOT counted).
		expect(out).toContain('integrity_issues_total: 7');
	});

	test('clean store reports zero in every category', async () => {
		write('plan-ledger.jsonl', '{"seq":1}\n');
		write('events.jsonl', '{"type":"a"}\n');
		write('full-auto-state.json', '{}\n');
		write('full-auto-state.json.bak', '{}\n');
		await handleDoctorCommand(projectDir, []); // prime receipt bootstrap
		const out = await handleDoctorCommand(projectDir, ['--integrity']);
		for (const key of [
			'ledger_torn_tail',
			'events_torn_tail',
			'temp_artifacts',
			'stale_locks',
			'orphaned_bak',
		]) {
			expect(out).toContain(`- ${key}: 0`);
		}
		expect(out).toContain('- memory_same_id_divergences: 0 (not linked)');
		expect(out).toContain('integrity_issues_total: 0');
	});

	test('absent .swarm directory degrades gracefully to all-zero', async () => {
		const out = await handleDoctorCommand(projectDir, ['--integrity']);
		expect(out).toContain('Store Integrity Report');
		expect(out).toContain('integrity_issues_total: 0');
		expect(out).toContain('- stale_locks: 0');
	});

	test("a typo'd longer prefixed flag is NOT treated as --integrity", async () => {
		write('plan-ledger.jsonl', '{"seq":1}\n{"seq":2');
		const typo = await handleDoctorCommand(projectDir, ['--integrityy']);
		// Falls through to the default read-only surface — no integrity
		// section, no error.
		expect(typo).not.toContain('Store Integrity Report');
		const exact = await handleDoctorCommand(projectDir, ['--integrity']);
		expect(exact).toContain('Store Integrity Report');
		expect(exact).toContain('integrity_issues_total: 1');
	});

	test('pid-ALIVE stale lock is listed report-only and never counted', async () => {
		const locksDir = path.join(swarmDir, 'locks');
		mkdirSync(locksDir, { recursive: true });
		const liveLck = path.join(locksDir, 'live.lck');
		writeFileSync(
			liveLck,
			JSON.stringify({
				v: 1,
				nonce: 'x',
				ownerPid: process.pid,
				startBoundMs: 0,
				agent: 'a',
				taskId: 't',
				acquiredAtMs: 1,
			}),
			'utf-8',
		);
		backdate(liveLck);
		await handleDoctorCommand(projectDir, []); // prime receipt bootstrap
		const out = await handleDoctorCommand(projectDir, ['--integrity']);
		expect(out).toContain('- stale_locks: 0');
		expect(out).toContain(
			'(report-only: live owner pid — manual recovery; never auto-removed)',
		);
		expect(out).toContain('integrity_issues_total: 0');
		// The live-owner lock itself is untouched — never auto-removed.
		expect(existsSync(liveLck)).toBe(true);
	});

	test('events.lock + break markers are classified (feedback PRR-004/006)', async () => {
		// Dead-pid events.lock past TTL → actionable.
		const eventsLock = write(
			'events.lock',
			JSON.stringify({
				v: 1,
				nonce: 'e',
				ownerPid: 999_999_999,
				startBoundMs: 0,
				agent: 'a',
				taskId: 't',
				acquiredAtMs: 1,
			}),
		);
		backdate(eventsLock);
		// events.lock.breaking marker → listed.
		write('events.lock.breaking', 'x');
		// Aged planted marker in locks/ → listed.
		const locksDir = path.join(swarmDir, 'locks');
		mkdirSync(locksDir, { recursive: true });
		const marker = path.join(locksDir, 'dead.lck.breaking');
		writeFileSync(marker, 'x', 'utf-8');
		await handleDoctorCommand(projectDir, []); // prime receipt bootstrap
		const out = await handleDoctorCommand(projectDir, ['--integrity']);
		expect(out).toContain('`events.lock` (owner pid 999999999 dead, past TTL)');
		expect(out).toContain('`events.lock.breaking` (break marker present');
		expect(out).toContain('`locks/dead.lck.breaking` (break marker');
		// events.lock actionable (1) + marker listed (1) + locks marker (1).
		expect(out).toContain('- stale_locks: 3');
	});

	test('non-v1 payload is ownerless, never report-only-live (feedback PRR-011)', async () => {
		const locksDir = path.join(swarmDir, 'locks');
		mkdirSync(locksDir, { recursive: true });
		const lck = path.join(locksDir, 'legacy.lck');
		// No `v` field — mirrors the substrate's ownerless classification.
		writeFileSync(
			lck,
			JSON.stringify({
				nonce: 'x',
				ownerPid: process.pid,
				startBoundMs: 0,
				agent: 'a',
				taskId: 't',
				acquiredAtMs: 1,
			}),
			'utf-8',
		);
		backdate(lck);
		await handleDoctorCommand(projectDir, []); // prime receipt bootstrap
		const out = await handleDoctorCommand(projectDir, ['--integrity']);
		expect(out).toContain('- stale_locks: 1');
		expect(out).toContain('(unparsable owner payload, past TTL)');
		expect(out).not.toContain('report-only: live owner pid');
	});

	test('oversized foreign lock artifact is listed, not parsed (feedback PRR-022)', async () => {
		const locksDir = path.join(swarmDir, 'locks');
		mkdirSync(locksDir, { recursive: true });
		const big = path.join(locksDir, 'huge.lck');
		writeFileSync(big, 'x'.repeat(65 * 1024), 'utf-8');
		backdate(big);
		await handleDoctorCommand(projectDir, []); // prime receipt bootstrap
		const out = await handleDoctorCommand(projectDir, ['--integrity']);
		expect(out).toContain('bytes — oversized foreign artifact, past TTL)');
		expect(out).toContain('- stale_locks: 1');
	});

	test('symlinked lock entries are skipped, never followed (feedback PRR-017)', async () => {
		const locksDir = path.join(swarmDir, 'locks');
		mkdirSync(locksDir, { recursive: true });
		const targetDir = path.join(projectDir, 'outside');
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(path.join(targetDir, 'planted.lck'), 'evil', 'utf-8');
		// A junction (works unprivileged on Windows; symlink on POSIX).
		symlinkSync(targetDir, path.join(locksDir, 'escape'), 'junction');
		await handleDoctorCommand(projectDir, []); // prime receipt bootstrap
		const out = await handleDoctorCommand(projectDir, ['--integrity']);
		expect(out).toContain('- stale_locks: 0');
		expect(out).not.toContain('planted');
		// The planted target was never touched.
		expect(existsSync(path.join(targetDir, 'planted.lck'))).toBe(true);
	});
});

describe('renderStoreIntegritySection — direct no-mutation pin', () => {
	test('no .swarm: all-zero with the absent-store note, tree untouched', async () => {
		const { renderStoreIntegritySection } = await import(
			'../../../src/commands/doctor-store-integrity'
		);
		const before = hashTree(projectDir);
		const out = await renderStoreIntegritySection(projectDir);
		assertTreeIdentical(before, hashTree(projectDir));
		expect(out).toContain('No `.swarm` directory found');
		expect(out).toContain('integrity_issues_total: 0');
	});
});
