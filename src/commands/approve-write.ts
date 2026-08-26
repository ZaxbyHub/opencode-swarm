import {
	formatApproveWriteCommand,
	issueWriteApprovalFact,
	type WriteApprovalAction,
} from '../security/write-authority.js';

const USAGE = [
	'Usage: /swarm approve-write <target-session-id> <action> <candidate-id> <candidate-content-hash> [--generation <n>] [--allowed-path-digest <sha256>]',
	'',
	'Issue one exact one-shot write approval for a session-bound action. This command is human-only.',
	'Actions: skill_improve',
].join('\n');

function parseApproveWriteArgs(args: string[]): {
	targetSessionId?: string;
	action?: WriteApprovalAction;
	candidateId?: string;
	candidateContentHash?: string;
	generation?: number;
	allowedPathDigest?: string;
	error?: string;
} {
	const positional: string[] = [];
	let generation: number | undefined;
	let allowedPathDigest: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (token === '--generation') {
			const next = args[i + 1];
			if (!next) return { error: 'missing value for --generation' };
			const parsed = Number.parseInt(next, 10);
			if (!Number.isFinite(parsed) || parsed < 0) {
				return { error: '--generation must be a non-negative integer' };
			}
			generation = parsed;
			i++;
			continue;
		}
		if (token === '--allowed-path-digest') {
			const next = args[i + 1];
			if (!next) return { error: 'missing value for --allowed-path-digest' };
			allowedPathDigest = next;
			i++;
			continue;
		}
		positional.push(token);
	}
	const [targetSessionId, actionRaw, candidateId, candidateContentHash] =
		positional;
	if (actionRaw !== undefined && actionRaw !== 'skill_improve') {
		return { error: `unknown action: ${actionRaw}` };
	}
	return {
		targetSessionId,
		action: actionRaw,
		candidateId,
		candidateContentHash,
		generation,
		allowedPathDigest,
	};
}

export async function handleApproveWriteCommand(
	directory: string,
	args: string[],
	sessionID: string,
): Promise<string> {
	const parsed = parseApproveWriteArgs(args ?? []);
	if (parsed.error) {
		return `Error: ${parsed.error}\n\n${USAGE}`;
	}
	if (!parsed.targetSessionId || !parsed.action || !parsed.candidateId) {
		return `Error: missing required arguments.\n\n${USAGE}`;
	}
	if (!parsed.candidateContentHash) {
		return `Error: missing candidate-content-hash.\n\n${USAGE}`;
	}
	if (!sessionID?.trim()) {
		return `Error: approve-write requires an active sessionID.\n\n${USAGE}`;
	}

	try {
		const fact = await issueWriteApprovalFact({
			directory,
			issuingSessionId: sessionID,
			request: {
				targetSessionId: parsed.targetSessionId,
				action: parsed.action,
				candidateId: parsed.candidateId,
				candidateContentHash: parsed.candidateContentHash,
				allowedPathDigest: parsed.allowedPathDigest,
				generation: parsed.generation,
			},
		});
		return [
			`Issued write approval ${fact.id}.`,
			`Target session: ${fact.targetSessionId}`,
			`Action: ${fact.action}`,
			`Candidate: ${fact.candidateId}`,
			`Expires: ${fact.expiresAt}`,
			`Replay command: ${formatApproveWriteCommand(fact)}`,
		].join('\n');
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `Error: ${message}\n\n${USAGE}`;
	}
}
