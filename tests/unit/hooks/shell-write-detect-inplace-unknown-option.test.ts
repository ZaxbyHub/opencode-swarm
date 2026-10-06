import { describe, expect, test } from 'bun:test';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';

function inplaceTargets(command: string): Array<string | null> {
	return detectPosixWrites(command)
		.writes.filter((w) => w.category === 'inplace_edit')
		.map((w) => w.path);
}

/**
 * The in-place picker models a fixed set of option words per command. An
 * option word it does not recognise (a GNU long-option abbreviation such as
 * `--expr=`, a bundle with an unmodelled letter such as perl `-fpe...`) can
 * supply the script itself. It is never read as an argument-less switch:
 * it is reported, no later word is taken for the implicit script (or the
 * awk program), and every remaining positional is reported. Taking the real
 * file for the implicit script reported nothing at all.
 */
describe('shell-write-detect: an option word the picker does not model', () => {
	describe('sed', () => {
		test.each([
			// -b (--binary) is an argument-less switch: `-be...` attaches -e.
			['sed -i -bes/a/X/ /etc/passwd', ['/etc/passwd']],
			['sed -i -bEes/a/X/ ../v', ['../v']],
			['sed -i -sbes/a/X/ ../v', ['../v']],
			['sed -i -bfs.sed ../v', ['../v']],
			['sed -bes/a/X/ ../v -i', ['../v']],
			['sed -i -n -bes/a/X/ ../v', ['../v']],
			['sed -i.bak -bes/a/X/ ../v', ['../v']],
			// getopt_long abbreviations are not modelled: reported.
			['sed -i --expr=s/a/X/ ../v', ['--expr=s/a/X/', '../v']],
			['sed -i --e=s/a/X/ ../v', ['--e=s/a/X/', '../v']],
			['sed -i --expressio=s/a/X/ ../v', ['--expressio=s/a/X/', '../v']],
			['sed -i --fil=s.sed ../v', ['--fil=s.sed', '../v']],
			['sed --e=s/a/X/ -i /etc/passwd', ['--e=s/a/X/', '/etc/passwd']],
			['sed --expr=s/a/X/ ../v -i', ['--expr=s/a/X/', '../v']],
			['sed -i.bak --expr=s/a/X/ ../v', ['--expr=s/a/X/', '../v']],
			['sed -i --quie 1d f', ['--quie', '1d', 'f']],
		])('%s edits %j', (command, files) => {
			expect(inplaceTargets(command)).toEqual(files);
		});
	});

	describe('perl', () => {
		test.each([
			['perl -i -fpes/a/X/ /etc/passwd', ['-fpes/a/X/', '/etc/passwd']],
			["perl -i -fpe's/a/X/' ../v", ['-fpes/a/X/', '../v']],
			['PERLDB_OPTS=NonStop perl -i -pdes/a/X/ ../v', ['-pdes/a/X/', '../v']],
			['perl -i.bak -fpes/a/X/ ../v', ['-fpes/a/X/', '../v']],
			// Option parsing stops after the unmodelled word (fail-safe).
			['perl -i -MO=Deparse -pe 1 ../v', ['-MO=Deparse', '-pe', '1', '../v']],
		])('%s edits %j', (command, files) => {
			expect(inplaceTargets(command)).toEqual(files);
		});
	});

	describe('awk', () => {
		test.each([
			[
				`awk -i inplace --sourc='{print "X"}' ../v`,
				['--sourc={print "X"}', '../v'],
			],
			[`awk -i inplace -be'{print "X"}' ../v`, ['-be{print "X"}', '../v']],
			[
				`awk -i inplace -Wsource='{print "X"}' ../v`,
				['-Wsource={print "X"}', '../v'],
			],
			['awk -i inplace --exec=p.awk ../v', ['--exec=p.awk', '../v']],
			['awk -i inplace -bfp.awk ../v', ['-bfp.awk', '../v']],
			// The program is not taken from the positionals either.
			["awk -i inplace -M '{print}' ../v", ['-M', '{print}', '../v']],
		])('%s edits %j', (command, files) => {
			expect(inplaceTargets(command)).toEqual(files);
		});
	});
});

