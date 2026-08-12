/**
 * ADVERSARIAL SECURITY TESTS for run-memory.ts and context-budget-service.ts
 *
 * Tests path traversal vulnerabilities for directory validation.
 * Verifies that all malicious directory inputs are properly rejected with errors.
 *
 * ISSUE #1619 — the OUTCOME these tests assert is unchanged; only the MECHANISM
 * and therefore the error text moved, which is why the message patterns below
 * accept both wordings.
 *
 * Before: the six call sites in `run-memory.ts` / `context-budget-service.ts`
 * used `validateDirectory`, which rejects EVERY absolute path by design because
 * it guards untrusted RELATIVE sub-paths. That rejected `/etc` and `C:\Windows`
 * — but it also rejected the always-absolute project root the plugin host
 * actually injects, so both features threw on every real call and were silently
 * dead behind a debug-gated catch.
 *
 * After: those sites use `validateProjectDirectory`, which REQUIRES an absolute
 * root and additionally rejects filesystem/drive roots and system locations
 * (`assertNotSystemLocation`). Every input below is still rejected, and the
 * feature works for a real project root.
 *
 * That second guard is not theoretical. While `validateProjectDirectory` briefly
 * accepted any absolute path, running this file created `E:\.swarm\`,
 * `E:\Windows\` and `E:\Users\Brett\AppData\Local\` on a developer machine —
 * because a root of `E:\` still resolves to a real writable location and
 * `validateSwarmPath` only pins the write to `<root>/.swarm/`. These assertions
 * are what caught that, so do not relax them to "absolute roots are accepted".
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	formatBudgetWarning,
	getContextBudgetReport,
	getDefaultConfig,
} from '../../../src/services/context-budget-service';
import {
	getRunMemorySummary,
	getTaskHistory,
	recordOutcome,
} from '../../../src/services/run-memory';
import { REJECTS_UNUSABLE_ROOT } from '../../helpers/unusable-root-pattern';

/**
 * A fixed timestamp. These suites assert that a root is accepted or refused
 * before the payload matters, so the clock value is irrelevant — pinning it
 * keeps the real clock out of the test (scripts/check-test-clock.sh).
 */
const FIXED_TIMESTAMP = '2026-01-01T00:00:00.000Z';

