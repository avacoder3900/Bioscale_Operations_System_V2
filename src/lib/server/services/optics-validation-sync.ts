import { CartridgeRecord, Spu, AuditLog, generateId } from '$lib/server/db';
import { analyzeCartridge } from '$lib/server/optical-analysis';
import { OPTICAL_CARTRIDGE_FILTER } from '$lib/server/optical-constants';

/**
 * Optics → SPU validation write-back.
 *
 * Optical-confirmation runs land in cartridge_records (written by
 * brevitest-cloud; sacred — never written here) with the RUNNING SPU recorded
 * as device.name (= the SPU UDI). Nothing previously mirrored that into the
 * SPU's validation block, so SPUs showed spectrophotometer 'pending' despite
 * completed optics runs (observed on SPU 212 with 15 runs).
 *
 * This sync derives the optics outcome per SPU from its LATEST analyzable run
 * (derive-on-read analyzeCartridge — F7/F3 ratios; warning=false → passed,
 * warning=true → failed) and writes it to validation.spectrophotometer.
 * Finalized SPUs are skipped (sacred). Idempotent: unchanged outcomes are
 * left untouched. Every change is audit-logged.
 */

export interface OpticsSyncResult {
	updated: { udi: string; status: string; cartridgeBarcode: string }[];
	unchanged: string[];
	skippedFinalized: string[];
	skippedNoSpu: string[];
	skippedNoReadings: string[];
}

export async function syncOpticsValidation(opts?: { spuUdi?: string }): Promise<OpticsSyncResult> {
	const result: OpticsSyncResult = {
		updated: [],
		unchanged: [],
		skippedFinalized: [],
		skippedNoSpu: [],
		skippedNoReadings: []
	};

	const match: Record<string, unknown> = {
		...OPTICAL_CARTRIDGE_FILTER,
		'device.name': opts?.spuUdi ?? { $regex: /^BT-/ }
	};

	// Newest-first per device: the first analyzable run per SPU wins.
	const carts = (await CartridgeRecord.find(match)
		.select('serialNumber createdAt device rawData')
		.sort({ createdAt: -1 })
		.lean()) as any[];

	const byUdi = new Map<string, any[]>();
	for (const c of carts) {
		const udi = c.device?.name;
		if (!udi) continue;
		if (!byUdi.has(udi)) byUdi.set(udi, []);
		byUdi.get(udi)!.push(c);
	}

	for (const [udi, runs] of byUdi) {
		const latest = runs.find(
			(c) => Array.isArray(c.rawData?.readings) && c.rawData.readings.length > 0
		);
		if (!latest) {
			result.skippedNoReadings.push(udi);
			continue;
		}
		const analysis = analyzeCartridge(latest.rawData.readings);
		if (!analysis) {
			result.skippedNoReadings.push(udi);
			continue;
		}

		const spu = (await Spu.findOne({ udi })
			.select('_id udi finalizedAt validation.spectrophotometer.status validation.spectrophotometer.sessionId')
			.lean()) as any;
		if (!spu) {
			result.skippedNoSpu.push(udi);
			continue;
		}
		if (spu.finalizedAt) {
			result.skippedFinalized.push(udi);
			continue;
		}

		const status = analysis.warning ? 'failed' : 'passed';
		const existing = spu.validation?.spectrophotometer;
		if (existing?.status === status && existing?.sessionId === latest._id) {
			result.unchanged.push(udi);
			continue;
		}

		await Spu.updateOne(
			{ _id: spu._id },
			{
				$set: {
					'validation.spectrophotometer': {
						status,
						// sessionId carries the cartridge barcode — optics has no
						// validation_sessions doc; the cartridge IS the run record.
						sessionId: latest._id,
						completedAt: latest.createdAt ?? new Date(),
						results: {
							source: 'optical_confirmation',
							cartridgeBarcode: latest._id,
							serialNumber: latest.serialNumber ?? null,
							ratioByChannel: analysis.ratioByChannel,
							crossWellCv: analysis.crossWellCv,
							runCount: runs.length
						},
						failureReasons: analysis.warning ? analysis.reasons : [],
						criteriaUsed: {
							source: 'optical-analysis',
							profileName: analysis.profileName,
							windowK: analysis.windowK
						}
					}
				}
			}
		);
		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: spu._id,
			action: 'UPDATE',
			newData: { 'validation.spectrophotometer': { status, sessionId: latest._id } },
			changedAt: new Date(),
			changedBy: 'optics-validation-sync',
			reason: `Optics write-back: latest optical run ${latest.serialNumber ?? latest._id} → ${status}`
		});
		result.updated.push({ udi, status, cartridgeBarcode: latest._id });
	}

	return result;
}
