import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, ServiceRecord, AuditLog, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

/**
 * Audit writer for this route.
 *
 * The servicing pages were originally written against `$lib/server/qms-gate`,
 * a subsystem that never landed on master. This is the same call signature
 * backed by master's plain AuditLog, matching /spu/cleaning. AuditLog has
 * immutable middleware applied — entries are append-only by design.
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

const SERVICE_TYPES = ['inspection', 'calibration', 'repair', 'part-replacement', 'other'];
const PRIORITIES = ['low', 'normal', 'high'];

/** Statuses a unit can be handed back to once its service job closes. */
const RETURNABLE_STATUSES = [
	'draft',
	'assembling',
	'assembled',
	'validating',
	'validated',
	'released-rnd',
	'released-manufacturing',
	'released-field',
	'deployed',
	'retired'
];

/** SPU-0244 style label built from the last 4 characters of the unit's UDI. */
function extractShortId(udi: string): string {
	if (!udi) return '';
	// UDIs are either GS1-style "(01)...(21)<serial>" or a plain unit id like
	// "BT-M01-0000-0236". Both share a long fixed prefix, so the leading
	// characters do not distinguish units - the tail is the unit number.
	const serial = udi.match(/\(21\)(.+)/)?.[1] ?? udi;
	const tail = serial.replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase();
	return tail ? `SPU-${tail}` : '';
}

function daysSince(date: Date | string | null | undefined): number {
	if (!date) return 0;
	const ms = Date.now() - new Date(date).getTime();
	return Math.max(0, Math.floor(ms / 86_400_000));
}

interface ServiceRow {
	recordId: string | null;
	spuId: string;
	shortId: string;
	udi: string;
	barcode: string | null;
	customer: string | null;
	owner: string | null;
	spuStatus: string;
	serviceType: string;
	priority: string;
	location: string;
	reason: string | null;
	assignedTo: string | null;
	openedAt: string | null;
	openedBy: string | null;
	daysOpen: number;
	previousStatus: string | null;
	lastMove: { to: string; movedAt: string; movedBy: string | null } | null;
	notes: { id: string; text: string; addedAt: string; addedBy: string | null }[];
	/** Full move trail, newest last — the detail panel renders it as a timeline. */
	locationHistory: { id: string; from: string; to: string; movedAt: string; movedBy: string | null; note: string | null }[];
	/**
	 * The unit's as-built parts, so replacing one is a pick from a list rather
	 * than typing a part number. Already-replaced entries are kept and flagged
	 * so the panel can show supersession rather than hiding history.
	 */
	parts: { id: string; partNumber: string; partName: string; lotNumber: string; serialNumber: string | null; isReplaced: boolean }[];
	partsReplaced: { id: string; partNumber: string; partName: string; oldLotNumber: string; newLotNumber: string; newSerialNumber: string | null; reason: string; replacedBy: string | null; replacedAt: string }[];
	firmwareChanges: { id: string; deviceType: string; previousVersion: string; newVersion: string; reason: string; performedBy: string | null; performedAt: string }[];
	otherChanges: { id: string; category: string; description: string; performedBy: string | null; performedAt: string }[];
	/** SPU sits in 'servicing' status but has no service record behind it. */
	needsIntake: boolean;
}

/** Shared shape for the three change lists, so the row mappers stay readable. */
function mapChanges(r: any) {
	return {
		partsReplaced: (r.partsReplaced ?? []).map((x: any) => ({
			id: x._id,
			partNumber: x.partNumber ?? '',
			partName: x.partName ?? '',
			oldLotNumber: x.oldLotNumber ?? '',
			newLotNumber: x.newLotNumber ?? '',
			newSerialNumber: x.newSerialNumber ?? null,
			reason: x.reason ?? '',
			replacedBy: x.replacedBy?.username ?? null,
			replacedAt: new Date(x.replacedAt).toISOString()
		})),
		firmwareChanges: (r.firmwareChanges ?? []).map((x: any) => ({
			id: x._id,
			deviceType: x.deviceType ?? '',
			previousVersion: x.previousVersion ?? '',
			newVersion: x.newVersion ?? '',
			reason: x.reason ?? '',
			performedBy: x.performedBy?.username ?? null,
			performedAt: new Date(x.performedAt).toISOString()
		})),
		otherChanges: (r.otherChanges ?? []).map((x: any) => ({
			id: x._id,
			category: x.category ?? '',
			description: x.description ?? '',
			performedBy: x.performedBy?.username ?? null,
			performedAt: new Date(x.performedAt).toISOString()
		}))
	};
}

