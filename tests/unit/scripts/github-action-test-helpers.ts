import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const roots: string[] = [];
let environmentLock: Promise<void> = Promise.resolve();
const hostPath = process.env.PATH ?? process.env.Path ?? '';

export function makeTempRoot(prefix = 'swarm-action-2498-'): string {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	roots.push(root);
	return root;
}

export function cleanupTempRoots(): void {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
}

export function runGit(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed: ${result.stderr.toString()}`,
		);
	}
	return result.stdout.toString().trim();
}

export function initRepository(root: string, name: string): string {
	const repo = path.join(root, name);
	fs.mkdirSync(repo, { recursive: true });
	runGit(repo, 'init', '-q', '-b', 'main');
	runGit(repo, 'config', 'user.email', 'action-test@example.invalid');
	runGit(repo, 'config', 'user.name', 'Action Test');
	return repo;
}

export function commitAll(repo: string, message: string): string {
	runGit(repo, 'add', '--all');
	runGit(repo, 'commit', '-q', '-m', message);
	return runGit(repo, 'rev-parse', 'HEAD');
}

export function makeRemoteFixture(root: string): {
	origin: string;
	seed: string;
	fresh: string;
	baseSha: string;
} {
	const origin = path.join(root, 'origin.git');
	runGit(root, 'init', '--bare', '-q', origin);
	const seed = initRepository(root, 'seed');
	fs.writeFileSync(path.join(seed, 'modified.txt'), 'base\n');
	fs.writeFileSync(path.join(seed, 'deleted.txt'), 'delete me\n');
	fs.writeFileSync(path.join(seed, 'rename-before.txt'), 'rename me\n');
	fs.writeFileSync(
		path.join(seed, 'binary.dat'),
		Buffer.from([0, 1, 2, 3, 255]),
	);
	fs.writeFileSync(path.join(seed, 'mode.sh'), '#!/bin/sh\necho base\n');
	const baseSha = commitAll(seed, 'base fixture');
	runGit(seed, 'remote', 'add', 'origin', origin);
	runGit(seed, 'push', '-q', '-u', 'origin', 'main');
	const fresh = path.join(root, 'fresh');
	runGit(root, 'clone', '-q', '-b', 'main', origin, fresh);
	return { origin, seed, fresh, baseSha };
}

export function makePatch(
	seed: string,
	baseSha: string,
): { patch: string; patchSha256: string } {
	fs.writeFileSync(path.join(seed, 'modified.txt'), 'modified\n');
	fs.writeFileSync(path.join(seed, 'new.txt'), 'new file\n');
	fs.rmSync(path.join(seed, 'deleted.txt'));
	runGit(seed, 'mv', 'rename-before.txt', 'rename-after.txt');
	fs.writeFileSync(
		path.join(seed, 'binary.dat'),
		Buffer.from([0, 9, 8, 7, 255]),
	);
	fs.chmodSync(path.join(seed, 'mode.sh'), 0o755);
	runGit(seed, 'update-index', '--add', '--chmod=+x', 'mode.sh');
	const patch = runGit(
		seed,
		'diff',
		'--binary',
		'--full-index',
		'--find-renames',
		baseSha,
	);
	return {
		patch,
		patchSha256: createHash('sha256').update(patch).digest('hex'),
	};
}

export function writeArtifact(root: string, payload: unknown): string {
	const file = path.join(root, '.swarm', 'github-action', 'artifact.json');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
	return file;
}

export function installFakeBinary(
	root: string,
	name: string,
	body: string,
): string {
	const binDir = path.join(root, 'bin');
	fs.mkdirSync(binDir, { recursive: true });
	const file = path.join(
		binDir,
		process.platform === 'win32' ? `${name}.cmd` : name,
	);
	if (process.platform === 'win32') {
		fs.writeFileSync(file, `@echo off\r\n${body.replace(/\n/g, '\r\n')}\r\n`);
	} else {
		fs.writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`);
		fs.chmodSync(file, 0o755);
	}
	return binDir;
}

