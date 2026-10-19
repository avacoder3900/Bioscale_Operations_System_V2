/**
 * Browser-side frame grab for the Vision tab (ARM-04).
 *
 * Frames come through the BIMS snapshot proxy, never the Pi's direct MJPEG
 * origin: the proxy is same-origin, so the decoded pixels can be read back
 * from a canvas. A cross-origin frame would taint the canvas and tracking
 * would be impossible.
 */
import type { PixelImage } from './markers';

export interface GrabbedFrame {
	/** The JPEG exactly as the Pi served it — what a calibration uploads. */
	blob: Blob;
	/** Object URL for <img>; the caller revokes it when the frame is replaced. */
	url: string;
	image: PixelImage;
	width: number;
	height: number;
}

export function snapshotUrl(camera: string): string {
	return `/api/robot-arm/cameras/${encodeURIComponent(camera)}/snapshot?t=${Date.now()}`;
}

export async function grabFrame(camera: string, signal?: AbortSignal): Promise<GrabbedFrame> {
	const res = await fetch(snapshotUrl(camera), { cache: 'no-store', signal });
	if (!res.ok) throw new Error(res.status === 502 ? 'Camera unavailable' : `Snapshot failed (${res.status})`);
	const blob = await res.blob();
	const bitmap = await createImageBitmap(blob);
	try {
		const canvas = document.createElement('canvas');
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) throw new Error('Canvas unavailable');
		ctx.drawImage(bitmap, 0, 0);
		const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
		return {
			blob,
			url: URL.createObjectURL(blob),
			image: { data, width: bitmap.width, height: bitmap.height, channels: 4 },
			width: bitmap.width,
			height: bitmap.height
		};
	} finally {
		bitmap.close();
	}
}

/** Depth at normalised points via the BIMS proxy. Never throws: depth is optional. */
export async function fetchDepth(
	camera: string,
	points: [number, number][]
): Promise<{ available: boolean; depth: (number | null)[]; reason: string | null }> {
	if (!points.length) return { available: false, depth: [], reason: null };
	try {
		const res = await fetch(`/api/robot-arm/cameras/${encodeURIComponent(camera)}/depth`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ points })
		});
		if (!res.ok) return { available: false, depth: points.map(() => null), reason: `Depth request failed (${res.status})` };
		const body = await res.json();
		const depth = points.map((_, i) => {
			const v = body?.depth_mm?.[i];
			return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
		});
		return { available: !!body?.available, depth, reason: body?.reason ?? null };
	} catch (e) {
		return { available: false, depth: points.map(() => null), reason: e instanceof Error ? e.message : 'Depth request failed' };
	}
}