/** The unit's as-built parts list, newest-scanned last. */
function mapParts(spu: any) {
	return (spu?.parts ?? []).map((pt: any) => ({
		id: pt._id,
		partNumber: pt.partNumber ?? '',
		partName: pt.partName ?? '',
		lotNumber: pt.lotNumber ?? '',
		serialNumber: pt.serialNumber ?? null,
		isReplaced: Boolean(pt.isReplaced)
	}));
}

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
	const locationFilter = url.searchParams.get('location') ?? '';
	const typeFilter = url.searchParams.get('type') ?? '';

	const [openRecords, closedRecords, servicingSpus, pickerSpus] = await Promise.all([
		ServiceRecord.find({ status: 'open' }).sort({ openedAt: 1 }).lean(),
		ServiceRecord.find({ status: 'closed' }).sort({ closedAt: -1 }).limit(15).lean(),
		Spu.find({ status: 'servicing' }).select('udi barcode status assignment owner parts').lean(),
		Spu.find({ status: { $ne: 'voided' } })
			.select('udi barcode status assignment owner')
			.sort({ udi: 1 })
			.lean()
	]);

	// Open records can reference SPUs outside the servicing bucket: a unit may be
	// pulled for service before anyone flips its status.
	const openSpuIds = (openRecords as any[]).map((r) => r.spuId);
	const relatedSpus = await Spu.find({ _id: { $in: openSpuIds } })
		.select('udi barcode status assignment owner parts')
		.lean();
	const spuById = new Map<string, any>((relatedSpus as any[]).map((s) => [s._id, s]));

	const rows: ServiceRow[] = (openRecords as any[]).map((r) => {
		const spu = spuById.get(r.spuId);
		const udi = spu?.udi ?? r.spuUdi ?? '';
		const lastMoveDoc = (r.locationHistory ?? []).at(-1);
		return {
			recordId: r._id,
			spuId: r.spuId,
			shortId: extractShortId(udi),
			udi,
			barcode: spu?.barcode ?? r.spuBarcode ?? null,
			customer: spu?.assignment?.customer?.name ?? r.customerName ?? null,
			owner: spu?.owner ?? null,
			spuStatus: spu?.status ?? 'unknown',
			serviceType: r.serviceType ?? 'other',
			priority: r.priority ?? 'normal',
			location: r.location ?? '',
			reason: r.reason ?? null,
			assignedTo: r.assignedTo?.username ?? null,
			openedAt: r.openedAt ? new Date(r.openedAt).toISOString() : null,
			openedBy: r.openedBy?.username ?? null,
			daysOpen: daysSince(r.openedAt),
			previousStatus: r.previousStatus ?? null,
			lastMove: lastMoveDoc
				? {
						to: lastMoveDoc.to ?? '',
						movedAt: new Date(lastMoveDoc.movedAt).toISOString(),
						movedBy: lastMoveDoc.movedBy?.username ?? null
					}
				: null,
			notes: (r.notes ?? []).map((n: any) => ({
				id: n._id,
				text: n.text ?? '',
				addedAt: new Date(n.addedAt).toISOString(),
				addedBy: n.addedBy?.username ?? null
			})),
			locationHistory: (r.locationHistory ?? []).map((h: any) => ({
				id: h._id,
				from: h.from ?? '',
				to: h.to ?? '',
				movedAt: new Date(h.movedAt).toISOString(),
				movedBy: h.movedBy?.username ?? null,
				note: h.note ?? null
			})),
			parts: mapParts(spu),
			...mapChanges(r),
			needsIntake: false
		};
	});

	// Units parked in 'servicing' with no record behind them predate this page.
	// Surface them so the list matches the floor instead of quietly hiding them.
	const recordedSpuIds = new Set<string>(openSpuIds);
	for (const spu of servicingSpus as any[]) {
		if (recordedSpuIds.has(spu._id)) continue;
		rows.push({
			recordId: null,
			spuId: spu._id,
			shortId: extractShortId(spu.udi),
			udi: spu.udi,
			barcode: spu.barcode ?? null,
			customer: spu.assignment?.customer?.name ?? null,
			owner: spu.owner ?? null,
			spuStatus: spu.status,
			serviceType: 'other',
			priority: 'normal',
			location: '',
			reason: null,
			assignedTo: null,
			openedAt: null,
			openedBy: null,
			daysOpen: 0,
			previousStatus: null,
			lastMove: null,
			notes: [],
			locationHistory: [],
			parts: mapParts(spu),
			partsReplaced: [],
			firmwareChanges: [],
			otherChanges: [],
			needsIntake: true
		});
	}

	const knownLocations = [
		...new Set(
			[...(openRecords as any[]), ...(closedRecords as any[])]
				.map((r) => (r.location ?? '').trim())
				.filter(Boolean)
		)
	].sort((a, b) => a.localeCompare(b));

	const filtered = rows.filter((row) => {
		if (locationFilter === '__unassigned__') {
			if (row.location.trim()) return false;
		} else if (locationFilter && row.location !== locationFilter) {
			return false;
		}
		if (typeFilter && row.serviceType !== typeFilter) return false;
		if (!q) return true;
		return [row.shortId, row.udi, row.barcode, row.customer, row.owner, row.location, row.reason]
			.filter(Boolean)
			.some((v) => String(v).toLowerCase().includes(q));
	});

	// Oldest first, but anything still needing intake floats to the top.
	filtered.sort((a, b) => {
		if (a.needsIntake !== b.needsIntake) return a.needsIntake ? -1 : 1;
		return b.daysOpen - a.daysOpen;
	});

	const byLocation = new Map<string, number>();
	const byType = new Map<string, number>();
	for (const row of rows) {
		const loc = row.location.trim() || 'Unassigned';
		byLocation.set(loc, (byLocation.get(loc) ?? 0) + 1);
		byType.set(row.serviceType, (byType.get(row.serviceType) ?? 0) + 1);
	}

	const eligibleSpus = (pickerSpus as any[])
		.filter((s) => !recordedSpuIds.has(s._id))
		.map((s) => ({
			id: s._id,
			udi: s.udi,
			shortId: extractShortId(s.udi),
			barcode: s.barcode ?? null,
			status: s.status ?? 'draft',
			customer: s.assignment?.customer?.name ?? null
		}));

	return {
		// Already plain primitives (dates were stringified on the way in), so this
		// crosses the SvelteKit boundary without a JSON round-trip.
		rows: filtered,
		totalOpen: rows.length,
		needsIntakeCount: rows.filter((r) => r.needsIntake).length,
		oldestDays: rows.reduce((max, r) => Math.max(max, r.daysOpen), 0),
		byLocation: [...byLocation.entries()]
			.map(([location, count]) => ({ location, count }))
			.sort((a, b) => b.count - a.count),
		byType: [...byType.entries()]
			.map(([type, count]) => ({ type, count }))
			.sort((a, b) => b.count - a.count),
		knownLocations,
		eligibleSpus,
		recentlyClosed: (closedRecords as any[]).map((r) => ({
			id: r._id,
			spuId: r.spuId,
			shortId: extractShortId(r.spuUdi ?? ''),
			udi: r.spuUdi ?? '',
			serviceType: r.serviceType ?? 'other',
			location: r.location ?? '',
			resolution: r.resolution ?? null,
			returnedToStatus: r.returnedToStatus ?? null,
			closedAt: r.closedAt ? new Date(r.closedAt).toISOString() : null,
			closedBy: r.closedBy?.username ?? null
		})),
		filters: { q: url.searchParams.get('q') ?? '', location: locationFilter, type: typeFilter },
		serviceTypes: SERVICE_TYPES,
		priorities: PRIORITIES,
		returnableStatuses: RETURNABLE_STATUSES
	};
};

