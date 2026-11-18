/**
 * BIMS API v1 — reader pairing and the reader's Wi-Fi, against the database
 * and Particle. Contract: docs/BIMS-API-V1.md, "Readers".
 *
 * Unlike the cartridge operations this module also imports the Particle
 * client and the operator Wi-Fi functions (`$lib/server/spu-wifi`), so the
 * device contract lives in one place.
 *
 * Writes: `spus.holder` (set on pair, removed on unpair), one journal entry on
 * the unit per pair, unpair and Wi-Fi change, and one `audit_log` row each.
 * Nothing else on the SPU, and never the operator `assignment`.
 *
 * Privacy: a Wi-Fi network name can place a home, so it is never journaled or
 * audited for an app-held reader (READER-01). The password is forwarded to
 * Particle and nothing else.
 */
import { AuditLog, Spu, generateId } from '$lib/server/db';
import { getDevice, getVariable } from '$lib/server/particle';
import { isMissingVariable, parseStatus } from '$lib/server/spu-wifi';
import {
	WIFI_MIN_FIRMWARE,
	evaluatePair,
	evaluateUnpair,
	heldBy,
	pickReader,
	serialValues,
	type ReaderDoc
} from './reader-rules';
import type { AppName } from './rules';

const READER_FIELDS = 'udi barcode status holder particleLink.particleDeviceId particleLink.particleSerial';

/** The sacred-document guard (db/middleware/sacred.ts) allows annotations, with an audit row. */
const ANNOTATION = { allowFinalized: true } as any;

export type ReaderView = {
	serial: string;
	online: boolean | null;
	firmware: number | null;
	wifiSupported: boolean | null;
	since: string | null;
};

export async function findReaderByCode(values: string[]): Promise<ReaderDoc | null> {
	const rows = (await Spu.find({
		$or: [{ udi: { $in: values } }, { barcode: { $in: values } }, { 'particleLink.particleSerial': { $in: values } }]
	})
		.select(READER_FIELDS)
		.limit(10)
		.lean()) as unknown as ReaderDoc[];
	return pickReader(rows, values);
}

export async function findReaderBySerial(serial: string): Promise<ReaderDoc | null> {
	const rows = (await Spu.find({ udi: { $in: serialValues(serial) } })
		.select(READER_FIELDS)
		.limit(3)
		.lean()) as unknown as ReaderDoc[];
	return rows.length === 1 ? rows[0] : null;
}

/** The reader, only when this holder holds it. */
export async function heldReader(serial: string, holderRef: string): Promise<ReaderDoc | null> {
	const doc = await findReaderBySerial(serial);
	return heldBy(doc, holderRef) ? doc : null;
}

const actorOf = (app: AppName) => ({ _id: `api:${app}`, username: `api:${app}` });

/** Same shape as spu-journal.ts writes; `source: 'app'` renders as its own badge. */
function journalEntry(text: string, app: AppName, now: Date) {
	return { _id: generateId(), text, source: 'app', refKind: 'bims-api', createdBy: actorOf(app), createdAt: now };
}

async function audit(spuId: string, app: AppName, now: Date, row: { action: string; oldData: unknown; newData: unknown; changedFields: string[] }) {
	await AuditLog.create({ _id: generateId(), tableName: 'spus', recordId: spuId, changedBy: `api:${app}`, changedAt: now, ...row });
}

// ---------------------------------------------------------------------------
// Pair and unpair

export type PairResponse =
	| { ok: true; status: 'paired' | 'already'; reader: ReaderView }
	| { ok: false; reason: 'not_found' | 'held_by_other' | 'not_available' };

/**
 * Make `holderRef` the reader's holder. Conditional on no holder and on the
 * status that was read, so two holders cannot both pair one reader; a missed
 * write is read and judged again, once.
 */
export async function pairReader(values: string[], holderRef: string, app: AppName, now = new Date()): Promise<PairResponse> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const doc = await findReaderByCode(values);
		const decision = evaluatePair(doc, holderRef);
		if (decision.action === 'refuse') return { ok: false, reason: decision.reason };
		if (decision.action === 'already') return { ok: true, status: 'already', reader: await readerView(doc!) };

		const holder = { kind: 'app', ref: holderRef, via: app, since: now };
		const entry = journalEntry(`Paired with a Bioscale app (${app}, holder ${holderRef})`, app, now);
		const res = await Spu.updateOne(
			{ _id: doc!._id, 'holder.ref': { $exists: false }, status: doc!.status ?? { $exists: false } },
			{ $set: { holder }, $push: { journal: entry } },
			ANNOTATION
		);
		if (res.matchedCount === 1) {
			await audit(doc!._id, app, now, {
				action: 'PAIR',
				oldData: { holder: null },
				newData: { holder: { kind: 'app', ref: holderRef, via: app }, journalEntryAdded: entry._id },
				changedFields: ['holder', 'journal']
			});
			return { ok: true, status: 'paired', reader: await readerView({ ...doc!, holder }) };
		}
	}
	return { ok: false, reason: 'held_by_other' };
}

