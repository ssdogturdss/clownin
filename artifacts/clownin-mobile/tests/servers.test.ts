import { describe, it, expect } from 'bun:test';
import { clearServerTestResult, type ServerTestResult } from '../lib/serverTestResults';

describe('clearServerTestResult', () => {
  const result1: ServerTestResult = { ok: true, testedAt: 1_000 };
  const result2: ServerTestResult = { ok: false, error: 'ECONNREFUSED', testedAt: 2_000 };
  const result3: ServerTestResult = { ok: true, testedAt: 3_000 };

  it('removes only the edited server result when multiple results exist', () => {
    const results: Record<number, ServerTestResult> = { 1: result1, 2: result2, 3: result3 };
    const next = clearServerTestResult(results, 2);
    expect(next[2]).toBeUndefined();
    expect(next[1]).toEqual(result1);
    expect(next[3]).toEqual(result3);
  });

  it('leaves other server results completely intact', () => {
    const results: Record<number, ServerTestResult> = { 10: result1, 20: result2 };
    const next = clearServerTestResult(results, 10);
    expect(Object.keys(next)).toEqual(['20']);
    expect(next[20]).toEqual(result2);
  });

  it('returns an empty map when the only result belongs to the edited server', () => {
    const results: Record<number, ServerTestResult> = { 5: result1 };
    const next = clearServerTestResult(results, 5);
    expect(Object.keys(next)).toHaveLength(0);
  });

  it('returns the map unchanged when the server has no existing result', () => {
    const results: Record<number, ServerTestResult> = { 7: result1, 8: result2 };
    const next = clearServerTestResult(results, 99);
    expect(next[7]).toEqual(result1);
    expect(next[8]).toEqual(result2);
    expect(Object.keys(next)).toHaveLength(2);
  });

  it('does not mutate the original results map', () => {
    const results: Record<number, ServerTestResult> = { 1: result1, 2: result2 };
    const snapshot = { ...results };
    clearServerTestResult(results, 1);
    expect(results[1]).toEqual(snapshot[1]);
    expect(results[2]).toEqual(snapshot[2]);
    expect(Object.keys(results)).toHaveLength(2);
  });
});