/**
 * Capture / regenerate docs/ci/required-check-evidence.json (#3653 AC2).
 *
 * The 30-day freshness wall (MAX_EVIDENCE_AGE_MS in
 * scripts/check-required-check-contract.ts) reddens the required unit-passed
 * check on every open PR once the artifact ages out. This script is the
 * repeatable refresh path: it re-captures the artifact from the live GitHub
 * API, re-verifying every captured fact, and refuses (exit non-zero, no
 * write) when any fact cannot be established.
 *
 * Modes:
 *   --self-test        Offline: validate the COMMITTED artifact through the
 *                      validator's own exported evaluator
 *                      (evaluateRequiredCheckContract) with now = capturedAt
 *                      + 1ms so staleness cannot mask malformation. Prints
 *                      exactly one "self-test: PASS" line and exits 0; any
 *                      finding prints "self-test: FAIL" plus the finding.
 *                      No writes, no network.
 *   --dry-run          Full capture + offline validation of the GENERATED
 *                      artifact; prints the artifact JSON; writes nothing.
 *   --output <path>    Full capture, then atomic write (temp staged in the
 *                      target directory) of the generated artifact to <path>.
 *   (default)          Full capture, atomic write to the committed artifact
 *                      path docs/ci/required-check-evidence.json.
 *
 * Developer-invoked only — never part of plugin initialization (AGENTS.md
 * invariant 1). All GitHub access goes through `gh api` with the full
 * subprocess contract (array form, explicit cwd, stdin ignored, per-call
 * timeout, bounded output, non-interactive environment).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	evaluateRequiredCheckContract,
	parseWorkflowSurface,
	type ContractFinding,
	type RequiredCheckEvidence,
} from './check-required-check-contract';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const CONTRACT_PATH = path.join(REPO_ROOT, 'scripts', 'required-check-contract.json');
const DEFAULT_EVIDENCE_PATH = path.join(REPO_ROOT, 'docs', 'ci', 'required-check-evidence.json');

/** Bounded pagination: at most this many runs pages / candidate heads probed. */
const MAX_RUN_PAGES = 3;
const RUNS_PER_PAGE = 100;
const MAX_CANDIDATE_HEADS = 20;
const API_TIMEOUT_MS = 30_000;
const MAX_API_OUTPUT_BYTES = 4 * 1024 * 1024;

interface GhApiResult {
	ok: boolean;
	status: number;
	json: unknown;
	error?: string;
}

