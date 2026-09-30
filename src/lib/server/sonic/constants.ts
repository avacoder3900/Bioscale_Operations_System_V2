/**
 * Sonic fingerprint constants (VALIDATION-08). Carried over unchanged from the
 * prototype C:\Users\aleja\spu-audio\spu_audio.py so BIMS reproduces its numbers.
 * Bump ANALYSIS_VERSION whenever a change here alters stored fingerprints.
 */
export const ANALYSIS_VERSION = 1;

export const SR = 48_000; // everything is analyzed mono at 48 kHz
export const FRAME_S = 0.05; // loudness envelope frame (alignment)
export const BIN_S = 0.5; // time resolution of the over-time series
export const WELCH_NPERSEG = 8192; // ~5.9 Hz resolution
export const SPEC_NPERSEG = 8192;
export const SPEC_HOP = 4096;
export const MIN_FREQ = 50; // ignore mains hum / DC for peaks
export const PSD_MAX_HZ = 16_000; // phone codecs cut above this; not stored
export const FREQ_LO = 100; // dominant-frequency search range (motor tones)
export const FREQ_HI = 2000;

export const BANDS5: ReadonlyArray<readonly [number, number, string]> = [
	[20, 200, '<200 Hz'],
	[200, 1000, '200-1k'],
	[1000, 4000, '1k-4k'],
	[4000, 12000, '4k-12k'],
	[12000, 24000, '>12k']
];
/** 1/3-octave edges, 100 Hz – 12.7 kHz (21 bands). */
export const THIRD_OCT: readonly number[] = Array.from({ length: 22 }, (_, k) => 100 * 2 ** (k / 3));

export const EVENT_RISE_DB = 6; // event = smoothed level this far above the noise floor
export const EVENT_SMOOTH_S = 0.5;
export const EVENT_GAP_S = 1.0; // merge events / phases separated by less than this
export const EVENT_MIN_S = 0.5;
export const ACTIVE_RISE_DB = 6; // a bin is "running" this far above the quiet level

export const MAX_ALIGN_S = 90;
export const PHASE_MIN_S = 3;
export const SECTION_GAP_MIN_S = 5;
export const LEVEL_SMOOTH_S = 2;

export const ENVELOPE_K = 2; // band = mean ± K·σ
export const SIGMA_FLOOR_DB = 1.0; // loudness-shape σ floor
export const SPEC_SIGMA_FLOOR_DB = 1.5; // tone-colour σ floor (per 1/3 octave)
export const PASS_INSIDE_PCT = 90; // a section passes when ≥ this % of points are inside, on both shapes
export const MIN_REFERENCES = 3; // verdict needs at least this many references (excluding the recording)
export const MIN_SPUS_FOR_ENVELOPE = 3; // compare page: SPU + at least 2 others

export const FREQ_MATCH_PCT = 5;
export const EXTREME_PROM_HZ = 25; // label a valley only if the stretch's range is at least this
export const EXTREME_MIN_S = 1.5;
export const TONE_FLAG_DB = 10;
export const TICK_S = 10;
