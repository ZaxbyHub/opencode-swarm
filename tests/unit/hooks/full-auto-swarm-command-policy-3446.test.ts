/**
 * #3446 — Full-Auto passes only READ-ONLY /swarm commands without a critic. The
 * tool policy's agent allowlist also contains state-changing and
 * process-spawning commands, so it is not a safety classification.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { executeSwarmCommand } from '../../../src/commands/command-dispatch';
import { classifySwarmCommandToolUse } from '../../../src/commands/tool-policy';
import {
	isSwarmCommandReadOnly,
	READ_ONLY_SWARM_COMMANDS,
} from '../../../src/hooks/full-auto-permission';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('isSwarmCommandReadOnly', () => {
	test('true for read-only commands the tool policy permits', () => {
		for (const args of [
			{ command: 'status', args: [] },
			{ command: 'status' },
			{ command: 'sdd status', args: [] },
			{ command: 'sdd validate', args: [] },
			{ command: 'show-plan', args: [] },
			{ command: 'history', args: [] },
			{ command: 'costs', args: ['--json'] },
		]) {
			expect(isSwarmCommandReadOnly(args)).toBe(true);
		}
	});

	test('false for state-changing or process-spawning commands that the tool policy allows an agent to run', () => {
		for (const command of [
			'diagnose',
			'doctor tools',
			'pr status',
			'sdd project',
			'auto-proceed',
			'guardrail reset',
			'attest',
			'ci-simulate',
			'gate-audit',
			'review',
			'post-mortem',
			'pr subscribe',
			'pr unsubscribe',
			'memory compact',
			'memory import',
			'memory migrate',
			'memory link',
			'memory unlink',
			'memory export',
			'export',
			'recover',
			'harness-opt run',
			'harness-opt stop',
			'benchmark',
			'config doctor',
		]) {
			expect(isSwarmCommandReadOnly({ command, args: [] })).toBe(false);
		}
	});

	test('false for human-only, restricted and unknown commands', () => {
		for (const command of [
			'full-auto',
			'epic',
			'approve-write',
			'reset-session',
			'rollback',
			'definitely-not-a-command',
			'',
		]) {
			expect(isSwarmCommandReadOnly({ command, args: [] })).toBe(false);
		}
	});

	test('false when the tool policy rejects the arguments', () => {
		expect(
			isSwarmCommandReadOnly({ command: 'config doctor', args: ['--fix'] }),
		).toBe(false);
	});

	test('false for malformed input', () => {
		for (const bad of [
			undefined,
			null,
			'status',
			42,
			{},
			{ command: 7 },
			{ command: 'status', args: 'x' },
			{ command: 'status', args: [1] },
		]) {
			expect(isSwarmCommandReadOnly(bad)).toBe(false);
		}
	});

	test('every entry of the read-only set is a registered command key', async () => {
		const { COMMAND_REGISTRY } = await import('../../../src/commands/registry');
		for (const key of READ_ONLY_SWARM_COMMANDS) {
			expect(Object.hasOwn(COMMAND_REGISTRY, key)).toBe(true);
		}
	});
});

describe('READ_ONLY_SWARM_COMMANDS — effect confinement', () => {
	// Snapshot every file outside `.swarm/` (path, size, mtime) so a command that
	// touches source, plan or any operator-visible file is caught.
	function snapshot(root: string): Map<string, string> {
		const out = new Map<string, string>();
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				const rel = path.relative(root, full);
				if (rel === '.swarm' || rel.startsWith(`.swarm${path.sep}`)) continue;
				if (entry.isDirectory()) {
					out.set(`${rel}/`, 'dir');
					walk(full);
				} else {
					const st = fs.statSync(full);
					out.set(rel, `${st.size}:${st.mtimeMs}`);
				}
			}
		};
		walk(root);
		return out;
	}

	/**
	 * Best-effort teardown only: the `memory *` keys leave a SQLite memory.db
	 * handle open under .swarm/, which Windows refuses to delete (EBUSY/EPERM).
	 * Any other error is real. Kept out of the `finally` (noUnsafeFinally).
	 */
	function removeDirBestEffort(dir: string): void {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== 'EBUSY' && code !== 'EPERM') throw err;
		}
	}

	test('every key leaves the tree outside .swarm/ untouched', async () => {
		for (const key of [...READ_ONLY_SWARM_COMMANDS].sort()) {
			const dir = canonicalMkdtemp('ro-swarm-cmd-');
			try {
				fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
				const before = snapshot(dir);
				await executeSwarmCommand({
					directory: dir,
					agents: {},
					sessionID: 'ro-confinement',
					tokens: key.split(' '),
					policy: classifySwarmCommandToolUse,
				});
				const after = snapshot(dir);
				expect({ key, tree: [...after] }).toEqual({
					key,
					tree: [...before],
				});
			} finally {
				removeDirBestEffort(dir);
			}
		}
	}, 120_000);
});
