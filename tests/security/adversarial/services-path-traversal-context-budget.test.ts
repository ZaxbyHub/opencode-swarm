/**
 * ADVERSARIAL SECURITY TESTS for context-budget-service.ts
 *
 * Split out of `services-path-traversal.test.ts` (FR-006 500-line cap). The
 * run-memory half stays there; the contract both halves assert is documented on
 * `REJECTS_UNUSABLE_ROOT` in `tests/helpers/unusable-root-pattern.ts`.
 *
 * Absoluteness is not containment: every caller writes under `<root>/.swarm/`,
 * so a root of `E:\` or `\Windows` resolves to a real writable location and
 * `validateSwarmPath` faithfully pins the write inside a root that is itself
 * wrong. While `validateProjectDirectory` briefly accepted any absolute path,
 * running this suite created `E:\.swarm\session\budget-state.json`,
 * `E:\Windows\` and `E:\Users\Brett\AppData\Local\` on a developer
 * machine. These assertions caught it — do not relax them to "absolute roots are
 * accepted".
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	formatBudgetWarning,
	getContextBudgetReport,
	getDefaultConfig,
} from '../../../src/services/context-budget-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { REJECTS_UNUSABLE_ROOT } from '../../helpers/unusable-root-pattern';

/**
 * A fixed timestamp. These suites assert that an unusable ROOT is refused before
 * anything is written, so the payload's clock value is irrelevant — pinning it
 * keeps the real clock out of the test (scripts/check-test-clock.sh) without
 * pulling in `freezeClock`, which would buy nothing here.
 */
const FIXED_TIMESTAMP = '2026-01-01T00:00:00.000Z';

