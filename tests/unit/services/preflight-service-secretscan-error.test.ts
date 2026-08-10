import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals } from '../../../src/services/preflight-service';

let tempDir: string;
const originals = {
	runSecretscan: _internals.runSecretscan,
};

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-secrets-error-'));
	_internals.runSecretscan = (async () => ({
		error: 'scanner exploded',
		scan_dir: '',
		findings: [],
		count: 0,
		files_scanned: 0,
		skipped_files: 0,
	})) as typeof _internals.runSecretscan;
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
	_internals.runSecretscan = originals.runSecretscan;
});

describe('runSecretsCheck scanner errors', () => {
	test('fails closed when secretscan returns an error result', async () => {
		const result = await _internals.runSecretsCheck(tempDir, 60_000);

		expect(result.status).toBe('fail');
		expect(result.message).toContain('Secrets check failed');
		expect(result.message).toContain('scanner exploded');
		expect(result.details?.error).toBe('scanner exploded');
	});
});
