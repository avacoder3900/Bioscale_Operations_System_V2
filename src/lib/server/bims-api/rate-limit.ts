/**
 * BIMS API v1 — rate limits, per calling app and per holder.
 *
 * Fixed one-minute windows counted in a small collection
 * (`bims_api_rate_limits`), because BIMS runs as several serverless instances
 * and a per-instance counter would not limit anything. One atomic `$inc`
 * upsert per counter.
 *
 * Honest limits of this limiter:
 * - Fixed windows: a caller can spend one window's allowance at the end of a
 *   minute and the next at the start of the following one (2× burst).
 * - It fails open: if the counter cannot be written the request proceeds.
 * - Rows expire by a TTL index on `expiresAt`. BIMS creates indexes
 *   deliberately (`scripts/ensure-indexes.ts --apply`); until that has run,
 *   an occasional sweep here removes expired rows instead.
 *
 * Self-contained on purpose: the model is registered here rather than in
 * models/index.ts (same pattern as route-policy.ts).
 */
import mongoose from 'mongoose';
import { ApiError } from './http';
import type { AppName } from './rules';

export type Endpoint = 'check' | 'link' | 'unlink' | 'result';

export const WINDOW_MS = 60_000;

/** Requests per minute. `perHolder` applies only when the request names a holder. */
export const LIMITS: Record<Endpoint, { perHolder: number; perApp: number }> = {
	check: { perHolder: 60, perApp: 600 },
	link: { perHolder: 20, perApp: 200 },
	unlink: { perHolder: 20, perApp: 200 },
	result: { perHolder: 120, perApp: 1200 }
};

const schema = new mongoose.Schema(
	{
		_id: { type: String },
		count: { type: Number, default: 0 },
		expiresAt: { type: Date }
	},
	{ collection: 'bims_api_rate_limits', versionKey: false }
);
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RateLimit =
	(mongoose.models.BimsApiRateLimit as mongoose.Model<any>) ?? mongoose.model('BimsApiRateLimit', schema);

/** Counter store: add one to a window's counter and return the new count. Replaceable in tests. */
export type Counter = (key: string, expiresAt: Date) => Promise<number>;

const SWEEP_ODDS = 0.01;

const mongoCounter: Counter = async (key, expiresAt) => {
	const bump = () =>
		RateLimit.findOneAndUpdate(
			{ _id: key },
			{ $inc: { count: 1 }, $setOnInsert: { expiresAt } },
			{ upsert: true, returnDocument: 'after', lean: true }
		);
	let doc: any;
	try {
		doc = await bump();
	} catch (e: any) {
		// Two first requests of a window raced the upsert; the second attempt updates.
		if (e?.code !== 11000) throw e;
		doc = await bump();
	}
	if (Math.random() < SWEEP_ODDS) {
		void RateLimit.deleteMany({ expiresAt: { $lt: new Date() } }).catch(() => {});
	}
	return doc?.count ?? 1;
};

/**
 * Count this request against the app's limit and, when a holder is named,
 * against the holder's. Throws a 429 with `Retry-After` (seconds to the next
 * window) when either is spent.
 */
export async function enforceRateLimit(
	endpoint: Endpoint,
	app: AppName,
	holderRef: string | null,
	opts: { now?: Date; counter?: Counter } = {}
): Promise<void> {
	const now = (opts.now ?? new Date()).getTime();
	const counter = opts.counter ?? mongoCounter;
	const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
	const windowEnd = windowStart + WINDOW_MS;
	// Kept one extra window so a late write never recreates an expired row.
	const expiresAt = new Date(windowEnd + WINDOW_MS);
	const limit = LIMITS[endpoint];

	const subjects: [string, number][] = [[`app:${app}`, limit.perApp]];
	if (holderRef) subjects.push([`holder:${holderRef}`, limit.perHolder]);

	for (const [subject, max] of subjects) {
		let count: number;
		try {
			count = await counter(`${endpoint}|${subject}|${windowStart}`, expiresAt);
		} catch (e) {
			console.error(`[bims-api] rate limit counter unavailable: ${e instanceof Error ? e.name : 'unknown error'}`);
			continue;
		}
		if (count > max) {
			const retryAfter = Math.max(1, Math.ceil((windowEnd - now) / 1000));
			throw new ApiError(429, 'Too many requests', { 'retry-after': String(retryAfter) });
		}
	}
}
