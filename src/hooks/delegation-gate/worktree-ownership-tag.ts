import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunSpawn } from '../../utils/bun-compat';

const OWNERSHIP_TAG_SCAN_TIMEOUT_MS = 2_000;
const MAX_OWNERSHIP_TAGS = 512;

export interface BackgroundWorktreeOwnershipTag {
	sessionId: string;
	laneId: string;
	callDigest: string;
	ref: string;
}

export type BackgroundWorktreeOwnershipTagScan =
	| { status: 'ok'; owners: BackgroundWorktreeOwnershipTag[] }
	| { status: 'uncertain'; reason: string };

function decodeTagPart(value: string): string | null {
	if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
	const decoded = Buffer.from(value, 'base64url').toString('utf8');
	return decoded && Buffer.from(decoded, 'utf8').toString('base64url') === value
		? decoded
		: null;
}

/**
 * Strict, bounded ownership-tag scan shared by init recovery and restart
 * collision classification. Any malformed or unreadable entry is uncertainty:
 * destructive cleanup must never infer absence from incomplete ownership data.
 */
export async function scanBackgroundWorktreeOwnershipTagsForRecovery(
	directory: string,
): Promise<BackgroundWorktreeOwnershipTagScan> {
	try {
		fs.statSync(path.join(directory, '.git'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { status: 'ok', owners: [] };
		}
		return {
			status: 'uncertain',
			reason: `Git metadata could not be inspected: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}

	const proc = bunSpawn(
		[
			'git',
			'-C',
			directory,
			'for-each-ref',
			`--count=${MAX_OWNERSHIP_TAGS + 1}`,
			'--format=%(refname:strip=2)%00%(objectname)',
			'refs/tags/swarm-preserved-owner/',
		],
		{
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'ignore',
			timeout: OWNERSHIP_TAG_SCAN_TIMEOUT_MS,
		},
	);
	try {
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			return {
				status: 'uncertain',
				reason: `ownership tag scan exited ${exitCode}`,
			};
		}
		const lines = (await proc.stdout.text())
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		if (lines.length > MAX_OWNERSHIP_TAGS) {
			return {
				status: 'uncertain',
				reason: `ownership tag scan exceeded the ${MAX_OWNERSHIP_TAGS}-tag safety bound`,
			};
		}

		const owners: BackgroundWorktreeOwnershipTag[] = [];
		for (const line of lines) {
			const [tag, ref, ...extra] = line.split('\0');
			const segments = tag?.split('/') ?? [];
			const sessionId = decodeTagPart(segments[1] ?? '');
			const laneId = decodeTagPart(segments[2] ?? '');
			const callDigest = segments[3];
			if (
				extra.length > 0 ||
				segments.length !== 4 ||
				segments[0] !== 'swarm-preserved-owner' ||
				!sessionId ||
				!laneId ||
				!callDigest ||
				!/^[0-9a-f]{12}$/.test(callDigest) ||
				!ref ||
				!/^[0-9a-f]{40,64}$/i.test(ref)
			) {
				return {
					status: 'uncertain',
					reason: `malformed background ownership tag entry "${tag ?? ''}"`,
				};
			}
			owners.push({ sessionId, laneId, callDigest, ref });
		}
		return { status: 'ok', owners };
	} catch (error) {
		return {
			status: 'uncertain',
			reason: `ownership tag scan failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	} finally {
		try {
			proc.kill();
		} catch {
			// best-effort
		}
	}
}
