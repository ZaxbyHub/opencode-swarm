import { describe, expect, test } from 'bun:test';

import { extractTitle, htmlToText } from '../../../src/tools/web-fetch';

describe('web-fetch.ts - decodeEntities inherited Object.prototype keys', () => {
	describe('extractTitle', () => {
		test('does not decode &constructor; as the native Object function', () => {
			expect(extractTitle('<title>&constructor;</title>')).toBe(
				'&constructor;',
			);
		});

		test('does not decode &CONSTRUCTOR; (any casing) as the native Object function', () => {
			expect(extractTitle('<title>&CONSTRUCTOR;</title>')).toBe(
				'&CONSTRUCTOR;',
			);
		});

		test('does not decode &Constructor; (mixed casing) as the native Object function', () => {
			expect(extractTitle('<title>&Constructor;</title>')).toBe(
				'&Constructor;',
			);
		});

		test('still decodes valid named entities', () => {
			expect(extractTitle('<title>&amp; &lt; &gt;</title>')).toBe('& < >');
		});
	});

	describe('htmlToText', () => {
		test('does not decode &constructor; as the native Object function', () => {
			expect(htmlToText('<p>&constructor;</p>')).toBe('&constructor;');
		});

		test('does not decode &CONSTRUCTOR; (any casing) as the native Object function', () => {
			expect(htmlToText('<p>&CONSTRUCTOR;</p>')).toBe('&CONSTRUCTOR;');
		});

		test('does not decode &Constructor; (mixed casing) as the native Object function', () => {
			expect(htmlToText('<p>&Constructor;</p>')).toBe('&Constructor;');
		});

		test('still decodes valid named entities', () => {
			expect(htmlToText('<p>&amp; &lt; &gt;</p>')).toBe('& < >');
			expect(htmlToText('<p>a&nbsp;b</p>')).toBe('a b');
		});
	});
});

describe('web-fetch.ts - decodeEntities numeric character references', () => {
	test('decodes well-formed decimal and hex references', () => {
		expect(htmlToText('<p>&#65;&#x41;&#X41;&#39;</p>')).toBe("AAA'");
	});

	test('leaves a decimal reference containing hex letters undecoded instead of truncating it', () => {
		expect(htmlToText('<p>x&#1e5;y</p>')).toBe('x&#1e5;y');
		expect(htmlToText('<p>&#12ab;</p>')).toBe('&#12ab;');
	});

	test('maps NUL, surrogate and out-of-range references to U+FFFD', () => {
		expect(htmlToText('<p>&#0;</p>')).toBe('�');
		expect(htmlToText('<p>&#xD800;</p>')).toBe('�');
		expect(htmlToText('<p>&#x110000;</p>')).toBe('�');
		expect(extractTitle('<title>a&#0;b</title>')).toBe('a�b');
	});

	test('maps the whole surrogate range to U+FFFD and keeps its neighbours', () => {
		expect(htmlToText('<p>&#xDC00;</p>')).toBe('�');
		expect(htmlToText('<p>&#xDFFF;</p>')).toBe('�');
		expect(htmlToText('<p>&#xD7FF;</p>')).toBe('퟿');
		expect(htmlToText('<p>&#xE000;</p>')).toBe('');
		expect(htmlToText('<p>&#x10FFFF;</p>')).toBe('\u{10FFFF}');
	});

	test('leaves a digit run too long to be a finite number as literal text', () => {
		const huge = `&#${'9'.repeat(400)};`;
		expect(htmlToText(`<p>${huge}</p>`)).toBe(huge);
	});
});
