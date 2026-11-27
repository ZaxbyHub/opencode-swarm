import { describe, expect, test } from 'bun:test';
import {
	classifyFile,
	classifyFiles,
	type FileZone,
	getZonePolicy,
	type ZoneClassification,
	type ZonePolicy,
} from '../../../src/context/zone-classifier';

describe('classifyFile - production zone', () => {
	test('returns production zone for src/**/*.ts files', () => {
		const result = classifyFile('/project/src/utils/helper.ts');
		expect(result.zone).toBe('production');
		expect(result.confidence).toBe('high');
		expect(result.reason).toContain('src/** or lib/**');
	});

	test('returns production zone for lib/**/*.ts files', () => {
		const result = classifyFile('/project/lib/core/engine.ts');
		expect(result.zone).toBe('production');
		expect(result.confidence).toBe('high');
	});

	test('returns production zone for nested src files', () => {
		const result = classifyFile('/packages/core/src/services/api.ts');
		expect(result.zone).toBe('production');
		expect(result.confidence).toBe('high');
	});

	test('returns production for unknown paths (default)', () => {
		const result = classifyFile('/some/random/path/file.ts');
		expect(result.zone).toBe('production');
		expect(result.confidence).toBe('medium');
		expect(result.reason).toContain('default');
	});

	test('returns production for relative paths without leading slash', () => {
		const result = classifyFile('other/file.ts');
		expect(result.zone).toBe('production');
		expect(result.confidence).toBe('medium');
	});
});

describe('classifyFile - test zone', () => {
	test('returns test zone for test/** files', () => {
		const result = classifyFile('/project/test/unit/helper.test.ts');
		expect(result.zone).toBe('test');
		expect(result.confidence).toBe('high');
		expect(result.reason).toContain('test/**');
	});

	test('returns test zone for tests/** files', () => {
		const result = classifyFile('/project/tests/integration/api.spec.ts');
		expect(result.zone).toBe('test');
		expect(result.confidence).toBe('high');
	});

	test('returns test zone for __tests__/** files', () => {
		const result = classifyFile('/project/src/__tests__/utils.ts');
		expect(result.zone).toBe('test');
		expect(result.confidence).toBe('high');
	});

	test('returns test zone for .test.* files', () => {
		const result = classifyFile('/project/utils.test.ts');
		expect(result.zone).toBe('test');
		expect(result.confidence).toBe('high');
	});

	test('returns test zone for .spec.* files', () => {
		const result = classifyFile('/project/utils.spec.ts');
		expect(result.zone).toBe('test');
		expect(result.confidence).toBe('high');
	});

	test('returns test zone for mocks/** files', () => {
		const result = classifyFile('/project/mocks/api-mock.ts');
		expect(result.zone).toBe('test');
		expect(result.confidence).toBe('high');
	});

	test('returns test zone for .test. files inside src/', () => {
		const result = classifyFile('/project/src/utils/helper.test.ts');
		expect(result.zone).toBe('test');
		expect(result.confidence).toBe('high');
	});

	test('returns test zone for .spec. files inside src/', () => {
		const result = classifyFile('/project/src/services/api.spec.ts');
		expect(result.zone).toBe('test');
		expect(result.confidence).toBe('high');
	});

	test('returns test zone for __tests__ inside src/', () => {
		const result = classifyFile('/project/src/__tests__/index.ts');
		expect(result.zone).toBe('test');
		expect(result.confidence).toBe('high');
	});

	test('returns test zone for mocks inside src/', () => {
		const result = classifyFile('/project/src/mocks/handlers.ts');
		expect(result.zone).toBe('test');
		expect(result.confidence).toBe('high');
	});
});

