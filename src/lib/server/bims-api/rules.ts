/**
 * BIMS API v1 — pure rules for checking, linking and unlinking a cartridge.
 * No database, SvelteKit or `$lib/server` import, so every rule is unit-testable
 * and the file can be lifted into a shared package unchanged.
 *
 * Ported from the customer apps' `cartridge-link-rules.ts` (the strictest
 * version: refuses unknown, used, run data, no assay, expired) plus the BIMS
 * claim rules (`consumer/ownership.ts`: voided, QC, research).
 *
 * `linked` is what the reader checks: the cloud refuses to start a cartridge
 * that is used, past its expiry, or in any other status. So a link must leave
 * the record `linked`, and nothing else about it changed.
 */

export const LINKED = 'linked';
export const HOLDER_REF = /^h_[A-Za-z0-9_-]{16,64}$/;

export type AppName = 'bioscale-app' | 'bioscale-business' | 'bioscale-store';

/** The fields of a cartridge record the rules read. Run data arrives as presence flags only. */
export type RuleRecord = {
	status?: string | null;
	priorStatus?: string | null;
	assayId?: string | null;
	/** Top-level expiry (string). Read only when `reagentFilling.expirationDate` is not set. */
	expirationDate?: string | Date | null;
	reagentFilling?: { expirationDate?: string | Date | null } | null;
	used?: boolean | null;
	voidedAt?: string | Date | null;
	usedForTestFill?: boolean | null;
	experiment?: string | null;
	checkpoints?: { linked?: { who?: unknown } | null } | null;
	/** Truthy when the record carries a reader's run. */
	rawData?: unknown;
	reading?: unknown;
};

export type Refusal =
	| 'not_found'
	| 'has_results'
	| 'in_use'
	| 'voided'
	| 'unavailable'
	| 'qc_cartridge'
	| 'research'
	| 'no_assay'
	| 'expired'
	| 'linked_by_other';

export type CheckState = 'ready' | 'linked' | 'running' | 'finished' | 'unavailable';

export type LinkCheckpoint = { who: string; when: string; where: Record<string, never>; via: AppName };

export type LinkDecision =
	/** Write `set`, but only while the record still has `fromStatus` and no run data. */
	| { action: 'link'; fromStatus: string | null; set: LinkSet; linkedAt: string }
	/** Already linked by this holder: nothing to write. */
	| { action: 'already' }
	| { action: 'refuse'; reason: Refusal };

export type LinkSet = {
	status: typeof LINKED;
	statusUpdatedOn: string;
	priorStatus: string;
	'checkpoints.linked': LinkCheckpoint;
};

/** Run data is what a reader uploads; checkpoints and manufacturing QC do not count. */
export const hasRunData = (r: RuleRecord) => Boolean(r.rawData || r.reading);

/** Blank and the research page's "Select Assay" sentinel '0' both mean no assay. */
export const hasAssay = (assayId: unknown): assayId is string =>
	typeof assayId === 'string' && assayId.trim() !== '' && assayId.trim() !== '0';

/** `reagentFilling.expirationDate ?? expirationDate`, as an instant; null when neither is a date. */
export function expiryOf(r: RuleRecord): Date | null {
	const raw = r.reagentFilling?.expirationDate ?? r.expirationDate ?? null;
	if (!raw) return null;
	const d = new Date(raw);
	return Number.isNaN(d.getTime()) ? null : d;
}

export const whoFor = (holderRef: string) => `app:${holderRef}`;

/**
 * Whether the record's link belongs to this holder. `app:<holderRef>` is what
 * this API writes; the bare `<holderRef>` is what the customer apps wrote
 * directly before the API existed, and names the same holder.
 */
export function linkedBy(r: Pick<RuleRecord, 'checkpoints'>, holderRef: string | null): boolean {
	if (!holderRef) return false;
	const who = r.checkpoints?.linked?.who;
	return who === whoFor(holderRef) || who === holderRef;
}

export type Eligibility = { ok: true; linked: boolean } | { ok: false; reason: Refusal };

/**
 * Whether a holder may link (or already holds) the cartridge. The same
 * function answers check, link and the retry inside link.
 *
 * Order matters: facts about the cartridge itself come before who holds it, so
 * a stranger probing ids learns nothing about holders from a dead cartridge.
 */
