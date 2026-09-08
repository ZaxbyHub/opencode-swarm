import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

/**
 * The Action has two deliberately separate entry points.  The prepare entry
 * point never accepts a publication token and the publish entry point never
 * runs agent work.  The adapters are injected so the security boundary can be
 * exercised without making a network request (and so the Action remains
 * usable by a consumer with a different GitHub/OpenCode setup).
 */

export const PIPELINE_STAGES = Object.freeze([
	'issue-ingestion',
	'specification',
	'planning',
	'gated-implementation',
	'independent-review',
	'tests',
	'swarm-ci',
]);

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS = 8;
const DEFAULT_DEADLINE_MS = 300_000;
const MAX_DEADLINE_MS = 21_600_000;
const MAX_PUBLICATION_CHARS = 32_000;
const MAX_CAPTURE_BYTES = 1_048_576;
const MAX_PATCH_BYTES = 32 * 1024 * 1024;
const ARTIFACT_VERSION = 2;
const MAX_ARTIFACT_BYTES = 40 * 1024 * 1024;
const publicationLocks = new Map();

// Provider credentials are deliberately an explicit allowlist.  They are
// exposed only to the OpenCode provider child; Git, Bun, and the Action-bound
// CI process receive the sanitized environment instead.  Add a provider here
// only when its credential contract is known and covered by secret scanning.
const PROVIDER_ENV_KEYS = Object.freeze([
	'AI21_API_KEY',
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_BASE_URL',
	'AWS_ACCESS_KEY_ID',
	'AWS_DEFAULT_REGION',
	'AWS_REGION',
	'AWS_SECRET_ACCESS_KEY',
	'AWS_SESSION_TOKEN',
	'AZURE_API_KEY',
	'AZURE_OPENAI_API_KEY',
	'AZURE_OPENAI_ENDPOINT',
	'BRAVE_SEARCH_API_KEY',
	'CEREBRAS_API_KEY',
	'COHERE_API_KEY',
	'DEEPINFRA_API_KEY',
	'DEEPSEEK_API_KEY',
	'FIREWORKS_API_KEY',
	'GEMINI_API_KEY',
	'GOOGLE_API_KEY',
	'GOOGLE_GENERATIVE_AI_API_KEY',
	'GROQ_API_KEY',
	'MISTRAL_API_KEY',
	'OPENAI_API_KEY',
	'OPENAI_BASE_URL',
	'OPENROUTER_API_KEY',
	'OPENCODE_API_KEY',
	'PERPLEXITYAI_API_KEY',
	'SAMBANOVA_API_KEY',
	'TAVILY_API_KEY',
	'TOGETHER_API_KEY',
	'TOGETHER_AI_API_KEY',
	'XAI_API_KEY',
]);

// Child processes must not inherit the caller's ambient environment.  Keep
// this list deliberately boring: these values locate the runtime, workspace,
// and Action metadata, but do not grant registry, GitHub, or provider access.
// Provider credentials are added only by providerEnvironment() below.
const SAFE_CHILD_ENV_KEYS = Object.freeze([
	'CI',
	'ComSpec',
	'GITHUB_ACTION_PATH',
	'GITHUB_ACTION_REF',
	'GITHUB_API_URL',
	'GITHUB_ACTOR',
	'GITHUB_ACTOR_ID',
	'GITHUB_EVENT_NAME',
	'GITHUB_EVENT_PATH',
	'GITHUB_GRAPHQL_URL',
	'GITHUB_JOB',
	'GITHUB_REF',
	'GITHUB_REF_NAME',
	'GITHUB_REPOSITORY',
	'GITHUB_REPOSITORY_ID',
	'GITHUB_REPOSITORY_OWNER',
	'GITHUB_REPOSITORY_OWNER_ID',
	'GITHUB_RUN_ATTEMPT',
	'GITHUB_RUN_ID',
	'GITHUB_SERVER_URL',
	'GITHUB_SHA',
	'GITHUB_WORKFLOW',
	'GITHUB_WORKFLOW_REF',
	'GITHUB_WORKFLOW_SHA',
	'GITHUB_WORKSPACE',
	'HOME',
	'HOMEDRIVE',
	'HOMEPATH',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'NO_COLOR',
	'PATH',
	'Path',
	'PATHEXT',
	'PROCESSOR_ARCHITECTURE',
	'SYSTEMROOT',
	'SystemRoot',
	'TEMP',
	'TERM',
	'TERM_PROGRAM',
	'TMP',
	'TMPDIR',
	'TZ',
	'USERPROFILE',
	'WINDIR',
	'XDG_CACHE_HOME',
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
]);

// The test harness uses a closed set of non-secret fixture controls.  Keeping
// these explicit preserves deterministic fake binaries without reopening the
// ambient-environment boundary to arbitrary FAKE_* or custom variables.
const TEST_FIXTURE_ENV_KEYS = Object.freeze([
	'FAKE_AGENT_OUTPUT',
	'FAKE_ARGS_LOG',
	'FAKE_BUN_ARGS_LOG',
	'FAKE_BUN_ENV_LOG',
	'FAKE_BUN_VERSION',
	'FAKE_ENV_LOG',
	'FAKE_EVIDENCE',
	'FAKE_GH_LOG',
	'FAKE_GH_PR_AFTER_CREATE_JSON',
	'FAKE_GH_PR_JSON',
	'FAKE_GH_PR_LIST',
	'FAKE_GH_PR_URL',
	'FAKE_GH_STATE',
	'FAKE_ISSUE_TRACE',
	'FAKE_ISSUE_URL',
	'FAKE_NODE',
	'FAKE_OPENCODE_VERSION',
	'FAKE_RECEIPT_MODE',
	'FAKE_SCRIPT',
]);

export class ActionAbortError extends Error {
	constructor(message = 'Action run cancelled or deadline exceeded') {
		super(message);
		this.name = 'ActionAbortError';
	}
}

export class ProcessTimeoutError extends Error {
	constructor(message = 'subprocess deadline exceeded') {
		super(message);
		this.name = 'ProcessTimeoutError';
	}
}

function asText(value) {
	return typeof value === 'string' ? value : String(value ?? '');
}

function boundedText(value, limit = MAX_PUBLICATION_CHARS) {
	return asText(value)
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
		.slice(0, limit);
}

function redactText(value, secrets = []) {
	let result = boundedText(value);
	for (const secret of secrets) {
		if (typeof secret === 'string' && secret.length > 0) result = result.split(secret).join('[REDACTED]');
	}
	// Cover common credentials even when an adapter forgot to list one.  This
	// is intentionally conservative: publication evidence is bounded text, not
	// a transport for arbitrary binary data.
	return result
		.replace(/(?:ghp_|gho_|ghs_|ghr_|github_pat_|sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})[A-Za-z0-9_-]*/g, '[REDACTED:TOKEN]')
		.replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, 'Bearer [REDACTED:TOKEN]');
}

function redactValue(value, secrets, seen = new WeakSet()) {
	if (typeof value === 'string') return redactText(value, secrets);
	if (value === null || typeof value !== 'object') return value;
	if (seen.has(value)) return '[REDACTED:CYCLE]';
	seen.add(value);
	if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, secrets, seen));
	const output = {};
	for (const [key, item] of Object.entries(value).slice(0, 100)) output[key] = redactValue(item, secrets, seen);
	return output;
}

function validateRepository(repository) {
	return typeof repository === 'string' && /^[^/\s]+\/[^/\s]+$/.test(repository);
}

function validatePrepareInput(input) {
	if (!input || typeof input !== 'object') throw new TypeError('prepare input must be an object');
	if (!validateRepository(input.repository)) throw new TypeError('repository must be owner/name');
	if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) throw new TypeError('issueNumber must be a positive integer');
	for (const key of ['deliveryId', 'label', 'labeler', 'issueBody']) {
		if (typeof input[key] !== 'string' || input[key].length === 0) throw new TypeError(`${key} must be a non-empty string`);
	}
	if (input.issueUrl !== undefined && (typeof input.issueUrl !== 'string' || input.issueUrl !== `https://github.com/${input.repository}/issues/${input.issueNumber}`)) throw new TypeError('issueUrl must be the canonical GitHub issue URL');
	if (input.expectedIssueTrace !== undefined && (typeof input.expectedIssueTrace !== 'string' || input.expectedIssueTrace.length === 0)) throw new TypeError('expectedIssueTrace must be a non-empty string');
	if (input.providerSecret !== undefined && typeof input.providerSecret !== 'string') throw new TypeError('providerSecret must be a string');
	if (input.maxAttempts !== undefined && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)) throw new TypeError('maxAttempts must be a positive integer');
	if (input.deadlineMs !== undefined && (!Number.isFinite(input.deadlineMs) || input.deadlineMs < 1)) throw new TypeError('deadlineMs must be positive');
}

function boundedAttempts(input) {
	return Math.min(MAX_ATTEMPTS, Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
}

function boundedDeadline(input) {
	return Math.min(MAX_DEADLINE_MS, Math.max(1, input.deadlineMs ?? DEFAULT_DEADLINE_MS));
}

function validateDependencies(dependencies, names) {
	if (!dependencies || typeof dependencies !== 'object') throw new TypeError('dependencies must be an object');
	for (const name of names) if (typeof dependencies[name] !== 'function') throw new TypeError(`missing dependency: ${name}`);
}

function createRunController(sourceSignal, deadlineMs) {
	const controller = new AbortController();
	let reason = null;
	const abort = (value) => {
		if (!controller.signal.aborted) {
			reason = value instanceof Error ? value : new ActionAbortError(asText(value));
			controller.abort(reason);
		}
	};
	const onSourceAbort = () => abort(new ActionAbortError('Action run cancelled'));
	if (sourceSignal?.aborted) onSourceAbort();
	else sourceSignal?.addEventListener('abort', onSourceAbort, { once: true });
	const timer = setTimeout(() => abort(new ActionAbortError('Action run deadline exceeded')), deadlineMs);
	return {
		controller,
		startedAt: Date.now(),
		remaining: (startedAt) => Math.max(0, deadlineMs - (Date.now() - startedAt)),
		reason: () => reason,
		close: () => {
			clearTimeout(timer);
			sourceSignal?.removeEventListener('abort', onSourceAbort);
		},
	};
}

function throwIfAborted(signal, reason) {
	if (signal.aborted) throw reason() ?? new ActionAbortError();
}

function boundedAwait(operation, runState) {
	throwIfAborted(runState.controller.signal, runState.reason);
	const pending = Promise.resolve().then(operation);
	const aborted = new Promise((_, reject) => {
		const onAbort = () => {
			runState.controller.signal.removeEventListener('abort', onAbort);
			reject(runState.reason() ?? new ActionAbortError());
		};
		if (runState.controller.signal.aborted) onAbort();
		else runState.controller.signal.addEventListener('abort', onAbort, { once: true });
		pending.finally(() => runState.controller.signal.removeEventListener('abort', onAbort)).catch(() => {});
	});
	return Promise.race([pending, aborted]);
}

async function retryTransient(operation, input, dependencies, runState) {
	const attempts = boundedAttempts(input);
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		throwIfAborted(runState.controller.signal, runState.reason);
		try {
			return await boundedAwait(operation, runState);
		} catch (error) {
			if (runState.controller.signal.aborted) throw runState.reason() ?? new ActionAbortError();
			let transient = false;
			try { transient = dependencies.isTransient(error) === true; } catch { transient = false; }
			if (!transient || attempt >= attempts) throw error;
			const remaining = runState.remaining(runState.startedAt);
			if (remaining <= 1) throw new ActionAbortError('Action run deadline exceeded during retry');
			const delay = Math.min(250 * 2 ** (attempt - 1), remaining - 1);
			await dependencies.sleep(delay);
		}
	}
	throw new Error('unreachable retry state');
}

