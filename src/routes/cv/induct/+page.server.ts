/**
 * /cv/induct — deliberate cartridge induction (CV-CARTRIDGE-INDUCT.md).
 *
 * The old "induct mode" auto-created a cartridge from ANY unknown scan on the
 * capture page and was deleted in the cartridge-first refactor (398f02c2e —
 * "induction is dead") because it minted ghost records with no lineage and no
 * chosen destination. This is induct brought back as a first-class flow: an
 * operator scans an unmade cartridge's barcode AND picks which inspection it
 * should be ready for, so the new record lands at a real status with an audit
 * trail — never a blank ghost.
 *
 * Origination mirrors the modern pattern (quick-reagent-test's "originate a
 * not-found barcode" branch, 2ddab20c9): the cartridge _id IS the scanned
 * barcode, the record is `create`d at the chosen status with a phase-tagged
 * note marking it as induct-sourced, and an AuditLog row is written. An
 * existing cartridge is NEVER mutated — a re-scan just reports what it already
 * is.
 *
 * "Ready for" → status derivation (see how each inline inspection statuses a
 * cart at capture/verdict time):
 *   - wax reject:       a `wax_filled` cart is photographed + rejected → wax_rejected
 *                       (WAX-SIMPLIFY-2; passes are implicit, no status change)
 *   - reagent inspect:  photographing a `sealed` cart     → reagent_qc (capture)
 *   - post-mortem:      photographs a `completed` cart, no status change
 * So the status a cart must be induct-created at to be "ready for" each is
 * wax_filled / sealed / completed respectively.
 */
import { error, fail, redirect } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, AuditLog, generateId } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

// The three destinations an operator can induct a cartridge toward, each mapped
// to the exact status that makes it "ready for" that inspection (derived above).
const READY_FOR = {
	wax: {
		status: 'wax_filled',
		label: 'Wax reject',
		blurb: 'Wax Reject: photograph + reject wax_filled → wax_rejected; passes are implicit (no status change).'
	},
	reagent: {
		status: 'reagent_filled',
		label: 'Reagent inspection',
		blurb: 'Photograph on Reagent Inspect (after the implicit top seal) to advance reagent_filled → reagent_qc, then a verdict.'
	},
	post_mortem: {
		status: 'completed',
		label: 'Post-mortem inspection',
		blurb: 'Photograph a ran (completed) cartridge on Post-Mortem Inspect — advisory only, no status change.'
	}
} as const;

type ReadyForKey = keyof typeof READY_FOR;

const READY_FOR_OPTIONS = (Object.keys(READY_FOR) as ReadyForKey[]).map((key) => ({
	key,
	status: READY_FOR[key].status,
	label: READY_FOR[key].label,
	blurb: READY_FOR[key].blurb
}));

function requireCvOrManufacturingWrite(user: App.Locals['user']): void {
	if (!hasPermission(user, 'cv:write') && !hasPermission(user, 'manufacturing:write')) {
		throw error(403, 'Forbidden');
	}
}

// Which lifecycle sub-docs carry a `recordedAt` stamp — used to summarize an
// existing cartridge's phase history when a re-scan hits an already-made cart.
const PHASE_STAMPS: { phase: string; path: string }[] = [
	{ phase: 'backing', path: 'backing' },
	{ phase: 'wax_filling', path: 'waxFilling' },
	{ phase: 'wax_storage', path: 'waxStorage' },
	{ phase: 'reagent_filling', path: 'reagentFilling' },
	{ phase: 'top_seal', path: 'topSeal' },
	{ phase: 'oven_cure', path: 'ovenCure' },
	{ phase: 'storage', path: 'storage' },
	{ phase: 'qaqc_release', path: 'qaqcRelease' },
	{ phase: 'shipping', path: 'shipping' },
	{ phase: 'test_execution', path: 'testExecution' }
];