export type UnpairResponse =
	| { ok: true; status: 'unpaired' | 'not_paired' }
	| { ok: false; reason: 'not_found' | 'held_by_other' };

export async function unpairReader(serial: string, holderRef: string, app: AppName, now = new Date()): Promise<UnpairResponse> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const doc = await findReaderBySerial(serial);
		const decision = evaluateUnpair(doc, holderRef);
		if (decision.action === 'refuse') return { ok: false, reason: decision.reason };
		if (decision.action === 'not_paired') return { ok: true, status: 'not_paired' };

		const entry = journalEntry(`Unpaired from a Bioscale app (${app}, holder ${holderRef})`, app, now);
		const res = await Spu.updateOne(
			{ _id: doc!._id, 'holder.ref': holderRef },
			{ $unset: { holder: '' }, $push: { journal: entry } },
			ANNOTATION
		);
		if (res.matchedCount === 1) {
			await audit(doc!._id, app, now, {
				action: 'UNPAIR',
				oldData: { holder: { kind: 'app', ref: holderRef, via: doc!.holder?.via ?? null } },
				newData: { holder: null, journalEntryAdded: entry._id },
				changedFields: ['holder', 'journal']
			});
			return { ok: true, status: 'unpaired' };
		}
	}
	return { ok: false, reason: 'held_by_other' };
}

/**
 * Journal and audit a Wi-Fi change made from an app. No network name, no
 * password. A failure here never fails the request: the change already
 * happened on the device.
 */
export async function journalWifiChange(doc: ReaderDoc, app: AppName, now = new Date()): Promise<void> {
	try {
		const entry = journalEntry(`Wi-Fi changed from a Bioscale app (${app})`, app, now);
		await Spu.updateOne({ _id: doc._id }, { $push: { journal: entry } }, ANNOTATION);
		await audit(doc._id, app, now, {
			action: 'UPDATE',
			oldData: {},
			newData: { journalEntryAdded: entry._id, source: 'app', event: 'wifi_changed', via: app },
			changedFields: ['journal']
		});
	} catch (e) {
		console.error(`[bims-api] reader wifi journal failed: ${e instanceof Error ? e.name : 'unknown error'}`);
	}
}

// ---------------------------------------------------------------------------
// What the app may see of a reader

const PARTICLE_TIMEOUT_MS = 4000;

function withTimeout<T>(p: Promise<T>, ms = PARTICLE_TIMEOUT_MS): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('timeout')), ms);
		p.then(
			(v) => (clearTimeout(t), resolve(v)),
			(e) => (clearTimeout(t), reject(e))
		);
	});
}

const iso = (v: Date | string | null | undefined) => {
	if (!v) return null;
	const d = v instanceof Date ? v : new Date(v);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Serial, whether it is online, its firmware and whether it can change Wi-Fi.
 * One Particle device read and, when online, one variable read, each bounded;
 * anything Particle cannot answer is null. Never throws for Particle.
 */
export async function readerView(doc: ReaderDoc): Promise<ReaderView> {
	const view: ReaderView = { serial: doc.udi, online: null, firmware: null, wifiSupported: null, since: iso(doc.holder?.since) };
	const deviceId = doc.particleLink?.particleDeviceId;
	if (!deviceId) return view;

	try {
		const d = await withTimeout(getDevice(deviceId));
		view.online = Boolean(d.online ?? d.connected);
		const fw = Number(d.firmware_version);
		if (Number.isFinite(fw) && fw > 0) view.firmware = fw;
	} catch {
		return view;
	}

	if (view.online) {
		try {
			const v = await withTimeout(getVariable(deviceId, 'wifi_status'));
			view.wifiSupported = true;
			const st = parseStatus(v?.result);
			if (view.firmware === null && st?.firmware) view.firmware = st.firmware;
		} catch (e) {
			if (e instanceof Error && isMissingVariable(e.message)) view.wifiSupported = false;
		}
	}
	if (view.wifiSupported === null && view.firmware !== null) view.wifiSupported = view.firmware >= WIFI_MIN_FIRMWARE;
	return view;
}
