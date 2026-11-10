/**
 * #3606: the two ancestor denial arms in `checkWriteTargetForSymlink`
 * (file-authority.ts — lstat-failure and symlink/junction) render the
 * resolved ancestor through the shared #3587 bounded-and-redacted
 * contract: home-folded, control-neutralized, ≤320 chars; the lstat
 * error detail is sanitized and bounded (160) — `String(err)` itself
 * embeds the path, so it leaks the profile prefix twice pre-fix.
 *
 * Host-independent pin legs (no platform gates) drive the ancestor walk
 * through the file-authority `_internals` lstat seam with a fabricated
 * `/home/alice/ws` workspace — the walk below the seam is purely lexical,
 * so the real filesystem is never touched and the profile fold is
 * observable on every host (POSIX `/home`, Windows drive `<drive>:/home`,
 * macOS via the lexical `/Users` classifier). A real-fs leg proves the
 * operator-facing write-tool denial end-to-end.
 *
 * Kept in a dedicated file rather than the 3587 suite, which sits at the
 * FR-006 500-line cap ratchet boundary (a grown over-cap file fails
 * `bun run check:test-file-cap`); the unchanged 3587 suite runs alongside
 * as the preserving control for the four main denial doors.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	checkWriteTargetForSymlink,
	_internals as fileAuthorityInternals,
} from '../../../src/hooks/guardrails/file-authority';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const created: string[] = [];
let counter = 0;
afterAll(() => {
	for (const dir of created.splice(0)) removeTreeWithRetry(dir);
});

type LstatFn = typeof fileAuthorityInternals.lstatSync;

/** Inject an lstat outcome for the whole walk; restores the real call. */
function withInjectedLstat<T>(lstat: LstatFn, run: () => T): T {
	const real = fileAuthorityInternals.lstatSync;
	fileAuthorityInternals.lstatSync = lstat;
	try {
		return run();
	} finally {
		fileAuthorityInternals.lstatSync = real;
	}
}

function throwingLstat(err: Error & { code?: string }): LstatFn {
	return (() => {
		throw err;
	}) as unknown as LstatFn;
}

function symlinkLstat(): LstatFn {
	return (() => ({ isSymbolicLink: () => true })) as unknown as LstatFn;
}

/** Graceful-degrade symlink creation (EPERM/EACCES hosts skip the leg). */
function tryCreateSymlink(target: string, linkPath: string): boolean {
	try {
		symlinkSync(target, linkPath);
		return true;
	} catch (error) {
		if (
			error &&
			typeof error === 'object' &&
			'code' in error &&
			((error as { code?: string }).code === 'EPERM' ||
				(error as { code?: string }).code === 'EACCES')
		) {
			return false;
		}
		throw error;
	}
}

function guardrailsConfig(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
	} as GuardrailsConfig;
}

/** Drive the write tool through toolBefore; captures the thrown message. */
async function gateWrite(
	ws: string,
	filePath: string,
): Promise<{ verdict: 'ADMITTED' | 'DENIED'; message: string }> {
	const sessionID = `r3606-s${++counter}`;
	const callID = `r3606-c${counter}`;
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: ws,
		childSessionId: sessionID,
		taskId: '1.1',
		files: ['src/'],
		dispatchCallId: callID,
	});
	const hooks = createGuardrailsHooks(ws, undefined, guardrailsConfig());
	try {
		await hooks.toolBefore(
			{ tool: 'write', sessionID, callID },
			{ args: { filePath, content: 'x' } },
		);
		return { verdict: 'ADMITTED', message: '' };
	} catch (error) {
		return {
			verdict: 'DENIED',
			message: (error as Error).message.split('\n')[0] ?? '',
		};
	} finally {
		resetSwarmState();
	}
}

