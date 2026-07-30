import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, CartridgeGroup, Spu } from '$lib/server/db';
import { reportGroup, type GroupInput } from '$lib/server/optical-analysis';
import { MAX_COMPARE_CARTRIDGES, isGroupColorKey } from '$lib/server/optical-constants';
import type { PageServerLoad } from './$types';

// One optical analysis group, read as a table: totals over the group plus one row
// per cartridge. VALIDATION-06 story S4.
//
// Derive-on-read throughout. Nothing here writes anything, and `cartridge_records`
// is never touched — the only mutation reachable from this page is the shared
// `?/removeFromGroup` action on the log route, which edits `cartridge_groups` only.
//
// Route-precedence note: this dynamic segment is a sibling of the static
// `groups/compare`. SvelteKit resolves static segments first, so the two coexist —
// do not rename `compare` to anything a group id could collide with.

export const load: PageServerLoad = async ({ params, locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	// Archived groups 404 rather than render: a soft-deleted cohort is not a cohort,
	// and silently showing one invites analysis of a set someone deliberately retired.
	const groupDoc = (await CartridgeGroup.findOne({
		_id: params.groupId,
		purpose: 'optical_analysis',
		archivedAt: null
	})
		.select('_id name description color cartridgeIds createdAt createdBy')
		.lean()) as any;

	if (!groupDoc) error(404, 'That optical analysis group does not exist, or has been archived.');

	// `?? []` because .lean() does not apply schema defaults.
	const memberIds = [...new Set((groupDoc.cartridgeIds ?? []) as string[])];

	// Each cartridge drags ~126 readings, so the same cap the comparison page uses
	// applies here. Truncation is surfaced, never silent.
	const truncated = memberIds.length > MAX_COMPARE_CARTRIDGES;
	const usedIds = truncated ? memberIds.slice(0, MAX_COMPARE_CARTRIDGES) : memberIds;

	// .lean() is REQUIRED: `rawData` and `device` are undeclared on the schema
	// (brevitest-cloud writes them), so a hydrated strict document drops both.
	const docs = (await CartridgeRecord.find({ _id: { $in: usedIds } })
		.select('_id assayName assayCategory status createdAt device rawData')
		.lean()) as any[];
	const byId = new Map(docs.map((d) => [d._id as string, d]));

	// SPU udi, batched — one query regardless of member count, never N+1.
	// Both join paths are verified against production: device.id -> the Particle
	// device id, with device.name -> udi (uniquely indexed) as the fallback.
	const deviceIds = [...new Set(docs.map((d) => d.device?.id).filter(Boolean))] as string[];
	const deviceNames = [...new Set(docs.map((d) => d.device?.name).filter(Boolean))] as string[];

	const spus =
		deviceIds.length > 0 || deviceNames.length > 0
			? ((await Spu.find({
					$or: [
						{ 'particleLink.particleDeviceId': { $in: deviceIds } },
						{ udi: { $in: deviceNames } }
					]
				})
					.select('_id udi particleLink.particleDeviceId')
					.lean()) as any[])
			: [];

	const spuByDevice = new Map<string, any>();
	const spuByUdi = new Map<string, any>();
	for (const s of spus) {
		if (s.particleLink?.particleDeviceId) spuByDevice.set(s.particleLink.particleDeviceId, s);
		if (s.udi) spuByUdi.set(s.udi, s);
	}

	function udiFor(id: string): string | null {
		const d = byId.get(id);
		const deviceId: string | null = d?.device?.id ?? null;
		const deviceName: string | null = d?.device?.name ?? null;
		const spu =
			(deviceId ? spuByDevice.get(deviceId) : null) ??
			(deviceName ? spuByUdi.get(deviceName) : null) ??
			null;
		// Fall back to the raw device name: it IS the udi on these records, and showing
		// it unmatched beats showing a dash for a cartridge that plainly ran somewhere.
		return spu?.udi ?? deviceName ?? null;
	}

	// A member id with no cartridge_records document is a different failure from a
	// cartridge that never ran, so it is reported separately rather than folded into
	// the engine's `excluded` list with a misleading "never run" reason.
	const missingIds = usedIds.filter((id) => !byId.has(id));

	const input: GroupInput = {
		groupId: groupDoc._id,
		groupName: groupDoc.name ?? '(unnamed)',
		items: usedIds
			.filter((id) => byId.has(id))
			.map((id) => ({
				id,
				label: id, // cartridge_records._id IS the scanned barcode
				spuUdi: udiFor(id),
				readings: byId.get(id)?.rawData?.readings ?? []
			}))
	};

	const report = reportGroup(input);

	// Run dates are not part of the engine's contract, so they ride alongside.
	const runDates: Record<string, string | null> = {};
	for (const d of docs) {
		runDates[d._id as string] = d.createdAt ? new Date(d.createdAt).toISOString() : null;
	}

	return {
		group: {
			_id: groupDoc._id as string,
			name: (groupDoc.name ?? '(unnamed)') as string,
			description: (groupDoc.description ?? null) as string | null,
			color: isGroupColorKey(groupDoc.color) ? groupDoc.color : 'cyan',
			createdAt: groupDoc.createdAt ? new Date(groupDoc.createdAt).toISOString() : null,
			/** Every id on the group, including any dropped by the cap. */
			memberCount: memberIds.length
		},
		report: JSON.parse(JSON.stringify(report)),
		runDates,
		missingIds,
		truncated,
		cap: MAX_COMPARE_CARTRIDGES
	};
};
