/**
 * Adversarial security tests for src/git/branch.ts
 *
 * Tests attack vectors:
 * 1. Command injection through branchName parameter
 * 2. Command injection through file paths in stageFiles
 * 3. Path traversal attempts
 * 4. Malformed/oversized inputs
 * 5. Special characters in branch names (spaces, quotes, semicolons)
 * 6. UNC path injection (Windows)
 * 7. Null bytes and control characters
 *
 * SECURITY MODEL:
 * The module uses spawnSync with array arguments, which is inherently safe from
 * command injection. Inputs are passed directly to git, which performs validation.
 * These tests verify that:
 * 1. Array arguments are always used (no shell string construction)
 * 2. Malicious inputs ARE passed to git (not sanitized/filtered by this module)
 * 3. Git handles the validation (which would reject invalid inputs in real execution)
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Track all calls to spawnSync for security verification
interface SpawnCall {
	command: string;
	args: string[];
	options: { cwd: string };
}

let callIndex = 0;
let spawnCalls: SpawnCall[] = [];
let returnValues: Array<{ status: number; stdout: string; stderr: string }> =
	[];

const mockSpawnSync = mock(
	(command: string, args: string[], options: { cwd: string }) => {
		spawnCalls.push({ command, args, options });
		const result = returnValues[callIndex] ?? {
			status: 0,
			stdout: '',
			stderr: '',
		};
		callIndex++;
		return result;
	},
);

// Mock the node:child_process module BEFORE importing branch
import * as realChildProcess from 'node:child_process';

mock.module('node:child_process', () => ({
	...realChildProcess,
	spawnSync: mockSpawnSync,
}));

// Import AFTER mock setup
const branch = await import('../../../src/git/branch');

function setupMock(
	...values: Array<{ status: number; stdout: string; stderr: string }>
) {
	callIndex = 0;
	spawnCalls = [];
	returnValues = values;
	mockSpawnSync.mockClear();
}

function getLastCall(): SpawnCall | undefined {
	return spawnCalls[spawnCalls.length - 1];
}

function getAllArgs(): string[] {
	return spawnCalls.flatMap((call) => call.args);
}

describe('Git Branch Module - Adversarial Security Tests', () => {
	const testCwd = '/test/repo';

	beforeEach(() => {
		callIndex = 0;
		spawnCalls = [];
		returnValues = [];
		mockSpawnSync.mockClear();
	});

	describe('CRITICAL: spawnSync uses array arguments (not shell string)', () => {
		test('createBranch passes arguments as array, not shell command', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' }, // remote check fails
				{ status: 0, stdout: '', stderr: '' }, // checkout -b succeeds
			);

			branch.createBranch(testCwd, 'test-branch');

			// SECURITY: Verify command is 'git' (not a constructed string)
			const lastCall = getLastCall();
			expect(lastCall?.command).toBe('git');
			// SECURITY: Args should be an array of individual arguments
			expect(Array.isArray(lastCall?.args)).toBe(true);
			// SECURITY: The branch name should be a separate array element (not concatenated)
			expect(lastCall?.args).toContain('test-branch');
		});

		test('stageFiles passes file paths as array elements', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['file1.ts', 'file2.ts']);

			const lastCall = getLastCall();
			expect(lastCall?.command).toBe('git');
			// SECURITY: Files should be separate array elements
			expect(lastCall?.args).toContain('file1.ts');
			expect(lastCall?.args).toContain('file2.ts');
		});

		test('commitChanges passes message as single array element', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.commitChanges(testCwd, 'test message');

			const lastCall = getLastCall();
			expect(lastCall?.command).toBe('git');
			expect(lastCall?.args).toContain('commit');
			expect(lastCall?.args).toContain('-m');
			// SECURITY: Message should be a single quoted argument
			expect(lastCall?.args).toContain('test message');
		});

		test('getChangedFiles passes branch as array element', () => {
			setupMock({ status: 0, stdout: 'file.ts', stderr: '' });

			branch.getChangedFiles(testCwd, 'develop');

			const lastCall = getLastCall();
			expect(lastCall?.command).toBe('git');
			expect(lastCall?.args).toContain('develop');
		});
	});

	describe('Attack Vector 1: Command injection - verify malicious strings are passed to git', () => {
		test('branch name with semicolon is passed to git (git will reject)', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'main; rm -rf /');

			// SECURITY: Malicious input IS passed to git via array (safe from shell injection)
			const allArgs = getAllArgs();
			expect(allArgs).toContain('main; rm -rf /');
		});

		test('branch name with command substitution is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'main$(whoami)');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('main$(whoami)');
		});

		test('branch name with pipe operator is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'main|cat /etc/passwd');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('main|cat /etc/passwd');
		});

		test('branch name with backticks is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'main`ls`');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('main`ls`');
		});

		test('branch name with && chain is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'main&&touch /tmp/pwned');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('main&&touch /tmp/pwned');
		});

		test('branch name with || chain is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'main||echo pwned');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('main||echo pwned');
		});

		test('branch name with redirect is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'main>/tmp/pwned');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('main>/tmp/pwned');
		});
	});

	describe('Attack Vector 2: File path injection - verify paths are passed to git', () => {
		test('file path with shell metacharacters is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['file; rm -rf /']);

			const allArgs = getAllArgs();
			expect(allArgs).toContain('file; rm -rf /');
		});

		test('file path with command substitution is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['$(whoami).txt']);

			const allArgs = getAllArgs();
			expect(allArgs).toContain('$(whoami).txt');
		});

		test('file path with pipe is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['a|b']);

			const allArgs = getAllArgs();
			expect(allArgs).toContain('a|b');
		});

		test('multiple files with injection is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['safe.txt', ';malicious']);

			const allArgs = getAllArgs();
			expect(allArgs).toContain(';malicious');
		});
	});

	describe('Attack Vector 3: Path traversal - verify traversal attempts are passed to git', () => {
		test('path with parent directory traversal is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['../../../etc/passwd']);

			const allArgs = getAllArgs();
			expect(allArgs).toContain('../../../etc/passwd');
		});

		test('path with multiple parent traversal is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['../../../../../../etc/passwd']);

			const allArgs = getAllArgs();
			expect(allArgs).toContain('../../../../../../etc/passwd');
		});

		test('branch name with path traversal is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, '../../../master');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('../../../master');
		});

		test('getChangedFiles with path traversal branch is passed to git', () => {
			setupMock({ status: 0, stdout: 'file.ts', stderr: '' });

			branch.getChangedFiles(testCwd, '../../../master');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('../../../master');
		});

		test('path with encoded dots is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['....//....//....//etc/passwd']);

			const allArgs = getAllArgs();
			expect(allArgs).toContain('....//....//....//etc/passwd');
		});

		test('path with percent-encoding is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd']);

			const allArgs = getAllArgs();
			expect(allArgs).toContain('%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd');
		});
	});

	describe('Attack Vector 4: Malformed/oversized inputs - verify they are passed to git', () => {
		test('extremely long branch name is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			const longBranchName = 'a'.repeat(10000);
			branch.createBranch(testCwd, longBranchName);

			const allArgs = getAllArgs();
			expect(allArgs).toContain(longBranchName);
		});

		test('extremely long file path is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			const longPath = 'a'.repeat(10000);
			branch.stageFiles(testCwd, [longPath]);

			const allArgs = getAllArgs();
			expect(allArgs).toContain(longPath);
		});

		test('extremely long commit message is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			const longMessage = 'a'.repeat(100000);
			branch.commitChanges(testCwd, longMessage);

			const allArgs = getAllArgs();
			expect(allArgs).toContain(longMessage);
		});

		test('empty string in files array is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['']);

			const allArgs = getAllArgs();
			expect(allArgs).toContain('');
		});

		test('whitespace-only input is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['   ']);

			const allArgs = getAllArgs();
			expect(allArgs).toContain('   ');
		});

		test('deeply nested path is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			const deepPath = '/'.repeat(500);
			branch.stageFiles(testCwd, [deepPath]);

			const allArgs = getAllArgs();
			expect(allArgs).toContain(deepPath);
		});

		test('massive array of files is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			const manyFiles = Array(10000).fill('file.txt');
			branch.stageFiles(testCwd, manyFiles);

			// Verify at least some files were passed
			const lastCall = getLastCall();
			expect(lastCall?.args.length).toBeGreaterThan(1);
		});
	});

	describe('Attack Vector 5: Special characters - verify they are passed to git', () => {
		test('branch name with spaces is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'my branch');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('my branch');
		});

		test('branch name with quotes is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, "branch'name");

			const allArgs = getAllArgs();
			expect(allArgs).toContain("branch'name");
		});

		test('branch name with double quotes is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'branch"name');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('branch"name');
		});

		test('branch name with backslash is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'branch\\name');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('branch\\name');
		});

		test('branch name with newline is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'branch\nname');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('branch\nname');
		});

		test('branch name with tab is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'branch\tname');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('branch\tname');
		});

		test('branch name with carriage return is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'branch\rname');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('branch\rname');
		});

		test('branch name with special characters is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, '!@#$%^&*()');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('!@#$%^&*()');
		});

		test('branch name with tilde is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'branch~name');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('branch~name');
		});

		test('branch name with caret is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'branch^name');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('branch^name');
		});

		test('branch name with colon is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'branch:name');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('branch:name');
		});

		test('branch name with asterisk is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'branch*name');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('branch*name');
		});

		test('branch name with question mark is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'branch?name');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('branch?name');
		});

		test('branch name with square brackets is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'branch[name]');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('branch[name]');
		});

		test('branch name with curly braces is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'branch{name}');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('branch{name}');
		});
	});

	describe('Attack Vector 6: UNC path injection (Windows) - verify paths are passed to git', () => {
		test('UNC path in file path is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['\\\\attacker\\share\\malicious.exe']);

			const allArgs = getAllArgs();
			expect(allArgs).toContain('\\\\attacker\\share\\malicious.exe');
		});

		test('UNC path with IP address is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['\\\\192.168.1.100\\share\\file']);

			const allArgs = getAllArgs();
			expect(allArgs).toContain('\\\\192.168.1.100\\share\\file');
		});

		test('UNC path in branch name is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, '\\\\server\\share');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('\\\\server\\share');
		});

		test('Windows drive letter path is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['C:\\Windows\\System32\\config']);

			const allArgs = getAllArgs();
			expect(allArgs).toContain('C:\\Windows\\System32\\config');
		});

		test('Alternate Data Stream syntax is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['file.txt:Zone.Identifier']);

			const allArgs = getAllArgs();
			expect(allArgs).toContain('file.txt:Zone.Identifier');
		});

		test('Mapped network drive is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['Z:\\sensitive\\data']);

			const allArgs = getAllArgs();
			expect(allArgs).toContain('Z:\\sensitive\\data');
		});
	});

	describe('Attack Vector 7: Null bytes and control characters - verify they are passed to git', () => {
		test('branch name with null byte is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'branch\x00name');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('branch\x00name');
		});

		test('file path with null byte is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['file\x00.txt']);

			const allArgs = getAllArgs();
			expect(allArgs).toContain('file\x00.txt');
		});

		test('commit message with null byte is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.commitChanges(testCwd, 'message\x00');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('message\x00');
		});

		test('branch name with SOH is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'branch\x01name');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('branch\x01name');
		});

		test('branch name with ETX is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'branch\x03name');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('branch\x03name');
		});

		test('branch name with ESC is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'branch\x1bname');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('branch\x1bname');
		});

		test('multiple null bytes are passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, '\x00\x00\x00');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('\x00\x00\x00');
		});
	});

	describe('Attack Vector: getChangedFiles with malicious branch names', () => {
		test('branch name with shell metacharacters is passed to git', () => {
			setupMock({ status: 0, stdout: 'file.ts', stderr: '' });

			branch.getChangedFiles(testCwd, '; rm -rf /');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('; rm -rf /');
		});

		test('branch name with newlines is passed to git', () => {
			setupMock({ status: 0, stdout: 'file.ts', stderr: '' });

			branch.getChangedFiles(testCwd, 'main\nwhoami');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('main\nwhoami');
		});

		test('branch name with null bytes is passed to git', () => {
			setupMock({ status: 0, stdout: 'file.ts', stderr: '' });

			branch.getChangedFiles(testCwd, 'main\x00');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('main\x00');
		});
	});

	describe('Attack Vector: commitChanges with malicious messages', () => {
		test('commit message with null byte is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.commitChanges(testCwd, 'message\x00');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('message\x00');
		});

		test('commit message with newlines is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.commitChanges(testCwd, 'msg\n-N');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('msg\n-N');
		});

		test('commit message starting with dash is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.commitChanges(testCwd, '-a commit');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('-a commit');
		});

		test('commit message with git options is passed to git', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.commitChanges(testCwd, '--global=malicious');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('--global=malicious');
		});
	});

	describe('Defense in depth: Valid inputs still work correctly', () => {
		test('normal branch name works', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'feature/my-branch');

			const lastCall = getLastCall();
			expect(lastCall?.args).toContain('feature/my-branch');
		});

		test('normal file paths work', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['src/index.ts', 'src/utils/helper.ts']);

			const lastCall = getLastCall();
			expect(lastCall?.args).toContain('src/index.ts');
			expect(lastCall?.args).toContain('src/utils/helper.ts');
		});

		test('normal commit message works', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.commitChanges(testCwd, 'feat: add new feature');

			const lastCall = getLastCall();
			expect(lastCall?.args).toContain('feat: add new feature');
		});

		test('branch name with hyphens works', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'feature-branch-name');

			const lastCall = getLastCall();
			expect(lastCall?.args).toContain('feature-branch-name');
		});

		test('branch name with underscores works', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'feature_branch_name');

			const lastCall = getLastCall();
			expect(lastCall?.args).toContain('feature_branch_name');
		});

		test('file path with spaces works', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['src with spaces/file.ts']);

			const lastCall = getLastCall();
			expect(lastCall?.args).toContain('src with spaces/file.ts');
		});
	});

	describe('Boundary: Unicode and international characters', () => {
		test('unicode branch name is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, '功能分支');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('功能分支');
		});

		test('emoji in branch name is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'feature-🔥');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('feature-🔥');
		});

		test('right-to-left unicode is passed to git', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'feature\u202efile');

			const allArgs = getAllArgs();
			expect(allArgs).toContain('feature\u202efile');
		});
	});

	describe('SECURITY SUMMARY: Module uses safe array-based execution', () => {
		test('all git commands use array args - never shell string', () => {
			// Run multiple operations
			setupMock(
				{ status: 0, stdout: '.git', stderr: '' }, // isGitRepo
				{ status: 0, stdout: 'main', stderr: '' }, // getCurrentBranch
				{ status: 128, stdout: '', stderr: 'not found' }, // createBranch remote check
				{ status: 0, stdout: '', stderr: '' }, // createBranch checkout
				{ status: 0, stdout: '', stderr: '' }, // stageFiles
				{ status: 0, stdout: '', stderr: '' }, // commitChanges
			);

			branch.isGitRepo(testCwd);
			branch.getCurrentBranch(testCwd);
			branch.createBranch(testCwd, 'test-branch');
			branch.stageFiles(testCwd, ['file.ts']);
			branch.commitChanges(testCwd, 'test');

			// Verify ALL calls use array arguments
			for (const call of spawnCalls) {
				expect(call.command).toBe('git');
				expect(Array.isArray(call.args)).toBe(true);
				// Verify no shell operators in any single argument that would indicate string concatenation
				for (const arg of call.args) {
					expect(arg).not.toMatch(/^.*[;&|`$<>].*/);
				}
			}
		});
	});
});
