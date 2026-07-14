/**
 * SBOM Detector Registry and Common Types
 *
 * Provides detectors for extracting dependency information from
 * manifest and lock files across 8 ecosystems.
 */

import { simpleGlobToRegex } from '../../utils';
import { log } from '../../utils/logger.js';

export interface SbomComponent {
	/** Package name */
	name: string;
	/** Package version */
	version: string;
	/** Component type */
	type: 'library' | 'framework' | 'application';
	/** Package URL (PURL) per SPDX spec */
	purl?: string;
	/** Detected license (best effort) */
	license?: string;
}

/** Detector interface for parsing manifest/lock files */
export interface Detector {
	/** Human-readable detector name */
	name: string;
	/** File glob patterns this detector handles */
	patterns: string[];
	/** Parse a file and extract components */
	detect: (filePath: string, content: string) => SbomComponent[];
}

/** Ecosystem identifiers */
export type Ecosystem =
	| 'npm'
	| 'pypi'
	| 'cargo'
	| 'golang'
	| 'maven'
	| 'nuget'
	| 'swift'
	| 'pub';

/** Map of ecosystem to its detectors */
export interface EcosystemDetector {
	ecosystem: Ecosystem;
	detectors: Detector[];
}

/**
 * Generate a Package URL (PURL) per SPDX specification
 * Format: pkg:<type>/<namespace>/<name>@<version>
 */
export function generatePurl(
	ecosystem: Ecosystem,
	name: string,
	version: string,
	namespace?: string,
): string {
	const encodedName = encodeURIComponent(name);
	const encodedVersion = encodeURIComponent(version);

	switch (ecosystem) {
		case 'npm':
			return `pkg:npm/${encodedName}@${encodedVersion}`;
		case 'pypi':
			return `pkg:pypi/${encodedName}@${encodedVersion}`;
		case 'cargo':
			return `pkg:cargo/${encodedName}@${encodedVersion}`;
		case 'golang':
			// Go modules may have namespace (e.g., github.com/org/repo)
			// Note: golang module paths should NOT have their slashes encoded
			if (namespace) {
				return `pkg:golang/${namespace}/${encodedName}@${encodedVersion}`;
			}
			// Standalone module without namespace (rare but possible)
			return `pkg:golang/${encodedName}@${encodedVersion}`;
		case 'maven': {
			// Maven uses group/artifact format
			const group = namespace || 'unknown';
			const encodedGroup = encodeURIComponent(group);
			return `pkg:maven/${encodedGroup}/${encodedName}@${encodedVersion}`;
		}
		case 'nuget':
			return `pkg:nuget/${encodedName}@${encodedVersion}`;
		case 'swift':
			// Swift packages may have organization prefix
			if (namespace) {
				const encodedOrg = encodeURIComponent(namespace);
				return `pkg:swift/${encodedOrg}/${encodedName}@${encodedVersion}`;
			}
			return `pkg:swift/${encodedName}@${encodedVersion}`;
		case 'pub':
			return `pkg:pub/${encodedName}@${encodedVersion}`;
		default:
			return `pkg:unknown/${encodedName}@${encodedVersion}`;
	}
}

/**
 * Detect ecosystem from file path
 */
export function detectEcosystemFromPath(filePath: string): Ecosystem | null {
	const lowerPath = filePath.toLowerCase();

	if (
		lowerPath.includes('package.json') ||
		lowerPath.includes('package-lock.json') ||
		lowerPath.includes('yarn.lock') ||
		lowerPath.includes('pnpm-lock')
	) {
		return 'npm';
	}

	if (
		lowerPath.includes('requirements.txt') ||
		lowerPath.includes('poetry.lock') ||
		lowerPath.includes('pipfile.lock')
	) {
		return 'pypi';
	}

	if (lowerPath.includes('cargo.lock') || lowerPath.includes('cargo.toml')) {
		return 'cargo';
	}

	if (lowerPath.includes('go.mod') || lowerPath.includes('go.sum')) {
		return 'golang';
	}

	if (lowerPath.includes('pom.xml') || lowerPath.includes('gradle.lockfile')) {
		return 'maven';
	}

	if (
		lowerPath.includes('packages.lock.json') ||
		lowerPath.includes('paket.lock')
	) {
		return 'nuget';
	}

	if (lowerPath.includes('package.resolved')) {
		return 'swift';
	}

	if (
		lowerPath.includes('pubspec.lock') ||
		lowerPath.includes('pubspec.yaml')
	) {
		return 'pub';
	}

	return null;
}

import { dartDetectors } from './dart.js';
import { dotnetDetectors } from './dotnet.js';
import { goDetectors } from './go.js';
import { javaDetectors } from './java.js';
// Import all detectors
import { nodejsDetectors } from './nodejs.js';
import { pythonDetectors } from './python.js';
import { rustDetectors } from './rust.js';
import { swiftDetectors } from './swift.js';

/** All registered detectors */
export const allDetectors: Detector[] = [
	...nodejsDetectors,
	...pythonDetectors,
	...rustDetectors,
	...goDetectors,
	...javaDetectors,
	...dotnetDetectors,
	...swiftDetectors,
	...dartDetectors,
];

/**
 * Find detectors matching a file path
 */
export function findDetectorsForFile(filePath: string): Detector[] {
	const fileName = filePath.split(/[/\\]/).pop() || '';

	return allDetectors.filter((detector) =>
		detector.patterns.some((pattern) =>
			simpleGlobToRegex(pattern).test(fileName),
		),
	);
}

/**
 * Detect components from a file using appropriate detectors
 */
export function detectComponents(
	filePath: string,
	content: string,
): SbomComponent[] {
	const detectors = findDetectorsForFile(filePath);

	// Try each detector until one succeeds
	for (const detector of detectors) {
		try {
			const components = detector.detect(filePath, content);
			if (components.length > 0) {
				return components;
			}
		} catch (error) {
			log(
				`[sbom] Detector failed for ${filePath}:`,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	return [];
}
