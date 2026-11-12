// Progress rules for building several SPUs at once against the SPU Assembly WI
// (/spu/assembly-wi/build). Pure functions, no DB: the page uses them to draw
// tabs and step cards, and the server uses the same ones to decide when a step
// or a whole build is complete, so the two can never disagree.
//
// A build tracks progress by WI step _id and material _id, never by position,
// so editing the WI mid-build (moving or renaming steps) keeps what was done.

export type WiMaterial = {
	_id: string;
	kind: string; // 'part' | 'tool' | 'aid' | 'supply'
	partNumber?: string | null;
	partDefinitionId?: string | null;
	name: string;
	quantity?: number | null;
	unit?: string | null;
	deductFromInventory?: boolean | null;
	notes?: string | null;
};

export type WiStep = {
	_id: string;
	stepNumber: number;
	title?: string | null;
	instructionsText?: string | null;
	materials?: WiMaterial[];
	requiresEsd?: boolean;
};

export type WiSection = {
	_id?: string;
	number: number;
	type: string; // 'setup' | 'subassembly'
	title?: string | null;
	tabLabel?: string | null;
	steps: WiStep[];
};

export type WiLike = { sections: WiSection[] };

export type BuildScanLike = { stepId: string; materialId: string; status?: string | null };
export type BuildLike = {
	status?: string | null;
	completedSteps?: { stepId: string }[];
	scans?: BuildScanLike[];
};

export type PartRef = { partDefinitionId?: string | null; partNumber?: string | null };

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * A scanned bucket QR code as stored on SpuBucket.qrCode / SpuBuild.bucketCode.
 * Bucket stickers carry a UUID: it is pulled out of whatever the scanner sends
 * (a bare UUID, or a link with the UUID in it) and lower-cased, since scanners
 * disagree about hex case. Any other label is trimmed and upper-cased. Null
 * when it can't be a label at all: empty, spaces inside, over 64 characters.
 */
export function normalizeBucketCode(code: string | null | undefined): string | null {
	const raw = (code ?? '').trim();
	const uuid = raw.match(UUID_RE);
	if (uuid) return uuid[0].toLowerCase();
	const c = raw.toUpperCase();
	return /^[A-Z0-9][A-Z0-9._:/-]{1,63}$/.test(c) ? c : null;
}

/** "Bucket 2" — the name people use; builds from before buckets were numbered fall back to their code. */
export function bucketLabel(b: { bucketNumber?: number | null; bucketCode?: string | null; number?: number | null }): string {
	const n = b.bucketNumber ?? b.number;
	return n != null ? `Bucket ${n}` : `Bucket ${b.bucketCode ?? '?'}`;
}

export function sectionLabel(section: { type: string; number: number }): string {
	return section.type === 'setup' ? 'Setup' : `Sub-Assembly ${section.number}`;
}

/** Same rule as the WI page's tabs: custom tabLabel if set, else the positional label. */
export function tabLabel(section: { type: string; number: number; tabLabel?: string | null }): string {
	return section.tabLabel?.trim() || sectionLabel(section);
}

export function stepTitle(step: WiStep): string {
	const title = (step.title ?? '').trim();
	if (title) return title;
	const firstLine = (step.instructionsText ?? '').trim().split(/\r?\n/)[0]?.trim() ?? '';
	if (firstLine) return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
	return 'Untitled step';
}

/** Materials that are consumed into the device: each one is scanned per build. */
export function partsOf(step: WiStep): WiMaterial[] {
	return (step.materials ?? []).filter((m) => m.kind === 'part');
}

/** Tools, manufacturing aids and supplies: listed for the operator, never scanned. */
export function toolsOf(step: WiStep): WiMaterial[] {
	return (step.materials ?? []).filter((m) => m.kind !== 'part');
}

/** A part only comes off inventory when it is linked to the catalog and not opted out. */
export function deducts(material: WiMaterial): boolean {
	return Boolean(material.partDefinitionId) && material.deductFromInventory !== false;
}

export function scanKey(stepId: string, materialId: string): string {
	return `${stepId}|${materialId}`;
}

/**
 * Scan lifecycle: 'pending' (slot claimed, deduction in flight) → 'recorded';
 * an undo goes 'recorded' → 'undoing' (stock being returned) → 'undone'.
 * Undone scans stay on the build as history but no longer fill their slot.
 */
export const SLOT_HOLDING_STATUSES = ['pending', 'recorded', 'undoing'] as const;

/**
 * Keys of every part recorded on a build. `recordedOnly` skips scans still in
 * flight (claimed but not yet deducted, or being undone) — use it when deciding
 * completion, and leave it off when deciding whether a slot is free, so a
 * double-fired scanner cannot claim the same slot twice.
 */
export function scannedKeys(build: BuildLike, opts: { recordedOnly?: boolean } = {}): Set<string> {
	const keys = new Set<string>();
	for (const s of build.scans ?? []) {
		if (s.status === 'undone') continue;
		if (opts.recordedOnly && s.status && s.status !== 'recorded') continue;
		keys.add(scanKey(s.stepId, s.materialId));
	}
	return keys;
}

/** The live (not undone) scan filling a slot, if any. */
export function liveScan<T extends BuildScanLike>(scans: T[] | undefined, stepId: string, materialId: string): T | null {
	return (scans ?? []).find((s) => s.stepId === stepId && s.materialId === materialId && s.status !== 'undone') ?? null;
}