/** Test seam: run `gh api <endpoint>` under the full subprocess contract. */
function ghApiViaCli(endpoint: string, cwd: string): GhApiResult {
	// Routed through _internals.spawnSync (#3661 item 2): spawnSync is
	// synchronous and reaps the child itself, so there is deliberately no
	// post-call kill — signalling the returned pid would target a reaped,
	// potentially recycled process.
	const proc = _internals.spawnSync('gh', ['api', endpoint], {
		cwd,
		input: '',
		timeout: API_TIMEOUT_MS,
		maxBuffer: MAX_API_OUTPUT_BYTES,
		encoding: 'utf-8',
		windowsHide: true,
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: '0',
			GH_PROMPT_DISABLED: '1',
			GH_NO_UPDATE_NOTIFIER: '1',
		},
	});
	if (proc.error) {
		return { ok: false, status: -1, json: null, error: proc.error.message };
	}
	if (proc.status !== 0) {
		return {
			ok: false,
			status: proc.status,
			json: null,
			error: (proc.stderr || '').split('\n')[0]?.slice(0, 300) || `gh exited ${proc.status}`,
		};
	}
	try {
		return { ok: true, status: 0, json: JSON.parse(proc.stdout) };
	} catch (error) {
		return {
			ok: false,
			status: 0,
			json: null,
			error: `gh api ${endpoint} returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** Test seam for the atomic write. */
function writeArtifactAtomic(target: string, contents: string): void {
	const dir = path.dirname(target);
	fs.mkdirSync(dir, { recursive: true });
	const temp = path.join(dir, `.capture-evidence-${process.pid}.tmp`);
	try {
		fs.writeFileSync(temp, contents, { encoding: 'utf-8' });
		fs.renameSync(temp, target);
	} finally {
		if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
	}
}

export const _internals: {
	ghApi: typeof ghApiViaCli;
	writeArtifactAtomic: typeof writeArtifactAtomic;
	spawnSync: typeof spawnSync;
} = {
	ghApi: ghApiViaCli,
	writeArtifactAtomic,
	spawnSync,
};

/** Thrown by refuse(); main() converts it to the exit code. */
export class CaptureRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CaptureRefusal';
	}
}

function refuse(message: string): never {
	throw new CaptureRefusal(message);
}

function requireOk(result: GhApiResult, purpose: string): unknown {
	if (!result.ok) return refuse(`${purpose} failed (${result.error ?? result.status})`);
	return result.json;
}

interface Contract {
	repository: string;
	branch: string;
	rulesetId: string;
	requiredContexts: string[];
	workflows: Array<{ file: string; events?: string[]; mergeGroupTypes?: string[]; jobs?: string[] }>;
}

function loadContract(): Contract {
	const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf-8')) as Contract;
	if (!contract.repository || !contract.branch || !contract.rulesetId) {
		refuse('contract is missing repository/branch/rulesetId');
	}
	if (!Array.isArray(contract.requiredContexts) || !Array.isArray(contract.workflows)) {
		refuse('contract is missing requiredContexts/workflows arrays');
	}
	return contract;
}

/** The validator's own LF-normalized SHA-256 over workflow text (:1244-1249). */
function normalizedSha256(text: string): string {
	return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

/** Offline self-test: the committed artifact must satisfy the validator's own
 *  evaluation, with now = capturedAt + 1ms so EVIDENCE_STALE cannot fire and
 *  every other offline finding is fatal. */
export function runSelfTest(evidencePath = DEFAULT_EVIDENCE_PATH): boolean {
	const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf-8')) as unknown;
	const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf-8')) as RequiredCheckEvidence;
	const capturedAtMs = Date.parse(evidence.capturedAt ?? '');
	if (!Number.isFinite(capturedAtMs)) {
		console.error('self-test: FAIL — capturedAt is missing or not an ISO timestamp');
		return false;
	}
	const result = evaluateRequiredCheckContract(
		{ ...contract, evidence },
		{ now: new Date(capturedAtMs + 1), strict: true },
	);
	const blocking = result.findings.filter(
		(finding: ContractFinding) => finding.severity === 'error',
	);
	if (result.status === 'pass' || blocking.length === 0) {
		console.log(`self-test: PASS (${result.findings.length} non-blocking finding(s))`);
		return true;
	}
	console.error('self-test: FAIL');
	for (const finding of blocking) {
		console.error(`  ${finding.code}: ${finding.message}`);
	}
	return false;
}

interface CheckRun {
	name: string;
	status: string;
	conclusion: string | null;
	/** Producing GitHub App (nullable on the wire; used for duplicate-name binding). */
	app?: { slug?: string | null } | null;
}

/**
 * #3716 item 2 / #3661 item 3: the app slug that produces check runs for
 * workflows in THIS repository. The contract's owner records map every
 * required context to a workflow file in this repo, so a run carrying an
 * EXPLICIT different app slug is a foreign producer and cannot satisfy a
 * required context. Runs with no app field stay acceptable (the legacy
 * fixture/API tolerance the existing tests pin).
 */
export const REPO_WORKFLOW_PRODUCER_APP_SLUG = 'github-actions';

/**
 * One shared producer-binding rule for required-context satisfaction, used by
 * BOTH the completeness loop (head qualification) and the captured success-set
 * derivation (mergeGroup.contexts) so the two can never diverge (#3716 item 2
 * — the name-only trust surface is gone).
 *
 * Rules (the completeness loop's #3661 item-3 rules plus the #3716 item-2
 * producer-ownership clause):
 * 1. at least one same-named run, every same-named run completed+success;
 * 2. duplicates: every run carries a non-empty app slug and all slugs agree —
 *    ambiguity is a TERMINAL refusal (existing behavior, message preserved);
 * 3. a run carrying an explicit app slug other than the repo-workflow
 *    producer does not satisfy the context (foreign producer → the head is
 *    unqualified, i.e. a head SKIP, not a terminal refusal).
 *
 * Returns true when the context is satisfied at this head; throws
 * CaptureRefusal for rule-2 ambiguity (exact existing messages).
 */
export function contextRunsSatisfyBinding(
	name: string,
	runs: readonly CheckRun[],
	head: string,
): boolean {
	const matches = runs.filter((run) => run.name === name);
	if (matches.length === 0) return false;
	const allSuccessful = matches.every(
		(run) => run.status === 'completed' && run.conclusion === 'success',
	);
	if (!allSuccessful) return false;
	if (matches.length > 1) {
		// Duplicates are acceptable only when the producing app is
		// unambiguous: EVERY same-named run carries a non-empty app slug and
		// they all agree. Missing identity on any duplicate is ambiguous and
		// refuses.
		const slugs = matches.map((run) => run.app?.slug);
		const allIdentified = slugs.every(
			(slug) => typeof slug === 'string' && slug.length > 0,
		);
		const distinctSlugs = new Set(
			slugs.filter(
				(slug): slug is string => typeof slug === 'string' && slug.length > 0,
			),
		);
		if (!allIdentified || distinctSlugs.size !== 1) {
			throw new CaptureRefusal(
				`required context "${name}" has ambiguous producer binding at head ${head} (same-named runs must all carry one agreeing app slug)`,
			);
		}
	}
	// Producer ownership: an explicit foreign app slug cannot satisfy a
	// context the contract anchors to this repository's workflows.
	const foreignProducer = matches.some(
		(run) =>
			typeof run.app?.slug === 'string' &&
			run.app.slug.length > 0 &&
			run.app.slug !== REPO_WORKFLOW_PRODUCER_APP_SLUG,
	);
	if (foreignProducer) return false;
	return true;
}

interface ActionsRun {
	id: number;
	name: string;
	path: string;
	event: string;
	status: string;
	conclusion: string | null;
	head_sha: string;
}

/** Full capture against the live API; returns the validated artifact. */
export function runCapture(cwd = REPO_ROOT): RequiredCheckEvidence {
	const contract = loadContract();
	const repo = contract.repository;
	const api = (endpoint: string, purpose: string) =>
		requireOk(_internals.ghApi(endpoint, cwd), purpose);

	// Step 1 — ruleset + branch BEFORE selection (selection needs the
	// required-context set; the artifact records both). Every branch-related
	// field written into the artifact is DERIVED from API evidence — a
	// ruleset scoped away from the contract branch must refuse, not capture.
	const rulesetDetail = api(`/repos/${repo}/rulesets/${contract.rulesetId}`, 'ruleset fetch') as {
		id: number;
		enforcement: string;
		rules?: Array<{ type: string; parameters?: { required_status_checks?: string[] | null } }>;
		conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
	};
	const branchInfo = api(`/repos/${repo}/branches/${contract.branch}`, 'branch fetch') as {
		protected: boolean;
		protection?: { required_status_checks?: unknown };
	};
	// Applicability evidence 1: the ruleset's own ref-name conditions must
	// target the contract branch (refs/heads/<branch> or ~DEFAULT_BRANCH).
	const branchRef = `refs/heads/${contract.branch}`;
	const includes = rulesetDetail.conditions?.ref_name?.include ?? [];
	const targetsBranch =
		includes.includes(branchRef) || includes.includes('~DEFAULT_BRANCH');
	if (!targetsBranch) {
		refuse(
			`ruleset ${contract.rulesetId} does not target branch ${contract.branch} (ref_name include: ${JSON.stringify(includes)})`,
		);
	}
	const excludes = rulesetDetail.conditions?.ref_name?.exclude ?? [];
	if (excludes.includes(branchRef)) {
		refuse(`ruleset ${contract.rulesetId} explicitly excludes branch ${contract.branch}`);
	}
	// Applicability evidence 2: the branch-rules endpoint must list this
	// ruleset among the rules actually applied to the branch (the endpoint
	// returns an ARRAY of applied rules, each carrying ruleset_id).
	const branchRules = api(
		`/repos/${repo}/rules/branches/${contract.branch}`,
		'branch rules fetch',
	) as unknown as Array<{ type?: string; ruleset_id?: number | string }>;
	if (!Array.isArray(branchRules)) {
		refuse(`branch-rules endpoint returned a non-array payload for ${contract.branch}`);
	}
	const rulesetIdString = String(rulesetDetail.id);
	const appliedByThisRuleset = branchRules.some(
		(rule) =>
			rule.type === 'required_status_checks' &&
			String(rule.ruleset_id ?? '') === rulesetIdString,
	);
	if (!appliedByThisRuleset) {
		refuse(
			`ruleset ${contract.rulesetId} is not applied to branch ${contract.branch} per the branch-rules endpoint`,
		);
	}
	if (branchInfo.protected !== true) {
		refuse(`branch ${contract.branch} is not protected`);
	}
	const statusChecksRule = rulesetDetail.rules?.find(
		(rule) => rule.type === 'required_status_checks',
	);
	// The REST rulesets API returns required_status_checks as an array of
	// {context: "..."} objects — normalize to bare context strings.
	const rulesetRequired = (
		statusChecksRule?.parameters?.required_status_checks ?? []
	).map((entry) =>
		typeof entry === 'string' ? entry : (entry as { context?: unknown }).context,
	).filter((context): context is string => typeof context === 'string');
	if (rulesetRequired.length === 0) {
		refuse(`ruleset ${contract.rulesetId} exposes no required status checks`);
	}
	for (const required of contract.requiredContexts) {
		if (!rulesetRequired.includes(required)) {
			refuse(`ruleset ${contract.rulesetId} is missing contract-required context "${required}"`);
		}
	}

	// Step 2 — candidate capture SHAs: newest successful merge-group runs
	// whose check-run set has EVERY required context completed+successful.
	const runs: ActionsRun[] = [];
	for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
		const listing = api(
			`/repos/${repo}/actions/runs?event=merge_group&status=success&per_page=${RUNS_PER_PAGE}&page=${page}`,
			'merge-group run listing',
		) as { workflow_runs?: ActionsRun[] };
		runs.push(...(listing.workflow_runs ?? []));
		if ((listing.workflow_runs ?? []).length < RUNS_PER_PAGE) break;
	}
	const headsNewestFirst = [...new Set(runs.map((run) => run.head_sha))].slice(
		0,
		MAX_CANDIDATE_HEADS,
	);
	let captureSha: string | undefined;
	let checkRuns: CheckRun[] = [];
	// Mirror the validator's requiredMergeGroupWorkflows derivation: a
	// workflow needs run receipts only when it declares merge_group AND
	// carries at least one required context (drift-check.yml declares
	// merge_group but carries none, so an empty map entry is correct).
	const requiredContextWorkflows = new Set(
		contract.requiredContexts.map((name) => name),
	);
	void requiredContextWorkflows;
	const mergeGroupWorkflows = contract.workflows.filter((workflow) => {
		const declares = (workflow.events ?? []).includes('merge_group');
		if (!declares) return false;
		return (contract as unknown as { contexts?: { required?: Array<{ name: string; workflow: string }> } })
			.contexts?.required?.some(
				(context) =>
					context.workflow === workflow.file && requiredContextWorkflows.has(context.name),
			);
	});
	for (const head of headsNewestFirst) {
		const checks = api(`/repos/${repo}/commits/${head}/check-runs?per_page=100`, 'check-run fetch') as {
			check_runs?: CheckRun[];
		};
		const all = checks.check_runs ?? [];
		let contextsComplete = true;
		for (const name of contract.requiredContexts) {
			// #3661 item 3 + #3716 item 2: one shared producer-binding rule
			// (contextRunsSatisfyBinding) decides head qualification here and
			// the mergeGroup.contexts derivation below — the two paths cannot
			// diverge. Original inline semantics preserved: no match or a
			// non-success run makes THIS head unqualifying (skip to the next
			// candidate, F-002); duplicate ambiguity refuses terminally
			// (exact message); a foreign-producer run (#3716 item 2) makes
			// the head unqualifying — a skip, not a refusal.
			if (!contextRunsSatisfyBinding(name, all, head)) {
				contextsComplete = false;
				break;
			}
		}
		const runsCoverWorkflows = mergeGroupWorkflows.every((workflow) =>
			runs.some((run) => run.head_sha === head && run.path === workflow.file),
		);
		if (contextsComplete && runsCoverWorkflows) {
			captureSha = head;
			checkRuns = all;
			break;
		}
	}
	if (captureSha === undefined) {
		refuse(
			`no recent successful merge-group head carries all ${contract.requiredContexts.length} required contexts as completed successful check runs`,
		);
	}

	// Step 3 — merge-group evidence from the selected head, scoped to CONTRACT
	// workflows only (#3661 item 4): a merge_group run at the head from a
	// workflow outside the contract is excluded here, matching the
	// validator's EVIDENCE_MERGE_GROUP_UNKNOWN rule by construction instead
	// of failing the offline validation later. The run map must still cover
	// EVERY contract workflow (empty arrays allowed for workflows that do
	// not run on merge_group), and every mapped/receipted run's endpoint must
	// appear in sources.
	const contractWorkflowFiles = new Set(contract.workflows.map((workflow) => workflow.file));
	const selectedRuns = runs.filter(
		(run) =>
			run.head_sha === captureSha &&
			run.event === 'merge_group' &&
			contractWorkflowFiles.has(run.path),
	);
	const observedRuns = selectedRuns.map((run) => ({
		id: run.id,
		workflow: run.name,
		workflowPath: run.path,
		event: run.event,
		endpoint: `https://api.github.com/repos/${repo}/actions/runs/${run.id}`,
		headSha: run.head_sha,
		conclusion: run.conclusion ?? 'success',
	}));
	const workflowRunsByWorkflow: Record<string, number[]> = {};
	for (const workflow of contract.workflows) {
		workflowRunsByWorkflow[workflow.file] = selectedRuns
			.filter((run) => run.path === workflow.file)
			.map((run) => run.id);
	}
	// Required workflows (merge_group-triggered AND carrying required
	// contexts) must have at least one successful run receipt at the capture
	// SHA — the validator rejects an artifact whose required workflows have
	// none. mergeGroupWorkflows mirrors the validator's own derivation.
	for (const workflow of mergeGroupWorkflows) {
		if (workflowRunsByWorkflow[workflow.file].length === 0) {
			refuse(
				`contract workflow ${workflow.file} declares merge_group but has no successful run at capture SHA ${captureSha}`,
			);
		}
	}
	// mergeGroup.contexts stays contract-scoped (the validator rejects
	// undeclared contexts); every one is verified successful above. #3716
	// item 2: the derivation goes through the SAME producer-binding rule as
	// the completeness loop (contextRunsSatisfyBinding) — the name-only
	// successfulNames Set is gone, so a same-named run from a foreign app can
	// no longer satisfy a required context on this path either.
	const contexts = contract.requiredContexts.filter((name) =>
		contextRunsSatisfyBinding(name, checkRuns, captureSha),
	);

	// Step 4 — per-workflow capture: exact Contents endpoint pinned to the
	// capture SHA, blob SHA, on: events, and the LF-normalized SHA-256 of the
	// local working copy (same algorithm as the validator).
	const capturedWorkflowFiles: Record<string, { contentsEndpoint: string; blobSha: string }> = {};
	const workflowEvents: Record<string, string[]> = {};
	const localWorkflowHashes: Record<string, string> = {};
	const sources: Array<{ endpoint: string; purpose: string }> = [
		{
			endpoint: `https://api.github.com/repos/${repo}/rulesets/${contract.rulesetId}`,
			purpose: 'active ruleset required status checks and enforcement',
		},
		{
			endpoint: `https://api.github.com/repos/${repo}/branches/${contract.branch}`,
			purpose: 'branch protection state at capture',
		},
		{
			endpoint: `https://api.github.com/repos/${repo}/rules/branches/${contract.branch}`,
			purpose: 'rules applied to the branch (ruleset applicability evidence)',
		},
		{
			// The validator pins this exact repository-bound form (no extra
			// query parameters) — it must appear verbatim in sources.
			endpoint: `https://api.github.com/repos/${repo}/actions/runs?event=merge_group`,
			purpose: 'observed merge-group runs at the capture SHA',
		},
		...observedRuns.map((run) => ({
			endpoint: run.endpoint,
			purpose: `merge-group run receipt ${run.id} (${run.workflowPath})`,
		})),
	];
	for (const workflow of contract.workflows) {
		const filePath = workflow.file;
		const endpoint = `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${captureSha}`;
		const contents = api(endpoint, `workflow contents fetch (${filePath})`) as {
			sha: string;
			content: string;
			encoding: string;
		};
		if (typeof contents.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(contents.sha)) {
			refuse(`contents response for ${filePath} has no blob SHA`);
		}
		const text =
			contents.encoding === 'base64'
				? Buffer.from(contents.content, 'base64').toString('utf-8')
				: String(contents.content ?? '');
		capturedWorkflowFiles[filePath] = { contentsEndpoint: endpoint, blobSha: contents.sha };
		sources.push({ endpoint, purpose: `workflow capture pinned to the capture SHA (${filePath})` });
		try {
			workflowEvents[filePath] = parseWorkflowSurface(text, filePath).events;
		} catch (error) {
			refuse(
				`captured content for ${filePath} does not parse as a workflow: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const localPath = path.join(cwd, filePath);
		if (!fs.existsSync(localPath)) {
			refuse(`local workflow file ${filePath} is missing; cannot compute its validation hash`);
		}
		const localText = fs.readFileSync(localPath, 'utf-8');
		localWorkflowHashes[filePath] = normalizedSha256(localText);
		if (localWorkflowHashes[filePath] !== normalizedSha256(text)) {
			refuse(
				`local workflow ${filePath} diverges from the captured blob at ${captureSha}; commit or check out the capture revision first`,
			);
		}
	}

	const capturedAt = new Date().toISOString();
	const artifact: RequiredCheckEvidence = {
		schemaVersion: 1,
		repository: repo,
		branch: {
			name: contract.branch,
			protected: branchInfo.protected === true,
			// Evidence-derived: the branch-rules endpoint listed this ruleset
			// among the rules applied to the branch (refused above otherwise),
			// so the protection mechanism IS a repository ruleset — not a
			// literal written by construction.
			protection: 'repository-ruleset',
			rulesetId: String(rulesetDetail.id),
		},
		ruleset: {
			id: String(rulesetDetail.id),
			enforcement: rulesetDetail.enforcement,
			requiredContexts: rulesetRequired,
		},
		mergeGroup: {
			known: true,
			contexts,
			observedRuns,
			workflowRunsByWorkflow,
		},
		workflowEvents,
		capturedWorkflowFiles,
		localWorkflowHashes,
		capturedAt,
		captureSha,
		sources,
	};

	// Offline-validate the GENERATED artifact through the validator's own
	// evaluator (fresh-by-construction so staleness cannot mask malformation).
	const contractRaw = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf-8')) as unknown;
	const verdict = evaluateRequiredCheckContract(
		{ ...contractRaw, evidence: artifact },
		{ now: new Date(Date.parse(capturedAt) + 1), strict: true },
	);
	const blocking = verdict.findings.filter((finding) => finding.severity === 'error');
	if (blocking.length > 0) {
		for (const finding of blocking) {
			console.error(`  ${finding.code}: ${finding.message}`);
		}
		refuse('the generated artifact fails the validator offline evaluation');
	}
	return artifact;
}

export function main(argv: string[] = process.argv.slice(2), cwd = REPO_ROOT): number {
	// Strict argv (#3661 item 1): only the space-separated `--output <path>`
	// form is recognized. Every other token — unknown flags, the
	// `--output=<path>` equals form, case-variant spellings, stray positionals,
	// and a bare `--` (no in-repo caller relies on it) — refuses with exit 2
	// BEFORE any capture work, self-test run, or write, so a typo can never
	// silently fall through to the default write of the committed evidence
	// artifact. F-007 (PR #3718 review): the --self-test dispatch ran BEFORE
	// this loop, so `--self-test --bogus` exited with the self-test verdict
	// and the strict contract was bypassable; the loop now validates EVERY
	// token first (the documented behavior: unknown flags exit 2), then
	// --self-test short-circuits the capture path.
	let dryRun = false;
	let outputArg: string | undefined;
	let selfTest = false;
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === '--self-test') {
			selfTest = true;
			continue;
		}
		if (token === '--dry-run') {
			dryRun = true;
			continue;
		}
		if (token === '--output') {
			const value = argv[i + 1];
			// An empty value would resolve to the cwd and only fail later
			// with exit 1 (F-007) — reject it as a missing path at the
			// contract boundary instead.
			if (value === undefined || value.length === 0 || value.startsWith('--')) {
				console.error('capture-required-check-evidence: --output requires a path');
				return 2;
			}
			outputArg = value;
			i += 1;
			continue;
		}
		console.error(
			`capture-required-check-evidence: unrecognized argument "${token}" (allowed: --self-test, --dry-run, --output <path>)`,
		);
		return 2;
	}
	if (selfTest) {
		return runSelfTest() ? 0 : 1;
	}
	try {
		const artifact = runCapture(cwd);
		const serialized = `${JSON.stringify(artifact, null, '\t')}\n`;
		if (dryRun) {
			console.log(serialized);
			console.log('dry-run: generated artifact validated offline; nothing written');
			return 0;
		}
		const target = outputArg !== undefined ? path.resolve(outputArg) : DEFAULT_EVIDENCE_PATH;
		_internals.writeArtifactAtomic(target, serialized);
		console.log(`capture-required-check-evidence: wrote ${path.relative(REPO_ROOT, target)}`);
		return 0;
	} catch (error) {
		if (error instanceof CaptureRefusal) {
			console.error(`capture-required-check-evidence: refusing — ${error.message}`);
			return 1;
		}
		throw error;
	}
}

if (import.meta.main) {
	process.exitCode = main();
}
