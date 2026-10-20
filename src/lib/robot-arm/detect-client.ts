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
}

export async function fetchDetections(camera: string, signal?: AbortSignal): Promise<LiveDetection> {
	const res = await fetch(`/api/robot-arm/cameras/${encodeURIComponent(camera)}/apriltags?t=${Date.now()}`, { cache: 'no-store', signal });
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
			? body.tags.map((t: any) => ({ id: t.id, center: t.center, corners: t.corners ?? [], sizeMm: t.sizeMm ?? null, pose: t.pose ?? null, depthMm: t.depthMm ?? null }))
			: [],
		frame: body.frame ?? null
	};
}
