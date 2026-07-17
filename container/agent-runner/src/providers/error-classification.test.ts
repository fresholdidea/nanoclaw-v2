import { test, expect } from 'bun:test';
import { classifyFailure, classifyMessage } from './error-classification.js';
import type { ProviderEvent } from './types.js';

test('quota error event triggers', () => {
  const e: ProviderEvent = { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' };
  expect(classifyFailure(e)).toBe('quota');
});

test('retryable error never triggers', () => {
  const e: ProviderEvent = { type: 'error', message: 'API retry', retryable: true };
  expect(classifyFailure(e)).toBeNull();
});

test('non-trigger classification does not fall back', () => {
  const e: ProviderEvent = { type: 'error', message: 'boom', retryable: false, classification: 'unknown' };
  expect(classifyFailure(e)).toBeNull();
});

test('isError result classified from text (billing)', () => {
  const e: ProviderEvent = { type: 'result', text: 'Your credit balance is too low (billing_error)', isError: true };
  expect(classifyFailure(e)).toBe('billing');
});

test('isError result classified from text (auth)', () => {
  const e: ProviderEvent = { type: 'result', text: 'Not logged in · Please run /login', isError: true };
  expect(classifyFailure(e)).toBe('auth');
});

test('successful result never triggers', () => {
  const e: ProviderEvent = { type: 'result', text: 'hello', isError: false };
  expect(classifyFailure(e)).toBeNull();
});

test('classifyMessage maps keywords', () => {
  expect(classifyMessage('unauthorized')).toBe('auth');
  expect(classifyMessage('usage limit reached')).toBe('quota');
  expect(classifyMessage('billing_error')).toBe('billing');
  expect(classifyMessage('something else')).toBeNull();
});
