import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
	readGitTextAtRevision,
	resolveCurrentGitHead,
	resolveCurrentGitHeadAsync,
	resolveExactMergeBase,
	resolveExactMergeBaseAsync,
	resolveGitControlStateDigest,
	resolveGitControlStateDigestAsync,
	resolvePrWorkflowRevisionDigest,
	resolvePrWorkflowRevisionDigestAsync,
} from '../background/workspace-snapshot.js';
import {
	assertCurrentCheckoutHead,
	assertPrFeedbackVerificationSettled,
	recordPrFeedbackStageA,
} from '../hooks/pr-workflow-gate.js';
import { runExternalTool } from '../utils/external-tool-runner.js';
import { createSwarmTool } from './create-tool.js';

const STAGE_A_CATEGORIES = [
	'build',
	'typecheck',
	'lint',
	'diff-check',
	'reproduction',
] as const;
type StageACategory = (typeof STAGE_A_CATEGORIES)[number];
const OPTIONAL_STAGE_A_CATEGORIES = ['build', 'typecheck', 'lint'] as const;
type OptionalStageACategory = (typeof OPTIONAL_STAGE_A_CATEGORIES)[number];
interface StageAObligation {
	id: string;
	category: OptionalStageACategory;
	workingDirectory: string;
	source: string;
	validatorContract?: { path: string; id: string };
}

interface ContractBaseProvenance {
	baseRef: string;
	baseSha: string;
}
const ALWAYS_REQUIRED_CATEGORIES: readonly StageACategory[] = [
	'diff-check',
	'reproduction',
];
const MAX_OUTPUT_BYTES = 64 * 1024;
const BLOCKED_EXECUTABLES = new Set([
	'aws',
	'az',
	'bash',
	'cmd',
	'curl',
	'docker',
	'echo',
	'env',
	'false',
	'ftp',
	'gcloud',
	'gh',
	'git',
	'kubectl',
	'podman',
	'powershell',
	'printf',
	'pwsh',
	'rsync',
	'scp',
	'sh',
	'sleep',
	'ssh',
	'test',
	'true',
	'wget',
	'zsh',
]);
const MUTATING_ARGUMENT =
	/(?:^|[-_:])(publish|deploy|push|upload|login|logout|release|promote|destroy|delete|remove|prune)(?:$|[-_:])/i;

const StageACheckSchema = z
	.object({
		category: z.enum(STAGE_A_CATEGORIES),
		command: z
			.array(z.string().min(1).max(2_000))
			.min(1)
			.max(64)
			.describe('Array-form executable and arguments; no shell string'),
		targets: z
			.array(z.string().trim().min(1).max(500))
			.min(1)
			.max(32)
			.optional()
			.describe(
				'Required for reproduction: exact test path, test name, package, or regression selector present in the command',
			),
		feedback_targets: z
			.array(
				z
					.object({
						feedback_item_id: z.string().trim().min(1).max(120),
						target: z.string().trim().min(1).max(500),
						expected_behavior: z.string().trim().min(8).max(1_000),
					})
					.strict(),
			)
			.min(1)
			.max(128)
			.optional()
			.describe(
				'Required for reproduction: one exact mapping from every immutable feedback item to an executed target and expected post-fix behavior',
			),
		working_directory: z
			.string()
			.trim()
			.min(1)
			.max(500)
			.optional()
			.describe(
				'Repository-relative workspace directory for this concrete validation obligation; defaults to the repository root',
			),
		obligation_id: z
			.string()
			.trim()
			.min(1)
			.max(1_000)
			.optional()
			.describe(
				'Exact controller-discovered workspace/category/source obligation id; required when a category has more than one applicable obligation in a workspace',
			),
		validator_contract: z
			.object({
				path: z.string().trim().min(1).max(500),
				id: z.string().trim().min(1).max(120),
			})
			.strict()
			.optional()
			.describe(
				'Optional exact validator entry from a bounded repository-owned .pr-validation.json contract',
			),
		timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
	})
	.strict();

const RunPrFeedbackStageAArgsSchema = z
	.object({
		pr_head_sha: z.string().trim().min(1).max(80),
		base_ref: z.string().trim().min(1).max(256).optional(),
		base_sha: z.string().trim().min(6).max(80).optional(),
		checks: z.array(StageACheckSchema).min(2).max(258),
	})
	.strict();

const RepositoryValidationContractSchema = z
	.object({
		version: z.literal(1),
		validators: z
			.array(
				z
					.object({
						id: z.string().trim().min(1).max(120),
						category: z.enum(OPTIONAL_STAGE_A_CATEGORIES),
						working_directory: z.string().trim().min(1).max(500).default('.'),
						command: z.array(z.string().min(1).max(2_000)).min(1).max(64),
					})
					.strict(),
			)
			.min(1)
			.max(256),
	})
	.strict()
	.superRefine((value, context) => {
		const seen = new Set<string>();
		for (const [index, validator] of value.validators.entries()) {
			if (seen.has(validator.id)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['validators', index, 'id'],
					message: `duplicate validator id ${validator.id}`,
				});
			}
			seen.add(validator.id);
		}
	});

function failure(message: string, checks: unknown[] = []): string {
	return JSON.stringify({ success: false, message, checks }, null, 2);
}

function isExactDiffCheck(command: readonly string[]): boolean {
	const executable = path.basename(command[0]).toLowerCase();
	return (
		(executable === 'git' || executable === 'git.exe') &&
		command.length === 3 &&
		command[1] === 'diff' &&
		command[2] === '--check'
	);
}

function isPlausibleBuildCommand(
	executable: string,
	args: readonly string[],
): boolean {
	const cleanOnlyPositionals = (
		optionsWithValue: ReadonlySet<string>,
	): boolean => {
		const positionals: string[] = [];
		for (let index = 0; index < args.length; index += 1) {
			const arg = args[index];
			if (optionsWithValue.has(arg)) {
				index += 1;
				continue;
			}
			if (arg.startsWith('-') || arg.startsWith('/')) continue;
			positionals.push(arg.toLowerCase());
		}
		return (
			positionals.length > 0 && positionals.every((arg) => arg === 'clean')
		);
	};
	switch (executable) {
		case 'make':
			return (
				!cleanOnlyPositionals(
					new Set(['-C', '--directory', '-f', '--file', '-I', '--include-dir']),
				) &&
				!args.some((arg) =>
					/^(?:-n|--just-print|--dry-run|--recon|-q|--question|-t|--touch|-p|--print-data-base)$/i.test(
						arg,
					),
				)
			);
		case 'ninja':
			return (
				!cleanOnlyPositionals(new Set(['-C', '-f', '-j', '-k', '-l', '-d'])) &&
				!args.some((arg) => /^(?:-n|--dry-run|-t|--tool)$/i.test(arg))
			);
		case 'cmake':
			if (!args.includes('--build')) return false;
			{
				const targetIndex = args.indexOf('--target');
				if (targetIndex >= 0) {
					const declaredTargets: string[] = [];
					for (let index = targetIndex + 1; index < args.length; index += 1) {
						if (args[index].startsWith('-')) break;
						declaredTargets.push(args[index].toLowerCase());
					}
					if (
						declaredTargets.length > 0 &&
						declaredTargets.every((target) => target === 'clean')
					)
						return false;
				}
			}
			return true;
		case 'msbuild': {
			const targetArgs = args
				.map((arg) => arg.match(/^(?:-|\/)(?:t|target):(.+)$/i)?.[1])
				.filter((value): value is string => Boolean(value));
			if (
				targetArgs.length > 0 &&
				targetArgs
					.flatMap((value) => value.split(/[;,]/))
					.every((target) => target.trim().toLowerCase() === 'clean')
			)
				return false;
			return (
				args.some(
					(arg) =>
						/\.(?:sln|slnx|proj|csproj|fsproj|vbproj)$/i.test(arg) ||
						/^(?:-|\/)(?:t|target):/i.test(arg),
				) &&
				!args.some((arg) =>
					/^(?:-|\/)(?:preprocess|pp|version|ver)(?::|$)/i.test(arg),
				)
			);
		}
		case 'cargo':
			return args[0] === 'build';
		case 'go':
			return (
				args[0] === 'build' && !args.some((arg) => /^-n(?:=.*)?$/i.test(arg))
			);
		case 'dotnet':
		case 'swift':
		case 'stack':
		case 'cabal':
		case 'bazel':
		case 'buck':
			return args[0] === 'build';
		case 'mix':
			return args[0] === 'compile';
		case 'mvn':
		case 'mvnw':
			return args.some((arg) =>
				/^(?:compile|package|verify|install|pre-integration-test|integration-test|post-integration-test)$/i.test(
					arg,
				),
			);
		case 'gradle':
		case 'gradlew':
			return (
				!args.some((arg) => /^(?:-m|--dry-run)(?:=.*)?$/i.test(arg)) &&
				args.some((arg) =>
					/(?:^|:)(?:build|assemble|classes|jar|war|compile[A-Za-z0-9_-]*)(?:$|:)/i.test(
						arg,
					),
				)
			);
		case 'ant':
			return (
				!cleanOnlyPositionals(new Set(['-f', '-file', '-buildfile', '-lib'])) &&
				(args.length === 0 ||
					args.some((arg) => !arg.startsWith('-') && !arg.startsWith('/')))
			);
		case 'swiftc':
			return args.some((arg) => /\.swift$/i.test(arg));
		case 'rustc':
			return args.some((arg) => /\.rs$/i.test(arg));
		case 'xcodebuild':
			return (
				args.some((arg) => arg.toLowerCase() === 'build') &&
				!args.some((arg) =>
					/^-(?:list|showBuildSettings|showdestinations|showsdks|version|help)$/i.test(
						arg,
					),
				)
			);
		default:
			if (
				['python', 'python3'].includes(executable) &&
				((args[0] === '-m' && args[1] === 'build') ||
					(args[0] === 'setup.py' && args.includes('build')))
			) {
				return true;
			}
			return (
				['vite', 'webpack', 'rollup', 'parcel', 'esbuild', 'tsup'].includes(
					executable,
				) && args.some((arg) => arg.toLowerCase() === 'build')
			);
	}
}

