import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, ValidationSession, OpticalBlankRun } from '$lib/server/db';
import {
	cycleSummary,
	runsSinceServicing,
	VALIDATION_TESTS
} from '$lib/server/spu-validation-cycle';
import type { PageServerLoad } from './$types';

/** Every session type any of the six tests is evidenced by. */
const SESSION_TYPES = [...new Set(VALIDATION_TESTS.flatMap((t) => [...t.sessionTypes]))];

const newerOf = (a: Date | null, b: Date | null) =>
	!a ? b : !b ? a : new Date(a) > new Date(b) ? a : b;

// SPU inventory: every unit, for search + list access. Moved here from /spu/mfg (SPU-INV-02).
export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	// Projection matters: attachments[].content holds inline CSV blobs and
	// assembly.stepRecords[] is large — neither is needed for the list.
	// The six-test tracker needs per-unit run evidence, which the device page
	// gets with one query per unit. Doing that here would be a query per card,
	// so both evidence sources are folded into one aggregation each: we only
	// ever need the newest run per (unit, type), not the sessions themselves.
	const [spus, sessionAgg, blankAgg] = await Promise.all([
		Spu.find()
			.select('udi barcode status qcStatus owner location batch particleLink validation validationResetAt createdAt')
			.sort({ createdAt: -1 })
			.lean(),
		ValidationSession.aggregate([
			{ $match: { type: { $in: SESSION_TYPES } } },
			{
				$group: {
					_id: { spuId: '$spuId', type: '$type' },
					lastAt: { $max: { $ifNull: ['$startedAt', '$createdAt'] } }
				}
			}
		]),
		// Blank runs carry spuId on new rows and only spuUdi on older ones —
		// the device page matches either, so the list has to as well or a
		// unit's blank dot goes red purely because its row predates spuId.
		OpticalBlankRun.aggregate([
			{
				$facet: {
					byId: [
						{ $group: { _id: '$spuId', lastAt: { $max: { $ifNull: ['$receivedAt', '$publishedAt'] } } } }
					],
					byUdi: [
						{ $group: { _id: '$spuUdi', lastAt: { $max: { $ifNull: ['$receivedAt', '$publishedAt'] } } } }
					]
				}
			}
		])
	]);

	const sessionsBySpu = new Map<string, { type: string; startedAt: Date }[]>();
	for (const r of sessionAgg as any[]) {
		const id = String(r._id?.spuId ?? '');
		if (!id) continue;
		const list = sessionsBySpu.get(id) ?? [];
		list.push({ type: r._id.type, startedAt: r.lastAt });
		sessionsBySpu.set(id, list);
	}

	const blankById = new Map<string, Date>();
	const blankByUdi = new Map<string, Date>();
	for (const r of ((blankAgg as any[])[0]?.byId ?? []) as any[]) if (r._id) blankById.set(String(r._id), r.lastAt);
	for (const r of ((blankAgg as any[])[0]?.byUdi ?? []) as any[]) if (r._id) blankByUdi.set(String(r._id), r.lastAt);

	return {
		spus: spus.map((s: any) => {
			// Only the current validation cycle counts (reset when the unit
			// last entered servicing) — see spu-validation-cycle.ts.
			const cycle = cycleSummary(s);

			// Same helper the device page uses, fed from the batched evidence
			// above so the dots and the Device card cannot disagree.
			const since = runsSinceServicing({
				validation: s.validation ?? null,
				validationResetAt: s.validationResetAt ?? null,
				sessions: sessionsBySpu.get(String(s._id)) ?? [],
				blankRunAt:
					newerOf(
						blankById.get(String(s._id)) ?? null,
						s.udi ? (blankByUdi.get(s.udi) ?? null) : null
					) ?? null
			});

			return {
				id: s._id,
				udi: s.udi,
				deviceId: s.particleLink?.particleDeviceId ?? null,
				barcode: s.barcode ?? null,
				status: s.status ?? 'draft',
				qcStatus: s.qcStatus ?? 'pending',
				owner: s.owner ?? null,
				location: s.location ?? null,
				batchNumber: s.batch?.batchNumber ?? null,
				validationPassed: cycle.passed,
				validationTotal: cycle.total,
				// The six-test tracker: one dot per test, red/amber/green.
				validationTests: since.tests.map((t) => ({
					key: t.key,
					name: t.name,
					state: t.state,
					lastRunAt: t.lastRunAt
				})),
				validationSincePassed: since.passed,
				validationSinceTotal: since.total,
				createdAt: s.createdAt
			};
		})
	};
};
