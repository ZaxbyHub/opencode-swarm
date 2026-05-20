export type FileZone =
	| 'production'
	| 'test'
	| 'config'
	| 'generated'
	| 'docs'
	| 'build';

export interface ZoneClassification {
	filePath: string;
	zone: FileZone;
	confidence: 'high' | 'medium';
	reason: string;
}

export interface ZonePolicy {
	qaDepth: 'full' | 'standard' | 'light' | 'skip';
	lintRequired: boolean;
	testRequired: boolean;
	reviewRequired: boolean;
	securityReviewRequired: boolean;
}

// Classification rules (pattern-based, no LLM)
// Order matters: more specific patterns checked first
export function classifyFile(filePath: string): ZoneClassification {
	const normalized = filePath.toLowerCase().replace(/\\/g, '/');

	// 1. GENERATED (most specific) - .wasm, dist/, build/, .swarm/checkpoints/
	if (
		normalized.endsWith('.wasm') ||
		normalized.startsWith('dist/') ||
		normalized.includes('/dist/') ||
		normalized.startsWith('build/') ||
		normalized.includes('/build/') ||
		normalized.includes('.swarm/checkpoints/')
	) {
		return {
			filePath,
			zone: 'generated',
			confidence: 'high',
			reason: 'path matches generated file patterns',
		};
	}

	// 2. TEST - test files (check before production to catch test files in src/)
	// test: test/**, tests/**, __tests__/**, *.test.*, *.spec.*, **/mocks/**
	// Also test files inside src/
	if (
		normalized.includes('/test/') ||
		normalized.includes('/tests/') ||
		normalized.includes('/__tests__/') ||
		normalized.includes('.test.') ||
		normalized.includes('.spec.') ||
		normalized.includes('/mocks/')
	) {
		return {
			filePath,
			zone: 'test',
			confidence: 'high',
			reason:
				'path matches test/**, tests/**, __tests__/**, *.test.*, *.spec.*, or **/mocks/**',
		};
	}

	// 3. BUILD - scripts/, Makefile, Dockerfile, .github/
	if (
		normalized.includes('/scripts/') ||
		normalized.includes('makefile') ||
		normalized.includes('dockerfile') ||
		normalized.includes('.github/')
	) {
		return {
			filePath,
			zone: 'build',
			confidence: 'high',
			reason: 'path matches build scripts or CI configuration',
		};
	}

	// 4. CONFIG - .json, .yaml, .yml, .toml, .env, biome.json, tsconfig.json
	// But NOT .github files (already checked above)
	if (
		(normalized.endsWith('.json') && !normalized.includes('.github/')) ||
		(normalized.endsWith('.yaml') && !normalized.includes('.github/')) ||
		(normalized.endsWith('.yml') && !normalized.includes('.github/')) ||
		normalized.endsWith('.toml') ||
		normalized.includes('.env') ||
		normalized.endsWith('biome.json') ||
		normalized.endsWith('tsconfig.json')
	) {
		return {
			filePath,
			zone: 'config',
			confidence: 'high',
			reason: 'extension is config file type',
		};
	}

	// 5. DOCS - docs/, .md (in root), README, CHANGELOG, LICENSE
	if (
		normalized.includes('/docs/') ||
		(normalized.endsWith('.md') && !normalized.includes('/')) ||
		normalized.includes('readme') ||
		normalized.includes('changelog') ||
		normalized.includes('license')
	) {
		return {
			filePath,
			zone: 'docs',
			confidence: 'high',
			reason: 'path matches docs/** or documentation files',
		};
	}

	// 6. PRODUCTION - src/, lib/ (fallback)
	if (normalized.includes('/src/') || normalized.includes('/lib/')) {
		return {
			filePath,
			zone: 'production',
			confidence: 'high',
			reason: 'path matches src/** or lib/**',
		};
	}

	// Default fallback
	return {
		filePath,
		zone: 'production',
		confidence: 'medium',
		reason: 'default classification',
	};
}

export function classifyFiles(filePaths: string[]): ZoneClassification[] {
	return filePaths.map(classifyFile);
}

export function getZonePolicy(zone: FileZone): ZonePolicy {
	const policies: Record<FileZone, ZonePolicy> = {
		production: {
			qaDepth: 'full',
			lintRequired: true,
			testRequired: true,
			reviewRequired: true,
			securityReviewRequired: true,
		},
		test: {
			qaDepth: 'standard',
			lintRequired: true,
			testRequired: false, // they ARE the tests
			reviewRequired: true,
			securityReviewRequired: false,
		},
		config: {
			qaDepth: 'light',
			lintRequired: false,
			testRequired: false,
			reviewRequired: true,
			securityReviewRequired: false,
		},
		generated: {
			qaDepth: 'skip',
			lintRequired: false,
			testRequired: false,
			reviewRequired: false,
			securityReviewRequired: false,
		},
		docs: {
			qaDepth: 'light',
			lintRequired: false,
			testRequired: false,
			reviewRequired: true,
			securityReviewRequired: false,
		},
		build: {
			qaDepth: 'standard',
			lintRequired: false,
			testRequired: false,
			reviewRequired: true,
			securityReviewRequired: false,
		},
	};

	return policies[zone];
}
