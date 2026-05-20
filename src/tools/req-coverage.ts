/**
 * Requirement coverage tool for analyzing FR requirements against touched files.
 * Reads .swarm/spec.md for FR-### requirements and checks coverage against
 * files touched during a phase via evidence files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { createSwarmTool } from './create-tool';

// ============ Constants ============
const SPEC_FILE = '.swarm/spec.md';
const EVIDENCE_DIR = '.swarm/evidence';
const OBLIGATION_KEYWORDS = ['MUST', 'SHOULD', 'SHALL'] as const;
const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB per file

// ============ Types ============
type ObligationLevel = (typeof OBLIGATION_KEYWORDS)[number];

interface Requirement {
	id: string;
	obligation: ObligationLevel | null;
	text: string;
	status: 'covered' | 'missing';
	filesSearched: string[];
}

interface ReqCoverageResult {
	success: boolean;
	phase: number;
	totalRequirements: number;
	coveredCount: number;
	missingCount: number;
	requirements: Requirement[];
}

interface RequirementMatch {
	id: string;
	obligation: ObligationLevel | null;
	text: string;
}

// ============ Parsing ============
/**
 * Extract all FR-### requirements from spec content.
 * For each requirement, identifies obligation level (MUST/SHOULD/SHALL) and text.
 */
export function extractRequirements(specContent: string): RequirementMatch[] {
	const requirements: RequirementMatch[] = [];

	// Split content into lines for analysis
	const lines = specContent.split('\n');

	// Match FR-XXX at start of line or after bullet markers
	const frLineRegex = /^\s*[-*]?\s*(FR-\d{3})\s*[:.\-)]\s*(.+)/gi;
	// Also match inline FR references: "FR-001 ... MUST ..."
	const frInlineRegex =
		/\b(FR-\d{3})\b[^.!?]*?(MUST|SHOULD|SHALL)[^.!?]*[.!?]?/gi;

	for (const line of lines) {
		// Check for FR requirement at start of line
		const lineMatchResults = [...line.matchAll(frLineRegex)];
		if (lineMatchResults.length > 0) {
			const lineMatch = lineMatchResults[0];
			const id = lineMatch[1].toUpperCase();
			const restOfLine = lineMatch[2];

			// Extract obligation and text
			const extracted = extractObligationAndText(id, restOfLine);
			if (extracted) {
				requirements.push(extracted);
			}
			continue;
		}

		// Check for inline FR references
		for (const inlineMatch of line.matchAll(frInlineRegex)) {
			const id = inlineMatch[1].toUpperCase();
			const matchedText = inlineMatch[0];

			// Check if we already have this requirement
			if (!requirements.some((r) => r.id === id)) {
				const extracted = extractObligationAndText(id, matchedText);
				if (extracted) {
					requirements.push(extracted);
				}
			}
		}
	}

	return requirements;
}

/**
 * Extract obligation level (MUST/SHOULD/SHALL) and requirement text from a line.
 */
export function extractObligationAndText(
	id: string,
	lineText: string,
): RequirementMatch | null {
	// Look for MUST/SHOULD/SHALL in the text
	let obligation: ObligationLevel | null = null;
	let text = lineText.trim();

	// Find the obligation keyword
	for (const keyword of OBLIGATION_KEYWORDS) {
		const regex = new RegExp(`\\b${keyword}\\b`, 'i');
		if (regex.test(text)) {
			obligation = keyword;
			break;
		}
	}

	// Clean up the text - remove the obligation keyword if found
	if (obligation) {
		const obligationRegex = new RegExp(`\\b${obligation}\\b`, 'i');
		text = text.replace(obligationRegex, '').replace(/\s+/g, ' ').trim();
	}

	// Remove leading punctuation
	text = text.replace(/^[:\-.)\s]+/, '').trim();

	if (!text) {
		return null;
	}

	return { id, obligation, text };
}

// ============ Evidence Reading ============
/**
 * Task ID validation pattern: strict N.M or N.M.P numeric format for phase membership.
 * Used to filter evidence directories that belong to a specific phase.
 */
const PHASE_TASK_ID_REGEX = /^\d+\.\d+(\.\d+)*$/;

/**
 * Read evidence files from .swarm/evidence/{taskId}/ directory structure.
 * Returns list of source files that were touched during the specified phase.
 * Evidence is stored at .swarm/evidence/<taskId>/evidence.json (e.g., 1.1, 2.3.1).
 * Only directories with numeric task IDs matching the phase prefix are processed.
 */
