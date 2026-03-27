export const CHECKPOINT_NAMES: Record<number, string> = {
	10: 'Cloud Disconnect',
	11: 'Cloud Disconnect OK',
	12: 'Cloud Connect',
	13: 'Cloud Connect OK',
	14: 'Publish Validate',
	15: 'Publish Validate OK',
	16: 'Publish Load Assay',
	17: 'Publish Load Assay OK',
	18: 'Publish Upload',
	19: 'Publish Upload OK',
	20: 'Publish Reset',
	21: 'Publish Reset OK',
	22: 'Webhook Response Received',
	23: 'Webhook Timeout',
	30: 'BCODE Start',
	31: 'BCODE Complete',
	40: 'Spectro Reading Start',
	41: 'Spectro Reading Complete',
	50: 'File Write Test',
	51: 'File Write Test OK',
	52: 'File Read Assay',
	53: 'File Read Assay OK',
	54: 'File Write Assay',
	55: 'File Write Assay OK',
	60: 'Stage Reset',
	61: 'Stage Reset OK',
	62: 'Barcode Scan',
	63: 'Barcode Scan OK',
	64: 'I2C Bus Init',
	65: 'I2C Bus Init OK',
	70: 'Test Start',
	71: 'Test Hardware Setup',
	80: 'Heater Overheat'
};

export const CRASH_CATEGORIES: Record<string, string> = {
	CLOUD: 'Cloud Operations (connect/disconnect/publish)',
	BCODE: 'Test Protocol Execution',
	I2C: 'Spectrophotometer / I2C Bus',
	FILE_IO: 'Flash File System',
	HARDWARE: 'Hardware (stage/barcode/I2C init)',
	TEST_LIFECYCLE: 'Test Lifecycle',
	HEATER: 'Heater / Temperature Control',
	UNKNOWN: 'Unknown'
};

// Even checkpoint codes = "about to do X", Odd = "X completed OK"
// If the last checkpoint is even, that operation was interrupted (crash/hang/power-loss)
export const isInterruptedCheckpoint = (code: number): boolean => {
	return code % 2 === 0 && code !== 0;
};

export const getCheckpointName = (code: number): string => {
	return CHECKPOINT_NAMES[code] ?? `Unknown (${code})`;
};
