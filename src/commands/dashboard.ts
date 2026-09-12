/**
 * `/swarm dashboard` — report the opt-in local mission-control dashboard's
 * state (issue #2509, Workstream G5).
 *
 * Read-only. Three outcomes:
 * - LISTENING: prints the tokened browsing URL (token from the in-process
 *   registry only — it is never persisted).
 * - DISABLED (port conflict / bind failure): explains why and how to fix.
 * - OFF (default): explains the `dashboard.port` opt-in.
 *
 * The command never starts or stops the listener; lifecycle belongs to the
 * post-resolution init task in `src/index.ts`.
 */

import { getDashboardHandle } from '../dashboard/index.js';
import { readSwarmFileAsync } from '../hooks/utils';
import type { CommandResult } from './registry';

interface DashboardStatusFileRecord {
	status?: unknown;
	port?: unknown;
	url?: unknown;
}

async function readStatusFileRecord(
	directory: string,
): Promise<DashboardStatusFileRecord | null> {
	try {
		const raw = await readSwarmFileAsync(directory, 'dashboard-status.json');
		if (!raw) return null;
		const parsed = JSON.parse(raw) as DashboardStatusFileRecord;
		return typeof parsed === 'object' && parsed !== null ? parsed : null;
	} catch {
		return null;
	}
}

export async function handleDashboardCommand(
	directory: string,
	_args: string[] | string,
): CommandResult {
	const handle = getDashboardHandle(directory);
	if (handle && handle.listening) {
		return [
			'## Swarm dashboard',
			'',
			`Status: **listening** on 127.0.0.1:${handle.port} (read-only, token-protected)`,
			'',
			`Open: ${handle.url ?? '(url unavailable)'}`,
			'',
			'Views: gates & circuits, pending-delegation age bands, lane liveness, task board, activity timeline.',
			'This page is read-only; abort/recover actions stay in the swarm commands and tools.',
		].join('\n');
	}

	const record = await readStatusFileRecord(directory);
	if (record && typeof record.status === 'string') {
		if (record.status === 'disabled_port_conflict') {
			return [
				'## Swarm dashboard',
				'',
				'**Disabled — port conflict.** The configured `dashboard.port` is already in use (or the bind failed), so no listener is running.',
				'',
				'Fix: free the port or set another `dashboard.port` in your opencode-swarm.json, then restart the host.',
			].join('\n');
		}
		if (record.status === 'stopped') {
			return [
				'## Swarm dashboard',
				'',
				'The dashboard listener was stopped (host shutdown). It restarts with the next host boot when `dashboard.port` is set.',
			].join('\n');
		}
	}

	return [
		'## Swarm dashboard',
		'',
		'**Disabled (default).** The local mission-control dashboard is opt-in.',
		'',
		'To enable, set a loopback port in your opencode-swarm.json:',
		'',
		'```json',
		'{',
		'  "dashboard": { "port": 47832 }',
		'}',
		'```',
		'',
		'When enabled, a read-only, token-protected view (gates & circuits, delegation age bands, lane liveness, task board, activity timeline) serves on 127.0.0.1 and starts after plugin init; port 0 or absent keeps it fully off.',
	].join('\n');
}
