/**
 * Test-only: an in-memory stand-in for the CartridgeRecord model, enough of
 * Mongo's query language (equality, dotted paths, $in, $nin, $exists, $regex,
 * $or, $and, $nor) and $set / $push to exercise the customer-held guard.
 * Imported only from *.test.ts files.
 */

type Doc = Record<string, any>;

function getPath(doc: Doc, path: string): unknown {
	return path.split('.').reduce<any>((v, k) => (v == null ? undefined : v[k]), doc);
}

function setPath(doc: Doc, path: string, value: unknown) {
	const keys = path.split('.');
	let cur = doc;
	for (const k of keys.slice(0, -1)) {
		if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
		cur = cur[k];
	}
	cur[keys[keys.length - 1]] = value;
}

function matchValue(actual: unknown, cond: any): boolean {
	if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
		const ops = Object.keys(cond);
		if (ops.length && ops.every((o) => o.startsWith('$'))) {
			return ops.every((op) => {
				const v = cond[op];
				switch (op) {
					case '$in':
						return (v as unknown[]).includes(actual as any);
					case '$nin':
						return !(v as unknown[]).includes(actual as any);
					case '$exists':
						return v ? actual !== undefined : actual === undefined;
					case '$ne':
						return actual !== v;
					case '$regex':
						return typeof actual === 'string' && new RegExp(v).test(actual);
					default:
						throw new Error(`fake-cartridges: unsupported operator ${op}`);
				}
			});
		}
	}
	return actual === cond;
}

export function matches(doc: Doc, filter: Doc): boolean {
	return Object.entries(filter).every(([key, cond]) => {
		if (key === '$or') return (cond as Doc[]).some((f) => matches(doc, f));
		if (key === '$and') return (cond as Doc[]).every((f) => matches(doc, f));
		if (key === '$nor') return !(cond as Doc[]).some((f) => matches(doc, f));
		return matchValue(getPath(doc, key), cond);
	});
}

function applyUpdate(doc: Doc, update: Doc) {
	for (const [path, value] of Object.entries(update.$set ?? {})) setPath(doc, path, value);
	for (const [path, value] of Object.entries(update.$push ?? {})) {
		const arr = (getPath(doc, path) as unknown[]) ?? [];
		setPath(doc, path, [...arr, value]);
	}
	for (const path of Object.keys(update.$unset ?? {})) setPath(doc, path, undefined);
}

const query = <T>(get: () => T) => {
	const q: any = {
		select: () => q,
		sort: () => q,
		limit: () => q,
		lean: async () => structuredClone(get())
	};
	return q;
};

export function fakeCartridgeModel(docs: Map<string, Doc>) {
	const writes: Array<{ filter: Doc; update: Doc }> = [];
	const model = {
		writes,
		find: (filter: Doc = {}) => query(() => [...docs.values()].filter((d) => matches(d, filter))),
		findById: (id: string) => query(() => docs.get(id) ?? null),
		findOne: (filter: Doc) => query(() => [...docs.values()].find((d) => matches(d, filter)) ?? null),
		updateOne: async (filter: Doc, update: Doc) => {
			writes.push({ filter, update });
			const doc = [...docs.values()].find((d) => matches(d, filter));
			if (!doc) return { matchedCount: 0, modifiedCount: 0 };
			applyUpdate(doc, update);
			return { matchedCount: 1, modifiedCount: 1 };
		},
		updateMany: async (filter: Doc, update: Doc) => {
			writes.push({ filter, update });
			const hit = [...docs.values()].filter((d) => matches(d, filter));
			hit.forEach((d) => applyUpdate(d, update));
			return { matchedCount: hit.length, modifiedCount: hit.length };
		},
		findByIdAndUpdate: async (id: string, update: Doc) => {
			writes.push({ filter: { _id: id }, update });
			const doc = docs.get(id);
			if (doc) applyUpdate(doc, update);
			return doc ?? null;
		},
		bulkWrite: async (ops: Array<{ updateOne: { filter: Doc; update: Doc } }>) => {
			let modifiedCount = 0;
			for (const op of ops) modifiedCount += (await model.updateOne(op.updateOne.filter, op.updateOne.update)).modifiedCount;
			return { modifiedCount };
		}
	};
	return model;
}

/** A cart a customer app linked through /api/v1. */
export const customerLinked = (id: string, extra: Doc = {}): Doc => ({
	_id: id,
	status: 'linked',
	priorStatus: 'released',
	checkpoints: { linked: { who: 'app:h_abcdefghijklmnop', when: '2026-11-01T00:00:00.000Z', where: {}, via: 'bioscale-app' } },
	...extra
});

/** A cart the research app's arm scan linked (no `via`, research user). */
export const researchLinked = (id: string, extra: Doc = {}): Doc => ({
	_id: id,
	status: 'linked',
	experiment: '374 - Carts for Chris',
	checkpoints: { linked: { who: 'chris', when: '2026-11-01T00:00:00.000Z', where: {} } },
	...extra
});
