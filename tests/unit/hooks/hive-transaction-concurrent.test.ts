/**
 * Storage gate (issue #1847 §"Required tests"): proves hive writes routed
 * through ONE transaction cannot lose entries under concurrent writers.
 *
 * This is the gold-standard test that mocks CANNOT satisfy: it spawns REAL
 * child processes that promote different entries into the SAME shared hive
 * file, then asserts both survive. Before #1847, the read→append→rewrite→cap
 * sequence was non-atomic and one process's rewrite silently dropped the
 * other's entry. After #1847, every hive write goes through `transactHiveStore`
 * under one directory lock, so both entries persist.
 *
 * Precedent: tests/unit/commands/unlink-concurrent-append.test.ts (real
 * child-process append vs unlink race).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import {
	promises as fsPromises,
	mkdtempSync,
	realpathSync,
	rmSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveHiveKnowledgePath } from '../../../src/knowledge/hive-paths.js';

async function readHiveCount(): Promise<number> {
	try {
		const content = await fsPromises.readFile(
			resolveHiveKnowledgePath(),
			'utf-8',
		);
		return content.split('\n').filter((l) => l.trim().length > 0).length;
	} catch {
		return 0;
	}
}

/** Spawn a child bun process that runs the promotion script as its entry file. */
function spawnPromoter(scriptPath: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [scriptPath], {
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
		let stderr = '';
		child.stderr?.on('data', (d) => {
			stderr += d.toString();
		});
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) resolve(0);
			else reject(new Error(`child exited ${code}: ${stderr.slice(0, 500)}`));
		});
	});
}

describe('hive transaction storage gate (#1847)', () => {
	let tempHome: string;
	let realHome: string | undefined;
	let scriptDir: string;

	beforeEach(() => {
		tempHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hive-conc-')));
		realHome = process.env.HOME;
		process.env.HOME = tempHome;
		if (process.platform === 'win32') {
			process.env.LOCALAPPDATA = path.join(tempHome, 'AppData', 'Local');
		}
		scriptDir = realpathSync(
			mkdtempSync(path.join(os.tmpdir(), 'hive-scripts-')),
		);
	});

	afterEach(() => {
		if (realHome === undefined) delete process.env.HOME;
		else process.env.HOME = realHome;
		delete process.env.LOCALAPPDATA;
		rmSync(tempHome, { recursive: true, force: true });
		rmSync(scriptDir, { recursive: true, force: true });
	});

	it('two concurrent processes promoting different entries both survive', async () => {
		// Two scripts, each promoting a distinct entry into the same hive file
		// (HOME is shared → same resolveHiveKnowledgePath). Both run concurrently.
		const scriptA = path.join(scriptDir, 'promote-a.mjs');
		const scriptB = path.join(scriptDir, 'promote-b.mjs');
		const entryA = 'Always run the type checker before opening a pull request';
		const entryB =
			'Never commit secrets into the repository source control tree';

		const promoterPath = path
			.resolve(process.cwd(), 'src/hooks/hive-promoter.ts')
			.replace(/\\/g, '/');
		const loader = (
			lesson: string,
			cohortId: string,
		) => `import { promoteToHive, _internals } from "${promoterPath}";
_internals.resolveCohortId = async () => ({ cohortId: ${JSON.stringify(cohortId)}, source: 'remote', normalizedRemote: 'github.com/t/r', degraded: false });
await promoteToHive(${JSON.stringify(tempHome)}, ${JSON.stringify(lesson)});
`;

		await fsPromises.writeFile(scriptA, loader(entryA, 'c-a'), 'utf-8');
		await fsPromises.writeFile(scriptB, loader(entryB, 'c-b'), 'utf-8');

		// Run both concurrently — the lost-update race window.
		await Promise.all([spawnPromoter(scriptA), spawnPromoter(scriptB)]);

		// BOTH entries must survive. Before #1847 the non-atomic rewrite dropped
		// one; under the transaction both persist.
		const content = await fsPromises.readFile(
			resolveHiveKnowledgePath(),
			'utf-8',
		);
		expect(content).toContain(entryA);
		expect(content).toContain(entryB);
		expect(await readHiveCount()).toBe(2);
	}, 60_000);

	it('concurrent promotion of the SAME lesson is idempotent (one entry, not two)', async () => {
		const lesson =
			'A shared canonical lesson about transactional hive promotion safety';
		const scriptA = path.join(scriptDir, 'same-a.mjs');
		const scriptB = path.join(scriptDir, 'same-b.mjs');
		const promoterPath = path
			.resolve(process.cwd(), 'src/hooks/hive-promoter.ts')
			.replace(/\\/g, '/');
		const loader = `import { promoteToHive, _internals } from "${promoterPath}";
_internals.resolveCohortId = async () => ({ cohortId: 'c-same', source: 'remote', normalizedRemote: 'github.com/t/r', degraded: false });
await promoteToHive(${JSON.stringify(tempHome)}, ${JSON.stringify(lesson)});
`;
		await fsPromises.writeFile(scriptA, loader, 'utf-8');
		await fsPromises.writeFile(scriptB, loader, 'utf-8');

		await Promise.all([spawnPromoter(scriptA), spawnPromoter(scriptB)]);

		// Near-duplicate dedup inside the transaction collapses both to one.
		expect(await readHiveCount()).toBe(1);
	}, 60_000);
});
