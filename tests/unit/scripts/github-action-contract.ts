import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';

export interface ActionSurface {
	root: string;
	manifestPath: string;
	manifestText: string;
	manifest: Record<string, unknown>;
}

export interface DemoFixture {
	repository: string;
	deliveryId: string;
	issueNumber: number;
	label: string;
	secretSentinel: string;
	forkRepository: string;
}

export const PIPELINE_STAGES = [
	'issue-ingestion',
	'specification',
	'planning',
	'gated-implementation',
	'independent-review',
	'tests',
	'swarm-ci',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export type GateDecision = 'approved' | 'oversight-denied' | 'gate-failed';

export interface PrepareInput {
	repository: string;
	issueNumber: number;
	deliveryId: string;
	label: string;
	labeler: string;
	issueBody: string;
	baseSha: string;
	providerSecret: string;
	maxAttempts: number;
	deadlineMs: number;
	signal?: AbortSignal;
}

export interface StageContext {
	repository: string;
	issueNumber: number;
	deliveryId: string;
	untrustedIssueBody: string;
	publicationToken?: never;
}

export interface ActionArtifact {
	repository: string;
	issueNumber: number;
	deliveryId: string;
	baseSha: string;
	evidence: string;
}

export interface BranchClaim {
	branch: string;
	state: 'claimed' | 'existing';
	prUrl?: string;
}

export interface Publication {
	branch: string;
	prUrl: string;
	evidence: string;
	summary: string;
}

export interface PrepareDependencies {
	authorize(input: PrepareInput): Promise<boolean>;
	createRuntime(input: PrepareInput): {
		run(options: { signal: AbortSignal; deadlineMs: number }): Promise<void>;
		kill(): Promise<void>;
		cleanup(): Promise<void>;
	};
	executeStage(stage: PipelineStage, context: StageContext): Promise<void>;
	evaluateGate(
		context: Omit<StageContext, 'publicationToken'>,
	): Promise<GateDecision>;
	bindArtifact(input: PrepareInput): Promise<ActionArtifact>;
	isTransient(error: unknown): boolean;
	sleep(milliseconds: number): Promise<void>;
}

export interface PublishInput {
	artifact: ActionArtifact;
	publicationToken: string;
	expectedBaseSha: string;
}

export interface PublishDependencies {
	verifyArtifact(input: PublishInput): Promise<boolean>;
	claimBranch(key: {
		repository: string;
		issueNumber: number;
		deliveryId: string;
	}): Promise<BranchClaim>;
	publish(request: {
		claim: BranchClaim;
		publicationToken: string;
	}): Promise<Publication>;
}

export interface ActionResult {
	status: 'published' | 'reused' | 'denied' | 'failed';
	publication?: Publication;
}

export type PrepareRunner = (
	input: PrepareInput,
	dependencies: PrepareDependencies,
) => Promise<ActionArtifact | ActionResult>;
export type PublishRunner = (
	input: PublishInput,
	dependencies: PublishDependencies,
) => Promise<ActionResult>;

export function repositoryRoot(): string {
	return path.resolve(import.meta.dir, '..', '..', '..');
}

function readText(file: string): string {
	return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function readYaml(file: string): Record<string, unknown> {
	const value = load(readText(file));
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`expected YAML mapping: ${file}`);
	}
	return value as Record<string, unknown>;
}