function stageContext(input) {
	return Object.freeze({
		repository: input.repository,
		issueNumber: input.issueNumber,
		deliveryId: input.deliveryId,
		untrustedIssueBody: input.issueBody,
	});
}

function normalizeArtifact(raw, input) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('artifact is not an object');
	if (raw.repository !== input.repository || raw.issueNumber !== input.issueNumber || raw.deliveryId !== input.deliveryId) {
		throw new Error('artifact identity does not match the prepare request');
	}
	if (typeof raw.baseSha !== 'string' || raw.baseSha.length === 0) throw new Error('artifact baseSha is missing');
	if (typeof input.baseSha === 'string' && raw.baseSha !== input.baseSha) throw new Error('artifact baseSha does not match the prepared workspace base');
	if (typeof raw.evidence !== 'string') throw new Error('artifact evidence is missing');
	return {
		repository: input.repository,
		issueNumber: input.issueNumber,
		deliveryId: input.deliveryId,
		baseSha: boundedText(raw.baseSha, 256),
		evidence: redactText(raw.evidence, [input.providerSecret]),
	};
}

/** Run the unprivileged phase and return only a bound, redacted artifact. */
export async function preparePublishGatedAction(input, dependencies) {
	validatePrepareInput(input);
	validateDependencies(dependencies, ['authorize', 'createRuntime', 'executeStage', 'evaluateGate', 'bindArtifact', 'isTransient', 'sleep']);
	let authorized = false;
	try { authorized = await dependencies.authorize(input) === true; } catch { authorized = false; }
	if (!authorized) return { status: 'denied' };

	const deadlineMs = boundedDeadline(input);
	const runState = createRunController(input.signal, deadlineMs);
	runState.startedAt = Date.now();
	let runtime;
	try {
		runtime = dependencies.createRuntime(input);
		validateDependencies(runtime, ['run', 'kill', 'cleanup']);
		// A production runtime is mutation-capable from its first invocation and
		// must never be replayed after a provider/process failure.  The legacy
		// injected test runtime remains retryable only when it does not opt into
		// the production marker; this keeps the pure adapter contract compatible
		// without weakening the real Action path.
		const run = () => runtime.run({ signal: runState.controller.signal, deadlineMs });
		if (runtime.mutationCapable === true) await boundedAwait(run, runState);
		else await retryTransient(run, input, dependencies, runState);
		const context = stageContext(input);
		for (const stage of PIPELINE_STAGES) {
			throwIfAborted(runState.controller.signal, runState.reason);
			await boundedAwait(() => dependencies.executeStage(stage, context), runState);
		}
		throwIfAborted(runState.controller.signal, runState.reason);
		const decision = await boundedAwait(() => dependencies.evaluateGate(context), runState);
		if (decision === 'oversight-denied') return { status: 'denied' };
		if (decision !== 'approved') return { status: 'failed' };
		const artifact = normalizeArtifact(await boundedAwait(() => dependencies.bindArtifact(input), runState), input);
		return redactValue(artifact, [input.providerSecret]);
	} catch (error) {
		// Cancellation/deadline is a control path for the caller to observe;
		// every other runtime/adapter failure is a fail-closed result.  In both
		// cases the finally block below owns process termination and cleanup.
		if (runState.controller.signal.aborted) throw runState.reason() ?? error;
		return { status: 'failed' };
	} finally {
		runState.close();
		if (runtime) {
			try { await runtime.kill(); } catch {}
			try { await runtime.cleanup(); } catch {}
		}
	}
}

function validatePublishInput(input) {
	if (!input || typeof input !== 'object') return false;
	if (typeof input.publicationToken !== 'string' || input.publicationToken.length === 0) return false;
	if (typeof input.expectedBaseSha !== 'string' || input.expectedBaseSha.length === 0) return false;
	const artifact = input.artifact;
	return Boolean(artifact && typeof artifact === 'object' && validateRepository(artifact.repository) && Number.isInteger(artifact.issueNumber) && artifact.issueNumber > 0 && typeof artifact.deliveryId === 'string' && artifact.deliveryId.length > 0 && typeof artifact.baseSha === 'string' && typeof artifact.evidence === 'string');
}

function publicationKey(input) {
	return createHash('sha256').update(`${input.artifact.repository}\0${input.artifact.issueNumber}\0${input.artifact.deliveryId}\0${input.artifact.baseSha}`).digest('hex');
}

function asReused(result) {
	if (result.status !== 'published') return result;
	return { ...result, status: 'reused' };
}

async function publishOnce(input, dependencies) {
	if (input.artifact.baseSha !== input.expectedBaseSha) return { status: 'failed' };
	let verified = false;
	try { verified = await dependencies.verifyArtifact(input) === true; } catch { verified = false; }
	if (!verified) return { status: 'failed' };
	let claim;
  try { claim = await dependencies.claimBranch({ repository: input.artifact.repository, issueNumber: input.artifact.issueNumber, deliveryId: input.artifact.deliveryId }); } catch { return { status: 'failed' }; }
	if (!claim || typeof claim.branch !== 'string' || (claim.state !== 'claimed' && claim.state !== 'existing')) return { status: 'failed' };
	if (claim.state === 'existing' && typeof claim.prUrl === 'string' && claim.prUrl.length > 0) {
		return { status: 'reused', publication: { branch: boundedText(claim.branch, 256), prUrl: boundedText(claim.prUrl, 2048), ...(Number.isInteger(claim.prNumber) ? { prNumber: claim.prNumber } : {}), evidence: redactText(input.artifact.evidence, [input.publicationToken]), summary: 'existing publication reused' } };
	}
	try {
		const publication = await dependencies.publish({ claim, publicationToken: input.publicationToken });
		if (!publication || typeof publication.branch !== 'string' || typeof publication.prUrl !== 'string' || publication.prUrl.length === 0) return { status: 'failed' };
		return { status: 'published', publication: redactValue({
			branch: publication.branch,
			prUrl: publication.prUrl,
			...(Number.isInteger(publication.prNumber) ? { prNumber: publication.prNumber } : {}),
			evidence: publication.evidence,
			summary: publication.summary,
		}, [input.publicationToken]) };
  } catch {
    return { status: 'failed' };
	}
}

/** Verify and atomically converge duplicate deliveries on one publication. */
export async function publishVerifiedAction(input, dependencies) {
	if (!validatePublishInput(input)) return { status: 'failed' };
	validateDependencies(dependencies, ['verifyArtifact', 'claimBranch', 'publish']);
	const key = publicationKey(input);
	const existing = publicationLocks.get(key);
	if (existing) {
		try { return asReused(await existing); } catch { return { status: 'failed' }; }
	}
	const current = publishOnce(input, dependencies);
	publicationLocks.set(key, current);
	try { return await current; } finally {
		if (publicationLocks.get(key) === current) publicationLocks.delete(key);
	}
}

/**
 * Bounded array-form child execution for Action adapters.  The function is
 * exported to keep subprocess behavior testable without reaching into the
 * orchestration policy.
 */
