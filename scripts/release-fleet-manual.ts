/**
 * Manual fleet release (Jacob, 2026-09-10).
 *
 * Releases every active (non-retired) SPU at `validating` EXCEPT the units listed
 * in HOLD, bypassing the hub's 3/3 gate on Jacob's explicit approval — the optical
 * release logic is being reworked and is not the authority yet. Each unit gets:
 *   - status validating → released with a statusTransitions entry,
 *   - an audit_log row,
 *   - a journal note recording the manual approval and the validation state at
 *     the moment of release,
 *   - the yellow-LED service flag cleared on the device (set_service 0),
 *     recorded on particleLink.serviceFlag* (best-effort, like service-flag.ts).
 *
 *   npx tsx scripts/release-fleet-manual.ts            # dry run
 *   npx tsx scripts/release-fleet-manual.ts --apply
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();

const APPLY = process.argv.includes('--apply');
const HOLD = ['0217', '0218', '0229', '0239', '0245', '0249', '0250', '0252', '0255', '0256'];
const API = 'https://api.particle.io/v1';

const NOTE =
	'Released — manually approved by Jacob on 2026-09-10, prior to the optical release software being fully figured out.';

const isPassed = (s?: string) => s === 'passed' || s === 'overridden';
function cycle(spu: any): { passed: number; parts: string } {
	const reset = spu.validationResetAt ? new Date(spu.validationResetAt).getTime() : null;
	const st = (r: any) => {
		const s = r?.status ?? 'pending';
		if (!isPassed(s)) return s;
		if (reset != null && (!r?.completedAt || new Date(r.completedAt).getTime() < reset)) return 'pending';
		return s;
	};
	const v = spu.validation ?? {};
	const parts = { mag: st(v.magnetometer), thermo: st(v.thermocouple), optics: st(v.spectrophotometer) };
	return {
		passed: Object.values(parts).filter(isPassed).length,
		parts: `mag ${parts.mag} / thermo ${parts.thermo} / optics ${parts.optics}`
	};
}

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const spus = db.collection('spus');
	const jacob: any = await db.collection('users').findOne({ username: 'jacob' }, { projection: { _id: 1, username: 1 } });
	if (!jacob) throw new Error('user jacob not found');
	const who = { _id: String(jacob._id), username: jacob.username };
	const integ: any = await db.collection('integrations').findOne({ type: 'particle' });
	const H = integ?.accessToken ? { Authorization: `Bearer ${integ.accessToken}`, 'Content-Type': 'application/json' } : null;

	const fleet = await spus
		.find({ status: { $ne: 'retired' } })
		.project({ udi: 1, status: 1, finalizedAt: 1, validation: 1, validationResetAt: 1, 'particleLink.particleDeviceId': 1 })
		.sort({ udi: 1 })
		.toArray();

	const targets = fleet.filter((s) => !HOLD.includes(s.udi.slice(-4)));
	const held = fleet.filter((s) => HOLD.includes(s.udi.slice(-4)));
	console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${fleet.length} active; releasing ${targets.length}; holding ${held.length} (${held.map((s) => s.udi.slice(-4)).join(' ')})\n`);

	const now = new Date();
	let released = 0;
	for (const s of targets) {
		const c = cycle(s);
		const tag = `${s.udi}  ${String(s.status).padEnd(10)}  ${c.passed}/3  ${c.parts}`;
		if (s.finalizedAt) { console.log(`${tag}  → skipped (finalized)`); continue; }
		if (s.status === 'released') { console.log(`${tag}  → already released`); continue; }
		if (s.status !== 'validating') { console.log(`${tag}  → skipped (not validating)`); continue; }
		console.log(`${tag}  → RELEASE`);
		if (!APPLY) continue;

		const reason = `${NOTE} Validation at release: ${c.passed}/3 (${c.parts}).`;
		await spus.updateOne(
			{ _id: s._id, status: 'validating' },
			{
				$set: { status: 'released', updatedAt: now },
				$push: {
					statusTransitions: { _id: nanoid(), from: 'validating', to: 'released', changedBy: who, changedAt: now, reason: NOTE },
					journal: { _id: nanoid(), text: reason, source: 'release', createdBy: who, createdAt: now }
				}
			}
		);
		await db.collection('audit_log').insertOne({
			_id: nanoid(), tableName: 'spus', recordId: s._id, action: 'UPDATE',
			oldData: { status: 'validating' }, newData: { status: 'released', validationAtRelease: c.parts },
			changedBy: who.username, changedAt: now, reason
		});
		released += 1;

		// Yellow LED off (released = cleared for use), best-effort.
		const deviceId = s.particleLink?.particleDeviceId;
		if (deviceId && H) {
			try {
				const r = await fetch(`${API}/devices/${deviceId}/set_service`, { method: 'POST', headers: H, body: JSON.stringify({ arg: '0' }), signal: AbortSignal.timeout(15000) });
				const body: any = await r.json().catch(() => ({}));
				const ok = r.ok && body.return_value === 0;
				await spus.updateOne({ _id: s._id }, { $set: { 'particleLink.serviceFlag': ok ? 0 : null, 'particleLink.serviceFlagState': ok ? 'synced' : 'error', 'particleLink.serviceFlagSyncedAt': now, 'particleLink.serviceFlagError': ok ? null : (body.error ?? `HTTP ${r.status}`) } });
				console.log(`    LED: ${ok ? 'off' : `not confirmed (${body.error ?? r.status})`}`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const state = /timed out|timeout|offline|abort/i.test(msg) ? 'offline' : 'error';
				await spus.updateOne({ _id: s._id }, { $set: { 'particleLink.serviceFlagState': state, 'particleLink.serviceFlagSyncedAt': now, 'particleLink.serviceFlagError': state === 'error' ? msg : null } });
				console.log(`    LED: ${state} — Resync Light on the detail page later`);
			}
		}
	}
	console.log(`\n${APPLY ? `Released ${released} unit(s).` : 'Re-run with --apply to write.'}`);
	await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
