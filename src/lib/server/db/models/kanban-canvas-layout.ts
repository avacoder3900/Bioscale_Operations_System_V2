import mongoose, { Schema } from 'mongoose';

/**
 * KB2-30 — pinned positions on the roadmap canvas. `_id` IS the task id.
 * Presentation-only state, deliberately outside the task documents: no task
 * audit noise, no schema creep. SHARED layout (one canonical arrangement,
 * Miro model) — `pinnedBy` keeps accountability. Auto-layout (dagre) places
 * anything without a row here; dragging a node upserts one. The `relayout`
 * action deletes all rows (that one IS audit-logged — it destroys a shared
 * arrangement). Per-drag saves are exempt from AuditLog by design (KB2-30):
 * high-frequency presentation writes.
 */
const kanbanCanvasLayoutSchema = new Schema(
	{
		_id: { type: String }, // task _id
		x: { type: Number, required: true },
		y: { type: Number, required: true },
		pinnedBy: String
	},
	{ timestamps: true }
);

export const KanbanCanvasLayout =
	mongoose.models.KanbanCanvasLayout ||
	mongoose.model('KanbanCanvasLayout', kanbanCanvasLayoutSchema, 'kanban_canvas_layout');