describe('ADVERSARIAL: context-budget-service.ts path traversal security', () => {
	let tempDir: string;

	beforeEach(async () => {
		// canonicalMkdtemp closes the macOS /var -> /private/var symlink gap and
		// the Windows 8.3 short-name mismatch (FR-011, issue #1737).
		tempDir = canonicalMkdtemp('swarm-security-');
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
				await getContextBudgetReport(
					'../etc',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "../" as directory - path traversal detected', async () => {
			await expect(async () => {
				await getContextBudgetReport('../', 'test prompt', getDefaultConfig());
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "../other" as directory - path traversal detected', async () => {
			await expect(async () => {
				await getContextBudgetReport(
					'../other',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "foo/../bar" as directory - path traversal detected', async () => {
			await expect(async () => {
				await getContextBudgetReport(
					'foo/../bar',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "foo/..\\bar" as directory - path traversal detected', async () => {
			await expect(async () => {
				await getContextBudgetReport(
					'foo/..\\bar',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "../../etc" as directory - path traversal detected', async () => {
			await expect(async () => {
				await getContextBudgetReport(
					'../../etc',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(/path traversal|Invalid directory/);
		});
	});

	describe('Absolute Path Attacks: directory parameter', () => {
		test('rejects "/etc" as directory - absolute path detected', async () => {
			await expect(async () => {
				await getContextBudgetReport('/etc', 'test prompt', getDefaultConfig());
			}).toThrow(REJECTS_UNUSABLE_ROOT);
		});

		test('rejects "/usr/bin" as directory - absolute path detected', async () => {
			await expect(async () => {
				await getContextBudgetReport(
					'/usr/bin',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(REJECTS_UNUSABLE_ROOT);
		});

		test('rejects "\\Windows" as directory - absolute path detected', async () => {
			await expect(async () => {
				await formatBudgetWarning(
					{
						timestamp: FIXED_TIMESTAMP,
						systemPromptTokens: 1000,
						planCursorTokens: 100,
						knowledgeTokens: 50,
						runMemoryTokens: 50,
						handoffTokens: 50,
						contextMdTokens: 50,
						swarmTotalTokens: 1300,
						estimatedTurnCount: 5,
						estimatedSessionTokens: 6500,
						budgetPct: 3.25,
						status: 'warning',
						recommendation: 'Test',
					},
					'\\Windows',
					getDefaultConfig(),
				);
			}).toThrow(REJECTS_UNUSABLE_ROOT);
		});

		test('rejects "\\" as directory - absolute path detected', async () => {
			await expect(async () => {
				await formatBudgetWarning(
					{
						timestamp: FIXED_TIMESTAMP,
						systemPromptTokens: 1000,
						planCursorTokens: 100,
						knowledgeTokens: 50,
						runMemoryTokens: 50,
						handoffTokens: 50,
						contextMdTokens: 50,
						swarmTotalTokens: 1300,
						estimatedTurnCount: 5,
						estimatedSessionTokens: 6500,
						budgetPct: 3.25,
						status: 'warning',
						recommendation: 'Test',
					},
					'\\',
					getDefaultConfig(),
				);
			}).toThrow(REJECTS_UNUSABLE_ROOT);
		});
	});

	describe('Windows Absolute Path Attacks: directory parameter', () => {
		test('rejects "C:\\Windows" as directory - Windows absolute path detected', async () => {
			await expect(async () => {
				await getContextBudgetReport(
					'C:\\Windows',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(REJECTS_UNUSABLE_ROOT);
		});

		test('rejects "C:/Windows" as directory - Windows absolute path detected', async () => {
			await expect(async () => {
				await getContextBudgetReport(
					'C:/Windows',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(REJECTS_UNUSABLE_ROOT);
		});

		test('rejects "D:\\Users" as directory - Windows absolute path detected', async () => {
			await expect(async () => {
				await getContextBudgetReport(
					'D:\\Users',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(REJECTS_UNUSABLE_ROOT);
		});

		test('rejects "E:\\" as directory - Windows absolute path detected', async () => {
			await expect(async () => {
				await getContextBudgetReport('E:\\', 'test prompt', getDefaultConfig());
			}).toThrow(REJECTS_UNUSABLE_ROOT);
		});
	});

	describe('Empty Directory Attacks: directory parameter', () => {
		test('rejects empty string as directory', async () => {
			await expect(async () => {
				await getContextBudgetReport('', 'test prompt', getDefaultConfig());
			}).toThrow(/empty|Invalid directory/);
		});

		test('rejects whitespace-only string as directory', async () => {
			await expect(async () => {
				await formatBudgetWarning(
					{
						timestamp: FIXED_TIMESTAMP,
						systemPromptTokens: 1000,
						planCursorTokens: 100,
						knowledgeTokens: 50,
						runMemoryTokens: 50,
						handoffTokens: 50,
						contextMdTokens: 50,
						swarmTotalTokens: 1300,
						estimatedTurnCount: 5,
						estimatedSessionTokens: 6500,
						budgetPct: 3.25,
						status: 'warning',
						recommendation: 'Test',
					},
					'   ',
					getDefaultConfig(),
				);
			}).toThrow(/empty|Invalid directory/);
		});

		test('rejects null-like empty string as directory', async () => {
			await expect(async () => {
				await getContextBudgetReport('\t\n', 'test prompt', getDefaultConfig());
			}).toThrow(/empty|Invalid directory/);
		});
	});

	describe('Valid directories are accepted', () => {
		test('accepts simple relative directory name', async () => {
			// This should NOT throw validation error
			await expect(async () => {
				await getContextBudgetReport(
					'valid-workspace',
					'test prompt',
					getDefaultConfig(),
				);
			}).not.toThrow(/Invalid directory/);
		});

		test('accepts nested relative directory path', async () => {
			// This should NOT throw validation error
			await expect(async () => {
				await formatBudgetWarning(
					{
						timestamp: FIXED_TIMESTAMP,
						systemPromptTokens: 1000,
						planCursorTokens: 100,
						knowledgeTokens: 50,
						runMemoryTokens: 50,
						handoffTokens: 50,
						contextMdTokens: 50,
						swarmTotalTokens: 1300,
						estimatedTurnCount: 5,
						estimatedSessionTokens: 6500,
						budgetPct: 3.25,
						status: 'warning',
						recommendation: 'Test',
					},
					'valid-workspace/nested',
					getDefaultConfig(),
				);
			}).not.toThrow(/Invalid directory/);
		});
	});
});
