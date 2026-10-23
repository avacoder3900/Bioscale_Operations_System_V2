/**
 * Browser-side AprilTag fetch for the Vision tab (ARM-05).
 *
 * Detection runs on the Pi; this only asks the BIMS proxy for the current
 * frame's tags and the JPEG they were found in. Nothing is decoded here.
 */
import type { TagDetection } from './apriltags';

export interface LiveDetection {
	available: boolean;
	reason: string | null;
	detector: string | null;
	width: number;
	height: number;
	intrinsics: { fx: number; fy: number; cx: number; cy: number; source: string } | null;
	tags: TagDetection[];
	/** data: URL of the frame the tags were found in. */
	frame: string | null;
	/** 'raw' when the Pi detected on the sensor's own pixels, 'jpeg' on an older Pi, null if it did not say. */
	frameSource: 'raw' | 'jpeg' | null;
	/** Frames the Pi averaged each tag over. */
	framesUsed: number;
}

/**
 * @param frames distinct captures the Pi averages each tag's corners over
 *   (1..10). More = steadier numbers, slower answer (~0.15 s per frame).
 */
export async function fetchDetections(camera: string, signal?: AbortSignal, frames = 1): Promise<LiveDetection> {
	const n = Math.max(1, Math.min(10, Math.round(frames)));
	const q = n > 1 ? `&frames=${n}` : '';
	const res = await fetch(`/api/robot-arm/cameras/${encodeURIComponent(camera)}/apriltags?t=${Date.now()}${q}`, { cache: 'no-store', signal });
	if (!res.ok) throw new Error(res.status === 502 ? 'Tag detection unavailable — is the arm reachable?' : `Detection failed (${res.status})`);
	const body = await res.json();
	return {
		available: !!body.available,
		reason: body.reason ?? null,
		detector: body.detector ?? null,
		width: Number(body.width) || 0,
		height: Number(body.height) || 0,
		intrinsics: body.intrinsics ?? null,
		tags: Array.isArray(body.tags)
			? body.tags.map((t: any) => ({
					id: t.id,
					center: t.center,
					corners: t.corners ?? [],
					sizeMm: t.sizeMm ?? null,
					pose: t.pose ?? null,
					depthMm: t.depthMm ?? null,
					jitterPx: typeof t.jitterPx === 'number' ? t.jitterPx : null,
					framesSeen: typeof t.framesSeen === 'number' ? t.framesSeen : null
				}))
			: [],
		frame: body.frame ?? null,
		frameSource: body.frameSource === 'raw' || body.frameSource === 'jpeg' ? body.frameSource : null,
		framesUsed: typeof body.framesUsed === 'number' ? body.framesUsed : 1
	};
}
