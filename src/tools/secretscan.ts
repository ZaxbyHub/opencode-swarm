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
const MAX_FINDINGS = 100;
const MAX_OUTPUT_BYTES = 512_000; // 512KB max output
const MAX_LINE_LENGTH = 10_000; // Skip lines longer than this
const MAX_CONTENT_BYTES = 50 * 1024; // 50KB per file for scanning (not full file)

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
	message?: string;
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

	// Skip lines that are too long
	if (line.length > MAX_LINE_LENGTH) {
		return results;
	}

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
		/(?:secret|key|token|password|cred|credential)\s*[=:]\s*["']?([a-zA-Z0-9+/=_-]{20,100})["']?/i,
	);
	if (valueMatch && isHighEntropyString(valueMatch[1])) {
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
				redacted: `${valueMatch[0].split('=')[0].trim()}=[HIGH_ENTROPY]`,
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
	if (findings.length === 0) return line;

	// Sort findings by position
	const sorted = [...findings].sort((a, b) => a.matchStart - b.matchStart);

	let result = '';
	let lastEnd = 0;

	for (const finding of sorted) {
		// Add non-secret portion
		result += line.slice(lastEnd, finding.matchStart);
		// Add redacted portion
		result += finding.redacted;
		lastEnd = finding.matchEnd;
	}

	// Add remaining portion
	result += line.slice(lastEnd);

	return result;
}

// O_NOFOLLOW flag for atomic symlink prevention (POSIX only, undefined on Windows)
const O_NOFOLLOW: number | undefined =
	process.platform !== 'win32'
		? (fs.constants as { O_NOFOLLOW: number }).O_NOFOLLOW
		: undefined;

