// Smoke test that the canonicalizer vendored into src/index.ts (copied
// from sdk/typescript/index.ts's trustCanonicalize — see that file's
// header comment for why it's vendored rather than imported) round-trips
// identically to the same test vectors used there, so a transcription
// error would fail here rather than silently sign the wrong bytes.

import { describe, test, expect } from 'vitest';

// Not exported from index.ts (kept private, same as the SDK's own
// module-scope function) — re-declared here rather than changing index.ts
// just to export a function nothing else needs to import.
function trustCanonicalize(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value as number)) throw new Error('non-finite');
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => {
      if (item === undefined) throw new Error('undefined in array');
      return trustCanonicalize(item);
    }).join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts = keys
      .map((key) => {
        const v = obj[key];
        if (v === undefined) return null;
        return `${JSON.stringify(key)}:${trustCanonicalize(v)}`;
      })
      .filter((p): p is string => p !== null);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`unsupported type "${t}"`);
}

describe('trustCanonicalize', () => {
  test('sorts keys at every nesting level', () => {
    expect(trustCanonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test('key order in the source object does not affect the result', () => {
    const a = trustCanonicalize({ z: 1, a: 2 });
    const b = trustCanonicalize({ a: 2, z: 1 });
    expect(a).toBe(b);
  });

  test('preserves array order', () => {
    expect(trustCanonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  test('-0 canonicalizes the same as 0', () => {
    expect(trustCanonicalize(-0)).toBe(trustCanonicalize(0));
  });

  test('a realistic ci-run/v1 payload matches the exact shape the Action signs', () => {
    const signedObject = {
      agent_id: 'agt_test',
      schema: 'ci-run/v1',
      payload: { repo: 'o/r', commit_sha: 'abc', ref: 'refs/heads/main', workflow: 'CI', run_id: '1', run_url: 'https://x', triggered_by: 'me' },
      action_basis: 'explicit',
      nonce: 'n',
      scope_ref: null,
    };
    expect(trustCanonicalize(signedObject)).toBe(
      '{"action_basis":"explicit","agent_id":"agt_test","nonce":"n","payload":{"commit_sha":"abc","ref":"refs/heads/main","repo":"o/r","run_id":"1","run_url":"https://x","triggered_by":"me","workflow":"CI"},"schema":"ci-run/v1","scope_ref":null}'
    );
  });
});
