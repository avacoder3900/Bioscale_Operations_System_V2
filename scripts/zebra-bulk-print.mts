/**
 * Bulk cartridge-label run on the Zebra ZT230 via the local Browser Print agent,
 * using the SAME server code the BIMS page uses:
 *
 *   reserveBatch()  → mintCartridgeBarcodes() (UUID v4; rejects anything already a
 *                     CartridgeRecord._id or in any prior BarcodeSheetBatch.barcodeIds;
 *                     rejects within-batch dupes) + reserved batch row
 *   send ZPL        → Browser Print /write, then poll ~HS until the printer has
 *                     drained the job and shows no error flags
 *   confirmBatch()  → re-checks cartridge + prior-batch collisions, atomic claim,
 *                     PT-CT-106 `creation`, AuditLog
 *
 * Extras over the page: a longer reservation window per batch (a printer stall
 * must never leave printed labels unrecorded), an extra guard against
 * optical_test_cartridges.barcode, a run-wide in-memory duplicate set, and a
 * final audit pass over every UUID printed in the run.
 *
 * Run from the PC the printer is attached to:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/zebra-bulk-print.mts --as=jacob --total=2000 [--batch=200] [--dry]
 *
 * --dry: mint + verify + build ZPL, but neither send nor confirm (batches are
 *        left `reserved` and expire; their UUIDs are burned — that is by design).
 */
import * as dotenv from 'dotenv';
dotenv.config();
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const flag = (k: string) => args.includes(`--${k}`);

const AS = opt('as');
const TOTAL = Number(opt('total', '0'));
const BATCH = Number(opt('batch', '200'));
const DRY = flag('dry');
const AGENT = process.env.BROWSER_PRINT_URL ?? 'http://localhost:9100';
const RUN_TAG = `zebra-bulk-${new Date().toISOString().slice(0, 10)}`;
const TTL_MS = 30 * 60 * 1000; // per-batch reservation window for the bulk run

if (!AS) throw new Error('--as=<username> is required (who the batches are recorded under)');
if (!Number.isInteger(TOTAL) || TOTAL < 1 || TOTAL > 5000) throw new Error('--total must be 1..5000');
if (!Number.isInteger(BATCH) || BATCH < 2 || BATCH > 800 || BATCH % 2 !== 0) throw new Error('--batch must be even, 2..800');

const { connectDB } = await import('../src/lib/server/db/connection.js');
await connectDB();
const { BarcodeSheetBatch, CartridgeRecord, OpticalTestCartridge, PartDefinition, User } = await import('../src/lib/server/db/models/index.js');
const { reserveBatch, confirmBatch, expireStaleReservations, BARCODE_PART_NUMBER } = await import('../src/lib/server/services/barcode-print-batch.js');
const { buildCartridgeLabelsZpl, ZT230_2X_075_DEFAULTS, ZEBRA_TEMPLATE_VERSION } = await import('../src/lib/zebra/cartridge-label-zpl.js');

const user = (await User.findOne({ username: AS }).select('_id username').lean()) as { _id: string; username: string } | null;
if (!user) throw new Error(`No user with username ${AS}`);

