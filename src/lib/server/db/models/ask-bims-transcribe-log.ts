import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * AskBimsTranscribeLog — per-transcription cost telemetry for voice input
 * (Phase M.1). Tracks audio-duration-based cost on Whisper. No transcript
 * text is stored (raw speech may include PII / wrong-room overhear); only
 * the cost signal needed for the daily cap and the admin dashboard.
 *
 * Caps are enforced workspace-wide. The Whisper rate ($0.006/min for
 * whisper-1) is cheap enough that per-user caps are unnecessary; a $2/day
 * workspace cap covers ~333 min of audio without paying for surprises.
 */
const askBimsTranscribeLogSchema = new Schema({
	_id: { type: String, default: () => generateId() },

	userId: { type: String, required: true, index: true },
	username: String,
	timestamp: { type: Date, required: true, default: () => new Date(), index: true },

	audioDurationSec: { type: Number, default: 0 },
	costUsd: { type: Number, required: true, default: 0 },

	errorClass: String // 'auth' | 'rate_limit' | 'service_unavailable' | 'cap_hit' | 'bad_audio' | etc.
}, { timestamps: false });

askBimsTranscribeLogSchema.index({ timestamp: -1 });

export const AskBimsTranscribeLog =
	mongoose.models.AskBimsTranscribeLog ||
	mongoose.model('AskBimsTranscribeLog', askBimsTranscribeLogSchema, 'ask_bims_transcribe_logs');