function categoryMatchesScriptName(
	category: StageACategory,
	scriptName: string,
): boolean {
	switch (category) {
		case 'build':
			return /(?:^|[:_-])(?:build|compile|package|assemble)(?:$|[:_-])/i.test(
				scriptName,
			);
		case 'typecheck':
			return /(?:type[:_-]*check|check[:_-]*types|types?)(?:$|[:_-])/i.test(
				scriptName,
			);
		case 'lint':
			return /(?:^|[:_-])(?:lint|format[:_-]*check|check[:_-]*format)(?:$|[:_-])/i.test(
				scriptName,
			);
		case 'reproduction':
			return /(?:^|[:_-])(?:test|spec|repro(?:duction)?|regression)(?:$|[:_-])/i.test(
				scriptName,
			);
		case 'diff-check':
			return false;
	}
}

function isPlausiblePackageManagerCommand(
	category: StageACategory,
	executable: string,
	args: readonly string[],
): boolean {
	if (
		args.some((arg) =>
			/^(?:--(?:cwd|filter|prefix|workspace)(?:=|$)|-[CFw](?:$|=))/.test(arg),
		) ||
		(executable === 'yarn' && args.includes('workspace'))
	) {
		return false;
	}
	const optionTakesValue = new Set([
		'--cwd',
		'--filter',
		'--prefix',
		'--workspace',
		'-C',
		'-F',
		'-w',
	]);
	const commandTokens: Array<{ index: number; value: string }> = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (optionTakesValue.has(arg)) {
			index += 1;
			continue;
		}
		if (arg.startsWith('-')) continue;
		commandTokens.push({ index, value: arg.toLowerCase() });
	}
	if (commandTokens.length === 0) return false;
	const firstArgIndex = commandTokens[0].index;
	const first = commandTokens[0].value;
	if (executable === 'npm') {
		const runToken = commandTokens.find(({ value }) =>
			['run', 'run-script'].includes(value),
		);
		if (!runToken) return false;
		const script = commandTokens.find(
			({ index }) => index > runToken.index,
		)?.value;
		return Boolean(script && categoryMatchesScriptName(category, script));
	}
	if (executable === 'bun') {
		if (category === 'build' && first === 'build') return true;
		if (category === 'reproduction' && first === 'test') return true;
		if (first !== 'run') return false;
		const script = args
			.slice(firstArgIndex + 1)
			.find((arg) => !arg.startsWith('-'));
		return Boolean(script && categoryMatchesScriptName(category, script));
	}
	if (executable === 'pnpm' || executable === 'yarn') {
		let script: string | undefined;
		if (executable === 'yarn' && first === 'workspace') {
			const runToken = commandTokens.find(
				({ value }, index) => index >= 2 && value === 'run',
			);
			script = runToken
				? commandTokens.find(({ index }) => index > runToken.index)?.value
				: commandTokens[2]?.value;
		} else {
			const runToken = commandTokens.find(({ value }) => value === 'run');
			script = runToken
				? commandTokens.find(({ index }) => index > runToken.index)?.value
				: commandTokens[0]?.value;
		}
		return Boolean(script && categoryMatchesScriptName(category, script));
	}
	if (executable === 'npx') {
		const invokedArgs = args.slice(firstArgIndex);
		const invokedExecutable = path
			.basename(invokedArgs[0])
			.toLowerCase()
			.replace(/\.(?:exe|cmd|bat)$/, '');
		const invokedToolArgs = invokedArgs.slice(1);
		switch (category) {
			case 'build':
				return (
					['vite', 'webpack', 'rollup', 'parcel', 'esbuild'].includes(
						invokedExecutable,
					) && invokedToolArgs.some((arg) => arg.toLowerCase() === 'build')
				);
			case 'typecheck':
				return isPlausibleTypecheckCommand(
					invokedExecutable,
					invokedToolArgs,
					invokedExecutable,
				);
			case 'lint':
				return isPlausibleLintCommand(
					invokedExecutable,
					invokedToolArgs,
					invokedExecutable,
				);
			case 'reproduction':
				return isPlausibleReproductionCommand(
					invokedExecutable,
					invokedToolArgs,
					invokedExecutable,
					invokedArgs[0],
				);
			case 'diff-check':
				return false;
		}
	}
	return false;
}

function isPlausibleLintCommand(
	executable: string,
	args: readonly string[],
	_directCommandName: string,
): boolean {
	const hasTarget = (from = 0): boolean =>
		args
			.slice(from)
			.some((arg) => !arg.startsWith('-') && !arg.startsWith('/'));
	switch (executable) {
		case 'eslint':
		case 'shellcheck':
		case 'pylint':
		case 'flake8':
		case 'stylelint':
		case 'hadolint':
		case 'ktlint':
		case 'checkstyle':
		case 'cppcheck':
			return hasTarget();
		case 'biome':
			return ['check', 'lint'].includes(args[0]?.toLowerCase()) && hasTarget(1);
		case 'ruff':
			return args[0]?.toLowerCase() === 'check' && hasTarget(1);
		case 'golangci-lint':
			return args[0]?.toLowerCase() === 'run';
		case 'swiftlint':
			return args.length === 0 || args[0]?.toLowerCase() === 'lint';
		case 'rubocop':
			return !args.some((arg) => /^--show-cops(?:=.*)?$/i.test(arg));
		case 'cargo':
			return args[0] === 'clippy';
		case 'dotnet':
			return args[0] === 'format' && args.includes('--verify-no-changes');
		default:
			return false;
	}
}

function outputReportsZeroTests(result: {
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
}): boolean {
	if (result.stdoutTruncated || result.stderrTruncated) return true;
	const output = `${result.stdout}\n${result.stderr}`;
	return /(?:\b(?:ran|running|collected)\s+0\s+(?:tests?|items?)\b|\btests? run:\s*0\b|\b0\s+(?:tests?\s+(?:ran|passed)|pass(?:ed)?|passing|examples?)\b|\bno tests? (?:ran|to run|found|were found|executed|is available)\b|\bno test is available\b|\btests? (?:are|were) skipped\b|\btest\b[^\n]*\bskipped\b|\bNO-SOURCE\b|\[no test files\])/i.test(
		output,
	);
}

function reproductionSelectorValues(command: readonly string[]): Set<string> {
	const runnerVerbs = new Set([
		'run',
		'run-script',
		'test',
		'tests',
		'spec',
		'check',
	]);
	const selectorFlags = new Set([
		'--test-name-pattern',
		'--testNamePattern',
		'--tests',
		'--filter',
		'--grep',
		'-k',
		'-m',
		'-run',
	]);
	const selectors = new Set<string>();
	for (let index = 1; index < command.length; index += 1) {
		const arg = command[index];
		if (selectorFlags.has(arg)) {
			const value = command[index + 1];
			if (value && !value.startsWith('-')) selectors.add(value);
			index += 1;
			continue;
		}
		const assignment = arg.match(
			/^(?:--(?:test-name-pattern|testNamePattern|tests|filter|grep)|-run|-Dtest)=(.+)$/,
		);
		if (assignment?.[1]) {
			selectors.add(assignment[1]);
			continue;
		}
		if (arg.startsWith('-') || arg.startsWith('/')) continue;
		if (runnerVerbs.has(arg.toLowerCase())) continue;
		selectors.add(arg);
	}
	return selectors;
}