// ── Browser Print ────────────────────────────────────────────────────────
interface Dev { name: string; uid: string; connection: string; deviceType: string; version?: number; provider?: string; manufacturer?: string }
async function agentGet(p: string) { const r = await fetch(`${AGENT}${p}`); return r.json(); }
async function agentPost(p: string, body: unknown) {
	const r = await fetch(`${AGENT}${p}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
	const t = await r.text();
	if (!r.ok) throw new Error(`Browser Print ${p} → ${r.status} ${t}`);
	return t;
}
const printers = ((await agentGet('/available')) as { printer?: Dev[] }).printer ?? [];
const printer = printers.find((p) => p.uid === opt('printer')) ?? printers[0];
if (!printer && !DRY) throw new Error(`No printer visible to Browser Print at ${AGENT}`);
const printerName = printer ? `${printer.name} (${printer.connection})` : 'dry-run';

interface HS { paperOut: boolean; paused: boolean; headOpen: boolean; ribbonOut: boolean; formatsBuffered: number; labelsRemaining: number; raw: string }
async function hostStatus(): Promise<HS | null> {
	if (!printer) return null;
	try {
		await agentPost('/write', { device: printer, data: '~HS' });
		await new Promise((r) => setTimeout(r, 700));
		const raw = await agentPost('/read', { device: printer });
		const lines = raw.replace(/\x02/g, '').split(/\x03|\r?\n/).map((l) => l.trim()).filter(Boolean);
		const l1 = (lines[0] ?? '').split(','), l2 = (lines[1] ?? '').split(',');
		if (l1.length < 9 || l2.length < 9) return null;
		return {
			paperOut: l1[1] === '1', paused: l1[2] === '1', formatsBuffered: Number(l1[4]) || 0,
			headOpen: l2[2] === '1', ribbonOut: l2[3] === '1', labelsRemaining: Number(l2[8]) || 0, raw
		};
	} catch { return null; }
}

/** Wait until the printer has drained the job. Throws on error flags that mean
 *  labels may be missing (paper/ribbon out). Head-open/pause just wait. */
async function waitDrained(label: string, maxMs = 20 * 60 * 1000): Promise<void> {
	const t0 = Date.now();
	let lastLog = 0;
	while (Date.now() - t0 < maxMs) {
		const s = await hostStatus();
		if (s) {
			if (s.paperOut) throw new Error(`${label}: printer reports PAPER OUT — labels may be missing; NOT confirming`);
			if (s.ribbonOut) throw new Error(`${label}: printer reports RIBBON OUT — labels may be missing; NOT confirming`);
			if (s.formatsBuffered === 0 && s.labelsRemaining === 0 && !s.paused && !s.headOpen) return;
			if (Date.now() - lastLog > 10_000) {
				console.log(`   … ${label}: buffered=${s.formatsBuffered} remaining=${s.labelsRemaining}${s.paused ? ' PAUSED' : ''}${s.headOpen ? ' HEAD OPEN' : ''}`);
				lastLog = Date.now();
			}
		}
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error(`${label}: printer did not drain within ${maxMs / 60000} min; NOT confirming`);
}

// ── Run ──────────────────────────────────────────────────────────────────
await expireStaleReservations();
const partBefore = ((await PartDefinition.findOne({ partNumber: BARCODE_PART_NUMBER }).select('inventoryCount').lean()) as { inventoryCount?: number } | null)?.inventoryCount ?? 0;
console.log(`Run ${RUN_TAG}: ${TOTAL} labels in batches of ${BATCH} → ${printerName}; recorded as ${user.username}; PT-CT-106 before = ${partBefore}${DRY ? '  [DRY RUN]' : ''}`);

const cfg = { ...ZT230_2X_075_DEFAULTS };
const seen = new Set<string>();
const all: string[] = [];
const batches: Array<{ batchId: string; first: string; last: string; n: number; confirmed: boolean }> = [];
const outDir = resolve(process.env.LOCALAPPDATA ?? '.', 'BIMS', 'zebra-runs');
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, `${RUN_TAG}-${Date.now()}.txt`);

let remaining = TOTAL, idx = 0;
while (remaining > 0) {
	idx++;
	const n = Math.min(BATCH, remaining);
	const label = `batch ${idx} (${n})`;

	// 1. Mint + reserve (all BIMS checks happen inside).
	const r = await reserveBatch({ totalLabels: n, sheetsUsed: 0, labelsPerSheet: cfg.columns, printerName, templateVersion: ZEBRA_TEMPLATE_VERSION, ttlMs: TTL_MS });
	if (r.spotCheck.collisions.length) throw new Error(`${label}: spot-check collision ${r.spotCheck.collisions.join(',')}`);

	// 2. Extra guards: run-wide dupes, optical test cartridges, and a fresh
	//    exact re-check against cartridge_records for the whole batch.
	const dupInRun = r.barcodes.filter((b) => seen.has(b));
	if (dupInRun.length) throw new Error(`${label}: UUID repeated within this run: ${dupInRun.join(',')}`);
	const optical = await OpticalTestCartridge.find({ barcode: { $in: r.barcodes } }).select('barcode').lean();
	if (optical.length) throw new Error(`${label}: collides with optical_test_cartridges: ${optical.map((o: any) => o.barcode).join(',')}`);
	const carts = await CartridgeRecord.find({ _id: { $in: r.barcodes } }).select('_id').lean();
	if (carts.length) throw new Error(`${label}: collides with cartridge_records: ${carts.map((c: any) => c._id).join(',')}`);
	const uniq = new Set(r.barcodes);
	if (uniq.size !== r.barcodes.length) throw new Error(`${label}: within-batch duplicate`);

	// 3. Print.
	const job = buildCartridgeLabelsZpl(r.barcodes, cfg);
	console.log(`▶ ${label}: ${r.batchId} ${r.barcodes[0]} … ${r.barcodes[r.barcodes.length - 1]} — ${job.rows} rows, ${job.zpl.length} bytes ZPL`);
	if (!DRY) {
		await agentPost('/write', { device: printer, data: job.zpl });
		await waitDrained(label);
		// 4. Confirm (atomic claim + inventory + audit).
		const c = await confirmBatch({
			batchId: r.batchId, barcodes: r.barcodes, totalLabels: n, sheetsUsed: 0, medium: 'zebra-roll',
			templateVersion: ZEBRA_TEMPLATE_VERSION, printerName, user,
			auditExtra: { bulkRun: RUN_TAG, batchIndex: idx, calibration: JSON.stringify(cfg), source: 'scripts/zebra-bulk-print.mts' }
		});
		if (!c.ok) throw new Error(`${label}: confirm failed (${c.status}): ${c.error}`);
		console.log(`   ✓ confirmed; PT-CT-106 now ${c.labelsAfter}`);
	}
	r.barcodes.forEach((b) => { seen.add(b); all.push(b); });
	batches.push({ batchId: r.batchId, first: r.barcodes[0], last: r.barcodes[r.barcodes.length - 1], n, confirmed: !DRY });
	writeFileSync(outFile, `# ${RUN_TAG} — ${printerName} — as ${user.username}${DRY ? ' — DRY' : ''}\n` +
		batches.map((b) => `# batch ${b.batchId} n=${b.n} ${b.confirmed ? 'confirmed' : 'reserved-only'}`).join('\n') + '\n' + all.join('\n') + '\n');
	remaining -= n;
}

