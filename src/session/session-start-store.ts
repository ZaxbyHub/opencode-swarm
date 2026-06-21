import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const SESSION_START_FILE = 'session-start.jsonl';

export function recordSessionStart(directory: string, startMs: number): void {
	// Append-only: write a single JSON line to .jsonl. No read before write.
	// Concurrent appends are safe (append is atomic for small lines); read computes
	// min across ALL lines, so a later append cannot clobber an earlier startMs.
	try {
		const swarmDir = path.join(directory, '.swarm');
		const sessionDir = path.join(swarmDir, 'session');
		const filePath = path.join(sessionDir, SESSION_START_FILE);
		const line = JSON.stringify({ startMs, ts: Date.now() });
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(filePath, `${line}\n`, { flag: 'a' });
	} catch {
		// non-fatal — fail-open
	}
}

export function readEarliestSessionStart(directory: string): string | null {
	try {
		const filePath = path.join(
			directory,
			'.swarm',
			'session',
			SESSION_START_FILE,
		);
		if (!existsSync(filePath)) return null;
		const content = readFileSync(filePath, 'utf-8');
		const lines = content.split('\n');
		const validStartMs: number[] = [];
		for (const line of lines) {
			if (!line.trim()) continue; // skip empty lines
			try {
				const parsed = JSON.parse(line) as { startMs?: unknown };
				if (
					typeof parsed.startMs === 'number' &&
					Number.isFinite(parsed.startMs)
				) {
					validStartMs.push(parsed.startMs);
				}
			} catch {
				// skip corrupt lines — fail-open per line
			}
		}
		if (validStartMs.length === 0) return null;
		return new Date(Math.min(...validStartMs)).toISOString();
	} catch {
		return null;
	}
}

export const _internals = { recordSessionStart, readEarliestSessionStart };
