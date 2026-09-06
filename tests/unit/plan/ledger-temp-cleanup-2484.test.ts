import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/plan/ledger.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalInternals = { ..._internals };
const tempRoots: string[] = [];

function makeRoot(label: string): string {
	const root = canonicalMkdtemp(`ledger-temp-${label}-`);
	fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });
	tempRoots.push(root);
	return root;
}

afterEach(() => {
	Object.assign(_internals, originalInternals);
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('plan-ledger archive staging cleanup (#2484)', () => {
	test('uses a random suffix and removes the staging path after rename', () => {
		const root = makeRoot('rename');
		const writes: string[] = [];
		_internals.writeFileFsyncedThenRename = (tempPath, targetPath, data) => {
			writes.push(tempPath);
			originalInternals.writeFileFsyncedThenRename(tempPath, targetPath, data);
		};

		const archived = _internals.archiveLegacyLedger(
			root,
			Buffer.from('legacy'),
		);

		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatch(/\.tmp\.[0-9a-f]{32}$/);
		expect(fs.existsSync(writes[0]!)).toBe(false);
		expect(fs.readFileSync(archived.path, 'utf8')).toBe('legacy');
	});

	test('removes a staging path when publication fails', () => {
		const root = makeRoot('failure');
		let tempPath = '';
		_internals.writeFileFsyncedThenRename = (stagingPath) => {
			tempPath = stagingPath;
			fs.writeFileSync(stagingPath, 'partial');
			throw new Error('injected archive publication failure');
		};

		expect(() =>
			_internals.archiveLegacyLedger(root, Buffer.from('legacy-failure')),
		).toThrow('injected archive publication failure');
		expect(tempPath).toMatch(/\.tmp\.[0-9a-f]{32}$/);
		expect(fs.existsSync(tempPath)).toBe(false);
	});

	test('portable SQLite export uses a random suffix and cleans up on failure', () => {
		const root = makeRoot('portable-export');
		const writes: string[] = [];
		_internals.writeFileFsyncedThenRename = (tempPath, targetPath, data) => {
			writes.push(tempPath);
			originalInternals.writeFileFsyncedThenRename(tempPath, targetPath, data);
		};

		_internals.writePortableLedger(root, [
			new Uint8Array(Buffer.from('{"seq":1}')),
		]);
		expect(writes[0]).toMatch(/\.sqlite-export\.[0-9a-f]{32}\.tmp$/);
		expect(fs.existsSync(writes[0]!)).toBe(false);

		let failedTempPath = '';
		_internals.writeFileFsyncedThenRename = (tempPath) => {
			failedTempPath = tempPath;
			fs.writeFileSync(tempPath, 'partial');
			throw new Error('injected portable export failure');
		};
		expect(() =>
			_internals.writePortableLedger(root, [
				new Uint8Array(Buffer.from('{"seq":2}')),
			]),
		).toThrow('injected portable export failure');
		expect(failedTempPath).toMatch(/\.sqlite-export\.[0-9a-f]{32}\.tmp$/);
		expect(fs.existsSync(failedTempPath)).toBe(false);
	});
});
