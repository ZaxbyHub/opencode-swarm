import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import {
	containsControlChars,
	containsPathTraversal,
} from '../utils/path-security';
import { createSwarmTool, type ToolResult } from './create-tool';

// ============ Constants ============
const MAX_FILE_PATH_LENGTH = 500;
const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512KB per file
const MAX_FILES_SCANNED = 1000;
const MAX_EXPLICIT_FILES_SCANNED = 100;
const MAX_FINDINGS = 100;
const MAX_OUTPUT_BYTES = 512_000; // 512KB max output
const MAX_CONTEXT_CHARS = 1000;
const MAX_LONG_LINE_CHARS = 10_000;
const MAX_INCOMPLETE_PATHS = 25;
const MAX_DISCOVERY_DIRECTORIES = 10_000;
// Leave headroom for pre_check_batch's 60-second wrapper timeout so the scan
// can return truthful incomplete-coverage accounting before the wrapper fires.
const SCAN_TIME_BUDGET_MS = 55_000;

// ============ Secret Type Definitions ============
type SecretType =
	| 'api_key'
	| 'aws_access_key'
	| 'aws_secret_key'
	| 'private_key'
	| 'password'
	| 'secret_token'
	| 'bearer_token'
	| 'basic_auth'
	| 'database_url'
	| 'jwt'
	| 'github_token'
	| 'slack_token'
	| 'stripe_key'
	| 'sendgrid_key'
	| 'twilio_key'
	| 'generic_token'
	| 'high_entropy';

type Confidence = 'high' | 'medium' | 'low';
type Severity = 'critical' | 'high' | 'medium' | 'low';

// ============ Result Types ============
export interface SecretFinding {
	path: string;
	line: number;
	type: SecretType;
	confidence: Confidence;
	severity: Severity;
	redacted: string; // Never raw secret, always redacted
	context: string; // Redacted surrounding context
}

export interface SecretscanResult {
	scan_dir: string;
	findings: SecretFinding[];
	count: number;
	files_scanned: number;
	skipped_files: number;
	/** Files requested or discovered but not completely examined. */
	incomplete_files: number;
	incomplete_paths: IncompletePath[];
	message?: string;
}

export interface IncompletePath {
	path: string;
	reason:
		| 'cleanup_failed'
		| 'deadline'
		| 'directory_limit'
		| 'max_files'
		| 'non_file'
		| 'oversized'
		| 'read_error'
		| 'scope_escape'
		| 'symlink'
		| 'truncated';
}

export interface SecretscanErrorResult {
	error: string;
	scan_dir: string;
	findings: [];
	count: 0;
	files_scanned: 0;
	skipped_files: 0;
}

// ============ Binary File Signatures ============
const BINARY_SIGNATURES = [
	0x00_00_00_00, // null
	0x89_50_4e_47, // PNG
	0xff_d8_ff_e0, // JPEG
	0x47_49_46_38, // GIF
	0x25_50_44_46, // PDF
	0x50_4b_03_04, // ZIP/JAR
];

const BINARY_PREFIX_BYTES = 4;
const BINARY_NULL_CHECK_BYTES = 8192;
const BINARY_NULL_THRESHOLD = 0.1;

// ============ Default Exclusions ============
const DEFAULT_EXCLUDE_DIRS = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'out',
	'coverage',
	'.next',
	'.nuxt',
	'.cache',
	'vendor',
	'.svn',
	'.hg',
	'.gradle',
	'target',
	'__pycache__',
	'.pytest_cache',
	'.venv',
	'venv',
	'.env',
	'.idea',
	'.vscode',
]) as Set<string>;

const DEFAULT_EXCLUDE_EXTENSIONS = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.ico',
	'.svg',
	'.pdf',
	'.zip',
	'.tar',
	'.gz',
	'.rar',
	'.7z',
	'.wasm',
	'.exe',
	'.dll',
	'.so',
	'.dylib',
	'.bin',
	'.dat',
	'.db',
	'.sqlite',
	'.lock',
	'.log',
	'.md',
]) as Set<string>;

// ============ Secret Detection Patterns ============
interface SecretPattern {
	type: SecretType;
	regex: RegExp;
	confidence: Confidence;
	severity: Severity;
	redactTemplate: (match: string) => string;
}