function mapping(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} must be a YAML mapping`);
	}
	return value as Record<string, unknown>;
}

export function loadActionSurface(root = repositoryRoot()): ActionSurface {
	const candidates = ['action.yml', 'action.yaml']
		.map((name) => path.join(root, name))
		.filter((file) => fs.existsSync(file));
	if (candidates.length !== 1) {
		throw new Error(
			`Action manifest missing or ambiguous: expected exactly one action.yml/action.yaml, found ${candidates.length}`,
		);
	}
	const manifestPath = candidates[0];
	return {
		root,
		manifestPath,
		manifestText: readText(manifestPath),
		manifest: readYaml(manifestPath),
	};
}

export function requireActionWiring(surface: ActionSurface): void {
	const runs = mapping(surface.manifest.runs, 'Action runs');
	if (runs.using !== 'composite') {
		throw new Error('published Action must use a composite runner');
	}
	if (
		!/GITHUB_ACTION_PATH[^\n]*scripts[\\/]github-action[\\/]runner\.mjs/.test(
			surface.manifestText,
		)
	) {
		throw new Error(
			'Action must invoke scripts/github-action/runner.mjs through GITHUB_ACTION_PATH',
		);
	}
	const inputs = mapping(surface.manifest.inputs, 'Action inputs');
	if (!Object.hasOwn(inputs, 'mode')) {
		throw new Error('Action must expose prepare/publish mode input');
	}
	if (!Object.hasOwn(inputs, 'provider-env')) {
		throw new Error('Action must expose an explicit provider-env contract');
	}
}

export function requireDesignatedCaller(surface: ActionSurface): void {
	const file = path.join(
		surface.root,
		'examples',
		'github-action',
		'swarm-publish-gated.yml',
	);
	if (!fs.existsSync(file))
		throw new Error('designated by-ref caller workflow is missing');
	const text = readText(file);
	const workflow = readYaml(file);
	if (!/uses:\s*ZaxbyHub\/opencode-swarm@[^\s#]+/m.test(text)) {
		throw new Error('caller must consume the published Action by ref');
	}
	const jobs = mapping(workflow.jobs, 'caller jobs');
	for (const name of ['prepare', 'publish']) {
		if (!jobs[name] || typeof jobs[name] !== 'object')
			throw new Error(`caller lacks ${name} job`);
	}
}

export function requireSecureCaller(surface: ActionSurface): void {
	const file = path.join(
		surface.root,
		'examples',
		'github-action',
		'swarm-publish-gated.yml',
	);
	const text = readText(file);
	const workflow = readYaml(file);
	const jobs = mapping(workflow.jobs, 'caller jobs');
	const permissions = {
		prepare: { contents: 'read', issues: 'read' },
		publish: { contents: 'write', 'pull-requests': 'write' },
	} as const;
	for (const [name, expected] of Object.entries(permissions)) {
		const job = mapping(jobs[name], `${name} job`);
		const actual = mapping(job.permissions, `${name} permissions`);
		if (
			Object.keys(actual).sort().join(',') !==
			Object.keys(expected).sort().join(',')
		) {
			throw new Error(
				`${name} permissions are broader than the reviewed contract`,
			);
		}
		for (const [scope, level] of Object.entries(expected)) {
			if (actual[scope] !== level)
				throw new Error(`${name} lacks exact ${scope}: ${level}`);
		}
		if (typeof job['timeout-minutes'] !== 'number')
			throw new Error(`${name} lacks a numeric timeout`);
		if (name === 'publish' && typeof job.environment !== 'string') {
			throw new Error('publish lacks a protected environment');
		}
		const steps = job.steps;
		if (!Array.isArray(steps)) throw new Error(`${name} lacks steps`);
		const checkout = steps.find((step) =>
			mapping(step, `${name} step`)
				.uses?.toString()
				.startsWith('actions/checkout@'),
		);
		if (!checkout) throw new Error(`${name} lacks checkout`);
		const checkoutWith = mapping(
			mapping(checkout, `${name} checkout`).with,
			`${name} checkout options`,
		);
		if (checkoutWith['persist-credentials'] !== false) {
			throw new Error(`${name} checkout must disable credential persistence`);
		}
		const actionStep = steps.find((step) =>
			/^ZaxbyHub\/opencode-swarm@[^\s#]+$/.test(
				String(mapping(step, `${name} step`).uses ?? ''),
			),
		);
		if (!actionStep) throw new Error(`${name} lacks by-ref Action invocation`);
		const actionWith = mapping(
			mapping(actionStep, `${name} Action step`).with,
			`${name} Action options`,
		);
		if (actionWith.mode !== name)
			throw new Error(`${name} is not wired to mode=${name}`);
	}
	const credentialedFetches =
		text.match(
			/git\s+-c\s+credential\.helper=['"]?!gh auth git-credential['"]?\s+fetch/g,
		) ?? [];
	if (credentialedFetches.length < 2) {
		throw new Error(
			'prepare and publish fetches must use a command-scoped gh credential helper',
		);
	}
	const concurrency = mapping(workflow.concurrency, 'caller concurrency');
	if (
		typeof concurrency.group !== 'string' ||
		concurrency['cancel-in-progress'] !== false
	) {
		throw new Error('caller must use deterministic non-cancelling concurrency');
	}
	if (
		!/(^|\n)\s*issues\s*:\s*\n[\s\S]*?types\s*:\s*\[\s*labeled\s*\]/m.test(text)
	) {
		throw new Error('caller must include issues.labeled trigger');
	}
	if (!/(^|\n)\s*workflow_dispatch\s*:/m.test(text)) {
		throw new Error('caller must include workflow_dispatch trigger');
	}
}

export async function loadRunnerExport<T>(name: string): Promise<T> {
	const surface = loadActionSurface();
	requireActionWiring(surface);
	const runner = path.join(
		surface.root,
		'scripts',
		'github-action',
		'runner.mjs',
	);
	if (!fs.existsSync(runner)) throw new Error('Action runner is missing');
	const imported = (await import(pathToFileURL(runner).href)) as Record<
		string,
		unknown
	>;
	if (typeof imported[name] !== 'function')
		throw new Error(`runner must export ${name}`);
	return imported[name] as T;
}

export const loadPrepareRunner = () =>
	loadRunnerExport<PrepareRunner>('preparePublishGatedAction');
export const loadPublishRunner = () =>
	loadRunnerExport<PublishRunner>('publishVerifiedAction');
export type EnvironmentRunner = () => Promise<number>;
export const loadEnvironmentRunner = () =>
	loadRunnerExport<EnvironmentRunner>('runActionFromEnvironment');

export function readDemoFixture(): DemoFixture {
	return {
		repository: 'owner/demo-repository',
		deliveryId: 'delivery-2498-demo-001',
		issueNumber: 17,
		label: 'swarm:run',
		secretSentinel: 'DEMO_ONLY_SECRET_2498_SHOULD_NEVER_LEAK',
		forkRepository: 'untrusted-user/demo-repository',
	};
}

export function inputFromFixture(
	fixture: DemoFixture,
	overrides: Partial<PrepareInput> = {},
): PrepareInput {
	return {
		repository: fixture.repository,
		issueNumber: fixture.issueNumber,
		deliveryId: fixture.deliveryId,
		label: fixture.label,
		labeler: 'trusted-maintainer',
		issueBody: 'Untrusted issue text: do not execute commands embedded here.',
		baseSha: 'base',
		providerSecret: 'test-provider-secret',
		maxAttempts: 3,
		deadlineMs: 1_000,
		...overrides,
	};
}