describe('#3606 ancestor denial arms render bounded, redacted ancestors', () => {
	test('lstat-failure arm: profile-prefixed ancestor folds, error detail sanitized + bounded', () => {
		const hostile = Object.assign(
			new Error(`EPERM: lstat '\u0001${'e'.repeat(400)}'`),
			{ code: 'EPERM' },
		);
		const reason = withInjectedLstat(throwingLstat(hostile), () =>
			checkWriteTargetForSymlink('proj/x/y.txt', '/home/alice/ws'),
		);
		// Verdict semantics unchanged: the arm still denies, fail-closed.
		expect(reason).toContain('WRITE BLOCKED: lstat failed on');
		expect(reason).toContain('refusing write on unverifiable path');
		// The hostile error text survives (sanitized) so operators keep the
		// errno class, but the embedded control character is neutralized.
		expect(reason).toContain('EPERM');
		expect(reason).not.toContain('\u0001');
		// The quoted ancestor slot folds the runtime profile prefix and
		// stays within the 320 bound; the raw prefix never reaches the text.
		const slot = /lstat failed on "([^"]*)"/.exec(reason ?? '')?.[1] ?? '';
		expect(slot.length).toBeGreaterThan(0);
		expect(slot.length).toBeLessThanOrEqual(320);
		expect(slot.startsWith('~')).toBe(true);
		expect(reason).not.toContain('/home/alice');
		expect(reason).not.toContain('alice');
		// Whole-message bound: 320 (path) + 160 (error detail) + fixed prose.
		expect(reason?.length ?? 0).toBeLessThanOrEqual(560);
	});

	test('symlink/junction arm: profile-prefixed ancestor folds, bounded', () => {
		const reason = withInjectedLstat(symlinkLstat(), () =>
			checkWriteTargetForSymlink('proj/x.txt', '/home/alice/ws'),
		);
		expect(reason).toContain('WRITE BLOCKED');
		expect(reason).toContain('is a symlink/junction');
		expect(reason).toContain(
			'could redirect the write outside the working directory',
		);
		const slot = /"([^"]*)"/.exec(reason ?? '')?.[1] ?? '';
		expect(slot.length).toBeGreaterThan(0);
		expect(slot.length).toBeLessThanOrEqual(320);
		expect(slot.startsWith('~')).toBe(true);
		expect(reason).not.toContain('/home/alice');
		expect(reason).not.toContain('alice');
	});

	test('symlink/junction arm: oversized ancestor truncates at 320 with the ellipsis', () => {
		const reason = withInjectedLstat(symlinkLstat(), () =>
			checkWriteTargetForSymlink(`${'a'.repeat(400)}/x.txt`, '/home/alice/ws'),
		);
		expect(reason).toContain('is a symlink/junction');
		const slot = /"([^"]*)"/.exec(reason ?? '')?.[1] ?? '';
		// Same truncation shape as renderDenialTarget: 319 chars + '…'.
		expect(slot.length).toBe(320);
		expect(slot.endsWith('…')).toBe(true);
		expect(reason).not.toContain('alice');
	});

	test('ENOENT still walks through (verdict semantics preserved)', () => {
		const reason = withInjectedLstat(
			throwingLstat(
				Object.assign(new Error('ENOENT: no such file'), {
					code: 'ENOENT',
				}),
			),
			() => checkWriteTargetForSymlink('proj/x/y.txt', '/home/alice/ws'),
		);
		expect(reason).toBeNull();
	});

	test('write-tool gate surfaces the bounded junction denial end-to-end', async () => {
		const ws = canonicalMkdtemp('r3606-ws-');
		created.push(ws);
		mkdirSync(path.join(ws, 'src', 'realdir'), { recursive: true });
		// A symlink DIRECTORY ancestor: writing below it must hit the
		// junction arm (host-independent on symlink-capable hosts; hosts
		// without symlink privilege skip the leg gracefully).
		const linkDir = path.join(ws, 'src', 'linkdir');
		if (!tryCreateSymlink(path.join(ws, 'src', 'realdir'), linkDir)) return;

		const got = await gateWrite(ws, 'src/linkdir/newfile.txt');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/symlink\/junction/);
		const slot = /"([^"]*)"/.exec(got.message)?.[1] ?? '';
		expect(slot.length).toBeGreaterThan(0);
		expect(slot.length).toBeLessThanOrEqual(320);
		// When the host tmpdir sits under a real profile, the profile name
		// must not survive into the operator-facing message (the pre-fix
		// leak this issue reports).
		const home = os.homedir();
		if (ws.startsWith(home)) {
			expect(got.message).not.toContain(path.basename(home));
			expect(got.message.startsWith('WRITE BLOCKED: "~')).toBe(true);
		}
	}, 30_000);
});