describe('ADVERSARIAL: run-memory.ts path traversal security', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-security-'));
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	/**
	 * Write a file to the .swarm directory
	 */
	async function writeSwarmFile(filename: string, content: string | object) {
		const swarmDir = join(tempDir, '.swarm');
		const filePath = join(swarmDir, filename);
		await mkdir(dirname(filePath), { recursive: true });
		const data =
			typeof content === 'string' ? content : JSON.stringify(content, null, 2);
		await writeFile(filePath, data);
		return filePath;
	}

	// =========================================================================
	// PATH TRAVERSAL ATTACKS - ALL MUST BE REJECTED
	// =========================================================================

	describe('Path Traversal Attacks: directory parameter', () => {
		test('rejects "../etc" as directory - path traversal detected', async () => {
			await expect(async () => {
				await recordOutcome('../etc', {
					timestamp: '2026-01-01T00:00:00.000Z',
					taskId: '1.1',
					taskFingerprint: 'abc12345',
					agent: 'test',
					outcome: 'pass',
					attemptNumber: 1,
				});
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "../" as directory - path traversal detected', async () => {
			await expect(async () => {
				await recordOutcome('../', {
					timestamp: '2026-01-01T00:00:00.000Z',
					taskId: '1.1',
					taskFingerprint: 'abc12345',
					agent: 'test',
					outcome: 'pass',
					attemptNumber: 1,
				});
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "../other" as directory - path traversal detected', async () => {
			await expect(async () => {
				await getTaskHistory('../other', '1.1');
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "foo/../bar" as directory - path traversal detected', async () => {
			await expect(async () => {
				await getRunMemorySummary('foo/../bar');
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "foo/..\\bar" as directory - path traversal detected', async () => {
			await expect(async () => {
				await getRunMemorySummary('foo/..\\bar');
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "../../etc" as directory - path traversal detected', async () => {
			await expect(async () => {
				await recordOutcome('../../etc', {
					timestamp: '2026-01-01T00:00:00.000Z',
					taskId: '1.1',
					taskFingerprint: 'abc12345',
					agent: 'test',
					outcome: 'pass',
					attemptNumber: 1,
				});
			}).toThrow(/path traversal|Invalid directory/);
		});
	});

	// A workspace ROOT is absolute by contract (`ctx.directory`, AGENTS.md
	// invariant 4). These functions previously ran it through validateDirectory,
	// a relative-sub-path validator, so every real call threw and the feature was
	// dead. They now use validateWorkspaceRoot. Containment is unchanged and is
	// enforced one layer down by validateSwarmPath, which is what these tests pin:
	// an absolute root is ACCEPTED, but writes stay inside <root>/.swarm/.
	describe('Absolute workspace roots: accepted, but still contained', () => {
		test('accepts an absolute workspace root (regression: feature was dead)', async () => {
			await expect(async () => {
				await recordOutcome(tempDir, {
					timestamp: FIXED_TIMESTAMP,
					taskId: '1.1',
					taskFingerprint: 'abc12345',
					agent: 'test',
					outcome: 'pass',
					attemptNumber: 1,
				});
			}).not.toThrow();
		});

		test('an absolute root round-trips through the read side', async () => {
			await recordOutcome(tempDir, {
				timestamp: FIXED_TIMESTAMP,
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'test',
				outcome: 'fail',
				attemptNumber: 1,
				failureReason: 'QA gate: reviewer gate required',
			});
			const summary = await getRunMemorySummary(tempDir);
			expect(summary).toContain('RUN MEMORY');
			expect(summary).toContain('reviewer gate required');
			expect(await getTaskHistory(tempDir, '1.1')).toHaveLength(1);
		});

		test('an absolute root writes ONLY under <root>/.swarm/', async () => {
			await recordOutcome(tempDir, {
				timestamp: FIXED_TIMESTAMP,
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'test',
				outcome: 'pass',
				attemptNumber: 1,
			});
			// The contained target exists; nothing was written beside .swarm/.
			const at = (...p: string[]) => existsSync(join(...p));
			expect(at(tempDir, '.swarm', 'run-memory.jsonl')).toBe(true);
			expect(at(tempDir, 'run-memory.jsonl')).toBe(false);
			expect(at(dirname(tempDir), 'run-memory.jsonl')).toBe(false);
		});

		test('an absolute root carrying a traversal segment is still rejected', async () => {
			// Concatenated, not join()ed: join() normalizes the ".." away.
			await expect(async () => {
				await getRunMemorySummary(`${tempDir}/../escaped`);
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('an absolute root with control characters is still rejected', async () => {
			await expect(async () => {
				await getTaskHistory(`${tempDir}\u0007evil`, '1.1');
			}).toThrow(/control characters|Invalid directory/);
		});
	});

	// Accepting an absolute root is necessary but NOT sufficient: every write
	// lands under `<root>/.swarm/`, so a root of `E:\` or `/etc` is a real
	// writable location and `validateSwarmPath` faithfully pins the write inside
	// a root that is itself wrong. Running this suite against an absolute-only
	// validator created `E:\.swarm\`, `E:\Windows\` and
	// `E:\Users\Brett\AppData\Local\` on a developer machine — these assertions
	// are what caught it (issue #1619).
	describe('Filesystem and system roots: rejected', () => {
		test('rejects "/etc" as directory', async () => {
			await expect(async () => {
				await recordOutcome('/etc', {
					timestamp: FIXED_TIMESTAMP,
					taskId: '1.1',
					taskFingerprint: 'abc12345',
					agent: 'test',
					outcome: 'pass',
					attemptNumber: 1,
				});
			}).toThrow(REJECTS_UNUSABLE_ROOT);
		});

		test('rejects "/usr/bin" as directory', async () => {
			await expect(async () => {
				await getRunMemorySummary('/usr/bin');
			}).toThrow(REJECTS_UNUSABLE_ROOT);
		});

		test('rejects "\\Windows" as directory', async () => {
			await expect(async () => {
				await getTaskHistory('\\Windows', '1.1');
			}).toThrow(REJECTS_UNUSABLE_ROOT);
		});

		test('rejects "\\" (filesystem root) as directory', async () => {
			await expect(async () => {
				await getRunMemorySummary('\\');
			}).toThrow(REJECTS_UNUSABLE_ROOT);
		});

		test('rejects "C:\\Windows" as directory', async () => {
			await expect(async () => {
				await recordOutcome('C:\\Windows', {
					timestamp: FIXED_TIMESTAMP,
					taskId: '1.1',
					taskFingerprint: 'abc12345',
					agent: 'test',
					outcome: 'pass',
					attemptNumber: 1,
				});
			}).toThrow(REJECTS_UNUSABLE_ROOT);
		});

		test('rejects "C:/Windows" as directory', async () => {
			await expect(async () => {
				await getRunMemorySummary('C:/Windows');
			}).toThrow(REJECTS_UNUSABLE_ROOT);
		});

		test('rejects "D:\\Users" as directory', async () => {
			await expect(async () => {
				await getTaskHistory('D:\\Users', '1.1');
			}).toThrow(REJECTS_UNUSABLE_ROOT);
		});

		test('rejects "E:\\" (drive root) as directory', async () => {
			await expect(async () => {
				await getRunMemorySummary('E:\\');
			}).toThrow(REJECTS_UNUSABLE_ROOT);
		});
	});

	describe('Empty Directory Attacks: directory parameter', () => {
		test('rejects empty string as directory', async () => {
			await expect(async () => {
				await recordOutcome('', {
					timestamp: '2026-01-01T00:00:00.000Z',
					taskId: '1.1',
					taskFingerprint: 'abc12345',
					agent: 'test',
					outcome: 'pass',
					attemptNumber: 1,
				});
			}).toThrow(/empty|Invalid directory/);
		});

		test('rejects whitespace-only string as directory', async () => {
			await expect(async () => {
				await getRunMemorySummary('   ');
			}).toThrow(/empty|Invalid directory/);
		});

		test('rejects null-like empty string as directory', async () => {
			await expect(async () => {
				await getTaskHistory('\t\n', '1.1');
			}).toThrow(/empty|Invalid directory/);
		});
	});

	describe('Valid directories are accepted', () => {
		test('accepts simple relative directory name', async () => {
			// This should NOT throw validation error - directory might not exist but validation passes
			// The function validates directory format, not existence
			await expect(async () => {
				await recordOutcome('valid-workspace', {
					timestamp: '2026-01-01T00:00:00.000Z',
					taskId: '1.1',
					taskFingerprint: 'abc12345',
					agent: 'test',
					outcome: 'pass',
					attemptNumber: 1,
				});
			}).not.toThrow(/Invalid directory/);
		});

		test('accepts nested relative directory path', async () => {
			// This should NOT throw validation error
			await expect(async () => {
				await recordOutcome('valid-workspace/nested', {
					timestamp: '2026-01-01T00:00:00.000Z',
					taskId: '1.1',
					taskFingerprint: 'abc12345',
					agent: 'test',
					outcome: 'pass',
					attemptNumber: 1,
				});
			}).not.toThrow(/Invalid directory/);
		});
	});
});
