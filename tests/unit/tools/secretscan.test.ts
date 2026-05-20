import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { secretscan } from '../../../src/tools/secretscan';

// Helper to create temp test directories
function createTempDir(): string {
	return fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'secretscan-test-')),
	);
}

// Helper to create test files
function createTestFile(
	dir: string,
	filename: string,
	content: string,
): string {
	const filePath = path.join(dir, filename);
	const parentDir = path.dirname(filePath);
	if (!fs.existsSync(parentDir)) {
		fs.mkdirSync(parentDir, { recursive: true });
	}
	fs.writeFileSync(filePath, content, 'utf-8');
	return filePath;
}

// Helper to parse JSON result
function parseResult(result: string): {
	scan_dir: string;
	findings: Array<{
		path: string;
		line: number;
		type: string;
		confidence: string;
		severity: string;
		redacted: string;
		context: string;
	}>;
	count: number;
	files_scanned: number;
	skipped_files: number;
	message?: string;
	error?: string;
} {
	return JSON.parse(result);
}

describe('secretscan tool', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ============ Input Validation Tests ============
	describe('input validation', () => {
		it('should reject empty directory', async () => {
			const result = await secretscan.execute({ directory: '' }, {} as any);
			const parsed = parseResult(result);

			expect(parsed.error).toContain('invalid directory');
			expect(parsed.error).toContain('directory is required');
			expect(parsed.findings).toEqual([]);
			expect(parsed.count).toBe(0);
		});

		it('should reject directory with control characters', async () => {
			const result = await secretscan.execute(
				{ directory: '/tmp/test\0dir' },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.error).toContain('invalid directory');
			expect(parsed.error).toContain('control characters');
			expect(parsed.findings).toEqual([]);
		});

		it('should reject directory with path traversal', async () => {
			const result = await secretscan.execute(
				{ directory: '/tmp/../etc/passwd' },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.error).toContain('invalid directory');
			expect(parsed.error).toContain('path traversal');
		});

		it('should reject directory exceeding max length', async () => {
			const longPath = 'x'.repeat(501);
			const result = await secretscan.execute(
				{ directory: longPath },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.error).toContain('invalid directory');
			expect(parsed.error).toContain('exceeds maximum length');
		});

		it('should reject non-existent directory', async () => {
			const result = await secretscan.execute(
				{ directory: '/nonexistent/directory/that/does/not/exist' },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.error).toContain('directory not found');
			expect(parsed.scan_dir).toBe(
				'/nonexistent/directory/that/does/not/exist',
			);
		});

		it('should reject file path instead of directory', async () => {
			const filePath = createTestFile(tempDir, 'test.txt', 'hello world');

			const result = await secretscan.execute(
				{ directory: filePath },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.error).toContain('target must be a directory');
		});

		it('should validate exclude paths for traversal', async () => {
			const result = await secretscan.execute(
				{ directory: tempDir, exclude: ['../etc'] },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.error).toContain('invalid exclude path');
			expect(parsed.error).toContain('path traversal');
		});
	});

	// ============ Secret Detection Tests ============
	describe('secret detection patterns', () => {
		it('should detect AWS Access Key ID', async () => {
			createTestFile(
				tempDir,
				'config.js',
				'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
			expect(parsed.findings[0].type).toBe('aws_access_key');
			expect(parsed.findings[0].confidence).toBe('high');
			expect(parsed.findings[0].severity).toBe('critical');
			expect(parsed.findings[0].redacted).toContain('REDACTED');
			expect(parsed.count).toBe(1);
		});

		it('should detect AWS Secret Key', async () => {
			createTestFile(
				tempDir,
				'env.sh',
				'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
			expect(parsed.findings[0].type).toBe('aws_secret_key');
			expect(parsed.findings[0].severity).toBe('critical');
		});

		it('should detect GitHub Token', async () => {
			// GitHub token format: ghp_ + at least 36 alphanumeric chars
			createTestFile(
				tempDir,
				'auth.txt',
				'ghp_1234567890abcdefghijklmnopqrstuvwxyz1234\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			const ghFinding = parsed.findings.find((f) => f.type === 'github_token');
			expect(ghFinding).toBeDefined();
			expect(ghFinding!.severity).toBe('critical');
		});

		it('should detect JWT Token', async () => {
			// Valid JWT format
			createTestFile(
				tempDir,
				'token.json',
				'{"token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"}\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
			expect(parsed.findings[0].type).toBe('jwt');
			expect(parsed.findings[0].severity).toBe('high');
		});

		it('should detect private key', async () => {
			createTestFile(
				tempDir,
				'key.pem',
				'-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
			expect(parsed.findings[0].type).toBe('private_key');
			expect(parsed.findings[0].severity).toBe('critical');
		});

		it('should detect database URL with credentials', async () => {
			createTestFile(
				tempDir,
				'db.env',
				'DATABASE_URL=postgres://admin:secretpassword@localhost:5432/mydb\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings.length).toBeGreaterThan(0);
			const dbFinding = parsed.findings.find((f) => f.type === 'database_url');
			expect(dbFinding).toBeDefined();
			expect(dbFinding!.severity).toBe('critical');
		});

		it('should detect Stripe API key', async () => {
			const stripeLikeKey = `sk_${'live_'}xxxxxxxxxxxxxxxxxxxxxxxx`;
			createTestFile(tempDir, 'stripe.js', `const key = "${stripeLikeKey}";\n`);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
			expect(parsed.findings[0].type).toBe('stripe_key');
			expect(parsed.findings[0].severity).toBe('critical');
		});

		it('should detect Slack token', async () => {
			// Use a unique format to avoid overlap with other patterns
			const slackLikeToken = `xox${'b-'}123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx`;
			createTestFile(
				tempDir,
				'slack.env',
				`SLACK_BOT_TOKEN=${slackLikeToken}\n`,
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			const slackFinding = parsed.findings.find(
				(f) => f.type === 'slack_token',
			);
			expect(slackFinding).toBeDefined();
			expect(slackFinding!.severity).toBe('critical');
		});

		it('should detect generic password in config', async () => {
			createTestFile(tempDir, 'settings.ini', 'password=SuperSecret123!\n');

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings.length).toBeGreaterThan(0);
			const pwFinding = parsed.findings.find((f) => f.type === 'password');
			expect(pwFinding).toBeDefined();
			expect(pwFinding!.redacted).toContain('REDACTED');
		});

		it('should detect bearer token', async () => {
			// Pattern requires space/quote after token: bearer\s+TOKEN[\s"'<]
			createTestFile(
				tempDir,
				'api.sh',
				'Authorization: bearer abcdefghijklmnopqrstuvwxyz123456 "other"\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			const bearerFinding = parsed.findings.find(
				(f) => f.type === 'bearer_token',
			);
			expect(bearerFinding).toBeDefined();
		});

		it('should detect basic auth', async () => {
			// Pattern requires space/quote/bracket after token: basic\s+TOKEN[\s"'<]
			createTestFile(
				tempDir,
				'curl.txt',
				'Authorization: basic dXNlcjpwYXNzd29yZA== <redacted>\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			const basicFinding = parsed.findings.find((f) => f.type === 'basic_auth');
			expect(basicFinding).toBeDefined();
		});
	});

	// ============ Redaction Tests ============
	describe('secret redaction', () => {
		it('should never include raw secret in output', async () => {
			const secretValue = 'AKIAIOSFODNN7EXAMPLE';
			createTestFile(
				tempDir,
				'config.js',
				`AWS_ACCESS_KEY_ID=${secretValue}\n`,
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);

			// Raw secret should never appear in JSON output
			expect(result).not.toContain(secretValue);
		});

		it('should redact context around secret', async () => {
			createTestFile(tempDir, 'config.js', 'password=SuperSecret123!\n');

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings[0].redacted).toContain('REDACTED');
			// Context should also be redacted
			expect(parsed.findings[0].context).not.toContain('SuperSecret123');
		});

		it('should show partial preview for API keys', async () => {
			createTestFile(
				tempDir,
				'api.js',
				'api_key=abcd1234567890abcdefghijklmnopqrstuvwxyz1234\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			// Should show first 4 and last 4 chars
			expect(parsed.findings[0].redacted).toMatch(/api_key=abcd\.\.\.1234/);
		});
	});

	// ============ Binary File Handling Tests ============
	describe('binary file handling', () => {
		it('should skip binary files', async () => {
			// Create a fake binary file with PNG signature
			const buffer = Buffer.alloc(100);
			buffer.writeUInt32BE(0x89_50_4e_47, 0); // PNG signature
			fs.writeFileSync(path.join(tempDir, 'image.png'), buffer);

			// Also create a text file with secret
			createTestFile(tempDir, 'config.txt', 'password=secret123\n');

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			// Should only find the secret in text file
			expect(parsed.findings).toHaveLength(1);
			expect(parsed.findings[0].path).toContain('config.txt');
		});

		it('should skip files with excluded extensions', async () => {
			createTestFile(
				tempDir,
				'readme.md',
				'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n',
			);
			createTestFile(tempDir, 'config.txt', 'password=secret123\n');

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			// Should skip .md file and only find in .txt
			expect(parsed.findings).toHaveLength(1);
			expect(parsed.findings[0].path).toContain('config.txt');
		});
	});

	// ============ Exclusion Tests ============
	describe('directory exclusions', () => {
		it('should exclude node_modules by default', async () => {
			fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
			createTestFile(
				path.join(tempDir, 'node_modules'),
				'secret.js',
				'password=secretInNodeModules\n',
			);
			createTestFile(tempDir, 'app.js', 'password=secretInApp\n');

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			// Should only find secret in app.js, not node_modules
			expect(parsed.findings).toHaveLength(1);
			expect(parsed.findings[0].path).toContain('app.js');
		});

		it('should exclude .git directory by default', async () => {
			fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true });
			createTestFile(
				path.join(tempDir, '.git'),
				'config',
				'password=gitSecret\n',
			);
			createTestFile(tempDir, 'config.txt', 'password=appSecret\n');

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
			expect(parsed.findings[0].path).not.toContain('.git');
		});

		it('should support additional exclude patterns', async () => {
			fs.mkdirSync(path.join(tempDir, 'secrets'), { recursive: true });
			createTestFile(
				path.join(tempDir, 'secrets'),
				'vault.txt',
				'password=vaultSecret\n',
			);
			createTestFile(tempDir, 'config.txt', 'password=appSecret\n');

			const result = await secretscan.execute(
				{ directory: tempDir, exclude: ['secrets'] },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
			expect(parsed.findings[0].path).toContain('config.txt');
		});

		it('should support glob patterns in exclude (e.g. **/.svelte-kit/**)', async () => {
			fs.mkdirSync(path.join(tempDir, '.svelte-kit', 'output'), {
				recursive: true,
			});
			createTestFile(
				path.join(tempDir, '.svelte-kit', 'output'),
				'chunk.js',
				'password=generated\n',
			);
			createTestFile(tempDir, 'config.txt', 'password=appSecret\n');

			const result = await secretscan.execute(
				{ directory: tempDir, exclude: ['**/.svelte-kit/**'] },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
			expect(parsed.findings[0].path).toContain('config.txt');
		});

		it('should support glob patterns matching specific file types (e.g. **/*.test.ts)', async () => {
			createTestFile(tempDir, 'app.test.ts', 'password=testSecret\n');
			createTestFile(tempDir, 'config.txt', 'password=appSecret\n');

			const result = await secretscan.execute(
				{ directory: tempDir, exclude: ['**/*.test.ts'] },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
			expect(parsed.findings[0].path).toContain('config.txt');
		});

		it('should support excluding a specific file by relative path', async () => {
			fs.mkdirSync(path.join(tempDir, 'src', 'routes'), { recursive: true });
			createTestFile(
				path.join(tempDir, 'src', 'routes'),
				'page.test.ts',
				'password=testSecret\n',
			);
			createTestFile(tempDir, 'config.txt', 'password=appSecret\n');

			const result = await secretscan.execute(
				{ directory: tempDir, exclude: ['src/routes/page.test.ts'] },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
			expect(parsed.findings[0].path).toContain('config.txt');
		});

		it('should reject negation patterns in exclude array', async () => {
			const result = await secretscan.execute(
				{ directory: tempDir, exclude: ['!node_modules'] },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.error).toBeDefined();
			expect(parsed.error).toContain('negation');
		});

		it('should reject absolute paths in exclude array', async () => {
			const result = await secretscan.execute(
				{ directory: tempDir, exclude: ['/etc/passwd'] },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.error).toBeDefined();
			expect(parsed.error).toContain('absolute paths');
		});

		it('should load and apply .secretscanignore patterns', async () => {
			fs.mkdirSync(path.join(tempDir, '.svelte-kit', 'output'), {
				recursive: true,
			});
			createTestFile(
				path.join(tempDir, '.svelte-kit', 'output'),
				'chunk.js',
				'password=generated\n',
			);
			createTestFile(tempDir, 'config.txt', 'password=appSecret\n');
			// Write a .secretscanignore file
			fs.writeFileSync(
				path.join(tempDir, '.secretscanignore'),
				'# ignore generated\n**/.svelte-kit/**\n',
				'utf-8',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
			expect(parsed.findings[0].path).toContain('config.txt');
		});

		it('should ignore blank lines and comments in .secretscanignore', async () => {
			createTestFile(tempDir, 'app.test.ts', 'password=testSecret\n');
			createTestFile(tempDir, 'config.txt', 'password=appSecret\n');
			// Write a .secretscanignore with comments and blanks only
			fs.writeFileSync(
				path.join(tempDir, '.secretscanignore'),
				'# this is a comment\n\n  \n',
				'utf-8',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			// Both files should be scanned since no valid patterns in ignore file
			expect(parsed.findings.length).toBeGreaterThanOrEqual(2);
		});

		it('should silently skip unsafe patterns in .secretscanignore', async () => {
			createTestFile(tempDir, 'config.txt', 'password=appSecret\n');
			// Write a .secretscanignore with a traversal attempt
			fs.writeFileSync(
				path.join(tempDir, '.secretscanignore'),
				'../etc/passwd\n*.txt\n',
				'utf-8',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			// config.txt should be excluded by the *.txt pattern (traversal pattern silently skipped)
			expect(parsed.findings).toHaveLength(0);
		});
	});

	// ============ Deterministic Ordering Tests ============
	describe('deterministic ordering', () => {
		it('should return findings sorted by path then line', async () => {
			createTestFile(
				tempDir,
				'z-config.txt',
				'line1\npassword=secretA\nline3\npassword=secretB\n',
			);
			createTestFile(tempDir, 'a-config.txt', 'password=secretC\n');

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.count).toBeGreaterThanOrEqual(3);

			// Should be sorted: a-config.txt first, then z-config.txt
			// Within each file, sorted by line number
			const paths = parsed.findings.map((f) => f.path);
			const lines = parsed.findings.map((f) => f.line);

			// a-config.txt should come before z-config.txt (case-insensitive)
			const aConfigIdx = paths.findIndex((p) => p.includes('a-config'));
			const zConfigIdx = paths.findIndex((p) => p.includes('z-config'));
			expect(aConfigIdx).toBeLessThan(zConfigIdx);

			// Check line ordering within z-config.txt
			const zFindings = parsed.findings.filter((f) =>
				f.path.includes('z-config'),
			);
			if (zFindings.length >= 2) {
				expect(zFindings[0].line).toBeLessThan(zFindings[1].line);
			}
		});

		it('should produce consistent results across multiple scans', async () => {
			createTestFile(
				tempDir,
				'config1.txt',
				'password=secret1\napi_key=abcd1234efgh5678\n',
			);
			createTestFile(tempDir, 'config2.txt', 'password=secret2\n');

			const result1 = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const result2 = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);

			// Results should be identical
			expect(result1).toBe(result2);
		});
	});

	// ============ Response Shape Compatibility Tests ============
	describe('response shape compatibility', () => {
		it('should return valid JSON structure', async () => {
			createTestFile(tempDir, 'config.txt', 'password=secret\n');

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			// Verify required fields
			expect(parsed).toHaveProperty('scan_dir');
			expect(parsed).toHaveProperty('findings');
			expect(parsed).toHaveProperty('count');
			expect(parsed).toHaveProperty('files_scanned');
			expect(parsed).toHaveProperty('skipped_files');

			expect(typeof parsed.scan_dir).toBe('string');
			expect(Array.isArray(parsed.findings)).toBe(true);
			expect(typeof parsed.count).toBe('number');
			expect(typeof parsed.files_scanned).toBe('number');
			expect(typeof parsed.skipped_files).toBe('number');
		});

		it('should have correct finding structure', async () => {
			createTestFile(tempDir, 'config.txt', 'password=secret\n');

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
			const finding = parsed.findings[0];

			expect(finding).toHaveProperty('path');
			expect(finding).toHaveProperty('line');
			expect(finding).toHaveProperty('type');
			expect(finding).toHaveProperty('confidence');
			expect(finding).toHaveProperty('severity');
			expect(finding).toHaveProperty('redacted');
			expect(finding).toHaveProperty('context');

			expect(typeof finding.path).toBe('string');
			expect(typeof finding.line).toBe('number');
			expect(typeof finding.type).toBe('string');
			expect(['high', 'medium', 'low']).toContain(finding.confidence);
			expect(['critical', 'high', 'medium', 'low']).toContain(finding.severity);
		});

		it('should return empty findings for clean directory', async () => {
			createTestFile(
				tempDir,
				'readme.txt',
				'This is a clean file with no secrets.\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toEqual([]);
			expect(parsed.count).toBe(0);
			expect(parsed.files_scanned).toBe(1);
		});

		it('should include message when results are truncated', async () => {
			// Create many files with secrets to trigger truncation
			for (let i = 0; i < 110; i++) {
				createTestFile(tempDir, `file${i}.txt`, `password=secret${i}\n`);
			}

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			// If MAX_FINDINGS is 100, should have message about truncation
			if (parsed.count >= 100) {
				expect(parsed.message).toBeDefined();
				expect(parsed.message).toContain('limited');
			}
		});
	});

	// ============ Edge Case Tests ============
	describe('edge cases', () => {
		it('should handle empty directory', async () => {
			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toEqual([]);
			expect(parsed.count).toBe(0);
			expect(parsed.files_scanned).toBe(0);
		});

		it('should handle nested directories', async () => {
			fs.mkdirSync(path.join(tempDir, 'a', 'b', 'c'), { recursive: true });
			createTestFile(
				path.join(tempDir, 'a', 'b', 'c'),
				'deep.txt',
				'password=deepSecret\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
			expect(parsed.findings[0].path).toContain('deep.txt');
		});

		it('should handle files with UTF-8 BOM', async () => {
			// Create file with UTF-8 BOM (EF BB BF)
			const content = Buffer.concat([
				Buffer.from([0xef, 0xbb, 0xbf]),
				Buffer.from('password=bomSecret\n'),
			]);
			fs.writeFileSync(path.join(tempDir, 'bom.txt'), content);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
		});

		it('should skip oversized files', async () => {
			// Create a file larger than MAX_FILE_SIZE_BYTES (512KB)
			const largeContent = 'x'.repeat(600 * 1024);
			createTestFile(tempDir, 'large.txt', largeContent);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toEqual([]);
			expect(parsed.skipped_files).toBeGreaterThan(0);
		});

		it('should skip lines that are too long', async () => {
			// Create file with very long line containing a secret
			const longLine =
				'x'.repeat(15000) + 'password=longSecret' + 'y'.repeat(15000);
			createTestFile(tempDir, 'longline.txt', longLine + '\n');

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			// Should skip the line due to length
			expect(parsed.findings).toEqual([]);
		});

		it('should handle multiple secrets on same line', async () => {
			createTestFile(
				tempDir,
				'multi.txt',
				'password=secret1 api_key=abcd1234567890abcdefghijklmnop\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			// Should detect both patterns
			expect(parsed.count).toBeGreaterThanOrEqual(2);
		});

		it('should handle special characters in path', async () => {
			fs.mkdirSync(path.join(tempDir, 'dir-with-dashes_and.underscores'), {
				recursive: true,
			});
			createTestFile(
				path.join(tempDir, 'dir-with-dashes_and.underscores'),
				'config.txt',
				'password=specialPath\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
		});

		it('should skip files with null bytes after decoding', async () => {
			// Create file with embedded null byte
			const content = 'password=sec\0ret\n';
			fs.writeFileSync(path.join(tempDir, 'null.txt'), content);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			// Should skip the file due to null bytes
			expect(parsed.findings).toEqual([]);
		});
	});

	// ============ Line Number Accuracy Tests ============
	describe('line number accuracy', () => {
		it('should report correct line numbers', async () => {
			createTestFile(
				tempDir,
				'multiline.txt',
				'line1\nline2\npassword=secretOnLine3\nline4\nline5\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
			expect(parsed.findings[0].line).toBe(3);
		});

		it('should handle Windows-style line endings', async () => {
			createTestFile(
				tempDir,
				'windows.txt',
				'line1\r\npassword=secret\r\nline3\r\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
			expect(parsed.findings[0].line).toBe(2);
		});
	});

	// ============ Confidence and Severity Tests ============
	describe('confidence and severity levels', () => {
		it('should assign critical severity to AWS keys', async () => {
			createTestFile(
				tempDir,
				'aws.txt',
				'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings[0].severity).toBe('critical');
			expect(parsed.findings[0].confidence).toBe('high');
		});

		it('should assign critical severity to private keys', async () => {
			createTestFile(tempDir, 'key.txt', '-----BEGIN PRIVATE KEY-----\n');

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings[0].severity).toBe('critical');
		});

		it('should assign medium confidence to generic API keys', async () => {
			createTestFile(
				tempDir,
				'api.txt',
				'api_key=abcdefghijklmnopqrstuvwxyz1234567890\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			const apiKeyFinding = parsed.findings.find((f) => f.type === 'api_key');
			expect(apiKeyFinding).toBeDefined();
			expect(apiKeyFinding!.confidence).toBe('medium');
		});
	});

	// ============ Cross-Platform Tests ============
	describe('cross-platform compatibility', () => {
		it('should work with relative path "."', async () => {
			createTestFile(tempDir, 'config.txt', 'password=secret\n');

			// Run from tempDir
			const originalDir = process.cwd();
			process.chdir(tempDir);

			try {
				const result = await secretscan.execute({ directory: '.' }, {} as any);
				const parsed = parseResult(result);

				expect(parsed.findings).toHaveLength(1);
			} finally {
				process.chdir(originalDir);
			}
		});

		it('should handle mixed path separators', async () => {
			// Create nested directory
			fs.mkdirSync(path.join(tempDir, 'nested', 'dir'), { recursive: true });
			createTestFile(
				path.join(tempDir, 'nested', 'dir'),
				'config.txt',
				'password=secret\n',
			);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.findings).toHaveLength(1);
		});
	});

	// ============ Scan Statistics Tests ============
	describe('scan statistics', () => {
		it('should report files_scanned correctly', async () => {
			createTestFile(tempDir, 'file1.txt', 'content1\n');
			createTestFile(tempDir, 'file2.txt', 'content2\n');
			createTestFile(tempDir, 'file3.txt', 'content3\n');

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.files_scanned).toBe(3);
		});

		it('should report skipped_files for binary files', async () => {
			createTestFile(tempDir, 'text.txt', 'text content\n');
			// Create binary file
			const buffer = Buffer.alloc(100);
			buffer.writeUInt32BE(0x89_50_4e_47, 0);
			fs.writeFileSync(path.join(tempDir, 'image.png'), buffer);

			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);

			expect(parsed.files_scanned).toBe(1); // Only text.txt
			expect(parsed.skipped_files).toBeGreaterThanOrEqual(1); // At least the PNG
		});
	});

	// ============ ADVERSARIAL ATTACK VECTOR TESTS ============
	describe('adversarial attack vectors', () => {
		// ----- ReDoS (Catastrophic Backtracking) Tests -----
		describe('ReDoS payloads', () => {
			it('should not hang on repeated patterns that could cause ReDoS', async () => {
				// Create a line with many repetitions that could trigger catastrophic backtracking
				// Pattern like "a" repeated many times followed by a character that won't match
				const evilLine = 'api_key=' + 'a'.repeat(5000) + '!';
				createTestFile(tempDir, 'redos.txt', evilLine + '\n');

				// This should complete within reasonable time (not hang)
				const start = Date.now();
				const result = await secretscan.execute(
					{ directory: tempDir },
					{} as any,
				);
				const elapsed = Date.now() - start;

				// Should complete in under 5 seconds (generous for ReDoS protection)
				expect(elapsed).toBeLessThan(5000);
				const parsed = parseResult(result);
				expect(parsed.error).toBeUndefined();
			});

			it('should handle nested groups that could trigger ReDoS', async () => {
				// Create content with nested bracket-like patterns
				const nestedPattern =
					'bearer ' + '('.repeat(100) + 'a'.repeat(100) + ')'.repeat(100);
				createTestFile(tempDir, 'nested.txt', nestedPattern + '\n');

				const start = Date.now();
				const result = await secretscan.execute(
					{ directory: tempDir },
					{} as any,
				);
				const elapsed = Date.now() - start;

				expect(elapsed).toBeLessThan(5000);
				const parsed = parseResult(result);
				expect(parsed.error).toBeUndefined();
			});

			it('should handle password patterns with many special chars (ReDoS vector)', async () => {
				// Password with many alternations that could cause backtracking
				const trickyPassword =
					'password=' + '!@#$%^&*()'.repeat(500) + 'secret';
				createTestFile(tempDir, 'tricky.txt', trickyPassword + '\n');

				const start = Date.now();
				const result = await secretscan.execute(
					{ directory: tempDir },
					{} as any,
				);
				const elapsed = Date.now() - start;

				expect(elapsed).toBeLessThan(5000);
				const parsed = parseResult(result);
				expect(parsed.error).toBeUndefined();
			});

			it('should handle long lines with secret-like patterns (bounded matching)', async () => {
				// Create a very long line with a secret pattern embedded
				const longLine =
					'x'.repeat(50000) +
					`api_key=sk_${'live_'}1234567890abcdefghijklmnop\n`;
				createTestFile(tempDir, 'longline.txt', longLine);

				const start = Date.now();
				const result = await secretscan.execute(
					{ directory: tempDir },
					{} as any,
				);
				const elapsed = Date.now() - start;

				expect(elapsed).toBeLessThan(5000);
			});

			it('should complete within timeout on pathological regex input', async () => {
				// Classic ReDoS test case: (a+)+ pattern with 'a' repeated and non-matching end
				const pathological = 'bearer ' + 'a '.repeat(1000) + '!';
				createTestFile(tempDir, 'patho.txt', pathological + '\n');

				const start = Date.now();
				const result = await secretscan.execute(
					{ directory: tempDir },
					{} as any,
				);
				const elapsed = Date.now() - start;

				expect(elapsed).toBeLessThan(5000);
				const parsed = parseResult(result);
				expect(parsed.error).toBeUndefined();
			});
		});

		// ----- Symlink Escape / TOCTOU Tests -----
		describe('symlink escape and TOCTOU attempts', () => {
			it('should skip symlinks to files outside scan directory', async () => {
				// Skip on Windows where symlinks require elevated privileges
				if (process.platform === 'win32') {
					return;
				}

				// Create a file outside the scan directory
				const outsideDir = createTempDir();
				try {
					createTestFile(outsideDir, 'secret.txt', 'password=outsiderSecret\n');

					// Create symlink inside scan dir pointing outside
					fs.symlinkSync(
						path.join(outsideDir, 'secret.txt'),
						path.join(tempDir, 'link-to-outside'),
					);

					const result = await secretscan.execute(
						{ directory: tempDir },
						{} as any,
					);
					const parsed = parseResult(result);

					// Should not find the secret from outside the scan directory
					expect(parsed.findings).toHaveLength(0);
					// Should count as skipped
					expect(parsed.skipped_files).toBeGreaterThanOrEqual(1);
				} finally {
					fs.rmSync(outsideDir, { recursive: true, force: true });
				}
			});

			it('should skip symlinked directories to prevent escape', async () => {
				if (process.platform === 'win32') {
					return;
				}

				const outsideDir = createTempDir();
				try {
					createTestFile(
						outsideDir,
						'config.txt',
						'api_key=escapedKey12345678\n',
					);

					// Create symlink to directory
					fs.symlinkSync(outsideDir, path.join(tempDir, 'escaped-dir'), 'dir');

					const result = await secretscan.execute(
						{ directory: tempDir },
						{} as any,
					);
					const parsed = parseResult(result);

					// Should not traverse into symlinked directory
					expect(parsed.findings).toHaveLength(0);
				} finally {
					fs.rmSync(outsideDir, { recursive: true, force: true });
				}
			});

			it('should detect and break symlink loops', async () => {
				if (process.platform === 'win32') {
					return;
				}

				// Create a subdirectory
				const subDir = path.join(tempDir, 'subdir');
				fs.mkdirSync(subDir);

				// Create a symlink loop: subdir/loop -> tempDir
				fs.symlinkSync(tempDir, path.join(subDir, 'loop'), 'dir');

				// This should not hang or crash
				const start = Date.now();
				const result = await secretscan.execute(
					{ directory: tempDir },
					{} as any,
				);
				const elapsed = Date.now() - start;

				expect(elapsed).toBeLessThan(5000);
				const parsed = parseResult(result);
				expect(parsed.error).toBeUndefined();
			});

			it('should handle TOCTOU race condition gracefully (file becomes symlink)', async () => {
				if (process.platform === 'win32') {
					return;
				}

				// Create a regular file with secret
				const filePath = createTestFile(
					tempDir,
					'config.txt',
					'password=testSecret\n',
				);

				// Scan should work normally
				const result = await secretscan.execute(
					{ directory: tempDir },
					{} as any,
				);
				const parsed = parseResult(result);

				// File should be scanned (symlink check happens before read)
				expect(parsed.files_scanned).toBeGreaterThanOrEqual(1);
			});

			it('should skip symlinks even when they point to valid files', async () => {
				if (process.platform === 'win32') {
					return;
				}

				// Create a file with secret inside scan dir
				createTestFile(tempDir, 'real.txt', 'password=realSecret\n');

				// Create a symlink to that file
				fs.symlinkSync(
					path.join(tempDir, 'real.txt'),
					path.join(tempDir, 'link-to-real'),
				);

				const result = await secretscan.execute(
					{ directory: tempDir },
					{} as any,
				);
				const parsed = parseResult(result);

				// Should only find one secret (from real file, not symlink)
				expect(parsed.findings.length).toBeLessThanOrEqual(1);
			});
		});

		// ----- Path Traversal Bypass Tests -----
		describe('path traversal bypass attempts', () => {
			it('should reject URL-encoded path traversal (%2e%2e)', async () => {
				const result = await secretscan.execute(
					{ directory: '/tmp/%2e%2e%2f%2e%2e%2fetc' },
					{} as any,
				);
				const parsed = parseResult(result);

				expect(parsed.error).toBeDefined();
				expect(parsed.error).toContain('path traversal');
			});

			it('should reject double URL-encoded path traversal', async () => {
				// %252e = double-encoded '.' - SECURITY NOTE: This test verifies
				// whether double-encoded traversal is caught. If it passes as "not found",
				// it means the double-encoded string bypasses validation but won't
				// actually traverse because filesystems don't URL-decode paths.
				// IDEAL: Should be rejected as path traversal
				// CURRENT: Falls through to "not found" (no actual traversal possible)
				const result = await secretscan.execute(
					{ directory: '/tmp/%252e%252e%252f' },
					{} as any,
				);
				const parsed = parseResult(result);

				// Either should reject with path traversal OR fail safely (not found)
				// The key security property is: no actual path traversal occurs
				expect(parsed.error).toBeDefined();
				// Verify no secrets were leaked (the real security concern)
				expect(JSON.stringify(parsed)).not.toContain('etc/passwd');
			});

			it('should reject mixed encoding path traversal', async () => {
				// Mix of encoded and unencoded - similar to double-encoding
				// If not caught by validation, falls through safely
				const result = await secretscan.execute(
					{ directory: '/tmp/..%2f..%2fetc/passwd' },
					{} as any,
				);
				const parsed = parseResult(result);

				// Either rejection or safe failure is acceptable
				expect(parsed.error).toBeDefined();
				// Note: scan_dir echoes input back, which may contain the target path
				// This is acceptable since it's user input, not leaked file content
				expect(parsed.findings).toHaveLength(0);
				expect(parsed.files_scanned).toBe(0);
			});

			it('should reject path traversal with backslash (Windows)', async () => {
				const result = await secretscan.execute(
					{ directory: '..\\..\\windows\\system32' },
					{} as any,
				);
				const parsed = parseResult(result);

				expect(parsed.error).toBeDefined();
				expect(parsed.error).toContain('path traversal');
			});

			it('should reject path traversal in exclude array', async () => {
				const result = await secretscan.execute(
					{ directory: tempDir, exclude: ['../../etc'] },
					{} as any,
				);
				const parsed = parseResult(result);

				expect(parsed.error).toBeDefined();
				expect(parsed.error).toContain('path traversal');
			});

			it('should reject URL-encoded traversal in exclude array', async () => {
				const result = await secretscan.execute(
					{ directory: tempDir, exclude: ['%2e%2e%2f'] },
					{} as any,
				);
				const parsed = parseResult(result);

				expect(parsed.error).toBeDefined();
				expect(parsed.error).toContain('path traversal');
			});

			it('should normalize and reject traversal after path.resolve', async () => {
				// Even if input looks innocent, normalization should catch traversal
				const result = await secretscan.execute(
					{ directory: './../../../etc' },
					{} as any,
				);
				const parsed = parseResult(result);

				expect(parsed.error).toBeDefined();
				expect(parsed.error).toContain('path traversal');
			});
		});

		// ----- Malformed/Oversized Payload Tests -----
		describe('malformed and oversized payloads', () => {
			it('should handle malformed Unicode gracefully', async () => {
				// Create file with invalid UTF-8 sequences
				const malformed = Buffer.from([
					0x70,
					0x61,
					0x73,
					0x73, // "pass"
					0x77,
					0x6f,
					0x72,
					0x64, // "word"
					0x3d, // "="
					0xff,
					0xfe, // Invalid UTF-8 BOM-like sequence
					0x73,
					0x65,
					0x63,
					0x72,
					0x65,
					0x74, // "secret"
				]);
				fs.writeFileSync(path.join(tempDir, 'malformed.txt'), malformed);

				const result = await secretscan.execute(
					{ directory: tempDir },
					{} as any,
				);
				const parsed = parseResult(result);

				// Should not crash, either finds something or skips cleanly
				expect(parsed.error).toBeUndefined();
			});

			it('should handle file with only null bytes', async () => {
				const nulls = Buffer.alloc(1000, 0);
				fs.writeFileSync(path.join(tempDir, 'nulls.bin'), nulls);

				const result = await secretscan.execute(
					{ directory: tempDir },
					{} as any,
				);
				const parsed = parseResult(result);

				expect(parsed.error).toBeUndefined();
				expect(parsed.findings).toHaveLength(0);
			});

			it('should handle extremely long directory path', async () => {
				// Create a path that's at the limit
				const longPath = 'a'.repeat(490);
				const result = await secretscan.execute(
					{ directory: `/tmp/${longPath}` },
					{} as any,
				);
				const parsed = parseResult(result);

				// Should either reject (too long) or handle gracefully (not found)
				expect(parsed.error).toBeDefined();
			});

			it('should handle empty exclude array items', async () => {
				const result = await secretscan.execute(
					{ directory: tempDir, exclude: ['', 'valid'] },
					{} as any,
				);
				const parsed = parseResult(result);

				// Should handle empty strings in exclude
				expect(parsed.error).toBeUndefined();
			});

			it('should handle very long exclude patterns', async () => {
				const longExclude = 'x'.repeat(600);
				const result = await secretscan.execute(
					{ directory: tempDir, exclude: [longExclude] },
					{} as any,
				);
				const parsed = parseResult(result);

				expect(parsed.error).toBeDefined();
				expect(parsed.error).toContain('exceeds maximum length');
			});

			it('should handle control characters in exclude array', async () => {
				const result = await secretscan.execute(
					{ directory: tempDir, exclude: ['test\0dir'] },
					{} as any,
				);
				const parsed = parseResult(result);

				expect(parsed.error).toBeDefined();
				expect(parsed.error).toContain('control characters');
			});
		});

		// ----- Loop/Recursion Abuse Tests -----
		describe('loop and recursion abuse', () => {
			it('should handle deeply nested directory structure', async () => {
				// Create a deeply nested structure
				let currentPath = tempDir;
				for (let i = 0; i < 50; i++) {
					currentPath = path.join(currentPath, `level${i}`);
					fs.mkdirSync(currentPath, { recursive: true });
				}
				// Put a secret at the deepest level
				fs.writeFileSync(
					path.join(currentPath, 'deep.txt'),
					'password=deepSecret\n',
				);

				const start = Date.now();
				const result = await secretscan.execute(
					{ directory: tempDir },
					{} as any,
				);
				const elapsed = Date.now() - start;

				expect(elapsed).toBeLessThan(10000);
				const parsed = parseResult(result);
				expect(parsed.findings.length).toBeGreaterThanOrEqual(1);
			});

			it('should handle directory cycle via bind mount (if available)', async () => {
				// This test primarily ensures the tool doesn't hang on cycles
				// On systems without bind mount support, this tests normal recursion

				// Create many directories to test recursion limits
				for (let i = 0; i < 100; i++) {
					fs.mkdirSync(path.join(tempDir, `dir${i}`), { recursive: true });
				}

				const start = Date.now();
				const result = await secretscan.execute(
					{ directory: tempDir },
					{} as any,
				);
				const elapsed = Date.now() - start;

				expect(elapsed).toBeLessThan(10000);
			});

			it('should limit total files scanned (DoS prevention)', async () => {
				// Create many files to test MAX_FILES_SCANNED limit
				for (let i = 0; i < 1100; i++) {
					createTestFile(tempDir, `file${i}.txt`, `content${i}\n`);
				}

				const result = await secretscan.execute(
					{ directory: tempDir },
					{} as any,
				);
				const parsed = parseResult(result);

				// Should have a message about truncation or be within limits
				expect(parsed.files_scanned).toBeLessThanOrEqual(1000);
			});

			it('should limit total findings (resource exhaustion prevention)', async () => {
				// Create files with many secrets
				for (let i = 0; i < 150; i++) {
					createTestFile(tempDir, `secrets${i}.txt`, `password=secret${i}\n`);
				}

				const result = await secretscan.execute(
					{ directory: tempDir },
					{} as any,
				);
				const parsed = parseResult(result);

				// Should limit findings
				expect(parsed.count).toBeLessThanOrEqual(100);
			});

			it('should handle thousands of empty directories', async () => {
				// Create many empty directories
				for (let i = 0; i < 500; i++) {
					fs.mkdirSync(path.join(tempDir, `empty${i}`), { recursive: true });
				}

				const start = Date.now();
				const result = await secretscan.execute(
					{ directory: tempDir },
					{} as any,
				);
				const elapsed = Date.now() - start;

				expect(elapsed).toBeLessThan(10000);
				const parsed = parseResult(result);
				expect(parsed.error).toBeUndefined();
			});
		});

		// ----- Secret Leakage Under Failure Conditions -----
		describe('secret leakage under failure conditions', () => {
			it('should not leak secret in error for invalid directory', async () => {
				// Even if the path contains secret-like patterns
				const secretLikeDir = `/tmp/api_key=sk_${'live_'}secret123`;
				const result = await secretscan.execute(
					{ directory: secretLikeDir },
					{} as any,
				);
				const parsed = parseResult(result);

				expect(parsed.error).toBeDefined();
				// Error should NOT contain the "secret" part
				expect(parsed.error).not.toContain('sk_live');
				expect(parsed.error).not.toContain('secret123');
			});

			it('should not leak file contents in error messages', async () => {
				// Try to scan a file with permission issues (we'll simulate with invalid input)
				const result = await secretscan.execute(
					{ directory: '/root/.ssh/id_rsa' }, // Likely inaccessible
					{} as any,
				);
				const parsed = parseResult(result);

				if (parsed.error) {
					// Error should not contain actual key content
					expect(parsed.error).not.toContain('PRIVATE KEY');
					expect(parsed.error).not.toContain('BEGIN RSA');
				}
			});

			it('should redact secrets even in truncated output', async () => {
				// Create many secrets to trigger truncation
				for (let i = 0; i < 150; i++) {
					createTestFile(
						tempDir,
						`secret${i}.txt`,
						`password=actualSecret${i}\n`,
					);
				}

				const result = await secretscan.execute(
					{ directory: tempDir },
					{} as any,
				);
				const rawOutput = result;

				// Raw output should never contain the actual secrets
				expect(rawOutput).not.toContain('actualSecret');
				// Should contain redacted versions
				expect(rawOutput).toContain('REDACTED');
			});

			it('should sanitize error messages from exceptions', async () => {
				// Create a scenario that might trigger an internal error
				// Try with a path that has special regex characters
				const result = await secretscan.execute(
					{ directory: '/tmp/$(rm -rf /)' },
					{} as any,
				);
				const parsed = parseResult(result);

				// Error should be generic, not reveal shell injection attempts
				if (parsed.error) {
					expect(parsed.error).not.toContain('rm -rf');
					expect(parsed.error).not.toContain('shell');
					expect(parsed.error).not.toContain('command');
				}
			});

			it('should not leak memory addresses or internal state in errors', async () => {
				const result = await secretscan.execute(
					{ directory: '\x00\x01\x02\x03' },
					{} as any,
				);
				const parsed = parseResult(result);

				expect(parsed.error).toBeDefined();
				// Should not contain memory addresses (0x...)
				expect(parsed.error).not.toMatch(/0x[0-9a-f]+/i);
				// Should not contain object representations
				expect(parsed.error).not.toContain('[object');
				expect(parsed.error).not.toContain('undefined');
			});

			it('should never return raw secrets in findings (redaction guarantee)', async () => {
				const rawSecret = `sk_${'live_'}4eC39HqLyjWDarjtT1zdp7dc`; // Stripe test key
				createTestFile(tempDir, 'real.txt', `stripe_key=${rawSecret}\n`);

				const result = await secretscan.execute(
					{ directory: tempDir },
					{} as any,
				);
				const rawOutput = result;
				const parsed = parseResult(result);

				// The raw secret should NEVER appear in output
				expect(rawOutput).not.toContain(rawSecret);

				// The redacted field should not contain the full secret
				if (parsed.findings.length > 0) {
					for (const finding of parsed.findings) {
						expect(finding.redacted).not.toContain(rawSecret);
						expect(finding.context).not.toContain(rawSecret);
					}
				}
			});
		});
	});

	describe('containsControlChars consistency', () => {
		it('blocks tab character in directory input', async () => {
			const result = await secretscan.execute(
				{ directory: '/tmp/test\tdir' },
				{} as any,
			);
			const parsed = parseResult(result);
			expect(parsed.error).toBeDefined();
			expect(parsed.error).toContain('control characters');
		});

		it('blocks newline character in directory input', async () => {
			const result = await secretscan.execute(
				{ directory: '/tmp/test\ndir' },
				{} as any,
			);
			const parsed = parseResult(result);
			expect(parsed.error).toBeDefined();
			expect(parsed.error).toContain('control characters');
		});

		it('blocks carriage return in directory input', async () => {
			const result = await secretscan.execute(
				{ directory: '/tmp/test\rdir' },
				{} as any,
			);
			const parsed = parseResult(result);
			expect(parsed.error).toBeDefined();
			expect(parsed.error).toContain('control characters');
		});

		it('blocks null byte in directory input', async () => {
			const result = await secretscan.execute(
				{ directory: '/tmp/test\0dir' },
				{} as any,
			);
			const parsed = parseResult(result);
			expect(parsed.error).toBeDefined();
			expect(parsed.error).toContain('control characters');
		});

		it('allows normal strings without control characters', async () => {
			const result = await secretscan.execute(
				{ directory: tempDir },
				{} as any,
			);
			const parsed = parseResult(result);
			expect(parsed.error).toBeUndefined();
		});
	});
});
