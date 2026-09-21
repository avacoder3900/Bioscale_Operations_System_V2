/**
 * Run-start deck identity guard.
 *
 * THE HOLE THIS CLOSES
 * BIMS asks the operator which deck they loaded (DECK-004). The robot decides
 * which cartridge-deck definition to load entirely on its own, by reading a
 * Particle device id over USB serial and looking it up in a dict inside the fill
 * protocol. Those two facts were never compared. Calibrating "DECK-001" in the
 * Studio therefore corrected a definition that the robot might never load, and
 * nothing anywhere recorded which geometry a run actually used —
 * `deck_calibration_edits.deckEquipmentId` was null on all ~47k rows and
 * `opentrons_run_records` was empty.
 *
 * WHAT IT CAN AND CANNOT PROVE
 * The Particle id is read on the robot at run time, so BIMS cannot verify the
 * physical deck from here. What it CAN prove before a run starts:
 *   - the selected deck is bound to a definition at all,
 *   - that definition exists in the labware library,
 *   - the deck the operator picked is one the protocol can actually load.
 * Each of those, left unchecked, produces "I calibrated it and it still goes to
 * the wrong place". The Particle id is returned so it can be recorded on the run
 * and compared against the robot's own log afterwards.
 *
 * ENFORCEMENT IS OPT-IN
 * Resolution always runs and always reports; only REFUSING is gated, per robot,
 * by DECK_HARDENING_ROBOT_IDS. On a robot that is not opted in this function
 * cannot throw — every problem comes back as `warning`, gets written to the run
 * record, and the fill proceeds exactly as it does today. That is what lets the
 * guard be observed on live production traffic before it is allowed to block.
 */
import { connectDB, Equipment, LabwareDefinition } from '$lib/server/db';
import { definitionHash } from './definition-hash';
import { isDeckLoadName } from './resolve';

export interface DeckBinding {
	deckId: string | null;
	deckLoadName: string | null;
	particleDeviceId: string | null;
	definitionVersion: number | null;
	definitionHash: string | null;
	wellCount: number | null;
	/** Why this run would have been refused, or a non-fatal note. Null when clean. */
	warning: string | null;
	/** True when the binding is good enough to run on. */
	ok: boolean;
	/** Whether refusal was armed for this robot. */
	enforced: boolean;
}

export class DeckBindingError extends Error {}

export interface GuardOptions {
	/** Refuse the run on a bad binding. False = report only. */
	enforce?: boolean;
	/** loadNames the deployed protocol can load, when known. */
	referencedLoadNames?: string[];
}

const empty = (enforced: boolean): DeckBinding => ({
	deckId: null,
	deckLoadName: null,
	particleDeviceId: null,
	definitionVersion: null,
	definitionHash: null,
	wellCount: null,
	warning: null,
	ok: true,
	enforced
});

/**
 * Resolve the deck a run will use.
 *
 * Throws `DeckBindingError` only when `enforce` is true AND the binding is
 * unusable. A run that carries no deck id at all is never refused — that is a
 * pre-existing data-shape gap in older runs, not a calibration mismatch, and
 * blocking it would stop production for a reason unrelated to geometry.
 */
export async function resolveDeckBinding(
	deckId: string | null | undefined,
	opts: GuardOptions = {}
): Promise<DeckBinding> {
	await connectDB();
	const enforce = !!opts.enforce;

	const refuse = (msg: string, partial?: Partial<DeckBinding>): DeckBinding => {
		if (enforce) throw new DeckBindingError(msg);
		return { ...empty(enforce), ...partial, warning: msg, ok: false };
	};

	if (!deckId) {
		return {
			...empty(enforce),
			warning: 'Run carries no deckId — geometry provenance cannot be recorded for this run.'
		};
	}

	const deck = (await Equipment.findById(deckId).lean()) as any;
	if (!deck) {
		return refuse(
			`Deck "${deckId}" is not in the equipment registry. Pick a registered deck before starting the run.`,
			{ deckId: String(deckId) }
		);
	}
	if (deck.archivedAt) {
		return refuse(`Deck "${deckId}" is archived and must not be used for production fills.`, {
			deckId: String(deckId)
		});
	}

	const deckLoadName: string | null = deck.deckLoadName ?? null;
	if (!deckLoadName) {
		return refuse(
			`Deck "${deckId}" is not bound to a labware definition, so BIMS cannot tell which ` +
				`geometry the robot will load for it. Bind it (equipment.deckLoadName) — ` +
				`scripts/deck-registry-bind.ts does this — then start the run again.`,
			{ deckId: String(deckId), particleDeviceId: deck.particleDeviceId ?? null }
		);
	}
	if (!isDeckLoadName(deckLoadName)) {
		return refuse(
			`Deck "${deckId}" is bound to "${deckLoadName}", which is not a cartridge-deck definition.`,
			{ deckId: String(deckId), deckLoadName }
		);
	}

	const def = (await LabwareDefinition.findOne({ loadName: deckLoadName }).lean()) as any;
	if (!def?.definition) {
		return refuse(
			`Deck "${deckId}" is bound to "${deckLoadName}", but no such definition exists in the ` +
				`BIMS labware library. Upload it before running.`,
			{ deckId: String(deckId), deckLoadName }
		);
	}

	const resolved: DeckBinding = {
		deckId: String(deckId),
		deckLoadName,
		particleDeviceId: deck.particleDeviceId ?? null,
		definitionVersion: Number(def.version ?? 1),
		definitionHash: definitionHash(def.definition),
		wellCount: Object.keys(def.definition?.wells ?? {}).length,
		warning: null,
		ok: true,
		enforced: enforce
	};

	if (opts.referencedLoadNames?.length && !opts.referencedLoadNames.includes(deckLoadName)) {
		return refuse(
			`Deck "${deckId}" (${deckLoadName}) is not one of the decks this protocol can load ` +
				`(${opts.referencedLoadNames.filter(isDeckLoadName).join(', ') || 'none'}). ` +
				`Either the wrong deck was selected, or the protocol on the robot is the wrong one.`,
			resolved
		);
	}

	if (!resolved.particleDeviceId) {
		resolved.warning =
			`Deck "${deckId}" has no particleDeviceId recorded, so the robot's own deck ` +
			`selection cannot be cross-checked against this run afterwards.`;
	}
	return resolved;
}
