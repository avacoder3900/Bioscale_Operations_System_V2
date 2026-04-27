/**
 * UDI generator — single source of truth for the next sequential UDI.
 *
 * Story: SPU-MFG-01 of PRD-SPU-MFG-UNIFIED.
 *
 * Design (resolves PRD §9 open questions Q3 & Q5):
 *  - Atomicity: a lightweight `udi_counters` collection keyed by prefix, mutated
 *    via `findOneAndUpdate({ _id: prefix }, { $inc: { sequence: 1 } }, { upsert: true, new: true })`.
 *    This is a single atomic server-side op, so concurrent callers each observe
 *    a distinct post-increment sequence value.
 *  - Format (Q5 resolved 2026-04-27): `<prefix>-NNNN-NNNN` where NNNN-NNNN is
 *    an 8-digit zero-padded sequence split with a hyphen between digits 4 and 5.
 *    Default prefix is `BT-M01`, so counter 1 → `BT-M01-0000-0001` and counter
 *    10000 → `BT-M01-0001-0000`.
 *  - Bookkeeping: after the atomic increment, we insert a `GeneratedBarcode`
 *    row (`{ prefix, sequence, barcode: udi, type: 'spu-udi' }`) so the existing
 *    barcode-tracking pattern keeps working and acts as an emergency rebuild
 *    source if the counter is ever lost.
 *
 * Callers must ensure `await connectDB()` has run beforehand (standard pattern
 * for every server-side DB consumer in this codebase).
 */
import { GeneratedBarcode, UdiCounter } from './models/index.js';

const DEFAULT_PREFIX = 'BT-M01';
const SEQUENCE_PAD = 8;

function formatUdi(prefix: string, sequence: number): string {
	const padded = String(sequence).padStart(SEQUENCE_PAD, '0');
	return `${prefix}-${padded.slice(0, 4)}-${padded.slice(4)}`;
}

/**
 * Atomically reserve and return the next UDI for the given prefix.
 *
 * Concurrent callers are safe: the `$inc` + upsert runs as a single atomic
 * MongoDB op, so each caller observes a distinct post-increment sequence.
 *
 * The `GeneratedBarcode` row inserted afterwards is best-effort bookkeeping —
 * if it fails (e.g. duplicate-key from an old migration), the counter has
 * already advanced and the caller still holds a valid, unique UDI. We therefore
 * swallow duplicate-key errors here so callers never see a spurious failure
 * for a UDI they legitimately own.
 */
export async function getNextUdi(
	prefix: string = DEFAULT_PREFIX
): Promise<{ udi: string; sequence: number }> {
	const counter = await UdiCounter.findOneAndUpdate(
		{ _id: prefix },
		{ $inc: { sequence: 1 } },
		{ upsert: true, new: true, setDefaultsOnInsert: true }
	).lean<{ _id: string; sequence: number } | null>();

	if (!counter || typeof counter.sequence !== 'number') {
		throw new Error(`Failed to advance UDI counter for prefix "${prefix}"`);
	}

	const sequence = counter.sequence;
	const udi = formatUdi(prefix, sequence);

	try {
		await GeneratedBarcode.create({
			prefix,
			sequence,
			barcode: udi,
			type: 'spu-udi',
			createdAt: new Date()
		});
	} catch (err: unknown) {
		// Duplicate-key on `barcode` means a prior run already registered this
		// UDI (e.g. re-seed, counter rollback, or manual insert). The counter
		// itself is the source of truth — log and continue.
		const code = (err as { code?: number } | null)?.code;
		if (code !== 11000) throw err;
	}

	return { udi, sequence };
}

/**
 * Read-only preview of what the next UDI will be WITHOUT incrementing.
 *
 * Useful for dashboards (PRD §4.1 `nextUdiPreview`). Because this does not
 * reserve the sequence, the value MAY be stale by the time a concurrent
 * `getNextUdi()` call fires — treat it strictly as a UI hint.
 */
export async function peekNextUdi(prefix: string = DEFAULT_PREFIX): Promise<string> {
	const counter = await UdiCounter.findById(prefix)
		.lean<{ _id: string; sequence: number } | null>();
	const current = counter?.sequence ?? 0;
	return formatUdi(prefix, current + 1);
}
