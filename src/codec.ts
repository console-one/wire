import { djb2 } from './registry.js';

// ── Encoded format ──────────────────────────────────────────────────────────
// Four forms, unambiguously distinguishable:
//   number        → REF:    exact match at dict[n]
//   { b, d }      → DELTA:  like dict[b], except Diff
//   { v }         → LITERAL: raw value, no compression
//   { nd }        → NESTED: recursive diff applied to corresponding base field

export type Diff = {
  s?: [string, Encoded][];   // SET: changed/added fields
  r?: string[];              // REMOVE: deleted fields
};

export type EncodedRef    = number;
export type EncodedDelta  = { b: number; d: Diff };
export type EncodedLit    = { v: any };
export type EncodedNested = { nd: Diff };
export type Encoded = EncodedRef | EncodedDelta | EncodedLit | EncodedNested;

export type CodecSnapshot = { v: 1; dict: any[]; maxSize: number };

// ── Helpers ─────────────────────────────────────────────────────────────────

function isPlainObject(x: any): x is Record<string, any> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function clone(value: any): any {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  const out: any = {};
  for (const k of Object.keys(value)) out[k] = clone(value[k]);
  return out;
}

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;

  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function hashValue(value: any): string {
  return djb2(JSON.stringify(value));
}

function isRef(e: Encoded): e is EncodedRef { return typeof e === 'number'; }
function isDelta(e: Encoded): e is EncodedDelta {
  return isPlainObject(e) && typeof (e as any).b === 'number' && (e as any).d !== undefined;
}
function isLiteral(e: Encoded): e is EncodedLit {
  return isPlainObject(e) && 'v' in (e as any) && !isDelta(e) && !isNested(e);
}
function isNested(e: Encoded): e is EncodedNested {
  return isPlainObject(e) && 'nd' in (e as any) && !isDelta(e);
}

// ── Codec ───────────────────────────────────────────────────────────────────

export class StructCodec {
  private dict: any[] = [];
  private index: Map<string, number[]> = new Map(); // hash → candidate indices
  private maxSize: number;

  constructor(opts?: { maxSize?: number }) {
    this.maxSize = opts?.maxSize ?? 256;
  }

  get size(): number { return this.dict.length; }

  reset(): void {
    this.dict = [];
    this.index = new Map();
  }

  fork(): StructCodec {
    const child = new StructCodec({ maxSize: this.maxSize });
    child.dict = this.dict.slice();
    child.index = new Map();
    for (const [k, v] of this.index) child.index.set(k, v.slice());
    return child;
  }

  toJSON(): CodecSnapshot {
    return { v: 1, dict: clone(this.dict), maxSize: this.maxSize };
  }

  static fromJSON(snap: CodecSnapshot): StructCodec {
    if (snap.v !== 1) throw new Error('Unsupported codec snapshot version');
    const codec = new StructCodec({ maxSize: snap.maxSize });
    codec.dict = clone(snap.dict);
    codec.rebuildIndex();
    return codec;
  }

  // ── Encode ──────────────────────────────────────────────────────────────

  encode(value: any, basis?: any): Encoded {
    // 1. Exact match check
    const exactIdx = this.findExact(value);
    if (exactIdx !== -1) {
      this.addToDict(value);
      return exactIdx;
    }

    // 2. For non-objects/arrays, emit literal
    if (!isPlainObject(value) && !Array.isArray(value)) {
      this.addToDict(value);
      return { v: value };
    }

    // 3. Try delta encoding
    let bestDelta: EncodedDelta | null = null;
    let bestDeltaSize = Infinity;

    // Try explicit basis first
    if (basis !== undefined) {
      const basisIdx = this.findExact(basis);
      if (basisIdx !== -1) {
        const delta = this.computeDelta(basis, value);
        if (delta) {
          const deltaSize = this.estimateSize({ b: basisIdx, d: delta });
          bestDelta = { b: basisIdx, d: delta };
          bestDeltaSize = deltaSize;
        }
      }
    }

    // Try auto basis: scan dictionary for best delta
    if (!bestDelta || bestDeltaSize > 20) {
      for (let i = this.dict.length - 1; i >= Math.max(0, this.dict.length - 32); i--) {
        const candidate = this.dict[i];
        if (!isPlainObject(candidate) && !Array.isArray(candidate)) continue;
        if (Array.isArray(candidate) !== Array.isArray(value)) continue;

        const delta = this.computeDelta(candidate, value);
        if (delta) {
          const size = this.estimateSize({ b: i, d: delta });
          if (size < bestDeltaSize) {
            bestDelta = { b: i, d: delta };
            bestDeltaSize = size;
          }
        }
      }
    }

    // 4. Quality gate: compare delta size vs literal size
    const literalSize = this.estimateSize({ v: value });

    if (bestDelta && bestDeltaSize < literalSize * 0.85) {
      this.addToDict(value);
      return bestDelta;
    }

    // 5. Emit literal
    this.addToDict(value);
    return { v: value };
  }

