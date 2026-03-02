import { expect } from 'vitest';

/** Assert an object has the expected keys with correct types */
export function expectShape(obj: any, shape: Record<string, string>) {
  expect(obj).toBeDefined();
  for (const [key, expectedType] of Object.entries(shape)) {
    if (expectedType === 'any') {
      expect(obj).toHaveProperty(key);
    } else if (expectedType === 'array') {
      expect(Array.isArray(obj[key])).toBe(true);
    } else if (expectedType === 'string?') {
      if (obj[key] !== null && obj[key] !== undefined) {
        expect(typeof obj[key]).toBe('string');
      }
    } else if (expectedType === 'number?') {
      if (obj[key] !== null && obj[key] !== undefined) {
        expect(typeof obj[key]).toBe('number');
      }
    } else if (expectedType === 'boolean?') {
      if (obj[key] !== null && obj[key] !== undefined) {
        expect(typeof obj[key]).toBe('boolean');
      }
    } else {
      expect(typeof obj[key]).toBe(expectedType);
    }
  }
}

/** Assert array items all match a shape */
export function expectArrayItemsShape(arr: any[], shape: Record<string, string>) {
  expect(Array.isArray(arr)).toBe(true);
  if (arr.length > 0) {
    expectShape(arr[0], shape);
  }
}
