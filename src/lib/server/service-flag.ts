/**
 * Service-flag yellow LED sync (SPU-INV-08, firmware v88 handoff).
 *
 * The device holds one EEPROM-backed bit, `service_flag`; while it is 1 the
 * LED pulses yellow every 5 s so a bench unit that isn't cleared for use is
 * obvious. BIMS owns the policy: 0 when the SPU is released, 1 otherwise.
 * Spec: brevitest-device/firmware/Docs/SERVICE_FLAG_LED_HANDOFF.md
 */
import { callFunction, getVariable } from '$lib/server/particle';
import { connectDB, Spu } from '$lib/server/db';

// Post-SPU-INV-07 vocabulary: only 'released' means cleared for use.
// A retired unit that gets powered on SHOULD blink — deliberate.
const RELEASED_STATUSES = ['released'];

export function desiredServiceFlag(status: string): '0' | '1' {
	return RELEASED_STATUSES.includes(status) ? '0' : '1';
}

export type ServiceFlagResult =
	| { state: 'synced'; value: 0 | 1 }
	| { state: 'unlinked' }
	| { state: 'unsupported' } // firmware < 88 — set_service returns 404
	| { state: 'offline' } // device did not answer
	| { state: 'error'; message: string };

/**
 * Push the desired flag for one SPU to its device and record the outcome on
 * particleLink.serviceFlag*. Never throws and never blocks the caller's
 * status write — device sync is strictly best-effort.
 */
export async function syncServiceFlag(spuId: string): Promise<ServiceFlagResult> {
	try {
		await connectDB();
		const spu = (await Spu.findById(spuId).select('status particleLink').lean()) as any;
		if (!spu) return { state: 'error', message: 'SPU not found' };
		const deviceId = spu.particleLink?.particleDeviceId;
		if (!deviceId) return record(spuId, { state: 'unlinked' });

		const want = desiredServiceFlag(spu.status ?? 'draft');
		try {
			const { return_value } = await callFunction(deviceId, 'set_service', want);
			if (return_value !== Number(want)) {
				return record(spuId, { state: 'error', message: `device returned ${return_value}` });
			}
			// Read-back confirmation.
			const v = await getVariable(deviceId, 'service_flag');
			return record(spuId, { state: 'synced', value: (v?.result ?? Number(want)) as 0 | 1 });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (/not found/i.test(msg)) return record(spuId, { state: 'unsupported' });
			if (/timed out|timeout|offline|not connected|abort/i.test(msg)) {
				return record(spuId, { state: 'offline' });
			}
			return record(spuId, { state: 'error', message: msg });
		}
	} catch (err) {
		return { state: 'error', message: err instanceof Error ? err.message : String(err) };
	}
}

async function record(spuId: string, r: ServiceFlagResult): Promise<ServiceFlagResult> {
	try {
		await Spu.updateOne(
			{ _id: spuId },
			{
				$set: {
					'particleLink.serviceFlag': r.state === 'synced' ? r.value : null,
					'particleLink.serviceFlagState': r.state,
					'particleLink.serviceFlagSyncedAt': new Date(),
					'particleLink.serviceFlagError': r.state === 'error' ? r.message : null
				}
			}
		);
	} catch {
		// Recording the outcome is itself best-effort.
	}
	return r;
}
