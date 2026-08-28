import { createHash } from 'node:crypto';

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return value;
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new TypeError('canonical JSON rejects non-finite numbers');
		}
		return Object.is(value, -0) ? 0 : value;
	}
	if (value === undefined) return undefined;
	if (typeof value !== 'object') {
		throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
	}
	if (ancestors.has(value)) {
		throw new TypeError('canonical JSON rejects cyclic values');
	}
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((entry) => {
				const encoded = canonicalize(entry, ancestors);
				return encoded === undefined ? null : encoded;
			});
		}
		const record = value as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			const encoded = canonicalize(record[key], ancestors);
			if (encoded !== undefined) result[key] = encoded;
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value, new Set()));
}

export function sha256(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

export function canonicalHash(value: unknown): string {
	return sha256(canonicalJson(value));
}

export function contentHashWithout<T extends Record<string, unknown>>(
	value: T,
	keys: readonly (keyof T)[],
): string {
	const copy = { ...value };
	for (const key of keys) delete copy[key];
	return canonicalHash(copy);
}
