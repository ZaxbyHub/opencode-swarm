import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	listActive,
	PR_SUBSCRIPTION_LIMITS,
	PR_SUBSCRIPTIONS_AUDIT_FILE,
	PR_SUBSCRIPTIONS_CHECKPOINT_FILE,
	PR_SUBSCRIPTIONS_FILE,
	subscribe,
	unsubscribe,
} from '../../../src/background/pr-subscriptions';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makeTempProject(): string {
	const dir = canonicalMkdtemp('swarm-pr-sub-hardening-');
	fs.mkdirSync(path.join(dir, '.swarm', 'pr-monitor'), { recursive: true });
	return dir;
}

function input(sessionID: string, prNumber: number) {
	return {
		sessionID,
		prNumber,
		repoFullName: 'owner/repo',
		prUrl: `https://github.com/owner/repo/pull/${prNumber}`,
	};
}

function checkpointPath(dir: string): string {
	return path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE);
}

describe('pr-subscriptions post-review hardening', () => {
	let dir: string;
	const realAuditCompactionWrite = _internals.auditCompactionWrite;
	const realStatSync = _internals.statSync;

	beforeEach(() => {
		dir = makeTempProject();
	});

	afterEach(() => {
		_internals.auditCompactionWrite = realAuditCompactionWrite;
		_internals.statSync = realStatSync;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('failed audit compaction does not publish a dropped-transition count', async () => {
		const record = await subscribe(dir, input('session-1', 1));
		const auditPath = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_AUDIT_FILE);
		const filler = 'x'.repeat(256);
		fs.writeFileSync(
			auditPath,
			Array.from(
				{ length: PR_SUBSCRIPTION_LIMITS.auditMaxLinesHigh + 100 },
				(_, i) => `{"ts":${i},"seq":1,"kind":"reset","note":"${filler}"}`,
			).join('\n') + '\n',
			'utf-8',
		);
		const before = fs.readFileSync(auditPath, 'utf-8');
		_internals.auditCompactionWrite = () => {
			throw Object.assign(new Error(`injected audit failure ${dir}`), {
				code: 'EIO',
			});
		};

		await unsubscribe(dir, record.correlationId);

		const checkpoint = JSON.parse(
			fs.readFileSync(checkpointPath(dir), 'utf-8'),
		) as { maintenance: { droppedAuditTransitions: number } };
		expect(checkpoint.maintenance.droppedAuditTransitions).toBe(0);
		expect(fs.readFileSync(auditPath, 'utf-8')).toContain(before);
	});

	test('admitted 8–64 MiB legacy stores converge during read bootstrap', async () => {
		const legacyPath = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		const oversizedLine = `{"padding":"${'x'.repeat(9 * 1024 * 1024)}"}\n`;
		fs.writeFileSync(legacyPath, oversizedLine, 'utf-8');
		expect(fs.statSync(legacyPath).size).toBeGreaterThan(
			PR_SUBSCRIPTION_LIMITS.migrationMaxBytesPerOperation,
		);
		expect(fs.statSync(legacyPath).size).toBeLessThanOrEqual(
			PR_SUBSCRIPTION_LIMITS.legacySourceMaxBytes,
		);

		expect(await listActive(dir)).toEqual([]);
		expect(fs.existsSync(checkpointPath(dir))).toBe(true);
	});

	test('filesystem failures expose only a stable error code to callers', async () => {
		const record = await subscribe(dir, input('session-1', 1));
		const checkpoint = JSON.parse(
			fs.readFileSync(checkpointPath(dir), 'utf-8'),
		) as { rootPath: string };
		checkpoint.rootPath = path.join(dir, 'foreign-root');
		fs.writeFileSync(checkpointPath(dir), `${JSON.stringify(checkpoint)}\n`);
		_internals.statSync = () => {
			throw Object.assign(new Error(`secret absolute path ${dir}`), {
				code: 'EIO',
			});
		};

		const result = await subscribe(dir, input('session-2', 2)).then(
			() => null,
			(error: unknown) =>
				error instanceof Error ? error.message : String(error),
		);
		expect(result).toContain('EIO');
		expect(result).not.toContain(dir);
		expect(record.correlationId).toContain('session-1');
	});
});
