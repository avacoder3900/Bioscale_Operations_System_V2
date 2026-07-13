/**
 * QMS regulated-environment service.
 *
 * Single source of truth for whether the system is in CONFIGURATION (open setup)
 * or REGULATED (full GxP) mode. The state lives in the QmsState singleton; this
 * module wraps it with a short-TTL cache so the auth-adjacent hot path doesn't hit
 * Mongo on every request. See ADMIN-01 PRD.
 */
import { connectDB, QmsState } from '$lib/server/db';

export type QmsPhase = 'configuration' | 'regulated';

export interface QmsStateView {
	phase: QmsPhase;
	regulated: boolean;
	reauthWindowSec: number;
	activatedAt: Date | null;
	activatedBy: { _id: string; username: string } | null;
}

const CACHE_TTL_MS = 5000;
let cache: { value: QmsStateView; at: number } | null = null;

/** Read the singleton, creating the default (configuration) document on first call. */
export async function getQmsState(force = false): Promise<QmsStateView> {
	if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
		return cache.value;
	}
	await connectDB();
	let doc = await QmsState.findById('default').lean();
	if (!doc) {
		await QmsState.updateOne(
			{ _id: 'default' },
			{ $setOnInsert: { phase: 'configuration', reauthWindowSec: 300 } },
			{ upsert: true }
		);
		doc = await QmsState.findById('default').lean();
	}
	const d = doc as any;
	const value: QmsStateView = {
		phase: d.phase ?? 'configuration',
		regulated: d.phase === 'regulated',
		reauthWindowSec: d.reauthWindowSec ?? 300,
		activatedAt: d.activatedAt ?? null,
		activatedBy: d.activatedBy ?? null
	};
	cache = { value, at: Date.now() };
	return value;
}

/** Convenience boolean for guards/gates. */
export async function isRegulated(): Promise<boolean> {
	return (await getQmsState()).regulated;
}

/** Flip the master switch. Caller is responsible for permission + step-up + audit. */
export async function transitionQms(
	to: QmsPhase,
	actor: { _id: string; username: string },
	reason: string
): Promise<QmsStateView> {
	await connectDB();
	const current = await getQmsState(true);
	const now = new Date();

	const set: Record<string, unknown> = { phase: to };
	if (to === 'regulated') {
		set.activatedAt = now;
		set.activatedBy = actor;
		set.activationReason = reason;
	} else {
		set.deactivatedAt = now;
		set.deactivatedBy = actor;
		set.deactivationReason = reason;
	}

	await QmsState.updateOne(
		{ _id: 'default' },
		{
			$set: set,
			$push: { transitions: { from: current.phase, to, at: now, by: actor, reason } }
		},
		{ upsert: true }
	);

	cache = null;
	return getQmsState(true);
}
