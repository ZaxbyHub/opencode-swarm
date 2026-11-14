import { readFileSync, readSync, statSync } from 'node:fs';

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
	if (!statSync(file).isFile() || statSync(file).size > 1024 * 1024) {
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
		const [id, classification, , argv, , base, head] = fields;
		rows.set(id, { classification, argv, base, head });
	}
	return rows;
}

try {
	const options = new Map();
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i += 2) {
		const name = argv[i];
		if (!['--reproduction', '--published-issue-body', '--published-replay'].includes(name) ||
			options.has(name) || !argv[i + 1]) throw new Error('invalid arguments');
		options.set(name, argv[i + 1]);
	}
	const published = publishedCriteria(read(options.get('--published-issue-body')));
	const traced = traceChecks(read(options.get('--reproduction')));
	if (!published.size || !traced.size) throw new Error('acceptance criteria or checks are empty');
	const evidence = new Map();
	if (options.has('--published-replay')) {
		const [header, ...lines] = read(options.get('--published-replay'));
		if (header !== 'ac_id\targv\tbase_sha\tbase_exit\thead_sha\thead_exit') throw new Error('invalid replay header');
		for (const line of lines.filter(Boolean)) {
			const fields = line.split('\t');
			const [id, , base, baseExit, head, headExit] = fields;
			if (fields.length !== 6 || evidence.has(id) || base === head ||
				![base, head].every((sha) => /^[0-9a-f]{40}$/.test(sha)) ||
				![baseExit, headExit].every((code) => /^\d+$/.test(code))) throw new Error(`invalid replay row ${id}`);
			evidence.set(id, fields);
		}
	}
	for (const [id, criterion] of published) {
		const check = traced.get(id);
		if (/^NON-EXECUTABLE/.test(criterion.class ?? '')) continue;
		if (!criterion.argv || !check || check.argv !== criterion.argv) {
			console.error(`${id} published argv: ${criterion.argv ?? '(missing)'} | trace argv: ${check?.argv ?? '(missing)'}`);
			process.exitCode = 1;
			const replay = evidence.get(id);
			if (criterion.class === 'DISCRIMINATING' && check?.base === 'RED' && check.head === 'GREEN' &&
				replay?.[1] === criterion.argv && replay?.[3] === '0' && replay?.[5] === '0') {
				console.error(`${id} published argv was green at both ends in the supplied replay and cannot witness the fix`);
			}
		} else {
			console.log(`${id} published argv matches trace`);
		}
	}
	for (const [id, check] of traced) {
		if (!/^NON-EXECUTABLE/.test(check.classification) && !published.has(id)) {
			console.error(`${id} published argv: (missing) | trace argv: ${check.argv}`);
			process.exitCode = 1;
		}
	}
} catch (error) {
	console.error(`check-published-argv: ${error.message}`);
	process.exitCode = 1;
}
