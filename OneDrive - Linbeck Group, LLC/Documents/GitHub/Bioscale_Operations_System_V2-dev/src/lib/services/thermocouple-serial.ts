/**
 * Thermocouple Serial Service (THERM-003)
 *
 * Client-side service for reading thermocouple data via USB serial connection.
 * Uses Web Serial API to communicate with thermocouple devices.
 */

/**
 * Temperature reading from the thermocouple
 */
export interface TemperatureReading {
	timestamp: number;
	temperature: number;
	unit: 'C' | 'F' | 'K';
}

/**
 * Connection state for the serial port
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Event types emitted by the ThermocoupleSerial class
 */
export type ThermocoupleSerialEvent =
	| { type: 'connected' }
	| { type: 'disconnected' }
	| { type: 'error'; error: Error }
	| { type: 'reading'; reading: TemperatureReading }
	| { type: 'state'; state: ConnectionState };

/**
 * Event listener callback type
 */
export type ThermocoupleSerialListener = (event: ThermocoupleSerialEvent) => void;

/**
 * Serial configuration for thermocouple devices
 */
export interface ThermocoupleSerialConfig {
	baudRate: number;
	dataBits?: 7 | 8;
	stopBits?: 1 | 2;
	parity?: 'none' | 'even' | 'odd';
	temperatureUnit?: 'C' | 'F' | 'K';
}

const DEFAULT_CONFIG: ThermocoupleSerialConfig = {
	baudRate: 9600,
	dataBits: 8,
	stopBits: 1,
	parity: 'none',
	temperatureUnit: 'C'
};

/**
 * ThermocoupleSerial class for managing USB serial connections to thermocouples.
 *
 * Usage:
 * ```ts
 * const thermo = new ThermocoupleSerial();
 * thermo.addEventListener((event) => {
 *   if (event.type === 'reading') {
 *     console.log('Temperature:', event.reading.temperature);
 *   }
 * });
 * await thermo.connect();
 * // ... readings will stream in via events
 * await thermo.disconnect();
 * ```
 */
export class ThermocoupleSerial {
	private port: SerialPort | null = null;
	private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	private readLoop: Promise<void> | null = null;
	private listeners: Set<ThermocoupleSerialListener> = new Set();
	private _state: ConnectionState = 'disconnected';
	private config: ThermocoupleSerialConfig;
	private buffer: string = '';
	private readings: TemperatureReading[] = [];

	constructor(config: Partial<ThermocoupleSerialConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Current connection state
	 */
	get state(): ConnectionState {
		return this._state;
	}

	/**
	 * Whether Web Serial API is supported in this browser
	 */
	static isSupported(): boolean {
		return typeof navigator !== 'undefined' && 'serial' in navigator;
	}

	/**
	 * Add an event listener
	 */
	addEventListener(listener: ThermocoupleSerialListener): void {
		this.listeners.add(listener);
	}

	/**
	 * Remove an event listener
	 */
	removeEventListener(listener: ThermocoupleSerialListener): void {
		this.listeners.delete(listener);
	}

	/**
	 * Emit an event to all listeners
	 */
	private emit(event: ThermocoupleSerialEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (err) {
				console.error('Error in thermocouple serial listener:', err);
			}
		}
	}

	/**
	 * Update connection state and emit event
	 */
	private setState(state: ConnectionState): void {
		this._state = state;
		this.emit({ type: 'state', state });
	}

	/**
	 * Request a serial port and connect to the thermocouple
	 */
	async connect(): Promise<void> {
		if (!ThermocoupleSerial.isSupported()) {
			throw new Error('Web Serial API is not supported in this browser');
		}

		if (this._state === 'connected' || this._state === 'connecting') {
			return;
		}

		this.setState('connecting');

		try {
			// Request port from user
			this.port = await navigator.serial!.requestPort();

			// Open with configured settings
			await this.port.open({
				baudRate: this.config.baudRate
			});

			this.setState('connected');
			this.emit({ type: 'connected' });

			// Start reading data
			this.startReading();
		} catch (err) {
			this.setState('error');
			const error = err instanceof Error ? err : new Error(String(err));
			this.emit({ type: 'error', error });
			throw error;
		}
	}

	/**
	 * Start the read loop for incoming serial data
	 */
	private startReading(): void {
		if (!this.port?.readable) {
			return;
		}

		this.readLoop = this.readLoopAsync();
	}

	/**
	 * Async read loop that continuously reads from the serial port
	 */
	private async readLoopAsync(): Promise<void> {
		if (!this.port?.readable) {
			return;
		}

		const reader = this.port.readable.getReader();
		this.reader = reader;
		const decoder = new TextDecoder();

		try {
			while (true) {
				const { value, done } = await reader.read();

				if (done) {
					break;
				}

				if (value) {
					// Decode and buffer the data
					this.buffer += decoder.decode(value, { stream: true });

					// Process complete lines
					this.processBuffer();
				}
			}
		} catch (err) {
			// Read errors during disconnect are expected
			if (this._state === 'connected') {
				const error = err instanceof Error ? err : new Error(String(err));
				this.emit({ type: 'error', error });
			}
		} finally {
			this.reader?.releaseLock();
			this.reader = null;
		}
	}

