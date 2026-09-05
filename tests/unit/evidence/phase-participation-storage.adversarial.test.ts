import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	MAX_PHASE_PARTICIPATION_BYTES,
	MAX_PHASE_PARTICIPATION_QUARANTINE_DIRECTORY_ENTRIES,
	observePhaseParticipationToolResult,
	PHASE_PARTICIPATION_FILE,
	PHASE_PARTICIPATION_QUARANTINE_DIR,
	readPhaseParticipation,
	reserveApprovedPhaseParticipation,
	resetPhaseParticipationForTests,
} from '../../../src/evidence/phase-participation';
import { bunSpawnSync } from '../../../src/utils/bun-compat';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function git(directory: string, args: string[]): void {
	const result = bunSpawnSync(['git', '-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 5_000,
	});
	if (!result.success) {
		throw new Error(new TextDecoder().decode(result.stderr));
	}
}

function commitWorkspace(directory: string, contents: string): void {
	fs.writeFileSync(path.join(directory, 'workspace-marker.txt'), contents);
	git(directory, ['add', '.']);
	git(directory, [
		'-c',
		'user.name=Swarm Test',
		'-c',
		'user.email=swarm-test@example.invalid',
		'commit',
		'-m',
		contents,
	]);
}

function plan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Storage Bounds',
		swarm: 'test',
		current_phase: 1,
		phases: [{ id: 1, name: 'One', status: 'in_progress', tasks: [] }],
	};
}

function storedPending(index: number, directory = '/project'): object {
	return {
		role: 'docs',
		prefixedRole: 'docs',
		planId: `plan-${index}`,
		planIdentityHash: 'a'.repeat(64),
		planStructureHash: 'b'.repeat(64),
		phase: 1,
		taskId: null,
		parentSessionId: `parent-${index}`,
		callId: `call-${index}`,
		policyDigest: 'c'.repeat(64),
		workspace: { directory, gitHead: null, prHeadSha: null },
		capturedAt: index + 1,
		childSessionId: `child-${index}`,
	};
}