describe('classifyFile - config zone', () => {
	test('returns config zone for .json files', () => {
		const result = classifyFile('/project/package.json');
		expect(result.zone).toBe('config');
		expect(result.confidence).toBe('high');
		expect(result.reason).toContain('config');
	});

	test('returns config zone for .yaml files', () => {
		const result = classifyFile('/project/config.yaml');
		expect(result.zone).toBe('config');
		expect(result.confidence).toBe('high');
	});

	test('returns config zone for .yml files', () => {
		const result = classifyFile('/project/config.yml');
		expect(result.zone).toBe('config');
		expect(result.confidence).toBe('high');
	});

	test('returns config zone for .toml files', () => {
		const result = classifyFile('/project/pyproject.toml');
		expect(result.zone).toBe('config');
		expect(result.confidence).toBe('high');
	});

	test('returns config zone for .env files', () => {
		const result = classifyFile('/project/.env');
		expect(result.zone).toBe('config');
		expect(result.confidence).toBe('high');
	});

	test('returns config zone for .env.local files', () => {
		const result = classifyFile('/project/.env.local');
		expect(result.zone).toBe('config');
		expect(result.confidence).toBe('high');
	});

	test('returns config zone for biome.json', () => {
		const result = classifyFile('/project/biome.json');
		expect(result.zone).toBe('config');
		expect(result.confidence).toBe('high');
	});

	test('returns config zone for tsconfig.json', () => {
		const result = classifyFile('/project/tsconfig.json');
		expect(result.zone).toBe('config');
		expect(result.confidence).toBe('high');
	});
});

describe('classifyFile - generated zone', () => {
	test('returns generated zone for .wasm files', () => {
		const result = classifyFile('/project/lib/math.wasm');
		expect(result.zone).toBe('generated');
		expect(result.confidence).toBe('high');
	});

	test('returns generated zone for dist/** files', () => {
		const result = classifyFile('/project/dist/bundle.js');
		expect(result.zone).toBe('generated');
		expect(result.confidence).toBe('high');
	});

	test('returns generated zone for build/** files', () => {
		const result = classifyFile('/project/build/output.js');
		expect(result.zone).toBe('generated');
		expect(result.confidence).toBe('high');
	});

	test('returns generated zone for .swarm/checkpoints/** files', () => {
		const result = classifyFile('/project/.swarm/checkpoints/snapshot.json');
		expect(result.zone).toBe('generated');
		expect(result.confidence).toBe('high');
	});
});

describe('classifyFile - state zone (.swarm/ runtime state)', () => {
	test('returns state zone for .swarm/loop run state files (not config)', () => {
		// The 2026-11-23 swarm_communication_debug AUTHORITY_POLICY_DENY wedge:
		// the loop skill instructs the architect to write this file after every
		// gate transition. It must never classify as config (the architect's
		// default blockedZones) — zone blocks cannot be overridden by allows.
		const result = classifyFile(
			'.swarm/loop/mainstream-model-20261121T1646Z/state.json',
		);
		expect(result.zone).toBe('state');
		expect(result.confidence).toBe('high');
	});

	test('the state zone is ONLY .swarm/loop — gate-integrity surfaces keep their base zones (#2703-review F-004)', () => {
		// A blanket `.swarm/ → state` re-zoned the gate-integrity surfaces out
		// of the architect's blockedZones ('config'), re-opening architect
		// writes to evidence bundles, route receipts, full-auto state, session
		// state, and the ledger projections. They must stay in their base
		// classifications so the #894 block keeps biting.
		expect(classifyFile('.swarm/evidence/secretscan.json').zone).toBe('config');
		expect(classifyFile('.swarm/evidence/1.1/evidence.json').zone).toBe(
			'config',
		);
		expect(classifyFile('.swarm/evidence/1.8.json').zone).toBe('config');
		expect(classifyFile('.swarm/pr-review/route-receipts/x.json').zone).toBe(
			'config',
		);
		expect(classifyFile('.swarm/full-auto-state.json').zone).toBe('config');
		expect(classifyFile('.swarm/session/abc.json').zone).toBe('config');
		expect(classifyFile('/project/.swarm/lane-results/x.json').zone).toBe(
			'config',
		);
		expect(classifyFile('.swarm/plan-ledger.jsonl').zone).toBe('production');
		expect(classifyFile('.swarm/background-delegations.jsonl').zone).toBe(
			'production',
		);
	});

	test('keeps .swarm/checkpoints/ in the generated zone (rule order)', () => {
		expect(classifyFile('.swarm/checkpoints/snapshot.json').zone).toBe(
			'generated',
		);
	});

	test('plan projections classify at their base zones; their architect block is exact-path, not zone', () => {
		// .swarm/plan.md/.swarm/plan.json stay architect-blocked through
		// blockedExact — the zone classification must not weaken that, and
		// neither projection needs the state zone for its protection.
		expect(classifyFile('.swarm/plan.json').zone).toBe('config');
		expect(classifyFile('.swarm/plan.md').zone).toBe('production');
	});

	test('project config files outside .swarm/ still classify as config', () => {
		expect(classifyFile('biome.json').zone).toBe('config');
		expect(classifyFile('configs/app.yaml').zone).toBe('config');
		expect(classifyFile('src/tsconfig.json').zone).toBe('config');
	});

	test('getZonePolicy exposes a skip-QA policy for the state zone', () => {
		const policy = getZonePolicy('state');
		expect(policy.qaDepth).toBe('skip');
		expect(policy.lintRequired).toBe(false);
		expect(policy.testRequired).toBe(false);
		expect(policy.reviewRequired).toBe(false);
		expect(policy.securityReviewRequired).toBe(false);
	});
});

