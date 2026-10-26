import * as fs from 'node:fs';
import * as path from 'node:path';
import { PlanSchema } from '../config/plan-schema.js';
import {
	computeExternalDeclarationDigest,
	type ExternalEvidenceBundle,
	readTaskEvidenceRaw,
	transitionTaskWorkflowEvidence,
} from '../gate-evidence.js';
import { bunSpawn } from '../utils/bun-compat.js';
import { resolveGitExecutable } from '../utils/git-executable.js';
import { assertProjectRoot } from '../utils/project-boundary.js';
import { _internals as updateInternals } from './update-task-status.js';

/**
 * `/swarm attest` core (issue #3422): the external-evidence producer.
 *
 * A plan task whose deliverable is git-external (commit/push, gh ops) can
 * declare `evidence_class: 'external_git'` with pinned read-only git
 * `evidence_anchors`. This executor runs each anchor as a bounded, no-shell
 * argv spawn inside the task's project root, checks the trimmed stdout
 * against the anchor's `expect` (exact) or `expect_prefix` (non-empty
 * prefix), and — only when every anchor matched — records a durable
 * `external_evidence_attested` bundle on the task's exact-task evidence.
 * The completion gate then admits completion for that task through the
 * shared external predicates (`gate-evidence.ts`), with no coder settlement
 * ever existing. Everything else refuses exactly as before (AC2).
 *
 * Trust boundary (documented, not tamper-proof): anchors are plan-authored.
 * The grammar below refuses anything that is not a positively-known
 * read-only git invocation — unknown flags, global options, output-writing
 * flags, remote-helper URLs, and non-git commands all fail closed with a
 * `read-only git` refusal. Malformed anchors (no `expect`/`expect_prefix`,
 * or an empty prefix, which would match everything) refuse with an
 * `expect` error before policy evaluation.
 */

export interface AttestTaskArgs {
	task_id: string;
	working_directory?: string;
	reason?: string;
}

export interface AttestTaskResult {
	success: boolean;
	message: string;
	task_id?: string;
	errors?: string[];
}

/** Per-anchor execution bounds. The 4096-char stdout bound mirrors the
 * durable-evidence storage cap: an anchor whose RAW output cannot be
 * persisted verbatim refuses instead of being silently truncated. */
const ANCHOR_STDOUT_MAX_CHARS = 4096;
const ANCHOR_SPAWN_TIMEOUT_MS = 10_000;
const ANCHOR_SPAWN_MAX_BUFFER_BYTES = 256 * 1024;
const ATTEST_TOTAL_DEADLINE_MS = 30_000;

/**
 * Exact v1 read-only git grammar (plan §7): subcommand → allowed flags with
 * arity (number of value tokens). Anything not listed refuses. `=`-joined
 * values are accepted only for arity-1 flags.
 */
const READ_ONLY_GIT_FLAGS: Readonly<
	Record<string, Readonly<Record<string, number>>>
> = {
	'rev-list': { '--count': 0, '--max-count': 1, '--format': 1, '--skip': 1 },
	log: {
		'--format': 1,
		'--max-count': 1,
		'-n': 1,
		'--oneline': 0,
		'--no-patch': 0,
		'--stat': 0,
		'--name-only': 0,
		'-1': 0,
		'-2': 0,
		'-3': 0,
		'-4': 0,
		'-5': 0,
		'-9': 0,
	},
	show: {
		'--format': 1,
		'--stat': 0,
		'--name-only': 0,
		'--no-patch': 0,
		'--quiet': 0,
	},
	diff: { '--stat': 0, '--name-only': 0, '--quiet': 0 },
	'rev-parse': { '--verify': 0, '--short': 0 },
};

/** Remote-helper / transport-harness URL forms never allowed as positionals. */
const REMOTE_HELPER_PATTERN = /^(ext::|[a-z+.-]+::)/;

interface AnchorPlan {
	command: string;
	expect?: string;
	expect_prefix?: string;
}

interface AnchorOutcome {
	command: string;
	expect?: string;
	expect_prefix?: string;
	matched: boolean;
	exit_code: number;
	stdout: string;
}