function isPlausibleTypecheckCommand(
	executable: string,
	args: readonly string[],
	_directCommandName: string,
): boolean {
	if (executable === 'go') {
		return args[0] === 'vet' && !args.some((arg) => /^-n(?:=.*)?$/i.test(arg));
	}
	if (executable === 'flow') {
		return ['check', 'status', 'focus-check'].includes(args[0]?.toLowerCase());
	}
	if (executable === 'phpstan') {
		return (
			['analyse', 'analyze'].includes(args[0]?.toLowerCase()) &&
			!args.some((arg) => /^--generate-baseline(?:=.*)?$/i.test(arg))
		);
	}
	return (
		/^(?:tsc|pyright|mypy|sorbet|psalm)$/.test(executable) ||
		(executable === 'cargo' && args[0] === 'check') ||
		(executable === 'dotnet' && args[0] === 'build')
	);
}

function isPlausibleReproductionCommand(
	executable: string,
	args: readonly string[],
	_directCommandName: string,
	_commandPath: string,
): boolean {
	if (executable === 'python' || executable === 'python3') {
		return args[0] === '-m' && args[1]?.toLowerCase() === 'pytest';
	}
	if (executable === 'bundle') {
		return args[0] === 'exec' && args[1]?.toLowerCase() === 'rspec';
	}
	if (executable === 'cargo') {
		return (
			args[0] === 'test' ||
			(args[0] === 'nextest' && args[1]?.toLowerCase() === 'run')
		);
	}
	if (executable === 'go') {
		return (
			args[0] === 'test' &&
			!args.some((arg) => /^(?:-c|-list(?:=.*)?)$/i.test(arg))
		);
	}
	if (executable === 'node') return args[0] === '--test';
	if (executable === 'deno') return args[0] === 'test';
	if (executable === 'zig') return args[0] === 'test';
	if (executable === 'meson') return args[0] === 'test';
	if (executable === 'make' || executable === 'ninja') {
		return args.some((arg) => /^(?:test|check|verify|regression)$/i.test(arg));
	}
	if (executable === 'playwright') return args[0] === 'test';
	if (executable === 'dart' || executable === 'flutter') {
		return args[0] === 'test';
	}
	if (executable === 'xcodebuild') {
		return (
			args.some((arg) =>
				['test', 'test-without-building'].includes(arg.toLowerCase()),
			) &&
			!args.some((arg) =>
				/^-(?:list|enumerate-tests|showBuildSettings|showdestinations|showTestPlans|showsdks|version|help)$/i.test(
					arg,
				),
			)
		);
	}
	if (executable === 'cypress') return args[0] === 'run';
	if (
		/^(?:pytest|ctest|rspec|phpunit|vitest|jest|mocha|ava|go-test-sum)$/.test(
			executable,
		)
	) {
		return true;
	}
	if (executable === 'dotnet') return args[0]?.toLowerCase() === 'test';
	if (['mvn', 'mvnw'].includes(executable)) {
		return args.some((arg) =>
			/^(?:test|verify|integration-test|failsafe:integration-test)$/i.test(arg),
		);
	}
	if (['gradle', 'gradlew'].includes(executable)) {
		const invokesExecutableTestTask = args.some((arg) => {
			if (arg.startsWith('-')) return false;
			const task = arg.split(':').filter(Boolean).at(-1) ?? '';
			if (
				/^(?:compile|process|generate|assemble|classes|jar|source|kapt|prepare)/i.test(
					task,
				)
			) {
				return false;
			}
			return (
				task.toLowerCase() === 'test' ||
				(/^test[A-Z0-9_-]/.test(task) && /Test$/.test(task)) ||
				/^[a-z][A-Za-z0-9_-]*Test$/.test(task)
			);
		});
		return (
			!args.some((arg) => /^(?:-m|--dry-run)(?:=.*)?$/i.test(arg)) &&
			invokesExecutableTestTask
		);
	}
	return false;
}

function isPlausibleStageACommand(
	category: StageACategory,
	command: readonly string[],
): boolean {
	if (category === 'diff-check') return isExactDiffCheck(command);
	const executable = path
		.basename(command[0])
		.toLowerCase()
		.replace(/\.(?:exe|cmd|bat)$/, '');
	if (BLOCKED_EXECUTABLES.has(executable)) return false;
	if (
		command
			.slice(1)
			.some((arg) =>
				/^(?:-h|--help|--version|version|help|list|-N|--fixtures(?:-per-test)?|--markers|--trace-config|--cache-show|--list(?:-?(?:tests?|suites|groups))?(?:-xml)?(?:=.*)?|--show-only(?:=.*)?|--print-labels|--listFilesOnly|--noCheck|--no-check|--no-run(?:=.*)?|--test-dry-run(?:=.*)?|--createStub|--createstub|--print-config|--env-info|--show-settings|--show-files|--list-msgs|--generate-rcfile|--show-?config(?:=.*)?|--init|--dry-run(?:=.*)?|--collect-only|--setup-(?:only|plan)|--co|--if-present(?:=.*)?)$/i.test(
					arg,
				),
			)
	) {
		return false;
	}
	if (
		command.slice(1).some((arg) => MUTATING_ARGUMENT.test(arg)) ||
		(['bun', 'node', 'python', 'python3', 'ruby', 'perl', 'npx'].includes(
			executable,
		) &&
			command
				.slice(1)
				.some((arg) => ['-e', '--eval', '-c', '--call'].includes(arg)))
	) {
		return false;
	}
	if (
		category === 'lint' &&
		command.some((arg) =>
			/^(?:--fix(?:-only)?|--write|--apply|--auto-?correct)(?:=.*)?$|^-[aAw]$/.test(
				arg,
			),
		)
	) {
		return false;
	}
	if (
		category === 'reproduction' &&
		(command.some((arg) =>
			/^(?:--passWithNoTests|--allow-no-tests|--collect-only|--list|--dry-run|--only|--todo|--update-snapshot|--bless|--accept|-w|-x(?:.+)?|--exclude-task(?:=.+)?)$/i.test(
				arg,
			),
		) ||
			command.some((arg) =>
				/^-D(?:skipTests|skipITs|maven\.test\.(?:skip|skip\.exec))(?:=true)?$/i.test(
					arg,
				),
			))
	) {
		return false;
	}
	if (
		['npm', 'pnpm', 'yarn'].includes(executable) ||
		(executable === 'bun' && ['build', 'run', 'test'].includes(command[1]))
	) {
		return isPlausiblePackageManagerCommand(
			category,
			executable,
			command.slice(1),
		);
	}
	if (executable === 'npx') {
		return isPlausiblePackageManagerCommand(
			category,
			executable,
			command.slice(1),
		);
	}
	const directCommandName = executable.replace(
		/\.(?:sh|ps1|py|js|mjs|cjs|rb|pl)$/,
		'',
	);
	switch (category) {
		case 'build':
			return isPlausibleBuildCommand(executable, command.slice(1));
		case 'typecheck':
			return isPlausibleTypecheckCommand(
				executable,
				command.slice(1),
				directCommandName,
			);
		case 'lint':
			return isPlausibleLintCommand(
				executable,
				command.slice(1),
				directCommandName,
			);
		case 'reproduction':
			return isPlausibleReproductionCommand(
				executable,
				command.slice(1),
				directCommandName,
				command[0],
			);
	}
}

function readBoundedText(filePath: string): string | undefined {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size > 512 * 1024) return undefined;
		return fs.readFileSync(filePath, 'utf8');
	} catch {
		return undefined;
	}
}

function readPresentRepositoryText(
	directory: string,
	filePath: string,
	label: string,
): string | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw new Error(`BLOCKED: Stage A cannot inspect present ${label}`);
	}
	if (!stat.isFile() || stat.size > 512 * 1024) {
		throw new Error(`BLOCKED: Stage A cannot inspect present ${label}`);
	}
	try {
		const canonicalRoot = fs.realpathSync(path.resolve(directory));
		const canonicalFile = fs.realpathSync(filePath);
		const relative = path.relative(canonicalRoot, canonicalFile);
		if (
			relative === '..' ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		) {
			throw new Error('escaping manifest');
		}
		return fs.readFileSync(canonicalFile, 'utf8');
	} catch {
		throw new Error(`BLOCKED: Stage A cannot inspect present ${label}`);
	}
}

function resolveContainedDirectory(
	directory: string,
	workingDirectory = '.',
): { absolute: string; relative: string } | undefined {
	const root = path.resolve(directory);
	const canonicalRoot = (() => {
		try {
			return fs.realpathSync(root);
		} catch {
			return root;
		}
	})();
	const candidate = path.resolve(root, workingDirectory);
	try {
		if (!fs.statSync(candidate).isDirectory()) return undefined;
		const absolute = fs.realpathSync(candidate);
		const relativePath = path.relative(canonicalRoot, absolute);
		if (
			relativePath === '..' ||
			relativePath.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relativePath)
		) {
			return undefined;
		}
		return {
			absolute,
			relative: relativePath.replaceAll('\\', '/') || '.',
		};
	} catch {
		return undefined;
	}
}

