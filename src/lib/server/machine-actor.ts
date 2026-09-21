/**
 * PERM-05: machine-surface identity, attribution, and authority (docs/prds/PERM-05).
 *
 * Three rules, all enforced here:
 *
 * 1. BOTS ARE PERMANENT NON-ADMINS. Key-authenticated callers get exactly what
 *    an Operator gets. Admin-gated activities (document approval, tier-1→tier-2
 *    commitment, lot release, sacred corrections, assay lock, policy changes)
 *    are human-only, in the web app, with a real session. Bots propose; humans
 *    decide.
 * 2. ATTRIBUTION IS MANDATORY BUT GRANTS NOTHING. Every machine-surface write
 *    must name the human it is acting for, and that name must resolve to an
 *    active BIMS user. Because bots can never reach an admin gate, a wrong or
 *    borrowed name cannot escalate anything — it is an audit-quality problem,
 *    not a security hole. (One shared Claude account is the reason we cannot
 *    authenticate the human; see PERM-05 §B.)
 * 3. THE REJECTION IS THE MECHANISM. There is no way to make a model ask a
 *    question, but a server can refuse in a way that leaves asking as the only
 *    path forward. `MISSING_ACTOR_MESSAGE` is written to be read by the model.
 *    Elicitation is deliberately NOT used — only Claude Code CLI supports it;
 *    Desktop, claude.ai and iOS do not (verified 2026-08-03).
 */
import { connectDB } from '$lib/server/db/connection';
import { User } from '$lib/server/db/models';
import { hasPermission } from '$lib/server/permissions';

/** Reserved actor for scheduled jobs — accepted only for cron-authenticated calls. */
export const SYSTEM_ACTOR = 'system';

/** How the machine surface was reached. Recorded verbatim in the audit trail. */
export type MachineChannel = 'mcp' | 'agent-api' | 'cron' | 'device';

export const MISSING_ACTOR_MESSAGE =
	'This action requires attribution. Ask the person you are working with for their ' +
	'BIMS username, then retry with `actor` set to it. Do not guess, and do not use ' +
	'your own name — the actor must be the human making this decision. Ask once and ' +
	'reuse that name for the rest of this conversation.';

export function unknownActorMessage(given: string): string {
	return (
		`"${given}" is not an active BIMS user, so this action was not performed. ` +
		'Ask the person you are working with for the exact username they log into BIMS ' +
		'with, then retry with `actor` set to it.'
	);
}

export function humanOnlyMessage(what: string, where: string): string {
	return (
		`${what} is a human-only action — it cannot be performed through an agent or MCP ` +
		`connection, regardless of who the actor is. A person with admin rights must do it ` +
		`in the BIMS web app: ${where}. If it should happen, say so and the request can be ` +
		'raised for them (kanban_propose_changes / create_approval_request), but the ' +
		'decision itself stays with a human.'
	);
}

export class ActorError extends Error {
	constructor(
		message: string,
		public readonly kind: 'missing' | 'unknown'
	) {
		super(message);
		this.name = 'ActorError';
	}
}

export interface ResolvedActor {
	username: string;
	userId: string;
	/** True only for the reserved cron principal. */
	isSystem: boolean;
}

/**
 * Resolve a caller-supplied actor name to an active BIMS user.
 *
 * Attribution only — the resolved user's permissions are deliberately NOT
 * consulted for authorization. Machine callers are non-admins no matter whom
 * they name; that check lives in `assertHumanOnly`.
 */
