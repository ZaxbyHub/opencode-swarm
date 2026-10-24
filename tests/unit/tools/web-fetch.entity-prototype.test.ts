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

		test('still decodes valid named entities', () => {
			expect(htmlToText('<p>&amp; &lt; &gt;</p>')).toBe('& < >');
			expect(htmlToText('<p>a&nbsp;b</p>')).toBe('a b');
		});
	});
});
