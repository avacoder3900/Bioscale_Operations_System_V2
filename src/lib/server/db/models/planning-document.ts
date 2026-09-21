import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * KB2-27 — immortalized strategy documents. A PlanningDocument is the
 * finalized output of a Claude-app workshop (e.g. "Fall 2026 Roadmap — v4"),
 * filed verbatim with a timestamp BEFORE the tasks it spawns are captured, so
 * every spawned task can carry `source: 'plan'` + `sourceRef: 'plan:<_id>'`
 * and provenance is queryable both ways.
 *
 * Append-mostly: `content` is never edited after filing — file a new version
 * and let `supersedes` chain them. The only in-place mutation is the
 * active → superseded status flip when a successor is filed.
 */
const planningDocumentSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		title: { type: String, required: true },
		version: String, // free string, e.g. "v4"
		content: { type: String, required: true }, // full markdown, verbatim
		context: String, // one-para: what question the workshop answered
		status: { type: String, enum: ['active', 'superseded'], default: 'active' },
		supersedes: String, // PlanningDocument _id this one replaces
		authoredBy: String, // human username the workshop was on behalf of
		filedVia: { type: String, enum: ['mcp', 'ui', 'agent-api'], default: 'mcp' },
		// KB2-39: the milestone task this plan workshopped. A plan and a chain
		// are the same object at two moments (rationale vs live DAG) — this is
		// the link that collapses them. Set at filing (kanban_file_plan
		// milestoneId) or by scripts/backfill-plan-milestones.ts.
		milestoneId: String
	},
	{ timestamps: true }
);

planningDocumentSchema.index({ status: 1, createdAt: -1 });
planningDocumentSchema.index({ milestoneId: 1 });

export const PlanningDocument =
	mongoose.models.PlanningDocument ||
	mongoose.model('PlanningDocument', planningDocumentSchema, 'planning_documents');
