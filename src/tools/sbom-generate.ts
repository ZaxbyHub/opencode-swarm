/**
 * SBOM Generate Tool
 *
 * Generates Software Bill of Materials (SBOM) by scanning project
 * for manifest/lock files and generating CycloneDX format output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { saveEvidence } from '../evidence/manager';
import { generateCycloneDX, serializeCycloneDX } from '../sbom/cyclonedx';
import {
	allDetectors,
	detectComponents,
	type SbomComponent,
} from '../sbom/detectors/index';
import { simpleGlobToRegex } from '../utils';
import { createSwarmTool } from './create-tool';

// ============ Constants ============

const DEFAULT_OUTPUT_DIR = '.swarm/evidence/sbom';

// ============ Types ============

export interface SbomGenerateInput {
	/** Scope of the scan: 'changed' for modified files only, 'all' for entire project */
	scope: 'changed' | 'all';
	/** Optional output directory (default: .swarm/evidence/sbom/) */
	output_dir?: string;
	/** Required if scope='changed': list of changed files */
	changed_files?: string[];
}

export interface SbomGenerateResult {
	/** Verdict: 'pass' if SBOM generated successfully, 'skip' if no manifests found */
	verdict: 'pass' | 'skip';
	/** Array of manifest/lock file paths discovered */
	files: string[];
	/** Number of components in the SBOM */
	components_count: number;
	/** Path to the generated SBOM file */
	output_path: string;
}

// ============ Helper Functions ============

/**
 * Find all manifest/lock files in a directory recursively
 */
function findManifestFiles(rootDir: string): string[] {
	const manifestFiles: string[] = [];

	// Get all unique patterns from detectors
	const patterns = [...new Set(allDetectors.flatMap((d) => d.patterns))];

	/**
	 * Recursively search for files matching detector patterns
	 */
	function searchDir(dir: string): void {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);

				// Skip hidden directories and node_modules
				if (
					entry.name.startsWith('.') ||
					entry.name === 'node_modules' ||
					entry.name === 'dist' ||
					entry.name === 'build' ||
					entry.name === 'target'
				) {
					continue;
				}

				if (entry.isDirectory()) {
					searchDir(fullPath);
				} else if (entry.isFile()) {
					// Check if filename matches any detector pattern
					for (const pattern of patterns) {
						if (simpleGlobToRegex(pattern).test(entry.name)) {
							manifestFiles.push(path.relative(rootDir, fullPath));
							break;
						}
					}
				}
			}
		} catch {
			// Permission denied or other error, skip directory
		}
	}

	searchDir(rootDir);
	return manifestFiles;
}

/**
 * Get unique directories containing the given files
 */
function _getUniqueDirectories(files: string[]): string[] {
	const dirs = new Set<string>();
	for (const file of files) {
		dirs.add(path.dirname(file));
	}
	return [...dirs];
}

/**
 * Find manifest files in specific directories only
 */
function findManifestFilesInDirs(
	directories: string[],
	workingDir: string,
): string[] {
	const found: string[] = [];

	// Get all unique patterns from detectors
	const patterns = [...new Set(allDetectors.flatMap((d) => d.patterns))];

	for (const dir of directories) {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);

				if (entry.isFile()) {
					for (const pattern of patterns) {
						if (simpleGlobToRegex(pattern).test(entry.name)) {
							// Return relative path from working directory
							found.push(path.relative(workingDir, fullPath));
							break;
						}
					}
				}
			}
		} catch {
			// Permission denied, skip
		}
	}

	return found;
}

/**
 * Extract directories from changed files, including parent directories
 */
function getDirectoriesFromChangedFiles(
	changedFiles: string[],
	workingDir: string,
): string[] {
	const dirs = new Set<string>();

	for (const file of changedFiles) {
		// Get the directory of the changed file
		let currentDir = path.dirname(file);

		// Add all parent directories up to the root
		while (true) {
			if (currentDir && currentDir !== '.' && currentDir !== path.sep) {
				dirs.add(path.join(workingDir, currentDir));
				// Go up one level
				const parent = path.dirname(currentDir);
				if (parent === currentDir) break; // Reached root
				currentDir = parent;
			} else {
				// For files at root level, add workingDir itself
				dirs.add(workingDir);
				break;
			}
		}
	}

	return [...dirs];
}

/**
 * Ensure output directory exists
 */
function ensureOutputDir(outputDir: string): void {
	try {
		fs.mkdirSync(outputDir, { recursive: true });
	} catch (error) {
		// Directory may already exist
		if (!error || (error as NodeJS.ErrnoException).code !== 'EEXIST') {
			throw error;
		}
	}
}

/**
 * Generate timestamped filename for SBOM
 */
function generateSbomFilename(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	const hours = String(now.getHours()).padStart(2, '0');
	const minutes = String(now.getMinutes()).padStart(2, '0');
	const seconds = String(now.getSeconds()).padStart(2, '0');

	return `sbom-${year}${month}${day}-${hours}${minutes}${seconds}.json`;
}

// ============ Validation ============

