import { uploadToR2, uploadViaWorker } from './r2';
import { storeImageInMongo } from './device-assembly-wi';
import type { StoreImageFn } from './device-assembly-wi-parser';

// R2-first image store for the SPU Assembly WI (routes only — pulls in $env).
// Order: Cloudflare Worker → direct S3v4 → Mongo (WorkInstructionImage).
// Something is always stored, so a picture never silently disappears.

export function makeDeviceWiImageStore(opts: { wiId: string | null; uploadedBy: string; keyPrefix?: string }): StoreImageFn {
	const prefix = opts.keyPrefix ?? `device-wi/${opts.wiId ?? 'import'}/${Date.now()}`;
	return async (buf, contentType, index) => {
		const ext = (contentType.split('/')[1] || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
		const key = `${prefix}/img-${String(index).padStart(3, '0')}.${ext}`;
		try {
			return { url: await uploadViaWorker(buf, key, contentType), storage: 'r2' };
		} catch {
			try {
				return { url: await uploadToR2(buf, key, contentType), storage: 'r2' };
			} catch {
				const stored = await storeImageInMongo(buf, contentType, { wiId: opts.wiId, uploadedBy: opts.uploadedBy });
				return { url: stored.url, storage: 'mongo' };
			}
		}
	};
}
