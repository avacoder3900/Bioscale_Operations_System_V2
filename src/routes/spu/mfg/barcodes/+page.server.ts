import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, AuditLog, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

/**
 * Audit writer for this route.
 *
 * Same signature as /spu/mfg/servicing and /spu/cleaning — AuditLog carries
 * immutable middleware, so these entries are append-only by design.
 */
async function writeAudit(
	event: RequestEvent,
	entry: {
		tableName: string;
		recordId: string;
		action: string;
		oldData?: unknown;
		newData?: unknown;
		changedFields?: string[];
		reason?: string;
	}
): Promise<void> {
	await AuditLog.create({
		_id: generateId(),
		...entry,
		changedBy: event.locals.user?.username,
		changedAt: new Date(),
		userAgent: event.request.headers.get('user-agent') ?? undefined
	});
}

/** Upper bound on a scanned QR payload. Guards against a scanner dumping a page of text. */
const MAX_BARCODE_LENGTH = 200;
/** An overwrite has to justify itself; a bare "x" is not a reason. */
const MIN_REASON_LENGTH = 3;

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const spus = await Spu.find({})
		.select('udi barcode status assemblyStatus batch assignment finalizedAt createdAt updatedAt')
		.lean();

	const rows = (spus as any[]).map((s) => ({
		id: String(s._id),
		udi: s.udi ?? '',
		barcode: s.barcode ?? null,
		status: s.status ?? 'draft',
		assemblyStatus: s.assemblyStatus ?? null,
		batchNumber: s.batch?.batchNumber ?? null,
		customerName: s.assignment?.customer?.name ?? null,
		// Finalized SPUs are sacred — the UI greys them out rather than
		// letting an operator discover the block only after a scan.
		finalized: Boolean(s.finalizedAt),
		createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : null,
		updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null
	}));

	// Unassigned first — that is the work queue this page exists to drain.
	rows.sort((a, b) => {
		const aHas = a.barcode ? 1 : 0;
		const bHas = b.barcode ? 1 : 0;
		if (aHas !== bHas) return aHas - bHas;
		return a.udi.localeCompare(b.udi);
	});

	return {
		rows: JSON.parse(JSON.stringify(rows)),
		counts: {
			total: rows.length,
			assigned: rows.filter((r) => r.barcode).length,
			unassigned: rows.filter((r) => !r.barcode).length
		}
	};
};

export const actions: Actions = {
	/**
	 * Bind a scanned QR payload to one SPU.
	 *
	 * Handles both the first assignment and a deliberate overwrite. Overwrites
	 * require a reason and are recorded old -> new in AuditLog, because the
	 * barcode is how the floor identifies a physical unit.
	 */
	assign: async (event) => {
		requirePermission(event.locals.user, 'spu:write');
		await connectDB();

		const form = await event.request.formData();
		const spuId = form.get('spuId')?.toString()?.trim();
		const barcode = form.get('barcode')?.toString()?.trim();
		const reason = form.get('reason')?.toString()?.trim() || null;

		if (!spuId) return fail(400, { error: 'No SPU selected.' });
		if (!barcode) return fail(400, { error: 'Scan a QR label to assign.', spuId });
		if (barcode.length > MAX_BARCODE_LENGTH) {
			return fail(400, {
				error: `Scanned value is ${barcode.length} characters — that does not look like a label.`,
				spuId
			});
		}

		const spu: any = await Spu.findById(spuId).lean();
		if (!spu) return fail(404, { error: 'SPU not found.', spuId });

		// Sacred: the middleware would throw on the update anyway. Fail here so
		// the operator gets a sentence instead of a Mongoose stack trace.
		if (spu.finalizedAt) {
			return fail(400, {
				error: `${spu.udi} is finalized and cannot be modified. Barcode changes on a finalized SPU need a correction entry.`,
				spuId
			});
		}

		const current: string | null = spu.barcode ?? null;

		if (current && current === barcode) {
			return fail(400, {
				error: `${spu.udi} already carries that exact barcode — nothing to change.`,
				spuId
			});
		}

		// `barcode` is indexed sparse but NOT unique, so the database will
		// happily accept a duplicate. Enforce it here instead.
		const clash: any = await Spu.findOne({ barcode, _id: { $ne: spuId } })
			.select('udi')
			.lean();
		if (clash) {
			return fail(409, {
				error: `That barcode is already bound to ${clash.udi}. Each label may only identify one SPU.`,
				spuId
			});
		}

		if (current && (!reason || reason.length < MIN_REASON_LENGTH)) {
			return fail(400, {
				error: `${spu.udi} already has a barcode. Re-assigning requires a reason.`,
				spuId,
				needsReason: true,
				currentBarcode: current
			});
		}

		try {
			await Spu.updateOne({ _id: spuId }, { $set: { barcode, updatedAt: new Date() } });
		} catch (err) {
			return fail(400, {
				error: `Could not update ${spu.udi}: ${(err as Error).message}`,
				spuId
			});
		}

		await writeAudit(event, {
			tableName: 'spus',
			recordId: spuId,
			action: 'UPDATE',
			oldData: { barcode: current },
			newData: { barcode },
			changedFields: ['barcode'],
			reason: current ? `Barcode re-assigned: ${reason}` : 'Barcode assigned'
		});

		return {
			success: true,
			assigned: { spuId, udi: spu.udi, barcode, previous: current }
		};
	}
};