export function eligibility(
	record: RuleRecord | null,
	opts: { holderRef: string | null; isQcCartridge: boolean; now: Date }
): Eligibility {
	if (!record) return { ok: false, reason: 'not_found' };
	const status = record.status ?? '';
	if (hasRunData(record)) return { ok: false, reason: 'has_results' };
	if (status === 'underway') return { ok: false, reason: 'in_use' };
	if (record.voidedAt || status === 'voided' || status === 'scrapped') return { ok: false, reason: 'voided' };
	if (status === 'completed' || status === 'cancelled') return { ok: false, reason: 'unavailable' };
	if (record.used) return { ok: false, reason: 'has_results' };
	if (opts.isQcCartridge || record.usedForTestFill) return { ok: false, reason: 'qc_cartridge' };
	// No "internal testers" exception: it needed the caller's customer links,
	// and this API carries no account or customer (docs/BIMS-API-V1.md).
	if (typeof record.experiment === 'string' && record.experiment.trim() !== '') return { ok: false, reason: 'research' };
	if (!hasAssay(record.assayId)) return { ok: false, reason: 'no_assay' };
	const expires = expiryOf(record);
	if (expires && expires.getTime() < opts.now.getTime()) return { ok: false, reason: 'expired' };
	if (status === LINKED) {
		return linkedBy(record, opts.holderRef) ? { ok: true, linked: true } : { ok: false, reason: 'linked_by_other' };
	}
	return { ok: true, linked: false };
}

export function evaluateLink(
	record: RuleRecord | null,
	opts: { holderRef: string; app: AppName; isQcCartridge: boolean; now: Date }
): LinkDecision {
	const verdict = eligibility(record, opts);
	if (!verdict.ok) return { action: 'refuse', reason: verdict.reason };
	if (verdict.linked) return { action: 'already' };
	const when = opts.now.toISOString();
	return {
		action: 'link',
		fromStatus: record!.status ?? null,
		linkedAt: when,
		set: {
			status: LINKED,
			statusUpdatedOn: when,
			// The manufacturing status to return to on unlink.
			priorStatus: record!.status ?? '',
			'checkpoints.linked': { who: whoFor(opts.holderRef), when, where: {}, via: opts.app }
		}
	};
}

const STATE_OF: Record<Refusal, CheckState> = {
	not_found: 'unavailable',
	has_results: 'finished',
	in_use: 'running',
	voided: 'unavailable',
	unavailable: 'unavailable',
	qc_cartridge: 'unavailable',
	research: 'unavailable',
	no_assay: 'unavailable',
	expired: 'unavailable',
	linked_by_other: 'linked'
};

/** The check endpoint's `usable` / `reason` / `state`. */
export function checkSummary(v: Eligibility): { usable: boolean; reason: Refusal | null; state: CheckState } {
	if (v.ok) return { usable: true, reason: null, state: v.linked ? 'linked' : 'ready' };
	return { usable: false, reason: v.reason, state: STATE_OF[v.reason] };
}

export type UnlinkDecision =
	/** Restore `restoredStatus` (null: the record had no status before the link). */
	| { action: 'restore'; restoredStatus: string | null; who: string }
	| { action: 'not_linked' }
	| { action: 'refuse'; reason: 'not_found' | 'has_results' | 'linked_by_other' };

const RUN_STATUSES = new Set(['underway', 'completed', 'cancelled']);

/**
 * Unlink mirrors the research platform's `unlinkCartridge` restore branch:
 * only a `linked` record with no run data goes back to its `priorStatus`.
 * A record is never deleted, and only the holder that linked it may unlink.
 */
export function evaluateUnlink(record: RuleRecord | null, holderRef: string): UnlinkDecision {
	if (!record) return { action: 'refuse', reason: 'not_found' };
	const status = record.status ?? '';
	if (status !== LINKED) {
		if (hasRunData(record) || RUN_STATUSES.has(status)) return { action: 'refuse', reason: 'has_results' };
		return { action: 'not_linked' };
	}
	if (!linkedBy(record, holderRef)) return { action: 'refuse', reason: 'linked_by_other' };
	if (hasRunData(record)) return { action: 'refuse', reason: 'has_results' };
	const prior = (record.priorStatus ?? '').trim();
	return { action: 'restore', restoredStatus: prior || null, who: String(record.checkpoints!.linked!.who) };
}
