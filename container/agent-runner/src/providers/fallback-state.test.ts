import { test, expect } from 'bun:test';
import { encodeState, decodeState, type FallbackState } from './fallback-state.js';

const sample: FallbackState = {
  v: 1,
  active: 'codex',
  children: { claude: 'sess-a', codex: 'thread-b' },
  cooldownUntil: '2026-07-17T20:30:00.000Z',
};

test('encode → decode round-trips', () => {
  expect(decodeState(encodeState(sample))).toEqual(sample);
});

test('decode returns null for undefined', () => {
  expect(decodeState(undefined)).toBeNull();
});

test('decode returns null for empty string', () => {
  expect(decodeState('')).toBeNull();
});

test('decode returns null for malformed base64/json', () => {
  expect(decodeState('not-base64-!@#')).toBeNull();
  expect(decodeState(Buffer.from('{not json').toString('base64'))).toBeNull();
});

test('decode returns null for unknown version', () => {
  const bad = Buffer.from(JSON.stringify({ ...sample, v: 2 })).toString('base64');
  expect(decodeState(bad)).toBeNull();
});