export function fakeOpenCodeBody(): string {
	if (process.platform === 'win32') {
		return 'if "%1"=="--version" (echo %FAKE_OPENCODE_VERSION% & exit /b 0)\r\n>>"%FAKE_ARGS_LOG%" echo %*\r\n>>"%FAKE_ENV_LOG%" echo publication=%SWARM_ACTION_PUBLICATION_TOKEN% gh=%GH_TOKEN% github=%GITHUB_TOKEN% provider=%SWARM_ACTION_PROVIDER_SECRET%\r\necho %FAKE_AGENT_OUTPUT%';
	}
	return 'if [ "${1-}" = --version ]; then printf "%s\\n" "${FAKE_OPENCODE_VERSION-1.18.26}"; exit 0; fi\nprintf "%s\\n" "$*" >> "$FAKE_ARGS_LOG"\nprintf "publication=%s gh=%s github=%s provider=%s\\n" "${SWARM_ACTION_PUBLICATION_TOKEN-}" "${GH_TOKEN-}" "${GITHUB_TOKEN-}" "${SWARM_ACTION_PROVIDER_SECRET-}" >> "$FAKE_ENV_LOG"\nprintf "%s\\n" "${FAKE_AGENT_OUTPUT-}"';
}

export function installTraceOpenCode(root: string): {
	binDir: string;
	binary: string;
	argsLog: string;
	envLog: string;
	script: string;
} {
	const binDir = path.join(root, 'bin');
	const script = path.join(root, 'fake-opencode-trace.mjs');
	const argsLog = path.join(root, 'trace.args');
	const envLog = path.join(root, 'trace.env');
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(
		script,
		String.raw`import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
 import { execFileSync } from 'node:child_process';
 import { tmpdir } from 'node:os';
 import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const log = process.env.FAKE_ARGS_LOG;
 const envLog = process.env.FAKE_ENV_LOG;
if (log) appendFileSync(log, JSON.stringify(args) + '\n');
 if (envLog) appendFileSync(envLog, 'publication=' + (process.env.SWARM_ACTION_PUBLICATION_TOKEN ?? '') + ' gh=' + (process.env.GH_TOKEN ?? '') + ' github=' + (process.env.GITHUB_TOKEN ?? '') + ' provider=' + (process.env.SWARM_ACTION_PROVIDER_SECRET ?? '') + ' openai=' + (process.env.OPENAI_API_KEY ?? '') + '\n');
 if (args[0] === '--version') {
  process.stdout.write((process.env.FAKE_OPENCODE_VERSION ?? '1.18.26') + '\n');
  process.exit(0);
}
 const dir = args[args.indexOf('--dir') + 1];
 const issueUrl = args.find((value) => value.startsWith('https://github.com/')) ?? process.env.FAKE_ISSUE_URL;
 const issueTrace = process.env.FAKE_ISSUE_TRACE ?? '2498-publish-gated-action';
const parts = issueUrl?.split('/') ?? [];
if (!dir || parts.length !== 7 || parts[0] !== 'https:' || parts[2] !== 'github.com' || parts[5] !== 'issues') process.exit(2);
const owner = parts[3];
const repo = parts[4];
const issue = parts[6];
const swarm = join(dir, '.swarm');
mkdirSync(swarm, { recursive: true });
const write = (name, value) => writeFileSync(join(swarm, name), JSON.stringify(value));
 const agent = args[args.indexOf('--agent') + 1];
 const isReviewer = agent === 'reviewer';
 const isCritic = agent === 'critic';
 const sessionIndex = args.indexOf('--session');
 const sessionID = sessionIndex >= 0 ? args[sessionIndex + 1] : isReviewer ? 'review-session-2498' : isCritic ? 'critic-session-2498' : 'trace-session-2498';
  if (args.includes('--command')) {
   write('issue-reference.json', { url: issueUrl, owner, repo, number: Number(issue), issueTrace, flags: { trace: true } });
   write('issue-trace-state.json', { issueNumber: Number(issue), issueTrace, lastTransition: 'ISSUE_INGEST_TO_PLAN', status: 'in_progress' });
 }
  if (sessionIndex >= 0) {
    write('issue-trace-state.json', { issueNumber: Number(issue), issueTrace, lastTransition: 'EXECUTE_TO_COMMIT', status: 'publication_handoff' });
     if (process.env.FAKE_RECEIPT_MODE !== 'missing-recurrence') write('recurrence-sweep.json', process.env.FAKE_RECEIPT_MODE === 'malformed-recurrence' ? 'not-an-object' : { issueNumber: Number(issue), issueTrace, status: 'clear', sessionId: sessionID, timestamp: '2026-09-08T00:00:00.000Z', defectClass: 'no defect class', justification: 'Fresh reviewer and critic found no recurrence.' });
  }
  if (args.some((value) => value.includes('authoritative implementation-review'))) {
   const indexDir = mkdtempSync(join(tmpdir(), 'fake-review-index-'));
   const index = join(indexDir, 'index');
   const gitEnv = { ...process.env, GIT_INDEX_FILE: index };
   const git = (gitArgs) => execFileSync('git', gitArgs, { cwd: dir, env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const sourceIndex = join(dir, git(['rev-parse', '--git-path', 'index']));
    if (existsSync(sourceIndex)) copyFileSync(sourceIndex, index);
    else git(['read-tree', 'HEAD']);
   git(['add', '-A', '--', '.', ':(exclude).git/**', ':(exclude).swarm/**']);
   const diffBase = git(['rev-parse', 'HEAD']);
   const diffHead = git(['write-tree']);
   rmSync(indexDir, { recursive: true, force: true });
    if (process.env.FAKE_RECEIPT_MODE !== 'missing-review') write('implementation-review.json', process.env.FAKE_RECEIPT_MODE === 'malformed-review' ? 'not-an-object' : { issueNumber: Number(issue), issueTrace, reviewerVerdict: 'APPROVE', criticVerdict: 'APPROVE', diffBase, diffHead, notes: 'fresh reviewer and critic both approved', timestamp: '2026-09-08T00:00:00.000Z', sessionId: sessionID });
 }
 const stages = ['issue-ingestion', 'specification', 'planning', 'gated-implementation', 'independent-review', 'tests', 'swarm-ci'];
 const injectedEvidence = process.env.FAKE_EVIDENCE ?? '';
 const text = isReviewer || isCritic ? 'Independent review evidence for issue-trace ' + issueTrace + '\nVERDICT: APPROVE' : 'issue-trace ' + issueTrace + ' trace evidence ' + injectedEvidence;
 process.stdout.write(JSON.stringify({ sessionID, issueTrace, stages, part: { type: 'text', text } }) + '\n');
`,
	);
	const binary = path.join(
		binDir,
		process.platform === 'win32'
			? 'fake-opencode-trace.cmd'
			: 'fake-opencode-trace',
	);
	if (process.platform === 'win32') {
		fs.writeFileSync(
			binary,
			`@echo off\r\n"%FAKE_NODE%" "%FAKE_SCRIPT%" %*\r\n`,
		);
	} else {
		fs.writeFileSync(
			binary,
			'#!/bin/sh\nexec "$FAKE_NODE" "$FAKE_SCRIPT" "$@"\n',
		);
		fs.chmodSync(binary, 0o755);
	}
	return { binDir, binary, argsLog, envLog, script };
}

