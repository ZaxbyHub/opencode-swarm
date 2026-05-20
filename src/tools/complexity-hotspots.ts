import * as fs from 'node:fs';
import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { estimateCyclomaticComplexity } from '../quality/metrics';
import { bunSpawn } from '../utils/bun-compat';
import { createSwarmTool } from './create-tool';

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

interface HotspotEntry {
	file: string;
	churnCount: number;
	complexity: number;
	riskScore: number;
	recommendation: Recommendation;
}

interface ComplexityHotspotsResult {
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

interface ComplexityHotspotsError {
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
import { containsControlChars } from '../utils/path-security';

function validateDays(days: unknown): {
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

function validateTopN(topN: unknown): {
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

function validateExtensions(extensions: unknown): {
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

	// Read stdout concurrently with process exit to avoid pipe deadlock.
	// git log output can be very large for repos with extensive history.
	const [stdout] = await Promise.all([proc.stdout.text(), proc.exited]);

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

function getComplexityForFile(filePath: string): number | null {
	try {
		const stat = fs.statSync(filePath);

		// Skip files > 256KB
		if (stat.size > MAX_FILE_SIZE_BYTES) {
			return null;
		}

		const content = fs.readFileSync(filePath, 'utf-8');
		return estimateCyclomaticComplexity(content);
	} catch {
		return null;
	}
}

// ============ Main Analysis ============
async function analyzeHotspots(
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

// ============ Tool Definition ============
export const complexity_hotspots: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Identify high-risk code hotspots by combining git churn frequency with cyclomatic complexity estimates. Returns files with their churn count, complexity score, risk score, and recommended review level.',
	args: {
		days: z
			.number()
			.optional()
			.describe(
				'Number of days of git history to analyze (default: 90, valid range: 1-365)',
			),
		top_n: z
			.number()
			.optional()
			.describe(
				'Number of top hotspots to return (default: 20, valid range: 1-100)',
			),
		extensions: z
			.string()
			.optional()
			.describe(
				'Comma-separated extensions to include (default: "ts,tsx,js,jsx,py,rs,ps1")',
			),
	},
	async execute(args: unknown, directory: string): Promise<string> {
		if (
			!directory ||
			typeof directory !== 'string' ||
			directory.trim() === ''
		) {
			const errorResult: ComplexityHotspotsError = {
				error: 'project directory is required but was not provided',
				analyzedFiles: 0,
				period: '0 days',
				hotspots: [],
				summary: {
					fullGates: 0,
					securityReview: 0,
					enhancedReview: 0,
					standard: 0,
				},
			};
			return JSON.stringify(errorResult, null, 2);
		}

		// Safe args extraction
		let daysInput: number | undefined;
		let topNInput: number | undefined;
		let extensionsInput: string | undefined;

		try {
			if (args && typeof args === 'object') {
				const obj = args as Record<string, unknown>;
				daysInput = typeof obj.days === 'number' ? obj.days : undefined;
				topNInput = typeof obj.top_n === 'number' ? obj.top_n : undefined;
				extensionsInput =
					typeof obj.extensions === 'string' ? obj.extensions : undefined;
			}
		} catch {
			// Malicious getter threw
		}

		// Validate days
		const daysValidation = validateDays(daysInput);
		if (!daysValidation.valid) {
			const errorResult: ComplexityHotspotsError = {
				error: `invalid days: ${daysValidation.error}`,
				analyzedFiles: 0,
				period: '0 days',
				hotspots: [],
				summary: {
					fullGates: 0,
					securityReview: 0,
					enhancedReview: 0,
					standard: 0,
				},
			};
			return JSON.stringify(errorResult, null, 2);
		}

		// Validate top_n
		const topNValidation = validateTopN(topNInput);
		if (!topNValidation.valid) {
			const errorResult: ComplexityHotspotsError = {
				error: `invalid top_n: ${topNValidation.error}`,
				analyzedFiles: 0,
				period: '0 days',
				hotspots: [],
				summary: {
					fullGates: 0,
					securityReview: 0,
					enhancedReview: 0,
					standard: 0,
				},
			};
			return JSON.stringify(errorResult, null, 2);
		}

		// Validate extensions
		const extensionsValidation = validateExtensions(extensionsInput);
		if (!extensionsValidation.valid) {
			const errorResult: ComplexityHotspotsError = {
				error: `invalid extensions: ${extensionsValidation.error}`,
				analyzedFiles: 0,
				period: '0 days',
				hotspots: [],
				summary: {
					fullGates: 0,
					securityReview: 0,
					enhancedReview: 0,
					standard: 0,
				},
			};
			return JSON.stringify(errorResult, null, 2);
		}

		const days = daysValidation.value;
		const topN = topNValidation.value;
		const extensions = extensionsValidation.value
			.split(',')
			.map((e) => e.trim());

		try {
			const result = await analyzeHotspots(days, topN, extensions, directory);
			return JSON.stringify(result, null, 2);
		} catch (e) {
			const errorResult: ComplexityHotspotsError = {
				error:
					e instanceof Error
						? `analysis failed: ${e.message}`
						: 'analysis failed: unknown error',
				analyzedFiles: 0,
				period: `${days} days`,
				hotspots: [],
				summary: {
					fullGates: 0,
					securityReview: 0,
					enhancedReview: 0,
					standard: 0,
				},
			};
			return JSON.stringify(errorResult, null, 2);
		}
	},
});