describe('classifyFile - docs zone', () => {
	test('returns docs zone for docs/** files', () => {
		const result = classifyFile('/project/docs/guide.md');
		expect(result.zone).toBe('docs');
		expect(result.confidence).toBe('high');
		expect(result.reason).toContain('docs');
	});

	test('returns docs zone for root .md files', () => {
		const result = classifyFile('/project/README.md');
		expect(result.zone).toBe('docs');
		expect(result.confidence).toBe('high');
	});

	test('returns docs zone for CHANGELOG files', () => {
		const result = classifyFile('/project/CHANGELOG.md');
		expect(result.zone).toBe('docs');
		expect(result.confidence).toBe('high');
	});

	test('returns docs zone for LICENSE files', () => {
		const result = classifyFile('/project/LICENSE');
		expect(result.zone).toBe('docs');
		expect(result.confidence).toBe('high');
	});

	test('returns docs zone for README in different cases', () => {
		const result = classifyFile('/project/readme.md');
		expect(result.zone).toBe('docs');
		expect(result.confidence).toBe('high');
	});
});

describe('classifyFile - build zone', () => {
	test('returns build zone for scripts/** files', () => {
		const result = classifyFile('/project/scripts/build.sh');
		expect(result.zone).toBe('build');
		expect(result.confidence).toBe('high');
		expect(result.reason).toContain('build');
	});

	test('returns build zone for Makefile', () => {
		const result = classifyFile('/project/Makefile');
		expect(result.zone).toBe('build');
		expect(result.confidence).toBe('high');
	});

	test('returns build zone for Dockerfile', () => {
		const result = classifyFile('/project/Dockerfile');
		expect(result.zone).toBe('build');
		expect(result.confidence).toBe('high');
	});

	test('returns build zone for Dockerfile.prod', () => {
		const result = classifyFile('/project/Dockerfile.prod');
		expect(result.zone).toBe('build');
		expect(result.confidence).toBe('high');
	});

	test('returns build zone for .github/** files', () => {
		const result = classifyFile('/project/.github/workflows/ci.yml');
		expect(result.zone).toBe('build');
		expect(result.confidence).toBe('high');
	});
});

describe('classifyFiles - batch processing', () => {
	test('processes multiple files and returns correct zones', () => {
		const files = [
			'/project/src/utils/helper.ts',
			'/project/tests/unit/api.test.ts',
			'/project/package.json',
			'/project/dist/bundle.js',
			'/project/docs/guide.md',
			'/project/scripts/build.sh',
		];
		const results = classifyFiles(files);

		expect(results).toHaveLength(6);
		expect(results[0].zone).toBe('production');
		expect(results[1].zone).toBe('test');
		expect(results[2].zone).toBe('config');
		expect(results[3].zone).toBe('generated');
		expect(results[4].zone).toBe('docs');
		expect(results[5].zone).toBe('build');
	});

	test('preserves file path in result', () => {
		const files = ['/project/src/main.ts', '/project/tests/app.spec.ts'];
		const results = classifyFiles(files);

		expect(results[0].filePath).toBe('/project/src/main.ts');
		expect(results[1].filePath).toBe('/project/tests/app.spec.ts');
	});

	test('handles empty array', () => {
		const results = classifyFiles([]);
		expect(results).toHaveLength(0);
	});
});

