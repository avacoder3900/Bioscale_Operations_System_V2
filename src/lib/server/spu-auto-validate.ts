/**
 * Auto-enter validation (SPU-INV-12): recording ANY validation test result
 * (magnetometer, thermocouple, optics) flips the unit to 'validating' — the
 * evidence state follows the evidence, no manual status bookkeeping.
 *
 * Flips from draft / assembling / servicing (Jacob explicitly wants a test
 * during servicing to pull the unit into validation). Released units are
 * never demoted by a spot-check, and retired units are left alone.
 *
 * Best-effort: never throws, never blocks the test write that triggered it.
 */
import { connectDB, Spu, AuditLog, generateId } from '$lib/server/db';

const AUTO_FLIP_FROM = ['draft', 'assembling', 'servicing'];

export async function autoEnterValidating(
	spuId: string,
	instrument: 'magnetometer' | 'thermocouple' | 'optics',
	actor?: { _id?: string; username?: string }
): Promise<{ flipped: boolean; from?: string }> {
	try {
		await connectDB();
		const spu = (await Spu.findById(spuId).select('status finalizedAt').lean()) as any;
		if (!spu || spu.finalizedAt) return { flipped: false };
		const from = spu.status ?? 'draft';
		if (!AUTO_FLIP_FROM.includes(from)) return { flipped: false };

		const who = { _id: actor?._id ?? 'system:auto-validate', username: actor?.username ?? 'auto-validate' };
		const reason = `${instrument} test recorded — auto-entered validation`;
		await Spu.updateOne(
			{ _id: spuId, status: from },
			{
				$set: { status: 'validating' },
				$push: {
					statusTransitions: {
						_id: generateId(),
						from,
						to: 'validating',
						changedBy: who,
						changedAt: new Date(),
						reason
					}
				}
			}
		);
		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: spuId,
			action: 'UPDATE',
			oldData: { status: from },
			newData: { status: 'validating' },
			reason,
			changedBy: who.username,
			changedAt: new Date()
		});
		return { flipped: true, from };
	} catch {
		return { flipped: false };
	}
}
