/**
 * The Animate scratch recording (2026-11-05): every Play and Go To writes its
 * rendered path to the Pi as one recording and replays it by the path the Pi
 * lists. This used to be three Pi calls before the replay — DELETE the old
 * file, restore the new one, list every recording to find its path — each a
 * tunnel round trip. Now:
 *
 *  - restore with `replace: true` (recordings_admin.py, 2026-11-05) overwrites
 *    in one call and answers with the path, so nothing else is needed;
 *  - a Pi without it ignores the flag and answers 409 "already exists": then
 *    DELETE + restore as before (BIMS works with either Pi);
 *  - with no path in the answer, the path found last time is reused (it is the
 *    same file every time) and the Pi's listing is read only once per server
 *    instance, or again after the Pi refused a remembered path.
 *
 * The Pi calls are injected so the fallbacks can be unit-tested.
 */
import type { RecordingMeta, RecordingSidecar } from './robot-arm-client';

export interface PreviewArm {
	restoreRecording(body: { name: string; jsonl: string; meta: RecordingSidecar | null; replace?: boolean }): Promise<{ restored: string; replaced?: boolean; path?: string }>;
	deleteRecording(name: string): Promise<unknown>;
	listRecordings(): Promise<{ recordings: RecordingMeta[] }>;
}

export class PreviewWriteError extends Error {}

/** name → the path the Pi lists it under, remembered for this server instance. */
const knownPaths = new Map<string, string>();

const msgOf = (err: unknown) => (err as Error)?.message ?? String(err);
const stem = (name: string) => name.replace(/\.jsonl$/i, '');

/** Forget a remembered path (the Pi refused to replay it). */
export function forgetPreviewPath(name: string): void {
	knownPaths.delete(name);
}

/** For tests. */
export function resetPreviewPaths(): void {
	knownPaths.clear();
}

/**
 * Write `jsonl` as the recording `name` on the Pi, replacing any file of that
 * name, and return the path to replay it by.
 */
export async function writePreviewRecording(arm: PreviewArm, name: string, jsonl: string, meta: RecordingSidecar | null): Promise<string> {
	let reply: { path?: string } | null = null;
	try {
		reply = await arm.restoreRecording({ name, jsonl, meta, replace: true });
	} catch (err) {
		const msg = msgOf(err);
		// Only an older Pi's "already exists" falls back; a session refusal or any other failure stops here.
		if (!/robot-arm 409/.test(msg) || !/already exists/i.test(msg)) throw new PreviewWriteError(`The Pi did not take the path: ${msg}`);
		try {
			await arm.deleteRecording(name);
		} catch (delErr) {
			if (!/robot-arm 404/.test(msgOf(delErr))) throw new PreviewWriteError(`Could not clear the preview recording on the Pi: ${msgOf(delErr)}`);
		}
		try {
			reply = await arm.restoreRecording({ name, jsonl, meta });
		} catch (err2) {
			throw new PreviewWriteError(`The Pi did not take the path: ${msgOf(err2)}`);
		}
	}
	if (reply?.path) {
		knownPaths.set(name, reply.path);
		return reply.path;
	}
	const known = knownPaths.get(name);
	if (known) return known;
	return lookUpPath(arm, name);
}

/** Read the Pi's listing for `name` (and remember it). */
export async function lookUpPath(arm: PreviewArm, name: string): Promise<string> {
	let recordings: RecordingMeta[];
	try {
		recordings = (await arm.listRecordings()).recordings ?? [];
	} catch (err) {
		throw new PreviewWriteError(`Could not list the Pi's recordings after writing the path: ${msgOf(err)}`);
	}
	const rec = recordings.find((r) => stem(r.name) === name);
	if (!rec?.path) {
		throw new PreviewWriteError(
			`The Pi accepted "${name}" but does not list it among its recordings — its restore route is saving to a different folder than replay reads. On arm-pi, check BIMS_ARM_RECORDINGS_DIR for the service and recordings_admin.py.`
		);
	}
	knownPaths.set(name, rec.path);
	return rec.path;
}
