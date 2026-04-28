// ─────────────────────────────────────────────────────────────────────────
// StructCodec — dictionary-based compression. First occurrence is a
// literal; later occurrences compress to a numeric ref or a delta.
// compactTree/expandTree are the standalone (no-mutation-state) form.
// ─────────────────────────────────────────────────────────────────────────

import { StructCodec, compactTree, expandTree, djb2 } from '../index.js';

export default async (test: (name: string, body: (validator: any) => any) => any) => {
  await test('first encode is a literal', async (validator: any) => {
    const codec = new StructCodec();
    const encoded = codec.encode({ x: 1, y: 2 });
    return validator.expect(typeof encoded === 'object' && encoded !== null && 'v' in (encoded as any)).toLookLike(true);
  });

  await test('repeated structure compresses to a numeric ref', async (validator: any) => {
    const codec = new StructCodec();
    codec.encode({ x: 1, y: 2 });
    const second = codec.encode({ x: 1, y: 2 });
    return validator.expect(typeof second === 'number').toLookLike(true);
  });

  await test('decoding a ref reproduces the original value', async (validator: any) => {
    const codec = new StructCodec();
    codec.encode({ name: 'alpha', kind: 'sample' });
    const ref = codec.encode({ name: 'alpha', kind: 'sample' });
    const decoded = codec.decode(ref);
    return validator.expect(decoded).toLookLike({ name: 'alpha', kind: 'sample' });
  });

  await test('similar-but-different structure does not re-emit a full literal', async (validator: any) => {
    const codec = new StructCodec();
    codec.encode({ name: 'alice', role: 'admin', active: true });
    const delta = codec.encode({ name: 'alice', role: 'admin', active: false });
    const isLit = typeof delta === 'object' && delta !== null && 'v' in (delta as any);
    return validator.expect(isLit).toLookLike(false);
  });

  await test('delta decode reconstructs the exact value', async (validator: any) => {
    const codec = new StructCodec();
    codec.encode({ name: 'alice', role: 'admin', active: true });
    const delta = codec.encode({ name: 'alice', role: 'admin', active: false });
    const decoded = codec.decode(delta);
    return validator
      .expect({ name: decoded.name, role: decoded.role, active: decoded.active })
      .toLookLike({ name: 'alice', role: 'admin', active: false });
  });

  await test('compactTree → expandTree round-trips arbitrary nested structure', async (validator: any) => {
    const source = {
      users: [
        { role: 'admin', perms: ['read', 'write'] },
        { role: 'admin', perms: ['read', 'write'] },
        { role: 'user', perms: ['read'] },
      ],
    };
    const compacted = compactTree(source);
    const expanded = expandTree(compacted);
    return validator.expect(expanded).toLookLike(source);
  });

  await test('compactTree dedups duplicate substructure into the dict', async (validator: any) => {
    const source = {
      a: { kind: 'point', x: 1, y: 2 },
      b: { kind: 'point', x: 1, y: 2 },
    };
    const compacted = compactTree(source);
    return validator.expect(compacted.dict.length >= 1).toLookLike(true);
  });

  await test('djb2 is deterministic', async (validator: any) => {
    return validator.expect(djb2('hello world') === djb2('hello world')).toLookLike(true);
  });

  await test('djb2 differs on case change', async (validator: any) => {
    return validator.expect(djb2('hello world') !== djb2('hello worlD')).toLookLike(true);
  });

  await test('djb2 returns a non-empty string', async (validator: any) => {
    const out = djb2('xyz');
    return validator.expect(typeof out === 'string' && out.length > 0).toLookLike(true);
  });
};