	/**
	 * Process the data buffer, extracting complete lines and parsing readings
	 */
	private processBuffer(): void {
		const lines = this.buffer.split('\n');

		// Keep the last incomplete line in the buffer
		this.buffer = lines.pop() || '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed) {
				const reading = this.parseLine(trimmed);
				if (reading) {
					this.readings.push(reading);
					this.emit({ type: 'reading', reading });
				}
			}
		}
	}

	/**
	 * Parse a line of thermocouple data into a structured reading.
	 *
	 * Supports multiple formats:
	 * - Simple: "25.5" (just temperature)
	 * - With unit: "25.5C" or "25.5 C" or "25.5°C"
	 * - CSV: "timestamp,temperature" or "timestamp,temperature,unit"
	 * - JSON: {"temperature": 25.5, "unit": "C", ...}
	 * - Labeled: "T:25.5" or "TEMP:25.5"
	 */
	private parseLine(line: string): TemperatureReading | null {
		try {
			// Try JSON format first
			if (line.startsWith('{')) {
				const data = JSON.parse(line);
				const temp = Number(data.temperature ?? data.temp ?? data.T ?? data.t);
				if (isNaN(temp)) return null;

				let unit = this.config.temperatureUnit || 'C';
				if (data.unit) {
					const u = String(data.unit).toUpperCase().replace('°', '');
					if (u === 'C' || u === 'F' || u === 'K') unit = u;
				}

				return {
					timestamp: data.timestamp ?? Date.now(),
					temperature: temp,
					unit
				};
			}

			// Try CSV format
			if (line.includes(',')) {
				const parts = line.split(',').map((p) => p.trim());

				if (parts.length >= 2) {
					const first = Number(parts[0]);
					const second = Number(parts[1]);

					// If first looks like timestamp (large number)
					if (first > 1000000000 && !isNaN(second)) {
						return {
							timestamp: first,
							temperature: second,
							unit: this.parseUnit(parts[2]) || this.config.temperatureUnit || 'C'
						};
					}

					// Otherwise first is temperature
					if (!isNaN(first)) {
						return {
							timestamp: Date.now(),
							temperature: first,
							unit: this.parseUnit(parts[1]) || this.config.temperatureUnit || 'C'
						};
					}
				}
			}

			// Try labeled format (T:25.5 or TEMP:25.5)
			const labeledMatch = line.match(/^(?:T|TEMP|TEMPERATURE)\s*[:=]\s*([\d.+-]+)\s*([CFKcfk°]*)/i);
			if (labeledMatch) {
				const temp = Number(labeledMatch[1]);
				if (!isNaN(temp)) {
					return {
						timestamp: Date.now(),
						temperature: temp,
						unit: this.parseUnit(labeledMatch[2]) || this.config.temperatureUnit || 'C'
					};
				}
			}

			// Try simple number with optional unit (25.5 or 25.5C or 25.5 °C)
			const simpleMatch = line.match(/^([\d.+-]+)\s*([°]?\s*[CFKcfk])?$/);
			if (simpleMatch) {
				const temp = Number(simpleMatch[1]);
				if (!isNaN(temp)) {
					return {
						timestamp: Date.now(),
						temperature: temp,
						unit: this.parseUnit(simpleMatch[2]) || this.config.temperatureUnit || 'C'
					};
				}
			}

			return null;
		} catch {
			// Failed to parse line
			return null;
		}
	}

	/**
	 * Parse temperature unit from string
	 */
	private parseUnit(unitStr: string | undefined): 'C' | 'F' | 'K' | null {
		if (!unitStr) return null;
		const u = unitStr.toUpperCase().replace('°', '').trim();
		if (u === 'C' || u === 'F' || u === 'K') return u;
		return null;
	}

	/**
	 * Read a single burst of data (waits for specified number of readings)
	 */
	async read(count: number = 10, timeoutMs: number = 10000): Promise<TemperatureReading[]> {
		return new Promise((resolve, reject) => {
			const readings: TemperatureReading[] = [];
			const timeout = setTimeout(() => {
				this.removeEventListener(listener);
				if (readings.length > 0) {
					resolve(readings);
				} else {
					reject(new Error('Timeout waiting for thermocouple readings'));
				}
			}, timeoutMs);

			const listener: ThermocoupleSerialListener = (event) => {
				if (event.type === 'reading') {
					readings.push(event.reading);
					if (readings.length >= count) {
						clearTimeout(timeout);
						this.removeEventListener(listener);
						resolve(readings);
					}
				} else if (event.type === 'error') {
					clearTimeout(timeout);
					this.removeEventListener(listener);
					reject(event.error);
				}
			};

			this.addEventListener(listener);
		});
	}

	/**
	 * Get all readings captured so far
	 */
	getReadings(): TemperatureReading[] {
		return [...this.readings];
	}

	/**
	 * Clear captured readings
	 */
	clearReadings(): void {
		this.readings = [];
	}

	/**
	 * Disconnect from the thermocouple
	 */
	async disconnect(): Promise<void> {
		if (this._state === 'disconnected') {
			return;
		}

		try {
			// Cancel the reader to stop the read loop
			if (this.reader) {
				await this.reader.cancel();
				this.reader.releaseLock();
				this.reader = null;
			}

			// Wait for read loop to finish
			if (this.readLoop) {
				await this.readLoop;
				this.readLoop = null;
			}

			// Close the port
			if (this.port) {
				await this.port.close();
				this.port = null;
			}

			this.setState('disconnected');
			this.emit({ type: 'disconnected' });
		} catch (err) {
			// Errors during disconnect are usually fine
			console.warn('Error during thermocouple disconnect:', err);
			this.setState('disconnected');
			this.emit({ type: 'disconnected' });
		}
	}
}

/**
 * Create a new ThermocoupleSerial instance with default configuration
 */
export function createThermocoupleSerial(
	config?: Partial<ThermocoupleSerialConfig>
): ThermocoupleSerial {
	return new ThermocoupleSerial(config);
}
