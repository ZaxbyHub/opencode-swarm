import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plan } from '../../../src/config/plan-schema';
import {
	_internals as coordinationInternals,
	transitionCoordinationState,
} from '../../../src/db/coordination-store.js';
import {
	closeAllProjectDbs,
	getProjectDb,
} from '../../../src/db/project-db.js';
import {
	createScopeBinding,
	type ScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	claimScopeBindingForChildDurably,
	persistAndRegisterScopeBinding,
	readScopeBindingFromDisk,
	writeScopeBindingToDisk,
} from '../../../src/scope/scope-persistence';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const cleanups: Array<() => void> = [];

function fixture(): { directory: string; plan: Plan } {
	const created = createSafeTestDir('scope-sqlite-auth-2481-');
	cleanups.push(created.cleanup);
	fs.mkdirSync(path.join(created.dir, '.swarm', 'scopes'), { recursive: true });
	return {
		directory: created.dir,
		plan: {
			schema_version: '1.0.0',
			title: 'Scope SQLite authority',
			swarm: 'default',
			phases: [
				{
					id: 1,
					name: 'Fix',
					status: 'pending',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'repair scope authority',
							depends: [],
							files_touched: ['src/scope/scope-persistence.ts'],
						},
					],
				},
			],
		},
	};
}

function exactPath(directory: string, binding: ScopeBinding): string {
	const name = `binding-${binding.taskId}-${binding.bindingId}-${binding.generationId}.json`;
	return path.join(directory, '.swarm', 'scopes', name);
}

function legacyWrite(binding: ScopeBinding, directory: string): void {
	fs.writeFileSync(
		exactPath(directory, binding),
		JSON.stringify(binding, null, 2),
	);
}

function pendingBinding(directory: string, plan: Plan): ScopeBinding {
	const binding = createScopeBinding({
		directory,
		plan,
		taskId: '1.1',
		files: ['src/a.ts'],
		ownerSessionId: 'architect-session',
		ownerMessageId: 'task-call',
		dispatchCallId: 'task-call',
		source: 'plan',
	});
	if (!binding) throw new Error('pending binding fixture failed');
	return binding;
}

function declarationBinding(directory: string, plan: Plan): ScopeBinding {
	const binding = createScopeBinding({
		directory,
		plan,
		taskId: '1.1',
		files: ['src/a.ts'],
		ownerSessionId: 'architect-session',
		ownerMessageId: 'declare-call',
		source: 'declare_scope',
	});
	if (!binding) throw new Error('declaration binding fixture failed');
	return binding;
}

function claimReceiptPath(directory: string, binding: ScopeBinding): string {
	const digest = createHash('sha256')
		.update(
			`${binding.bindingId}\0${binding.generationId}\0${binding.dispatchCallId ?? ''}`,
		)
		.digest('hex')
		.slice(0, 40);
	return path.join(directory, '.swarm', 'scopes', `claim-${digest}.json`);
}

function waitForFile(filePath: string, deadlineMs = 5_000): boolean {
	const gate = new Int32Array(new SharedArrayBuffer(4));
	const start = performance.now();
	while (performance.now() - start < deadlineMs) {
		if (fs.existsSync(filePath)) return true;
		Atomics.wait(gate, 0, 0, 25);
	}
	return fs.existsSync(filePath);
}