function validateArgs(args: unknown): args is SbomGenerateInput {
	if (typeof args !== 'object' || args === null) {
		return false;
	}

	const obj = args as Record<string, unknown>;

	// Required: scope must be 'changed' or 'all'
	if (
		typeof obj.scope !== 'string' ||
		!['changed', 'all'].includes(obj.scope)
	) {
		return false;
	}

	// If scope is 'changed', changed_files is required
	if (obj.scope === 'changed') {
		if (!Array.isArray(obj.changed_files) || obj.changed_files.length === 0) {
			return false;
		}
	}

	// Optional: output_dir must be a string if provided
	if (obj.output_dir !== undefined && typeof obj.output_dir !== 'string') {
		return false;
	}

	// Optional: changed_files must be array of strings if provided
	if (obj.changed_files !== undefined) {
		if (!Array.isArray(obj.changed_files)) {
			return false;
		}
		for (const f of obj.changed_files) {
			if (typeof f !== 'string') {
				return false;
			}
		}
	}

	return true;
}

// ============ Tool Implementation ============

export const sbom_generate: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Generate Software Bill of Materials (SBOM) by scanning project for dependency manifests. Uses CycloneDX format. Supports scanning entire project or only changed files.',
	args: {
		scope: z
			.enum(['changed', 'all'])
			.describe(
				'Scan scope: "changed" for modified files only, "all" for entire project',
			),
		changed_files: z
			.array(z.string())
			.optional()
			.describe('List of changed files (required if scope="changed")'),
		output_dir: z
			.string()
			.optional()
			.describe('Output directory for SBOM (default: .swarm/evidence/sbom/)'),
	},
	async execute(args: unknown, directory: string): Promise<string> {
		// Validate arguments
		if (!validateArgs(args)) {
			const errorResult: SbomGenerateResult = {
				verdict: 'skip',
				files: [],
				components_count: 0,
				output_path: '',
			};
			return JSON.stringify(
				{
					...errorResult,
					error:
						'Invalid arguments: scope is required ("changed" or "all"), and changed_files is required when scope="changed"',
				},
				null,
				2,
			);
		}

		const obj = args as SbomGenerateInput;
		const scope = obj.scope;
		const changedFiles = obj.changed_files;
		const relativeOutputDir = obj.output_dir || DEFAULT_OUTPUT_DIR;

		// Get directory from createSwarmTool
		const workingDir = directory;

		// Resolve output directory against project root so .swarm/ is always created
		// at the project root, not relative to process.cwd()
		const outputDir = path.isAbsolute(relativeOutputDir)
			? relativeOutputDir
			: path.join(workingDir, relativeOutputDir);

		// Find manifest files based on scope
		let manifestFiles: string[] = [];

		if (scope === 'all') {
			// Scan entire project
			manifestFiles = findManifestFiles(workingDir);
		} else if (scope === 'changed' && changedFiles && changedFiles.length > 0) {
			// Only scan directories containing changed files
			const changedDirs = getDirectoriesFromChangedFiles(
				changedFiles,
				workingDir,
			);
			if (changedDirs.length > 0) {
				manifestFiles = findManifestFilesInDirs(changedDirs, workingDir);
			}
		}

		// If no manifests found, return skip verdict
		if (manifestFiles.length === 0) {
			const result: SbomGenerateResult = {
				verdict: 'skip',
				files: [],
				components_count: 0,
				output_path: '',
			};
			return JSON.stringify(result, null, 2);
		}

		// Extract components from each manifest file
		const allComponents: SbomComponent[] = [];
		const processedFiles: string[] = [];

		for (const manifestFile of manifestFiles) {
			try {
				const fullPath = path.isAbsolute(manifestFile)
					? manifestFile
					: path.join(workingDir, manifestFile);

				if (!fs.existsSync(fullPath)) {
					continue;
				}

				const content = fs.readFileSync(fullPath, 'utf-8');
				const components = detectComponents(manifestFile, content);

				// Add to processed files if we found the file (even if no components)
				processedFiles.push(manifestFile);

				if (components.length > 0) {
					allComponents.push(...components);
				}
			} catch {
				// Skip files that can't be read
			}
		}

		// If still no components but have files, still generate (empty BOM is valid)
		// But if no files with components found, check if we should skip
		if (processedFiles.length === 0 && manifestFiles.length > 0) {
			// Files exist but couldn't parse any components - still valid, pass with 0
		}

		// Ensure output directory exists
		ensureOutputDir(outputDir);

		// Generate CycloneDX BOM
		const bom = generateCycloneDX(allComponents);
		const bomJson = serializeCycloneDX(bom);

		// Write to file
		const filename = generateSbomFilename();
		const outputPath = path.join(outputDir, filename);
		fs.writeFileSync(outputPath, bomJson, 'utf-8');

		// Determine verdict
		const verdict = processedFiles.length > 0 ? 'pass' : 'pass';

		// Save evidence
		try {
			const timestamp = new Date().toISOString();
			await saveEvidence(workingDir, 'sbom_generate', {
				task_id: 'sbom_generate',
				type: 'sbom',
				timestamp,
				agent: 'sbom_generate',
				verdict,
				summary: `Generated SBOM with ${allComponents.length} component(s) from ${processedFiles.length} manifest file(s)`,
				components: allComponents.map((c) => ({
					name: c.name,
					version: c.version,
					type: c.type,
					purl: c.purl,
					license: c.license,
				})),
				metadata: {
					timestamp,
					tool: 'sbom_generate',
					tool_version: '6.9.0',
				},
				files: processedFiles,
				components_count: allComponents.length,
				output_path: outputPath,
			});
		} catch (error) {
			// Log warning but don't fail - SBOM file was still written
			console.warn(
				`Warning: Failed to save SBOM evidence: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const result: SbomGenerateResult = {
			verdict,
			files: processedFiles,
			components_count: allComponents.length,
			output_path: outputPath,
		};

		return JSON.stringify(result, null, 2);
	},
});