export function readTouchedFiles(
	evidenceDir: string,
	phase: number,
	cwd: string,
): string[] {
	const touchedFiles = new Set<string>();

	// Check if evidence directory exists
	if (!fs.existsSync(evidenceDir) || !fs.statSync(evidenceDir).isDirectory()) {
		return [];
	}

	let entries: string[];
	try {
		entries = fs.readdirSync(evidenceDir);
	} catch {
		return [];
	}

	// Process only directories that match phase prefix (e.g., "1.1" -> phase 1, "2.3.1" -> phase 2)
	for (const entry of entries) {
		const entryPath = path.join(evidenceDir, entry);

		// Skip non-directories (evidence is stored in directories, not files)
		try {
			const stat = fs.statSync(entryPath);
			if (!stat.isDirectory()) {
				continue;
			}
		} catch {
			continue;
		}

		// Filter by phase using first number before the dot
		// Skip non-numeric task IDs (like "sast_scan", "quality_budget", "retro-1")
		if (!PHASE_TASK_ID_REGEX.test(entry)) {
			continue;
		}

		const entryPhase = entry.split('.')[0];
		if (entryPhase !== String(phase)) {
			continue;
		}

		const evidenceFilePath = path.join(entryPath, 'evidence.json');

		// Security check: ensure file is within evidence directory
		try {
			const resolvedPath = path.resolve(evidenceFilePath);
			const evidenceDirResolved = path.resolve(evidenceDir);

			if (!resolvedPath.startsWith(evidenceDirResolved + path.sep)) {
				continue;
			}

			// Check it's a file
			const stat = fs.lstatSync(evidenceFilePath);
			if (!stat.isFile()) {
				continue;
			}

			// Check file size
			if (stat.size > MAX_FILE_SIZE_BYTES) {
				continue;
			}
		} catch {
			continue;
		}

		// Read and parse JSON
		let content: string;
		try {
			content = fs.readFileSync(evidenceFilePath, 'utf-8');
		} catch {
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			continue;
		}

		// Extract touched files from evidence bundle
		// Format: { schema_version, task_id, entries: [{ type: 'diff', files_changed: [...] }] }
		if (parsed && typeof parsed === 'object') {
			const obj = parsed as Record<string, unknown>;

			// Look for entries array
			if (Array.isArray(obj.entries)) {
				for (const entryItem of obj.entries) {
					if (
						entryItem &&
						typeof entryItem === 'object' &&
						(entryItem as Record<string, unknown>).type === 'diff'
					) {
						const diffEntry = entryItem as Record<string, unknown>;
						if (Array.isArray(diffEntry.files_changed)) {
							for (const file of diffEntry.files_changed) {
								if (typeof file === 'string') {
									touchedFiles.add(path.resolve(cwd, file));
								}
							}
						}
					}
				}
			}
		}
	}

	return Array.from(touchedFiles);
}

// ============ Coverage Analysis ============
/**
 * Search a file for keywords from a requirement.
 * Returns true if any keyword is found.
 */
export function searchFileForKeywords(
	filePath: string,
	keywords: string[],
	cwd: string,
): boolean {
	try {
		// Security check: ensure file is within working directory
		const resolvedPath = path.resolve(filePath);
		const cwdResolved = path.resolve(cwd);

		if (!resolvedPath.startsWith(cwdResolved)) {
			return false;
		}

		// Read file content
		const content = fs.readFileSync(resolvedPath, 'utf-8');

		// Search for each keyword (case-insensitive)
		for (const keyword of keywords) {
			const regex = new RegExp(`\\b${keyword}\\b`, 'i');
			if (regex.test(content)) {
				return true;
			}
		}

		return false;
	} catch {
		return false;
	}
}

/**
 * Analyze coverage for a requirement against touched files.
 */
export function analyzeRequirementCoverage(
	requirement: RequirementMatch,
	touchedFiles: string[],
	cwd: string,
): Requirement {
	const keywords: string[] = [];

	// Extract significant words from requirement text
	// Filter out common stop words and short words
	const stopWords = new Set([
		'the',
		'a',
		'an',
		'and',
		'or',
		'but',
		'in',
		'on',
		'at',
		'to',
		'for',
		'of',
		'with',
		'by',
		'from',
		'as',
		'is',
		'was',
		'are',
		'be',
		'been',
		'being',
		'have',
		'has',
		'had',
		'do',
		'does',
		'did',
		'will',
		'would',
		'could',
		'should',
		'may',
		'might',
		'must',
		'shall',
		'can',
		'need',
		'that',
		'this',
		'these',
		'those',
		'it',
		'its',
		'they',
		'them',
	]);

	// Extract words (alphanumeric, minimum 4 chars)
	const wordRegex = /\b[a-zA-Z]{4,}\b/g;
	const words = requirement.text.match(wordRegex) || [];

	// Add meaningful words to keywords
	for (const word of words) {
		const lower = word.toLowerCase();
		if (!stopWords.has(lower)) {
			keywords.push(word);
		}
	}

	// Search touched files for keywords
	let foundCount = 0;
	const searchedFiles: string[] = [];

	for (const file of touchedFiles) {
		// Skip non-source files
		if (!file.match(/\.(ts|js|tsx|jsx|py|go|rs|java|c|cpp|h|cs|rb|php)$/i)) {
			continue;
		}

		searchedFiles.push(file);

		if (searchFileForKeywords(file, keywords, cwd)) {
			foundCount++;
		}
	}

	// Categorize coverage
	let status: Requirement['status'];
	if (foundCount >= 1) {
		status = 'covered';
	} else {
		status = 'missing';
	}

	// If no files were searched (no touched files), mark as missing
	if (searchedFiles.length === 0) {
		status = 'missing';
	}

	return {
		id: requirement.id,
		obligation: requirement.obligation,
		text: requirement.text,
		status,
		filesSearched: searchedFiles,
	};
}

