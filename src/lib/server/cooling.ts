/**
 * Wax cartridge cooling / tray-release utilities.
 *
 * Wax-filled cartridges cool on a limited number of cooling trays. Once a batch
 * has cooled (default 30 min — see `coolingRequiredMin`), the cartridges can be
 * removed from the tray into loose storage (a fridge/bucket that needs no tray),
 * which frees the tray for the next run. Both the manual "remove from tray"
 * action and the auto-timer cron call `releaseTrayForRun`.
 */
import {
	CartridgeRecord, Consumable, WaxFillingRun, AuditLog, generateId
} from '$lib/server/db';

/** Default minutes a batch must cool on the tray before it can be removed. */
export const DEFAULT_COOLING_REQUIRED_MIN = 30;

/** Location value stamped on cartridges once they leave the tray for loose storage. */
export const LOOSE_STORAGE_LOCATION = 'Loose Storage (fridge)';

/** Cartridge phases that are still on a cooling tray and eligible to be released. */
const RELEASABLE_PHASES = ['wax_filled', 'wax_stored'];

type OperatorRef = { _id: string; username: string };

/**
 * Compute cooling progress for a run from its `coolingConfirmedTime`.
 * `nowMs` is injectable so callers can avoid `Date.now()` where it's unavailable.
 */
export function coolingStatus(
	coolingConfirmedTime: Date | string | null | undefined,
	requiredMin: number,
	nowMs: number
) {
	const startMs = coolingConfirmedTime ? new Date(coolingConfirmedTime).getTime() : null;
	const readyAtMs = startMs != null ? startMs + requiredMin * 60_000 : null;
	const elapsedMin = startMs != null ? (nowMs - startMs) / 60_000 : null;
	return {
		startMs,
		readyAtMs,
		elapsedMin,
		ready: readyAtMs != null && nowMs >= readyAtMs
	};
}

/**
 * Move a run's still-on-tray cartridges into loose storage and free its cooling tray.
 *
 * Idempotent-ish: if the run has no `coolingTrayId` and no releasable cartridges,
 * it returns `{ cartridgesMoved: 0 }` and writes no audit entry.
 */
export async function releaseTrayForRun(
	run: { _id: string; coolingTrayId?: string | null },
	opts: { operator: OperatorRef; changedBy: string; reason?: string; nowMs?: number }
): Promise<{ trayId: string | null; cartridgesMoved: number }> {
	const now = opts.nowMs != null ? new Date(opts.nowMs) : new Date();
	const runId = String(run._id);
	const trayId = run.coolingTrayId ?? null;

	// 1) Cartridges → loose storage, drop the tray link.
	const res = await CartridgeRecord.updateMany(
		{ 'waxFilling.runId': runId, currentPhase: { $in: RELEASABLE_PHASES } },
		{
			$set: {
				'waxStorage.location': LOOSE_STORAGE_LOCATION,
				'waxStorage.operator': opts.operator,
				'waxStorage.timestamp': now,
				'waxStorage.recordedAt': now,
				currentPhase: 'wax_stored'
			},
			$unset: { 'waxStorage.coolingTrayId': '' }
		}
	);
	const cartridgesMoved = res.modifiedCount ?? 0;

	// Nothing to do — tray already free and no cartridges on it.
	if (!trayId && cartridgesMoved === 0) {
		return { trayId: null, cartridgesMoved: 0 };
	}

	// 2) Free the cooling-tray consumable so the next run can claim it.
	if (trayId) {
		await Consumable.updateOne(
			{ _id: trayId, type: 'cooling_tray' },
			{
				$set: { status: 'active', lastUsedAt: now },
				$unset: { assignedRunId: '', currentCartridges: '' },
				$push: {
					usageLog: {
						_id: generateId(),
						usageType: 'tray_released',
						runId,
						quantityChanged: cartridgesMoved,
						operator: opts.operator,
						notes: `Tray released after cooling — ${cartridgesMoved} cartridge(s) moved to loose storage`,
						createdAt: now
					}
				}
			}
		);
	}

	// 3) Drop the tray link on the run.
	await WaxFillingRun.updateOne({ _id: runId }, { $unset: { coolingTrayId: '' } });

	// 4) Audit trail.
	await AuditLog.create({
		_id: generateId(),
		tableName: 'wax_filling_runs',
		recordId: runId,
		action: 'UPDATE',
		newData: {
			event: 'tray_released',
			trayId,
			cartridgesMoved,
			location: LOOSE_STORAGE_LOCATION
		},
		changedAt: now,
		changedBy: opts.changedBy,
		reason: opts.reason
	});

	return { trayId, cartridgesMoved };
}