describe('phase participation storage adversaries', () => {
	let directory: string;
	let cleanup: () => void;
	let evidencePath: string;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('participation-store-'));
		fs.mkdirSync(path.join(directory, '.swarm', 'evidence'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan()),
		);
		evidencePath = path.join(
			directory,
			'.swarm',
			...PHASE_PARTICIPATION_FILE.split('/'),
		);
		resetPhaseParticipationForTests();
	});

	afterEach(() => {
		resetPhaseParticipationForTests();
		cleanup();
	});

	test('fails closed and preserves an oversized projection byte-for-byte', async () => {
		const bytes = Buffer.alloc(MAX_PHASE_PARTICIPATION_BYTES + 1, 0x78);
		fs.writeFileSync(evidencePath, bytes);
		expect(
			(await readPhaseParticipation(directory, plan(), 1, 'docs')).status,
		).toBe('oversized');

		await expect(
			reserveApprovedPhaseParticipation({
				directory,
				tool: 'Task',
				parentSessionId: 'parent',
				callId: 'call',
				args: { subagent_type: 'docs' },
				policy: {},
			}),
		).rejects.toThrow('PHASE_PARTICIPATION_OVERSIZED');
		expect(fs.readFileSync(evidencePath)).toEqual(bytes);
	});

	test('reports an unreadable projection and does not replace it', async () => {
		fs.mkdirSync(evidencePath);
		expect(
			(await readPhaseParticipation(directory, plan(), 1, 'docs')).status,
		).toBe('unreadable');
		await expect(
			reserveApprovedPhaseParticipation({
				directory,
				tool: 'Task',
				parentSessionId: 'parent',
				callId: 'call',
				args: { subagent_type: 'docs' },
				policy: {},
			}),
		).rejects.toThrow('PHASE_PARTICIPATION_UNREADABLE');
		expect(fs.statSync(evidencePath).isDirectory()).toBe(true);
	});

	test('rejects an oversized colliding quarantine artifact without reading or replacing it', async () => {
		const corrupt = Buffer.from('{bad');
		fs.writeFileSync(evidencePath, corrupt);
		const digest = createHash('sha256').update(corrupt).digest('hex');
		const quarantineDir = path.join(
			directory,
			'.swarm',
			...PHASE_PARTICIPATION_QUARANTINE_DIR.split('/'),
		);
		fs.mkdirSync(quarantineDir, { recursive: true });
		const collisionPath = path.join(quarantineDir, `${digest}.bin`);
		fs.writeFileSync(
			collisionPath,
			Buffer.alloc(MAX_PHASE_PARTICIPATION_BYTES + 1),
		);

		await expect(
			reserveApprovedPhaseParticipation({
				directory,
				tool: 'Task',
				parentSessionId: 'parent',
				callId: 'call',
				args: { subagent_type: 'docs' },
				policy: {},
			}),
		).rejects.toThrow('not a permitted regular file');
		expect(fs.statSync(collisionPath).size).toBe(
			MAX_PHASE_PARTICIPATION_BYTES + 1,
		);
		expect(fs.readFileSync(evidencePath)).toEqual(corrupt);
	});

	test('stops quarantine enumeration at its hard directory-entry cap', async () => {
		const corrupt = Buffer.from('{bad');
		fs.writeFileSync(evidencePath, corrupt);
		const quarantineDir = path.join(
			directory,
			'.swarm',
			...PHASE_PARTICIPATION_QUARANTINE_DIR.split('/'),
		);
		fs.mkdirSync(quarantineDir, { recursive: true });
		for (
			let index = 0;
			index <= MAX_PHASE_PARTICIPATION_QUARANTINE_DIRECTORY_ENTRIES;
			index += 1
		) {
			fs.writeFileSync(path.join(quarantineDir, `noise-${index}.txt`), 'x');
		}

		await expect(
			reserveApprovedPhaseParticipation({
				directory,
				tool: 'Task',
				parentSessionId: 'parent',
				callId: 'call',
				args: { subagent_type: 'docs' },
				policy: {},
			}),
		).rejects.toThrow('PHASE_PARTICIPATION_QUARANTINE_FULL');
		expect(fs.readFileSync(evidencePath)).toEqual(corrupt);
	});

	test('evicts oldest pending entries before an atomic write exceeds its byte cap', async () => {
		const pending: object[] = [];
		for (let index = 0; index < 128; index++) {
			pending.push(storedPending(index, 'x'));
			const base = JSON.stringify(
				{ schemaVersion: 1, pending, receipts: [] },
				null,
				2,
			);
			const padding =
				MAX_PHASE_PARTICIPATION_BYTES - 50 - Buffer.byteLength(base);
			if (padding >= 0 && padding <= 4095) {
				pending[pending.length - 1] = storedPending(
					index,
					'x'.repeat(1 + padding),
				);
				break;
			}
			pending[pending.length - 1] = storedPending(index, 'x'.repeat(4096));
		}
		const nearLimit = JSON.stringify(
			{ schemaVersion: 1, pending, receipts: [] },
			null,
			2,
		);
		expect(Buffer.byteLength(nearLimit)).toBeLessThanOrEqual(
			MAX_PHASE_PARTICIPATION_BYTES,
		);
		expect(
			MAX_PHASE_PARTICIPATION_BYTES - Buffer.byteLength(nearLimit),
		).toBeLessThan(100);
		fs.writeFileSync(evidencePath, nearLimit);

		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'new-parent',
			callId: 'new-call',
			args: { subagent_type: 'docs' },
			policy: {},
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'new-parent',
			callId: 'new-call',
			output: {
				output: '<task id="new-child" state="running"></task>',
				metadata: { background: true, status: 'running' },
			},
		});

		const finalBytes = fs.readFileSync(evidencePath);
		const store = JSON.parse(finalBytes.toString('utf8')) as {
			pending: Array<{ childSessionId: string }>;
		};
		expect(finalBytes.byteLength).toBeLessThanOrEqual(
			MAX_PHASE_PARTICIPATION_BYTES,
		);
		expect(
			store.pending.some((entry) => entry.childSessionId === 'new-child'),
		).toBe(true);
		expect(store.pending.length).toBeLessThan(pending.length + 1);
	});

	test('serializes concurrent pending writers without losing updates', async () => {
		const dispatches = Array.from({ length: 8 }, (_, index) => ({
			parentSessionId: `parent-${index}`,
			callId: `call-${index}`,
			childSessionId: `child-${index}`,
		}));
		await Promise.all(
			dispatches.map((dispatch) =>
				reserveApprovedPhaseParticipation({
					directory,
					tool: 'Task',
					parentSessionId: dispatch.parentSessionId,
					callId: dispatch.callId,
					args: { subagent_type: 'docs' },
					policy: {},
				}),
			),
		);
		await Promise.all(
			dispatches.map((dispatch) =>
				observePhaseParticipationToolResult({
					directory,
					tool: 'Task',
					parentSessionId: dispatch.parentSessionId,
					callId: dispatch.callId,
					output: {
						output: `<task id="${dispatch.childSessionId}" state="running"></task>`,
						metadata: {
							background: true,
							status: 'running',
							sessionId: dispatch.childSessionId,
						},
					},
				}),
			),
		);

		const store = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as {
			pending: Array<{ childSessionId: string }>;
		};
		expect(store.pending.map((entry) => entry.childSessionId).sort()).toEqual(
			dispatches.map((entry) => entry.childSessionId).sort(),
		);
	});

	test('rejects a durable receipt after the Git HEAD changes', async () => {
		git(directory, ['init']);
		commitWorkspace(directory, 'head-a');
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			args: { subagent_type: 'docs' },
			policy: {},
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			output: { output: 'Documentation updated.' },
		});
		expect(
			(await readPhaseParticipation(directory, plan(), 1, 'docs')).found,
		).toBe(true);

		commitWorkspace(directory, 'head-b');
		expect(
			(await readPhaseParticipation(directory, plan(), 1, 'docs')).found,
		).toBe(false);
	});

	test('does not mint foreground proof after the Git HEAD changes', async () => {
		git(directory, ['init']);
		commitWorkspace(directory, 'head-a');
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			args: { subagent_type: 'docs' },
			policy: {},
		});
		commitWorkspace(directory, 'head-b');
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			output: { output: 'Documentation updated.' },
		});

		expect(
			(await readPhaseParticipation(directory, plan(), 1, 'docs')).found,
		).toBe(false);
	});

	test('rejects a receipt after upstream advances while local HEAD stays fixed', async () => {
		git(directory, ['init']);
		commitWorkspace(directory, 'head-a');
		git(directory, ['branch', 'upstream-main', 'HEAD']);
		git(directory, ['branch', '--set-upstream-to=upstream-main']);
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			args: { subagent_type: 'docs' },
			policy: {},
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			output: { output: 'Documentation updated.' },
		});
		expect(
			(await readPhaseParticipation(directory, plan(), 1, 'docs')).found,
		).toBe(true);

		git(directory, [
			'-c',
			'user.name=Swarm Test',
			'-c',
			'user.email=swarm-test@example.invalid',
			'commit',
			'--allow-empty',
			'-m',
			'upstream-b',
		]);
		git(directory, ['update-ref', 'refs/heads/upstream-main', 'HEAD']);
		git(directory, ['reset', '--hard', 'HEAD^']);

		expect(
			(await readPhaseParticipation(directory, plan(), 1, 'docs')).found,
		).toBe(false);
	});
});
