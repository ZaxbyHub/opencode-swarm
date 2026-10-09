import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunSpawn } from '../utils/bun-compat';

// ============ Constants ============
const MAX_FILE_SIZE_BYTES = 256 * 1024; // 256KB per file
const DEFAULT_DAYS = 90;
const DEFAULT_TOP_N = 20;
const DEFAULT_EXTENSIONS = 'ts,tsx,js,jsx,py,rs,ps1';

// Shell metacharacters that are not allowed in extensions
const SHELL_METACHAR_REGEX = /[;&|%$`\\]/;

// ============ Types ============
type Recommendation =
	| 'standard'
	| 'enhanced_review'
	| 'security_review'
	| 'full_gates';

export interface HotspotEntry {
	file: string;
	churnCount: number;
	complexity: number;
	riskScore: number;
	recommendation: Recommendation;
}

export interface ComplexityHotspotsResult {
	analyzedFiles: number;
	period: string;
	hotspots: HotspotEntry[];
	summary: {
		fullGates: number;
		securityReview: number;
		enhancedReview: number;
		standard: number;
	};
}

export interface ComplexityHotspotsError {
	error: string;
	analyzedFiles: 0;
	period: string;
	hotspots: [];
	summary: {
		fullGates: 0;
		securityReview: 0;
		enhancedReview: 0;
		standard: 0;
	};
}

// ============ Validation ============
function containsControlChars(str: string): boolean {
	return /[\0\t\r\n]/.test(str);
}

export function validateDays(days: unknown): {
	valid: boolean;
	value: number;
	error: string | null;
} {
	if (typeof days === 'undefined') {
		return { valid: true, value: DEFAULT_DAYS, error: null };
	}

	if (typeof days !== 'number' || !Number.isInteger(days)) {
		return { valid: false, value: 0, error: 'days must be an integer' };
	}

	if (days < 1 || days > 365) {
		return { valid: false, value: 0, error: 'days must be between 1 and 365' };
	}

	return { valid: true, value: days, error: null };
}

export function validateTopN(topN: unknown): {
	valid: boolean;
	value: number;
	error: string | null;
} {
	if (typeof topN === 'undefined') {
		return { valid: true, value: DEFAULT_TOP_N, error: null };
	}

	if (typeof topN !== 'number' || !Number.isInteger(topN)) {
		return { valid: false, value: 0, error: 'top_n must be an integer' };
	}

	if (topN < 1 || topN > 100) {
		return { valid: false, value: 0, error: 'top_n must be between 1 and 100' };
	}

	return { valid: true, value: topN, error: null };
}

export function validateExtensions(extensions: unknown): {
	valid: boolean;
	value: string;
	error: string | null;
} {
	if (typeof extensions === 'undefined') {
		return { valid: true, value: DEFAULT_EXTENSIONS, error: null };
	}

	if (typeof extensions !== 'string') {
		return { valid: false, value: '', error: 'extensions must be a string' };
	}

	if (containsControlChars(extensions)) {
		return {
			valid: false,
			value: '',
			error: 'extensions contains control characters',
		};
	}

	if (SHELL_METACHAR_REGEX.test(extensions)) {
		return {
			valid: false,
			value: '',
			error: 'extensions contains shell metacharacters (;|&%$`\\)',
		};
	}

	// Only allow alphanumeric, commas, and dots
	if (!/^[a-zA-Z0-9,.]+$/.test(extensions)) {
		return {
			valid: false,
			value: '',
			error:
				'extensions contains invalid characters (only alphanumeric, commas, dots allowed)',
		};
	}

	return { valid: true, value: extensions, error: null };
}

// ============ Git Churn Analysis ============
async function getGitChurn(
	days: number,
	directory: string,
): Promise<Map<string, number>> {
	const churnMap = new Map<string, number>();

	const proc = bunSpawn(
		[
			'git',
			'log',
			`--since=${days} days ago`,
			'--name-only',
			'--pretty=format:',
		],
		{
			stdout: 'pipe',
			stderr: 'pipe',
			cwd: directory,
		},
	);

	const stdout = await proc.stdout.text();
	await proc.exited;

	// Split on CRLF for cross-platform handling
	const lines = stdout.split(/\r?\n/);

	for (const line of lines) {
		// Normalize path separators: \ to /
		const normalizedPath = line.replace(/\\/g, '/');

		// Skip empty lines
		if (!normalizedPath || normalizedPath.trim() === '') {
			continue;
		}

		// Skip files in excluded directories
		if (
			normalizedPath.includes('node_modules') ||
			normalizedPath.includes('/.git/') ||
			normalizedPath.includes('/dist/') ||
			normalizedPath.includes('/build/') ||
			normalizedPath.includes('__tests__')
		) {
			continue;
		}

		// Skip test files
		if (
			normalizedPath.includes('.test.') ||
			normalizedPath.includes('.spec.')
		) {
			continue;
		}

		churnMap.set(normalizedPath, (churnMap.get(normalizedPath) || 0) + 1);
	}

	return churnMap;
}