export function doneStepIds(build: BuildLike): Set<string> {
	return new Set((build.completedSteps ?? []).map((c) => c.stepId));
}

export function allPartsScanned(step: WiStep, scanned: Set<string>): boolean {
	return partsOf(step).every((m) => scanned.has(scanKey(step._id, m._id)));
}

export function sectionProgress(section: WiSection, done: Set<string>): { done: number; total: number } {
	return { done: section.steps.filter((st) => done.has(st._id)).length, total: section.steps.length };
}

/** Steps done out of every step on the current WI (steps since deleted from the WI don't count). */
export function buildProgress(wi: WiLike, build: BuildLike): { done: number; total: number } {
	const done = doneStepIds(build);
	let n = 0;
	let total = 0;
	for (const s of wi.sections) {
		const p = sectionProgress(s, done);
		n += p.done;
		total += p.total;
	}
	return { done: n, total };
}

/** The first section with a step left to do; the last section when everything is done. */
export function firstOpenSection(wi: WiLike, build: BuildLike): WiSection | null {
	const done = doneStepIds(build);
	for (const s of wi.sections) {
		const p = sectionProgress(s, done);
		if (p.done < p.total) return s;
	}
	return wi.sections[wi.sections.length - 1] ?? null;
}

export type BuildTone = 'done' | 'idle' | 'active' | 'cancelled';

export function buildStatus(wi: WiLike, build: BuildLike): { label: string; tone: BuildTone } {
	if (build.status === 'cancelled') return { label: 'Cancelled', tone: 'cancelled' };
	const { done, total } = buildProgress(wi, build);
	if (build.status === 'completed' || (total > 0 && done >= total)) return { label: 'Complete', tone: 'done' };
	if (done === 0 && !(build.scans ?? []).some((s) => s.status !== 'undone')) return { label: 'Not started', tone: 'idle' };
	const open = firstOpenSection(wi, build);
	return { label: open ? `In progress · ${tabLabel(open)}` : 'In progress', tone: 'active' };
}

export function matchesPart(material: WiMaterial, part: PartRef): boolean {
	if (material.kind !== 'part') return false;
	if (part.partDefinitionId && material.partDefinitionId && material.partDefinitionId === part.partDefinitionId) return true;
	const a = (material.partNumber ?? '').trim().toUpperCase();
	const b = (part.partNumber ?? '').trim().toUpperCase();
	return Boolean(a) && a === b;
}

/** Parts on a step not recorded on this build yet (scans in flight count as recorded). */
export function partsLeft(step: WiStep, build: BuildLike): WiMaterial[] {
	const scanned = scannedKeys(build);
	return partsOf(step).filter((m) => !scanned.has(scanKey(step._id, m._id)));
}

/**
 * The step whose parts are scanned now: the first step in the section, in WI
 * order, with a part not recorded yet. Parts go in step by step — a later
 * step's parts are refused until this step's are all in. Null when every part
 * in the section is in, or the section has none.
 */
export function currentStep(section: WiSection, build: BuildLike): WiStep | null {
	return section.steps.find((st) => partsLeft(st, build).length > 0) ?? null;
}

export type PartHit =
	| { kind: 'found'; step: WiStep; material: WiMaterial }
	| { kind: 'out-of-order'; current: WiStep; step: WiStep } // belongs to a later step
	| { kind: 'section-scanned' } // every part in the section is already in
	| { kind: 'already-scanned' }
	| { kind: 'not-in-section' };

/**
 * Where a scanned part goes: the current step (see currentStep), if it still
 * needs that part. A part a later step needs is refused as out of order.
 */
export function findStepForPart(section: WiSection, build: BuildLike, part: PartRef): PartHit {
	if (!section.steps.some((st) => partsOf(st).some((m) => matchesPart(m, part)))) return { kind: 'not-in-section' };
	const current = currentStep(section, build);
	if (!current) return { kind: 'section-scanned' };
	const material = partsLeft(current, build).find((m) => matchesPart(m, part));
	if (material) return { kind: 'found', step: current, material };
	const after = section.steps.slice(section.steps.indexOf(current) + 1);
	const later = after.find((st) => partsLeft(st, build).some((m) => matchesPart(m, part)));
	return later ? { kind: 'out-of-order', current, step: later } : { kind: 'already-scanned' };
}

/** A section is complete when the operator has confirmed it: every one of its steps is on completedSteps. */
export function sectionConfirmed(section: WiSection, build: BuildLike): boolean {
	const done = doneStepIds(build);
	return section.steps.length > 0 && section.steps.every((st) => done.has(st._id));
}

/** Parts recorded / needed, for a section or the whole WI. */
export function partsProgress(sections: WiSection[], build: BuildLike): { scanned: number; total: number } {
	let scanned = 0;
	let total = 0;
	for (const s of sections) for (const st of s.steps) {
		const parts = partsOf(st);
		total += parts.length;
		scanned += parts.length - partsLeft(st, build).length;
	}
	return { scanned, total };
}

export function sectionsUsingPart(wi: WiLike, part: PartRef): WiSection[] {
	return wi.sections.filter((s) => s.steps.some((st) => partsOf(st).some((m) => matchesPart(m, part))));
}
