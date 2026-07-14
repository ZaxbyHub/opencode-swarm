#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// Must stay in sync with BUNDLED_PROJECT_SKILLS in src/config/bundled-skills.ts.
// A drift test in tests/unit/scripts/package-smoke.test.ts asserts the two match.
export const REQUIRED_PROJECT_SKILL_SLUGS = [
	'brainstorm',
	'specify',
	'clarify-spec',
	'resume',
	'clarify',
	'discover',
	'consult',
	'pre-phase-briefing',
	'council',
	'deep-dive',
	'deep-research',
	'codebase-review-swarm',
	'swarm-implement',
	'design-docs',
	'swarm-pr-review',
	'swarm',
	'swarm-pr-feedback',
	'swarm-pr-subscribe',
	'swarm-ci-monitor',
	'issue-ingest',
	'plan',
	'critic-gate',
	'execute',
	'phase-wrap',
	'loop',
	'writing-tests',
	'running-tests',
	'engineering-conventions',
	'commit-pr',
	'worktree-retry-cleanup',
	'skill-edit-validation',
	'merge-queue-readiness',
	'gate-attribution',
	'ci-failure-batching',
	'test-file-split',
	'fork-pr-operations',
	'parallel-work-check',
	'ci-fix-monitor',
];

export const REQUIRED_EVALUATION_FIXTURE_IDS = [
	'mutation-off-by-one',
	'null-substitution',
	'operator-swap',
	'guard-removal',
	'branch-swap',
	'side-effect-deletion',
	'curated-off-by-one',
	'missing-await',
	'swallowed-error',
	'injection-prone-string',
	'missing-auth-check',
	'boundary-error',
];

const REQUIRED_PACKAGE_FILES = [
	'dist/index.js',
	'dist/index.d.ts',
	'dist/cli/index.js',
	...REQUIRED_PROJECT_SKILL_SLUGS.map(
		(slug) => `.opencode/skills/${slug}/SKILL.md`,
	),
	...REQUIRED_EVALUATION_FIXTURE_IDS.flatMap((id) => [
		`evaluation-fixtures/tier1/${id}/manifest.json`,
		`evaluation-fixtures/tier1/${id}/instruction.md`,
		`evaluation-fixtures/tier1/${id}/environment/baseline.ts`,
		`evaluation-fixtures/tier1/${id}/environment/defect.ts`,
		`evaluation-fixtures/tier1/${id}/environment/defect.test.ts`,
	]),
	'README.md',
	'LICENSE',
	'package.json',
];

const FORBIDDEN_PACKAGE_PREFIXES = [
	'.github/',
	'.swarm/',
	'src/',
	'tests/unit/',
	'tests/integration/',
	'tests/smoke/',
	'tests/security/',
	'tests/adversarial/',
];

function npmInvocation(args) {
	if (process.platform !== 'win32') {
		return { command: 'npm', args };
	}

	const nodeDir = path.dirname(process.execPath);
	const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
	return {
		command: process.execPath,
		args: [npmCli, ...args],
	};
}

function normalizePackagePath(filePath) {
	return String(filePath).replace(/\\/g, '/').replace(/^package\//, '');
}

function runCommand(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf8',
		timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		maxBuffer: MAX_BUFFER_BYTES,
		windowsHide: true,
	});

	if (result.error) {
		throw new Error(
			`Command failed before exit: ${command} ${args.join(' ')}\n${result.error.message}`,
			{ cause: result.error },
		);
	}
	if (result.status !== 0) {
		const stdout = (result.stdout ?? '').trim();
		const stderr = (result.stderr ?? '').trim();
		throw new Error(
			[
				`Command failed: ${command} ${args.join(' ')}`,
				`exit code: ${result.status}`,
				stdout ? `stdout:\n${stdout}` : '',
				stderr ? `stderr:\n${stderr}` : '',
			]
				.filter(Boolean)
				.join('\n'),
		);
	}

	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

export async function listExpectedGrammarFiles(root = ROOT) {
	const grammarDir = path.join(root, 'src', 'lang', 'grammars');
	const files = await readdir(grammarDir);
	return files
		.filter((file) => file.endsWith('.wasm'))
		.sort()
		.map((file) => `dist/lang/grammars/${file}`);
}

