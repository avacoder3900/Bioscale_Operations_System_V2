/**
 * SPU Inventory Reconciliation 2026-09-02 — programmatic execution of
 * BIMS change-approval request unXY0MFkG58pNCy178UY0 (filed by Samantha Wolf).
 * Source doc: spu-reconciliation-2026-09-02.md
 *
 * Sections: A status changes, C provenance journals, D barcode clearing with
 * journal-before-clear enforcement, D2 no-barcode journals. (B — creation of
 * unregistered unit 52198 — is NOT in this script; needs UDI/status decision.)
 *
 * Every status change pushes a statusTransitions entry + AuditLog row.
 * Barcode clears use $unset (never $set:null — the sparse unique index on
 * barcode would collide on the second null).
 *
 *   npx tsx scripts/reconcile-spu-2026-09-02.ts                 # dry run
 *   npx tsx scripts/reconcile-spu-2026-09-02.ts --apply         # execute
 *   npx tsx scripts/reconcile-spu-2026-09-02.ts --apply --include-held
 *       # ALSO retire the 6 held units (0239 0240 0241 0242 0248 0250)
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { customAlphabet } from 'nanoid';

const generateId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 21);

const APPROVAL = 'unXY0MFkG58pNCy178UY0';
const TAG = 'Physical reconciliation 2026-09-02';

// ── Doc lists (4-digit UDI suffixes) ────────────────────────────────────────
const TO_ASSEMBLING = ['0257'];
const TO_SERVICING = ['0210', '0211', '0212', '0217', '0247', '0249', '0251', '0253', '0255', '0256'];
const TO_RETIRED = [
	'0001', '0002', '0003', '0004', '0162', '0165', '0174', '0175', '0190', '0191', '0192', '0193',
	'0194', '0195', '0196', '0197', '0198', '0199', '0200', '0204', '0205', '0206', '0207', '0208',
	'0209', '0213', '0214', '0216', '0219', '0224', '0225', '0227', '0228', '0231', '0232', '0233',
	'0234', '0235', '0239', '0240', '0241', '0242', '0245', '0248', '0250'
];
// Reviewer attention item 1: active within 48h of the count — held unless --include-held.
const HELD_RETIREMENTS = ['0239', '0240', '0241', '0242', '0248', '0250'];

const EXPECT_UNCHANGED: Record<string, string> = {
	'0202': 'released', '0243': 'released', '0238': 'retired',
	'0203': 'servicing', '0215': 'servicing', '0218': 'servicing', '0220': 'servicing',
	'0221': 'servicing', '0222': 'servicing', '0223': 'servicing', '0226': 'servicing',
	'0229': 'servicing', '0230': 'servicing', '0236': 'servicing', '0237': 'servicing',
	'0244': 'servicing', '0246': 'servicing', '0252': 'servicing'
};

const PROVENANCE: Record<string, string> = {
	'0212': `${TAG}: unit located in R&D Lab. Unit provided by Alejandro Valdez.`,
	'0244': `${TAG}: unit located in R&D Lab. Unit provided by Alejandro Valdez.`,
	'0253': `${TAG}: unit located at the desk. Unit provided by Alejandro Valdez.`,
	'0255': `${TAG}: unit located at the desk. Unit provided by Alejandro Valdez.`
};

const BARCODES: Record<string, string> = {
	'0202': 'e3a0f66d-74a3-4e66-9591-4ec754af8263',
	'0205': 'abd33673-2771-454d-b84c-1ef98e0168b7',
	'0208': '0a61c805-cd78-427a-b432-b62ff241a363',
	'0209': '554d4801-a8fe-4541-a84e-ad32c3ccdac8',
	'0210': '23e3865f-29c4-4272-b148-a3bad4bd0d8d',
	'0214': '4c9c4bfa-6d5b-4a7b-98c7-bac77343e1c9',
	'0215': '8d7a7379-5dec-48d6-95d9-ee48223b461c',
	'0216': '25947faf-5f5a-4758-a39c-31b74c967aed',
	'0217': '78ce5385-2fd9-4986-a075-eb3c2cd71891',
	'0218': '17c74a2b-8e29-444b-8252-3374341fb1f3',
	'0219': '6dab92cc-04f0-4cb3-b27c-ba92f815f1fd',
	'0220': '48d84ef1-8b24-46e1-9a17-fbab16737432',
	'0221': '6a6fbb66-e142-4e37-a41d-5d517bc25cf7',
	'0223': '7c44f119-1eb4-42e2-8d5c-5edb70e61a1c',
	'0224': '1981cb7f-30b1-4f75-96e7-3e552176583a',
	'0225': '96fe84df-04cb-4e4f-87f0-b89fa3cfd3af',
	'0226': 'c62b4255-24f7-4425-968b-741629bec646',
	'0227': '36a99a79-56b0-47b4-b432-1bbb3590c615',
	'0229': '1140a6dc-d586-4463-800d-e9e0f456f49a',
	'0230': '763a3e08-e4ec-4824-a705-df9730efdc94',
	'0231': '6f0527d6-62c7-4c88-b823-e435ed69be4b',
	'0234': 'f5e06431-60cc-4d01-b1e9-2744a31d12bd',
	'0235': '96ed3328-9d30-458d-bc68-b101a75cdf55',
	'0236': '644697a2-b54e-4c60-a400-31fc8eb36d4d',
	'0237': 'c3ed8306-5bb5-4259-a058-18afa441ce8f',
	'0238': 'dd0cb809-e82a-49ed-a0cb-8cb0b9b67329',
	'0241': 'BT-M01-0000-0241',
	'0242': 'BT-M01-0000-0242',
	'0253': 'BT-M01-0000-0253',
	'0255': 'BT-M01-0000-0255',
	'0256': 'BT-M01-0000-0256',
	'0257': 'BT-M01-0000-0257'
};

const NO_BARCODE = [
	'0001', '0002', '0003', '0004', '0162', '0165', '0174', '0175', '0190', '0191', '0192', '0193',
	'0194', '0195', '0196', '0197', '0198', '0199', '0200', '0203', '0204', '0206', '0207', '0211',
	'0212', '0213', '0222', '0228', '0232', '0233', '0239', '0240', '0243', '0244', '0245', '0246',
	'0247', '0248', '0249', '0250', '0251', '0252'
];

// ── helpers ─────────────────────────────────────────────────────────────────
const flags: string[] = [];
function flag(msg: string) {
	flags.push(msg);
	console.log(`  ⚠ ${msg}`);
}

async function main() {
	const apply = process.argv.includes('--apply');
	const includeHeld = process.argv.includes('--include-held');
	const uri = process.env.MONGODB_URI;
	if (!uri) throw new Error('MONGODB_URI not set');
	await mongoose.connect(uri);
	const db = mongoose.connection.db!;
	const spus = db.collection('spus');
	const auditLog = db.collection('audit_logs');

	console.log(apply ? `=== APPLY MODE${includeHeld ? ' (+held retirements)' : ''} ===` : '=== DRY RUN ===');

	// Actor: prefer the filer's real user record.
	const users = db.collection('users');
	const sam = await users.findOne({ username: { $regex: /wolf|samantha/i } });
	const actor = sam
		? { _id: String(sam._id), username: String(sam.username) }
		: { _id: 'system:reconciliation', username: 'reconciliation-2026-09-02' };
	console.log(`Actor: ${actor.username}${sam ? '' : ' (no matching user found — system actor)'}`);

	// Suffix → doc map from live UDIs.
	const all = (await spus.find({}).project({ udi: 1, status: 1, barcode: 1, journal: 1 }).toArray()) as any[];
	console.log(`Registered SPUs in DB: ${all.length}`);
	const bySuffix = new Map<string, any>();
	for (const s of all) {
		const m = String(s.udi ?? '').match(/(\d+)$/);
		if (!m) continue;
		const key = m[1].padStart(4, '0');
		if (bySuffix.has(key)) flag(`duplicate suffix ${key}: ${bySuffix.get(key).udi} and ${s.udi}`);
		bySuffix.set(key, s);
	}

	function get(suffix: string): any | null {
		const s = bySuffix.get(suffix);
		if (!s) flag(`SPU ${suffix}: not found in DB`);
		return s ?? null;
	}

	async function writeAudit(recordId: string, oldData: unknown, newData: unknown, reason: string) {
		await auditLog.insertOne({
			_id: generateId(),
			tableName: 'spus',
			recordId,
			action: 'UPDATE',
			oldData,
			newData,
			reason,
			changedBy: actor.username,
			changedAt: new Date()
		});
	}

	async function addJournal(spu: any, text: string): Promise<string | null> {
		const entry = { _id: generateId(), text, createdBy: actor, createdAt: new Date() };
		if (!apply) return entry._id;
		await spus.updateOne({ _id: spu._id }, { $push: { journal: entry } as any });
		// Verbatim verification (doc's execution constraint).
		const check = await spus.findOne({ _id: spu._id, journal: { $elemMatch: { _id: entry._id, text } } });
		if (!check) return null;
		return entry._id;
	}

	async function setStatus(spu: any, to: string, expectFrom: string | null) {
		const from = spu.status ?? 'draft';
		if (from === to) {
			flag(`SPU ${spu.udi}: already ${to} — skipped`);
			return;
		}
		if (expectFrom && from !== expectFrom) {
			flag(`SPU ${spu.udi}: expected ${expectFrom} but is ${from} — SKIPPED (doc assumption broken)`);
			return;
		}
		console.log(`  ${spu.udi}: ${from} → ${to}`);
		if (!apply) return;
		await spus.updateOne(
			{ _id: spu._id },
			{
				$set: { status: to },
				$push: {
					statusTransitions: {
						_id: generateId(),
						from,
						to,
						changedBy: actor,
						changedAt: new Date(),
						reason: `${TAG} (approval ${APPROVAL})`
					}
				} as any
			}
		);
		await writeAudit(spu._id, { status: from }, { status: to }, `${TAG} (approval ${APPROVAL})`);
	}

	// ── A. Status changes ────────────────────────────────────────────────────
	console.log('\n--- A1. draft → assembling ---');
	for (const sfx of TO_ASSEMBLING) {
		const s = get(sfx);
		if (s) await setStatus(s, 'assembling', 'draft');
	}

	console.log('\n--- A2. draft → servicing ---');
	for (const sfx of TO_SERVICING) {
		const s = get(sfx);
		if (s) await setStatus(s, 'servicing', 'draft');
	}

	console.log('\n--- A3. → retired ---');
	for (const sfx of TO_RETIRED) {
		if (HELD_RETIREMENTS.includes(sfx) && !includeHeld) {
			console.log(`  ${sfx}: HELD (recently active — reviewer attention item 1)`);
			continue;
		}
		const s = get(sfx);
		if (s) await setStatus(s, 'retired', null);
	}

	console.log('\n--- A4. verify unchanged ---');
	for (const [sfx, expect] of Object.entries(EXPECT_UNCHANGED)) {
		const s = get(sfx);
		if (s && (s.status ?? 'draft') !== expect) {
			flag(`SPU ${s.udi}: doc expects "${expect}" but is "${s.status}" — no change made, review`);
		}
	}

	// ── C. Provenance journals ───────────────────────────────────────────────
	console.log('\n--- C. provenance journal entries ---');
	for (const [sfx, text] of Object.entries(PROVENANCE)) {
		const s = get(sfx);
		if (!s) continue;
		const already = (s.journal ?? []).some((j: any) => j.text === text);
		if (already) {
			console.log(`  ${s.udi}: provenance entry already present — skipped`);
			continue;
		}
		console.log(`  ${s.udi}: + "${text.slice(0, 60)}..."`);
		if (apply && !(await addJournal(s, text))) flag(`SPU ${s.udi}: provenance journal verify FAILED`);
	}

	// ── D. Barcode clearing (journal-before-clear enforced) ─────────────────
	console.log('\n--- D. barcode clearing ---');
	let cleared = 0;
	for (const [sfx, docBarcode] of Object.entries(BARCODES)) {
		const s = get(sfx);
		if (!s) continue;
		const dbBarcode = s.barcode ?? null;
		if (dbBarcode === null) {
			flag(`SPU ${s.udi}: doc lists barcode ${docBarcode} but DB barcode is empty — SKIPPED`);
			continue;
		}
		if (dbBarcode !== docBarcode) {
			flag(`SPU ${s.udi}: doc barcode ${docBarcode} ≠ DB barcode ${dbBarcode} — SKIPPED`);
			continue;
		}
		const text = `${TAG}: barcode cleared. Previous barcode: ${dbBarcode}`;
		console.log(`  ${s.udi}: journal + clear (${dbBarcode})`);
		if (!apply) { cleared++; continue; }
		const entryId = await addJournal(s, text);
		if (!entryId) {
			flag(`SPU ${s.udi}: journal verify FAILED — barcode NOT cleared`);
			continue;
		}
		// $unset, never null: the sparse unique index on barcode treats explicit
		// nulls as present and would collide on the second one.
		await spus.updateOne({ _id: s._id }, { $unset: { barcode: '' } });
		await writeAudit(s._id, { barcode: dbBarcode }, { barcode: null, journalEntry: entryId }, `${TAG}: barcode cleared (approval ${APPROVAL})`);
		cleared++;
	}
	console.log(`  → ${cleared}/${Object.keys(BARCODES).length} barcodes ${apply ? 'cleared' : 'clearable'}`);

	// ── D2. no-barcode journals ──────────────────────────────────────────────
	console.log('\n--- D2. no-barcode journal entries ---');
	const noBcText = `${TAG}: no barcode present at time of barcode clearing.`;
	let noted = 0;
	for (const sfx of NO_BARCODE) {
		const s = get(sfx);
		if (!s) continue;
		if (s.barcode) {
			flag(`SPU ${s.udi}: doc says no barcode but DB has "${s.barcode}" — SKIPPED (no false journal)`);
			continue;
		}
		if ((s.journal ?? []).some((j: any) => j.text === noBcText)) continue;
		if (apply && !(await addJournal(s, noBcText))) {
			flag(`SPU ${s.udi}: no-barcode journal verify FAILED`);
			continue;
		}
		noted++;
	}
	console.log(`  → ${noted}/${NO_BARCODE.length} entries ${apply ? 'written' : 'to write'}`);

	// ── summary ──────────────────────────────────────────────────────────────
	console.log('\n--- resulting status distribution ---');
	for (const r of await spus.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray()) {
		console.log(`${String(r._id).padEnd(14)} ${r.n}`);
	}
	const withBarcode = await spus.countDocuments({ barcode: { $exists: true, $nin: [null, ''] } });
	console.log(`SPUs with populated barcode: ${withBarcode}`);
	console.log(`\nFlags (${flags.length}):`);
	for (const f of flags) console.log(`  - ${f}`);

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