function operator(user: any) {
	return { _id: user._id, username: user.username };
}

/**
 * Open a service job on an already-loaded SPU.
 *
 * Shared by the explicit "Start service job" form and by the scan bar, so a
 * scanned unit and a hand-picked one take exactly the same path — same status
 * transition, same audit trail, same intake move.
 */
async function createServiceJob(
	event: RequestEvent,
	spu: any,
	opts: { serviceType: string; priority: string; location: string; reason: string }
): Promise<string> {
	const { serviceType, priority, location, reason } = opts;
	const oldStatus = spu.status ?? 'draft';
	const record: any = await ServiceRecord.create({
		_id: generateId(),
		spuId: spu._id,
		spuUdi: spu.udi,
		spuBarcode: spu.barcode ?? undefined,
		customerName: spu.assignment?.customer?.name ?? undefined,
		serviceType,
		priority,
		status: 'open',
		location,
		locationHistory: location
			? [
					{
						_id: generateId(),
						from: '',
						to: location,
						movedAt: new Date(),
						movedBy: operator(event.locals.user),
						note: 'Intake'
					}
				]
			: [],
		reason: reason || undefined,
		// Only remember a status worth returning to; if the unit was already
		// 'servicing' we have nothing better to restore it to on close.
		previousStatus: oldStatus === 'servicing' ? undefined : oldStatus,
		openedAt: new Date(),
		openedBy: operator(event.locals.user)
	});

	if (oldStatus !== 'servicing') {
		await Spu.updateOne(
			{ _id: spu._id },
			{
				$set: { status: 'servicing' },
				$push: {
					statusTransitions: {
						_id: generateId(),
						from: oldStatus,
						to: 'servicing',
						changedBy: operator(event.locals.user),
						changedAt: new Date(),
						reason: `Service job opened (${serviceType})`
					}
				}
			}
		);
		await writeAudit(event, {
			tableName: 'spus',
			recordId: spu._id,
			action: 'UPDATE',
			oldData: { status: oldStatus },
			newData: { status: 'servicing' },
			reason: `Service job opened (${serviceType})`
		});
	}

	await writeAudit(event, {
		tableName: 'service_records',
		recordId: record._id,
		action: 'INSERT',
		newData: { spuId: spu._id, serviceType, priority, location, reason },
		reason: 'Service job opened'
	});

	return record._id;
}