export function spawnBounded(command, args, options = {}) {
	if (typeof command !== 'string' || !Array.isArray(args)) throw new TypeError('spawnBounded requires array-form command arguments');
	const cwd = options.cwd;
	if (typeof cwd !== 'string' || cwd.length === 0) throw new TypeError('spawnBounded requires an explicit cwd');
	const requestedTimeout = Number(options.timeout ?? DEFAULT_DEADLINE_MS);
	if (!Number.isFinite(requestedTimeout) || requestedTimeout < 1) throw new TypeError('spawnBounded timeout must be a positive number');
	const timeout = Math.max(1, Math.min(MAX_DEADLINE_MS, requestedTimeout));
	const signal = options.signal;
	const childEnv = options.env ?? process.env;
	return new Promise((resolve, reject) => {
		let stdout = '';
		let stderr = '';
		let settled = false;
		let closed = false;
		let timer;
		let hardTimer;
		let timedOut = false;
		let reaping = false;
		let escalationPending = false;
		let closeResult;
		let child;
		try {
			child = spawn(command, args, {
				cwd,
				stdin: 'ignore',
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
				detached: process.platform !== 'win32',
				signal,
				env: childEnv,
			});
		} catch (error) {
			reject(error);
			return;
		}
		const captureLimit = Math.min(MAX_PATCH_BYTES, Math.max(1, Number(options.maxOutputBytes ?? MAX_CAPTURE_BYTES)));
		const append = (target, chunk) => {
			const combined = Buffer.concat([Buffer.from(target, 'utf8'), Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
			if (combined.length <= captureLimit) return { value: combined.toString('utf8'), truncated: false };
			return { value: combined.subarray(combined.length - captureLimit).toString('utf8'), truncated: true };
		};
		let stdoutTruncated = false;
		let stderrTruncated = false;
		child.stdout?.on('data', (chunk) => {
			const captured = append(stdout, chunk);
			stdout = captured.value;
			stdoutTruncated ||= captured.truncated;
		});
		child.stderr?.on('data', (chunk) => {
			const captured = append(stderr, chunk);
			stderr = captured.value;
			stderrTruncated ||= captured.truncated;
		});
		const killTree = (killSignal) => {
			if (closed && !reaping) return;
			try {
				if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, killSignal);
				else if (child.pid) {
					try { spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { cwd: dirname(process.execPath), stdio: 'ignore', windowsHide: true, timeout: 250 }); } catch {}
				}
				child.kill(killSignal);
			} catch {
				try { child.kill(); } catch {}
			}
		};
		const cleanup = () => {
			clearTimeout(timer);
			// A direct-child `close` event is not evidence that a detached
			// descendant is gone.  Once TERM/KILL escalation has been scheduled,
			// keep that timer alive even if the child has already closed.
			if (!escalationPending) clearTimeout(hardTimer);
			try { child.kill(); } catch {}
		};
		const finish = (error, result) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve({ ...result, stdout, stderr, stdoutTruncated, stderrTruncated });
		};
		const requestStop = () => {
			if (timedOut || settled) return;
			timedOut = true;
			reaping = true;
			escalationPending = true;
			// POSIX children are detached into a private process group.  First ask
			// the whole group to terminate, then issue a bounded SIGKILL if it has
			// not closed.  This is deliberately not a best-effort single-child kill:
			// an OpenCode provider/tool descendant must not survive cancellation.
			killTree('SIGTERM');
				hardTimer = setTimeout(() => {
					killTree('SIGKILL');
					escalationPending = false;
					finish(new ProcessTimeoutError());
			}, 250);
		};
		child.once('error', (error) => {
			if (timedOut || signal?.aborted) requestStop();
			else finish(error);
		});
		child.once('exit', (code) => {
			if (timedOut) return;
			// A direct child exit is not proof that its detached tool/provider
			// descendants stopped, regardless of the exit code. Reap the owned
			// process group before resolving so a background child cannot mutate the
			// workspace after a gate observed success or failure. Callers which
			// intentionally own a daemon must opt out.
			if (options.reapDescendantsOnSuccess !== false) {
				reaping = true;
				escalationPending = true;
				killTree('SIGTERM');
				// Do not resolve the child until the owned group has been given a
				// bounded TERM→KILL cleanup window. `close` only follows the direct
				// child's stdio; it does not prove a detached grandchild is gone.
				hardTimer = setTimeout(() => {
					killTree('SIGKILL');
					escalationPending = false;
					reaping = false;
					if (closeResult) finish(null, closeResult);
				}, 250);
			}
		});
		child.once('close', (code, signalName) => {
			closed = true;
			if (timedOut) closeResult = { code, signal: signalName, timedOut: true };
			else if (reaping) closeResult = { code, signal: signalName, timedOut: false };
			else finish(null, { code, signal: signalName, timedOut: false });
		});
		// A second bounded timer settles even if a child ignores SIGTERM.  The
		// first timer is intentionally shorter than the caller's total deadline;
		// cleanup never leaves the Action promise pending indefinitely.
		timer = setTimeout(requestStop, timeout);
		if (signal?.aborted) requestStop();
	});
}

export function stableRunKey({ repository, issueNumber, deliveryId, baseSha = '' }) {
	return createHash('sha256').update(`${repository}\0${issueNumber}\0${deliveryId}\0${baseSha}`).digest('hex').slice(0, 24);
}

function envText(name, fallback = '') {
	return typeof process.env[name] === 'string' ? process.env[name] : fallback;
}

