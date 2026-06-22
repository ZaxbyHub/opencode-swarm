import * as fs from 'node:fs';
import * as path from 'node:path';
import { clearTrajectoryStep } from '../hooks/trajectory-logger';
import { validateSwarmPath } from '../hooks/utils';
import { resetPrmSessionState } from '../prm';
import { swarmState } from '../state';

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Handles the /swarm reset-session command.
 * Deletes only the session state file (.swarm/session/state.json)
 * and clears in-memory agent sessions. Preserves plan, evidence,
 * and knowledge for continuity across sessions.
 */
export async function handleResetSessionCommand(
	directory: string,
	_args: string[],
): Promise<string> {
	const results: string[] = [];

	// Delete session state file
	try {
		const statePath = validateSwarmPath(directory, 'session/state.json');
		if (fs.existsSync(statePath)) {
			fs.unlinkSync(statePath);
			results.push('✅ Deleted .swarm/session/state.json');
		} else {
			results.push('⏭️ state.json not found (already clean)');
		}
	} catch {
		// Justification: best-effort session cleanup — state.json may be
		// locked by an active session or concurrently removed. The report
		// records the failure; reset-session continues to clean remaining files.
		results.push('❌ Failed to delete state.json');
	}

	// Clean all files in .swarm/session/ except state.json
	const sessionDir = path.dirname(
		validateSwarmPath(directory, 'session/state.json'),
	);
	let sessionFiles: string[] = [];
	if (fs.existsSync(sessionDir)) {
		try {
			sessionFiles = fs.readdirSync(sessionDir);
		} catch (err) {
			results.push(`❌ Failed to read session directory: ${errorMessage(err)}`);
		}
	}
	// If sessionDir doesn't exist, sessionFiles stays [] — nothing to clean, no error

	for (const file of sessionFiles) {
		if (file === 'state.json') continue; // handled separately
		const filePath = path.join(sessionDir, file);
		try {
			if (!fs.existsSync(filePath)) continue;
			if (!fs.lstatSync(filePath).isFile()) continue;
			fs.unlinkSync(filePath);
			results.push(`✓ Deleted ${file}`);
		} catch (err) {
			results.push(`❌ Failed to delete ${file}: ${errorMessage(err)}`);
		}
	}

	// Clear in-memory agent sessions
	const sessionCount = swarmState.agentSessions.size;
	for (const [sessionId, session] of swarmState.agentSessions) {
		resetPrmSessionState(session, sessionId);
		clearTrajectoryStep(sessionId);
	}
	swarmState.agentSessions.clear();
	results.push(`✅ Cleared ${sessionCount} in-memory agent session(s)`);

	// Clear delegation chains to prevent stale coder_delegated detection
	const chainCount = swarmState.delegationChains.size;
	swarmState.delegationChains.clear();
	results.push(`✅ Cleared ${chainCount} delegation chain(s)`);

	return [
		'## Session State Reset',
		'',
		...results,
		'',
		'Session state cleared. Plan, evidence, and knowledge preserved.',
		'',
		'**All circuit breakers and revision limits have been cleared.** You can continue in this session — fresh state will be initialized automatically on the next tool call.',
	].join('\n');
}
