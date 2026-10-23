/**
 * Shape checks for POST /api/robot-arm/cameras/[name]/controls, kept out of
 * +server.ts because SvelteKit refuses non-handler exports from route files
 * at build time. See +server.ts for what the route does.
 */
import { error } from '@sveltejs/kit';

const NAME_RE = /^[a-z0-9_]{1,64}$/;
const MAX_SET = 40;

export interface ControlsBody {
	set?: Record<string, number>;
	reset?: boolean;
	persist: boolean;
}

/**
 * Shape-check the POST body. Throws a SvelteKit 400 with a reason the panel
 * can show. Booleans become 0/1 (v4l2 bools are ints); anything that is not a
 * whole number is refused here rather than rounded, because a rounded value
 * is a value the operator did not type.
 */
export function parseControlsBody(raw: unknown): ControlsBody {
	if (!raw || typeof raw !== 'object') error(400, 'Body must be a JSON object');
	const b = raw as Record<string, unknown>;
	const persist = b.persist === undefined ? true : b.persist === true;
	if (b.reset === true) return { reset: true, persist };
	if (!b.set || typeof b.set !== 'object' || Array.isArray(b.set)) error(400, 'Body needs `set` (name → value) or `reset: true`');
	const entries = Object.entries(b.set as Record<string, unknown>);
	if (!entries.length) error(400, '`set` is empty');
	if (entries.length > MAX_SET) error(400, `At most ${MAX_SET} controls per request`);
	const set: Record<string, number> = {};
	for (const [name, v] of entries) {
		if (!NAME_RE.test(name)) error(400, `"${name}" is not a control name`);
		let n: number;
		if (typeof v === 'boolean') n = v ? 1 : 0;
		else if (typeof v === 'number') n = v;
		else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) n = Number(v);
		else error(400, `${name}: value must be a number`);
		if (!Number.isInteger(n)) error(400, `${name}: value must be a whole number`);
		set[name] = n;
	}
	return { set, persist };
}
