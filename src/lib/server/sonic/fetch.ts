/**
 * Server-side read of a stored sonic recording (shared by analysis and the
 * MongoDB copy), so neither module imports the other.
 */
import { env } from '$env/dynamic/private';
import { downloadFile } from '$lib/server/r2';
import { downloadViaWorker } from '$lib/server/services/r2';

/**
 * The download must finish well inside the action's maxDuration (60 s) so a hung
 * Worker still ends in a stored analysis.error instead of a killed function and a
 * recording that reads "pending" forever.
 */
const DOWNLOAD_TIMEOUT_MS = 25_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Server-side reads go through the Worker (the S3 keys in Vercel are known-bad, and
 * falling back to them only replaced the Worker's real error with a credentials one).
 * The S3 client is used only where no Worker is configured (local dev).
 */
export async function fetchRecording(key: string): Promise<Uint8Array> {
	let bytes: Uint8Array;
	if (env.R2_WORKER_URL) {
		bytes = new Uint8Array(await withTimeout(downloadViaWorker(key), DOWNLOAD_TIMEOUT_MS, 'recording download'));
	} else {
		bytes = await withTimeout(
			(async () => {
				const { body } = await downloadFile(key);
				return new Uint8Array(await new Response(body).arrayBuffer());
			})(),
			DOWNLOAD_TIMEOUT_MS,
			'recording download'
		);
	}
	if (!bytes.byteLength) throw new Error('the stored recording is empty (0 bytes)');
	return bytes;
}