/** Minimal child env: PATH/HOME/locale plus the Windows system vars git
 * needs; every git override variable is scrubbed and system config disabled
 * so a hostile repo/global config cannot retarget the invocation. */
function anchorEnv(): {
	env: Record<string, string | undefined>;
	envOverrides: Record<string, string | null>;
} {
	const env: Record<string, string | undefined> = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		LANG: process.env.LANG,
		LC_ALL: process.env.LC_ALL,
		GIT_CONFIG_NOSYSTEM: '1',
	};
	if (process.platform === 'win32') {
		env.SYSTEMROOT = process.env.SYSTEMROOT;
		env.WINDIR = process.env.WINDIR;
		env.COMSPEC = process.env.COMSPEC;
	}
	const envOverrides: Record<string, string | null> = {
		GIT_EXTERNAL_DIFF: null,
		GIT_CONFIG_PARAMETERS: null,
		GIT_CONFIG_COUNT: null,
		GIT_DIR: null,
		GIT_WORK_TREE: null,
		GIT_INDEX_FILE: null,
		GIT_SSH_COMMAND: null,
		GIT_ASKPASS: null,
		GIT_EXEC_PATH: null,
		GIT_PAGER: null,
	};
	return { env, envOverrides };
}

/**
 * Validate one anchor's command against the v1 grammar and build the final
 * argv. Returns a refusal string (policy: `read-only git`; malformed
 * expectation: `expect`) or null when admitted.
 */
export function buildAnchorArgv(command: string): {
	argv: string[] | null;
	refusal: string | null;
} {
	const tokens = command.trim().split(/\s+/).filter(Boolean);
	if (tokens[0] !== 'git' || tokens.length < 2) {
		return {
			argv: null,
			refusal: `anchor command is not an allowed read-only git invocation: "${command}"`,
		};
	}
	const subcommand = tokens[1];
	if (subcommand.startsWith('-')) {
		return {
			argv: null,
			refusal: `anchor command smuggles a git global option ("${subcommand}"); only bare read-only git subcommands are allowed`,
		};
	}
	const allowed = READ_ONLY_GIT_FLAGS[subcommand];
	if (!allowed) {
		return {
			argv: null,
			refusal: `git "${subcommand}" is not in the read-only git subcommand allowlist (rev-list, log, rev-parse, show, diff)`,
		};
	}
	// finalTokens carries the SUBCOMMAND and its args only — the git binary
	// and the producer's own safety prefix are prepended at the end, so the
	// anchor's leading `git` token must not be duplicated.
	const finalTokens: string[] = [subcommand];
	for (let i = 2; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token.startsWith('-')) {
			const eq = token.indexOf('=');
			const flag = eq >= 0 ? token.slice(0, eq) : token;
			const inlineValue = eq >= 0 ? token.slice(eq + 1) : undefined;
			const arity = allowed[flag];
			if (arity === undefined) {
				return {
					argv: null,
					refusal: `flag "${flag}" is not in the read-only git allowlist for git ${subcommand}`,
				};
			}
			if (arity === 0) {
				if (inlineValue !== undefined) {
					return {
						argv: null,
						refusal: `flag "${flag}" takes no value; =-joined forms are not valid for it`,
					};
				}
				finalTokens.push(flag);
			} else {
				let value = inlineValue;
				if (value === undefined) {
					const next = tokens[i + 1];
					if (next === undefined || next.startsWith('--')) {
						return {
							argv: null,
							refusal: `flag "${flag}" requires a value token`,
						};
					}
					value = next;
					i++;
				}
				// Issue #3432 review PRR-009: space-separated option values fail
				// on git-for-windows 2.54 ("ambiguous argument" exit 128, probed)
				// while the = form works everywhere — normalize to a single
				// `flag=value` token (short flags concatenate without =).
				finalTokens.push(
					flag.startsWith('--') ? `${flag}=${value}` : `${flag}${value}`,
				);
			}
			continue;
		}
		// Biome forbids control characters in regexes (decoded escapes count),
		// so the control-byte scan is a code-point check (issue #3422).
		const hasControlByte = Array.from(token).some(
			(ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f,
		);
		if (token.length > 400 || hasControlByte) {
			return {
				argv: null,
				refusal: 'anchor argument is too long or contains control bytes',
			};
		}
		if (REMOTE_HELPER_PATTERN.test(token)) {
			return {
				argv: null,
				refusal: `anchor argument "${token.slice(0, 32)}" looks like a remote-helper URL; remote helpers can execute commands and are not read-only git invocations`,
			};
		}
		finalTokens.push(token);
	}
	// Belt-and-braces for the diff-driver subcommands: the positive flag
	// allowlist already excludes --ext-diff/--textconv, but force-disable
	// both mechanisms (plus paging and diff.external) on the producer's own
	// prefix so an inherited config cannot re-enable them.
	if (subcommand === 'diff' || subcommand === 'show' || subcommand === 'log') {
		finalTokens.push('--no-ext-diff', '--no-textconv');
	}
	const git = resolveGitExecutable();
	// Issue #3432 review PRR-001: neutralize the remaining config-driven exec
	// class alongside diff.external — fsmonitor daemons (fire on index refresh
	// during diff), GPG helpers (log.showSignature/gpg.program verify signed
	// objects on log/show), and credential helpers (defense in depth).
	const argv = [
		git,
		'--no-pager',
		'-c',
		'diff.external=',
		'-c',
		'core.pager=cat',
		'-c',
		'core.fsmonitor=',
		'-c',
		'gpg.program=',
		'-c',
		'credential.helper=',
		...finalTokens,
	];
	return { argv, refusal: null };
}

