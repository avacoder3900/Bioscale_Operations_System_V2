/**
 * VALIDATION-06-S3 — the optical analysis Groups workspace.
 *
 * Read-only load. This route deliberately defines NO actions: all five group
 * mutations (saveGroup / renameGroup / removeFromGroup / archiveGroup, plus assign)
 * already live on `../+page.server.ts` with their permission checks and AuditLog
 * writes. The forms on this page post to those, e.g.
 *   action="/validation/optical-confirmation?/saveGroup"
 * so there is exactly one implementation of each mutation and one audit trail.
 *
 * Derive-on-read throughout: `cartridge_records` is never written, and no computed
 * statistic is persisted anywhere.
 */
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, CartridgeGroup } from '$lib/server/db';
import { analyzeCartridge } from '$lib/server/optical-analysis';
import { OPTICAL_CARTRIDGE_FILTER, isGroupColorKey } from '$lib/server/optical-constants';
import type { PageServerLoad } from './$types';

/** Same cap the cartridge log uses — each record drags ~126 readings. */
const MAX_CANDIDATES = 200;

/** `checkpoints.*.when` and `createdAt` come back as Date or string depending on writer. */
function toIso(v: unknown): string | null {
	if (!v) return null;
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
	const d = new Date(v as string);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	// Analysis cohorts only. `assign_batch` groups are created by the assign endpoint
	// and are deliberately invisible here (PRD §3).
	const groupDocs = await CartridgeGroup.find({
		purpose: 'optical_analysis',
		archivedAt: null
	})
		.select('_id name description color cartridgeIds createdAt')
		.sort({ createdAt: 1 })
		.lean();

	const groups = groupDocs.map((g: any) => {
		// `?? []` because .lean() does NOT apply schema defaults: a group written before
		// cartridgeIds existed comes back with the field simply missing.
		const ids = (g.cartridgeIds ?? []) as string[];
		return {
			id: g._id as string,
			name: (g.name ?? '(unnamed)') as string,
			description: (g.description ?? null) as string | null,
			color: isGroupColorKey(g.color) ? g.color : 'cyan',
			count: ids.length,
			createdAt: toIso(g.createdAt)
		};
	});

	// Picker candidates: optical cartridges that have ALREADY RUN. Readings presence is
	// the real gate — a cartridge with no readings yields no statistic, so offering it
	// would only let someone build a group that cannot be analyzed.
	//
	// `rawData` and `device` are UNDECLARED on cartridge_records, so .lean() is
	// mandatory or a strict document drops them entirely.
	const candidateDocs = await CartridgeRecord.find({
		...OPTICAL_CARTRIDGE_FILTER,
		'rawData.readings.0': { $exists: true }
	})
		.select('_id rawData device checkpoints createdAt')
		.sort({ createdAt: -1 })
		.limit(MAX_CANDIDATES)
		.lean();

	const candidates = candidateDocs
		// Belt-and-braces: if an undeclared-path filter were ever stripped by a strict
		// query mode, this keeps a never-run cartridge out of the picker regardless.
		.filter((c: any) => Array.isArray(c.rawData?.readings) && c.rawData.readings.length > 0)
		.map((c: any) => {
			// Derive-on-read F7/F3 — computed for display, never written back.
			const analysis = analyzeCartridge(c.rawData?.readings ?? []);
			return {
				id: c._id as string,
				// cartridge_records._id IS the scanned barcode for optical cartridges.
				barcode: c._id as string,
				spuUdi: (c.device?.name ?? null) as string | null,
				ratioByChannel: analysis?.ratioByChannel ?? { A: null, B: null, C: null },
				runDate:
					toIso(c.checkpoints?.completed?.when) ??
					toIso(c.checkpoints?.underway?.when) ??
					toIso(c.createdAt)
			};
		});

	return JSON.parse(JSON.stringify({ groups, candidates }));
};
