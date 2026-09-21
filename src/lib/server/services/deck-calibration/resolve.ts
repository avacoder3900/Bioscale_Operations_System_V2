/**
 * One deterministic way to turn a loadName into exactly one labware definition.
 *
 * Why this exists: `labware_definitions` is uniquely indexed on the TRIPLE
 * (namespace, loadName, version), so the collection legitimately permits several
 * documents sharing a loadName. Every historical call site queried
 * `findOne({ loadName })` — no namespace, no version, and no sort — which
 * returns whichever document Mongo happens to hand back first. Natural order is
 * not stable: it can change when a document grows past its allocated space and
 * is relocated, which an in-place `$set` on a 576-well blob does routinely.
 *
 * The consequence was silent and expensive: the Studio could display and edit
 * one document while a different one was bundled to the robot. Production
 * currently has no duplicate loadNames, so this never fired — but the moment
 * anyone uploads a v2 of a deck, every one of those call sites becomes a coin
 * flip. Routing them all through here makes that impossible by construction.
 */
import { connectDB, LabwareDefinition } from '$lib/server/db';

export interface ResolveOptions {
	/** Restrict to one namespace (e.g. 'cosmas_damian'). */
	namespace?: string | null;
	/** Restrict to one exact version. Omit to take the highest. */
	version?: number | null;
	/**
	 * Refuse to guess. When several documents match, throw instead of taking the
	 * highest version. Use for anything that reaches the robot.
	 */
	strict?: boolean;
}

export interface ResolvedDefinition {
	doc: any;
	/** How many documents matched. >1 means the loadName alone was ambiguous. */
	matchCount: number;
	/** namespace/loadName/version — the Opentrons definition URI. */
	uri: string;
}

/**
 * Resolve a loadName to a single definition document.
 *
 * Ordering is fully deterministic: highest version wins, ties broken by most
 * recently updated, then by `_id`. `_id` is the final tiebreak precisely because
 * it can never tie, so the result never depends on storage order.
 *
 * @throws when nothing matches, or when `strict` and the match is ambiguous.
 */
export async function resolveLabwareDefinition(
	loadName: string,
	opts: ResolveOptions = {}
): Promise<ResolvedDefinition> {
	await connectDB();
	const q: Record<string, unknown> = { loadName };
	if (opts.namespace) q.namespace = opts.namespace;
	if (opts.version != null) q.version = opts.version;

	const docs = (await LabwareDefinition.find(q)
		.sort({ version: -1, updatedAt: -1, _id: 1 })
		.lean()) as any[];

	if (!docs.length) {
		const scope = opts.namespace || opts.version != null
			? ` (namespace=${opts.namespace ?? 'any'}, version=${opts.version ?? 'any'})`
			: '';
		throw new Error(`Labware definition "${loadName}" not found in labware_definitions${scope}.`);
	}

	if (docs.length > 1 && opts.strict) {
		const seen = docs.map((d) => `${d.namespace}/${d.loadName}/${d.version}`).join(', ');
		throw new Error(
			`Labware "${loadName}" is ambiguous — ${docs.length} definitions match: ${seen}. ` +
				`Pass an explicit namespace and version, or archive the duplicates.`
		);
	}

	const doc = docs[0];
	return {
		doc,
		matchCount: docs.length,
		uri: `${doc.namespace}/${doc.loadName}/${doc.version}`
	};
}

/** True when a loadName is a cartridge deck. Mirrors the Studio's DECK_RE. */
export const DECK_RE = /(gen4deck|cartridge_deck)/i;
export const isDeckLoadName = (loadName: string): boolean => DECK_RE.test(loadName ?? '');