  // ── Decode ──────────────────────────────────────────────────────────────

  decode(encoded: Encoded): any {
    const result = this.decodeInner(encoded);
    this.addToDict(result);
    return result;
  }

  private decodeInner(encoded: Encoded): any {
    if (isRef(encoded)) {
      if (encoded < 0 || encoded >= this.dict.length) {
        throw new Error(`Invalid ref: ${encoded}, dict size: ${this.dict.length}`);
      }
      return clone(this.dict[encoded]);
    }

    if (isDelta(encoded)) {
      const { b, d } = encoded;
      if (b < 0 || b >= this.dict.length) {
        throw new Error(`Invalid basis ref: ${b}, dict size: ${this.dict.length}`);
      }
      const base = clone(this.dict[b]);
      return this.applyDiff(base, d);
    }

    if (isLiteral(encoded)) {
      return clone(encoded.v);
    }

    // EncodedNested can't appear at top level — only inside Diff.s values
    throw new Error('Invalid encoded value');
  }

  // Decode a set-entry value, which may be a nested diff against the base field
  private decodeSetValue(encoded: Encoded, baseField: any): any {
    if (isNested(encoded)) {
      return this.applyDiff(clone(baseField), encoded.nd);
    }
    return this.decodeInner(encoded);
  }

  // ── Delta computation ───────────────────────────────────────────────────

  private computeDelta(base: any, target: any): Diff | null {
    if (Array.isArray(base) !== Array.isArray(target)) return null;
    if (!isPlainObject(base) && !Array.isArray(base)) return null;
    if (!isPlainObject(target) && !Array.isArray(target)) return null;

    const baseKeys = Array.isArray(base)
      ? Array.from({ length: base.length }, (_, i) => String(i))
      : Object.keys(base);
    const targetKeys = Array.isArray(target)
      ? Array.from({ length: target.length }, (_, i) => String(i))
      : Object.keys(target);

    const baseKeySet = new Set(baseKeys);
    const targetKeySet = new Set(targetKeys);

    const sets: [string, Encoded][] = [];
    const removes: string[] = [];

    for (const k of targetKeys) {
      const tv = Array.isArray(target) ? target[Number(k)] : target[k];
      if (baseKeySet.has(k)) {
        const bv = Array.isArray(base) ? base[Number(k)] : base[k];
        if (!deepEqual(bv, tv)) {
          sets.push([k, this.encodeNestedValue(tv, bv)]);
        }
      } else {
        sets.push([k, this.encodeNestedValue(tv, undefined)]);
      }
    }

    if (!Array.isArray(base)) {
      for (const k of baseKeys) {
        if (!targetKeySet.has(k)) removes.push(k);
      }
    }

    if (sets.length === 0 && removes.length === 0) return null;

    const diff: Diff = {};
    if (sets.length > 0) diff.s = sets;
    if (removes.length > 0) diff.r = removes;
    return diff;
  }

  private encodeNestedValue(tv: any, bv: any): Encoded {
    // 1. Exact dict ref
    const nestedRef = this.findExact(tv);
    if (nestedRef !== -1) return nestedRef;

    // 2. Recursive nested diff if both sides are objects/arrays of the same shape
    if (bv !== undefined) {
      const bothObjects = isPlainObject(bv) && isPlainObject(tv);
      const bothArrays = Array.isArray(bv) && Array.isArray(tv);
      if (bothObjects || bothArrays) {
        const subDiff = this.computeDelta(bv, tv);
        if (subDiff) {
          const nestedEnc: EncodedNested = { nd: subDiff };
          const litEnc: EncodedLit = { v: tv };
          if (this.estimateSize(nestedEnc) < this.estimateSize(litEnc) * 0.9) {
            return nestedEnc;
          }
        }
      }
    }

    // 3. Literal
    return { v: tv };
  }

  private applyDiff(base: any, diff: Diff): any {
    const result = clone(base);

    if (diff.s) {
      for (const [k, encoded] of diff.s) {
        const baseField = Array.isArray(base) ? base[Number(k)] : base[k];
        const val = this.decodeSetValue(encoded, baseField);
        if (Array.isArray(result)) {
          result[Number(k)] = val;
        } else {
          result[k] = val;
        }
      }
    }

    if (diff.r) {
      for (const k of diff.r) {
        delete result[k];
      }
    }

    return result;
  }

  // ── Dictionary management ───────────────────────────────────────────────

  private findExact(value: any): number {
    const hash = hashValue(value);
    const candidates = this.index.get(hash);
    if (!candidates) return -1;
    for (const idx of candidates) {
      if (idx < this.dict.length && deepEqual(this.dict[idx], value)) return idx;
    }
    return -1;
  }

