# @console-one/wire

Two closely-related serialization tools in one package, zero dependencies:

1. **`StructCodec`** — a dictionary-based compression codec for repetitive object graphs. First occurrence of a value is a literal; subsequent near-duplicates encode as `ref` or `delta` against the dict.
2. **`WireRegistry`** — an adapter-driven bundler for serializing heterogeneous object graphs with stable keys and dependency edges. Bundle a root; get a `{ roots, table }` graph where each node has a content-addressable key and explicit deps.
3. **`HoistCompilerBuilder`** — a code generator that walks an object graph, decides which nodes are "simple enough to inline" and which should be hoisted into named bindings, and emits them grouped by bucket (e.g. `types`, `helpers`, `handlers`).

All three share a philosophy: **separate transport/codegen from validation.** Where libraries like Zod or JSON Schema use one schema to both describe data and validate it, wire treats "how to serialize" and "how to codegen" as distinct adapter contracts. You write a `NodeAdapter` or a `HoistHandler` that says "here's how to match this kind of node, here's how to turn it into JSON / inline it / hoist it, here's how to undo that" — and the same graph can be bundled for transport, compressed via delta, or code-generated into emitted source.

## Install

```bash
npm install @console-one/wire
```

## StructCodec — dictionary compression with delta encoding

```ts
import { StructCodec } from '@console-one/wire'

const codec = new StructCodec()

// First time: literal
codec.encode({ x: 1, y: 2 })
// → { v: { x: 1, y: 2 } }

// Identical repeat: numeric ref
codec.encode({ x: 1, y: 2 })
// → 0  (dict index)

// Near-duplicate: delta against the closest dict entry
codec.encode({ x: 1, y: 2, z: 3 })
// → { b: 0, d: { s: [[ 'z', { v: 3 } ]] } }

// Decode reconstructs exact values
const back = codec.decode(0)  // → { x: 1, y: 2 }
```

Four encoded forms, unambiguously distinguishable by shape:

- **REF** (`number`) — exact match at `dict[n]`
- **DELTA** (`{ b, d }`) — like `dict[b]`, except for the `Diff`
- **LITERAL** (`{ v }`) — raw value, no compression
- **NESTED** (`{ nd }`) — recursive diff applied to a corresponding base field

Snapshots are serializable via `codec.snapshot()` / `StructCodec.restore(snapshot)`.

### Standalone tree compaction

For one-shot compression (no codec instance needed):

```ts
import { compactTree, expandTree } from '@console-one/wire'

const data = { users: [
  { role: 'admin', perms: ['read', 'write'] },
  { role: 'admin', perms: ['read', 'write'] },
  { role: 'user', perms: ['read'] }
] }

const compacted = compactTree(data)
// → { v: 1, dict: [...], root: ... }   // duplicate objects interned in dict

const back = expandTree(compacted)
// deep-equal to `data`
```

## WireRegistry — bundle an object graph

```ts
import { WireRegistry, NodeAdapter } from '@console-one/wire'

type Name = { kind: 'name'; id: string; value: string }
type Var  = { kind: 'var';  id: string; name: Name }

const nameAdapter: NodeAdapter<Name> = {
  type: 'name',
  matches: (x): x is Name => x?.kind === 'name',
  key: n => n.id,
  toJSON:   (n) => ({ value: n.value }),
  fromJSON: (d) => ({ kind: 'name', id: '', value: d.value })
}

const varAdapter: NodeAdapter<Var> = {
  type: 'var',
  matches: (x): x is Var => x?.kind === 'var',
  key: v => v.id,
  deps: v => [v.name],
  toJSON:   (v, ref) => ({ name: ref(v.name) }),
  fromJSON: (d, get)  => ({ kind: 'var', id: '', name: get(d.name.$ref) })
}

const registry = new WireRegistry([nameAdapter, varAdapter])

const v: Var = { kind: 'var', id: 'v1', name: { kind: 'name', id: 'n1', value: 'alpha' } }
const bundle = registry.bundle([v])
// → { version: 1, roots: ['v1'], table: { v1: {...}, n1: {...} } }

const [restored] = registry.unbundle(bundle)
// restored === { kind: 'var', id: '', name: { kind: 'name', id: '', value: 'alpha' } }
```