// ============ File Scanning ============
function scanFileForSecrets(filePath: string): SecretFinding[] {
	const findings: SecretFinding[] = [];

	try {
		// Use lstat to check if file is a symlink (defense in depth)
		const lstat = fs.lstatSync(filePath);
		if (lstat.isSymbolicLink()) {
			return findings; // Skip symlinked files
		}

		if (lstat.size > MAX_FILE_SIZE_BYTES) {
			return findings; // Skip oversized files
		}

		// Read file with O_NOFOLLOW to prevent TOCTOU symlink swap
		// On platforms without O_NOFOLLOW, rely on lstat check above
		let buffer: Buffer;
		if (O_NOFOLLOW !== undefined) {
			const fd = fs.openSync(filePath, 'r', O_NOFOLLOW);
			try {
				buffer = fs.readFileSync(fd);
			} finally {
				fs.closeSync(fd);
			}
		} else {
			// Windows fallback: rely on lstat check above
			buffer = fs.readFileSync(filePath);
		}

		// Skip binary files
		if (isBinaryFile(filePath, buffer)) {
			return findings;
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
			return findings;
		}

		// Only scan first MAX_CONTENT_BYTES to bound work
		const scanContent = content.slice(0, MAX_CONTENT_BYTES);
		const lines = scanContent.split('\n');

		for (let i = 0; i < lines.length; i++) {
			const lineResults = scanLineForSecrets(lines[i], i + 1);

			for (const result of lineResults) {
				findings.push({
					path: filePath,
					line: i + 1, // Deterministic: always use current line number
					type: result.type,
					confidence: result.confidence,
					severity: result.severity,
					redacted: result.redacted,
					context: createRedactedContext(lines[i], [result]),
				});
			}
		}
	} catch {
		// Skip files that can't be read
	}

	return findings;
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

function findScannableFiles(
	dir: string,
	excludeExact: Set<string>,
	excludeGlobs: string[],
	scanDir: string,
	visited: VisitedPaths,
	stats: ScanStats = {
		skippedDirs: 0,
		skippedFiles: 0,
		fileErrors: 0,
		symlinkSkipped: 0,
	},
): string[] {
	const files: string[] = [];

	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		stats.fileErrors++;
		return files;
	}

	// Sort for deterministic order (case-insensitive but stable)
	entries.sort((a, b) => {
		const aLower = a.toLowerCase();
		const bLower = b.toLowerCase();
		if (aLower < bLower) return -1;
		if (aLower > bLower) return 1;
		return a.localeCompare(b); // tie-breaker: stable sort
	});

	for (const entry of entries) {
		const fullPath = path.join(dir, entry);
		// Compute forward-slash relative path for glob matching
		const relPath = path.relative(scanDir, fullPath).replace(/\\/g, '/');

		// Skip excluded entries (applies to both files and directories)
		if (isExcluded(entry, relPath, excludeExact, excludeGlobs)) {
			stats.skippedDirs++;
			continue;
		}

		let lstat: fs.Stats;
		try {
			// Use lstat to detect symlinks without following them
			lstat = fs.lstatSync(fullPath);
		} catch {
			stats.fileErrors++;
			continue;
		}

		// Security: Skip symlinks to prevent traversal attacks
		if (lstat.isSymbolicLink()) {
			stats.symlinkSkipped++;
			continue;
		}

		if (lstat.isDirectory()) {
			// Check for directory loops via real path
			let realPath: string;
			try {
				realPath = fs.realpathSync(fullPath);
			} catch {
				stats.fileErrors++;
				continue;
			}

			// Skip if this real path was already visited (symlink loop)
			if (isSymlinkLoop(realPath, visited)) {
				stats.symlinkSkipped++;
				continue;
			}

			// Security: Ensure real path stays within scan scope
			if (!isPathWithinScope(realPath, scanDir)) {
				stats.symlinkSkipped++;
				continue;
			}

			const subFiles = findScannableFiles(
				fullPath,
				excludeExact,
				excludeGlobs,
				scanDir,
				visited,
				stats,
			);
			files.push(...subFiles);
		} else if (lstat.isFile()) {
			const ext = path.extname(fullPath).toLowerCase();
			// Only scan text-like files
			if (!DEFAULT_EXCLUDE_EXTENSIONS.has(ext)) {
				files.push(fullPath);
			} else {
				stats.skippedFiles++;
			}
		}
	}

	return files;
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
			const _scanDirRaw = path.resolve(directory);
			const scanDir = (() => {
				try {
					return fs.realpathSync(_scanDirRaw);
				} catch {
					return _scanDirRaw;
				}
			})();

			// Check if directory exists
			if (!fs.existsSync(scanDir)) {
				const errorResult: SecretscanErrorResult = {
					error: 'directory not found',
					scan_dir: directory,
					findings: [],
					count: 0,
					files_scanned: 0,
					skipped_files: 0,
				};
				return JSON.stringify(errorResult, null, 2);
			}

			const dirStat = fs.statSync(scanDir);
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
			const files = findScannableFiles(
				scanDir,
				excludeExact,
				excludeGlobs,
				scanDir,
				visited,
				stats,
			);

			// Sort for deterministic order (case-insensitive but stable)
			files.sort((a, b) => {
				const aLower = a.toLowerCase();
				const bLower = b.toLowerCase();
				if (aLower < bLower) return -1;
				if (aLower > bLower) return 1;
				return a.localeCompare(b); // tie-breaker: stable sort
			});

			// Limit files to scan
			const filesToScan = files.slice(0, MAX_FILES_SCANNED);

			// Scan files for secrets
			const allFindings: SecretFinding[] = [];
			let filesScanned = 0;
			let skippedFiles = stats.skippedFiles;

			for (const filePath of filesToScan) {
				if (allFindings.length >= MAX_FINDINGS) break;

				const fileFindings = scanFileForSecrets(filePath);

				// Check file size for skipped count
				try {
					const stat = fs.statSync(filePath);
					if (stat.size > MAX_FILE_SIZE_BYTES) {
						skippedFiles++;
						continue;
					}
				} catch {
					// Count as error
				}

				filesScanned++;

				for (const finding of fileFindings) {
					if (allFindings.length >= MAX_FINDINGS) break;
					allFindings.push(finding);
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
			};

			// Add informative message if results were truncated
			const parts: string[] = [];
			if (files.length > MAX_FILES_SCANNED) {
				parts.push(`Found ${files.length} files, scanned ${MAX_FILES_SCANNED}`);
			}
			if (allFindings.length >= MAX_FINDINGS) {
				parts.push(`Results limited to ${MAX_FINDINGS} findings`);
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

			// Check output size
			let jsonOutput = JSON.stringify(result, null, 2);
			if (jsonOutput.length > MAX_OUTPUT_BYTES) {
				// Truncate findings to fit
				const truncatedResult: SecretscanResult = {
					...result,
					findings: result.findings.slice(
						0,
						Math.floor((MAX_OUTPUT_BYTES * 0.8) / 200),
					), // Approximate
					message: 'Output truncated due to size limits.',
				};
				jsonOutput = JSON.stringify(truncatedResult, null, 2);
			}

			return jsonOutput;
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
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	secretscan: typeof secretscan;
	runSecretscan: typeof runSecretscan;
} = {
	secretscan,
	runSecretscan,
} as const;