describe('getZonePolicy - policy per zone', () => {
	test('returns full policy for production zone', () => {
		const policy = getZonePolicy('production');
		expect(policy.qaDepth).toBe('full');
		expect(policy.lintRequired).toBe(true);
		expect(policy.testRequired).toBe(true);
		expect(policy.reviewRequired).toBe(true);
		expect(policy.securityReviewRequired).toBe(true);
	});

	test('returns standard policy for test zone', () => {
		const policy = getZonePolicy('test');
		expect(policy.qaDepth).toBe('standard');
		expect(policy.lintRequired).toBe(true);
		expect(policy.testRequired).toBe(false);
		expect(policy.reviewRequired).toBe(true);
		expect(policy.securityReviewRequired).toBe(false);
	});

	test('returns light policy for config zone', () => {
		const policy = getZonePolicy('config');
		expect(policy.qaDepth).toBe('light');
		expect(policy.lintRequired).toBe(false);
		expect(policy.testRequired).toBe(false);
		expect(policy.reviewRequired).toBe(true);
		expect(policy.securityReviewRequired).toBe(false);
	});

	test('returns skip policy for generated zone', () => {
		const policy = getZonePolicy('generated');
		expect(policy.qaDepth).toBe('skip');
		expect(policy.lintRequired).toBe(false);
		expect(policy.testRequired).toBe(false);
		expect(policy.reviewRequired).toBe(false);
		expect(policy.securityReviewRequired).toBe(false);
	});

	test('returns light policy for docs zone', () => {
		const policy = getZonePolicy('docs');
		expect(policy.qaDepth).toBe('light');
		expect(policy.lintRequired).toBe(false);
		expect(policy.testRequired).toBe(false);
		expect(policy.reviewRequired).toBe(true);
		expect(policy.securityReviewRequired).toBe(false);
	});

	test('returns standard policy for build zone', () => {
		const policy = getZonePolicy('build');
		expect(policy.qaDepth).toBe('standard');
		expect(policy.lintRequired).toBe(false);
		expect(policy.testRequired).toBe(false);
		expect(policy.reviewRequired).toBe(true);
		expect(policy.securityReviewRequired).toBe(false);
	});
});

describe('Cross-platform path handling', () => {
	test('handles Windows backslash paths for src/', () => {
		const result = classifyFile('C:\\project\\src\\utils.ts');
		expect(result.zone).toBe('production');
	});

	test('handles Windows backslash paths for test/', () => {
		const result = classifyFile('C:\\project\\test\\unit\\api.test.ts');
		expect(result.zone).toBe('test');
	});

	test('handles Windows backslash paths for __tests__/', () => {
		const result = classifyFile('C:\\project\\src\\__tests__\\index.ts');
		expect(result.zone).toBe('test');
	});

	test('handles Windows backslash paths for dist/', () => {
		const result = classifyFile('C:\\project\\dist\\bundle.js');
		expect(result.zone).toBe('generated');
	});

	test('handles Windows backslash paths for .env', () => {
		const result = classifyFile('C:\\project\\.env');
		expect(result.zone).toBe('config');
	});

	test('handles Windows backslash paths for docs/', () => {
		const result = classifyFile('C:\\project\\docs\\guide.md');
		expect(result.zone).toBe('docs');
	});

	test('handles Windows backslash paths for scripts/', () => {
		const result = classifyFile('C:\\project\\scripts\\build.ps1');
		expect(result.zone).toBe('build');
	});

	test('handles Windows backslash paths for .github/', () => {
		const result = classifyFile('C:\\project\\.github\\workflows\\ci.yml');
		expect(result.zone).toBe('build');
	});

	test('handles mixed case paths', () => {
		const result = classifyFile('/SRC/UTILS/HELPER.TS');
		expect(result.zone).toBe('production');
	});

	test('handles forward slash paths', () => {
		const result = classifyFile('/home/user/project/src/utils.ts');
		expect(result.zone).toBe('production');
	});
});

describe('ZoneClassification interface structure', () => {
	test('returns proper interface for production', () => {
		const result = classifyFile('/project/src/main.ts');
		expect(result.filePath).toBe('/project/src/main.ts');
		expect(result.zone).toBe('production');
		expect(['high', 'medium']).toContain(result.confidence);
		expect(typeof result.reason).toBe('string');
	});

	test('returns proper interface for test', () => {
		const result = classifyFile('/project/tests/main.test.ts');
		expect(result.filePath).toBe('/project/tests/main.test.ts');
		expect(result.zone).toBe('test');
		expect(result.confidence).toBe('high');
		expect(typeof result.reason).toBe('string');
	});
});