  private addToDict(value: any): number {
    const cloned = clone(value);
    const hash = hashValue(cloned);

    if (this.dict.length >= this.maxSize) {
      this.dict.shift();
      this.rebuildIndex();
    }

    const idx = this.dict.length;
    this.dict.push(cloned);

    const candidates = this.index.get(hash);
    if (candidates) {
      candidates.push(idx);
    } else {
      this.index.set(hash, [idx]);
    }

    return idx;
  }

  private rebuildIndex(): void {
    this.index = new Map();
    for (let i = 0; i < this.dict.length; i++) {
      const hash = hashValue(this.dict[i]);
      const candidates = this.index.get(hash);
      if (candidates) {
        candidates.push(i);
      } else {
        this.index.set(hash, [i]);
      }
    }
  }

  // ── Size estimation ─────────────────────────────────────────────────────

  private estimateSize(encoded: Encoded): number {
    return JSON.stringify(encoded).length;
  }
}

// ── Tree compaction ─────────────────────────────────────────────────────────
// Primitive #1: deduplicate repeated sub-trees within a single JSON value.
// Walks the tree, identifies structurally identical sub-trees, and replaces
// duplicates with {$: N} refs into a shared dictionary.

export type CompactedTree = { v: 1; dict: any[]; root: any };

function isTreeRef(x: any): x is { $: number } {
  return isPlainObject(x) && typeof x.$ === 'number' && Object.keys(x).length === 1;
}

// Canonical stringify — key-order-independent structural identity
function canonicalKey(node: any): string {
  if (node === null || typeof node !== 'object') return JSON.stringify(node);
  // Respect toJSON — FieldTypes, custom serializers collapse to compact form
  if (typeof node.toJSON === 'function') return canonicalKey(node.toJSON());
  if (Array.isArray(node)) return '[' + node.map(canonicalKey).join(',') + ']';
  const keys = Object.keys(node).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalKey(node[k])).join(',') + '}';
}

export function compactTree(value: any): CompactedTree {
  // Pass 1: count structural occurrences of each sub-tree
  const freq = new Map<string, number>();

  function count(node: any): string {
    if (node === null || typeof node !== 'object') return '';
    // Respect toJSON — FieldTypes collapse to compact form before counting
    if (typeof node.toJSON === 'function') return count(node.toJSON());
    const key = canonicalKey(node);
    freq.set(key, (freq.get(key) ?? 0) + 1);
    if (Array.isArray(node)) {
      for (const child of node) count(child);
    } else {
      for (const k of Object.keys(node)) count(node[k]);
    }
    return key;
  }
  count(value);

  // Pass 2: build dict from repeated sub-trees, replace with refs
  const dict: any[] = [];
  const keyToIdx = new Map<string, number>();

  function compact(node: any): any {
    if (node === null || typeof node !== 'object') return node;
    // Respect toJSON — FieldTypes collapse to compact form before compaction
    if (typeof node.toJSON === 'function') return compact(node.toJSON());

    const key = canonicalKey(node);

    // Already in dict → ref
    if (keyToIdx.has(key)) return { $: keyToIdx.get(key)! };

    const shouldDedup = (freq.get(key) ?? 0) > 1;

    // Recursively compact children first
    let compacted: any;
    if (Array.isArray(node)) {
      compacted = node.map(compact);
    } else {
      compacted = {} as any;
      for (const k of Object.keys(node)) {
        compacted[k] = compact(node[k]);
      }
    }

    if (shouldDedup) {
      const idx = dict.length;
      keyToIdx.set(key, idx);
      dict.push(compacted);
      return { $: idx };
    }

    return compacted;
  }

  const root = compact(value);
  return { v: 1, dict, root };
}

function isCompactedTree(x: any): x is CompactedTree {
  return isPlainObject(x) && x.v === 1 && Array.isArray(x.dict) && 'root' in x;
}

export function expandTree(data: any): any {
  // Backwards compat: non-compacted data passes through unchanged
  if (!isCompactedTree(data)) return data;

  const ct = data;
  const expanded = new Map<number, any>();

  function expand(node: any): any {
    if (node === null || typeof node !== 'object') return node;
    if (isTreeRef(node)) {
      if (node.$ < 0 || node.$ >= ct.dict.length) {
        throw new Error(`Invalid tree ref: ${node.$}, dict size: ${ct.dict.length}`);
      }
      if (expanded.has(node.$)) return clone(expanded.get(node.$));
      expanded.set(node.$, null); // cycle guard
      const val = expand(ct.dict[node.$]);
      expanded.set(node.$, val);
      return clone(val);
    }
    if (Array.isArray(node)) return node.map(expand);
    const out: any = {};
    for (const k of Object.keys(node)) out[k] = expand(node[k]);
    return out;
  }

  return expand(ct.root);
}