function envInteger(name, fallback) {
	const value = Number(envText(name, String(fallback)));
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * An independent review is authoritative only when it has exactly one
 * unambiguous approval marker and the bounded process capture is complete.
 * Conflicting, repeated, truncated, or non-zero transcripts fail closed.
 */
export function isUnambiguousApproval(textParts, result = {}) {
	if (!Array.isArray(textParts) || result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) return false;
	const lines = textParts.join('\n').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const verdictLines = lines.filter((line) => /^VERDICT\s*:\s*(APPROVE|NEEDS_REVISION)$/i.test(line));
	return verdictLines.length === 1 && lines.at(-1) === verdictLines[0] && /^VERDICT\s*:\s*APPROVE$/i.test(verdictLines[0]);
}

function configuredProviderKeys() {
	const configured = envText('SWARM_ACTION_PROVIDER_ENV_KEYS')
		.split(/[\s,]+/)
		.filter(Boolean);
	if (configured.some((key) => !PROVIDER_ENV_KEYS.includes(key))) {
		throw new Error('SWARM_ACTION_PROVIDER_ENV_KEYS contains an unsupported provider environment key');
	}
	return [...new Set(configured)];
}

function configuredSecrets() {
	return [
		envText('SWARM_ACTION_PUBLICATION_TOKEN'),
		envText('SWARM_ACTION_PROVIDER_SECRET'),
		envText('GH_TOKEN'),
		envText('GITHUB_TOKEN'),
		...configuredProviderKeys().map((key) => process.env[key]),
	].filter((value, index, values) => typeof value === 'string' && value.length > 0 && values.indexOf(value) === index);
}

function sanitizedEnvironment(extraKeys = []) {
	const env = {};
	for (const key of [...SAFE_CHILD_ENV_KEYS, ...TEST_FIXTURE_ENV_KEYS, ...extraKeys]) {
		if (typeof process.env[key] === 'string') env[key] = process.env[key];
	}
	return env;
}

// Prepare has no publication authority. Keep this sanitizer narrow and
// reusable so every non-provider prepare child (Git/index inspection, Bun
// checks, and the Action-bound CI CLI) has no credential capability.
function prepareEnvironment() {
	return sanitizedEnvironment();
}

// OpenCode is the only prepare child that may need provider authentication.
// Credentials are copied into this one child-scoped environment from the
// explicit allowlist above; they are never placed in argv, Git config, or the
// transport artifact.  `SWARM_ACTION_PROVIDER_SECRET` remains scanner-only.
function providerEnvironment() {
	const env = sanitizedEnvironment();
	for (const key of configuredProviderKeys()) {
		const value = process.env[key];
		if (typeof value === 'string' && value.length > 0) env[key] = value;
	}
	return env;
}

function workspaceRoot() {
	return resolve(envText('GITHUB_WORKSPACE', process.cwd()));
}

export function safeArtifactPath(root, value) {
	const requested = value || '.swarm/github-action/artifact.json';
	if (isAbsolute(requested)) throw new Error('artifact-path must be relative to the workspace');
	let canonicalRoot;
	try { canonicalRoot = realpathSync(root); } catch { throw new Error('workspace root is missing or unsafe'); }
	const target = resolve(canonicalRoot, requested);
	const rel = relative(canonicalRoot, target).replaceAll('\\', '/');
	if (!rel || rel.startsWith('../') || rel.includes('/../') || rel === '.swarm' || !rel.startsWith('.swarm/')) {
		throw new Error('artifact-path must remain under .swarm/');
	}
	let current = canonicalRoot;
	for (const component of rel.split('/')) {
		current = join(current, component);
		try {
			const stat = lstatSync(current);
			if (stat.isSymbolicLink()) throw new Error('artifact-path contains a symbolic-link component');
			const real = realpathSync(current);
			const normalizePath = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
			if (normalizePath(resolve(real)) !== normalizePath(resolve(current))) throw new Error('artifact-path contains a redirected path component');
		} catch (error) {
			if (error?.code === 'ENOENT') break;
			throw error;
		}
	}
	return target;
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

function contentTreeDigest(lsTreeOutput) {
	const entries = asText(lsTreeOutput).split('\0').filter(Boolean).map((entry) => {
		const separator = entry.indexOf('\t');
		// Keep the complete `git ls-tree` record.  Its pre-tab fields bind the
		// mode, object type, and object id; the post-tab field binds the path.
		// Stripping the mode makes a mode-only remote substitution invisible.
		return separator < 0 ? entry : `${entry.slice(0, separator)}\t${entry.slice(separator + 1)}`;
	}).sort();
	return sha256(Buffer.from(entries.join('\0'), 'utf8'));
}

function canonicalJson(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function safeRelativePath(root, value) {
	if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || isAbsolute(value)) return false;
	const normalized = normalize(value).replaceAll('\\', '/');
	return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../') && !normalized.includes('/../') && !normalized.startsWith('.git/') && normalized !== '.git' && !normalized.startsWith('.swarm/') && normalized !== '.swarm' && resolve(root, value).startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`);
}

function safeBranchName(value) {
	return typeof value === 'string' && value.length > 0 && value.length <= 255
		&& !/[\s\u0000-\u001f\u007f~^:?*\\]/.test(value)
		&& !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.')
		&& !value.includes('..') && !value.includes('@{') && !value.split('/').some((part) => part.length === 0 || part === '.');
}

function runIdentity() {
	return {
		runId: envText('GITHUB_RUN_ID', envText('SWARM_ACTION_EXPECTED_RUN_ID', 'local-run')),
		runAttempt: envText('GITHUB_RUN_ATTEMPT', envText('SWARM_ACTION_RUN_ATTEMPT', '1')),
	};
}

function toolBindings() {
	return {
		opencodeVersion: envText('SWARM_ACTION_OPENCODE_VERSION'),
		bunVersion: envText('SWARM_ACTION_BUN_VERSION'),
		pluginRef: envText('SWARM_ACTION_PLUGIN_REF').toLowerCase(),
		ciRuntime: 'action-bound-dist-cli',
		model: envText('SWARM_ACTION_MODEL', 'opencode/big-pickle'),
		agent: envText('SWARM_ACTION_AGENT', 'architect'),
	};
}

function actionBoundCiCli() {
	const actionPath = envText('GITHUB_ACTION_PATH');
	if (!actionPath || !isAbsolute(actionPath)) throw new Error('GITHUB_ACTION_PATH is required to bind the Action CI CLI');
	const actionRoot = realpathSync(resolve(actionPath));
	const expected = join(actionRoot, 'dist', 'cli', 'index.js');
	const configured = envText('SWARM_ACTION_CI_BIN');
	if (configured && resolve(configured) !== expected) throw new Error('SWARM_ACTION_CI_BIN must be the Action-bound dist/cli/index.js');
	const stat = lstatSync(expected);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Action-bound CI CLI is missing or unsafe');
	return expected;
}

function secretFindings(value, secrets = []) {
	const bytes = Buffer.isBuffer(value) ? value : Buffer.from(asText(value), 'utf8');
	const text = bytes.toString('latin1');
	const findings = [];
	for (const secret of secrets) {
		if (typeof secret !== 'string' || secret.length < 4) continue;
		const rawSecret = Buffer.from(secret, 'utf8');
		// Candidate files are scanned after decoding from the Git transport, so
		// a binary blob cannot evade this check merely because its textual patch
		// representation uses Git's binary encoding.  Keep base64 detection for
		// textual evidence/PR surfaces where a secret may have been re-encoded.
		if (bytes.indexOf(rawSecret) >= 0 || text.includes(rawSecret.toString('base64'))) findings.push('configured-secret');
	}
	if (/(?:ghp_|gho_|ghs_|ghr_|github_pat_|sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})[A-Za-z0-9_-]*/.test(text)) findings.push('credential-shaped-token');
	if (/Bearer\s+[A-Za-z0-9._~+\-/]+=*/i.test(text)) findings.push('bearer-token');
	return [...new Set(findings)];
}

function assertSecretFree(value, secrets) {
	const findings = secretFindings(value, secrets);
	if (findings.length > 0) throw new Error(`publication surface contains secrets (${findings.join(',')})`);
}

async function gitCommand(root, args, options = {}) {
	const result = await spawnBounded('git', args, {
		cwd: root,
		timeout: options.timeout,
		signal: options.signal,
		env: options.env,
		maxOutputBytes: options.maxOutputBytes,
	});
	if (options.requireCompleteOutput && (result.stdoutTruncated || result.stderrTruncated)) {
		throw new Error(`git ${args[0] ?? 'command'} output exceeded its capture bound`);
	}
	if (result.code !== 0) {
		const detail = redactText(result.stderr || result.stdout, configuredSecrets()).slice(0, 400);
		throw new Error(`git ${args[0] ?? 'command'} failed${detail ? `: ${detail}` : ''}`);
	}
	return result;
}

async function collectCanonicalTransport(root, input, signal, timeoutMs, secrets, baseEnv = prepareEnvironment()) {
	const temp = mkdtempSync(join(tmpdir(), 'swarm-action-index-'));
	const index = join(temp, 'index');
	const env = { ...baseEnv, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0' };
	try {
		const head = (await gitCommand(root, ['rev-parse', 'HEAD'], { timeout: timeoutMs, signal, env })).stdout.trim();
		if (head !== input.baseSha) throw new Error('workspace HEAD does not match the requested base SHA');
		const tree = (await gitCommand(root, ['rev-parse', 'HEAD^{tree}'], { timeout: timeoutMs, signal, env })).stdout.trim();
		const indexPathResult = await gitCommand(root, ['rev-parse', '--git-path', 'index'], { timeout: timeoutMs, signal, env: { ...baseEnv, GIT_OPTIONAL_LOCKS: '0' } });
		const sourceIndex = resolve(root, indexPathResult.stdout.trim());
		if (existsSync(sourceIndex)) copyFileSync(sourceIndex, index);
		else await gitCommand(root, ['read-tree', 'HEAD'], { timeout: timeoutMs, signal, env });
		await gitCommand(root, ['add', '-A', '--', '.', ':(exclude).git/**', ':(exclude).swarm/**'], { timeout: timeoutMs, signal, env });
		const patch = await gitCommand(root, ['diff', '--cached', '--binary', '--full-index', '--find-renames', '--find-copies', 'HEAD', '--', '.', ':(exclude).git/**', ':(exclude).swarm/**'], { timeout: timeoutMs, signal, env, maxOutputBytes: MAX_PATCH_BYTES, requireCompleteOutput: true });
		const patchBytes = Buffer.from(patch.stdout, 'utf8');
		if (patchBytes.length === 0) throw new Error('prepare produced no transportable workspace changes');
		if (patchBytes.length > MAX_PATCH_BYTES) throw new Error('transport exceeds the Action artifact bound');
		const names = await gitCommand(root, ['diff', '--cached', '--name-only', '-z', '--find-renames', 'HEAD', '--', '.', ':(exclude).git/**', ':(exclude).swarm/**'], { timeout: timeoutMs, signal, env, maxOutputBytes: MAX_CAPTURE_BYTES, requireCompleteOutput: true });
		const paths = names.stdout.split('\0').filter(Boolean);
		if (paths.length === 0 || paths.some((file) => !safeRelativePath(root, file))) throw new Error('transport contains an unsafe path');
		// A deleted path has no working-tree bytes left to inspect.  Resolve the
		// complete base tree first, then scan each changed path's base blob before
		// the patch becomes durable.  The bounded, complete capture is important:
		// truncation must fail closed rather than create an artifact whose deleted
		// content was only partially checked.
		const baseTree = await gitCommand(root, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], { timeout: timeoutMs, signal, env, maxOutputBytes: MAX_PATCH_BYTES, requireCompleteOutput: true });
		const basePaths = new Set(baseTree.stdout.split('\0').filter(Boolean).map((entry) => {
			const separator = entry.indexOf('\t');
			return separator < 0 ? '' : entry.slice(separator + 1);
		}).filter(Boolean));
		for (const file of [...new Set(paths)]) {
			if (!basePaths.has(file)) continue;
			const baseBlob = await gitCommand(root, ['show', `HEAD:${file}`], { timeout: timeoutMs, signal, env, maxOutputBytes: MAX_PATCH_BYTES, requireCompleteOutput: true });
			assertSecretFree(Buffer.from(baseBlob.stdout, 'utf8'), secrets);
		}
		for (const file of [...new Set(paths)]) {
			const candidate = join(root, file);
			try {
				const stat = lstatSync(candidate);
				if (stat.isFile()) assertSecretFree(readFileSync(candidate), secrets);
				else if (stat.isSymbolicLink()) assertSecretFree(Buffer.from(readlinkSync(candidate), 'utf8'), secrets);
			} catch (error) {
				// A deleted path has no target content to scan.  Any other failure is
				// an unsafe/ambiguous candidate and must not become an artifact.
				if (existsSync(candidate)) throw error;
			}
		}
		const patchBase64 = patchBytes.toString('base64');
		const targetTree = (await gitCommand(root, ['write-tree'], { timeout: timeoutMs, signal, env })).stdout.trim();
		const targetContentSha256 = contentTreeDigest((await gitCommand(root, ['ls-tree', '-r', '-z', targetTree], { timeout: timeoutMs, signal, env, maxOutputBytes: MAX_PATCH_BYTES, requireCompleteOutput: true })).stdout);
		const transport = {
			version: ARTIFACT_VERSION,
			format: 'git-binary-patch',
			baseSha: head,
			baseTreeSha: tree,
			targetTreeSha: targetTree,
			targetContentSha256,
			patchBase64,
			patchSha256: sha256(patchBytes),
			paths: [...new Set(paths)].sort(),
		};
		assertSecretFree(patchBytes, secrets);
		return transport;
	} finally {
		try { rmSync(temp, { recursive: true, force: true }); } catch {}
	}
}

function canonicalArtifactPayload(input, artifact, transport, state, secrets) {
	const identity = { ...runIdentity(), ...toolBindings() };
	const evidence = redactText(JSON.stringify({
		version: ARTIFACT_VERSION,
		stages: state.stageRecords ?? PIPELINE_STAGES.map((stage) => ({ stage, status: 'passed' })),
		gate: state.gateDecision ?? 'approved',
		evidence: artifact.evidence,
	}), secrets, MAX_PUBLICATION_CHARS);
	assertSecretFree(evidence, secrets);
	const bindings = {
		repository: input.repository,
		issueNumber: input.issueNumber,
		deliveryId: input.deliveryId,
		baseSha: artifact.baseSha,
		baseBranch: input.baseBranch,
		issueTrace: input.expectedIssueTrace,
		reviewSession: state.reviewEvidence?.parentSession,
		reviewTranscriptSha256: state.reviewEvidence?.traceTranscriptSha256,
		reviewTreeSha: state.reviewEvidence?.targetTreeSha,
		...identity,
	};
	const runKey = stableRunKey({ ...artifact });
	const payloadWithoutDigest = { version: ARTIFACT_VERSION, runKey, repository: input.repository, issueNumber: input.issueNumber, deliveryId: input.deliveryId, baseSha: artifact.baseSha, bindings, artifact, transport, evidence, gateDecision: state.gateDecision ?? 'approved', oversightStatus: state.oversightStatus ?? 'pending' };
	return {
		...payloadWithoutDigest,
		artifactDigest: sha256(canonicalJson(payloadWithoutDigest)),
	};
}

function verifyCanonicalArtifactPayload(payload, root, input, expectedBaseSha) {
	if (!payload || payload.version !== ARTIFACT_VERSION || !payload.bindings || !payload.transport || !payload.artifact) throw new Error('unsupported or malformed Action artifact');
	const digest = payload.artifactDigest;
	const unsigned = { version: payload.version, runKey: payload.runKey, repository: payload.repository, issueNumber: payload.issueNumber, deliveryId: payload.deliveryId, baseSha: payload.baseSha, bindings: payload.bindings, artifact: payload.artifact, transport: payload.transport, evidence: payload.evidence, gateDecision: payload.gateDecision, oversightStatus: payload.oversightStatus };
	if (typeof digest !== 'string' || sha256(canonicalJson(unsigned)) !== digest) throw new Error('Action artifact digest mismatch');
	const bindings = payload.bindings;
	if (payload.repository !== input.repository || payload.issueNumber !== input.issueNumber || payload.deliveryId !== input.deliveryId || payload.baseSha !== expectedBaseSha) throw new Error('Action artifact top-level binding mismatch');
	if (payload.artifact.repository !== payload.repository || payload.artifact.issueNumber !== payload.issueNumber || payload.artifact.deliveryId !== payload.deliveryId || payload.artifact.baseSha !== payload.baseSha) throw new Error('Action artifact nested binding mismatch');
	if (bindings.repository !== input.repository || bindings.issueNumber !== input.issueNumber || bindings.deliveryId !== input.deliveryId || bindings.baseSha !== expectedBaseSha || bindings.baseBranch !== envText('SWARM_ACTION_BASE_BRANCH') || !safeBranchName(bindings.baseBranch)) throw new Error('Action artifact identity or base binding mismatch');
	if (bindings.issueTrace !== envText('SWARM_ACTION_ISSUE_TRACE')) throw new Error('Action artifact issue-tracer binding mismatch');
	if (typeof bindings.reviewSession !== 'string' || !/^[0-9a-f]{64}$/.test(asText(bindings.reviewTranscriptSha256)) || bindings.reviewTreeSha !== payload.transport.targetTreeSha) throw new Error('Action artifact review/tree binding mismatch');
	const expectedRunId = envText('SWARM_ACTION_EXPECTED_RUN_ID');
	if (expectedRunId && bindings.runId !== expectedRunId) throw new Error('Action artifact run binding mismatch');
	const expectedAttempt = envText('GITHUB_RUN_ATTEMPT', envText('SWARM_ACTION_RUN_ATTEMPT'));
	if (expectedAttempt && bindings.runAttempt !== expectedAttempt) throw new Error('Action artifact attempt binding mismatch');
	const pins = toolBindings();
	const requiredOpenCode = exactVersion(pins.opencodeVersion, 'opencode-version');
	const requiredBun = exactVersion(pins.bunVersion, 'bun-version');
	const requiredPluginRef = immutableCommit(pins.pluginRef, 'plugin-ref');
	if (envText('GITHUB_ACTION_REF').toLowerCase() !== requiredPluginRef) throw new Error('publisher Action ref does not match the immutable plugin binding');
	if (bindings.opencodeVersion !== requiredOpenCode || bindings.bunVersion !== requiredBun || bindings.pluginRef !== requiredPluginRef || bindings.ciRuntime !== pins.ciRuntime || bindings.model !== pins.model || bindings.agent !== pins.agent) throw new Error('Action artifact tool binding mismatch');
	const transport = payload.transport;
	if (transport.version !== ARTIFACT_VERSION || transport.baseSha !== expectedBaseSha || !/^[0-9a-f]{40}$/i.test(asText(transport.targetTreeSha)) || !Array.isArray(transport.paths) || transport.paths.some((file) => !safeRelativePath(root, file))) throw new Error('Action artifact transport binding is invalid');
	const patchBytes = Buffer.from(asText(transport.patchBase64), 'base64');
	if (patchBytes.length === 0 || patchBytes.length > MAX_PATCH_BYTES || sha256(patchBytes) !== transport.patchSha256 || !/^[0-9a-f]{64}$/.test(asText(transport.targetContentSha256))) throw new Error('Action artifact transport digest mismatch');
	return { ...payload, patchBytes };
}

function writeActionOutputs(values) {
	const outputFile = envText('GITHUB_OUTPUT');
	const lines = [];
	for (const [key, value] of Object.entries(values)) {
		const delimiter = `swarm_${createHash('sha256').update(`${key}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16)}`;
		lines.push(`${key}<<${delimiter}\n${boundedText(value, 16_000)}\n${delimiter}`);
	}
	if (outputFile) appendFileSync(outputFile, `${lines.join('\n')}\n`, 'utf8');
	const summaryFile = envText('GITHUB_STEP_SUMMARY');
	if (summaryFile) {
		const summary = Object.entries(values).map(([key, value]) => `- ${key}: ${boundedText(value, 2_000)}`).join('\n');
		appendFileSync(summaryFile, `### Gated Swarm Action\n${summary}\n`, 'utf8');
	}
}

