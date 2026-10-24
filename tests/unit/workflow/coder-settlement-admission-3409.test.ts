import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import { _internals } from '../../../src/workflow/coder-settlement';
import {
	assertSettlementArtifactsRemovable,
	withSettlementArtifactLifecycle,
} from '../../../src/worktree/settlement-artifact-lifecycle';
import {
	begin,
	deferred,
	fixture,
	git,
	readWal,
	TASK,
	walPath,
} from '../../helpers/coder-settlement-3409';

const roots: string[] = [];
const originalLifecycle = _internals.withSettlementArtifactLifecycle;
afterEach(() => {
	_internals.withSettlementArtifactLifecycle = originalLifecycle;
	_internals.liveDispatches.clear();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe('#3409 dispatch publication and destructive admission serialize', () => {
	test('publication winning the lifecycle lock protects lane before cleanup can delete', async () => {
		const f = fixture('publication-first');
		roots.push(f.root);
		const published = deferred();
		const release = deferred();
		_internals.withSettlementArtifactLifecycle = (directory, operation) =>
			originalLifecycle(directory, async () => {
				const result = await operation();
				published.resolve();
				await release.promise;
				return result;
			});
		const dispatch = begin(f);
		await published.promise;
		expect(readWal(f).state).toBe('DISPATCHED');
		let deleted = false;
		const cleanup = withSettlementArtifactLifecycle(f.repo, async () => {
			await assertSettlementArtifactsRemovable(f.repo, {
				path: f.lane,
				branch: f.branch,
			});
			git(f.repo, ['worktree', 'remove', '--force', f.lane]);
			deleted = true;
		});
		const refusal = expect(cleanup).rejects.toThrow(
			/CODER_SETTLEMENT_ARTIFACT_(PROTECTED|UNCERTAIN)/,
		);
		release.resolve();
		await dispatch;
		await refusal;
		expect(deleted).toBe(false);
		expect(fs.existsSync(f.lane)).toBe(true);
		expect(readWal(f).state).toBe('DISPATCHED');
	});
	test('cleanup winning before admission refuses dispatch without publishing child state', async () => {
		const f = fixture('cleanup-first');
		roots.push(f.root);
		const reachedAdmission = deferred();
		const resumeAdmission = deferred();
		_internals.withSettlementArtifactLifecycle = async (
			directory,
			operation,
		) => {
			reachedAdmission.resolve();
			await resumeAdmission.promise;
			return originalLifecycle(directory, operation);
		};
		const dispatch = begin(f);
		const result = dispatch.then(
			() => ({ error: undefined }),
			(error: unknown) => ({ error }),
		);
		await Promise.race([
			reachedAdmission.promise,
			dispatch.then(() => {
				throw new Error('dispatch bypassed admission');
			}),
		]);
		await withSettlementArtifactLifecycle(f.repo, async () => {
			await assertSettlementArtifactsRemovable(f.repo, {
				path: f.lane,
				branch: f.branch,
			});
			git(f.repo, ['worktree', 'remove', '--force', f.lane]);
			git(f.repo, ['branch', '-D', f.branch]);
		});
		resumeAdmission.resolve();
		expect((await result).error).toBeInstanceOf(Error);
		expect(fs.existsSync(walPath(f))).toBe(false);
		expect(
			getTaskWorkflowSnapshot(await readTaskEvidence(f.repo, TASK)),
		).toMatchObject({ generation: 0 });
		expect(_internals.liveDispatches.size).toBe(0);
	});
	test('a changed live lane head is rejected before dispatch transition', async () => {
		const f = fixture('changed-head');
		roots.push(f.root);
		fs.writeFileSync(
			path.join(f.lane, 'source.txt'),
			'changed after capture\n',
		);
		git(f.lane, ['add', '.']);
		git(f.lane, ['commit', '-m', 'moved lane']);
		await expect(begin(f)).rejects.toThrow(
			'CODER_SETTLEMENT_DISPATCH_ARTIFACT_CHANGED',
		);
		expect(fs.existsSync(walPath(f))).toBe(false);
		expect(
			getTaskWorkflowSnapshot(await readTaskEvidence(f.repo, TASK)),
		).toMatchObject({ generation: 0 });
	});
	test('a descriptor naming another branch cannot publish a dispatch', async () => {
		const f = fixture('foreign-branch');
		roots.push(f.root);
		f.descriptor.branchName = 'swarm-lane/foreign/lane-1';
		await expect(begin(f)).rejects.toThrow(
			'CODER_SETTLEMENT_DISPATCH_ARTIFACT_CHANGED',
		);
		expect(fs.existsSync(walPath(f))).toBe(false);
		expect(git(f.lane, ['symbolic-ref', '--short', 'HEAD'])).toBe(f.branch);
	});
});
