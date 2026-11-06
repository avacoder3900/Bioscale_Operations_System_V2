/**
 * One mover at a time (2026-11-06).
 *
 * Return Home, the droop settle that runs after a play, and a Play / Go to
 * pose all move the arm from BIMS, and none of them is a run on the Pi for
 * the whole time it moves, so the Pi's busy check (getActive) cannot keep
 * them apart. At 16:28 UTC that day Return Home jogged the shoulder toward
 * home while the settle kept writing the pose's goal back: the shoulder swung
 * 300–480 steps every 1.2 s round, and the settle saved that as a +300 trim.
 *
 * Each mover claims this lease first; a second one is refused with "the arm
 * is busy (…)". The lease lives in Mongo (Vercel runs every request in its
 * own instance) and ends on its own at `until`, so a crashed request cannot
 * strand the arm. The same owner may claim again to renew it.
 */
import { connectDB } from './db/connection';
import { RobotArmMotion } from './db/models';

const LEASE_ID = 'arm';

export interface ArmMotionClaim {
	owner: string;
	label: string;
	username?: string | null;
	ttlMs: number;
}

export class ArmMotionBusy extends Error {
	constructor(readonly holder: { label: string; username: string | null }) {
		super(`the arm is busy (${holder.label}${holder.username ? `, ${holder.username}` : ''}) — wait for it to finish or stop it first`);
	}
}

function isDuplicateKey(err: unknown): boolean {
	return (err as { code?: number })?.code === 11000;
}

/** Take or renew the lease. Throws ArmMotionBusy while someone else holds it. */
export async function claimArmMotion(c: ArmMotionClaim): Promise<void> {
	await connectDB();
	const now = new Date();
	try {
		await RobotArmMotion.updateOne(
			{ _id: LEASE_ID, $or: [{ until: { $lte: now } }, { owner: c.owner }] },
			{ $set: { owner: c.owner, label: c.label, username: c.username ?? null, claimedAt: now, until: new Date(now.getTime() + c.ttlMs) } },
			{ upsert: true }
		);
	} catch (err) {
		// The row exists, is still live and is someone else's: the upsert's insert collides on _id.
		if (!isDuplicateKey(err)) throw err;
		const h = (await RobotArmMotion.findById(LEASE_ID).select('label username').lean()) as { label?: string; username?: string | null } | null;
		throw new ArmMotionBusy({ label: h?.label ?? 'another move', username: h?.username ?? null });
	}
}

/**
 * Give the lease up. `lingerMs` keeps it a moment longer, so the gap between
 * two requests of one operation (Return Home's attempts, its claw close) is
 * not a window for anything else to start.
 */
export async function releaseArmMotion(owner: string, lingerMs = 0): Promise<void> {
	try {
		await connectDB();
		await RobotArmMotion.updateOne({ _id: LEASE_ID, owner }, { $set: { until: new Date(Date.now() + lingerMs) } });
	} catch (err) {
		// Never fails the move it ends: the lease runs out by itself.
		console.error('[robot-arm-motion] release failed:', err);
	}
}
