/**
 * Magnetometer Serial Service (MAG-003)
 *
 * Client-side service for reading magnetometer data via Bluetooth serial connection.
 * Uses Web Serial API to communicate with magnetometer devices that present as serial ports.
 */

/**
 * Raw magnetometer reading from the device
 */
export interface MagnetometerReading {
	timestamp: number;
	x: number;
	y: number;
	z: number;
	magnitude: number;
	temperature?: number;
}

/**
 * Connection state for the serial port
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Event types emitted by the MagnetometerSerial class
 */
export type MagnetometerSerialEvent =
	| { type: 'connected' }
	| { type: 'disconnected' }
	| { type: 'error'; error: Error }
	| { type: 'reading'; reading: MagnetometerReading }
	| { type: 'state'; state: ConnectionState };

/**
 * Event listener callback type
 */
export type MagnetometerSerialListener = (event: MagnetometerSerialEvent) => void;

/**
 * Serial configuration for magnetometer devices
 */
export interface MagnetometerSerialConfig {
	baudRate: number;
	dataBits?: 7 | 8;
	stopBits?: 1 | 2;
	parity?: 'none' | 'even' | 'odd';
}

const DEFAULT_CONFIG: MagnetometerSerialConfig = {
	baudRate: 115200,
	dataBits: 8,
	stopBits: 1,
	parity: 'none'
};

/**
 * MagnetometerSerial class for managing Bluetooth serial connections to magnetometers.
 *
 * Usage:
 * ```ts
 * const mag = new MagnetometerSerial();
 * mag.addEventListener((event) => {
 *   if (event.type === 'reading') {
 *     console.log('Reading:', event.reading);
 *   }
 * });
 * await mag.connect();
 * // ... readings will stream in via events
 * await mag.disconnect();
 * ```
 */
export class MagnetometerSerial {
	private port: SerialPort | null = null;
	private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	private readLoop: Promise<void> | null = null;
	private listeners: Set<MagnetometerSerialListener> = new Set();
	private _state: ConnectionState = 'disconnected';
	private config: MagnetometerSerialConfig;
	private buffer: string = '';
	private readings: MagnetometerReading[] = [];

	constructor(config: Partial<MagnetometerSerialConfig> = {}) {
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
	addEventListener(listener: MagnetometerSerialListener): void {
		this.listeners.add(listener);
	}

	/**
	 * Remove an event listener
	 */
	removeEventListener(listener: MagnetometerSerialListener): void {
		this.listeners.delete(listener);
	}

	/**
	 * Emit an event to all listeners
	 */
	private emit(event: MagnetometerSerialEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (err) {
				console.error('Error in magnetometer serial listener:', err);
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
	 * Request a serial port and connect to the magnetometer
	 */
	async connect(): Promise<void> {
		if (!MagnetometerSerial.isSupported()) {
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

		this.reader = this.port.readable.getReader();
		const decoder = new TextDecoder();

		try {
			while (true) {
				const { value, done } = await this.reader.read();

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
	 * Parse a line of magnetometer data into a structured reading.
	 *
	 * Supports multiple formats:
	 * - CSV: "timestamp,x,y,z" or "timestamp,x,y,z,temp"
	 * - JSON: {"x": 1.0, "y": 2.0, "z": 3.0, ...}
	 * - Space-separated: "x y z" or "timestamp x y z"
	 */
	private parseLine(line: string): MagnetometerReading | null {
		try {
			// Try JSON format first
			if (line.startsWith('{')) {
				const data = JSON.parse(line);
				const x = Number(data.x ?? data.X ?? 0);
				const y = Number(data.y ?? data.Y ?? 0);
				const z = Number(data.z ?? data.Z ?? 0);
				const magnitude = Math.sqrt(x * x + y * y + z * z);

				return {
					timestamp: data.timestamp ?? Date.now(),
					x,
					y,
					z,
					magnitude,
					temperature: data.temp ?? data.temperature
				};
			}

			// Try CSV format
			if (line.includes(',')) {
				const parts = line.split(',').map((p) => p.trim());

				if (parts.length >= 3) {
					let x: number, y: number, z: number;
					let timestamp = Date.now();
					let temperature: number | undefined;

					if (parts.length === 3) {
						// x,y,z
						[x, y, z] = parts.map(Number);
					} else if (parts.length === 4) {
						// timestamp,x,y,z or x,y,z,temp
						const firstPart = Number(parts[0]);
						if (firstPart > 1000000000) {
							// Looks like a timestamp
							timestamp = firstPart;
							[, x, y, z] = parts.map(Number);
						} else {
							[x, y, z, temperature] = parts.map(Number);
						}
					} else {
						// timestamp,x,y,z,temp
						[timestamp, x, y, z, temperature] = parts.map(Number) as [
							number,
							number,
							number,
							number,
							number
						];
					}

					const magnitude = Math.sqrt(x * x + y * y + z * z);

					return {
						timestamp,
						x,
						y,
						z,
						magnitude,
						temperature
					};
				}
			}

			// Try space-separated format
			const parts = line.split(/\s+/).map(Number);
			if (parts.length >= 3 && parts.every((p) => !isNaN(p))) {
				let x: number, y: number, z: number;
				let timestamp = Date.now();

				if (parts.length === 3) {
					[x, y, z] = parts;
				} else {
					[timestamp, x, y, z] = parts;
				}

				const magnitude = Math.sqrt(x * x + y * y + z * z);

				return {
					timestamp,
					x,
					y,
					z,
					magnitude
				};
			}

			return null;
		} catch {
			// Failed to parse line
			return null;
		}
	}

	/**
	 * Read a single burst of data (waits for specified number of readings)
	 */
	async read(count: number = 10, timeoutMs: number = 5000): Promise<MagnetometerReading[]> {
		return new Promise((resolve, reject) => {
			const readings: MagnetometerReading[] = [];
			const timeout = setTimeout(() => {
				this.removeEventListener(listener);
				if (readings.length > 0) {
					resolve(readings);
				} else {
					reject(new Error('Timeout waiting for magnetometer readings'));
				}
			}, timeoutMs);

			const listener: MagnetometerSerialListener = (event) => {
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
	getReadings(): MagnetometerReading[] {
		return [...this.readings];
	}

	/**
	 * Clear captured readings
	 */
	clearReadings(): void {
		this.readings = [];
	}

	/**
	 * Disconnect from the magnetometer
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
			console.warn('Error during magnetometer disconnect:', err);
			this.setState('disconnected');
			this.emit({ type: 'disconnected' });
		}
	}
}

/**
 * Create a new MagnetometerSerial instance with default configuration
 */
export function createMagnetometerSerial(
	config?: Partial<MagnetometerSerialConfig>
): MagnetometerSerial {
	return new MagnetometerSerial(config);
}