Key properties:

- **Content-addressable keys** — if `NodeAdapter.key` is omitted, the key is `${type}:${djb2(JSON.stringify(node))}`, giving structural dedup for free.
- **Explicit dep edges** — `toJSON(node, ref)` uses the `ref(child)` callback to register a child; deps are recorded so `unbundle` can respect topological order.
- **Cycle-safe** — `unbundle` makes forward progress as long as a node's deps are resolved, and force-decodes one node at a time if a cycle is detected.

## HoistCompilerBuilder — code generation with hoisting

Turn an expression-tree-ish object graph into generated source where trivial nodes inline and heavy ones are lifted to named bindings, grouped into buckets:

```ts
import { HoistCompilerBuilder } from '@console-one/wire'

const compiler = new HoistCompilerBuilder()
  .add({
    type: 'lit',
    matches: (x): x is { kind: 'lit'; v: number } => x?.kind === 'lit',
    key: e => `lit:${e.v}`,
    deps: () => [],
    isSimple: () => true,
    renderInline: e => String(e.v),
    renderHoisted: () => ({ body: '' })
  })
  .add({
    type: 'add',
    matches: (x): x is { kind: 'add'; l: any; r: any } => x?.kind === 'add',
    key: e => `add:${JSON.stringify(e)}`,
    classify: () => 'expr',
    deps: e => [e.l, e.r],
    isSimple: () => false,
    renderInline: () => '',
    renderHoisted: (e, tryCompile) => ({
      body: `${tryCompile(e.l)} + ${tryCompile(e.r)}`,
      bucket: 'expr'
    })
  })
  .build()

const expr = { kind: 'add', l: { kind: 'lit', v: 2 }, r: { kind: 'lit', v: 3 } }
const result = compiler.compileAll([expr])
// → { sections: { expr: [{ key: 'add:...', name: 'E_xxxxx', body: '2 + 3', ... }] }, body: '...' }

const source = compiler.emit(result)
// rendered source with sections concatenated
```

A `HoistHandler` decides:

- Structural dedup via `key` / `id`
- Inline vs hoist via `isSimple`
- How to refer to a hoisted binding via `refName`
- Which bucket a hoisted node belongs to via `classify`

## Public surface

From `@console-one/wire`:

**Codec**
- `StructCodec` — encode / decode / snapshot / restore
- `compactTree(value)` / `expandTree(compacted)`
- Types: `Diff`, `Encoded`, `EncodedRef`, `EncodedDelta`, `EncodedLit`, `EncodedNested`, `CodecSnapshot`, `CompactedTree`

**Bundler**
- `WireRegistry` — `bundle(roots)` / `unbundle(bundle)`
- `djb2(s)` — stable string hash used for default content addressing
- Types: `WireRecord`, `WireBundle`, `NodeAdapter<T>`

**Compiler**
- `HoistCompilerBuilder` — `.add(handler).build(opts)` → `{ tryCompile, compileAll, emit }`
- Types: `TryCompile`, `HoistedNode`, `CompileSections`, `CompileResult`, `HoistHandler<T>`, `NodeHandler<T>`, `CompilerOptions`

## Layout

```
src/
├── index.ts        # Public surface
├── smoke.ts        # End-to-end smoke test
├── codec.ts        # StructCodec, compactTree/expandTree
├── registry.ts     # WireRegistry, djb2
├── nodeadaptor.ts  # NodeAdapter<T> type
└── compiler.ts     # HoistCompilerBuilder
```

Zero runtime dependencies. TypeScript-first with full `.d.ts` emit.

## Smoke test

```bash
npm install
npm run build
npm run smoke
```

Asserts six end-to-end paths:

1. **Ref compression** — repeated structure compresses to a numeric ref; decode reconstructs exactly.
2. **Delta encoding** — similar-but-different structure compresses as a delta or nested form (not a full literal re-emit).
3. **Tree compaction** — `compactTree → expandTree` round-trips deep-equal.
4. **Bundler** — typed object graph serializes and deserializes through `NodeAdapter`s with deps preserved.
5. **Hash determinism** — `djb2` is stable and discriminates.
6. **Compiler** — `HoistCompilerBuilder` hoists non-simple nodes into buckets and inlines the simple ones.

## License

MIT