export function fakeBunBody(): string {
	return process.platform === 'win32'
		? 'if not "%FAKE_BUN_ARGS_LOG%"=="" >>"%FAKE_BUN_ARGS_LOG%" echo %*\r\nif not "%FAKE_BUN_ENV_LOG%"=="" >>"%FAKE_BUN_ENV_LOG%" echo openai=%OPENAI_API_KEY%\r\nif "%1"=="--version" (echo %FAKE_BUN_VERSION% & exit /b 0)\r\necho {"status":"pass"}'
		: 'if [ -n "${FAKE_BUN_ARGS_LOG-}" ]; then printf "%s\\n" "$*" >> "$FAKE_BUN_ARGS_LOG"; fi\nif [ -n "${FAKE_BUN_ENV_LOG-}" ]; then printf "openai=%s\\n" "${OPENAI_API_KEY-}" >> "$FAKE_BUN_ENV_LOG"; fi\nif [ "${1-}" = --version ]; then printf "%s\\n" "${FAKE_BUN_VERSION-1.3.14}"; exit 0; fi\nprintf "{\\"status\\":\\"pass\\"}\\n"';
}

export function fakeGhBody(): string {
	if (process.platform === 'win32') {
		return '>>"%FAKE_GH_LOG%" echo %*\r\nif "%1"=="auth" exit /b 0\r\nif "%1"=="pr" if "%2"=="list" (if not "%FAKE_GH_PR_JSON%"=="" (echo %FAKE_GH_PR_JSON% & exit /b 0) else if exist "%FAKE_GH_STATE%" if not "%FAKE_GH_PR_AFTER_CREATE_JSON%"=="" (echo %FAKE_GH_PR_AFTER_CREATE_JSON% & exit /b 0) else (echo %FAKE_GH_PR_LIST% & exit /b 0))\r\nif "%1"=="pr" if "%2"=="create" (if not "%FAKE_GH_STATE%"=="" type nul > "%FAKE_GH_STATE%" & echo %FAKE_GH_PR_URL% & exit /b 0)\r\nexit /b 0';
	}
	return 'printf "%s\\n" "$*" >> "$FAKE_GH_LOG"\nif [ "$1" = auth ]; then exit 0; fi\nif [ "$1" = pr ] && [ "$2" = list ]; then if [ -n "${FAKE_GH_PR_JSON-}" ]; then printf "%s\\n" "$FAKE_GH_PR_JSON"; elif [ -n "${FAKE_GH_STATE-}" ] && [ -f "$FAKE_GH_STATE" ] && [ -n "${FAKE_GH_PR_AFTER_CREATE_JSON-}" ]; then printf "%s\\n" "$FAKE_GH_PR_AFTER_CREATE_JSON"; else printf "%s\\n" "${FAKE_GH_PR_LIST-}"; fi; exit 0; fi\nif [ "$1" = pr ] && [ "$2" = create ]; then if [ -n "${FAKE_GH_STATE-}" ]; then : > "$FAKE_GH_STATE"; fi; printf "%s\\n" "$FAKE_GH_PR_URL"; exit 0; fi\nexit 0';
}

