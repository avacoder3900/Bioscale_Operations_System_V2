/**
 * Shared TypeScript types for server-side data passed to Svelte pages.
 * These represent the "serialized" shape (IDs as strings, Dates as Date objects).
 */

export interface Spu {
	id: string;
	udi: string;
	status: string;
	deviceState: string;
	owner: string | null;
	ownerNotes: string | null;
	batchId: string | null;
	batchNumber: string | null;
	createdAt: Date;
	createdByUsername: string | null;
	assignmentType: string | null;
	assignmentCustomerId: string | null;
	customerName: string | null;
	qcStatus: string;
	qcDocumentUrl: string | null;
	assemblyStatus: string;
}
