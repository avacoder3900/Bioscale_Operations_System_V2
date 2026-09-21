// ROUTE PRECEDENCE — READ THIS BEFORE RENAMING THIS DIRECTORY.
//
// This route only resolves because SvelteKit prefers a STATIC path segment over a
// sibling DYNAMIC one: `groups/compare` wins over `groups/[groupId]`, which would
// otherwise swallow it as a group whose id is the literal string "compare".
//
// Consequences:
//   1. Do NOT rename this directory to anything a real group id could collide with
//      (a nanoid, a slug derived from a group name, `[...rest]`, etc.). The day a
//      group id equals this segment, the group's analyze page silently becomes this
//      page — with no error anywhere.
//   2. Any further static sibling added under `groups/` inherits the same rule and
//      the same hazard.
//
// VALIDATION-06 story S5. Derive-on-read throughout: nothing here writes to the DB,
// and `cartridge_records` is never touched.
//
// Query params:
//   ?a=<groupId>&b=<groupId>   the two optical_analysis groups to compare.
// Missing or unknown ids are NOT an exception — they render a helpful empty state,
// because a stale bookmark to an archived group is an ordinary event, not a fault.

import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, CartridgeGroup, Spu } from '$lib/server/db';
import { diffGroups, type GroupInput } from '$lib/server/optical-analysis';
import { MAX_COMPARE_CARTRIDGES, isGroupColorKey } from '$lib/server/optical-constants';
import type { PageServerLoad } from './$types';

/** One side of the comparison, as the page needs to describe it. */
export interface CompareSide {
	groupId: string;
	groupName: string;
	color: string;
	description: string | null;
	/** Members named on the group document, before any cap or record lookup. */
	memberCount: number;
	/** Members dropped because the cap was hit. */
	truncated: number;
	/** Members with no `cartridge_records` document at all — accounted for, never silent. */
	missingRecords: number;
}

export const load: PageServerLoad = async ({ url, locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const aId = url.searchParams.get('a')?.trim() ?? '';
	const bId = url.searchParams.get('b')?.trim() ?? '';

	const empty = (problem: string) => ({
		diff: null,
		sides: null as { a: CompareSide; b: CompareSide } | null,
		problem
	});

	if (!aId || !bId) {
		return empty(
			'Pick two groups to compare. This page expects ?a=<group id>&b=<group id> — the Groups workspace sets both for you.'
		);
	}
	if (aId === bId) {
		return empty('Group A and Group B are the same group. Pick two different groups.');
	}

	// `?? []` on cartridgeIds below because .lean() does not apply schema defaults.
	const groupDocs = (await CartridgeGroup.find({
		_id: { $in: [aId, bId] },
		purpose: 'optical_analysis',
		archivedAt: null
	})
		.select('_id name color description cartridgeIds')
		.lean()) as any[];

	const aDoc = groupDocs.find((g) => g._id === aId) ?? null;
	const bDoc = groupDocs.find((g) => g._id === bId) ?? null;

	if (!aDoc || !bDoc) {
		const missing = [!aDoc ? 'A' : null, !bDoc ? 'B' : null].filter(Boolean).join(' and ');
		return empty(
			`Group ${missing} could not be found. It may have been archived, or it may not be an optical-analysis group. Pick a group from the workspace.`
		);
	}

	// Each cartridge drags ~126 readings, so both sides are capped independently.
	const aAll = (aDoc.cartridgeIds ?? []) as string[];
	const bAll = (bDoc.cartridgeIds ?? []) as string[];
	const aIds = aAll.slice(0, MAX_COMPARE_CARTRIDGES);
	const bIds = bAll.slice(0, MAX_COMPARE_CARTRIDGES);

	// ONE batched cartridge query covering both groups.
	const wantedIds = [...new Set([...aIds, ...bIds])];
	const docs = (await CartridgeRecord.find({ _id: { $in: wantedIds } })
		// .lean() is REQUIRED: rawData and device are undeclared on the schema
		// (brevitest-cloud owns them), so a hydrated strict document drops both.
		.select('_id device rawData')
		.lean()) as any[];
	const byId = new Map(docs.map((d) => [d._id as string, d]));

	// ONE batched SPU query covering both groups. diffGroups needs spuUdi to decide
	// whether the comparison spans more than one reader — that decides whether the
	// calibration caveat is emitted, so it cannot be skipped.
	// Join verified 32/32 in production: device.id -> the Particle device id, with
	// device.name -> udi (uniquely indexed) as the fallback.
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

	const udiById = new Map<string, string | null>();
	for (const d of docs) {
		const deviceId: string | null = d.device?.id ?? null;
		const deviceName: string | null = d.device?.name ?? null;
		const spu =
			(deviceId ? spuByDevice.get(deviceId) : null) ??
			(deviceName ? spuByUdi.get(deviceName) : null) ??
			null;
		// Fall back to the raw device name: an unmatched reader is still a distinct
		// reader for the purposes of the calibration caveat.
		udiById.set(d._id as string, spu?.udi ?? deviceName ?? null);
	}

	const toItem = (id: string) => ({
		id,
		label: id, // cartridge_records._id IS the scanned barcode
		spuUdi: udiById.get(id) ?? null,
		readings: byId.get(id)?.rawData?.readings ?? []
	});

	const buildInput = (doc: any, ids: string[]): GroupInput => ({
		groupId: doc._id,
		groupName: doc.name ?? '(unnamed)',
		items: ids.filter((id) => byId.has(id)).map(toItem)
	});

	const aInput = buildInput(aDoc, aIds);
	const bInput = buildInput(bDoc, bIds);

	const diff = diffGroups(aInput, bInput);

	const side = (doc: any, all: string[], used: string[], input: GroupInput): CompareSide => ({
		groupId: doc._id,
		groupName: doc.name ?? '(unnamed)',
		color: isGroupColorKey(doc.color) ? doc.color : 'cyan',
		description: doc.description ?? null,
		memberCount: all.length,
		truncated: Math.max(0, all.length - used.length),
		missingRecords: used.length - input.items.length
	});

	return {
		diff: JSON.parse(JSON.stringify(diff)),
		sides: {
			a: side(aDoc, aAll, aIds, aInput),
			b: side(bDoc, bAll, bIds, bInput)
		},
		problem: null as string | null
	};
};