function writeArtifactFile(file, payload) {
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
	try { renameSync(temporary, file); } catch (renameError) {
		try {
			// Windows cannot atomically replace an existing file with renameSync.
			writeFileSync(file, readFileSync(temporary), { encoding: 'utf8', mode: 0o600 });
		} catch {
			throw renameError;
		} finally {
			try { unlinkSync(temporary); } catch {}
		}
	}
}

export function readArtifactFile(file) {
	const stat = lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('prepare artifact must be a regular non-symlink file');
	if (stat.size > MAX_ARTIFACT_BYTES) throw new Error('prepare artifact exceeds the bounded transport size');
	const raw = readFileSync(file);
	if (raw.length > MAX_ARTIFACT_BYTES) throw new Error('prepare artifact exceeds the bounded transport size');
	const parsed = JSON.parse(raw.toString('utf8'));
	if (!parsed || typeof parsed !== 'object' || !parsed.artifact) throw new Error('malformed prepare artifact');
	return parsed;
}

function immutableCommit(value, label) {
	if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${label} must be an immutable 40-character commit SHA`);
	return value.toLowerCase();
}

function exactVersion(value, label) {
	if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) throw new Error(`${label} must be an exact semantic version`);
	return value;
}

function canonicalIssueUrl(input) {
	const expected = `https://github.com/${input.repository}/issues/${input.issueNumber}`;
	if (input.issueUrl !== undefined && input.issueUrl !== expected) throw new Error('issue URL is not the canonical repository issue URL');
	return expected;
}

function parseOpenCodeEvents(stdout) {
	const events = [];
	for (const line of asText(stdout).split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event && typeof event === 'object') events.push(event);
		} catch {
			throw new Error('OpenCode JSON output contained a non-JSON line');
		}
	}
	if (events.length === 0) throw new Error('OpenCode JSON output was empty');
	const sessionIds = [...new Set(events.map((event) => event.sessionID).filter((id) => typeof id === 'string' && id.length > 0))];
	if (sessionIds.length !== 1) throw new Error('OpenCode JSON output did not bind one session');
	const textParts = events
		.filter((event) => event.part?.type === 'text' && typeof event.part.text === 'string')
		.map((event) => event.part.text);
	if (textParts.length === 0) throw new Error('OpenCode JSON output contained no text parts');
	return { sessionId: sessionIds[0], textParts };
}

function safeReceiptPath(root, relativePath) {
	const file = safeArtifactPath(root, relativePath);
	let stat;
	try { stat = lstatSync(file); } catch (error) {
		if (error?.code === 'ENOENT') return file;
		throw new Error('durable receipt is inaccessible');
	}
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('durable receipt must be a regular non-symlink file');
	if (stat.size > MAX_ARTIFACT_BYTES) throw new Error('durable receipt exceeds the bounded transport size');
	return file;
}