async function listPackageFilesRecursive(
	sourceDir,
	packageDir,
	relativeDir = '',
) {
	const currentSource = path.join(sourceDir, relativeDir);
	const entries = await readdir(currentSource, { withFileTypes: true });
	const files = [];

	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;

		const relativeEntry = path.join(relativeDir, entry.name);
		const packagePath = path.posix.join(
			packageDir,
			...relativeEntry.split(path.sep),
		);
		if (entry.isDirectory()) {
			files.push(
				...(await listPackageFilesRecursive(
					sourceDir,
					packageDir,
					relativeEntry,
				)),
			);
			continue;
		}

		if (entry.isFile()) files.push(packagePath);
	}

	return files;
}

export async function listExpectedProjectSkillFiles(root = ROOT) {
	const skillsRoot = path.join(root, '.opencode', 'skills');
	const files = [];

	for (const slug of REQUIRED_PROJECT_SKILL_SLUGS) {
		const skillDir = path.join(skillsRoot, slug);
		files.push(
			...(await listPackageFilesRecursive(
				skillDir,
				path.posix.join('.opencode/skills', slug),
			)),
		);
	}

	return files.sort();
}

export function validatePackageFiles(
	files,
	expectedGrammarFiles,
	expectedProjectSkillFiles,
) {
	const paths = new Set(files.map((file) => normalizePackagePath(file.path ?? file)));
	const expectedSkillPaths = new Set(expectedProjectSkillFiles);
	const errors = [];

	for (const required of REQUIRED_PACKAGE_FILES) {
		if (!paths.has(required)) {
			errors.push(`missing required package file: ${required}`);
		}
	}

	for (const grammar of expectedGrammarFiles) {
		if (!paths.has(grammar)) {
			errors.push(`missing grammar asset: ${grammar}`);
		}
	}

	for (const skillFile of expectedProjectSkillFiles) {
		if (!paths.has(skillFile)) {
			errors.push(`missing bundled skill package file: ${skillFile}`);
		}
	}

	for (const packagePath of paths) {
		for (const prefix of FORBIDDEN_PACKAGE_PREFIXES) {
			if (packagePath.startsWith(prefix)) {
				errors.push(`unexpected source-only package file: ${packagePath}`);
			}
		}

		if (
			packagePath.startsWith('.opencode/skills/') &&
			!expectedSkillPaths.has(packagePath)
		) {
			errors.push(`unexpected bundled skill package file: ${packagePath}`);
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		paths,
	};
}

function parsePackOutput(stdout) {
	// `npm pack --json` may run the `prepare` lifecycle first, which builds and prints
	// progress to stdout when lifecycle scripts are enabled, so the JSON payload can be
	// preceded by build noise. The payload is a single JSON array and the build output
	// contains no brackets, so slice from the first '[' to the last ']' to isolate it —
	// robust whether or not prepare emits noise.
	const start = stdout.indexOf('[');
	const end = stdout.lastIndexOf(']');
	const jsonText = start >= 0 && end > start ? stdout.slice(start, end + 1) : stdout;
	let parsed;
	try {
		parsed = JSON.parse(jsonText);
	} catch (error) {
		throw new Error(
			`Failed to parse npm pack --json output: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	if (!Array.isArray(parsed) || parsed.length !== 1) {
		throw new Error('npm pack --json did not return exactly one package entry');
	}
	return parsed[0];
}

async function main() {
	const packDir = mkdtempSync(path.join(tmpdir(), 'opencode-swarm-pack-'));
	const installDir = mkdtempSync(path.join(tmpdir(), 'opencode-swarm-install-'));

	try {
		const pack = npmInvocation([
			'pack',
			'--json',
			'--pack-destination',
			packDir,
		]);
		const packResult = runCommand(pack.command, pack.args);
		const packEntry = parsePackOutput(packResult.stdout);
		const expectedGrammarFiles = await listExpectedGrammarFiles(ROOT);
		const expectedProjectSkillFiles = await listExpectedProjectSkillFiles(ROOT);
		const validation = validatePackageFiles(
			packEntry.files ?? [],
			expectedGrammarFiles,
			expectedProjectSkillFiles,
		);

		if (!validation.ok) {
			throw new Error(
				`Package file validation failed:\n${validation.errors.join('\n')}`,
			);
		}

		const tarball = path.resolve(packDir, packEntry.filename);
		writeFileSync(
			path.join(installDir, 'package.json'),
			JSON.stringify({ type: 'module', private: true }, null, 2),
		);

		const install = npmInvocation([
			'install',
			'--ignore-scripts',
			'--no-audit',
			'--no-fund',
			tarball,
		]);
		runCommand(install.command, install.args, { cwd: installDir });

		// Exercise the installed tarball's real plugin-init path, not the source
		// checkout. The package must materialize plugin-owned skills under the
		// collision-safe private runtime root while leaving a repository-owned
		// skill with the same slug byte-for-byte unchanged.
		writeFileSync(
			path.join(installDir, 'materialization-probe.mjs'),
			[
				"import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
				"import path from 'node:path';",
				"import plugin, { loadTier1EvaluationTasks } from 'opencode-swarm';",
				"const projectDir = path.join(process.cwd(), 'probe-project');",
				"const nativePlan = path.join(projectDir, '.opencode', 'skills', 'plan', 'SKILL.md');",
				"const privatePlan = path.join(projectDir, '.swarm', 'bundled-skills', 'plan', 'SKILL.md');",
				"const privateAsset = path.join(projectDir, '.swarm', 'bundled-skills', 'codebase-review-swarm', 'assets', 'jsonl-schemas.md');",
				"const privateParallelWork = path.join(projectDir, '.swarm', 'bundled-skills', 'parallel-work-check', 'SKILL.md');",
				"const privateCiFix = path.join(projectDir, '.swarm', 'bundled-skills', 'ci-fix-monitor', 'SKILL.md');",
				"const packageRoot = path.join(process.cwd(), 'node_modules', 'opencode-swarm');",
				"const packagedPlan = path.join(packageRoot, '.opencode', 'skills', 'plan', 'SKILL.md');",
				"const evaluationTasks = await loadTier1EvaluationTasks(packageRoot);",
				"if (evaluationTasks.length !== 12) throw new Error('packed Tier-1 evaluation fixtures did not resolve');",
				"const sentinel = '---\\nname: plan\\naudience: ragappv3\\ndescription: repository-owned sentinel\\n---\\n';",
				"mkdirSync(path.dirname(nativePlan), { recursive: true });",
				"writeFileSync(nativePlan, sentinel);",
				"const ctx = {",
				"  directory: projectDir,",
				"  project: { id: 'package-smoke', root: projectDir },",
				"  worktree: { directory: projectDir },",
				"  client: { app: {}, config: { get: async () => ({}) } },",
				"  experimental_workspace: { register() {} },",
				"  get serverUrl() { return new URL('http://localhost:4096'); },",
				"  $: undefined,",
				"};",
				"await plugin.server(ctx, {});",
				"const deadline = Date.now() + 10_000;",
				"while ((!existsSync(privatePlan) || !existsSync(privateAsset) || !existsSync(privateParallelWork) || !existsSync(privateCiFix)) && Date.now() < deadline) {",
				"  await new Promise((resolve) => setTimeout(resolve, 25));",
				"}",
				"if (readFileSync(nativePlan, 'utf8') !== sentinel) throw new Error('repository-owned native skill was overwritten');",
				"if (!existsSync(privatePlan)) throw new Error('private bundled plan skill was not materialized');",
				"if (!readFileSync(privatePlan).equals(readFileSync(packagedPlan))) throw new Error('private bundled plan differs from packed source');",
				"if (!existsSync(privateAsset)) throw new Error('nested bundled skill asset was not materialized');",
				"if (!existsSync(privateParallelWork)) throw new Error('parallel-work-check dependency was not materialized');",
				"if (!existsSync(privateCiFix)) throw new Error('ci-fix-monitor dependency was not materialized');",
				"console.log('installed package private skill materialization OK');",
				"process.exit(0);",
			].join('\n'),
		);
		runCommand(process.execPath, ['materialization-probe.mjs'], {
			cwd: installDir,
		});

		// Execute the supported package-level evaluation API from the extracted
		// tarball. This is a real disposable-git-worktree run and verifies that the
		// immutable promotion decision is persisted, not merely exported by name.
		writeFileSync(
			path.join(installDir, 'evaluation-api-probe.mjs'),
			[
				"import { execFileSync } from 'node:child_process';",
				"import { existsSync, mkdirSync, writeFileSync } from 'node:fs';",
				"import path from 'node:path';",
				"import { evaluationV1 } from 'opencode-swarm';",
				"const root = path.join(process.cwd(), 'evaluation-api-project');",
				"mkdirSync(path.join(root, 'fixture'), { recursive: true });",
				"writeFileSync(path.join(root, 'fixture', 'subject.ts'), 'export const value = 1;\\n');",
				"writeFileSync(path.join(root, 'instruction.md'), 'Return a verdict.\\n');",
				"writeFileSync(path.join(root, 'baseline.md'), 'baseline\\n');",
				"writeFileSync(path.join(root, 'candidate.md'), 'candidate\\n');",
				"execFileSync('git', ['init'], { cwd: root, timeout: 30_000, stdio: ['ignore', 'ignore', 'ignore'] });",
				"execFileSync('git', ['add', '.'], { cwd: root, timeout: 30_000, stdio: ['ignore', 'ignore', 'ignore'] });",
				"execFileSync('git', ['-c', 'user.name=Package Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-m', 'fixture'], { cwd: root, timeout: 30_000, stdio: ['ignore', 'ignore', 'ignore'] });",
				"const taskDraft = { v: 1, id: 'package-smoke-task', source: 'curated', split: 'validation', category: 'correctness', protected: true, instructionPath: 'instruction.md', environment: { kind: 'fixture', path: 'fixture' }, scorer: { kind: 'builtin', argv: ['builtin'], timeoutMs: 1000, scoreRange: [0, 1] }, provenance: { origin: 'package-smoke', license: 'MIT' } };",
				"const baselineDraft = { v: 1, id: 'baseline', kind: 'baseline', payloadPath: 'baseline.md', model: 'configured' };",
				"const candidateDraft = { v: 1, id: 'candidate', kind: 'skill', payloadPath: 'candidate.md', model: 'configured' };",
				"const task = { ...taskDraft, contentHash: await evaluationV1.hashTaskInput(root, taskDraft) };",
				"const baseline = { ...baselineDraft, contentHash: await evaluationV1.hashCandidateInput(root, baselineDraft) };",
				"const candidate = { ...candidateDraft, contentHash: await evaluationV1.hashCandidateInput(root, candidateDraft) };",
				"const result = await evaluationV1.evaluateCandidate({ projectRoot: root, tasks: [task], baseline, candidate, split: 'validation', seed: 'package-smoke', models: ['configured'], budgets: { maxTasks: 1, maxRepetitions: 1, maxConcurrency: 2, maxTaskTimeMs: 1000, maxRetries: 0, maxOutputBytes: 1024 }, executor: async () => ({ status: 'completed', text: '{\\\"v\\\":1,\\\"caught\\\":true}', durationMs: 1, cost: { source: 'reported', usd: 0 } }) });",
				"const replay = await evaluationV1.evaluateCandidate({ projectRoot: root, tasks: [task], baseline, candidate, split: 'validation', seed: 'package-smoke', models: ['configured'], budgets: { maxTasks: 1, maxRepetitions: 1, maxConcurrency: 2, maxTaskTimeMs: 1000, maxRetries: 0, maxOutputBytes: 1024 }, executor: async () => ({ status: 'completed', text: '{\\\"v\\\":1,\\\"caught\\\":true}', durationMs: 1, cost: { source: 'reported', usd: 0 } }) });",
				"if (result.run.status !== 'complete') throw new Error('package evaluation run did not complete');",
				"if (!result.decision.decisionId) throw new Error('package evaluation decision missing');",
				"if (replay.decision.decidedAt !== result.decision.decidedAt) throw new Error('package evaluation replay was not idempotent');",
				"const decisionPath = path.join(root, '.swarm', 'evolution', 'decisions', `${result.decision.decisionId}.json`);",
				"if (!existsSync(decisionPath)) throw new Error('package evaluation decision was not persisted');",
				"console.log('installed package evaluation API OK');",
			].join('\n'),
		);
		runCommand(process.execPath, ['evaluation-api-probe.mjs'], {
			cwd: installDir,
		});

		runCommand(process.execPath, [
			'--input-type=module',
			'--eval',
			[
				"const mod = await import('opencode-swarm');",
				"if (!mod.default || mod.default.id !== 'opencode-swarm') throw new Error('bad plugin id');",
				"if (typeof mod.default.server !== 'function') throw new Error('missing server function');",
				"console.log('installed package import OK');",
			].join(' '),
		], { cwd: installDir });

		runCommand(process.execPath, [
			'--input-type=module',
			'--eval',
			[
				"try {",
				"  await import('opencode-swarm/cli');",
				"  throw new Error('CLI subpath should not be exported');",
				"} catch (error) {",
				"  if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;",
				"}",
				"console.log('installed package cli subpath not exported OK');",
			].join(' '),
		], { cwd: installDir });

		runCommand('bun', [
			path.join(
				installDir,
				'node_modules',
				'opencode-swarm',
				'dist',
				'cli',
				'index.js',
			),
			'--help',
		], { cwd: installDir });

		console.log(
			`package smoke OK: ${packEntry.filename} (${packEntry.files.length} files)`,
		);
	} finally {
		rmSync(packDir, { recursive: true, force: true });
		rmSync(installDir, { recursive: true, force: true });
	}
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (currentFile === invokedFile) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
