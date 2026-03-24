import { json } from '@sveltejs/kit';
import { connectDB, Consumable, Equipment, EquipmentLocation, OpentronsRobot, CartridgeRecord } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	await connectDB();

	const type = url.searchParams.get('type');
	const id = url.searchParams.get('id')?.trim();

	if (!type || !id) {
		return json({ error: 'Missing type or id parameter' }, { status: 400 });
	}

	if (type === 'deck') {
		const deck = await Consumable.findOne({ _id: id, type: 'deck' }).lean();
		if (!deck) return json({ error: `Deck "${id}" does not exist. Register it in Equipment → Decks & Trays first.` }, { status: 404 });
		if ((deck as any).status === 'retired') return json({ error: `Deck "${id}" is retired.` }, { status: 400 });
		return json({ valid: true, id, name: (deck as any).name ?? id, status: (deck as any).status });
	}

	if (type === 'tray') {
		const tray = await Consumable.findOne({ _id: id, type: 'cooling_tray' }).lean();
		if (!tray) return json({ error: `Tray "${id}" does not exist. Register it in Equipment → Decks & Trays first.` }, { status: 404 });
		return json({ valid: true, id, status: (tray as any).status });
	}

	if (type === 'fridge') {
		// Check Equipment first (parent fridges), then fall back to EquipmentLocation
		const equip = await Equipment.findOne({ _id: id, equipmentType: 'fridge', status: { $ne: 'offline' } }).lean()
			?? await Equipment.findOne({ barcode: id, equipmentType: 'fridge', status: { $ne: 'offline' } }).lean();
		if (equip) return json({ valid: true, id: (equip as any)._id, name: (equip as any).name });
		const fridge = await EquipmentLocation.findOne({ _id: id, locationType: 'fridge', isActive: true }).lean()
			?? await EquipmentLocation.findOne({ barcode: id, locationType: 'fridge', isActive: true }).lean();
		if (!fridge) return json({ error: `Fridge "${id}" does not exist or is inactive.` }, { status: 404 });
		return json({ valid: true, id: (fridge as any)._id, name: (fridge as any).displayName });
	}

	if (type === 'robot') {
		const robot = await OpentronsRobot.findById(id).lean();
		if (!robot) return json({ error: `Robot "${id}" does not exist.` }, { status: 404 });
		if (!(robot as any).isActive) return json({ error: `Robot "${id}" is inactive.` }, { status: 400 });
		return json({ valid: true, id, name: (robot as any).name });
	}

	if (type === 'cartridge') {
		// context=reagent means cartridge must already exist (wax_filled) and not yet reagent-filled
		const context = url.searchParams.get('context');
		const cart = await CartridgeRecord.findById(id).select('_id currentPhase waxFilling.runId reagentFilling.runId').lean();

		if (context === 'reagent') {
			if (!cart) {
				return json({ error: `Cartridge "${id}" not found. It must go through wax filling first.`, isNew: true }, { status: 404 });
			}
			const phase = (cart as any).currentPhase;
			const validForReagent = ['wax_filled', 'wax_stored', 'wax_qc'];
			if (!validForReagent.includes(phase)) {
				return json({ error: `Cartridge "${id}" is in phase "${phase}". Must be wax stored before reagent filling.` }, { status: 400 });
			}
			return json({ valid: true, id, isNew: false, phase });
		}

		// Default (wax filling context): cartridge should be new or in backing phase
		if (cart) {
			const phase = (cart as any).currentPhase;
			if (phase && phase !== 'backing' && phase !== 'voided') {
				return json({ error: `Cartridge "${id}" already exists in phase "${phase}". It cannot be re-scanned.` }, { status: 400 });
			}
		}
		// Cartridge not found = OK (will be created on first scan)
		return json({ valid: true, id, isNew: !cart });
	}

	if (type === 'admin-password') {
		// Check if the user is an admin by verifying password against User model
		const { User } = await import('$lib/server/db');
		const { isAdmin } = await import('$lib/server/permissions');
		if (isAdmin(event.locals.user)) {
			// Admin user — accept any password as override confirmation
			return json({ valid: true });
		}
		return json({ valid: false, error: 'User is not an admin' }, { status: 403 });
	}

	return json({ error: `Unknown equipment type: ${type}` }, { status: 400 });
};
