/**
 * Unified SPU journal writer (SPU-INV-10).
 *
 * The journal is the unit's single chronological story: humans append manual
 * entries from the detail page, and systems append at their "publish" moments
 * (service-job close today; validation runs, release, etc. later). Everything
 * goes through this helper so the stream stays consistent and append-only.
 */
import { connectDB, Spu, AuditLog, generateId } from '$lib/server/db';

export interface JournalSource {
	/** 'manual' | 'service' | future kinds. Renders as a badge in the UI. */
	source: string;
	refKind?: string;
	refId?: string;
	/** Human label for the producing record, e.g. "Inspection — Timing Belt Investigation". */
	refLabel?: string;
}

export async function appendSpuJournal(
	spuId: string,
	text: string,
	actor: { _id: string; username?: string },
	meta: JournalSource = { source: 'manual' }
): Promise<{ ok: boolean; entryId?: string; error?: string }> {
	try {
		await connectDB();
		const trimmed = text.trim();
		if (!trimmed) return { ok: false, error: 'empty entry' };

		const entry = {
			_id: generateId(),
			text: trimmed.slice(0, 5000),
			source: meta.source,
			refKind: meta.refKind,
			refId: meta.refId,
			refLabel: meta.refLabel,
			createdBy: { _id: actor._id, username: actor.username },
			createdAt: new Date()
		};
		const res = await Spu.updateOne({ _id: spuId }, { $push: { journal: entry } });
		if (res.matchedCount === 0) return { ok: false, error: 'SPU not found' };

		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: spuId,
			action: 'UPDATE',
			oldData: {},
			newData: { journalEntryAdded: entry._id, source: meta.source, preview: trimmed.slice(0, 120) },
			changedBy: actor.username ?? actor._id,
			changedAt: new Date()
		});
		return { ok: true, entryId: entry._id };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
