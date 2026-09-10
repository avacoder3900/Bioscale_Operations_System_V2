/**
 * Fleet-wide service-flag control (SPU-INV-08 yellow LED / v92 hard enforcement).
 *
 * Why this exists (2026-09-10): firmware v92 rejects every UUID-barcode cartridge
 * while service_flag = 1, and it cannot tell an optical validation cart from a
 * customer cart (see brevitest-device/firmware/Docs/SERVICE_MODE_OPTICAL_GAP_HANDOFF.md).
 * Until v93 gates on the assay instead, the optical confirmation batch can only
 * run with the flag temporarily cleared.
 *
 *   npx tsx scripts/service-flag-fleet.ts            # report: what each active unit holds
 *   npx tsx scripts/service-flag-fleet.ts --clear    # set_service 0 on every active unit
 *   npx tsx scripts/service-flag-fleet.ts --rearm    # set_service 1 on every active NON-released unit
 *
 * Every write is read back (service_flag variable) and recorded on
 * particleLink.serviceFlag* exactly as src/lib/server/service-flag.ts does, plus
 * one audit_log row per unit.
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();

const MODE = process.argv.includes('--clear') ? 'clear' : process.argv.includes('--rearm') ? 'rearm' : 'report';
const API = 'https://api.particle.io/v1';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const integ: any = await db.collection('integrations').findOne({ type: 'particle' });
	if (!integ?.accessToken) throw new Error('Particle integration not configured');
	const H = { Authorization: `Bearer ${integ.accessToken}`, 'Content-Type': 'application/json' };

	const spus = await db
		.collection('spus')
		.find({ status: { $ne: 'retired' }, 'particleLink.particleDeviceId': { $exists: true, $nin: [null, ''] } })
		.project({ udi: 1, status: 1, 'particleLink.particleDeviceId': 1 })
		.sort({ udi: 1 })
		.toArray();

	console.log(`${MODE.toUpperCase()} — ${spus.length} active Particle-linked SPU(s)`);
	const now = new Date();
	const tally: Record<string, number> = {};

	for (const s of spus) {
		const id = s.particleLink.particleDeviceId as string;
		const want: '0' | '1' | null =
			MODE === 'clear' ? '0' : MODE === 'rearm' ? (s.status === 'released' ? '0' : '1') : null;
		let outcome = '';
		try {
			if (want !== null) {
				const r = await fetch(`${API}/devices/${id}/set_service`, {
					method: 'POST', headers: H, body: JSON.stringify({ arg: want }), signal: AbortSignal.timeout(15000)
				});
				const body: any = await r.json().catch(() => ({}));
				if (!r.ok) throw new Error(body.error_description || body.error || `HTTP ${r.status}`);
			}
			const v = await fetch(`${API}/devices/${id}/service_flag`, { headers: H, signal: AbortSignal.timeout(15000) });
			const vb: any = await v.json().catch(() => ({}));
			if (!v.ok) throw new Error(vb.error_description || vb.error || `HTTP ${v.status}`);
			const flag = Number(vb.result);
			outcome = `flag=${flag}`;
			if (want !== null) {
				await db.collection('spus').updateOne(
					{ _id: s._id },
					{ $set: { 'particleLink.serviceFlag': flag, 'particleLink.serviceFlagState': 'synced', 'particleLink.serviceFlagSyncedAt': now, 'particleLink.serviceFlagError': null } }
				);
				await db.collection('audit_log').insertOne({
					_id: nanoid(), tableName: 'spus', recordId: s._id, action: 'UPDATE',
					oldData: null, newData: { serviceFlag: flag },
					changedBy: 'script:service-flag-fleet (jacob)', changedAt: now,
					reason: MODE === 'clear'
						? 'Service flag cleared fleet-wide for the optical confirmation run (v92 rejects UUID carts while set)'
						: 'Service flag re-armed after the optical confirmation run'
				});
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			outcome = /not found/i.test(msg) ? 'unsupported (fw<88)' : /timed out|timeout|offline|not connected|abort/i.test(msg) ? 'offline' : `error: ${msg}`;
			if (want !== null) {
				await db.collection('spus').updateOne(
					{ _id: s._id },
					{ $set: { 'particleLink.serviceFlagState': outcome.startsWith('error') ? 'error' : outcome.split(' ')[0], 'particleLink.serviceFlagSyncedAt': now, 'particleLink.serviceFlagError': outcome.startsWith('error') ? msg : null } }
				);
			}
		}
		tally[outcome] = (tally[outcome] ?? 0) + 1;
		console.log(`  ${s.udi}  ${String(s.status).padEnd(10)}  ${outcome}`);
	}
	console.log('\nSummary:', JSON.stringify(tally));
	await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
