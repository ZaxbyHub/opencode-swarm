import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runPreCheckBatch } from '../../../src/tools/pre-check-batch';

let tempDir: string;

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-secrets-')),
	);
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('pre_check_batch file-scoped secretscan registry coverage', () => {
	test('hard-fails the gate for AWS access keys in changed files', async () => {
		const awsAccessKey = 'AK' + 'IAIOSFODNN7EXAMPLE';
		fs.writeFileSync(
			path.join(tempDir, 'secrets.env'),
			`AWS_ACCESS_KEY_ID=${awsAccessKey}\n`,
		);

		const result = await runPreCheckBatch({
			directory: tempDir,
			files: ['secrets.env'],
		});

		expect(result.secretscan.ran).toBe(true);
		expect(result.gates_passed).toBe(false);
		expect(result.secretscan.result).toBeDefined();
		const secrets = result.secretscan.result as {
			count: number;
			findings: Array<{ type: string }>;
		};
		expect(secrets.count).toBeGreaterThan(0);
		expect(secrets.findings.some((f) => f.type === 'aws_access_key')).toBe(
			true,
		);
	});
});
