import { lstatSync, readFileSync, readSync } from 'node:fs';

const sha = /^[0-9a-f]{40}$/;
const classes = new Set(['DISCRIMINATING', 'PRESERVING', 'NEW-SURFACE', 'NON-EXECUTABLE']);

function read(file) {
	if (file === '-') {
		const buffer = Buffer.alloc(1024 * 1024 + 1);
		let size = 0;
		while (size < buffer.length) {
			const count = readSync(0, buffer, size, buffer.length - size, null);
			if (!count) break;
			size += count;
		}
		if (size === buffer.length) throw new Error('published issue body exceeds 1 MiB');
		return buffer.subarray(0, size).toString('utf8').split(/\r?\n/);
	}
	const info = lstatSync(file);
	if (!info.isFile() || info.size > 1024 * 1024) {
		throw new Error('expected a regular input file of at most 1 MiB');
	}
	return readFileSync(file, 'utf8').split(/\r?\n/);
}

function section(lines, heading) {
	const start = lines.indexOf(heading);
	if (start < 0 || lines.lastIndexOf(heading) !== start) {
		throw new Error(`expected exactly one ${heading} section`);
	}
	const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
	return lines.slice(start + 1, end === -1 ? lines.length : end);
}

function publishedCriteria(lines) {
	const criteria = new Map();
	let current;
	for (const line of section(lines, '## Acceptance criteria')) {
		const criterion = /^- \[[ xX]\] (AC\d+):/.exec(line);
		if (criterion) {
			if (criteria.has(criterion[1])) throw new Error(`duplicate published ${criterion[1]}`);
			current = {};
			criteria.set(criterion[1], current);
		}
		const field = /^\s+- (class|argv):\s*(.*)$/.exec(line);
		if (field && current) {
			if (Object.hasOwn(current, field[1])) throw new Error(`duplicate published ${field[1]}`);
			current[field[1]] = field[2].trim();
		}
	}
	return criteria;
}

function traceChecks(lines) {
	const rows = new Map();
	for (const line of section(lines, '## Acceptance checks')) {
		if (!/^\|\s*AC\d+\s*\|/.test(line)) continue;
		const fields = line.trim().slice(1, -1).split(/(?<!\\)\|/).map((field) => field.trim());
		if (fields.length !== 8 || rows.has(fields[0])) throw new Error(`malformed or duplicate trace row ${fields[0]}`);
		const [id, classification, checkId, argv] = fields;
		rows.set(id, { classification, checkId, argv });
	}
	return rows;
}

try {
	const options = new Map();
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i += 2) {
		const name = argv[i];
		if (!['--reproduction', '--published-issue-body', '--published-replay', '--expected-head', '--checkpoint-manifest'].includes(name) ||
			options.has(name) || !argv[i + 1]) throw new Error('invalid arguments');
		options.set(name, argv[i + 1]);
	}
	const published = publishedCriteria(read(options.get('--published-issue-body')));
	const traced = traceChecks(read(options.get('--reproduction')));
	if (!published.size || !traced.size) throw new Error('acceptance criteria or checks are empty');
	const evidence = new Map();
	if (options.has('--published-replay')) {
		const expectedHead = options.get('--expected-head');
		if (!sha.test(expectedHead ?? '') || !options.has('--checkpoint-manifest')) {
			throw new Error('published replay requires expected head and checkpoint manifest');
		}
		const manifest = read(options.get('--checkpoint-manifest'));
		if (manifest.at(-1) === '') manifest.pop();
		const [manifestHeader, ...baseLines] = manifest;
		if (![1, 2].some((version) => manifestHeader === `# issue-tracer checkpoint manifest v${version} rows=${baseLines.length}`)) {
			throw new Error('invalid checkpoint manifest header');
		}
		const pairs = new Map();
		for (const [index, line] of baseLines.entries()) {
			const fields = line.split('\t');
			const [seq, kind, file, , , id, , , base] = fields;
			if (fields.length !== 10 || seq !== String(index + 1) || !file ||
				!/^C[0-9]+$/.test(id) || !sha.test(base)) throw new Error('invalid checkpoint row');
			const key = JSON.stringify([file, id]);
			if (kind !== (pairs.has(key) ? 'AMEND' : 'CHECKPOINT')) throw new Error('invalid checkpoint history');
			pairs.set(key, { id, base });
		}
		const bases = new Map();
		for (const { id, base } of pairs.values()) {
			if (bases.has(id) && bases.get(id) !== base) throw new Error('divergent checkpoint base identities');
			bases.set(id, base);
		}
		const [header, ...lines] = read(options.get('--published-replay'));
		if (header !== 'ac_id\targv\tbase_sha\tbase_exit\thead_sha\thead_exit') throw new Error('invalid replay header');
		for (const line of lines.filter(Boolean)) {
			const fields = line.split('\t');
			const [id, replayArgv, base, baseExit, head, headExit] = fields;
			const check = traced.get(id);
			const criterion = published.get(id);
			if (fields.length !== 6 || evidence.has(id) || base === head ||
				!check || check.classification === 'NON-EXECUTABLE' ||
				base !== bases.get(check.checkId) || head !== expectedHead ||
				!replayArgv || replayArgv !== criterion?.argv || ![baseExit, headExit].every((code) =>
					/^(0|[1-9][0-9]{0,2})$/.test(code) && Number(code) <= 255)) {
				throw new Error('invalid or stale published replay row');
			}
			evidence.set(id, fields);
		}
	}
	for (const [id, criterion] of published) {
		const check = traced.get(id);
		const nonExecutable = /^NON-EXECUTABLE\(([A-Z_]+)\)$/.exec(criterion.class ?? '');
		const classification = nonExecutable ? 'NON-EXECUTABLE' : criterion.class;
		if (!classes.has(classification) || !check || check.classification !== classification ||
			(nonExecutable && nonExecutable[1] !== check.checkId)) {
			console.error(`${id} published classification differs from trace or is invalid`);
			process.exitCode = 1;
			continue;
		}
		if (classification === 'NON-EXECUTABLE') continue;
		const replay = evidence.get(id);
		if (classification === 'DISCRIMINATING' && replay && replay[1] === criterion.argv &&
			replay[3] === '0' && replay[5] === '0') {
			console.error(`${id} published argv was green at both ends in the supplied replay and cannot witness the fix`);
			process.exitCode = 1;
		}
		if (!criterion.argv || check.argv !== criterion.argv) {
			console.error(`${id} published argv: ${JSON.stringify(criterion.argv ?? '(missing)')} | trace argv: ${JSON.stringify(check.argv)}`);
			process.exitCode = 1;
		} else {
			console.log(`${id} published argv matches trace`);
		}
	}
	for (const [id, check] of traced) {
		if (!published.has(id)) {
			console.error(`${id} published argv: (missing) | trace argv: ${check.argv}`);
			process.exitCode = 1;
		}
	}
} catch (error) {
	console.error(`check-published-argv: ${error.message}`);
	process.exitCode = 1;
}