async function runAnchor(
	argv: string[],
	cwd: string,
	timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; refusal: string | null }> {
	const { env, envOverrides } = anchorEnv();
	const proc = bunSpawn(argv, {
		cwd,
		env,
		envOverrides,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: timeoutMs,
		maxBuffer: ANCHOR_SPAWN_MAX_BUFFER_BYTES,
	});
	try {
		const exited = await proc.exited;
		// bunSpawn exposes stdout/stderr as buffered BunCompatStreams, not
		// plain strings; read them to text AFTER exit (the maxBuffer cap
		// owns the bound). An over-buffer stream rejects — convert that to
		// the tool's fail-closed refusal shape instead of letting the error
		// escape the executor boundary (#3432 review PRR-004).
		let stdout: string;
		try {
			stdout = await proc.stdout.text();
		} catch {
			return {
				exitCode: exited,
				stdout: '',
				refusal: `anchor output exceeded the ${Math.floor(ANCHOR_SPAWN_MAX_BUFFER_BYTES / 1024)}KB spawn capture buffer; refusing rather than truncating`,
			};
		}
		if (exited !== 0) {
			const stderr = await proc.stderr.text();
			const detail = stderr.trim().slice(0, 200);
			return {
				exitCode: exited,
				stdout,
				refusal: `anchor command exited with code ${exited}${detail ? `: ${detail}` : ''}`,
			};
		}
		return { exitCode: exited, stdout, refusal: null };
	} finally {
		try {
			proc.kill();
		} catch {
			// best-effort per AGENTS.md invariant 3: the bounded timeout and
			// stream caps own the leak window even when the kill races exit.
		}
	}
}

export const _internals = {
	runAnchor,
	buildAnchorArgv,
	loadPlanTask: (
		directory: string,
		taskId: string,
	): {
		title: string;
		swarm: string;
		task: {
			id: string;
			evidence_class?: string;
			evidence_anchors?: AnchorPlan[];
		};
	} | null => {
		const planPath = path.join(directory, '.swarm', 'plan.json');
		if (!fs.existsSync(planPath)) return null;
		const plan = PlanSchema.parse(
			JSON.parse(fs.readFileSync(planPath, 'utf-8')),
		);
		for (const phase of plan.phases) {
			for (const task of phase.tasks) {
				if (task.id === taskId) {
					return { title: plan.title, swarm: plan.swarm, task };
				}
			}
		}
		return null;
	},
};

function validateAnchorExpectations(anchors: AnchorPlan[]): string | null {
	for (const anchor of anchors) {
		if (anchor.expect === undefined && anchor.expect_prefix === undefined) {
			return `anchor "${anchor.command.slice(0, 60)}" declares neither expect nor expect_prefix`;
		}
		if (
			anchor.expect_prefix !== undefined &&
			anchor.expect_prefix.length === 0
		) {
			return `anchor "${anchor.command.slice(0, 60)}" declares an empty expect_prefix, which would match any output`;
		}
	}
	return null;
}