function readRepositoryValidationContract(
	directory: string,
	contractPath: string,
): z.infer<typeof RepositoryValidationContractSchema> | undefined {
	const root = path.resolve(directory);
	const canonicalRoot = (() => {
		try {
			return fs.realpathSync(root);
		} catch {
			return root;
		}
	})();
	const resolved = path.resolve(root, contractPath);
	let canonicalContract: string;
	try {
		canonicalContract = fs.realpathSync(resolved);
	} catch {
		return undefined;
	}
	const relative = path.relative(canonicalRoot, canonicalContract);
	if (
		!relative ||
		relative === '..' ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative) ||
		path.basename(canonicalContract) !== '.pr-validation.json'
	) {
		return undefined;
	}
	const text = readBoundedText(canonicalContract);
	if (!text) return undefined;
	try {
		return RepositoryValidationContractSchema.parse(JSON.parse(text));
	} catch {
		return undefined;
	}
}

async function resolveContractBaseProvenance(
	directory: string,
	prHeadSha: string,
	baseRef: string | undefined,
	baseSha: string | undefined,
): Promise<ContractBaseProvenance | undefined> {
	if (!baseRef && !baseSha) return undefined;
	if (!baseRef || !baseSha) {
		throw new Error(
			'BLOCKED: Stage A contract authorization requires both base_ref and base_sha',
		);
	}
	const resolvedBase = await _internals.resolveExactMergeBaseAsync(
		directory,
		baseRef,
		prHeadSha,
	);
	if (
		!resolvedBase ||
		resolvedBase.toLowerCase() !== baseSha.toLowerCase() ||
		resolvedBase.toLowerCase() === prHeadSha.toLowerCase()
	) {
		throw new Error(
			'Stage A contract authorization requires base_sha to be the immutable merge base of base_ref and pr_head_sha',
		);
	}
	return { baseRef, baseSha: resolvedBase.toLowerCase() };
}

