import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const equipmentSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: String, equipmentType: { type: String, enum: ['fridge', 'oven', 'robot', 'deck', 'cooling_tray'] },
	barcode: String, capacity: Number,
	location: String, status: { type: String, enum: ['active', 'maintenance', 'offline', 'available', 'in_use', 'retired'] },
	// Fridge/oven specific
	mocreoDeviceId: String, mocreoAssetId: String,
	temperatureMinC: Number, temperatureMaxC: Number,
	currentTemperatureC: Number, lastTemperatureReadAt: Date,
	alertsEnabled: { type: Boolean, default: false },
	connectionTimeoutMinutes: { type: Number, default: 30 },
	notes: String,
	// Robot specific (mirrored from opentrons_robots for manufacturing use)
	ip: String, port: Number, robotSide: String,
	isActive: { type: Boolean, default: true },
	lastHealthOk: Boolean, lastHealthAt: Date,
	// Deck specific
	currentRobotId: String, lockoutUntil: Date, lastUsed: Date,
	// Deck QR alias (DECK-QR): a QR/UUID (same format as cartridge barcodes) stuck
	// on the deck at a consistent spot. The gantry auto-scan reads this; it
	// resolves to the deck's canonical _id (e.g. DECK-004). Scan either one.
	qrCode: { type: String, index: true },
	// Deck geometry binding (DECK-CAL). The robot chooses which cartridge-deck
	// labware definition to load from a Particle device id it reads over USB
	// serial; BIMS separately asks the operator to pick a deck. Nothing used to
	// connect the two, so calibrating "DECK-001" could correct a definition the
	// robot never loads. These two fields are that connection, and the run-start
	// guard refuses a fill when they disagree.
	/** loadName of this deck's labware definition, e.g. gen4deck_gen7cartridge_004. */
	deckLoadName: { type: String, index: true },
	/** Particle device id embedded in the physical deck, read by the protocol. */
	particleDeviceId: { type: String, index: true },
	// Archival (decks are never deleted — run history references them).
	archivedAt: { type: Date, default: null },
	archivedBy: String,
	archivedReason: String,
	// Cooling tray specific
	assignedRunId: String,
	// Usage log (shared by deck/tray)
	usageLog: [{
		_id: { type: String, default: () => generateId() },
		usageType: String, runId: String, quantityChanged: Number,
		operator: { _id: String, username: String }, notes: String, createdAt: Date
	}]
}, { timestamps: true });

export const Equipment = mongoose.models.Equipment || mongoose.model('Equipment', equipmentSchema, 'equipment');
