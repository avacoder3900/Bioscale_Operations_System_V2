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

/** Represents a Consumable document of type 'deck'. _id is used as deckId. */
export interface DeckRecord {
	deckId: string;
	status: string;
	currentRobotId: string | null;
	lockoutUntil: Date | string | null;
	lastUsed: Date | string | null;
	createdAt: Date | string;
	updatedAt: Date | string;
}

/** Represents a Consumable document of type 'cooling_tray'. _id is used as trayId. */
export interface CoolingTrayRecord {
	trayId: string;
	status: string;
	assignedRunId: string | null;
	createdAt: Date | string;
	updatedAt: Date | string;
}

/** Rejection reason code stored in ManufacturingSettings */
export interface RejectionReasonCode {
	id: string;
	code: string;
	label: string;
	processType: string;
	sortOrder: number;
}