export async function executeAttestTask(
	args: AttestTaskArgs,
	fallbackDir?: string,
): Promise<AttestTaskResult> {
	const resolveResult = updateInternals.resolveWorkingDirectory(
		args.working_directory,
		fallbackDir,
	);
	if (!resolveResult.success) {
		return {
			success: false,
			message: resolveResult.message,
			errors: [resolveResult.message],
		};
	}
	const directory = resolveResult.directory;
	try {
		assertProjectRoot(directory);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { success: false, message, errors: [message] };
	}

	let found: ReturnType<typeof _internals.loadPlanTask>;
	try {
		found = _internals.loadPlanTask(directory, args.task_id);
	} catch (error) {
		// A schema-invalid plan must surface as a clean refusal, never a
		// thrown zod error (#3422/#3432 review PRR-004). Anchor-specific
		// failures keep the dedicated `expect` wording; every other plan
		// validation failure gets the generic invalid-plan refusal.
		const message = error instanceof Error ? error.message : String(error);
		if (
			message.includes('expect_prefix') ||
			message.includes('evidence_anchors')
		) {
			const refusal =
				'the plan declares an invalid external-evidence anchor: every anchor must carry expect and/or a non-empty expect_prefix (an empty prefix would match any output)';
			return {
				success: false,
				message: refusal,
				errors: [refusal],
				task_id: args.task_id,
			};
		}
		const refusal = `the plan at ${directory} is invalid or unreadable; fix or re-save the plan before attesting`;
		return {
			success: false,
			message: refusal,
			errors: [`${refusal} (${message.slice(0, 160)})`],
			task_id: args.task_id,
		};
	}
	if (!found) {
		const message = `Task ${args.task_id} not found in the plan at ${directory}`;
		return {
			success: false,
			message,
			errors: [message],
			task_id: args.task_id,
		};
	}
	if (found.task.evidence_class !== 'external_git') {
		const message =
			`Task ${args.task_id} does not declare evidence_class external_git; the attest path is ` +
			`fail-closed to explicitly declared external-evidence tasks (issue #3422)`;
		return {
			success: false,
			message,
			errors: [message],
			task_id: args.task_id,
		};
	}
	const anchors = found.task.evidence_anchors ?? [];
	if (anchors.length === 0) {
		const message = `Task ${args.task_id} declares external_git evidence but pins no evidence_anchors`;
		return {
			success: false,
			message,
			errors: [message],
			task_id: args.task_id,
		};
	}
	const malformed = validateAnchorExpectations(anchors);
	if (malformed) {
		return {
			success: false,
			message: malformed,
			errors: [malformed],
			task_id: args.task_id,
		};
	}

	const startedAt = Date.now();
	const outcomes: AnchorOutcome[] = [];
	for (const anchor of anchors) {
		const { argv, refusal } = _internals.buildAnchorArgv(anchor.command);
		if (refusal !== null || argv === null) {
			const message = `anchor not admitted: ${refusal ?? 'not an allowed read-only git invocation'}`;
			return {
				success: false,
				message,
				errors: [message],
				task_id: args.task_id,
			};
		}
		const remaining = ATTEST_TOTAL_DEADLINE_MS - (Date.now() - startedAt);
		if (remaining <= 0) {
			const message =
				'attest total deadline (30s) exhausted before all anchors ran';
			return {
				success: false,
				message,
				errors: [message],
				task_id: args.task_id,
			};
		}
		const run = await _internals.runAnchor(
			argv,
			directory,
			Math.min(ANCHOR_SPAWN_TIMEOUT_MS, remaining),
		);
		if (run.refusal !== null) {
			const message = `anchor "${anchor.command.slice(0, 60)}" failed: ${run.refusal}`;
			return {
				success: false,
				message,
				errors: [message],
				task_id: args.task_id,
			};
		}
		if (run.stdout.length > ANCHOR_STDOUT_MAX_CHARS) {
			const message =
				`anchor "${anchor.command.slice(0, 60)}" produced ${run.stdout.length} chars of stdout, ` +
				`exceeding the ${ANCHOR_STDOUT_MAX_CHARS}-char evidence storage bound; refusing rather than truncating`;
			return {
				success: false,
				message,
				errors: [message],
				task_id: args.task_id,
			};
		}
		const trimmed = run.stdout.trim();
		const matched =
			anchor.expect !== undefined
				? trimmed === anchor.expect &&
					(anchor.expect_prefix === undefined ||
						trimmed.startsWith(anchor.expect_prefix))
				: trimmed.startsWith(anchor.expect_prefix!);
		outcomes.push({
			command: anchor.command,
			expect: anchor.expect,
			expect_prefix: anchor.expect_prefix,
			matched,
			exit_code: run.exitCode,
			stdout: run.stdout,
		});
	}
	if (!outcomes.every((outcome) => outcome.matched)) {
		const failed = outcomes.find((outcome) => !outcome.matched);
		const message =
			`anchor "${failed?.command.slice(0, 60) ?? '?'}" did not match its expectation ` +
			`(stdout: ${JSON.stringify(failed?.stdout.slice(0, 120) ?? '')})`;
		return {
			success: false,
			message,
			errors: [message],
			task_id: args.task_id,
		};
	}

	// Compare-and-publish freshness: re-read the plan after the bounded run so
	// a re-plan that landed mid-run cannot publish a bundle whose digest names
	// a declaration that no longer exists (#3432 review PRR-003: the anchor
	// set itself is compared, not just the identity fields — it is exactly the
	// field a declaration edit changes). Completion re-validates the digest
	// again under the plan lock (externalProofCurrent), which is the
	// authoritative enforcement point.
	let current: ReturnType<typeof _internals.loadPlanTask>;
	try {
		current = _internals.loadPlanTask(directory, args.task_id);
	} catch {
		const message =
			'the plan became unreadable while anchors were running; re-run attest against the current declaration';
		return {
			success: false,
			message,
			errors: [message],
			task_id: args.task_id,
		};
	}
	const anchorsUnchanged =
		JSON.stringify(current?.task.evidence_anchors ?? null) ===
		JSON.stringify(anchors);
	if (
		!current ||
		current.task.evidence_class !== 'external_git' ||
		current.title !== found.title ||
		current.swarm !== found.swarm ||
		!anchorsUnchanged
	) {
		const message =
			'the plan changed while anchors were running; re-run attest against the current declaration';
		return {
			success: false,
			message,
			errors: [message],
			task_id: args.task_id,
		};
	}

	// A corrupt existing evidence file must surface as a clean refusal (the
	// tool's universal {success:false} shape), not an uncaught parse error.
	let existingEvidence: ReturnType<typeof readTaskEvidenceRaw> = null;
	try {
		existingEvidence = readTaskEvidenceRaw(directory, args.task_id);
	} catch (error) {
		const message =
			`the existing evidence file for task ${args.task_id} is unreadable (corrupt): ` +
			`${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}; ` +
			'inspect the file before attesting';
		return {
			success: false,
			message,
			errors: [message],
			task_id: args.task_id,
		};
	}
	const generation = existingEvidence?.workflow?.generation ?? 0;
	const transitionId = `attest:${args.task_id}:${startedAt}:${Math.random().toString(36).slice(2, 10)}`;
	const bundle: ExternalEvidenceBundle = {
		class: 'external_git',
		transitionId,
		declarationDigest: computeExternalDeclarationDigest({
			taskId: args.task_id,
			evidence_class: 'external_git',
			evidence_anchors: anchors,
			plan_title: current.title,
			plan_swarm: current.swarm,
			generation,
		}),
		anchors: outcomes,
		attestedAt: new Date().toISOString(),
	};

	try {
		await transitionTaskWorkflowEvidence(directory, args.task_id, {
			type: 'external_evidence_attested',
			bundle,
			expectedGeneration: generation,
			transitionId,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			message,
			errors: [message],
			task_id: args.task_id,
		};
	}

	return {
		success: true,
		message: `Task ${args.task_id}: ${outcomes.length} external evidence anchor(s) attested and recorded; completion is now admissible for this declared task`,
		task_id: args.task_id,
	};
}