function readJsonObject(root, relativePath, label) {
	const file = safeReceiptPath(root, relativePath);
	let stat;
	try { stat = lstatSync(file); } catch { throw new Error(`${label} is missing or malformed`); }
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARTIFACT_BYTES) throw new Error(`${label} is missing or malformed`);
	let value;
	try {
		const raw = readFileSync(file);
		if (raw.length > MAX_ARTIFACT_BYTES) throw new Error('oversized');
		value = JSON.parse(raw.toString('utf8'));
	} catch { throw new Error(`${label} is missing or malformed`); }
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is malformed`);
	return value;
}

function requireIssueIngestTransition(root, input) {
	const reference = readJsonObject(root, '.swarm/issue-reference.json', 'issue trace reference');
	const state = readJsonObject(root, '.swarm/issue-trace-state.json', 'issue trace state');
	if (reference.url !== canonicalIssueUrl(input) || reference.owner !== input.repository.split('/')[0] || reference.repo !== input.repository.split('/')[1] || reference.number !== input.issueNumber || reference.flags?.trace !== true) {
		throw new Error('durable issue trace reference is not bound to the requested canonical issue');
	}
	if (state.issueNumber !== input.issueNumber || state.lastTransition !== 'ISSUE_INGEST_TO_PLAN' || state.status !== 'in_progress') {
		throw new Error('durable issue trace did not reach ISSUE_INGEST_TO_PLAN');
	}
}

function requireDurableTraceCompletion(root, input, reviewEvidence, targetTreeSha) {
	const state = readJsonObject(root, '.swarm/issue-trace-state.json', 'issue trace state');
	const review = readJsonObject(root, '.swarm/implementation-review.json', 'implementation review receipt');
	const recurrence = readJsonObject(root, '.swarm/recurrence-sweep.json', 'recurrence sweep receipt');
	const transcript = readJsonObject(root, '.swarm/github-action/review-transcript.json', 'review transcript evidence');
	if (state.issueNumber !== input.issueNumber || state.lastTransition !== 'EXECUTE_TO_COMMIT' || state.status !== 'publication_handoff') throw new Error('durable issue trace did not reach the publication handoff gate');
	if (!reviewEvidence || reviewEvidence.targetTreeSha !== targetTreeSha || !/^[0-9a-f]{64}$/.test(asText(reviewEvidence.traceTranscriptSha256))) throw new Error('review evidence is not bound to the nested issue trace and candidate tree');
	if (review.issueNumber !== input.issueNumber || review.issueTrace !== input.expectedIssueTrace || review.reviewerVerdict !== 'APPROVE' || review.criticVerdict !== 'APPROVE' || review.diffBase !== input.baseSha || review.diffHead !== targetTreeSha || review.sessionId !== reviewEvidence.parentSession || typeof review.timestamp !== 'string' || Number.isNaN(Date.parse(review.timestamp)) || typeof review.notes !== 'string' || review.notes.trim().length < 8) throw new Error('durable authoritative implementation-review receipt is incomplete or unbound');
	const recurrenceComplete = recurrence.defectClass === 'no defect class'
		? typeof recurrence.justification === 'string' && recurrence.justification.trim().length > 0
		: Array.isArray(recurrence.predicates) && recurrence.predicates.length > 0 && Array.isArray(recurrence.dispositions) && recurrence.dispositions.length > 0 && recurrence.guardrail && typeof recurrence.guardrail === 'object';
	if (recurrence.issueNumber !== input.issueNumber || recurrence.issueTrace !== input.expectedIssueTrace || recurrence.sessionId !== reviewEvidence.parentSession || typeof recurrence.timestamp !== 'string' || Number.isNaN(Date.parse(recurrence.timestamp)) || !recurrenceComplete) throw new Error('durable recurrence sweep receipt is not bound to the architect session');
	if (!Array.isArray(reviewEvidence.nested) || reviewEvidence.nested.length !== 2 || reviewEvidence.nested.some((entry) => !entry || typeof entry.agent !== 'string' || typeof entry.sessionId !== 'string' || entry.sessionId === reviewEvidence.parentSession || !/^[0-9a-f]{64}$/.test(entry.textSha256))) throw new Error('independent nested review transcript proof is incomplete');
	if (new Set(reviewEvidence.nested.map((entry) => entry.sessionId)).size !== 2) throw new Error('nested reviewer and critic sessions are not independent');
	if (transcript.version !== 1 || transcript.issueNumber !== input.issueNumber || transcript.issueUrl !== canonicalIssueUrl(input) || transcript.baseSha !== input.baseSha || transcript.targetTreeSha !== targetTreeSha || transcript.parentSession !== reviewEvidence.parentSession || transcript.traceTranscriptSha256 !== reviewEvidence.traceTranscriptSha256 || JSON.stringify(transcript.nested) !== JSON.stringify(reviewEvidence.nested)) throw new Error('review transcript provenance is missing or unbound');
}

async function candidateTreeSha(root, input, signal, timeoutMs, baseEnv = prepareEnvironment()) {
	const temp = mkdtempSync(join(tmpdir(), 'swarm-action-review-index-'));
	const index = join(temp, 'index');
	const env = { ...baseEnv, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0' };
	try {
		const head = (await gitCommand(root, ['rev-parse', 'HEAD'], { timeout: timeoutMs, signal, env })).stdout.trim();
		if (head !== input.baseSha) throw new Error('workspace HEAD changed before independent review');
		const indexPathResult = await gitCommand(root, ['rev-parse', '--git-path', 'index'], { timeout: timeoutMs, signal, env: { ...baseEnv, GIT_OPTIONAL_LOCKS: '0' } });
		const sourceIndex = resolve(root, indexPathResult.stdout.trim());
		if (existsSync(sourceIndex)) copyFileSync(sourceIndex, index);
		else await gitCommand(root, ['read-tree', 'HEAD'], { timeout: timeoutMs, signal, env });
		await gitCommand(root, ['add', '-A', '--', '.', ':(exclude).git/**', ':(exclude).swarm/**'], { timeout: timeoutMs, signal, env });
		return (await gitCommand(root, ['write-tree'], { timeout: timeoutMs, signal, env })).stdout.trim();
	} finally {
		try { rmSync(temp, { recursive: true, force: true }); } catch {}
	}
}

function writeReviewTranscriptEvidence(root, input, evidence) {
	const file = safeReceiptPath(root, '.swarm/github-action/review-transcript.json');
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ version: 1, issueNumber: input.issueNumber, issueUrl: canonicalIssueUrl(input), traceTranscriptSha256: evidence.traceTranscriptSha256, baseSha: input.baseSha, targetTreeSha: evidence.targetTreeSha, parentSession: evidence.parentSession, nested: evidence.nested }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function verifyActualToolBindings(root, opencode, expectedVersion, expectedPluginRef, signal, timeout, env) {
	const opencodeVersion = exactVersion(expectedVersion, 'opencode-version');
	const pluginRef = immutableCommit(expectedPluginRef, 'plugin-ref');
	const version = await spawnBounded(opencode, ['--version'], { cwd: root, timeout, signal, env });
	if (version.code !== 0 || version.stdout.trim() !== opencodeVersion) throw new Error('installed OpenCode version does not match the pinned Action input');
	// GitHub resolves a composite Action into an extracted action directory, not
	// necessarily a Git checkout.  `github.action_ref` is the host-provided
	// resolved ref for the running composite Action; action.yml injects it as
	// GITHUB_ACTION_REF.  Require an immutable match rather than treating an
	// arbitrary caller assertion or an absent .git directory as provenance.
	if (asText(env?.GITHUB_ACTION_REF).toLowerCase() !== pluginRef) throw new Error('host-resolved Action/plugin ref does not match plugin-ref');
	actionBoundCiCli();
	return { opencodeVersion, pluginRef };
}

async function verifyActualBunBinding(root, bun, expectedVersion, signal, timeout, env) {
	const bunVersion = exactVersion(expectedVersion, 'bun-version');
	const version = await spawnBounded(bun, ['--version'], { cwd: root, timeout, signal, env });
	if (version.code !== 0 || version.stdout.trim() !== bunVersion) throw new Error('installed Bun version does not match the pinned Action input');
	return bunVersion;
}

async function verifyAndApplyCanonicalTransport(root, payload, input, signal, timeoutMs) {
	const verified = verifyCanonicalArtifactPayload(payload, root, input, input.expectedBaseSha);
	const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
	const head = (await gitCommand(root, ['rev-parse', 'HEAD'], { timeout: timeoutMs, signal, env })).stdout.trim();
	const tree = (await gitCommand(root, ['rev-parse', 'HEAD^{tree}'], { timeout: timeoutMs, signal, env })).stdout.trim();
	if (head !== input.expectedBaseSha || tree !== verified.transport.baseTreeSha) throw new Error('publisher checkout is not the bound base revision');
	const status = await gitCommand(root, ['status', '--porcelain=v1', '-z'], { timeout: timeoutMs, signal, env });
  const dirty = status.stdout.split('\0').filter(Boolean).map((entry) => entry.slice(3)).filter((file) => file && file !== '.swarm' && !file.startsWith('.swarm/'));
  if (dirty.length > 0) throw new Error('publisher checkout is unexpectedly dirty');
	const temp = mkdtempSync(join(tmpdir(), 'swarm-action-patch-'));
	const patchFile = join(temp, 'transport.patch');
	try {
		writeFileSync(patchFile, verified.patchBytes, { encoding: 'utf8', mode: 0o600 });
		await gitCommand(root, ['apply', '--check', '--binary', '--whitespace=nowarn', patchFile], { timeout: timeoutMs, signal, env });
		await gitCommand(root, ['apply', '--index', '--binary', '--whitespace=nowarn', patchFile], { timeout: timeoutMs, signal, env });
		return verified;
	} finally {
		try { rmSync(temp, { recursive: true, force: true }); } catch {}
	}
}

function localBinary(name) {
	return process.platform === 'win32' ? `${name}.cmd` : name;
}

function trustedPrepareDependencies(input, root) {
	const state = { agentOutput: '', gateOutput: '', signal: undefined, sessionId: '', traceTranscriptSha256: '', stageRecords: [], gateDecision: 'pending', oversightStatus: 'protected-environment-required', startedAt: Date.now(), bindingsVerified: false, reviewEvidence: null };
	const model = envText('SWARM_ACTION_MODEL', 'opencode/big-pickle');
	const agent = envText('SWARM_ACTION_AGENT', 'architect');
	const reviewerAgent = envText('SWARM_ACTION_REVIEWER_AGENT', 'reviewer');
	const opencode = envText('SWARM_ACTION_OPENCODE_BIN', localBinary('opencode'));
	const prepareEnv = prepareEnvironment();
	const providerEnv = providerEnvironment();
	const remainingTimeout = () => Math.max(1, input.deadlineMs - (Date.now() - state.startedAt));
	const recordOpenCode = (result, expectedSession = undefined, requireTraceMarker = false) => {
		if (result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) throw new Error('OpenCode issue trace command failed or produced incomplete output');
		const parsed = parseOpenCodeEvents(result.stdout);
		if (expectedSession && parsed.sessionId !== expectedSession) throw new Error('OpenCode continuation did not retain the issue-trace session');
		const traceParts = parsed.textParts.filter((text) => text.includes(input.expectedIssueTrace));
		if (requireTraceMarker && traceParts.length === 0) throw new Error('OpenCode nested transcript did not prove the expected issue trace');
		if (traceParts.length > 0) state.traceTranscriptSha256 = sha256(traceParts.join('\n'));
		state.agentOutput = `${state.agentOutput}\n${parsed.textParts.join('\n')}`;
		return parsed;
	};
	const startIssueTrace = async () => {
		const args = ['run', '--format', 'json', '--model', model, '--agent', agent, '--command', 'swarm', '--dir', root, '--', 'issue', canonicalIssueUrl(input), '--trace'];
		const result = await spawnBounded(opencode, args, { cwd: root, timeout: remainingTimeout(), signal: state.signal, env: providerEnv });
		state.sessionId = recordOpenCode(result, undefined, true).sessionId;
		requireIssueIngestTransition(root, input);
	};
	const continueIssueTrace = async () => {
		if (!state.sessionId) throw new Error('cannot continue an unbound OpenCode issue trace session');
		const result = await spawnBounded(opencode, ['run', '--format', 'json', '--model', model, '--agent', agent, '--session', state.sessionId, '--dir', root, 'Continue the active issue trace.'], { cwd: root, timeout: remainingTimeout(), signal: state.signal, env: providerEnv });
		recordOpenCode(result, state.sessionId);
	};
	const runIndependentReview = async (reviewAgent, role) => {
		const result = await spawnBounded(opencode, ['run', '--format', 'json', '--model', model, '--agent', reviewAgent, '--dir', root, `Independently ${role} the implementation for ${canonicalIssueUrl(input)}. Return a bounded VERDICT: APPROVE or NEEDS_REVISION with evidence; do not mutate trace receipts.`], { cwd: root, timeout: remainingTimeout(), signal: state.signal, env: providerEnv });
		const parsed = parseOpenCodeEvents(result.stdout);
		if (parsed.sessionId === state.sessionId || !isUnambiguousApproval(parsed.textParts, result)) throw new Error('independent nested reviewer transcript is not an approving fresh review');
		state.agentOutput = `${state.agentOutput}\n${parsed.textParts.join('\n')}`;
		return { agent: reviewAgent, sessionId: parsed.sessionId, textSha256: sha256(parsed.textParts.join('\n')) };
	};
	const recordAuthoritativeReview = async (targetTreeSha) => {
		const result = await spawnBounded(opencode, ['run', '--format', 'json', '--model', model, '--agent', agent, '--session', state.sessionId, '--dir', root, `Continue the active issue trace. Collect the completed independent reviewer and critic results, then record the authoritative implementation-review receipt and recurrence-sweep receipt for issue ${input.issueNumber} with diffBase ${input.baseSha} and diffHead ${targetTreeSha}.`], { cwd: root, timeout: remainingTimeout(), signal: state.signal, env: providerEnv });
		recordOpenCode(result, state.sessionId, true);
	};
	return {
		state,
		authorize: async (request) => {
			const expected = envText('GITHUB_REPOSITORY');
			return (!expected || expected === request.repository) && request.labeler.length > 0 && request.label.length > 0;
		},
		createRuntime: () => ({
			mutationCapable: true,
			run: async ({ signal, deadlineMs }) => {
				state.signal = signal;
				await verifyActualBunBinding(root, envText('SWARM_ACTION_BUN_BIN', localBinary('bun')), envText('SWARM_ACTION_BUN_VERSION'), signal, deadlineMs, prepareEnv);
				await verifyActualToolBindings(root, opencode, envText('SWARM_ACTION_OPENCODE_VERSION'), envText('SWARM_ACTION_PLUGIN_REF'), signal, deadlineMs, providerEnv);
				state.bindingsVerified = true;
				await startIssueTrace();
			},
			kill: async () => {},
			cleanup: async () => {},
		}),
		executeStage: async (stage) => {
			if (!state.bindingsVerified) throw new Error('OpenCode/plugin bindings were not verified');
			if (stage === 'specification' || stage === 'planning' || stage === 'gated-implementation') await continueIssueTrace();
			if (stage === 'independent-review') {
				const targetTreeSha = await candidateTreeSha(root, input, state.signal, remainingTimeout(), prepareEnv);
				const reviewer = await runIndependentReview(reviewerAgent, 'review');
				const critic = await runIndependentReview(envText('SWARM_ACTION_CRITIC_AGENT', 'critic'), 'critique');
				state.reviewEvidence = { parentSession: state.sessionId, traceTranscriptSha256: state.traceTranscriptSha256, targetTreeSha, nested: [reviewer, critic] };
				await recordAuthoritativeReview(targetTreeSha);
				writeReviewTranscriptEvidence(root, input, state.reviewEvidence);
			}
			if (stage === 'tests') {
				const bun = envText('SWARM_ACTION_BUN_BIN', localBinary('bun'));
				const configured = envText('SWARM_ACTION_TEST_COMMANDS');
				let commands;
				try { commands = configured ? JSON.parse(configured) : [['run', 'test'], ['run', 'typecheck'], ['run', 'lint:ci']]; } catch { throw new Error('SWARM_ACTION_TEST_COMMANDS must be JSON array form'); }
				if (!Array.isArray(commands) || commands.some((args) => !Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))) throw new Error('runner test commands must be array-form');
				for (const args of commands) {
					const result = await spawnBounded(bun, args, { cwd: root, timeout: remainingTimeout(), signal: state.signal, env: prepareEnv });
					state.agentOutput += `\nrunner-check ${JSON.stringify(args)}\n${result.stdout}\n${result.stderr}`;
					if (result.code !== 0) throw new Error(`runner-owned check failed: ${args.join(' ')}`);
				}
			}
			state.stageRecords.push({ stage, status: 'passed' });
		},
		evaluateGate: async () => {
			try { requireDurableTraceCompletion(root, input, state.reviewEvidence, state.reviewEvidence?.targetTreeSha); } catch { state.gateDecision = 'gate-failed'; return 'gate-failed'; }
			const bun = envText('SWARM_ACTION_BUN_BIN', localBinary('bun'));
			// The CI gate executes the CLI shipped by this immutable composite
			// Action ref.  No `bun x` / registry resolution is permitted here.
			const result = await spawnBounded(bun, [actionBoundCiCli(), 'ci', '--json', '--timeout-ms', String(remainingTimeout())], { cwd: root, timeout: remainingTimeout(), signal: state.signal, env: prepareEnv });
			state.gateOutput = `${result.stdout}\n${result.stderr}`;
			state.gateDecision = result.code === 0 ? 'approved' : 'gate-failed';
			return state.gateDecision;
		},
		bindArtifact: async (request) => ({
			repository: request.repository,
			issueNumber: request.issueNumber,
			deliveryId: request.deliveryId,
			baseSha: envText('SWARM_ACTION_BASE_SHA'),
			evidence: `${state.agentOutput}\n${state.gateOutput}`,
		}),
		isTransient: (error) => /(?:timed? ?out|temporar(?:y|ily)|429|502|503|504|unavailable)/i.test(asText(error)),
		sleep: (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
	};
}

function prepareInputFromEnvironment() {
	return {
		repository: envText('SWARM_ACTION_REPOSITORY'),
		issueNumber: envInteger('SWARM_ACTION_ISSUE_NUMBER', 0),
		deliveryId: envText('SWARM_ACTION_DELIVERY_ID'),
		label: envText('SWARM_ACTION_LABEL'),
		labeler: envText('SWARM_ACTION_LABELER'),
		baseSha: envText('SWARM_ACTION_BASE_SHA'),
		issueBody: `${envText('SWARM_ACTION_ISSUE_TITLE')}\n\n${envText('SWARM_ACTION_ISSUE_BODY')}`.trim(),
		issueUrl: envText('SWARM_ACTION_ISSUE_URL'),
		baseBranch: envText('SWARM_ACTION_BASE_BRANCH', 'main'),
		expectedIssueTrace: envText('SWARM_ACTION_ISSUE_TRACE'),
		providerSecret: envText('SWARM_ACTION_PROVIDER_SECRET'),
		maxAttempts: envInteger('SWARM_ACTION_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS),
		deadlineMs: envInteger('SWARM_ACTION_DEADLINE_MS', DEFAULT_DEADLINE_MS),
	};
}

async function runPrepareCli(root) {
	const input = prepareInputFromEnvironment();
	if (!input.issueUrl || !input.expectedIssueTrace || !safeBranchName(input.baseBranch)) throw new Error('prepare requires canonical issue-url, expected issue-trace, and safe base-branch bindings');
	const artifactPath = safeArtifactPath(root, envText('SWARM_ACTION_ARTIFACT_PATH'));
	const outer = createRunController(undefined, boundedDeadline(input));
	input.signal = outer.controller.signal;
	const dependencies = trustedPrepareDependencies(input, root);
	try {
		const result = await preparePublishGatedAction(input, dependencies);
		if (!('status' in result)) {
			const secrets = configuredSecrets();
			assertSecretFree(`${dependencies.state.agentOutput}\n${dependencies.state.gateOutput}`, secrets);
			const remaining = Math.max(1, outer.remaining(outer.startedAt));
			const transport = await collectCanonicalTransport(root, input, input.signal, remaining, secrets, prepareEnvironment());
			if (!dependencies.state.reviewEvidence || dependencies.state.reviewEvidence.targetTreeSha !== transport.targetTreeSha) throw new Error('workspace changed after the authoritative review receipt; re-run prepare');
			const canonical = canonicalArtifactPayload(input, result, transport, dependencies.state, secrets);
			const payload = { ...canonical };
			if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_ARTIFACT_BYTES) throw new Error('Action artifact exceeds the bounded transport size');
			writeArtifactFile(artifactPath, payload);
			writeActionOutputs({ status: 'prepared', 'evidence-path': relative(root, artifactPath), 'run-key': payload.runKey });
			return 0;
		}
		writeActionOutputs({ status: result.status, 'run-key': stableRunKey(input) });
		return result.status === 'denied' ? 1 : 3;
	} finally {
		outer.close();
	}
}

function publishDependenciesFromEnvironment(root, payload, runState) {
	const token = envText('SWARM_ACTION_PUBLICATION_TOKEN');
	const baseSha = payload.bindings.baseSha;
	const branch = `swarm/issue-${payload.issueNumber}`;
	const baseBranch = payload.bindings.baseBranch;
	if (!safeBranchName(baseBranch) || envText('SWARM_ACTION_BASE_BRANCH', 'main') !== baseBranch) throw new Error('publisher base branch does not match the bound artifact');
	const publishEnv = {
		...sanitizedEnvironment(),
		GH_TOKEN: token,
		GITHUB_TOKEN: token,
		GIT_AUTHOR_NAME: 'opencode-swarm[bot]',
		GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
		GIT_COMMITTER_NAME: 'opencode-swarm[bot]',
		GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
	};
	delete publishEnv.SWARM_ACTION_PUBLICATION_TOKEN;
	delete publishEnv.SWARM_ACTION_PROVIDER_SECRET;
	const remaining = () => Math.max(1, runState.remaining(runState.startedAt));
	const remoteGitArgs = (args) => ['-c', 'credential.helper=!gh auth git-credential', ...args];
	const ghJson = async (args) => {
		const result = await spawnBounded(localBinary('gh'), args, { cwd: root, timeout: remaining(), signal: runState.controller.signal, env: publishEnv, maxOutputBytes: MAX_CAPTURE_BYTES });
		if (result.code !== 0) throw new Error(`GitHub query failed: ${redactText(result.stderr, configuredSecrets()).slice(0, 300)}`);
		const raw = result.stdout.trim();
		if (raw === '' || /^ECHO is (?:on|off)\.?$/i.test(raw)) return [];
		try { return JSON.parse(raw); } catch {
			const url = result.stdout.trim().split(/\s+/).find((value) => /^https:\/\/github\.com\//.test(value));
			if (url) return [{ number: Number(url.match(/\/pull\/(\d+)/)?.[1]), url, headRefName: args[args.indexOf('--head') + 1] }];
			throw new Error('GitHub query returned malformed JSON');
		}
	};
	const openPr = async (head) => {
		const rows = await ghJson(['pr', 'list', '--repo', payload.repository, '--head', head, '--state', 'open', '--json', 'number,url,headRefName,headRefOid,baseRefName,baseRefOid', '--limit', '20']);
		if (!Array.isArray(rows)) throw new Error('GitHub PR query was not an array');
		return rows.find((row) => row && row.headRefName === head && row.baseRefName === baseBranch && row.baseRefOid === baseSha && typeof row.url === 'string') ?? null;
	};
	const remoteSha = async (head) => {
		const result = await spawnBounded('git', remoteGitArgs(['ls-remote', '--heads', 'origin', `refs/heads/${head}`]), { cwd: root, timeout: remaining(), signal: runState.controller.signal, env: publishEnv, maxOutputBytes: MAX_CAPTURE_BYTES });
		if (result.stdoutTruncated || result.stderrTruncated) throw new Error('remote branch inspection exceeded its capture bound');
		if (result.code !== 0) throw new Error('unable to inspect the remote publication branch');
		return result.stdout.trim().split(/\s+/)[0] || null;
	};
	const assertLiveBase = async () => {
		const liveBase = await remoteSha(baseBranch);
		if (!liveBase || liveBase !== baseSha) throw new Error('live remote base no longer matches the approved artifact; re-run prepare');
		return liveBase;
	};
	const verifyRemotePatch = async (remote) => {
		if (!remote) return false;
		// Bind the object being verified to the live ref immediately before the
		// fetch.  A name/base match alone is not sufficient for PR reuse.
		if (await remoteSha(branch) !== remote) return false;
		await gitCommand(root, remoteGitArgs(['fetch', '--no-tags', 'origin', `refs/heads/${branch}`]), { timeout: remaining(), signal: runState.controller.signal, env: publishEnv });
		const diff = await gitCommand(root, ['diff', '--binary', '--full-index', '--find-renames', '--find-copies', baseSha, remote, '--', '.', ':(exclude).git/**', ':(exclude).swarm/**'], { timeout: remaining(), signal: runState.controller.signal, env: publishEnv, maxOutputBytes: MAX_PATCH_BYTES, requireCompleteOutput: true });
		const patchBytes = Buffer.from(diff.stdout, 'utf8');
		const remoteTree = await gitCommand(root, ['ls-tree', '-r', '-z', remote], { timeout: remaining(), signal: runState.controller.signal, env: publishEnv, maxOutputBytes: MAX_PATCH_BYTES, requireCompleteOutput: true });
		// The patch binds the claimed transition from the approved base; the
		// complete tree listing independently binds modes, object types, paths,
		// and object content.  Either check alone is insufficient for remote
		// reuse/claim equivalence.
		return sha256(patchBytes) === payload.transport.patchSha256
			&& contentTreeDigest(remoteTree.stdout) === payload.transport.targetContentSha256;
	};
	const verifyOpenPr = async (head, expectedRemote = undefined) => {
		const liveRemote = await remoteSha(head);
		if (!liveRemote) {
			if (expectedRemote) throw new Error('publication branch disappeared during PR verification');
			return null;
		}
		if (expectedRemote && liveRemote !== expectedRemote) throw new Error('publication branch changed during PR verification');
		const pr = await openPr(head);
		if (!pr) return null;
		if ((pr.headRefOid && pr.headRefOid !== liveRemote) || !(await verifyRemotePatch(liveRemote))) throw new Error('pull request head does not match the bound artifact');
		return { pr, remoteSha: liveRemote };
	};
	const createOrReusePr = async (head, expectedRemote) => {
		let verifiedPr = await verifyOpenPr(head, expectedRemote);
		let existing = verifiedPr?.pr;
		if (!existing) {
			const body = redactText(payload.evidence, [token]);
			assertSecretFree(body, [token]);
			const created = await spawnBounded(localBinary('gh'), ['pr', 'create', '--repo', payload.repository, '--head', head, '--base', baseBranch, '--title', `chore: gated swarm issue #${payload.issueNumber}`, '--body', body], { cwd: root, timeout: remaining(), signal: runState.controller.signal, env: publishEnv });
			if (created.code !== 0) {
				// A duplicate may have created the PR between list and create. Query
				// structured JSON and reuse only that exact deterministic head.
				// The final verification below performs the authoritative lookup and
				// exact remote-tree check, avoiding a redundant fetch on the success path.
				if (created.code !== 0 && !expectedRemote) throw new Error('pull request creation failed');
			}
		}
		// Re-check both the live base and exact remote tree immediately before
		// returning a reusable or newly-created PR to the caller.
		await assertLiveBase();
		verifiedPr = await verifyOpenPr(head, expectedRemote);
		if (!verifiedPr) throw new Error('pull request disappeared during final verification');
		return verifiedPr.pr;
	};
	return {
		verifyArtifact: async (request) => {
			try {
				const verified = verifyCanonicalArtifactPayload(payload, root, { repository: request.artifact.repository, issueNumber: request.artifact.issueNumber, deliveryId: request.artifact.deliveryId }, request.expectedBaseSha);
				const head = (await gitCommand(root, ['rev-parse', 'HEAD'], { timeout: remaining(), signal: runState.controller.signal, env: publishEnv })).stdout.trim();
				const tree = (await gitCommand(root, ['rev-parse', 'HEAD^{tree}'], { timeout: remaining(), signal: runState.controller.signal, env: publishEnv })).stdout.trim();
				return head === request.expectedBaseSha && tree === verified.transport.baseTreeSha;
            } catch { return false; }
		},
		claimBranch: async () => {
			await assertLiveBase();
			const verifiedPr = await verifyOpenPr(branch);
			if (verifiedPr) {
				const pr = verifiedPr.pr;
				return { branch, state: 'existing', prUrl: pr.url, prNumber: pr.number, remoteSha: verifiedPr.remoteSha };
			}
			const remote = await remoteSha(branch);
			if (remote) {
				if (!(await verifyRemotePatch(remote))) throw new Error('orphan branch does not match the bound artifact');
				return { branch, state: 'existing', remoteSha: remote, orphan: true };
			}
			return { branch, state: 'claimed' };
		},
		publish: async ({ claim }) => {
			if (envText('SWARM_ACTION_OVERSIGHT_STATUS', 'approved') !== 'approved') throw new Error('publisher oversight status is not approved');
			// The caller's protected Environment approved this job.  Bind that
			// approval to the current remote base immediately before mutation.
			await assertLiveBase();
			let candidateSha = claim.remoteSha;
			if (claim.state === 'existing' && claim.orphan) {
				if (!(await verifyRemotePatch(candidateSha))) throw new Error('orphan branch does not match the bound artifact');
			} else if (claim.state === 'claimed') {
				await verifyAndApplyCanonicalTransport(root, payload, { repository: payload.repository, issueNumber: payload.issueNumber, deliveryId: payload.deliveryId, expectedBaseSha: baseSha }, runState.controller.signal, remaining());
				const add = await gitCommand(root, ['add', '-A', '--', '.', ':(exclude).git/**', ':(exclude).swarm/**'], { timeout: remaining(), signal: runState.controller.signal, env: publishEnv });
				if (add.code !== 0) throw new Error('unable to stage the bound transport');
				await gitCommand(root, ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=opencode-swarm[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', `chore: apply gated swarm issue #${payload.issueNumber}`], { timeout: remaining(), signal: runState.controller.signal, env: publishEnv });
				candidateSha = (await gitCommand(root, ['rev-parse', 'HEAD'], { timeout: remaining(), signal: runState.controller.signal, env: publishEnv })).stdout.trim();
				// Empty expected old value is Git's create-only lease.  It cannot
				// fast-forward or overwrite a ref which appeared after preflight.
				// `persist-credentials:false` leaves a hosted runner without Git
				// credentials.  Supply gh's fixed credential-helper only for this
				// one child: GH_TOKEN stays in its environment, never in a URL, argv
				// token, repository config, or artifact.  The helper string is the
				// documented Git helper protocol and has no user-controlled input.
				// Because it is `-c` scoped, there is no temporary credential state to
				// clean up after the bounded child exits.
				const push = await spawnBounded('git', ['-c', 'credential.helper=!gh auth git-credential', 'push', '--porcelain', `--force-with-lease=refs/heads/${claim.branch}:`, 'origin', `${candidateSha}:refs/heads/${claim.branch}`], { cwd: root, timeout: remaining(), signal: runState.controller.signal, env: publishEnv });
				if (push.code !== 0) {
					const winner = await remoteSha(claim.branch);
					if (!(await verifyRemotePatch(winner))) throw new Error('atomic branch claim lost to a different artifact');
					candidateSha = winner;
				} else if (await remoteSha(claim.branch) !== candidateSha) throw new Error('create-only branch lease did not produce the expected remote head');
			}
			const pr = await createOrReusePr(claim.branch, candidateSha);
			return { branch: claim.branch, prUrl: pr.url, prNumber: pr.number, evidence: payload.evidence, summary: `gated publication ${candidateSha ? `at ${candidateSha.slice(0, 12)}` : ''}`.trim() };
		},
	};
}

async function runPublishCli(root) {
	const artifactPath = safeArtifactPath(root, envText('SWARM_ACTION_ARTIFACT_PATH'));
	const payload = readArtifactFile(artifactPath);
	const token = envText('SWARM_ACTION_PUBLICATION_TOKEN');
	const expectedBaseSha = envText('SWARM_ACTION_EXPECTED_BASE_SHA', envText('SWARM_ACTION_BASE_SHA'));
	if (!token) throw new Error('publication token is required only for publish mode');
	const deadlineMs = envInteger('SWARM_ACTION_DEADLINE_MS', DEFAULT_DEADLINE_MS);
	const runState = createRunController(undefined, boundedDeadline({ deadlineMs }));
	runState.startedAt = Date.now();
	try {
		// Publish never executes OpenCode or the CI CLI.  Avoiding a version probe
		// here prevents the publication-only credential environment from ever
		// reaching an unrelated executable; artifact and Action-ref binding are
		// verified below before any mutation.
		const input = { repository: envText('SWARM_ACTION_REPOSITORY', payload.repository), issueNumber: envInteger('SWARM_ACTION_ISSUE_NUMBER', payload.issueNumber), deliveryId: envText('SWARM_ACTION_DELIVERY_ID', payload.deliveryId), artifact: payload.artifact, publicationToken: token, expectedBaseSha, signal: runState.controller.signal };
		if (input.repository !== payload.repository || input.issueNumber !== payload.issueNumber || input.deliveryId !== payload.deliveryId) throw new Error('publish inputs do not match the bound artifact');
		const result = await publishVerifiedAction(input, publishDependenciesFromEnvironment(root, payload, runState));
		writeActionOutputs({ status: result.status, 'pr-url': result.publication?.prUrl ?? '', 'pr-number': result.publication?.prNumber ?? '', summary: result.publication?.summary ?? '', 'evidence-path': relative(root, artifactPath), 'run-key': payload.runKey ?? stableRunKey(payload.artifact) });
		return result.status === 'published' || result.status === 'reused' ? 0 : 1;
	} finally {
		runState.close();
	}
}

export async function runActionFromEnvironment() {
	const root = workspaceRoot();
	const mode = envText('SWARM_ACTION_MODE', 'prepare');
	if (mode === 'prepare') return runPrepareCli(root);
	if (mode === 'publish') return runPublishCli(root);
	throw new Error(`unsupported Action mode: ${mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const exitCode = await runActionFromEnvironment();
		process.exitCode = exitCode;
	} catch (error) {
		console.error(`gated Action failed: ${redactText(error instanceof Error ? error.message : error, configuredSecrets())}`);
		process.exitCode = 3;
	}
}
