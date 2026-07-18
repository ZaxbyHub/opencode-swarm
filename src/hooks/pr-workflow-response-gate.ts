import { readPrWorkflowGateState } from './pr-workflow-gate.js';

const DEFAULT_WAKE_TIMEOUT_MS = 5_000;

interface PromptResult {
	error?: unknown;
}

interface SessionClient {
	prompt: (args: unknown) => Promise<PromptResult>;
	promptAsync?: (args: unknown) => Promise<PromptResult>;
}

interface PrWorkflowResponseGateClient {
	session?: unknown;
}

interface IdleEvent {
	type?: unknown;
	properties?: { sessionID?: unknown };
}

function blockedText(mode: string): string {
	return [
		`[${mode} MECHANICAL GATE: FINAL RESPONSE BLOCKED]`,
		'This workflow still has an active durable gate. The replaced text is not a valid review, closure ledger, or completion verdict.',
		'Continue with the required structured lanes and evidence. Only complete_pr_workflow can clear the gate after every mandatory obligation settles.',
	].join('\n');
}

/**
 * Prevent an architect from bypassing PR obligations by simply emitting text.
 * The text-complete hook replaces every architect-session text part while the
 * durable gate exists; session.idle then mechanically resumes that session.
 */
export function createPrWorkflowResponseGate(options: {
	directory: string;
	client?: PrWorkflowResponseGateClient;
	wakeTimeoutMs?: number;
}) {
	const wakeTimeoutMs = options.wakeTimeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;
	const activeWakeSessions = new Set<string>();
	const session = options.client?.session as SessionClient | undefined;

	const textComplete = async (
		input: { sessionID?: string },
		output: { text: string },
	): Promise<void> => {
		if (!input.sessionID?.trim()) return;
		const state = await readPrWorkflowGateState(
			options.directory,
			input.sessionID,
		);
		if (!state) return;
		output.text = blockedText(state.mode);
	};

	const event = async (input: { event: unknown }): Promise<void> => {
		const event = input.event as IdleEvent | undefined;
		const sessionID = event?.properties?.sessionID;
		if (
			event?.type !== 'session.idle' ||
			typeof sessionID !== 'string' ||
			!sessionID.trim() ||
			activeWakeSessions.has(sessionID)
		) {
			return;
		}
		const state = await readPrWorkflowGateState(options.directory, sessionID);
		if (!state || !session) return;

		activeWakeSessions.add(sessionID);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const args = {
				path: { id: sessionID },
				body: {
					parts: [
						{
							type: 'text',
							text: `${blockedText(state.mode)}\nDo not stop or summarize. Inspect the durable gate, dispatch or collect the next missing required lane, and continue until complete_pr_workflow succeeds.`,
						},
					],
				},
			};
			const call = session.promptAsync
				? session.promptAsync(args)
				: session.prompt(args);
			const result = await Promise.race([
				call,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error('PR workflow resume prompt timed out')),
						wakeTimeoutMs,
					);
				}),
			]);
			if (result?.error != null) {
				throw new Error(
					`PR workflow resume prompt failed: ${String(result.error)}`,
				);
			}
		} finally {
			if (timer) clearTimeout(timer);
			activeWakeSessions.delete(sessionID);
		}
	};

	return { event, textComplete };
}