function summarizePhaseHistory(cart: any): { phase: string; at: string | null }[] {
	return PHASE_STAMPS.filter((s) => cart?.[s.path]?.recordedAt).map((s) => ({
		phase: s.phase,
		at: cart[s.path].recordedAt
	}));
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requireCvOrManufacturingWrite(locals.user);
	await connectDB();

	// The session history list is driven by the origination metadata we write:
	// the 'cartridge_induct' AuditLog rows. Join each to the cartridge's current
	// status so the list reflects reality (a cart may have moved on since induct).
	const auditRaw = (await AuditLog.find({ action: 'cartridge_induct' })
		.select('recordId changedBy changedAt newData')
		.sort({ changedAt: -1 })
		.limit(20)
		.lean()) as any[];

	const cartIds = Array.from(new Set(auditRaw.map((a) => a.recordId).filter(Boolean)));
	const carts = cartIds.length
		? ((await CartridgeRecord.find({ _id: { $in: cartIds } })
				.select('_id status')
				.lean()) as any[])
		: [];
	const statusById = new Map<string, string>(carts.map((c) => [c._id, c.status ?? '—']));

	const recentlyInducted = auditRaw.map((a) => ({
		barcode: a.recordId,
		currentStatus: statusById.get(a.recordId) ?? '(deleted)',
		inductedStatus: a.newData?.to ?? null,
		readyFor: a.newData?.readyFor ?? null,
		by: a.changedBy ?? null,
		at: a.changedAt ?? null
	}));

	return {
		options: READY_FOR_OPTIONS,
		recentlyInducted: JSON.parse(JSON.stringify(recentlyInducted))
	};
};

export const actions: Actions = {
	induct: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requireCvOrManufacturingWrite(locals.user);
		await connectDB();

		const form = await request.formData();
		// Validate the barcode the same way the quick-reagent-test origination
		// does: trim, require non-empty. No generated_barcodes lookup and no UUID
		// format check — the scanned string is taken as the cartridge _id verbatim.
		const barcode = (form.get('barcode') as string | null)?.trim() ?? '';
		const readyForRaw = (form.get('readyFor') as string | null)?.trim() ?? '';

		if (!barcode) return fail(400, { error: 'Scan a cartridge barcode' });
		if (!(readyForRaw in READY_FOR)) {
			return fail(400, { error: 'Pick what the cartridge should be ready for' });
		}
		const readyFor = readyForRaw as ReadyForKey;
		const targetStatus = READY_FOR[readyFor].status;

		const op = { _id: locals.user._id, username: locals.user.username };
		const now = new Date();

		// NEVER mutate an existing cartridge — a re-scan is informational only.
		const existing = (await CartridgeRecord.findById(barcode)
			.select(
				'_id status notes backing waxFilling waxStorage reagentFilling ' +
					'topSeal ovenCure storage qaqcRelease shipping testExecution'
			)
			.lean()) as any;
		if (existing) {
			return {
				exists: true,
				barcode,
				currentStatus: existing.status ?? '—',
				phaseHistory: summarizePhaseHistory(existing),
				noteCount: Array.isArray(existing.notes) ? existing.notes.length : 0
			};
		}

		// Originate a brand-new cartridge directly at the chosen ready-for status.
		// The induct note (phase 'induct') makes these records distinguishable
		// from carts that reached this status through the normal line.
		try {
			await CartridgeRecord.create({
				_id: barcode,
				status: targetStatus,
				priorStatus: 'new',
				notes: [
					{
						_id: generateId(),
						body: `Inducted for ${READY_FOR[readyFor].label} (CV Induct: new → ${targetStatus}).`,
						phase: 'induct',
						author: op,
						createdAt: now
					}
				]
			});
			await AuditLog.create({
				_id: generateId(),
				tableName: 'cartridge_records',
				recordId: barcode,
				action: 'cartridge_induct',
				newData: { from: 'new', to: targetStatus, readyFor, source: 'induct' },
				changedAt: now,
				changedBy: op.username
			});
		} catch (e: any) {
			// Duplicate-key race (created between findById and create) or any other
			// write error — surface it so the operator can re-scan.
			return fail(409, {
				error:
					e?.code === 11000
						? `Cartridge ${barcode} already exists — re-scan to see it.`
						: `Could not induct ${barcode}.`
			});
		}

		return {
			inducted: true,
			barcode,
			status: targetStatus,
			readyFor,
			readyForLabel: READY_FOR[readyFor].label
		};
	}
};
