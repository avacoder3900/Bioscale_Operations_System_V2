// Web Serial API type declarations
// These extend the browser's Navigator interface to include the Serial API

interface SerialPortInfo {
	usbVendorId?: number;
	usbProductId?: number;
}

interface SerialPortRequestOptions {
	filters?: SerialPortInfo[];
}

interface SerialOptions {
	baudRate: number;
	dataBits?: 5 | 6 | 7 | 8;
	stopBits?: 1 | 2;
	parity?: 'none' | 'even' | 'odd';
	bufferSize?: number;
	flowControl?: 'none' | 'hardware';
}

interface SerialPort extends EventTarget {
	open(options: SerialOptions): Promise<void>;
	close(): Promise<void>;
	readonly readable: ReadableStream<Uint8Array> | null;
	readonly writable: WritableStream<Uint8Array> | null;
	getInfo(): SerialPortInfo;
}

interface Serial extends EventTarget {
	requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
	getPorts(): Promise<SerialPort[]>;
}

interface Navigator {
	readonly serial: Serial;
}
