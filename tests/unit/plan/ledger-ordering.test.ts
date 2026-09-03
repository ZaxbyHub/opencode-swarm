import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals, quarantineLedgerSuffix } from '../../../src/plan/ledger';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

describe('plan ledger recovery ordering', () => {
	test('selects the code-unit-first matching quarantine archive despite reversed enumeration', async () => {
		const { dir, cleanup } = createSafeTestDir('ledger-ordering-');
		const originalReadDirectory = _internals.readLedgerDirectory;
		try {
			const suffix = '{"event":"recover-me"}\n';
			const hash = createHash('sha256')
				.update(suffix, 'utf8')
				.digest('hex')
				.slice(0, 12);
			const first = `plan-ledger.quarantine.100.${hash}`;
			const second = `plan-ledger.quarantine.200.${hash}`;
			const swarmDir = path.join(dir, '.swarm');
			fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
			fs.mkdirSync(swarmDir, { recursive: true });
			fs.writeFileSync(path.join(swarmDir, first), suffix);
			fs.writeFileSync(path.join(swarmDir, second), suffix);
			_internals.readLedgerDirectory = () => [second, first];

			const result = await quarantineLedgerSuffix(dir, suffix);
			expect(result.path).toBe(path.join(swarmDir, first));
		} finally {
			_internals.readLedgerDirectory = originalReadDirectory;
			cleanup();
		}
	});
});