/** Modelled options keep their handling: only the file is reported. */
describe('shell-write-detect: modelled options report only the file', () => {
	test.each([
		["sed -i 's/a/b/' src/f.ts", ['src/f.ts']],
		["sed -i -e 's/a/b/' src/f.ts", ['src/f.ts']],
		['sed -n -i p src/f.ts', ['src/f.ts']],
		["sed -E -i 's/a/b/' src/f.ts", ['src/f.ts']],
		["sed -r -i 's/a/b/' src/f.ts", ['src/f.ts']],
		["sed -s -i 's/a/b/' src/f.ts", ['src/f.ts']],
		["sed -z -i 's/a/b/' src/f.ts", ['src/f.ts']],
		["sed -u -i 's/a/b/' src/f.ts", ['src/f.ts']],
		["sed -b -i 's/a/b/' src/f.ts", ['src/f.ts']],
		["sed --posix -i 's/a/b/' src/f.ts", ['src/f.ts']],
		["sed --debug -i 's/a/b/' src/f.ts", ['src/f.ts']],
		["sed --follow-symlinks -i 's/a/b/' src/f.ts", ['src/f.ts']],
		["sed --quiet -i 's/a/b/' src/f.ts", ['src/f.ts']],
		["sed -i -E -e 's/a/b/' src/f.ts", ['src/f.ts']],
		['sed -i -e 1d -e 2d src/f.ts', ['src/f.ts']],
		["sed -i '' -E 's/a/b/' src/f.ts", ['src/f.ts']],
		['sed -i.bak -e 1d src/f.ts', ['src/f.ts']],
		['sed -l 5 -i 1d src/f.ts', ['src/f.ts']],
		['sed -i --line-length=5 1d src/f.ts', ['src/f.ts']],
		["sed -i --expression='s/a/b/' src/f.ts", ['src/f.ts']],
		["perl -i -pe 's/a/b/' src/f.ts", ['src/f.ts']],
		["perl -i.bak -ne 'print' src/f.ts", ['src/f.ts']],
		["perl -i -0777 -pe 's/a/b/' src/f.ts", ['src/f.ts']],
		["awk -i inplace -v x=1 '{print}' src/f.ts", ['src/f.ts']],
		['awk -i inplace -f p.awk src/f.ts', ['src/f.ts']],
		["awk -i inplace --posix '{print}' src/f.ts", ['src/f.ts']],
		// -b bundles with the other switches, -e, -f and -l.
		['sed -i -be 1d ../v', ['../v']],
		// -be consumes `1d` as its script, so `1d` is not a file.
		['sed -i -be 1d -e 2d ../v', ['../v']],
		['sed -i -bse 1d ../v', ['../v']],
		['sed -bl 5 -i 1d src/f.ts', ['src/f.ts']],
		['sed -i -bs 1d src/f.ts', ['src/f.ts']],
		['sed -i -sb 1d src/f.ts', ['src/f.ts']],
	])('%s edits %j', (command, files) => {
		expect(inplaceTargets(command)).toEqual(files);
	});
});

/**
 * An option that takes a detached argument consumes the next word whatever
 * it looks like, as getopt does: `awk -F -f '{...}' f` sets FS to `-f` and
 * runs the program `{...}` on f. The argument is never parsed again as an
 * option, the script or the awk program, so the real file stays reported.
 */
describe('shell-write-detect: a detached option argument is never re-parsed', () => {
	test.each([
		[`awk -i inplace -F -f '{print "X"}' ../v`, ['../v']],
		[`awk -i inplace -F -e '{print "X"}' ../v`, ['../v']],
		[`awk -i inplace -F -v '{print "X"}' ../v`, ['../v']],
		[`awk -i inplace -F -F '{print "X"}' ../v`, ['../v']],
		[`awk -i inplace -F -i '{print "X"}' ../v`, ['../v']],
		[`awk -i inplace -F -f '{print "X"}' /etc/passwd`, ['/etc/passwd']],
		[`awk -i inplace -F -e '{print "X"}' /etc/passwd`, ['/etc/passwd']],
		[`awk -i inplace -F -v '{print "X"}' /etc/passwd`, ['/etc/passwd']],
		[`awk -i inplace -F -F '{print "X"}' /etc/passwd`, ['/etc/passwd']],
		[`awk -i inplace -F -i '{print "X"}' /etc/passwd`, ['/etc/passwd']],
		[`awk -i inplace -F -- '{print "X"}' ../v`, ['../v']],
		// sed: the argument of -l is not the script (`1d` is).
		['sed -i -l 5 1d ../v', ['../v']],
		['sed -l 5 1d -i ../v', ['../v']],
		// perl: -e takes `-pe` as its code; ../v stays reported.
		['perl -i -e -pe ../v', ['../v']],
		// Controls: ordinary arguments keep their handling.
		["awk -i inplace -F, '{print}' src/f.ts", ['src/f.ts']],
		["awk -i inplace -v x=1 -F : '{print}' src/f.ts", ['src/f.ts']],
		['sed -e 1d -n -i src/f.ts', ['src/f.ts']],
	])('%s edits %j', (command, files) => {
		expect(inplaceTargets(command)).toEqual(files);
	});
});