export const actions: Actions = {
	/**
	 * The bench path: one scan of a unit's barcode or UDI either resumes its
	 * open job or opens a new one, with no dialog in between.
	 *
	 * Resuming is deliberately not an error — scanning a unit that is already
	 * on the board is the single most common thing a tech does (walk up, scan,
	 * carry on), so it just returns the job to focus.
	 */
	scan: async (event) => {
		requirePermission(event.locals.user, 'spu:write');
		await connectDB();

		const form = await event.request.formData();
		const code = (form.get('code')?.toString() ?? '').trim();
		if (!code) return fail(400, { error: 'Nothing scanned' });

		// Wedge scanners are configured for the barcode, but techs also read the
		// UDI off the label by hand, and the record id shows up in links.
		const spu: any = await Spu.findOne({
			$or: [{ barcode: code }, { udi: code }, { _id: code }]
		}).lean();
		if (!spu) {
			return fail(404, { error: `No SPU matches "${code}"`, scanned: code });
		}

		const existing: any = await ServiceRecord.findOne({
			spuId: spu._id,
			status: 'open'
		}).lean();
		if (existing) {
			return {
				success: true,
				resumed: true,
				focusRecordId: existing._id,
				scanned: code,
				message: `Resumed open job on ${spu.udi ?? code}`
			};
		}

		// A finalized unit must not be silently mutated; say so instead.
		if (spu.finalizedAt) {
			return fail(400, { error: 'SPU is finalized', scanned: code });
		}

		const recordId = await createServiceJob(event, spu, {
			// Deliberately un-triaged: the tech sets type and priority from the
			// detail panel in one click once the unit is on the board.
			serviceType: 'other',
			priority: 'normal',
			location: (form.get('location')?.toString() ?? '').trim(),
			reason: ''
		});

		return {
			success: true,
			opened: true,
			focusRecordId: recordId,
			scanned: code,
			message: `Opened job on ${spu.udi ?? code}`
		};
	},


	/**
	 * Pull an SPU in for service. Also covers "intake" for units already parked
	 * in 'servicing' status from before service records existed.
	 */
	openService: async (event) => {
		requirePermission(event.locals.user, 'spu:write');
		await connectDB();

		const form = await event.request.formData();
		const spuId = form.get('spuId')?.toString() ?? '';
		const serviceTypeRaw = form.get('serviceType')?.toString() ?? 'other';
		const priorityRaw = form.get('priority')?.toString() ?? 'normal';
		const location = (form.get('location')?.toString() ?? '').trim();
		const reason = (form.get('reason')?.toString() ?? '').trim();

		if (!spuId) return fail(400, { error: 'Pick an SPU first' });
		const serviceType = SERVICE_TYPES.includes(serviceTypeRaw) ? serviceTypeRaw : 'other';
		const priority = PRIORITIES.includes(priorityRaw) ? priorityRaw : 'normal';

		const spu: any = await Spu.findById(spuId).lean();
		if (!spu) return fail(404, { error: 'SPU not found' });
		if (spu.finalizedAt) return fail(400, { error: 'SPU is finalized' });

		const existing = await ServiceRecord.findOne({ spuId, status: 'open' }).lean();
		if (existing) return fail(409, { error: 'That SPU already has an open service job' });

		const recordId = await createServiceJob(event, spu, {
			serviceType,
			priority,
			location,
			reason
		});

		return { success: true, opened: true, focusRecordId: recordId };
	},

	/** Move a unit to a new physical spot and keep the trail. */
	moveLocation: async (event) => {
		requirePermission(event.locals.user, 'spu:write');
		await connectDB();

		const form = await event.request.formData();
		const recordId = form.get('recordId')?.toString() ?? '';
		const location = (form.get('location')?.toString() ?? '').trim();
		const note = (form.get('note')?.toString() ?? '').trim();

		if (!recordId) return fail(400, { error: 'Missing service record' });
		if (!location) return fail(400, { error: 'Location is required' });

		const record: any = await ServiceRecord.findById(recordId).lean();
		if (!record) return fail(404, { error: 'Service record not found' });
		if (record.status !== 'open') return fail(400, { error: 'That service job is already closed' });

		const from = record.location ?? '';
		if (from === location && !note) return { success: true, unchanged: true };

		await ServiceRecord.updateOne(
			{ _id: recordId },
			{
				$set: { location },
				$push: {
					locationHistory: {
						_id: generateId(),
						from,
						to: location,
						movedAt: new Date(),
						movedBy: operator(event.locals.user),
						note: note || undefined
					}
				}
			}
		);

		await writeAudit(event, {
			tableName: 'service_records',
			recordId,
			action: 'UPDATE',
			oldData: { location: from },
			newData: { location },
			changedFields: ['location'],
			reason: note || 'Service location updated'
		});

		return { success: true, moved: true };
	},

	/** Edit the job itself: what kind of work, how urgent, who owns it. */
	updateService: async (event) => {
		requirePermission(event.locals.user, 'spu:write');
		await connectDB();

		const form = await event.request.formData();
		const recordId = form.get('recordId')?.toString() ?? '';
		const serviceTypeRaw = form.get('serviceType')?.toString() ?? '';
		const priorityRaw = form.get('priority')?.toString() ?? '';
		const assignedTo = (form.get('assignedTo')?.toString() ?? '').trim();
		const reason = (form.get('reason')?.toString() ?? '').trim();

		if (!recordId) return fail(400, { error: 'Missing service record' });

		const record: any = await ServiceRecord.findById(recordId).lean();
		if (!record) return fail(404, { error: 'Service record not found' });
		if (record.status !== 'open') return fail(400, { error: 'That service job is already closed' });

		// Only touch fields the caller actually submitted. The one-click type and
		// priority controls post just their own field, and treating a missing
		// field as "clear this" would silently wipe the reason and assignee.
		const update: Record<string, unknown> = {};
		if (SERVICE_TYPES.includes(serviceTypeRaw)) update.serviceType = serviceTypeRaw;
		if (PRIORITIES.includes(priorityRaw)) update.priority = priorityRaw;
		if (form.has('reason')) update.reason = reason || undefined;
		if (form.has('assignedTo')) {
			update.assignedTo = assignedTo ? { _id: assignedTo, username: assignedTo } : undefined;
		}
		if (Object.keys(update).length === 0) return fail(400, { error: 'Nothing to update' });

		await ServiceRecord.updateOne({ _id: recordId }, { $set: update });

		await writeAudit(event, {
			tableName: 'service_records',
			recordId,
			action: 'UPDATE',
			oldData: {
				serviceType: record.serviceType,
				priority: record.priority,
				assignedTo: record.assignedTo?.username ?? null,
				reason: record.reason ?? null
			},
			newData: { ...update, assignedTo: assignedTo || null },
			reason: 'Service job updated'
		});

		return { success: true, updated: true };
	},

	addNote: async (event) => {
		requirePermission(event.locals.user, 'spu:write');
		await connectDB();

		const form = await event.request.formData();
		const recordId = form.get('recordId')?.toString() ?? '';
		const text = (form.get('text')?.toString() ?? '').trim();

		if (!recordId) return fail(400, { error: 'Missing service record' });
		if (!text) return fail(400, { error: 'Note cannot be empty' });

		const record: any = await ServiceRecord.findById(recordId).lean();
		if (!record) return fail(404, { error: 'Service record not found' });

		await ServiceRecord.updateOne(
			{ _id: recordId },
			{
				$push: {
					notes: {
						_id: generateId(),
						text,
						addedAt: new Date(),
						addedBy: operator(event.locals.user)
					}
				}
			}
		);

		await writeAudit(event, {
			tableName: 'service_records',
			recordId,
			action: 'UPDATE',
			newData: { note: text },
			reason: 'Service note added'
		});

		return { success: true, noted: true };
	},

	/**
	 * Swap a part on the unit and record it on the job.
	 *
	 * This is the one action here that writes the device history rather than
	 * just describing it: the outgoing spu.parts[] entry is flagged replaced and
	 * the incoming lot is appended, so the as-built record stays truthful.
	 */
	replacePart: async (event) => {
		requirePermission(event.locals.user, 'spu:write');
		await connectDB();

		const form = await event.request.formData();
		const recordId = form.get('recordId')?.toString() ?? '';
		const spuPartId = form.get('spuPartId')?.toString() ?? '';
		const newLotNumber = (form.get('newLotNumber')?.toString() ?? '').trim();
		const newSerialNumber = (form.get('newSerialNumber')?.toString() ?? '').trim();
		const reason = (form.get('reason')?.toString() ?? '').trim();

		if (!recordId) return fail(400, { error: 'Missing service record' });
		if (!spuPartId) return fail(400, { error: 'Pick the part being replaced' });
		if (!newLotNumber) return fail(400, { error: 'New lot number is required' });
		if (!reason) return fail(400, { error: 'A reason is required for traceability' });

		const record: any = await ServiceRecord.findById(recordId).lean();
		if (!record) return fail(404, { error: 'Service record not found' });
		if (record.status === 'closed') return fail(400, { error: 'Job is already closed' });

		const spu: any = await Spu.findById(record.spuId).lean();
		if (!spu) return fail(404, { error: 'SPU not found' });
		if (spu.finalizedAt) return fail(400, { error: 'SPU is finalized' });

		const oldPart = (spu.parts ?? []).find((pt: any) => pt._id === spuPartId);
		if (!oldPart) return fail(400, { error: 'That part is not on this unit' });
		if (oldPart.isReplaced) return fail(400, { error: 'That part was already replaced' });

		const now = new Date();
		const who = operator(event.locals.user);

		await ServiceRecord.updateOne(
			{ _id: recordId },
			{
				$push: {
					partsReplaced: {
						_id: generateId(),
						spuPartId,
						partNumber: oldPart.partNumber,
						partName: oldPart.partName,
						oldLotNumber: oldPart.lotNumber,
						newLotNumber,
						newSerialNumber: newSerialNumber || undefined,
						reason,
						replacedBy: who,
						replacedAt: now
					}
				}
			}
		);

		// Retire the outgoing entry...
		await Spu.updateOne(
			{ _id: record.spuId, 'parts._id': spuPartId },
			{
				$set: {
					'parts.$.isReplaced': true,
					'parts.$.replacedBy': newLotNumber,
					'parts.$.replaceReason': reason
				}
			}
		);

		// ...and append the incoming one, carrying the same definition across.
		await Spu.updateOne(
			{ _id: record.spuId },
			{
				$push: {
					parts: {
						_id: generateId(),
						partDefinitionId: oldPart.partDefinitionId,
						partNumber: oldPart.partNumber,
						partName: oldPart.partName,
						lotNumber: newLotNumber,
						serialNumber: newSerialNumber || undefined,
						scannedAt: now,
						scannedBy: who,
						isReplaced: false
					}
				}
			}
		);

		await writeAudit(event, {
			tableName: 'spus',
			recordId: record.spuId,
			action: 'UPDATE',
			oldData: { partId: spuPartId, lotNumber: oldPart.lotNumber },
			newData: { lotNumber: newLotNumber, serialNumber: newSerialNumber || null },
			changedFields: ['parts'],
			reason: `Part replaced during service: ${reason}`
		});
		await writeAudit(event, {
			tableName: 'service_records',
			recordId,
			action: 'UPDATE',
			newData: { partNumber: oldPart.partNumber, newLotNumber, reason },
			changedFields: ['partsReplaced'],
			reason: 'Part replacement recorded'
		});

		return { success: true, partReplaced: true };
	},

	/** Record a firmware flash performed during the job. */
	recordFirmwareChange: async (event) => {
		requirePermission(event.locals.user, 'spu:write');
		await connectDB();

		const form = await event.request.formData();
		const recordId = form.get('recordId')?.toString() ?? '';
		const deviceType = (form.get('deviceType')?.toString() ?? '').trim();
		const previousVersion = (form.get('previousVersion')?.toString() ?? '').trim();
		const newVersion = (form.get('newVersion')?.toString() ?? '').trim();
		const reason = (form.get('reason')?.toString() ?? '').trim();

		if (!recordId) return fail(400, { error: 'Missing service record' });
		if (!deviceType) return fail(400, { error: 'Which device was flashed?' });
		if (!newVersion) return fail(400, { error: 'New firmware version is required' });

		const record: any = await ServiceRecord.findById(recordId).lean();
		if (!record) return fail(404, { error: 'Service record not found' });
		if (record.status === 'closed') return fail(400, { error: 'Job is already closed' });

		await ServiceRecord.updateOne(
			{ _id: recordId },
			{
				$push: {
					firmwareChanges: {
						_id: generateId(),
						deviceType,
						previousVersion: previousVersion || undefined,
						newVersion,
						reason: reason || undefined,
						performedBy: operator(event.locals.user),
						performedAt: new Date()
					}
				}
			}
		);

		await writeAudit(event, {
			tableName: 'service_records',
			recordId,
			action: 'UPDATE',
			newData: { deviceType, previousVersion, newVersion },
			changedFields: ['firmwareChanges'],
			reason: 'Firmware change recorded'
		});

		return { success: true, firmwareRecorded: true };
	},

	/** Anything that is neither a part swap nor a flash. */
	recordOtherChange: async (event) => {
		requirePermission(event.locals.user, 'spu:write');
		await connectDB();

		const form = await event.request.formData();
		const recordId = form.get('recordId')?.toString() ?? '';
		const category = (form.get('category')?.toString() ?? '').trim();
		const description = (form.get('description')?.toString() ?? '').trim();

		if (!recordId) return fail(400, { error: 'Missing service record' });
		if (!description) return fail(400, { error: 'Describe what changed' });

		const record: any = await ServiceRecord.findById(recordId).lean();
		if (!record) return fail(404, { error: 'Service record not found' });
		if (record.status === 'closed') return fail(400, { error: 'Job is already closed' });

		await ServiceRecord.updateOne(
			{ _id: recordId },
			{
				$push: {
					otherChanges: {
						_id: generateId(),
						category: category || 'adjustment',
						description,
						performedBy: operator(event.locals.user),
						performedAt: new Date()
					}
				}
			}
		);

		await writeAudit(event, {
			tableName: 'service_records',
			recordId,
			action: 'UPDATE',
			newData: { category, description },
			changedFields: ['otherChanges'],
			reason: 'Service change recorded'
		});

		return { success: true, changeRecorded: true };
	},

	/** Close the job and hand the unit back to a normal lifecycle status. */
	closeService: async (event) => {
		requirePermission(event.locals.user, 'spu:write');
		await connectDB();

		const form = await event.request.formData();
		const recordId = form.get('recordId')?.toString() ?? '';
		const resolution = (form.get('resolution')?.toString() ?? '').trim();
		const returnToRaw = form.get('returnToStatus')?.toString() ?? '';

		if (!recordId) return fail(400, { error: 'Missing service record' });

		const record: any = await ServiceRecord.findById(recordId).lean();
		if (!record) return fail(404, { error: 'Service record not found' });
		if (record.status !== 'open') return fail(400, { error: 'That service job is already closed' });

		const returnTo = RETURNABLE_STATUSES.includes(returnToRaw)
			? returnToRaw
			: RETURNABLE_STATUSES.includes(record.previousStatus)
				? record.previousStatus
				: 'validated';

		const spu: any = await Spu.findById(record.spuId).lean();
		if (spu?.finalizedAt) return fail(400, { error: 'SPU is finalized' });

		await ServiceRecord.updateOne(
			{ _id: recordId },
			{
				$set: {
					status: 'closed',
					closedAt: new Date(),
					closedBy: operator(event.locals.user),
					resolution: resolution || undefined,
					returnedToStatus: returnTo
				}
			}
		);

		const oldStatus = spu?.status ?? 'servicing';
		if (spu && oldStatus !== returnTo) {
			await Spu.updateOne(
				{ _id: record.spuId },
				{
					$set: { status: returnTo },
					$push: {
						statusTransitions: {
							_id: generateId(),
							from: oldStatus,
							to: returnTo,
							changedBy: operator(event.locals.user),
							changedAt: new Date(),
							reason: `Service job closed${resolution ? ': ' + resolution : ''}`
						}
					}
				}
			);
			await writeAudit(event, {
				tableName: 'spus',
				recordId: record.spuId,
				action: 'UPDATE',
				oldData: { status: oldStatus },
				newData: { status: returnTo },
				reason: `Service job closed${resolution ? ': ' + resolution : ''}`
			});
		}

		await writeAudit(event, {
			tableName: 'service_records',
			recordId,
			action: 'UPDATE',
			oldData: { status: 'open' },
			newData: { status: 'closed', returnedToStatus: returnTo, resolution },
			reason: 'Service job closed'
		});

		return { success: true, closed: true };
	}
};