export async function resolveActor(
	given: string | undefined | null,
	opts?: { allowSystem?: boolean }
): Promise<ResolvedActor> {
	const name = given?.trim();
	if (!name) throw new ActorError(MISSING_ACTOR_MESSAGE, 'missing');

	if (name.toLowerCase() === SYSTEM_ACTOR) {
		if (opts?.allowSystem) return { username: SYSTEM_ACTOR, userId: SYSTEM_ACTOR, isSystem: true };
		throw new ActorError(
			`"${SYSTEM_ACTOR}" is reserved for scheduled jobs. ${MISSING_ACTOR_MESSAGE}`,
			'unknown'
		);
	}

	await connectDB();
	const user: any = await User.findOne({
		username: new RegExp(`^${escapeRegex(name)}$`, 'i'),
		isActive: true
	})
		.select('_id username roles')
		.lean();

	if (!user) throw new ActorError(unknownActorMessage(name), 'unknown');

	// A research-app-only account is not a BIMS actor. hasPermission already
	// ignores research-owned roles, so this also rejects e.g. "Research Admin".
	if (!hasPermission(user, 'bims')) {
		throw new ActorError(
			`"${user.username}" is not a BIMS user (no bims access), so this action was not ` +
				'performed. Ask for the username of someone who uses BIMS.',
			'unknown'
		);
	}

	return { username: user.username, userId: String(user._id), isSystem: false };
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Admin-gated actions the machine surface must never perform.
 * Key = stable id used by callers; value = where a human does it instead.
 */
export const HUMAN_ONLY_ACTIONS: Record<string, { what: string; where: string }> = {
	kanban_replenish: {
		what: 'Committing work (Tier 1 → Board)',
		where: 'Kanban → Tier 1, select the items and use the commit bar'
	},
	kanban_demote: {
		what: 'Demoting committed work (Board → Tier 1)',
		where: 'Kanban → the task page, Demote'
	},
	kanban_reorder_ready: {
		what: 'Reordering the committed (ready) queue',
		where: 'Kanban → Board (order is commit order; there is no priority list on the Board)'
	},
	kanban_set_policy: { what: 'Changing kanban policy', where: 'Kanban → Policy' },
	kanban_set_template: { what: 'Changing workflow templates', where: 'Kanban → Policy → Templates' },
	kanban_set_standing_target: {
		what: 'Changing standing supply targets',
		where: 'Kanban → Policy → Standing targets'
	},
	kanban_decide_proposal: {
		what: 'Deciding a change proposal',
		where: 'Kanban → the task page, Proposals'
	},
	decide_approval_request: { what: 'Deciding an approval request', where: 'BIMS → Approvals' },
	document_approve: { what: 'Approving a document', where: 'Documents → the document → Approve' },
	manufacturing_release: { what: 'Releasing or scrapping a lot', where: 'Manufacturing → QA/QC' },
	assay_lock: { what: 'Locking or unlocking an assay', where: 'Assays → the assay' }
};

/** Throws if `actionId` is admin-gated. Machine callers are never admins. */
export function assertHumanOnly(actionId: keyof typeof HUMAN_ONLY_ACTIONS | string): void {
	const entry = HUMAN_ONLY_ACTIONS[actionId];
	if (entry) throw new HumanOnlyError(humanOnlyMessage(entry.what, entry.where));
}

export class HumanOnlyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HumanOnlyError';
	}
}

/**
 * Dual-identity audit record for a machine-surface mutation (PERM-05 §C).
 *
 * Two identities, deliberately kept apart:
 *   keyIdentity   — which credential was presented. Cryptographically true.
 *   reportedActor — who the caller SAYS they act for. Self-attested, validated
 *                   only to the extent that it names an active BIMS user.
 *
 * Written to AuditLog so it lands in the existing Admin → Agent Activity view.
 */
export async function logMachineActivity(entry: {
	keyIdentity: string;
	reportedActor: string | null;
	channel: MachineChannel;
	tool: string;
	path: string;
	method: string;
	ok: boolean;
	detail?: string;
}): Promise<void> {
	try {
		await connectDB();
		const { AuditLog } = await import('$lib/server/db/models');
		const { generateId } = await import('$lib/server/db/utils');
		await AuditLog.create({
			_id: generateId(),
			tableName: 'machine_activity',
			recordId: entry.tool,
			action: entry.ok ? 'MACHINE_WRITE' : 'MACHINE_WRITE_FAILED',
			newData: {
				keyIdentity: entry.keyIdentity,
				reportedActor: entry.reportedActor,
				attribution: 'self-reported',
				channel: entry.channel,
				tool: entry.tool,
				path: entry.path,
				method: entry.method,
				ok: entry.ok,
				...(entry.detail ? { detail: entry.detail.slice(0, 500) } : {})
			},
			// changedBy carries the authenticated identity, never the claimed one —
			// the claimed human lives in newData.reportedActor and is labelled.
			changedBy: entry.keyIdentity,
			changedAt: new Date()
		});
	} catch (e) {
		// Audit failure must not break the operation it describes.
		console.error('[PERM-05] machine activity log failed (ignored):', e instanceof Error ? e.message : e);
	}
}
