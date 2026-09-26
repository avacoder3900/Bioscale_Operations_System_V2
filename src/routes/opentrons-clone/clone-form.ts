/**
 * `use:cloneForm` — the clone's form actions, run in the browser (OT2-TAILNET-5 S10b).
 *
 * Replaces `use:enhance` on the clone pages so the markup stays as it was: the
 * form keeps `action="?/name"`, and submitting it calls actions[name](FormData)
 * — a client function over the robot session — instead of a server action.
 * Result handling mirrors enhance's defaults: a success resets the form and
 * re-runs the loads (invalidateAll); a failure shows { error, details }; a
 * redirect navigates.
 */
import { goto, invalidateAll } from '$app/navigation';

export type CloneFormResult = {
	success?: boolean;
	message?: string;
	error?: string;
	details?: unknown;
	[k: string]: unknown;
} | null;

export type CloneOutcome =
	| { type: 'success'; data: CloneFormResult }
	| { type: 'failure'; status: number; data: CloneFormResult }
	| { type: 'redirect'; location: string };

export type CloneAction = (form: FormData) => Promise<CloneOutcome>;

export const ok = (data: Record<string, unknown> = {}): CloneOutcome => ({ type: 'success', data: { success: true, ...data } });
export const failure = (status: number, error: string, details?: unknown): CloneOutcome => ({
	type: 'failure',
	status,
	data: { error, ...(details !== undefined ? { details } : {}) }
});
export const redirectTo = (location: string): CloneOutcome => ({ type: 'redirect', location });

/**
 * A robot Response → outcome. The failure text is the page's own ("Delete
 * failed"), plus the session's message when the line itself answered (relay
 * 502, "needs Tailscale", "NOT retried").
 */
export async function answer(
	res: Response,
	failMsg: string,
	onOk: (body: any) => CloneOutcome = () => ok()
): Promise<CloneOutcome> {
	const body = await res.json().catch(() => null);
	if (!res.ok) {
		const lineMsg = typeof body?.message === 'string' && !body?.errors ? ` — ${body.message}` : '';
		return failure(res.status, `${failMsg}${lineMsg}`, body ?? undefined);
	}
	return onOk(body);
}

/**
 * requirePermission(manufacturing:write) for the browser-side actions: a
 * direct-line action never reaches a BIMS route, so refuse it here (the queue
 * relay checks the same permission server-side).
 */
export function guardWrite(canWrite: boolean | undefined, actions: Record<string, CloneAction>): Record<string, CloneAction> {
	if (canWrite) return actions;
	const denied: CloneAction = async () => failure(403, 'Permission denied: requires manufacturing:write');
	return Object.fromEntries(Object.keys(actions).map((k) => [k, denied]));
}

export interface CloneFormParams {
	actions: Record<string, CloneAction>;
	onResult?: (r: CloneFormResult) => void;
	/** Called before the action; may return a cleanup run when it settles. */
	onSubmit?: () => void | (() => void);
}

export function cloneForm(node: HTMLFormElement, params: CloneFormParams) {
	let p = params;
	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const raw = e.submitter?.getAttribute('formaction') ?? node.getAttribute('action') ?? '';
		const name = raw.replace(/^\?\//, '');
		const action = p.actions[name];
		if (!action) {
			p.onResult?.({ error: `Unknown action ${name}` });
			return;
		}
		const fd = e.submitter ? new FormData(node, e.submitter as HTMLElement) : new FormData(node);
		const settle = p.onSubmit?.();
		let outcome: CloneOutcome;
		try {
			outcome = await action(fd);
		} catch (err) {
			outcome = failure(502, `Robot unreachable: ${err instanceof Error ? err.message : String(err)}`);
		}
		try {
			if (outcome.type === 'redirect') {
				await goto(outcome.location, { invalidateAll: true });
				return;
			}
			p.onResult?.(outcome.data);
			if (outcome.type === 'success') {
				node.reset();
				await invalidateAll();
			}
		} finally {
			if (typeof settle === 'function') settle();
		}
	}
	node.addEventListener('submit', submit);
	return {
		update(next: CloneFormParams) {
			p = next;
		},
		destroy() {
			node.removeEventListener('submit', submit);
		}
	};
}
