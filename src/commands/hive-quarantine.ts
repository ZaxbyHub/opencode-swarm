/**
 * `/swarm knowledge hive-quarantine` — human-only knowledge maintenance for the
 * machine-global hive store (issue #2033).
 *
 * Flow (operator-driven; no `--yes`/`--force` flag exists — the only
 * non-interactive escape is the explicit SWARM_ALLOW_HUMAN_ONLY_CLI=1 opt-in):
 *   preview  <id>[,<id>…]            read-only snapshot + confirmation token
 *   commit   --token <t> [--reason r] validated backup → exact-ID quarantine → verify
 *   rollback --token <t12> | --latest  idempotent byte-exact restore from the manifest
 *   status                            read-only list of quarantine backups
 *
 * Layered gates (PR #2200 review): `toolPolicy: 'human-only'` refuses agents at
 * `swarm_command` classification and the chat-fallback policy blocks agent-typed
 * usage; the shell guardrail blocks direct, quoted, path-qualified, and
 * shell-variable-indirected CLI invocations from agent shells; the CLI entry
 * itself refuses human-only commands from non-interactive shells (aliases
 * resolved to their canonical policy). The confirmation token is HMAC-bound to
 * a per-install secret, so it cannot be minted from public store contents
 * alone. These layers are defense-in-depth with an honest audit trail — local
 * single-user tooling cannot be tamper-proof against the owning user, and the
 * docs make no absolute claim otherwise.
 */

import {
	commitHiveQuarantine,
	listHiveQuarantineBackups,
	previewHiveQuarantine,
	rollbackHiveQuarantine,
} from '../knowledge/hive-quarantine.js';

const USAGE = [
	'Usage:',
	'  /swarm knowledge hive-quarantine preview <entry-id>[,<entry-id>...]',
	'  /swarm knowledge hive-quarantine commit --token <token> [--reason <text>]',
	'  /swarm knowledge hive-quarantine rollback --token <token12> | --latest',
	'  /swarm knowledge hive-quarantine status',
	'',
	'Exact-ID selection only. Preview shows hashes/provenance and issues a short-lived',
	'token; commit re-verifies the store under lock, creates a validated backup, moves',
	'exactly the selected entries to a quarantine sidecar, and verifies counts/hashes.',
	'Rollback restores the exact original bytes from the manifest (idempotent).',
].join('\n');

function parseFlag(args: string[], name: string): string | undefined {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === name && i + 1 < args.length) return args[i + 1];
		const withEq = `${name}=`;
		if (args[i].startsWith(withEq)) return args[i].slice(withEq.length);
	}
	return undefined;
}

export async function handleKnowledgeHiveQuarantineCommand(
	_directory: string,
	args: string[],
): Promise<string> {
	const stage = args[0];

	if (stage === 'preview') {
		const idsArg = args[1];
		if (!idsArg || idsArg.startsWith('--')) return USAGE;
		const ids = idsArg
			.split(',')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const result = await previewHiveQuarantine(ids);
		if (!result.ok) {
			return `❌ Preview failed (${result.code}): ${result.error}`;
		}
		const p = result.preview;
		const lines: string[] = [
			'## Hive quarantine preview (read-only)',
			'',
			`Store: ${p.store_entry_count} entries · sha256 ${p.store_file_sha256.slice(0, 12)}… · plugin ${p.plugin_version}`,
			'',
			'| ID | Status | Conf | Category | Source project | Lineage actor | Updated | Line sha256 |',
			'|----|--------|------|----------|----------------|---------------|---------|-------------|',
		];
		for (const r of p.records) {
			lines.push(
				`| ${r.id} | ${r.status} | ${Math.round(r.confidence * 100)}% | ${r.category} | ${
					r.source_project ?? '—'
				} | ${r.lineage_actor ?? '—'} | ${r.updated_at.slice(0, 10)} | ${r.raw_line_sha256.slice(0, 12)}… |`,
			);
		}
		lines.push(
			'',
			`Token (expires ${p.expires_at}):`,
			'',
			'```',
			p.token,
			'```',
			'',
			'To quarantine exactly these entries, a human operator runs:',
			'`/swarm knowledge hive-quarantine commit --token <token> [--reason <text>]`',
		);
		return lines.join('\n');
	}

	if (stage === 'commit') {
		const token = parseFlag(args, '--token');
		const reason = parseFlag(args, '--reason');
		if (!token) return USAGE;
		const result = await commitHiveQuarantine({ token, reason });
		if (!result.ok) {
			return `🚫 Commit aborted (${result.code}) — ${result.error}`;
		}
		const r = result.result;
		return [
			'✅ Hive quarantine committed.',
			`- Quarantined ${r.quarantinedIds.length} exact entr${r.quarantinedIds.length === 1 ? 'y' : 'ies'}: ${r.quarantinedIds.join(', ')}`,
			`- Store entries: ${r.storeEntriesBefore} → ${r.storeEntriesAfter} (verified)`,
			`- Backup: ${r.backupDir} (${r.backupBytes} bytes, hash-verified)`,
			'',
			'Rollback any time with:',
			`\`/swarm knowledge hive-quarantine rollback --latest\``,
		].join('\n');
	}

	if (stage === 'rollback') {
		const token = parseFlag(args, '--token');
		const latest = args.includes('--latest');
		if (!token && !latest) return USAGE;
		const result = await rollbackHiveQuarantine({ ref: token ?? 'latest' });
		if (!result.ok) {
			return `🚫 Rollback aborted (${result.code}) — ${result.error}`;
		}
		const r = result.result;
		const parts: string[] = [];
		if (r.restoredIds.length > 0) {
			parts.push(
				`restored ${r.restoredIds.length} entr${r.restoredIds.length === 1 ? 'y' : 'ies'} (${r.restoredIds.join(', ')}) — byte-exact, hash-verified: ${r.verified}`,
			);
		}
		if (r.alreadyPresentIds.length > 0) {
			parts.push(
				`${r.alreadyPresentIds.length} already present with identical bytes (idempotent replay)`,
			);
		}
		if (parts.length === 0)
			parts.push(
				'nothing to do (all ids already present with identical bytes)',
			);
		return `✅ Hive quarantine rollback complete — ${parts.join('; ')}. Store now has ${r.storeEntriesAfter} entries.`;
	}

	if (stage === 'status') {
		const backups = await listHiveQuarantineBackups();
		if (backups.length === 0) {
			return 'ℹ️ No hive quarantine backups exist yet.';
		}
		const lines: string[] = [
			'## Hive quarantine backups',
			'',
			'| Token (prefix) | Committed | Entries | Reason |',
			'|---------------|-----------|---------|--------|',
		];
		for (const b of backups) {
			lines.push(
				`| ${b.token12} | ${b.committed_at.slice(0, 19).replace('T', ' ')} | ${b.idCount} | ${b.reason.slice(0, 60)} |`,
			);
		}
		lines.push(
			'',
			'Rollback with: `/swarm knowledge hive-quarantine rollback --token <token12>`',
		);
		return lines.join('\n');
	}

	return USAGE;
}