// ── Final audit over the whole run ───────────────────────────────────────
console.log('\nFinal audit:');
const setAll = new Set(all);
console.log(`  ${all.length} UUIDs printed, ${setAll.size} unique → ${setAll.size === all.length ? 'OK' : 'DUPLICATE!!'}`);
let cartHits = 0, batchOwners = 0, notInBatch = 0;
for (let i = 0; i < all.length; i += 500) {
	const chunk = all.slice(i, i + 500);
	cartHits += await CartridgeRecord.countDocuments({ _id: { $in: chunk } });
	const owners = await BarcodeSheetBatch.aggregate([{ $match: { barcodeIds: { $in: chunk } } }, { $unwind: '$barcodeIds' }, { $match: { barcodeIds: { $in: chunk } } }, { $group: { _id: '$barcodeIds', n: { $sum: 1 } } }]);
	batchOwners += owners.filter((o: any) => o.n > 1).length;
	notInBatch += chunk.length - owners.length;
}
console.log(`  in cartridge_records: ${cartHits} (must be 0) → ${cartHits === 0 ? 'OK' : 'FAIL'}`);
console.log(`  owned by >1 batch: ${batchOwners} (must be 0) → ${batchOwners === 0 ? 'OK' : 'FAIL'}`);
console.log(`  missing from batches: ${notInBatch} (must be 0) → ${notInBatch === 0 ? 'OK' : 'FAIL'}`);
const partAfter = ((await PartDefinition.findOne({ partNumber: BARCODE_PART_NUMBER }).select('inventoryCount').lean()) as { inventoryCount?: number } | null)?.inventoryCount ?? 0;
console.log(`  PT-CT-106: ${partBefore} → ${partAfter} (${DRY ? 'dry, unchanged' : `expected +${TOTAL}`})`);
console.log(`  batches: ${batches.map((b) => b.batchId).join(', ')}`);
console.log(`  list written to ${outFile}`);
process.exit(0);