export function prependPath(binDir: string): string {
	return `${binDir}${path.delimiter}${hostPath}`;
}

export function readOutputFile(file: string): Record<string, string> {
	if (!fs.existsSync(file)) return {};
	const text = fs.readFileSync(file, 'utf8');
	const result: Record<string, string> = {};
	for (const match of text.matchAll(/^([^\n]+)<<([^\n]+)\n([\s\S]*?)\n\2$/gm))
		result[match[1]] = match[3];
	return result;
}

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	return `{${Object.keys(value as Record<string, unknown>)
		.sort()
		.map(
			(key) =>
				`${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
		)
		.join(',')}}`;
}

export function refreshArtifactDigest(payload: Record<string, unknown>): void {
	const unsigned = {
		version: payload.version,
		runKey: payload.runKey,
		repository: payload.repository,
		issueNumber: payload.issueNumber,
		deliveryId: payload.deliveryId,
		baseSha: payload.baseSha,
		bindings: payload.bindings,
		artifact: payload.artifact,
		transport: payload.transport,
		evidence: payload.evidence,
		gateDecision: payload.gateDecision,
		oversightStatus: payload.oversightStatus,
	};
	payload.artifactDigest = createHash('sha256')
		.update(canonicalJson(unsigned))
		.digest('hex');
}

export function withEnvironment<T>(
	values: Record<string, string | undefined>,
	action: () => Promise<T>,
): Promise<T> {
	const run = environmentLock.then(async () => {
		const previous = new Map<string, string | undefined>();
		for (const [key, value] of Object.entries(values)) {
			previous.set(key, process.env[key]);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		try {
			return await action();
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
	environmentLock = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}
