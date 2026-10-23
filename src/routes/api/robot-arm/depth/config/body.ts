/**
 * Shape checks and the allowed mode/fps tables for POST /api/robot-arm/depth/config,
 * kept out of +server.ts because SvelteKit refuses non-handler exports from
 * route files at build time. See +server.ts for what the route does.
 */
import { error } from '@sveltejs/kit';

export const DEPTH_MODES = ['480p', '720p'] as const;
export const DEPTH_FPS = [6, 15, 30] as const;
export type DepthMode = (typeof DEPTH_MODES)[number];

export interface DepthConfigBody {
	mode?: DepthMode;
	fps?: number;
	persist: boolean;
}

/** Shape-check the POST body; throws a SvelteKit 400 with the reason. */
export function parseDepthConfigBody(raw: unknown): DepthConfigBody {
	if (!raw || typeof raw !== 'object') error(400, 'Body must be a JSON object');
	const b = raw as Record<string, unknown>;
	const out: DepthConfigBody = { persist: b.persist === undefined ? true : b.persist === true };
	if (b.mode !== undefined) {
		if (typeof b.mode !== 'string' || !(DEPTH_MODES as readonly string[]).includes(b.mode)) error(400, `mode must be one of ${DEPTH_MODES.join(', ')}`);
		out.mode = b.mode as DepthMode;
	}
	if (b.fps !== undefined) {
		const n = typeof b.fps === 'string' ? Number(b.fps) : b.fps;
		if (typeof n !== 'number' || !(DEPTH_FPS as readonly number[]).includes(n)) error(400, `fps must be one of ${DEPTH_FPS.join(', ')}`);
		out.fps = n;
	}
	if (out.mode === undefined && out.fps === undefined) error(400, 'Nothing to change: give mode and/or fps');
	return out;
}