function readTrustedRepositoryValidationContract(
	directory: string,
	contractPath: string,
	provenance: ContractBaseProvenance | undefined,
): z.infer<typeof RepositoryValidationContractSchema> | undefined {
	if (!provenance) return undefined;
	const current = readRepositoryValidationContract(directory, contractPath);
	const currentText = readBoundedText(path.resolve(directory, contractPath));
	const baseText = _internals.readGitTextAtRevision(
		directory,
		provenance.baseSha,
		contractPath.replaceAll('\\', '/').replace(/^\.\//, ''),
	);
	if (!current || !currentText || baseText === null || currentText !== baseText)
		return undefined;
	return current;
}

type StageACheckInput = z.infer<typeof StageACheckSchema>;

function isExactRepositoryContractValidator(
	directory: string,
	check: StageACheckInput,
	provenance: ContractBaseProvenance | undefined,
): boolean {
	if (!check.validator_contract) return false;
	const contract = readTrustedRepositoryValidationContract(
		directory,
		check.validator_contract.path,
		provenance,
	);
	const validator = contract?.validators.find(
		(candidate) => candidate.id === check.validator_contract?.id,
	);
	if (!validator || validator.category !== check.category) return false;
	const requestedDirectory = resolveContainedDirectory(
		directory,
		check.working_directory ?? '.',
	);
	const declaredDirectory = resolveContainedDirectory(
		directory,
		validator.working_directory,
	);
	return (
		Boolean(requestedDirectory && declaredDirectory) &&
		requestedDirectory?.absolute === declaredDirectory?.absolute &&
		validator.command.length === check.command.length &&
		validator.command.every((part, index) => part === check.command[index])
	);
}

function isExactObligationContractAuthorization(
	directory: string,
	obligation: StageAObligation,
	check: StageACheckInput,
	provenance: ContractBaseProvenance | undefined,
): boolean {
	const identity = obligation.validatorContract;
	if (
		!identity ||
		check.validator_contract?.path !== identity.path ||
		check.validator_contract.id !== identity.id
	) {
		return false;
	}
	const contract = readTrustedRepositoryValidationContract(
		directory,
		identity.path,
		provenance,
	);
	const validator = contract?.validators.find(({ id }) => id === identity.id);
	const workspace = resolveContainedDirectory(
		directory,
		obligation.workingDirectory,
	);
	const validatorWorkspace = validator
		? resolveContainedDirectory(directory, validator.working_directory)
		: undefined;
	if (
		!validator ||
		validator.category !== obligation.category ||
		validatorWorkspace?.absolute !== workspace?.absolute
	) {
		return false;
	}
	if (!obligation.source.startsWith('package.json#') || !workspace)
		return false;
	const scriptName = obligation.source.slice('package.json#'.length);
	const packageText = readBoundedText(
		path.join(workspace.absolute, 'package.json'),
	);
	if (!packageText) return false;
	try {
		const script = (
			JSON.parse(packageText) as { scripts?: Record<string, unknown> }
		).scripts?.[scriptName];
		const declared =
			typeof script === 'string'
				? parseSimpleRepositoryScript(script)
				: undefined;
		return Boolean(
			declared &&
				declared.length === validator.command.length &&
				declared.every((part, index) => part === validator.command[index]) &&
				(packageManagerSelectsExactScript(check.command, scriptName) ||
					(declared.length === check.command.length &&
						declared.every((part, index) => part === check.command[index]))),
		);
	} catch {
		return false;
	}
}

function isSafeContractCommand(command: readonly string[]): boolean {
	const executable = path
		.basename(command[0])
		.toLowerCase()
		.replace(/\.(?:exe|cmd|bat)$/, '');
	return (
		!BLOCKED_EXECUTABLES.has(executable) &&
		!command.slice(1).some((arg) => MUTATING_ARGUMENT.test(arg)) &&
		!command.some((arg) =>
			/^(?:-h|--help|--version|help|version|--dry-run|--if-present)$/i.test(
				arg,
			),
		) &&
		!(
			['bun', 'node', 'python', 'python3', 'ruby', 'perl', 'npx'].includes(
				executable,
			) &&
			command
				.slice(1)
				.some((arg) => ['-e', '--eval', '-c', '--call'].includes(arg))
		)
	);
}

function isAllowedRepositoryExecutable(
	directory: string,
	workingDirectory: string,
	executable: string,
	contractValidated: boolean,
): boolean {
	if (!/[\\/]/.test(executable)) return true;
	if (path.isAbsolute(executable)) return false;
	const workspace = resolveContainedDirectory(directory, workingDirectory);
	if (!workspace) return false;
	const resolved = path.resolve(workspace.absolute, executable);
	let canonicalExecutable: string;
	try {
		canonicalExecutable = fs.realpathSync(resolved);
	} catch {
		return false;
	}
	const canonicalRoot = (() => {
		try {
			return fs.realpathSync(path.resolve(directory));
		} catch {
			return path.resolve(directory);
		}
	})();
	const relative = path.relative(canonicalRoot, canonicalExecutable);
	if (
		relative === '..' ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		return false;
	}
	const basename = path
		.basename(canonicalExecutable)
		.toLowerCase()
		.replace(/\.(?:cmd|bat|exe)$/, '');
	if (!contractValidated && !['gradlew', 'mvnw'].includes(basename))
		return false;
	return fs.statSync(canonicalExecutable).isFile();
}

function normalizedExecutable(command: readonly string[]): string {
	return path
		.basename(command[0])
		.toLowerCase()
		.replace(/\.(?:exe|cmd|bat)$/, '');
}

function parseSimpleRepositoryScript(script: string): string[] | undefined {
	if (
		/[;&|><`\r\n]/.test(script) ||
		script.includes('$(') ||
		script.includes('${')
	) {
		return undefined;
	}
	const tokens =
		script.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g)?.map((token) => {
			if (
				(token.startsWith('"') && token.endsWith('"')) ||
				(token.startsWith("'") && token.endsWith("'"))
			) {
				return token.slice(1, -1);
			}
			return token;
		}) ?? [];
	return tokens.length > 0 ? tokens : undefined;
}

function packageManagerSelectedScriptName(
	command: readonly string[],
): string | undefined {
	const executable = normalizedExecutable(command);
	if (!['npm', 'bun', 'pnpm', 'yarn'].includes(executable)) return undefined;
	const positional = command
		.slice(1, command.indexOf('--') >= 0 ? command.indexOf('--') : undefined)
		.filter((arg) => !arg.startsWith('-'));
	if (executable === 'npm') {
		return ['run', 'run-script'].includes(positional[0] ?? '')
			? positional[1]
			: undefined;
	}
	if (executable === 'bun') {
		return positional[0] === 'run' ? positional[1] : undefined;
	}
	return positional[0] === 'run' ? positional[1] : positional[0];
}

function packageManagerSelectsExactScript(
	command: readonly string[],
	scriptName: string,
): boolean {
	return packageManagerSelectedScriptName(command) === scriptName;
}

function isExactRepositoryPackageManagerScript(
	directory: string,
	workingDirectory: string,
	category: StageACategory,
	command: readonly string[],
): boolean {
	const scriptName = packageManagerSelectedScriptName(command);
	const workspace = resolveContainedDirectory(directory, workingDirectory);
	if (
		!scriptName ||
		!workspace ||
		!categoryMatchesScriptName(category, scriptName)
	) {
		return false;
	}
	const packageText = readBoundedText(
		path.join(workspace.absolute, 'package.json'),
	);
	if (!packageText) return false;
	try {
		const script = (
			JSON.parse(packageText) as { scripts?: Record<string, unknown> }
		).scripts?.[scriptName];
		const declared =
			typeof script === 'string'
				? parseSimpleRepositoryScript(script)
				: undefined;
		return Boolean(declared && isPlausibleStageACommand(category, declared));
	} catch {
		return false;
	}
}

function commandMatchesObligationSource(
	directory: string,
	obligation: StageAObligation,
	check: StageACheckInput,
	contractValidated: boolean,
): boolean {
	const executable = normalizedExecutable(check.command);
	const effectiveExecutable =
		executable === 'npx' && check.command[1]
			? path.basename(check.command[1]).toLowerCase()
			: executable;
	const source = obligation.source;
	if (source.includes('.pr-validation.json#')) {
		const separator = source.lastIndexOf('#');
		const contractPath = source.slice(0, separator);
		const validatorId = source.slice(separator + 1);
		return (
			contractValidated &&
			check.validator_contract?.id === validatorId &&
			check.validator_contract?.path
				.replaceAll('\\', '/')
				.replace(/^\.\//, '') === contractPath.replace(/^\.\//, '')
		);
	}
	if (source.startsWith('package.json#')) {
		const scriptName = source.slice('package.json#'.length);
		const workspace = resolveContainedDirectory(
			directory,
			obligation.workingDirectory,
		);
		const packageText = workspace
			? readBoundedText(path.join(workspace.absolute, 'package.json'))
			: undefined;
		if (!packageText) return false;
		try {
			const script = (
				JSON.parse(packageText) as { scripts?: Record<string, unknown> }
			).scripts?.[scriptName];
			const declared =
				typeof script === 'string'
					? parseSimpleRepositoryScript(script)
					: undefined;
			return (
				(Boolean(declared) &&
					declared?.length === check.command.length &&
					declared.every((part, index) => part === check.command[index])) ||
				packageManagerSelectsExactScript(check.command, scriptName)
			);
		} catch {
			return false;
		}
	}
	if (source === 'Cargo.toml') return effectiveExecutable === 'cargo';
	if (source === 'go.mod') return effectiveExecutable === 'go';
	if (source === 'pom.xml')
		return ['mvn', 'mvnw'].includes(effectiveExecutable);
	if (/^build\.gradle(?:\.kts)?$/.test(source)) {
		return ['gradle', 'gradlew'].includes(effectiveExecutable);
	}
	if (/^(?:Makefile|makefile)$/.test(source))
		return effectiveExecutable === 'make';
	if (source === 'CMakeLists.txt') return effectiveExecutable === 'cmake';
	if (source === 'Package.swift')
		return ['swift', 'swiftc'].includes(effectiveExecutable);
	if (source === 'setup.py' || source === 'pyproject.toml#build-system') {
		return ['python', 'python3'].includes(effectiveExecutable);
	}
	if (/\.(?:sln|slnx|csproj|fsproj|vbproj)$/i.test(source)) {
		return ['dotnet', 'msbuild'].includes(effectiveExecutable);
	}
	if (/\.(?:xcodeproj|xcworkspace)$/i.test(source)) {
		return effectiveExecutable === 'xcodebuild';
	}
	const sourceExecutables: Record<string, readonly string[]> = {
		'tsconfig.json': ['tsc'],
		'pyrightconfig.json': ['pyright'],
		'.flowconfig': ['flow'],
		'phpstan.neon': ['phpstan'],
		'phpstan.neon.dist': ['phpstan'],
		'psalm.xml': ['psalm'],
		'psalm.xml.dist': ['psalm'],
		'mypy.ini': ['mypy'],
		'pyproject.toml#mypy': ['mypy'],
		'biome.json': ['biome'],
		'biome.jsonc': ['biome'],
		'ruff.toml': ['ruff'],
		'.ruff.toml': ['ruff'],
		'pyproject.toml#ruff': ['ruff'],
		'.rubocop.yml': ['rubocop'],
		'.swiftlint.yml': ['swiftlint'],
		'.golangci.yml': ['golangci-lint'],
		'.golangci.yaml': ['golangci-lint'],
		'.stylelintrc': ['stylelint'],
		'.stylelintrc.json': ['stylelint'],
	};
	if (/^(?:\.eslintrc|eslint\.config\.)/.test(source)) {
		return effectiveExecutable === 'eslint';
	}
	return sourceExecutables[source]?.includes(effectiveExecutable) ?? false;
}

/** Discover concrete workspace/category/source obligations from bounded local signals. */
function discoverApplicableStageAObligations(
	directory: string,
	contractBase?: ContractBaseProvenance,
): StageAObligation[] {
	const root = path.resolve(directory);
	const canonicalRoot = (() => {
		try {
			return fs.realpathSync(root);
		} catch {
			return root;
		}
	})();
	const candidateRoots: string[] = [];
	const seenRoots = new Set<string>();
	let discoveryOverflow: string | undefined;
	const addCandidateRoot = (candidate: string): void => {
		if (candidateRoots.length >= 256) {
			discoveryOverflow =
				'Stage A repository discovery exceeded 256 contained workspace roots';
			return;
		}
		try {
			if (!fs.statSync(candidate).isDirectory()) return;
			const canonicalCandidate = fs.realpathSync(candidate);
			const relative = path.relative(canonicalRoot, canonicalCandidate);
			if (
				relative.startsWith(`..${path.sep}`) ||
				relative === '..' ||
				path.isAbsolute(relative) ||
				seenRoots.has(canonicalCandidate)
			) {
				return;
			}
			seenRoots.add(canonicalCandidate);
			candidateRoots.push(canonicalCandidate);
		} catch {
			// Missing, unreadable, or escaping workspace roots establish no obligation.
		}
	};
	const addWorkspacePattern = (pattern: string): void => {
		const normalized = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
		if (
			!normalized ||
			normalized.startsWith('!') ||
			path.posix.isAbsolute(normalized) ||
			normalized.split('/').includes('..')
		) {
			discoveryOverflow = `Stage A cannot safely expand declared workspace pattern "${pattern}"`;
			return;
		}
		if (!normalized.includes('*')) {
			addCandidateRoot(path.resolve(root, normalized));
			return;
		}
		const wildcard = normalized.match(/^([^*?[\]]+)\/\*\/?$/);
		if (!wildcard) {
			discoveryOverflow = `Stage A cannot safely expand declared workspace pattern "${pattern}"`;
			return;
		}
		const container = path.resolve(root, wildcard[1]);
		try {
			const entries = fs.readdirSync(container, { withFileTypes: true });
			if (entries.length > 256) {
				discoveryOverflow = `Stage A workspace container ${wildcard[1]} exceeds the 256-entry bounded discovery limit`;
				return;
			}
			for (const entry of entries) {
				if (entry.isDirectory())
					addCandidateRoot(path.join(container, entry.name));
			}
		} catch {
			// A missing workspace container establishes no obligation.
		}
	};

	addCandidateRoot(root);
	for (const containerName of [
		'packages',
		'apps',
		'services',
		'libs',
		'crates',
	]) {
		addWorkspacePattern(`${containerName}/*`);
	}
	const rootPackageText = readPresentRepositoryText(
		canonicalRoot,
		path.join(root, 'package.json'),
		'root package.json workspace declaration',
	);
	if (rootPackageText) {
		try {
			const value = JSON.parse(rootPackageText) as {
				workspaces?: string[] | { packages?: string[] };
			};
			const workspacePatterns = Array.isArray(value.workspaces)
				? value.workspaces
				: value.workspaces?.packages;
			for (const pattern of workspacePatterns ?? []) {
				if (typeof pattern === 'string') addWorkspacePattern(pattern);
			}
		} catch {
			discoveryOverflow =
				'Stage A cannot safely inspect malformed root package.json workspace metadata';
		}
	}
	const pnpmWorkspaceText = readPresentRepositoryText(
		canonicalRoot,
		path.join(root, 'pnpm-workspace.yaml'),
		'pnpm-workspace.yaml declaration',
	);
	for (const match of pnpmWorkspaceText?.matchAll(
		/^\s*-\s*['"]?([^'"#\r\n]+?)['"]?\s*$/gm,
	) ?? []) {
		addWorkspacePattern(match[1]);
	}
	const cargoWorkspaceText = readPresentRepositoryText(
		canonicalRoot,
		path.join(root, 'Cargo.toml'),
		'Cargo.toml workspace declaration',
	);
	const cargoMembers = cargoWorkspaceText?.match(
		/\bmembers\s*=\s*\[([\s\S]*?)\]/m,
	)?.[1];
	for (const match of cargoMembers?.matchAll(/['"]([^'"]+)['"]/g) ?? []) {
		addWorkspacePattern(match[1]);
	}
	const mavenText = readPresentRepositoryText(
		canonicalRoot,
		path.join(root, 'pom.xml'),
		'pom.xml module declaration',
	);
	for (const match of mavenText?.matchAll(
		/<module>\s*([^<]+?)\s*<\/module>/gi,
	) ?? []) {
		addWorkspacePattern(match[1]);
	}
	const goWorkText = readPresentRepositoryText(
		canonicalRoot,
		path.join(root, 'go.work'),
		'go.work workspace declaration',
	);
	for (const match of goWorkText?.matchAll(
		/^\s*(?:use\s+)?(\.\.?\/[^\s/]+(?:\/[^\s]+)*)\s*$/gm,
	) ?? []) {
		addWorkspacePattern(match[1]);
	}
	for (const settingsName of ['settings.gradle', 'settings.gradle.kts']) {
		const settingsText = readPresentRepositoryText(
			canonicalRoot,
			path.join(root, settingsName),
			`${settingsName} workspace declaration`,
		);
		for (const includeMatch of settingsText?.matchAll(
			/\binclude\s*\(?([^\r\n)]+)/g,
		) ?? []) {
			for (const projectMatch of includeMatch[1].matchAll(/['"]:?(.*?)['"]/g)) {
				const projectPath = projectMatch[1].replaceAll(':', '/');
				if (projectPath) addWorkspacePattern(projectPath);
			}
		}
	}
	const obligations = new Map<string, StageAObligation>();
	const addObligation = (
		category: OptionalStageACategory,
		candidateRoot: string,
		source: string,
		validatorContract?: { path: string; id: string },
	): void => {
		const workspace =
			path.relative(canonicalRoot, candidateRoot).replaceAll('\\', '/') || '.';
		const id = `${category}:${workspace}:${source}`;
		if (!obligations.has(id) && obligations.size >= 256) {
			discoveryOverflow =
				'Stage A repository discovery exceeded 256 concrete validation obligations';
			return;
		}
		obligations.set(id, {
			id,
			category,
			workingDirectory: workspace,
			source,
			...(validatorContract ? { validatorContract } : {}),
		});
	};
	const buildFiles = new Set([
		'Cargo.toml',
		'go.mod',
		'pom.xml',
		'build.gradle',
		'build.gradle.kts',
		'Makefile',
		'makefile',
		'CMakeLists.txt',
		'Package.swift',
		'setup.py',
	]);
	const typecheckFiles = new Set([
		'tsconfig.json',
		'pyrightconfig.json',
		'.flowconfig',
		'phpstan.neon',
		'phpstan.neon.dist',
		'psalm.xml',
		'psalm.xml.dist',
		'mypy.ini',
	]);
	const lintFiles = new Set([
		'biome.json',
		'biome.jsonc',
		'.eslintrc',
		'.eslintrc.json',
		'.eslintrc.yaml',
		'.eslintrc.yml',
		'.eslintrc.js',
		'.eslintrc.cjs',
		'.eslintrc.mjs',
		'eslint.config.js',
		'eslint.config.mjs',
		'eslint.config.cjs',
		'eslint.config.ts',
		'ruff.toml',
		'.ruff.toml',
		'.rubocop.yml',
		'.swiftlint.yml',
		'.golangci.yml',
		'.golangci.yaml',
		'.stylelintrc',
		'.stylelintrc.json',
	]);
	for (const candidateRoot of candidateRoots) {
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(candidateRoot, { withFileTypes: true });
			if (entries.length > 2_048) {
				discoveryOverflow = `Stage A workspace ${path.relative(canonicalRoot, candidateRoot) || '.'} exceeds the 2048-entry bounded manifest scan`;
				continue;
			}
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isFile() && buildFiles.has(entry.name))
				addObligation('build', candidateRoot, entry.name);
			if (entry.isFile() && typecheckFiles.has(entry.name))
				addObligation('typecheck', candidateRoot, entry.name);
			if (entry.isFile() && lintFiles.has(entry.name))
				addObligation('lint', candidateRoot, entry.name);
			if (
				entry.isFile() &&
				/\.(?:sln|slnx|csproj|fsproj|vbproj)$/i.test(entry.name)
			)
				addObligation('build', candidateRoot, entry.name);
			if (
				entry.isDirectory() &&
				/\.(?:xcodeproj|xcworkspace)$/i.test(entry.name)
			)
				addObligation('build', candidateRoot, entry.name);
		}
		const contractPath = path.join(candidateRoot, '.pr-validation.json');
		const contractRelative = path
			.relative(canonicalRoot, contractPath)
			.replaceAll('\\', '/');
		const untrustedContract = readRepositoryValidationContract(
			canonicalRoot,
			contractRelative,
		);
		const contract = readTrustedRepositoryValidationContract(
			canonicalRoot,
			contractRelative,
			contractBase,
		);
		if (fs.existsSync(contractPath) && !untrustedContract) {
			discoveryOverflow = `Stage A found an invalid, oversized, unreadable, or escaping validation contract at ${contractRelative}`;
		} else if (untrustedContract && !contract) {
			discoveryOverflow = `Stage A validation contract at ${contractRelative} must be unchanged from the immutable merge base named by base_ref and base_sha`;
		}
		const contractValidatorsCoveredByScripts = new Set<string>();
		const packageText = readPresentRepositoryText(
			canonicalRoot,
			path.join(candidateRoot, 'package.json'),
			`${path.relative(canonicalRoot, candidateRoot).replaceAll('\\', '/') || '.'}/package.json manifest`,
		);
		if (packageText) {
			try {
				const value = JSON.parse(packageText) as {
					scripts?: Record<string, unknown>;
				};
				for (const [script, commandText] of Object.entries(
					value.scripts ?? {},
				)) {
					const declaredCommand =
						typeof commandText === 'string'
							? parseSimpleRepositoryScript(commandText)
							: undefined;
					for (const category of OPTIONAL_STAGE_A_CATEGORIES) {
						if (!categoryMatchesScriptName(category, script)) continue;
						const authorizingValidator = contract?.validators.find(
							(validator) => {
								const validatorWorkspace = resolveContainedDirectory(
									canonicalRoot,
									validator.working_directory,
								);
								return (
									validator.category === category &&
									validatorWorkspace?.absolute === candidateRoot &&
									(!declaredCommand ||
										(declaredCommand.length === validator.command.length &&
											declaredCommand.every(
												(part, index) => part === validator.command[index],
											)))
								);
							},
						);
						if (!declaredCommand) {
							if (!authorizingValidator) {
								discoveryOverflow = `Stage A opaque package script ${path.relative(canonicalRoot, candidateRoot).replaceAll('\\', '/') || '.'}/package.json#${script} requires a trusted base-identical contract validator for ${category}`;
							}
							continue;
						}
						if (
							isPlausibleStageACommand(category, declaredCommand) ||
							Boolean(authorizingValidator)
						) {
							addObligation(
								category,
								candidateRoot,
								`package.json#${script}`,
								authorizingValidator
									? {
											path: contractRelative,
											id: authorizingValidator.id,
										}
									: undefined,
							);
							if (authorizingValidator) {
								contractValidatorsCoveredByScripts.add(authorizingValidator.id);
							}
						}
					}
				}
			} catch {
				discoveryOverflow = `Stage A cannot safely inspect malformed package manifest at ${path.relative(canonicalRoot, candidateRoot).replaceAll('\\', '/') || '.'}/package.json`;
			}
		}
		const pyprojectText = readPresentRepositoryText(
			canonicalRoot,
			path.join(candidateRoot, 'pyproject.toml'),
			`${path.relative(canonicalRoot, candidateRoot).replaceAll('\\', '/') || '.'}/pyproject.toml manifest`,
		);
		if (pyprojectText?.match(/\[build-system\]/i))
			addObligation('build', candidateRoot, 'pyproject.toml#build-system');
		if (pyprojectText?.match(/\[(?:tool\.)?mypy\]/i))
			addObligation('typecheck', candidateRoot, 'pyproject.toml#mypy');
		if (pyprojectText?.match(/\[tool\.ruff(?:\.|\])/i))
			addObligation('lint', candidateRoot, 'pyproject.toml#ruff');
		for (const validator of contract?.validators ?? []) {
			if (contractValidatorsCoveredByScripts.has(validator.id)) continue;
			if (
				OPTIONAL_STAGE_A_CATEGORIES.includes(
					validator.category as OptionalStageACategory,
				)
			) {
				const validatorWorkspace = resolveContainedDirectory(
					canonicalRoot,
					validator.working_directory,
				);
				if (!validatorWorkspace) continue;
				addObligation(
					validator.category as OptionalStageACategory,
					validatorWorkspace.absolute,
					`${contractRelative}#${validator.id}`,
				);
			}
		}
	}
	if (discoveryOverflow) throw new Error(`BLOCKED: ${discoveryOverflow}`);
	return [...obligations.values()];
}

function discoverApplicableStageACategories(
	directory: string,
	contractBase?: ContractBaseProvenance,
): OptionalStageACategory[] {
	const applicable = new Set(
		discoverApplicableStageAObligations(directory, contractBase).map(
			({ category }) => category,
		),
	);
	return OPTIONAL_STAGE_A_CATEGORIES.filter((category) =>
		applicable.has(category),
	);
}

/** Execute every mandatory repository-generic Stage A category and persist receipts. */
export async function executeRunPrFeedbackStageA(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = RunPrFeedbackStageAArgsSchema.safeParse(args);
	if (!parsed.success) {
		return failure(
			`Invalid PR-feedback Stage A request: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		);
	}
	if (!context.sessionID?.trim()) {
		return failure('PR-feedback Stage A requires an active sessionID');
	}
	const categories = parsed.data.checks.map((check) => check.category);
	for (const requiredSingleton of ALWAYS_REQUIRED_CATEGORIES) {
		if (
			categories.filter((category) => category === requiredSingleton).length !==
			1
		) {
			return failure(
				`Stage A requires exactly one ${requiredSingleton} receipt`,
			);
		}
	}
	let contractBase: ContractBaseProvenance | undefined;
	try {
		contractBase = await resolveContractBaseProvenance(
			directory,
			parsed.data.pr_head_sha,
			parsed.data.base_ref,
			parsed.data.base_sha,
		);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
	let applicableObligations: StageAObligation[];
	try {
		applicableObligations = _internals.discoverApplicableStageAObligations(
			directory,
			contractBase,
		);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
	const applicableCategories = OPTIONAL_STAGE_A_CATEGORIES.filter((category) =>
		applicableObligations.some(
			(obligation) => obligation.category === category,
		),
	);
	const matchedObligationIds = new Set<string>();
	const selectedObligations = new Map<StageACheckInput, StageAObligation>();
	const normalizedCheckDirectories = new Map<StageACheckInput, string>();
	for (const check of parsed.data.checks) {
		const workspace = resolveContainedDirectory(
			directory,
			check.working_directory ?? '.',
		);
		if (!workspace) {
			return failure(
				`Stage A ${check.category} working_directory is not a contained repository workspace`,
			);
		}
		normalizedCheckDirectories.set(check, workspace.relative);
		if (
			!OPTIONAL_STAGE_A_CATEGORIES.includes(
				check.category as OptionalStageACategory,
			)
		)
			continue;
		const candidates = applicableObligations.filter(
			(obligation) =>
				obligation.category === check.category &&
				obligation.workingDirectory === workspace.relative,
		);
		if (candidates.length === 0 && !check.obligation_id) continue;
		const selected = check.obligation_id
			? candidates.find((candidate) => candidate.id === check.obligation_id)
			: candidates.length === 1
				? candidates[0]
				: undefined;
		if (!selected) {
			return failure(
				`Stage A ${check.category} must name one exact discovered obligation_id for workspace ${workspace.relative}: ${candidates.map(({ id }) => id).join(', ') || 'none discovered'}`,
			);
		}
		if (matchedObligationIds.has(selected.id)) {
			return failure(`Stage A repeats discovered obligation ${selected.id}`);
		}
		matchedObligationIds.add(selected.id);
		selectedObligations.set(check, selected);
		check.obligation_id = selected.id;
		check.working_directory = workspace.relative;
	}
	const missingObligations = applicableObligations.filter(
		({ id }) => !matchedObligationIds.has(id),
	);
	if (missingObligations.length > 0) {
		return failure(
			`Stage A is missing concrete repository validation obligations: ${missingObligations.map(({ id }) => id).join(', ')}`,
		);
	}
	const diffCheck = parsed.data.checks.find(
		(check) => check.category === 'diff-check',
	);
	if (!diffCheck || !isExactDiffCheck(diffCheck.command)) {
		return failure(
			'Stage A diff-check must execute array-form ["git", "diff", "--check"]',
		);
	}
	for (const check of parsed.data.checks) {
		const directContractValidated = isExactRepositoryContractValidator(
			directory,
			check,
			contractBase,
		);
		const selectedObligation = selectedObligations.get(check);
		const obligationContractValidated = selectedObligation
			? isExactObligationContractAuthorization(
					directory,
					selectedObligation,
					check,
					contractBase,
				)
			: false;
		const contractValidated =
			directContractValidated || obligationContractValidated;
		if (selectedObligation?.validatorContract && !obligationContractValidated) {
			return failure(
				`Stage A obligation ${selectedObligation.id} requires exact validator_contract ${selectedObligation.validatorContract.path}#${selectedObligation.validatorContract.id}`,
			);
		}
		const executable = normalizedExecutable(check.command);
		if (
			selectedObligation &&
			!commandMatchesObligationSource(
				directory,
				selectedObligation,
				check,
				contractValidated,
			)
		) {
			return failure(
				`Stage A command does not prove its exact source obligation ${selectedObligation.id}`,
			);
		}
		if (
			!isPlausibleStageACommand(check.category, check.command) &&
			!(contractValidated && isSafeContractCommand(check.command))
		) {
			return failure(
				`Stage A ${check.category} command is not a recognized non-publishing ${check.category} validation command`,
			);
		}
		const isPackageManagerCommand =
			['npm', 'pnpm', 'yarn'].includes(executable) ||
			(executable === 'bun' && check.command[1] === 'run');
		if (
			!selectedObligation &&
			isPackageManagerCommand &&
			(check.category !== 'reproduction' ||
				!isExactRepositoryPackageManagerScript(
					directory,
					normalizedCheckDirectories.get(check) ?? '.',
					check.category,
					check.command,
				))
		) {
			return failure(
				`Stage A ${check.category} package-manager command must select one exact inspected repository script`,
			);
		}
		if (
			!isAllowedRepositoryExecutable(
				directory,
				normalizedCheckDirectories.get(check) ?? '.',
				check.command[0],
				contractValidated,
			)
		) {
			return failure(
				`Stage A rejects escaping or undeclared repository wrapper executables: ${check.command[0]}`,
			);
		}
	}
	const normalizedCommands = parsed.data.checks.map((check) =>
		`${check.obligation_id ?? check.category}\0${normalizedCheckDirectories.get(check) ?? '.'}\0${check.command.join('\0')}`.toLowerCase(),
	);
	if (new Set(normalizedCommands).size !== normalizedCommands.length) {
		return failure(
			'Stage A categories require distinct commands; one command cannot prove multiple obligations',
		);
	}
	const reproduction = parsed.data.checks.find(
		(check) => check.category === 'reproduction',
	);
	if (!reproduction?.targets?.length) {
		return failure(
			'Stage A reproduction requires at least one explicit test/regression target',
		);
	}
	const reproductionSelectors = reproductionSelectorValues(
		reproduction.command,
	);
	const missingTargets = reproduction.targets.filter(
		(target) =>
			![...reproductionSelectors].some(
				(selector) =>
					selector === target ||
					selector.replaceAll('\\', '/') === target.replaceAll('\\', '/'),
			),
	);
	if (missingTargets.length > 0) {
		return failure(
			`Stage A reproduction command does not select declared target(s): ${missingTargets.join(', ')}`,
		);
	}
	for (const target of reproduction.targets) {
		if (!/[\\/]/.test(target)) continue;
		const pathTarget = target.split('::', 1)[0].replace(/:\d+(?::\d+)?$/, '');
		const resolved = path.resolve(directory, pathTarget);
		const relative = path.relative(path.resolve(directory), resolved);
		if (
			!relative ||
			relative.startsWith('..') ||
			path.isAbsolute(relative) ||
			!fs.existsSync(resolved) ||
			!fs.statSync(resolved).isFile()
		) {
			return failure(
				`Stage A reproduction target is not a contained existing file: ${target}`,
			);
		}
	}

	try {
		const state = await assertPrFeedbackVerificationSettled(
			directory,
			context.sessionID,
		);
		const feedbackTargets = reproduction.feedback_targets ?? [];
		const mappedFeedbackIds = feedbackTargets.map(
			(mapping) => mapping.feedback_item_id,
		);
		if (
			mappedFeedbackIds.length !== new Set(mappedFeedbackIds).size ||
			mappedFeedbackIds.length !== (state.prFeedbackInventory?.length ?? 0) ||
			!mappedFeedbackIds.every(
				(itemId, index) => itemId === state.prFeedbackInventory?.[index],
			) ||
			feedbackTargets.some(
				(mapping) => !reproduction.targets?.includes(mapping.target),
			)
		) {
			return failure(
				'Stage A reproduction requires one exact target and expected-behavior mapping for every immutable feedback item in declared order',
			);
		}
		if (state.prHeadSha !== parsed.data.pr_head_sha) {
			return failure(
				`PR_FEEDBACK head mismatch: expected ${state.prHeadSha ?? '(unbound)'}, received ${parsed.data.pr_head_sha}`,
			);
		}
		await assertCurrentCheckoutHead(directory, parsed.data.pr_head_sha);
		const beforeDigest = await _internals.resolvePrWorkflowRevisionDigestAsync(
			directory,
			parsed.data.pr_head_sha,
		);
		if (!beforeDigest) {
			return failure('Could not compute a bounded Stage A revision digest');
		}
		const boundHead = (
			await _internals.resolveCurrentGitHeadAsync(directory)
		)?.trim();
		const boundControlState =
			await _internals.resolveGitControlStateDigestAsync(directory);
		if (!boundHead || !boundControlState) {
			return failure(
				'Could not bind Stage A to the current Git HEAD, refs, config, and index state',
			);
		}

		const results: Array<Record<string, unknown>> = [];
		const receipts = [];
		for (const check of parsed.data.checks) {
			const commandRevision =
				await _internals.resolvePrWorkflowRevisionDigestAsync(
					directory,
					parsed.data.pr_head_sha,
				);
			const commandControl =
				await _internals.resolveGitControlStateDigestAsync(directory);
			if (
				commandRevision !== beforeDigest ||
				commandControl !== boundControlState ||
				(await _internals.resolveCurrentGitHeadAsync(directory))?.trim() !==
					boundHead
			) {
				return failure(
					`Stage A Git or content state changed before ${check.category}; restart the complete sequence`,
					results,
				);
			}
			const started = Date.now();
			const [executable, ...commandArgs] = check.command;
			const checkDirectory = resolveContainedDirectory(
				directory,
				check.working_directory ?? '.',
			);
			if (!checkDirectory) {
				return failure(
					`Stage A ${check.category} workspace disappeared before execution`,
					results,
				);
			}
			let result: Awaited<ReturnType<typeof runExternalTool>>;
			try {
				result = await _internals.runExternalTool({
					executable,
					args: commandArgs,
					cwd: checkDirectory.absolute,
					timeoutMs: check.timeout_ms ?? 120_000,
					maxStdoutBytes: MAX_OUTPUT_BYTES,
					maxStderrBytes: MAX_OUTPUT_BYTES,
				});
			} catch (error) {
				const afterThrowRevision =
					await _internals.resolvePrWorkflowRevisionDigestAsync(
						directory,
						parsed.data.pr_head_sha,
					);
				const afterThrowControl =
					await _internals.resolveGitControlStateDigestAsync(directory);
				if (
					afterThrowRevision !== beforeDigest ||
					afterThrowControl !== boundControlState ||
					(await _internals.resolveCurrentGitHeadAsync(directory))?.trim() !==
						boundHead
				) {
					return failure(
						`Stage A ${check.category} threw after mutating content, HEAD, refs, Git config, or index state`,
						results,
					);
				}
				return failure(
					`Stage A ${check.category} execution threw: ${error instanceof Error ? error.message : String(error)}`,
					results,
				);
			}
			const durationMs = Date.now() - started;
			results.push({
				category: check.category,
				working_directory: checkDirectory.relative,
				...(check.obligation_id ? { obligation_id: check.obligation_id } : {}),
				command: check.command,
				status: result.status,
				exit_code: result.exitCode,
				duration_ms: durationMs,
				stdout: result.stdout,
				stderr: result.stderr,
				stdout_truncated: result.stdoutTruncated,
				stderr_truncated: result.stderrTruncated,
				...(result.message ? { message: result.message } : {}),
			});
			const afterCommandRevision =
				await _internals.resolvePrWorkflowRevisionDigestAsync(
					directory,
					parsed.data.pr_head_sha,
				);
			const afterCommandControl =
				await _internals.resolveGitControlStateDigestAsync(directory);
			if (
				afterCommandRevision !== beforeDigest ||
				afterCommandControl !== boundControlState ||
				(await _internals.resolveCurrentGitHeadAsync(directory))?.trim() !==
					boundHead
			) {
				return failure(
					`Stage A ${check.category} mutated content, HEAD, refs, Git config, or index state`,
					results,
				);
			}
			if (result.status !== 'completed' || result.exitCode !== 0) {
				return failure(
					`Stage A ${check.category} failed (${result.status}, exit ${result.exitCode ?? 'unknown'})`,
					results,
				);
			}
			if (
				check.validator_contract &&
				!`${result.stdout}\n${result.stderr}`.trim()
			) {
				return failure(
					`Stage A repository-contract validator ${check.validator_contract.id} produced no machine-observable evidence`,
					results,
				);
			}
			if (check.category === 'reproduction' && outputReportsZeroTests(result)) {
				return failure(
					'Stage A reproduction produced truncated proof or reported that zero tests executed',
					results,
				);
			}
			if (
				check.category === 'reproduction' &&
				!`${result.stdout}\n${result.stderr}`.trim()
			) {
				return failure(
					'Stage A reproduction produced no machine-observable execution evidence',
					results,
				);
			}
			receipts.push({
				category: check.category,
				workingDirectory: checkDirectory.relative,
				...(check.obligation_id ? { obligationId: check.obligation_id } : {}),
				...(check.validator_contract
					? {
							validatorContract: {
								path: check.validator_contract.path,
								id: check.validator_contract.id,
							},
						}
					: {}),
				command: check.command,
				...(check.targets ? { targets: check.targets } : {}),
				...(check.feedback_targets
					? {
							feedbackTargets: check.feedback_targets.map((mapping) => ({
								feedbackItemId: mapping.feedback_item_id,
								target: mapping.target,
								expectedBehavior: mapping.expected_behavior,
							})),
						}
					: {}),
				durationMs,
			});
		}

		const afterDigest = await _internals.resolvePrWorkflowRevisionDigestAsync(
			directory,
			parsed.data.pr_head_sha,
		);
		if (!afterDigest || afterDigest !== beforeDigest) {
			return failure(
				'Stage A changed the working-tree revision; rerun all Stage A checks on the resulting diff',
				results,
			);
		}
		if (
			(await _internals.resolveGitControlStateDigestAsync(directory)) !==
				boundControlState ||
			(await _internals.resolveCurrentGitHeadAsync(directory))?.trim() !==
				boundHead
		) {
			return failure(
				'Stage A changed HEAD, refs, Git config, or index state; rerun the complete sequence',
				results,
			);
		}
		await recordPrFeedbackStageA(
			directory,
			context.sessionID,
			afterDigest,
			receipts,
			{ applicableCategories, applicableObligations },
		);
		return JSON.stringify(
			{
				success: true,
				pr_head_sha: parsed.data.pr_head_sha,
				revision_digest: afterDigest,
				checks: results,
			},
			null,
			2,
		);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
}

export const _internals = {
	runExternalTool,
	readGitTextAtRevision,
	resolveExactMergeBase,
	resolveExactMergeBaseAsync,
	resolveCurrentGitHead,
	resolveCurrentGitHeadAsync,
	resolveGitControlStateDigest,
	resolveGitControlStateDigestAsync,
	resolvePrWorkflowRevisionDigest,
	resolvePrWorkflowRevisionDigestAsync,
	isPlausibleStageACommand,
	discoverApplicableStageACategories,
	discoverApplicableStageAObligations,
	commandMatchesObligationSource,
};

export const run_pr_feedback_stage_a: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Execute and persist mandatory PR-feedback Stage A diff-check and targeted reproduction receipts plus every build, typecheck, or lint check mechanically applicable to this repository, on one content-bound revision.',
		args: {
			pr_head_sha: RunPrFeedbackStageAArgsSchema.shape.pr_head_sha,
			checks: RunPrFeedbackStageAArgsSchema.shape.checks,
		},
		execute: executeRunPrFeedbackStageA,
	});
