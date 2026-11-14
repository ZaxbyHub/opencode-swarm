import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

try {
	const [root, repo, pr, run, head, review] = process.argv.slice(2);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run)) process.exit(1);
	const relative = ['.swarm', 'pr-review', run, 'native-submission.json'];
	let file = realpathSync(root);
	for (const part of relative) {
		file = resolve(file, part);
		if (lstatSync(file).isSymbolicLink()) process.exit(1);
	}
	if (!file.startsWith(realpathSync(root) + sep)) process.exit(1);
	const stat = lstatSync(file);
	if (!stat.isFile() || stat.size > 4096) process.exit(1);
	const receipt = JSON.parse(readFileSync(file, 'utf8'));
	const chunks = [];
	let length = 0;
	for await (const chunk of process.stdin) {
		length += chunk.length;
		if (length > 2 * 1024 * 1024) process.exit(1);
		chunks.push(chunk);
	}
	const body = Buffer.concat(chunks).toString('utf8').trimEnd();
	const digest = createHash('sha256').update(body).digest('hex');
	if (receipt.run_id !== run || receipt.head !== head || receipt.repo !== repo ||
		receipt.pr !== Number(pr) || receipt.review_id !== Number(review) || receipt.body_sha256 !== digest) process.exit(1);
} catch {
	process.exit(1);
}