const SECRET_PATTERNS: SecretPattern[] = [
	// AWS Access Key ID
	{
		type: 'aws_access_key',
		regex:
			/(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|aws_access_key_id|aws_secret_access_key)\s*[=:]\s*['"]?([A-Z0-9]{20})['"]?/gi,
		confidence: 'high',
		severity: 'critical',
		redactTemplate: () => 'AKIA[REDACTED]',
	},
	// AWS Secret Key - tightened to avoid ReDoS on malformed lines
	{
		type: 'aws_secret_key',
		regex:
			/(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key)\s*[=:]\s*['"]?([A-Za-z0-9+/=]{40})['"]?/gi,
		confidence: 'high',
		severity: 'critical',
		redactTemplate: () => '[REDACTED_AWS_SECRET]',
	},
	// Generic API Key patterns
	{
		type: 'api_key',
		regex:
			/(?:api[_-]?key|apikey|API[_-]?KEY)\s*[=:]\s*['"]?([a-zA-Z0-9_-]{16,64})['"]?/gi,
		confidence: 'medium',
		severity: 'high',
		redactTemplate: (m) => {
			const key = m.match(/[a-zA-Z0-9_-]{16,64}/)?.[0] || '';
			return `api_key=${key.slice(0, 4)}...${key.slice(-4)}`;
		},
	},
	// Bearer Token - bounded to prevent ReDoS
	{
		type: 'bearer_token',
		regex: /(?:bearer\s+|Bearer\s+)([a-zA-Z0-9_\-.]{1,200})[\s"'<]/gi,
		confidence: 'medium',
		severity: 'high',
		redactTemplate: () => 'bearer [REDACTED]',
	},
	// Basic Auth - bounded to prevent ReDoS
	{
		type: 'basic_auth',
		regex: /(?:basic\s+|Basic\s+)([a-zA-Z0-9+/=]{1,200})[\s"'<]/gi,
		confidence: 'medium',
		severity: 'high',
		redactTemplate: () => 'basic [REDACTED]',
	},
	// Database URL with credentials - tightened to avoid ReDoS on malformed lines
	{
		type: 'database_url',
		regex:
			/(?:mysql|postgres|postgresql|mongodb|redis):\/\/[^\s"'/:]+:[^\s"'/:]+@[^\s"']+/gi,
		confidence: 'high',
		severity: 'critical',
		redactTemplate: () => 'mysql://[user]:[password]@[host]',
	},
	// GitHub Token
	{
		type: 'github_token',
		regex: /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}/gi,
		confidence: 'high',
		severity: 'critical',
		redactTemplate: () => 'ghp_[REDACTED]',
	},
	// Generic Token - bounded to prevent ReDoS
	{
		type: 'generic_token',
		regex: /(?:token|TOKEN)\s*[=:]\s*['"]?([a-zA-Z0-9_\-.]{20,80})['"]?/gi,
		confidence: 'low',
		severity: 'medium',
		redactTemplate: (m) => {
			const token = m.match(/[a-zA-Z0-9_\-.]{20,80}/)?.[0] || '';
			return `token=${token.slice(0, 4)}...`;
		},
	},
	// Password in config - bounded to prevent ReDoS
	{
		type: 'password',
		regex:
			/(?:password|passwd|pwd|PASSWORD|PASSWD)\s*[=:]\s*['"]?([^\s'"]{4,100})['"]?/gi,
		confidence: 'medium',
		severity: 'high',
		redactTemplate: () => 'password=[REDACTED]',
	},
	// Private Key
	{
		type: 'private_key',
		regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gi,
		confidence: 'high',
		severity: 'critical',
		redactTemplate: () => '-----BEGIN PRIVATE KEY-----',
	},
	// JWT Token
	{
		type: 'jwt',
		regex: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
		confidence: 'high',
		severity: 'high',
		redactTemplate: (m) => `eyJ...${m.slice(-10)}`,
	},
	// Stripe Key
	{
		type: 'stripe_key',
		regex: /(?:sk|pk)_(?:live|test)_[a-zA-Z0-9]{24,}/gi,
		confidence: 'high',
		severity: 'critical',
		redactTemplate: () => 'sk_live_[REDACTED]',
	},
	// Slack Token
	{
		type: 'slack_token',
		regex: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/g,
		confidence: 'high',
		severity: 'critical',
		redactTemplate: () => 'xoxb-[REDACTED]',
	},
	// SendGrid Key
	{
		type: 'sendgrid_key',
		regex: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g,
		confidence: 'high',
		severity: 'critical',
		redactTemplate: () => 'SG.[REDACTED]',
	},
	// Twilio Key
	{
		type: 'twilio_key',
		regex: /SK[a-f0-9]{32}/gi,
		confidence: 'high',
		severity: 'critical',
		redactTemplate: () => 'SK[REDACTED]',
	},
];

// ============ Entropy Calculation ============
function calculateShannonEntropy(str: string): number {
	if (str.length === 0) return 0;

	const freq: Map<string, number> = new Map();
	for (const char of str) {
		freq.set(char, (freq.get(char) || 0) + 1);
	}

	let entropy = 0;
	for (const count of freq.values()) {
		const p = count / str.length;
		entropy -= p * Math.log2(p);
	}

	return entropy;
}

function isHighEntropyString(str: string): boolean {
	// Must be at least 20 chars to consider for entropy
	if (str.length < 20) return false;

	// Must have at least 25% alphanumeric
	const alphanumeric = str.replace(/[^a-zA-Z0-9]/g, '').length;
	if (alphanumeric / str.length < 0.25) return false;

	// High entropy threshold for potential secrets (>4 bits per char)
	const entropy = calculateShannonEntropy(str);
	return entropy > 4.0;
}

// ============ Validation ============

/**
 * Validate an exclude pattern for safety.
 * Returns an error message if the pattern is unsafe, or null if it is valid.
 */
function validateExcludePattern(exc: string): string | null {
	if (exc.length === 0) return null; // Empty patterns are silently ignored
	if (exc.length > MAX_FILE_PATH_LENGTH) {
		return `invalid exclude path: exceeds maximum length of ${MAX_FILE_PATH_LENGTH}`;
	}
	if (containsControlChars(exc)) {
		return 'invalid exclude path: contains path traversal or control characters';
	}
	if (containsPathTraversal(exc)) {
		return 'invalid exclude path: contains path traversal or control characters';
	}
	// Reject negation patterns (could cause surprising behavior)
	if (exc.startsWith('!')) {
		return 'invalid exclude path: negation patterns are not supported';
	}
	// Reject absolute paths
	if (exc.startsWith('/') || exc.startsWith('\\')) {
		return 'invalid exclude path: absolute paths are not supported';
	}
	return null;
}

/**
 * Determine if a pattern looks like a glob or path pattern (vs a plain name).
 * Plain names are single path components with no glob characters.
 */
function isGlobOrPathPattern(pattern: string): boolean {
	return (
		pattern.includes('/') || pattern.includes('\\') || /[*?[\]{}]/.test(pattern)
	);
}

/**
 * Load patterns from a .secretscanignore file in the scan root.
 * Returns an array of validated patterns; silently skips blank lines, comments, and unsafe patterns.
 */
function loadSecretScanIgnore(scanDir: string): string[] {
	const ignorePath = path.join(scanDir, '.secretscanignore');
	try {
		if (!fs.existsSync(ignorePath)) return [];
		const content = fs.readFileSync(ignorePath, 'utf8');
		const patterns: string[] = [];
		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith('#')) continue;
			if (validateExcludePattern(line) === null) {
				patterns.push(line);
			}
		}
		return patterns;
	} catch {
		return [];
	}
}

/**
 * Check whether a file-system entry should be excluded.
 * @param entry - The entry's basename
 * @param relPath - The entry's path relative to scanDir (forward slashes)
 * @param exactNames - Set of exact basename patterns (backward-compatible)
 * @param globPatterns - Array of glob/path patterns
 */
function isExcluded(
	entry: string,
	relPath: string,
	exactNames: Set<string>,
	globPatterns: string[],
): boolean {
	// Backward-compatible exact name match
	if (exactNames.has(entry)) return true;
	// Glob / path pattern match against the relative path
	for (const pattern of globPatterns) {
		if (path.matchesGlob(relPath, pattern)) return true;
	}
	return false;
}

function validateDirectoryInput(dir: string): string | null {
	if (!dir || dir.length === 0) {
		return 'directory is required';
	}
	if (dir.length > MAX_FILE_PATH_LENGTH) {
		return `directory exceeds maximum length of ${MAX_FILE_PATH_LENGTH}`;
	}
	if (containsControlChars(dir)) {
		return 'directory contains control characters';
	}
	if (containsPathTraversal(dir)) {
		return 'directory contains path traversal';
	}
	return null;
}

// ============ File Detection ============
function isBinaryFile(filePath: string, buffer: Buffer): boolean {
	const ext = path.extname(filePath).toLowerCase();
	if (DEFAULT_EXCLUDE_EXTENSIONS.has(ext)) {
		return true;
	}

	if (buffer.length >= BINARY_PREFIX_BYTES) {
		const prefix = buffer.subarray(0, BINARY_PREFIX_BYTES);
		const uint32 = prefix.readUInt32BE(0);
		for (const sig of BINARY_SIGNATURES) {
			if (uint32 === sig) return true;
		}
	}

	let nullCount = 0;
	const checkLen = Math.min(buffer.length, BINARY_NULL_CHECK_BYTES);
	for (let i = 0; i < checkLen; i++) {
		if (buffer[i] === 0) nullCount++;
	}
	return nullCount > checkLen * BINARY_NULL_THRESHOLD;
}

// ============ Redaction Utilities ============
function _redactMatch(_fullMatch: string, _group?: string): string {
	// Replace the actual secret portion with redacted version
	return '[REDACTED]';
}

function _createContextRedactor(
	line: string,
	startIdx: number,
	endIdx: number,
): string {
	const before = line.slice(0, startIdx);
	const after = line.slice(endIdx);
	return `${before}[SECRET]${after}`;
}

// ============ Secret Scanning ============
interface ScanLineResult {
	type: SecretType;
	confidence: Confidence;
	severity: Severity;
	redacted: string;
	matchStart: number;
	matchEnd: number;
}

function scanLineForSecrets(line: string, _lineNum: number): ScanLineResult[] {
	const results: ScanLineResult[] = [];

	// Check against all regex patterns (reuse compiled patterns)
	for (const pattern of SECRET_PATTERNS) {
		// Reset lastIndex for global patterns to ensure deterministic behavior
		pattern.regex.lastIndex = 0;
		for (
			let match = pattern.regex.exec(line);
			match !== null;
			match = pattern.regex.exec(line)
		) {
			const fullMatch = match[0];
			const redacted = pattern.redactTemplate(fullMatch);

			results.push({
				type: pattern.type,
				confidence: pattern.confidence,
				severity: pattern.severity,
				redacted,
				matchStart: match.index,
				matchEnd: match.index + fullMatch.length,
			});

			// Prevent infinite loops on zero-width matches
			if (match.index === pattern.regex.lastIndex) {
				pattern.regex.lastIndex++;
			}
		}
	}

	// High entropy string detection (run regardless of pattern matches, avoid duplicates)
	// Look for potential high-entropy values in key=value patterns - bounded to prevent ReDoS
	const valueMatch = line.match(
		/((?:secret|key|token|password|cred|credential))\s*[=:]\s*["']?([a-zA-Z0-9+/=_-]{20,100})["']?/i,
	);
	if (valueMatch && isHighEntropyString(valueMatch[2])) {
		const matchStart = valueMatch.index || 0;
		const matchEnd = matchStart + valueMatch[0].length;

		// Check if this overlaps with any existing pattern match to avoid duplicates
		const hasOverlap = results.some(
			(r) => !(r.matchEnd <= matchStart || r.matchStart >= matchEnd),
		);

		if (!hasOverlap) {
			results.push({
				type: 'high_entropy',
				confidence: 'low',
				severity: 'medium',
				redacted: `${valueMatch[1]}=[HIGH_ENTROPY]`,
				matchStart,
				matchEnd,
			});
		}
	}

	return results;
}

function createRedactedContext(
	line: string,
	findings: ScanLineResult[],
): string {
	if (findings.length === 0) return '';

	// Sort findings by position
	const sorted = [...findings].sort((a, b) => a.matchStart - b.matchStart);

	let result = '';
	let lastEnd = 0;

	for (const finding of sorted) {
		if (finding.matchEnd <= lastEnd) continue;
		if (finding.matchStart >= lastEnd) {
			result += line.slice(lastEnd, finding.matchStart);
			result += '[REDACTED]';
		}
		lastEnd = Math.max(lastEnd, finding.matchEnd);
	}

	// Add remaining portion
	result += line.slice(lastEnd);

	if (result.length <= MAX_CONTEXT_CHARS) return result;
	const truncationMarker = '...[context truncated]...';
	const edgeLength = Math.floor(
		(MAX_CONTEXT_CHARS - truncationMarker.length) / 2,
	);
	const remaining = MAX_CONTEXT_CHARS - truncationMarker.length - edgeLength;
	return `${result.slice(0, edgeLength)}${truncationMarker}${result.slice(-remaining)}`;
}

// O_NOFOLLOW flag for atomic symlink prevention (POSIX only, undefined on Windows)
const O_NOFOLLOW: number | undefined =
	process.platform !== 'win32'
		? (fs.constants as { O_NOFOLLOW: number }).O_NOFOLLOW
		: undefined;

// ============ File Scanning ============
type ScanMode = 'standalone' | 'explicit';

type SecretFileScanOutcome =
	| { status: 'scanned'; findings: SecretFinding[] }
	| { status: 'skipped'; reason: 'binary' | 'symlink' }
	| {
			status: 'incomplete';
			reason: 'oversized' | 'non_file' | 'read_error' | 'symlink';
	  };

type BoundedFileReadOutcome =
	| { status: 'ok'; buffer: Buffer; truncated: boolean }
	| { status: 'incomplete'; reason: 'oversized' | 'non_file' | 'read_error' };

function getStableFileIdentity(
	stat: Pick<fs.BigIntStats, 'dev' | 'ino'>,
): string | null {
	const { dev, ino } = stat;
	if (dev < 0n || ino < 0n || (dev === 0n && ino === 0n)) {
		return null;
	}
	return `${dev}:${ino}`;
}

function readBoundedFile(
	filePath: string,
	expectedPathStat: fs.BigIntStats,
): BoundedFileReadOutcome {
	const expectedIdentity = getStableFileIdentity(expectedPathStat);
	if (expectedIdentity === null) {
		return { status: 'incomplete', reason: 'read_error' };
	}

	let fd: number | null = null;
	try {
		const flags =
			fs.constants.O_RDONLY | (O_NOFOLLOW !== undefined ? O_NOFOLLOW : 0);
		fd = _internals.openFile(filePath, flags);
	} catch {
		return { status: 'incomplete', reason: 'read_error' };
	}

	let outcome: BoundedFileReadOutcome;
	let closeFailed = false;
	try {
		const stat = _internals.fstatFile(fd);
		const descriptorIdentity = getStableFileIdentity(stat);
		const initialSize = stat.size;
		if (!stat.isFile()) {
			outcome = { status: 'incomplete', reason: 'non_file' };
		} else if (
			descriptorIdentity === null ||
			descriptorIdentity !== expectedIdentity
		) {
			outcome = { status: 'incomplete', reason: 'read_error' };
		} else {
			const bufferLength =
				initialSize >= BigInt(MAX_FILE_SIZE_BYTES)
					? MAX_FILE_SIZE_BYTES + 1
					: Number(initialSize) + 1;
			const buffer = Buffer.allocUnsafe(bufferLength);
			let bytesRead = 0;
			while (bytesRead < buffer.length) {
				const count = _internals.readFileChunk(
					fd,
					buffer,
					bytesRead,
					buffer.length - bytesRead,
					null,
				);
				if (count === 0) break;
				bytesRead += count;
			}
			const postStat = _internals.fstatFile(fd);
			const postDescriptorIdentity = getStableFileIdentity(postStat);
			const postPathStat = _internals.lstatFile(filePath);
			const postPathIdentity = getStableFileIdentity(postPathStat);
			if (
				!postStat.isFile() ||
				postDescriptorIdentity === null ||
				postDescriptorIdentity !== descriptorIdentity ||
				postPathStat.isSymbolicLink() ||
				!postPathStat.isFile() ||
				postPathIdentity === null ||
				postPathIdentity !== descriptorIdentity
			) {
				outcome = { status: 'incomplete', reason: 'read_error' };
			} else if (postStat.size !== initialSize) {
				outcome = {
					status: 'incomplete',
					reason:
						postStat.size > BigInt(MAX_FILE_SIZE_BYTES)
							? 'oversized'
							: 'read_error',
				};
			} else {
				outcome = {
					status: 'ok',
					buffer: buffer.subarray(0, bytesRead),
					truncated: initialSize > MAX_FILE_SIZE_BYTES,
				};
			}
		}
	} catch {
		outcome = { status: 'incomplete', reason: 'read_error' };
	} finally {
		if (fd !== null) {
			try {
				_internals.closeFile(fd);
			} catch {
				closeFailed = true;
			}
		}
	}
	if (closeFailed) return { status: 'incomplete', reason: 'read_error' };
	return outcome;
}

function scanFileForSecrets(
	filePath: string,
	mode: ScanMode,
): SecretFileScanOutcome {
	const findings: SecretFinding[] = [];

	try {
		// Use lstat to check if file is a symlink (defense in depth)
		const lstat = _internals.lstatFile(filePath);
		if (lstat.isSymbolicLink()) {
			return mode === 'explicit'
				? { status: 'incomplete', reason: 'symlink' }
				: { status: 'skipped', reason: 'symlink' };
		}

		if (!lstat.isFile()) {
			return { status: 'incomplete', reason: 'non_file' };
		}

		// Open first, inspect the opened handle, and read at most one byte beyond
		// the limit so growth/replacement races cannot cause unbounded allocation.
		const readOutcome = readBoundedFile(filePath, lstat);
		if (readOutcome.status === 'incomplete') return readOutcome;
		const { buffer, truncated } = readOutcome;

		// Skip binary files, including oversized binary prefixes.
		if (isBinaryFile(filePath, buffer)) {
			return { status: 'skipped', reason: 'binary' };
		}

		if (truncated) {
			return { status: 'incomplete', reason: 'oversized' };
		}

		// Handle UTF-8 BOM (EF BB BF) - strip it to prevent issues
		let content: string;
		if (
			buffer.length >= 3 &&
			buffer[0] === 0xef &&
			buffer[1] === 0xbb &&
			buffer[2] === 0xbf
		) {
			content = buffer.slice(3).toString('utf-8');
		} else {
			content = buffer.toString('utf-8');
		}

		// Check for null bytes after decoding - skip files with embedded NUL
		if (content.includes('\0')) {
			return { status: 'skipped', reason: 'binary' };
		}

		const lines = content.split('\n');

		for (let i = 0; i < lines.length; i++) {
			if (mode === 'standalone' && lines[i].length > MAX_LONG_LINE_CHARS) {
				continue;
			}
			const lineResults = scanLineForSecrets(lines[i], i + 1);
			const context = createRedactedContext(lines[i], lineResults);

			for (const result of lineResults) {
				findings.push({
					path: filePath,
					line: i + 1, // Deterministic: always use current line number
					type: result.type,
					confidence: result.confidence,
					severity: result.severity,
					redacted: result.redacted,
					context,
				});
			}
		}
		return { status: 'scanned', findings };
	} catch {
		return { status: 'incomplete', reason: 'read_error' };
	}
}

function assertNever(value: never): never {
	throw new Error(`Unhandled secretscan outcome: ${String(value)}`);
}

async function yieldToEventLoop(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function serializeSecretscanResult(result: SecretscanResult): string {
	let findings = result.findings;
	let candidate: SecretscanResult = result;
	let json = JSON.stringify(candidate, null, 2);

	while (
		Buffer.byteLength(json, 'utf8') > MAX_OUTPUT_BYTES &&
		findings.length > 0
	) {
		findings = findings.slice(0, Math.floor(findings.length / 2));
		candidate = {
			...result,
			findings,
			message: 'Output truncated due to size limits.',
		};
		json = JSON.stringify(candidate, null, 2);
	}

	if (Buffer.byteLength(json, 'utf8') > MAX_OUTPUT_BYTES) {
		candidate = {
			...result,
			findings: [],
			message: 'Output truncated due to size limits.',
		};
		json = JSON.stringify(candidate, null, 2);
	}

	return json;
}

// ============ Directory Scanning ============
interface ScanStats {
	skippedDirs: number;
	skippedFiles: number;
	fileErrors: number;
	symlinkSkipped: number;
}

// Per-scan visited real paths - avoids cross-scan state leakage
type VisitedPaths = Set<string>;

function isSymlinkLoop(realPath: string, visited: VisitedPaths): boolean {
	if (visited.has(realPath)) {
		return true;
	}
	visited.add(realPath);
	return false;
}

function isPathWithinScope(realPath: string, scanDir: string): boolean {
	// Resolve both paths and check if realPath is within scanDir
	const resolvedScanDir = path.resolve(scanDir);
	const resolvedRealPath = path.resolve(realPath);
	// Use separator-aware check to prevent /abc vs /abcd confusion
	return (
		resolvedRealPath === resolvedScanDir ||
		resolvedRealPath.startsWith(resolvedScanDir + path.sep) ||
		resolvedRealPath.startsWith(`${resolvedScanDir}/`) ||
		resolvedRealPath.startsWith(`${resolvedScanDir}\\`)
	);
}

const DISCOVERY_YIELD_INTERVAL = 100;

interface DiscoveryState {
	files: string[];
	totalCandidates: number;
	deadline: number;
	deadlineExceeded: boolean;
	cleanupFailed: boolean;
	entriesSinceYield: number;
	incompletePaths: IncompletePath[];
	directoriesQueued: number;
	unexaminedDirectories: number;
}

function toSafeRelativePath(rootDir: string, targetPath: string): string {
	const relative = path.relative(rootDir, targetPath).replace(/\\/g, '/');
	if (!relative || relative === '.') return '.';
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		const basename = path.basename(targetPath).replace(/\\/g, '/');
		return basename || '.';
	}
	return relative;
}

function recordIncompletePath(
	target: IncompletePath[],
	rootDir: string,
	targetPath: string,
	reason: IncompletePath['reason'],
): void {
	if (target.length >= MAX_INCOMPLETE_PATHS) {
		target[MAX_INCOMPLETE_PATHS - 1] = { path: '.', reason: 'truncated' };
		return;
	}
	target.push({ path: toSafeRelativePath(rootDir, targetPath), reason });
}

function compareFilePaths(a: string, b: string): number {
	const aLower = a.toLowerCase();
	const bLower = b.toLowerCase();
	if (aLower < bLower) return -1;
	if (aLower > bLower) return 1;
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function addBoundedCandidate(state: DiscoveryState, filePath: string): void {
	state.totalCandidates++;
	const heap = state.files;
	if (heap.length < MAX_FILES_SCANNED) {
		heap.push(filePath);
		let index = heap.length - 1;
		while (index > 0) {
			const parent = Math.floor((index - 1) / 2);
			if (compareFilePaths(heap[parent], heap[index]) >= 0) break;
			[heap[parent], heap[index]] = [heap[index], heap[parent]];
			index = parent;
		}
		return;
	}

	if (compareFilePaths(filePath, heap[0]) >= 0) return;
	heap[0] = filePath;
	let index = 0;
	while (true) {
		const left = index * 2 + 1;
		const right = left + 1;
		let largest = index;
		if (left < heap.length && compareFilePaths(heap[left], heap[largest]) > 0) {
			largest = left;
		}
		if (
			right < heap.length &&
			compareFilePaths(heap[right], heap[largest]) > 0
		) {
			largest = right;
		}
		if (largest === index) break;
		[heap[index], heap[largest]] = [heap[largest], heap[index]];
		index = largest;
	}
}

async function collectScannableFiles(
	dir: string,
	excludeExact: Set<string>,
	excludeGlobs: string[],
	scanDir: string,
	visited: VisitedPaths,
	stats: ScanStats,
	state: DiscoveryState,
): Promise<void> {
	const pending = [dir];

	while (pending.length > 0) {
		if (state.deadlineExceeded || state.cleanupFailed) return;
		const currentDir = pending.pop();
		if (!currentDir) continue;

		let directory: fs.Dir;
		try {
			directory = fs.opendirSync(currentDir);
		} catch {
			stats.fileErrors++;
			recordIncompletePath(
				state.incompletePaths,
				scanDir,
				currentDir,
				'read_error',
			);
			continue;
		}

		let stoppedEarly = false;
		try {
			while (true) {
				if (state.entriesSinceYield >= DISCOVERY_YIELD_INTERVAL) {
					state.entriesSinceYield = 0;
					await _internals.yieldToEventLoop();
					if (_internals.now() >= state.deadline) {
						state.deadlineExceeded = true;
						recordIncompletePath(
							state.incompletePaths,
							scanDir,
							currentDir,
							'deadline',
						);
						stoppedEarly = true;
						break;
					}
				}

				const entry = directory.readSync();
				if (!entry) break;
				state.entriesSinceYield++;
				const fullPath = path.join(currentDir, entry.name);
				const relPath = path.relative(scanDir, fullPath).replace(/\\/g, '/');

				if (isExcluded(entry.name, relPath, excludeExact, excludeGlobs)) {
					stats.skippedDirs++;
					continue;
				}

				let lstat: fs.Stats;
				try {
					lstat = fs.lstatSync(fullPath);
				} catch {
					stats.fileErrors++;
					recordIncompletePath(
						state.incompletePaths,
						scanDir,
						fullPath,
						'read_error',
					);
					continue;
				}

				if (lstat.isSymbolicLink()) {
					stats.symlinkSkipped++;
					continue;
				}

				if (lstat.isDirectory()) {
					if (state.directoriesQueued >= MAX_DISCOVERY_DIRECTORIES) {
						state.unexaminedDirectories++;
						recordIncompletePath(
							state.incompletePaths,
							scanDir,
							fullPath,
							'directory_limit',
						);
						continue;
					}
					let realPath: string;
					try {
						realPath = fs.realpathSync(fullPath);
					} catch {
						stats.fileErrors++;
						recordIncompletePath(
							state.incompletePaths,
							scanDir,
							fullPath,
							'read_error',
						);
						continue;
					}

					if (
						isSymlinkLoop(realPath, visited) ||
						!isPathWithinScope(realPath, scanDir)
					) {
						stats.symlinkSkipped++;
						continue;
					}

					pending.push(fullPath);
					state.directoriesQueued++;
				} else if (lstat.isFile()) {
					const ext = path.extname(fullPath).toLowerCase();
					if (!DEFAULT_EXCLUDE_EXTENSIONS.has(ext)) {
						addBoundedCandidate(state, fullPath);
					} else {
						stats.skippedFiles++;
					}
				} else {
					stats.fileErrors++;
					recordIncompletePath(
						state.incompletePaths,
						scanDir,
						fullPath,
						'non_file',
					);
				}
			}
		} finally {
			try {
				_internals.closeDirectory(directory);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') {
					state.cleanupFailed = true;
					recordIncompletePath(
						state.incompletePaths,
						scanDir,
						currentDir,
						'cleanup_failed',
					);
				}
			}
		}

		if (stoppedEarly) break;
	}
}

// ============ Tool Definition ============
export const secretscan: ReturnType<typeof createSwarmTool> = createSwarmTool({
	description:
		'Scan directory for potential secrets (API keys, tokens, passwords) using regex patterns and entropy heuristics. Returns metadata-only findings with redacted previews - NEVER returns raw secrets. Excludes common directories (node_modules, .git, dist, etc.) by default. Supports glob patterns (e.g. **/.svelte-kit/**, **/*.test.ts) and reads .secretscanignore at the scan root.',
	args: {
		directory: z
			.string()
			.describe('Directory to scan for secrets (e.g., "." or "./src")'),
		exclude: z
			.array(z.string())
			.optional()
			.describe(
				'Patterns to exclude: plain directory names (e.g. node_modules), relative paths, or globs (e.g. **/.svelte-kit/**, **/*.test.ts). Added to default exclusions.',
			),
	},
	async execute(
		args: unknown,
		_directory: string,
		_ctx?: ToolContext,
	): Promise<string> {
		const typedArgs = args as { directory: string; exclude?: string[] };
		// Safe args extraction - guard against malformed args and malicious getters
		let directory: string | undefined;
		let exclude: string[] | undefined;
		try {
			if (typedArgs && typeof typedArgs === 'object') {
				directory = typedArgs.directory;
				exclude = typedArgs.exclude;
			}
		} catch {
			// Malicious getter threw - treat as malformed args
		}

		// Handle malformed args: return structured error
		if (directory === undefined) {
			const errorResult: SecretscanErrorResult = {
				error: 'invalid arguments: directory is required',
				scan_dir: '',
				findings: [],
				count: 0,
				files_scanned: 0,
				skipped_files: 0,
			};
			return JSON.stringify(errorResult, null, 2);
		}

		// Validate inputs - use safely extracted values
		const dirValidationError = validateDirectoryInput(directory);
		if (dirValidationError) {
			const errorResult: SecretscanErrorResult = {
				error: `invalid directory: ${dirValidationError}`,
				scan_dir: directory,
				findings: [],
				count: 0,
				files_scanned: 0,
				skipped_files: 0,
			};
			return JSON.stringify(errorResult, null, 2);
		}

		// Validate exclude array items
		if (exclude) {
			for (const exc of exclude) {
				const err = validateExcludePattern(exc);
				if (err) {
					const errorResult: SecretscanErrorResult = {
						error: err,
						scan_dir: directory,
						findings: [],
						count: 0,
						files_scanned: 0,
						skipped_files: 0,
					};
					return JSON.stringify(errorResult, null, 2);
				}
			}
		}

		try {
			// Resolve the target directory to an absolute path, then resolve
			// any OS-level symlinks (e.g. /var → /private/var on macOS) so that
			// isPathWithinScope() comparisons against fs.realpathSync()-resolved
			// subdirectory paths always match.
			const scanDirRaw = path.resolve(directory);
			const scanDir = (() => {
				try {
					return fs.realpathSync(scanDirRaw);
				} catch {
					return scanDirRaw;
				}
			})();

			let dirStat: fs.Stats;
			try {
				dirStat = fs.lstatSync(scanDir);
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				const errorResult: SecretscanErrorResult = {
					error:
						err.code === 'ENOENT'
							? 'directory not found'
							: `scan failed: ${err.message || 'unable to inspect directory'}`,
					scan_dir: directory,
					findings: [],
					count: 0,
					files_scanned: 0,
					skipped_files: 0,
				};
				return JSON.stringify(errorResult, null, 2);
			}

			if (!dirStat.isDirectory()) {
				const errorResult: SecretscanErrorResult = {
					error: 'target must be a directory, not a file',
					scan_dir: directory,
					findings: [],
					count: 0,
					files_scanned: 0,
					skipped_files: 0,
				};
				return JSON.stringify(errorResult, null, 2);
			}

			// Build exclusion sets: exact names (backward-compat) + glob/path patterns
			const excludeExact = new Set(DEFAULT_EXCLUDE_DIRS);
			const excludeGlobs: string[] = [];

			// Load .secretscanignore patterns from scan root
			const ignoreFilePatterns = loadSecretScanIgnore(scanDir);

			const allUserPatterns = [...(exclude ?? []), ...ignoreFilePatterns];
			for (const exc of allUserPatterns) {
				if (exc.length === 0) continue;
				if (isGlobOrPathPattern(exc)) {
					excludeGlobs.push(exc);
				} else {
					excludeExact.add(exc);
				}
			}

			// Find all scannable files
			const stats: ScanStats = {
				skippedDirs: 0,
				skippedFiles: 0,
				fileErrors: 0,
				symlinkSkipped: 0,
			};
			// Per-scan visited paths - avoids cross-scan state leakage
			const visited: VisitedPaths = new Set();
			const deadline = _internals.now() + SCAN_TIME_BUDGET_MS;
			const discovery: DiscoveryState = {
				files: [],
				totalCandidates: 0,
				deadline,
				deadlineExceeded: false,
				cleanupFailed: false,
				entriesSinceYield: 0,
				incompletePaths: [],
				directoriesQueued: 1,
				unexaminedDirectories: 0,
			};
			await _internals.yieldToEventLoop();
			await collectScannableFiles(
				scanDir,
				excludeExact,
				excludeGlobs,
				scanDir,
				visited,
				stats,
				discovery,
			);
			const files = discovery.files;

			// Sort for deterministic order (case-insensitive but stable)
			files.sort(compareFilePaths);
			const filesToScan = files;
			if (discovery.totalCandidates > filesToScan.length) {
				recordIncompletePath(
					discovery.incompletePaths,
					scanDir,
					scanDir,
					'max_files',
				);
			}
			if (discovery.deadlineExceeded) {
				recordIncompletePath(
					discovery.incompletePaths,
					scanDir,
					scanDir,
					'deadline',
				);
			}
			if (discovery.cleanupFailed) {
				recordIncompletePath(
					discovery.incompletePaths,
					scanDir,
					scanDir,
					'cleanup_failed',
				);
			}

			// Scan files for secrets
			const allFindings: SecretFinding[] = [];
			let filesScanned = 0;
			let skippedFiles = stats.skippedFiles;
			let incompleteFiles =
				stats.fileErrors +
				Math.max(0, discovery.totalCandidates - filesToScan.length) +
				(discovery.deadlineExceeded || discovery.cleanupFailed ? 1 : 0) +
				discovery.unexaminedDirectories;

			for (let index = 0; index < filesToScan.length; index++) {
				if (_internals.now() >= deadline) {
					for (const remaining of filesToScan.slice(index)) {
						recordIncompletePath(
							discovery.incompletePaths,
							scanDir,
							remaining,
							'deadline',
						);
					}
					incompleteFiles += filesToScan.length - index;
					break;
				}
				if (allFindings.length >= MAX_FINDINGS) {
					recordIncompletePath(
						discovery.incompletePaths,
						scanDir,
						scanDir,
						'truncated',
					);
					incompleteFiles += filesToScan.length - index;
					break;
				}

				const outcome = scanFileForSecrets(filesToScan[index], 'standalone');
				switch (outcome.status) {
					case 'scanned':
						filesScanned++;
						break;
					case 'skipped':
						skippedFiles++;
						break;
					case 'incomplete':
						skippedFiles++;
						incompleteFiles++;
						recordIncompletePath(
							discovery.incompletePaths,
							scanDir,
							filesToScan[index],
							outcome.reason,
						);
						break;
					default:
						assertNever(outcome);
				}

				if (outcome.status === 'scanned') {
					for (const finding of outcome.findings) {
						if (allFindings.length >= MAX_FINDINGS) break;
						allFindings.push(finding);
					}
				}

				if (index + 1 < filesToScan.length) {
					await _internals.yieldToEventLoop();
				}
			}

			// Sort findings deterministically: by path (case-insensitive), then by line
			allFindings.sort((a, b) => {
				const aPathLower = a.path.toLowerCase();
				const bPathLower = b.path.toLowerCase();
				if (aPathLower < bPathLower) return -1;
				if (aPathLower > bPathLower) return 1;
				// Tie-breaker: stable sort on path
				if (a.path < b.path) return -1;
				if (a.path > b.path) return 1;
				return a.line - b.line;
			});

			const result: SecretscanResult = {
				scan_dir: directory,
				findings: allFindings,
				count: allFindings.length,
				files_scanned: filesScanned,
				skipped_files: skippedFiles + stats.fileErrors + stats.symlinkSkipped,
				incomplete_files: incompleteFiles,
				incomplete_paths: discovery.incompletePaths,
			};

			// Add informative message if results were truncated
			const parts: string[] = [];
			if (discovery.totalCandidates > MAX_FILES_SCANNED) {
				parts.push(
					`Found ${discovery.totalCandidates} files, selected ${MAX_FILES_SCANNED}`,
				);
			}
			if (discovery.deadlineExceeded) {
				parts.push('Discovery stopped at the scan deadline');
			}
			if (discovery.cleanupFailed) {
				parts.push('Discovery directory cleanup failed');
			}
			if (allFindings.length >= MAX_FINDINGS) {
				parts.push(`Results limited to ${MAX_FINDINGS} findings`);
			}
			if (incompleteFiles > 0) {
				parts.push(`${incompleteFiles} files were not completely scanned`);
			}
			if (
				skippedFiles > 0 ||
				stats.fileErrors > 0 ||
				stats.symlinkSkipped > 0
			) {
				parts.push(
					`${
						skippedFiles + stats.fileErrors + stats.symlinkSkipped
					} files skipped (binary/oversized/symlinks/errors)`,
				);
			}
			if (parts.length > 0) {
				result.message = `${parts.join('; ')}.`;
			}

			return serializeSecretscanResult(result);
		} catch (e) {
			const errorResult: SecretscanErrorResult = {
				error:
					e instanceof Error
						? `scan failed: ${e.message || 'internal error'}`
						: 'scan failed: unknown error',
				scan_dir: directory,
				findings: [],
				count: 0,
				files_scanned: 0,
				skipped_files: 0,
			};
			return JSON.stringify(errorResult, null, 2);
		}
	},
});

// ============ Standalone Run Function ============
// Reusable function for programmatic calls (e.g., preflight service)
/**
 * Run secretscan programmatically
 */
export async function runSecretscan(
	directory: string,
): Promise<SecretscanResult | SecretscanErrorResult> {
	try {
		// Call the tool's execute function with proper args format
		// Use type assertion to bypass strict context requirements for programmatic calls
		const result = (await _internals.secretscan.execute(
			{ directory },
			{} as Parameters<typeof secretscan.execute>[1],
		)) as unknown as ToolResult;
		const jsonStr = typeof result === 'string' ? result : result.output;
		return JSON.parse(jsonStr) as SecretscanResult | SecretscanErrorResult;
	} catch (e) {
		const errorResult: SecretscanErrorResult = {
			error:
				e instanceof Error
					? `scan failed: ${e.message}`
					: 'scan failed: unknown error',
			scan_dir: directory,
			findings: [],
			count: 0,
			files_scanned: 0,
			skipped_files: 0,
		};
		return errorResult;
	}
}

/**
 * Run secretscan over an explicit, already-selected file set.
 * Used by pre_check_batch so changed-file hard gates share the same detector
 * registry and entropy logic as the standalone scanner.
 */
export async function runSecretscanOnFiles(
	files: string[],
	directory: string,
): Promise<SecretscanResult | SecretscanErrorResult> {
	try {
		const findings: SecretFinding[] = [];
		let filesScanned = 0;
		let skippedFiles = 0;
		const incompletePaths: IncompletePath[] = [];
		const rawRoot = path.resolve(directory);
		const canonicalRoot = (() => {
			try {
				return fs.realpathSync(rawRoot);
			} catch {
				return rawRoot;
			}
		})();
		let rootStat: fs.Stats;
		try {
			rootStat = fs.lstatSync(canonicalRoot);
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			return {
				error:
					err.code === 'ENOENT'
						? 'directory not found'
						: `scan failed: ${err.message || 'unable to inspect directory'}`,
				scan_dir: directory,
				findings: [],
				count: 0,
				files_scanned: 0,
				skipped_files: 0,
			};
		}
		if (!rootStat.isDirectory()) {
			throw new Error('target must be a directory');
		}
		const filesToScan = files.slice(0, MAX_EXPLICIT_FILES_SCANNED);
		let incompleteFiles = Math.max(0, files.length - filesToScan.length);
		if (files.length > filesToScan.length) {
			recordIncompletePath(
				incompletePaths,
				canonicalRoot,
				canonicalRoot,
				'max_files',
			);
		}
		const deadline = _internals.now() + SCAN_TIME_BUDGET_MS;
		await _internals.yieldToEventLoop();

		for (let index = 0; index < filesToScan.length; index++) {
			if (_internals.now() >= deadline) {
				for (const remaining of filesToScan.slice(index)) {
					const remainingPath = path.isAbsolute(remaining)
						? path.resolve(remaining)
						: path.resolve(rawRoot, remaining);
					recordIncompletePath(
						incompletePaths,
						canonicalRoot,
						remainingPath,
						'deadline',
					);
				}
				incompleteFiles += filesToScan.length - index;
				break;
			}
			if (findings.length >= MAX_FINDINGS) {
				recordIncompletePath(
					incompletePaths,
					canonicalRoot,
					canonicalRoot,
					'truncated',
				);
				incompleteFiles += filesToScan.length - index;
				break;
			}

			const file = filesToScan[index];
			if (typeof file !== 'string') {
				skippedFiles++;
				continue;
			}

			const resolvedPath = path.isAbsolute(file)
				? path.resolve(file)
				: path.resolve(rawRoot, file);

			if (!isPathWithinScope(resolvedPath, rawRoot)) {
				skippedFiles++;
				incompleteFiles++;
				recordIncompletePath(
					incompletePaths,
					canonicalRoot,
					resolvedPath,
					'scope_escape',
				);
				continue;
			}

			let lstat: fs.BigIntStats;
			try {
				lstat = _internals.lstatFile(resolvedPath);
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				if (err.code === 'ENOENT') {
					skippedFiles++;
					continue;
				}
				skippedFiles++;
				incompleteFiles++;
				recordIncompletePath(
					incompletePaths,
					canonicalRoot,
					resolvedPath,
					'read_error',
				);
				continue;
			}

			if (lstat.isSymbolicLink()) {
				skippedFiles++;
				incompleteFiles++;
				recordIncompletePath(
					incompletePaths,
					canonicalRoot,
					resolvedPath,
					'symlink',
				);
				continue;
			}

			if (!lstat.isFile()) {
				skippedFiles++;
				incompleteFiles++;
				recordIncompletePath(
					incompletePaths,
					canonicalRoot,
					resolvedPath,
					'non_file',
				);
				continue;
			}

			const ext = path.extname(resolvedPath).toLowerCase();
			if (DEFAULT_EXCLUDE_EXTENSIONS.has(ext)) {
				skippedFiles++;
				continue;
			}

			let scanPath = resolvedPath;
			try {
				scanPath = fs.realpathSync(resolvedPath);
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				if (err.code === 'ENOENT') {
					skippedFiles++;
					continue;
				}
				skippedFiles++;
				incompleteFiles++;
				recordIncompletePath(
					incompletePaths,
					canonicalRoot,
					resolvedPath,
					'read_error',
				);
				continue;
			}
			if (!isPathWithinScope(scanPath, canonicalRoot)) {
				skippedFiles++;
				incompleteFiles++;
				recordIncompletePath(
					incompletePaths,
					canonicalRoot,
					scanPath,
					'scope_escape',
				);
				continue;
			}

			const outcome = scanFileForSecrets(scanPath, 'explicit');
			switch (outcome.status) {
				case 'scanned':
					filesScanned++;
					findings.push(...outcome.findings);
					if (findings.length > MAX_FINDINGS) findings.length = MAX_FINDINGS;
					break;
				case 'skipped':
					skippedFiles++;
					break;
				case 'incomplete':
					skippedFiles++;
					incompleteFiles++;
					recordIncompletePath(
						incompletePaths,
						canonicalRoot,
						scanPath,
						outcome.reason,
					);
					break;
				default:
					assertNever(outcome);
			}

			if (index + 1 < filesToScan.length) {
				await _internals.yieldToEventLoop();
			}
		}

		findings.sort((a, b) => {
			if (a.path < b.path) return -1;
			if (a.path > b.path) return 1;
			return a.line - b.line;
		});

		return {
			scan_dir: directory,
			findings,
			count: findings.length,
			files_scanned: filesScanned,
			skipped_files: skippedFiles,
			incomplete_files: incompleteFiles,
			incomplete_paths: incompletePaths,
		};
	} catch (e) {
		return {
			error:
				e instanceof Error
					? `scan failed: ${e.message}`
					: 'scan failed: unknown error',
			scan_dir: directory,
			findings: [],
			count: 0,
			files_scanned: 0,
			skipped_files: 0,
		};
	}
}

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	secretscan: typeof secretscan;
	runSecretscan: typeof runSecretscan;
	runSecretscanOnFiles: typeof runSecretscanOnFiles;
	SECRET_PATTERNS: typeof SECRET_PATTERNS;
	now: () => number;
	yieldToEventLoop: typeof yieldToEventLoop;
	openFile: typeof fs.openSync;
	fstatFile: (fd: number) => fs.BigIntStats;
	readFileChunk: typeof fs.readSync;
	closeFile: typeof fs.closeSync;
	lstatFile: (path: fs.PathLike) => fs.BigIntStats;
	closeDirectory: (directory: fs.Dir) => void;
} = {
	secretscan,
	runSecretscan,
	runSecretscanOnFiles,
	SECRET_PATTERNS,
	now: Date.now,
	yieldToEventLoop,
	openFile: fs.openSync,
	fstatFile: (fd) => fs.fstatSync(fd, { bigint: true }),
	readFileChunk: fs.readSync,
	closeFile: fs.closeSync,
	lstatFile: (path) => fs.lstatSync(path, { bigint: true }),
	closeDirectory: (directory) => directory.closeSync(),
} as const;