afterEach(() => {
	coordinationInternals.coordinationFaultInjector = undefined;
	closeAllProjectDbs();
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe('scope binding SQLite authority cutover (#2481)', () => {
	test('recovers archive work after an import commit crash', () => {
		const { directory, plan } = fixture();
		const binding = declarationBinding(directory, plan);
		legacyWrite(binding, directory);
		coordinationInternals.coordinationFaultInjector = (point) => {
			if (point === 'after_commit_before_archive') {
				throw new Error('scope archive crash');
			}
		};
		expect(
			readScopeBindingFromDisk({
				directory,
				taskId: '1.1',
				plan,
				ownerSessionId: binding.ownerSessionId,
				requireDeclaration: true,
			}),
		).toBeNull();
		coordinationInternals.coordinationFaultInjector = undefined;
		expect(
			readScopeBindingFromDisk({
				directory,
				taskId: '1.1',
				plan,
				ownerSessionId: binding.ownerSessionId,
				requireDeclaration: true,
			}),
		).toMatchObject({ generationId: binding.generationId });
		expect(fs.existsSync(`${exactPath(directory, binding)}.imported`)).toBe(
			true,
		);
	});

	test('a durable revocation overrides a stale same-process cache entry', async () => {
		const { directory, plan } = fixture();
		const binding = declarationBinding(directory, plan);
		expect(
			await persistAndRegisterScopeBinding(directory, binding),
		).toMatchObject({ ok: true });
		expect(
			readScopeBindingFromDisk({
				directory,
				taskId: '1.1',
				plan,
				ownerSessionId: binding.ownerSessionId,
				requireDeclaration: true,
			}),
		).not.toBeNull();
		const row = getProjectDb(directory)
			.query<{ revision: number }, [string, string]>(
				'SELECT revision FROM coordination_state WHERE namespace = ? AND entity_key = ?',
			)
			.get('scope-binding', binding.generationId);
		if (!row) throw new Error('scope authority row missing');
		const revoked = {
			...binding,
			revision: binding.revision + 1,
			lifecycleState: 'revoked' as const,
			updatedAt: binding.updatedAt + 1,
		};
		expect(
			transitionCoordinationState(directory, {
				namespace: 'scope-binding',
				entityKey: binding.generationId,
				expectedRevision: row.revision,
				generation: revoked.revision,
				status: 'revoked',
				payload: JSON.stringify(revoked),
			}).outcome,
		).toBe('applied');
		expect(
			readScopeBindingFromDisk({
				directory,
				taskId: '1.1',
				plan,
				ownerSessionId: binding.ownerSessionId,
				requireDeclaration: true,
			}),
		).toBeNull();
	});

	test('valid legacy declaration imports once and archives the source after commit', () => {
		const { directory, plan } = fixture();
		const binding = declarationBinding(directory, plan);
		legacyWrite(binding, directory);

		const resolved = readScopeBindingFromDisk({
			directory,
			taskId: '1.1',
			plan,
			ownerSessionId: binding.ownerSessionId,
			requireDeclaration: true,
		});

		expect(resolved).toMatchObject({
			generationId: binding.generationId,
			bindingId: binding.bindingId,
		});
		expect(fs.existsSync(exactPath(directory, binding))).toBe(true);
		expect(fs.existsSync(`${exactPath(directory, binding)}.imported`)).toBe(
			true,
		);
		expect(
			getProjectDb(directory)
				.query<{ revision: number; status: string }, [string, string]>(
					`SELECT revision, status FROM coordination_state
					 WHERE namespace = ? AND entity_key = ?`,
				)
				.get('scope-binding', binding.generationId),
		).toEqual({ revision: 1, status: 'live' });
	});

	test('archive collision keeps the canonical .imported file and preserves the new source in a suffixed archive', () => {
		const { directory, plan } = fixture();
		const binding = declarationBinding(directory, plan);
		legacyWrite(binding, directory);
		const canonicalArchive = `${exactPath(directory, binding)}.imported`;
		fs.writeFileSync(canonicalArchive, 'prior-archive');

		const resolved = readScopeBindingFromDisk({
			directory,
			taskId: '1.1',
			plan,
			ownerSessionId: binding.ownerSessionId,
			requireDeclaration: true,
		});

		expect(resolved).toMatchObject({ generationId: binding.generationId });
		expect(fs.readFileSync(canonicalArchive, 'utf8')).toBe('prior-archive');
		expect(fs.existsSync(`${canonicalArchive}.1`)).toBe(true);
		expect(
			JSON.parse(
				fs.readFileSync(`${canonicalArchive}.1`, 'utf8'),
			) as ScopeBinding,
		).toMatchObject({
			generationId: binding.generationId,
			bindingId: binding.bindingId,
		});
		expect(fs.existsSync(exactPath(directory, binding))).toBe(true);
	});

	test('corrupt legacy claim receipt fails closed and leaves authority unimported', async () => {
		const { directory, plan } = fixture();
		const binding = pendingBinding(directory, plan);
		legacyWrite(binding, directory);
		fs.writeFileSync(
			claimReceiptPath(directory, binding),
			JSON.stringify({
				version: 1,
				predecessorGenerationId: binding.generationId,
				winnerGenerationId: '33333333-3333-4333-a333-333333333333',
				childSessionId: 'coder-session',
				dispatchCallId: 'task-call',
				createdAt: binding.declaredAt,
			}),
		);

		const result = await claimScopeBindingForChildDurably({
			directory,
			parentSessionId: 'architect-session',
			childSessionId: 'coder-session',
			dispatchCallId: 'task-call',
		});

		expect(result).toMatchObject({
			ok: false,
			code: 'SCOPE_BINDING_PERSISTENCE_FAILED',
		});
		if (result.ok) throw new Error('corrupt import unexpectedly succeeded');
		expect(result.message).toContain('has no winner generation');
		expect(fs.existsSync(`${exactPath(directory, binding)}.imported`)).toBe(
			false,
		);
		expect(
			getProjectDb(directory)
				.query<{ count: number }, [string]>(
					'SELECT COUNT(*) AS count FROM coordination_state WHERE namespace = ?',
				)
				.get('scope-binding')?.count,
		).toBe(0);
		expect(
			getProjectDb(directory)
				.query<{ count: number }, [string]>(
					'SELECT COUNT(*) AS count FROM coordination_import WHERE source = ?',
				)
				.get('scope-binding-v2')?.count,
		).toBe(0);
	});

	test('generation identity remains immutable across rewrite attempts', async () => {
		const { directory, plan } = fixture();
		const binding = declarationBinding(directory, plan);
		expect(await writeScopeBindingToDisk(directory, binding)).toMatchObject({
			ok: true,
		});

		const colliding: ScopeBinding = {
			...binding,
			bindingId: randomUUID(),
			ownerMessageId: 'changed-owner-message',
		};
		const rejected = await writeScopeBindingToDisk(directory, colliding);
		expect(rejected).toMatchObject({
			ok: false,
			code: 'SCOPE_BINDING_STALE',
		});

		const resolved = readScopeBindingFromDisk({
			directory,
			taskId: '1.1',
			plan,
			ownerSessionId: binding.ownerSessionId,
			requireDeclaration: true,
		});
		expect(resolved).toMatchObject({
			generationId: binding.generationId,
			bindingId: binding.bindingId,
		});
	});

	test('legacy import preserves revision greater than one and future CAS updates advance from it', async () => {
		const { directory, plan } = fixture();
		const original = declarationBinding(directory, plan);
		const binding = {
			...original,
			revision: 3,
			updatedAt: original.declaredAt + 500,
		} satisfies ScopeBinding;
		legacyWrite(binding, directory);

		const resolved = readScopeBindingFromDisk({
			directory,
			taskId: '1.1',
			plan,
			ownerSessionId: binding.ownerSessionId,
			requireDeclaration: true,
		});
		expect(resolved).toMatchObject({
			generationId: binding.generationId,
			revision: 3,
		});
		expect(
			getProjectDb(directory)
				.query<{ revision: number; status: string }, [string, string]>(
					`SELECT revision, status FROM coordination_state
					 WHERE namespace = ? AND entity_key = ?`,
				)
				.get('scope-binding', binding.generationId),
		).toEqual({ revision: 3, status: 'live' });

		const advanced: ScopeBinding = {
			...binding,
			revision: 4,
			files: ['src/a.ts', 'src/b.ts'],
			updatedAt: binding.updatedAt + 1,
			expiresAt: binding.expiresAt + 60_000,
		};
		expect(await writeScopeBindingToDisk(directory, advanced)).toMatchObject({
			ok: true,
			value: {
				generationId: binding.generationId,
				revision: 4,
			},
		});
	});

	test(
		'real two-process duplicate child claims converge on one winner',
		{ timeout: 30_000 },
		async () => {
			const { directory, plan } = fixture();
			const pending = pendingBinding(directory, plan);
			expect(
				await persistAndRegisterScopeBinding(directory, pending),
			).toMatchObject({ ok: true });

			const repoRoot = path.resolve(import.meta.dir, '..', '..', '..');
			const scopePersistenceUrl = pathToFileURL(
				path.join(repoRoot, 'src', 'scope', 'scope-persistence.ts'),
			).href;
			const projectDbUrl = pathToFileURL(
				path.join(repoRoot, 'src', 'db', 'project-db.ts'),
			).href;
			const readyMarker = path.join(directory, 'worker-ready.marker');
			const goMarker = path.join(directory, 'worker-go.marker');
			const workerPath = path.join(directory, 'claim-worker.ts');
			const workerSource = `import { claimScopeBindingForChildDurably } from ${JSON.stringify(scopePersistenceUrl)};
import { closeAllProjectDbs } from ${JSON.stringify(projectDbUrl)};
import { existsSync, writeFileSync } from 'node:fs';
const directory = process.env.SWARM_SCOPE_DIR;
const readyMarker = process.env.SWARM_SCOPE_READY;
const goMarker = process.env.SWARM_SCOPE_GO;
if (!directory || !readyMarker || !goMarker) throw new Error('missing scope claim env');
writeFileSync(readyMarker, 'ready');
const gate = new Int32Array(new SharedArrayBuffer(4));
const start = performance.now();
while (!existsSync(goMarker) && performance.now() - start < 5000) Atomics.wait(gate, 0, 0, 25);
if (!existsSync(goMarker)) throw new Error('go marker missing');
const result = await claimScopeBindingForChildDurably({
	directory,
	parentSessionId: 'architect-session',
	childSessionId: 'coder-worker',
	dispatchCallId: 'task-call',
});
process.stdout.write(JSON.stringify(result));
closeAllProjectDbs();
`;
			fs.writeFileSync(workerPath, workerSource, 'utf8');

			let child: Bun.Subprocess | null = null;
			try {
				child = Bun.spawn([process.execPath, workerPath], {
					cwd: repoRoot,
					env: {
						...process.env,
						SWARM_SCOPE_DIR: directory,
						SWARM_SCOPE_READY: readyMarker,
						SWARM_SCOPE_GO: goMarker,
					},
					stdin: 'ignore',
					stdout: 'pipe',
					stderr: 'pipe',
				});
				expect(waitForFile(readyMarker)).toBe(true);
				fs.writeFileSync(goMarker, 'go');

				const parentResult = await claimScopeBindingForChildDurably({
					directory,
					parentSessionId: 'architect-session',
					childSessionId: 'coder-parent',
					dispatchCallId: 'task-call',
				});
				const exitCode = await child.exited;
				const stdout = child.stdout
					? await new Response(child.stdout).text()
					: '';
				const stderr = child.stderr
					? await new Response(child.stderr).text()
					: '';
				expect(exitCode).toBe(0);
				const workerResult = JSON.parse(stdout) as Awaited<
					ReturnType<typeof claimScopeBindingForChildDurably>
				> | null;
				if (!workerResult) {
					throw new Error(`worker produced no result: ${stderr || '<empty>'}`);
				}

				const all = [parentResult, workerResult];
				expect(all.filter((result) => result.ok)).toHaveLength(1);
				expect(
					all.filter((result) => !result.ok).map((result) => result.code),
				).toEqual(['SCOPE_BINDING_ALREADY_CLAIMED']);

				const winner = all.find((result) => result.ok);
				if (!winner || !winner.ok) throw new Error('winner missing');
				const resolved = readScopeBindingFromDisk({
					directory,
					taskId: '1.1',
					plan,
					ownerSessionId: winner.value.claimed.ownerSessionId,
					parentCallId: 'task-call',
				});
				expect(resolved).toMatchObject({
					generationId: winner.value.claimed.generationId,
					predecessorGenerationId: pending.generationId,
				});
			} finally {
				child?.kill();
			}
		},
	);
});
