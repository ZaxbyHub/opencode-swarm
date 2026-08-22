import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	executeWriteRetro as executeRawWriteRetro,
	type WriteRetroArgs,
} from '../../../src/tools/write-retro';

const executeWriteRetro = (a: WriteRetroArgs, d: string) =>
	executeRawWriteRetro({ ...a, verdict: 'pass' }, d);

describe('write-retro adversarial security tests', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'write-retro-adversarial-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create .swarm directory structure
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// PATH TRAVERSAL ATTACKS

	describe('path traversal attacks', () => {
		test('rejects path traversal with ../ in task_id', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: '../parent',
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(
				/path traversal|Invalid task ID|must match pattern/,
			);
		});

		test('rejects path traversal with ../../etc/passwd in task_id', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: '../../etc/passwd',
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(
				/path traversal|Invalid task ID|must match pattern/,
			);
		});

		test('rejects path traversal with ..\\ pattern in task_id', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: '..\\windows\\system32',
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(
				/path traversal|Invalid task ID|must match pattern/,
			);
		});

		test('rejects path traversal with embedded ../ in task_id', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: 'task../id',
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(
				/path traversal|Invalid task ID|must match pattern/,
			);
		});
	});

	// NULL BYTE ATTACKS

	describe('null byte attacks', () => {
		test('rejects null bytes in task_id', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: 'retro-\x00evil',
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(/null bytes|Invalid task ID/);
		});

		test('rejects null bytes embedded in task_id', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: 'task\x00id',
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(/null bytes|Invalid task ID/);
		});
	});

	// CONTROL CHARACTER ATTACKS

	describe('control character attacks', () => {
		test('rejects control character \\x01 in task_id', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: 'retro-\x01evil',
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(
				/control characters|Invalid task ID|must match pattern/,
			);
		});

		test('rejects control character \\x1f in task_id', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: 'task\x1fid',
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(
				/control characters|Invalid task ID|must match pattern/,
			);
		});

		test('rejects multiple control characters in task_id', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: 'task\x01\x02\x03id',
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(
				/control characters|Invalid task ID|must match pattern/,
			);
		});
	});

	// OVERSIZED INPUT ATTACKS

	describe('oversized input attacks', () => {
		test('rejects extremely long task_id (exceeds pattern validation)', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: 'a'.repeat(10000),
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			// sanitizeTaskId rejects long non-matching strings with invalid pattern error
			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(/Invalid task ID|must match pattern/);
		});

		test('handles oversized lessons_learned without crashing', async () => {
			const longString = 'x'.repeat(100000);
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				lessons_learned: [longString, 'another lesson'],
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			// Should succeed or fail gracefully, but not crash
			expect(parsed).toBeDefined();
			if (!parsed.success) {
				expect(parsed.message).toMatch(/exceeds maximum|size/i);
			}
		});

		test('handles oversized summary without crashing (but rejects due to size limit)', async () => {
			const longString = 'x'.repeat(1000000);
			const args: WriteRetroArgs = {
				phase: 1,
				summary: longString,
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: 'retro-script-injection',
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			// Should fail because the resulting bundle exceeds 500KB limit
			// But should not crash
			expect(parsed).toBeDefined();
			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(/exceeds maximum|size/);
		});
	});

	// NUMERIC VALIDATION ATTACKS

	describe('numeric validation attacks', () => {
		test('rejects negative total_tool_calls', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: -1,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: 'retro-sql-injection',
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			// Negative values are not allowed - all numeric fields have min(0)
			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(/Invalid total_tool_calls/);
		});

		test('rejects NaN phase', async () => {
			const args: WriteRetroArgs = {
				phase: NaN,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: 'retro-html-entity',
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(/Invalid phase.*positive integer/);
		});

		test('rejects floating point phase', async () => {
			const args: WriteRetroArgs = {
				phase: 1.5,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: 'retro-script-injection',
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(/Invalid phase.*positive integer/);
		});

		test('rejects very large phase number', async () => {
			const args: WriteRetroArgs = {
				phase: 999999,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: 'retro-sql-injection',
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(/Invalid phase.*<= 99/);
		});

		test('rejects zero phase', async () => {
			const args: WriteRetroArgs = {
				phase: 0,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: 'retro-html-entity',
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(/Invalid phase.*positive integer/);
		});

		test('rejects negative phase', async () => {
			const args: WriteRetroArgs = {
				phase: -1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(/Invalid phase.*positive integer/);
		});
	});

	// INJECTION ATTACKS

	describe('injection attacks', () => {
		test('accepts unicode/script injection in summary (stored as-is)', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: '<script>alert(1)</script>',
				task_id: 'retro-script-injection',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			// Should succeed - this is a storage tool, not rendering
			expect(parsed.success).toBe(true);
		});

		test('accepts SQL injection attempt in summary (stored as-is)', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: "'; DROP TABLE evidence; --",
				task_id: 'retro-sql-injection',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			// Should succeed - this is a storage tool using JSON, not SQL
			expect(parsed.success).toBe(true);
		});

		test('accepts HTML entity injection in summary (stored as-is)', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: '&lt;script&gt;evil&lt;/script&gt;',
				task_id: 'retro-html-entity',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			// Should succeed - this is a storage tool, not rendering
			expect(parsed.success).toBe(true);
		});
	});

	// BOUNDARY VIOLATIONS

	describe('boundary violations', () => {
		test('rejects empty summary', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: '',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(/Invalid summary.*non-empty/);
		});

		test('rejects whitespace-only summary', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: '   \t\n  ',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(/Invalid summary.*non-empty/);
		});

		test('rejects zero task_count', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 0,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(/Invalid task_count.*positive integer/);
		});

		test('rejects negative task_count', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: -5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(/Invalid task_count.*positive integer/);
		});

		test('rejects invalid task_complexity', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'invalid' as any,
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(/Invalid task_complexity/);
		});
	});

	// DIRECTORY ATTACKS

	describe('directory and file system attacks', () => {
		test('rejects non-existent directory instead of creating arbitrary .swarm trees', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
			};

			const nonExistentDir = path.join(tempDir, 'nonexistent');

			const result = await executeWriteRetro(args, nonExistentDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(/no \.swarm\/ folder|inaccessible/);
		});

		test('rejects invalid directory path (reserved or inaccessible)', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
			};

			// Use a clearly invalid path - CON is a reserved Windows device name
			const invalidDir = 'CON:';

			const result = await executeWriteRetro(args, invalidDir);
			const parsed = JSON.parse(result);

			// Should fail on invalid device path
			expect(parsed.success).toBe(false);
		});

		test('rejects directories without a verifiable project root', async () => {
			const emptyDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'write-retro-empty-')),
			);
			try {
				const args: WriteRetroArgs = {
					phase: 1,
					summary: 'Test summary',
					task_count: 5,
					task_complexity: 'simple',
					total_tool_calls: 100,
					coder_revisions: 2,
					reviewer_rejections: 1,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
				};

				const result = await executeWriteRetro(args, emptyDir);
				const parsed = JSON.parse(result);

				expect(parsed.success).toBe(false);
				expect(parsed.message).toMatch(/Cannot write evidence|project root/);
			} finally {
				fs.rmSync(emptyDir, { recursive: true, force: true });
			}
		});
	});

	// COMBINED ATTACKS

	describe('combined attack vectors', () => {
		test('handles path traversal with null bytes', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: '../\x00evil',
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
		});

		test('handles control characters with path traversal', async () => {
			const args: WriteRetroArgs = {
				phase: 1,
				summary: 'Test summary',
				task_count: 5,
				task_complexity: 'simple',
				total_tool_calls: 100,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_id: '../\x01evil',
			};

			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
		});
	});
});