// ============ Complexity Estimation ============
function estimateComplexity(content: string): number {
	// Remove block comments /* ... */
	let processed = content.replace(/\/\*[\s\S]*?\*\//g, '');

	// Remove line comments //
	processed = processed.replace(/\/\/.*/g, '');

	// Remove Python comments #
	processed = processed.replace(/#.*/g, '');

	// Remove single-quoted strings
	processed = processed.replace(/'[^']*'/g, '');

	// Remove double-quoted strings
	processed = processed.replace(/"[^"]*"/g, '');

	// Remove template literals
	processed = processed.replace(/`[^`]*`/g, '');

	let complexity = 1; // Base complexity

	// Count decision points
	const decisionPatterns = [
		/\bif\b/g, // if statements
		/\belse\s+if\b/g, // else if
		/\bfor\b/g, // for loops
		/\bwhile\b/g, // while loops
		/\bswitch\b/g, // switch
		/\bcase\b/g, // case
		/\bcatch\b/g, // catch blocks
		/\?\./g, // optional chaining
		/\?\?/g, // nullish coalescing
		/&&/g, // logical AND
		/\|\|/g, // logical OR
	];

	for (const pattern of decisionPatterns) {
		const matches = processed.match(pattern);
		if (matches) {
			complexity += matches.length;
		}
	}

	// Approximate ternary: ? followed by non-colon (simple heuristic)
	const ternaryMatches = processed.match(/\?[^:]/g);
	if (ternaryMatches) {
		complexity += ternaryMatches.length;
	}

	return complexity;
}

function getComplexityForFile(filePath: string): number | null {
	try {
		const stat = fs.statSync(filePath);

		// Skip files > 256KB
		if (stat.size > MAX_FILE_SIZE_BYTES) {
			return null;
		}

		const content = fs.readFileSync(filePath, 'utf-8');
		return estimateComplexity(content);
	} catch {
		return null;
	}
}

// ============ Main Analysis ============
export async function analyzeHotspots(
	days: number,
	topN: number,
	extensions: string[],
	directory: string,
): Promise<ComplexityHotspotsResult> {
	// Get git churn data
	const churnMap = await getGitChurn(days, directory);

	// Build extension set for filtering
	const extSet = new Set(
		extensions.map((e) => (e.startsWith('.') ? e : `.${e}`)),
	);

	// Filter churn map to only include files with allowed extensions
	const filteredChurn = new Map<string, number>();

	for (const [file, count] of churnMap) {
		const ext = path.extname(file).toLowerCase();
		if (extSet.has(ext)) {
			filteredChurn.set(file, count);
		}
	}

	// Get complexity for each file
	const hotspots: HotspotEntry[] = [];
	const cwd = directory;
	let analyzedFiles = 0;

	for (const [file, churnCount] of filteredChurn) {
		// Try to find the file relative to cwd
		let fullPath = file;
		if (!fs.existsSync(fullPath)) {
			fullPath = path.join(cwd, file);
		}

		const complexity = getComplexityForFile(fullPath);

		if (complexity !== null) {
			analyzedFiles++;

			// Calculate risk score
			const riskScore =
				Math.round(churnCount * Math.log2(Math.max(complexity, 1)) * 10) / 10;

			// Determine recommendation
			let recommendation: Recommendation;
			if (riskScore >= 50) {
				recommendation = 'full_gates';
			} else if (riskScore >= 30) {
				recommendation = 'security_review';
			} else if (riskScore >= 15) {
				recommendation = 'enhanced_review';
			} else {
				recommendation = 'standard';
			}

			hotspots.push({
				file,
				churnCount,
				complexity,
				riskScore,
				recommendation,
			});
		}
	}

	// Sort by risk score descending
	hotspots.sort((a, b) => b.riskScore - a.riskScore);

	// Limit to top N
	const topHotspots = hotspots.slice(0, topN);

	// Count summary
	const summary = {
		fullGates: topHotspots.filter((h) => h.recommendation === 'full_gates')
			.length,
		securityReview: topHotspots.filter(
			(h) => h.recommendation === 'security_review',
		).length,
		enhancedReview: topHotspots.filter(
			(h) => h.recommendation === 'enhanced_review',
		).length,
		standard: topHotspots.filter((h) => h.recommendation === 'standard').length,
	};

	return {
		analyzedFiles,
		period: `${days} days`,
		hotspots: topHotspots,
		summary,
	};
}