// ============ Tool Definition ============
export const req_coverage: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Analyze requirement coverage for FR requirements against touched files. ' +
		'Reads .swarm/spec.md for FR-### requirements and checks coverage against ' +
		'files touched during a phase via evidence files. Produces coverage report.',
	args: {
		phase: z
			.number()
			.int()
			.min(1)
			.describe('The phase number to analyze coverage for'),
		directory: z
			.string()
			.optional()
			.describe('Working directory (defaults to plugin context directory)'),
	},
	async execute(args: unknown, directory: string): Promise<string> {
		// Safe args extraction
		let phase: number;
		let inputDirectory: string | undefined;

		try {
			if (args && typeof args === 'object') {
				const obj = args as Record<string, unknown>;
				phase =
					typeof obj.phase === 'number'
						? obj.phase
						: typeof obj.phase === 'string'
							? Number(obj.phase)
							: NaN;
				inputDirectory =
					typeof obj.directory === 'string' ? obj.directory : undefined;
			} else {
				phase = NaN;
			}
		} catch {
			phase = NaN;
		}

		// Validate phase
		if (Number.isNaN(phase) || phase < 1 || !Number.isFinite(phase)) {
			return JSON.stringify(
				{
					success: false,
					phase: 0,
					totalRequirements: 0,
					coveredCount: 0,
					missingCount: 0,
					requirements: [],
					error: 'Invalid phase number',
				},
				null,
				2,
			);
		}

		// Use input directory if provided, otherwise use directory
		const cwd = inputDirectory || directory;

		// Read spec.md
		const specPath = path.join(cwd, SPEC_FILE);
		let specContent: string;

		try {
			specContent = fs.readFileSync(specPath, 'utf-8');
		} catch (readError) {
			return JSON.stringify(
				{
					success: false,
					phase,
					totalRequirements: 0,
					coveredCount: 0,
					missingCount: 0,
					requirements: [],
					error: `Failed to read spec.md: ${readError instanceof Error ? readError.message : String(readError)}`,
				},
				null,
				2,
			);
		}

		// Extract requirements
		const requirements = extractRequirements(specContent);

		if (requirements.length === 0) {
			return JSON.stringify(
				{
					success: true,
					phase,
					totalRequirements: 0,
					coveredCount: 0,
					missingCount: 0,
					requirements: [],
					message: 'No FR requirements found in spec.md',
				},
				null,
				2,
			);
		}

		// Read touched files from evidence
		const evidenceDir = path.join(cwd, EVIDENCE_DIR);
		const touchedFiles = readTouchedFiles(evidenceDir, phase, cwd);

		// Analyze coverage for each requirement
		const analyzedRequirements: Requirement[] = [];
		let coveredCount = 0;
		let missingCount = 0;

		for (const req of requirements) {
			const analysis = analyzeRequirementCoverage(req, touchedFiles, cwd);
			analyzedRequirements.push(analysis);

			switch (analysis.status) {
				case 'covered':
					coveredCount++;
					break;
				case 'missing':
					missingCount++;
					break;
			}
		}

		// Build result
		const result: ReqCoverageResult = {
			success: true,
			phase,
			totalRequirements: requirements.length,
			coveredCount,
			missingCount,
			requirements: analyzedRequirements,
		};

		// Write report to .swarm/evidence/req-coverage-phase-{N}.json
		const reportFilename = `req-coverage-phase-${phase}.json`;
		const reportPath = path.join(evidenceDir, reportFilename);

		try {
			// Ensure evidence directory exists
			if (!fs.existsSync(evidenceDir)) {
				fs.mkdirSync(evidenceDir, { recursive: true });
			}

			fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf-8');
		} catch (writeError) {
			// Non-blocking - return result even if report write fails
			console.warn(
				`Failed to write coverage report: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
			);
		}

		return JSON.stringify(result, null, 2);
	},
});
