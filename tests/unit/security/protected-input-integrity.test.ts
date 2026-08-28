import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	snapshotProtectedSet,
	snapshotProtectedTree,
	verifyProtectedSet,
	verifyProtectedTree,
	withProtectedInputIntegrity,
} from '../../../src/security/protected-input-integrity.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
	const root = canonicalMkdtemp('swarm-integrity-');
	roots.push(root);
	writeFileSync(path.join(root, 'task.json'), '{"expected":1}');
	return root;
}

describe('protected input integrity', () => {
	test('accepts an unchanged protected tree', async () => {
		const root = fixture();
		await verifyProtectedTree(await snapshotProtectedTree(root));
	});

	test('detects protected content mutation', async () => {
		const root = fixture();
		const before = await snapshotProtectedTree(root);
		writeFileSync(path.join(root, 'task.json'), '{"expected":2}');
		await expect(verifyProtectedTree(before)).rejects.toThrow(
			'PROTECTED_INPUT_INTEGRITY_VIOLATION',
		);
	});

	test('verifies in finally when evaluation throws', async () => {
		const root = fixture();
		await expect(
			withProtectedInputIntegrity(root, async () => {
				writeFileSync(path.join(root, 'task.json'), 'tampered');
				throw new Error('executor failed');
			}),
		).rejects.toThrow('PROTECTED_INPUT_INTEGRITY_VIOLATION');
	});

	test('detects creation of a previously missing protected root', async () => {
		const root = fixture();
		const missing = path.join(root, 'protected-new');
		const before = await snapshotProtectedSet([missing]);
		writeFileSync(missing, 'created');
		await expect(verifyProtectedSet(before)).rejects.toThrow(
			'PROTECTED_INPUT_INTEGRITY_VIOLATION',
		);
	});

	test('rejects a symlinked child as ambiguous protected input', async () => {
		const root = fixture();
		const realDir = path.join(root, 'real');
		const linkDir = path.join(root, 'linked');
		mkdirSync(realDir, { recursive: true });
		writeFileSync(path.join(realDir, 'payload.json'), '{"ok":true}');
		try {
			symlinkSync(realDir, linkDir, 'junction');
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'EPERM' || code === 'EACCES') return;
			throw error;
		}
		await expect(snapshotProtectedTree(root)).rejects.toThrow(
			'PROTECTED_INPUT_AMBIGUOUS:linked',
		);
	});
});
