/**
 * Browser-side AprilTag fetch for the Vision tab (ARM-05).
 *
 * Detection runs on the Pi; this only asks the BIMS proxy for the current
 * frame's tags and the JPEG they were found in. Nothing is decoded here.
 */
import type { TagDetection, TagRole } from './apriltags';

/** A detection with what the registry says it is (null = not registered). */
export interface LiveTag extends TagDetection {
	registered: { _id: string; name: string; group: string | null; role: TagRole } | null;
}

export interface LiveDetection {
	available: boolean;
	reason: string | null;
	detector: string | null;
	width: number;
	height: number;
	intrinsics: { fx: number; fy: number; cx: number; cy: number; source: string } | null;
	tags: LiveTag[];
	/** data: URL of the frame the tags were found in. */
	frame: string | null;
	/** 'raw' when the Pi detected on the sensor's own pixels, 'jpeg' on an older Pi, null if it did not say. */
	frameSource: 'raw' | 'jpeg' | null;
	/** Separate detections the Pi averaged each tag's corners over. */
	framesUsed: number;
	/** Frames the Pi stacked into each image before detecting; null on a Pi without frame stacking. */
	framesAveraged: number | null;
	/** Time the Pi spent capturing, ms; null on an older Pi. */
	captureMs: number | null;
	/** Mean |last - first| luma over the stack (0-255); ~0 when nothing moved. */
	motionLuma: number | null;
}

/**
 * @param frames distinct captures the Pi averages each tag's corners over
 *   (1..10). More = steadier numbers, slower answer (~0.6 s per frame).
 * @param average consecutive frames the Pi stacks pixel by pixel into each
 *   image before detecting (1..60, ~33 ms per frame at 30 fps, no extra detect).
 */
export async function fetchDetections(camera: string, signal?: AbortSignal, frames = 1, average = 1): Promise<LiveDetection> {
	const n = Math.max(1, Math.min(10, Math.round(frames)));
	const k = Math.max(1, Math.min(60, Math.round(average)));
	const q = (n > 1 ? `&frames=${n}` : '') + (k > 1 ? `&average=${k}` : '');
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
					framesSeen: typeof t.framesSeen === 'number' ? t.framesSeen : null,
					registered: t.registered ?? null
				}))
			: [],
		frame: body.frame ?? null,
		frameSource: body.frameSource === 'raw' || body.frameSource === 'jpeg' ? body.frameSource : null,
		framesUsed: typeof body.framesUsed === 'number' ? body.framesUsed : 1,
		framesAveraged: typeof body.framesAveraged === 'number' ? body.framesAveraged : null,
		captureMs: typeof body.captureMs === 'number' ? body.captureMs : null,
		motionLuma: typeof body.motionLuma === 'number' ? body.motionLuma : null
	};
}
