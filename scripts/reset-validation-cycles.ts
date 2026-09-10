/**
 * One-time fleet correction (Jacob, 2026-09-10): validation cycles.
 *
 * Rule: a unit's validation counter goes to 0/3 when it ENTERS servicing and
 * every instrument must pass again (see src/lib/server/spu-validation-cycle.ts).
 * Until today nothing stamped that reset from the servicing board, so the
 * rollups on the unit records mixed pre-service passes with this week's runs.
 *
 * For every non-retired SPU this script:
 *   1. moves it to `validating` if it sits at released/servicing (the fleet
 *      is mid-revalidation; statuses drifted while the flows were changing);
 *   2. sets validationResetAt = when it last entered servicing (or keeps an
 *      existing later reset); units that never entered servicing keep all
 *      their history;
 *   3. recomputes the three rollups from evidence recorded on/after that
 *      moment — latest magnetometer session, latest JUDGED thermocouple
 *      session, latest analyzable optical run — exactly as the live writers
 *      would have, and clears an instrument to pending when there is none;
 *   4. audit-logs every unit it touches and, for units leaving `released`,
 *      pushes the yellow-LED service flag back on (best-effort).
 *
 *   npx tsx scripts/reset-validation-cycles.ts            # dry run
 *   npx tsx scripts/reset-validation-cycles.ts --apply    # write
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
import { analyzeCartridge } from '../src/lib/server/optical-analysis.js';
dotenv.config();

const APPLY = process.argv.includes('--apply');
const OPTICAL_ASSAY_ID = 'A9EB41AD';
const ACTOR = 'script:reset-validation-cycles (jacob)';

type Rollup = Record<string, unknown> & { status: string };
const PENDING: Rollup = { status: 'pending' };
const passed = (s: string) => s === 'passed' || s === 'overridden';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const spus = db.collection('spus');
	const sessions = db.collection('validation_sessions');
	const carts = db.collection('cartridge_records');

	const fleet = await spus
		.find({ status: { $ne: 'retired' } })
		.project({ udi: 1, status: 1, validation: 1, validationResetAt: 1, statusTransitions: 1, particleLink: 1, finalizedAt: 1 })
		.sort({ udi: 1 })
		.toArray();

	console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${fleet.length} active SPU(s)\n`);
	const now = new Date();
	const ledResync: { udi: string; deviceId: string }[] = [];
	let touched = 0;

	for (const s of fleet) {
		if (s.finalizedAt) {
			console.log(`${s.udi}  finalized — skipped`);
			continue;
		}
		const entries = (s.statusTransitions ?? [])
			.filter((t: any) => t.to === 'servicing' && t.changedAt)
			.map((t: any) => new Date(t.changedAt).getTime());
		const existingReset = s.validationResetAt ? new Date(s.validationResetAt).getTime() : null;
		const startMs = Math.max(...entries, existingReset ?? -Infinity);
		const cycleStart = Number.isFinite(startMs) ? new Date(startMs) : null;
		const since = cycleStart ?? new Date(0);

		const [mag, thermo, optics] = await Promise.all([
			sessions
				.find({ spuId: s._id, type: { $in: ['mag', 'magnetometer'] }, startedAt: { $gte: since } })
				.sort({ startedAt: -1 })
				.limit(1)
				.next(),
			sessions
				.find({
					spuId: s._id,
					type: 'thermo',
					startedAt: { $gte: since },
					results: { $elemMatch: { testType: 'thermocouple', passed: { $in: [true, false] } } }
				})
				// Latest VERDICT wins (completedAt is when the operator judged it) —
				// the same "last verdict written" semantics as recordThermoVerdict.
				.sort({ completedAt: -1, startedAt: -1 })
				.limit(1)
				.next(),
			carts
				.find({
					$or: [{ assayCategory: 'optical_test' }, { assayId: OPTICAL_ASSAY_ID }],
					'device.name': s.udi,
					createdAt: { $gte: since },
					'rawData.readings.0': { $exists: true }
				})
				.sort({ createdAt: -1 })
				.limit(1)
				.next()
		]);

		// --- rollups, in the exact shapes the live writers produce ---
		const magRollup: Rollup = mag
			? {
					status: mag.overallPassed ? 'passed' : 'failed',
					sessionId: mag._id,
					completedAt: mag.completedAt ?? mag.startedAt,
					testRanAt: mag.testRanAt ?? null,
					rawData: mag.rawData ?? null,
					results: mag.magResults ?? null,
					failureReasons: mag.overallPassed ? [] : (mag.failureReasons ?? []),
					criteriaUsed: mag.criteriaUsed ?? null
				}
			: PENDING;

		let thermoRollup: Rollup = PENDING;
		if (thermo) {
			const r = (thermo.results ?? []).find((x: any) => x.testType === 'thermocouple');
			const ok = r?.passed === true;
			const stats = r?.processedData?.stats ?? null;
			thermoRollup = {
				status: ok ? 'passed' : 'failed',
				sessionId: thermo._id,
				completedAt: thermo.completedAt ?? thermo.startedAt,
				failureReasons: ok ? [] : (thermo.failureReasons ?? ['Failed on operator review']),
				rawData: { readingCount: stats?.readingCount ?? r?.rawData?.readings?.length ?? 0, fileName: thermo.fileName ?? null },
				results: stats
			};
		}

		let opticsRollup: Rollup = PENDING;
		if (optics) {
			const analysis = analyzeCartridge(optics.rawData.readings);
			if (analysis) {
				opticsRollup = {
					status: analysis.warning ? 'failed' : 'passed',
					sessionId: optics._id,
					completedAt: optics.createdAt,
					results: {
						source: 'optical_confirmation',
						cartridgeBarcode: optics._id,
						serialNumber: optics.serialNumber ?? null,
						ratioByChannel: analysis.ratioByChannel,
						crossWellCv: analysis.crossWellCv,
						runCount: await carts.countDocuments({
							$or: [{ assayCategory: 'optical_test' }, { assayId: OPTICAL_ASSAY_ID }],
							'device.name': s.udi,
							createdAt: { $gte: since }
						})
					},
					failureReasons: analysis.warning ? analysis.reasons : [],
					criteriaUsed: { source: 'optical-analysis', profileName: analysis.profileName, windowK: analysis.windowK }
				};
			}
		}

		const statuses = [magRollup.status, thermoRollup.status, opticsRollup.status];
		const overall = statuses.every(passed) ? 'passed' : statuses.some((x) => x === 'failed') ? 'failed' : 'pending';
		const newStatus = s.status === 'released' || s.status === 'servicing' ? 'validating' : s.status;

		const before = {
			status: s.status,
			mag: s.validation?.magnetometer?.status ?? 'pending',
			thermo: s.validation?.thermocouple?.status ?? 'pending',
			optics: s.validation?.spectrophotometer?.status ?? 'pending',
			resetAt: s.validationResetAt ?? null
		};
		const after = {
			status: newStatus,
			mag: magRollup.status,
			thermo: thermoRollup.status,
			optics: opticsRollup.status,
			resetAt: cycleStart
		};
		const changed = JSON.stringify(before) !== JSON.stringify(after);
		const fmt = (d: any) => (d ? new Date(d).toISOString().slice(0, 16) : '—');
		console.log(
			`${s.udi}  ${before.status}→${after.status}  cycle since ${fmt(cycleStart)}` +
				`  mag ${before.mag}→${after.mag}  thermo ${before.thermo}→${after.thermo}  optics ${before.optics}→${after.optics}` +
				`  = ${statuses.filter(passed).length}/3${changed ? '' : '  (no change)'}`
		);
		if (!changed || !APPLY) continue;

		const $set: Record<string, unknown> = {
			'validation.magnetometer': magRollup,
			'validation.thermocouple': thermoRollup,
			'validation.spectrophotometer': opticsRollup,
			'validation.status': overall,
			updatedAt: now
		};
		if (cycleStart) $set.validationResetAt = cycleStart;
		const update: Record<string, unknown> = { $set };
		if (newStatus !== s.status) {
			$set.status = newStatus;
			update.$push = {
				statusTransitions: {
					_id: nanoid(),
					from: s.status,
					to: newStatus,
					changedBy: { _id: 'script', username: ACTOR },
					changedAt: now,
					reason: 'Fleet reset to validating — validation cycle recomputed (Jacob, 2026-09-10)'
				}
			};
			if (s.status === 'released' && s.particleLink?.particleDeviceId) {
				ledResync.push({ udi: s.udi, deviceId: s.particleLink.particleDeviceId });
			}
		}
		await spus.updateOne({ _id: s._id }, update);
		await db.collection('audit_log').insertOne({
			_id: nanoid(),
			tableName: 'spus',
			recordId: s._id,
			action: 'UPDATE',
			oldData: before,
			newData: after,
			changedBy: ACTOR,
			changedAt: now,
			reason: 'Validation cycle recomputed: only evidence since the unit last entered servicing counts'
		});
		touched += 1;
	}

	console.log(`\n${APPLY ? `Updated ${touched} SPU(s).` : 'Re-run with --apply to write.'}`);

	// Yellow-LED service flag back on for units that left `released` (SPU-INV-08).
	if (APPLY && ledResync.length) {
		const integ = await db.collection('integrations').findOne({ type: 'particle' });
		const token = integ?.accessToken;
		for (const d of ledResync) {
			if (!token) {
				console.log(`  LED ${d.udi}: no Particle token — use "Resync Light" on the detail page`);
				continue;
			}
			try {
				const res = await fetch(`https://api.particle.io/v1/devices/${d.deviceId}/set_service`, {
					method: 'POST',
					headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
					body: JSON.stringify({ arg: '1' }),
					signal: AbortSignal.timeout(15000)
				});
				const body: any = await res.json().catch(() => ({}));
				console.log(`  LED ${d.udi}: ${res.ok ? `set_service → ${body.return_value}` : body.error ?? res.statusText}`);
			} catch (err) {
				console.log(`  LED ${d.udi}: ${err instanceof Error ? err.message : String(err)} — use "Resync Light" on the detail page`);
			}
		}
	}

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
