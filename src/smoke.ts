/**
 * Smoke test: dictionary-based codec compression + adapter-driven bundling
 * + hoist-compiler codegen.
 *
 * Exits non-zero on any assertion failure.
 */

import {
  HoistCompilerBuilder,
  NodeAdapter,
  StructCodec,
  WireRegistry,
  compactTree,
  djb2,
  expandTree
} from './index.js'

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(`[smoke] assertion failed: ${msg}`)
}

// ---------------------------------------------------------------------------
// Case 1: StructCodec encodes first occurrence as literal, duplicates as ref
// ---------------------------------------------------------------------------
function caseCodecRefCompression() {
  const codec = new StructCodec()
  const first = codec.encode({ x: 1, y: 2 })
  const second = codec.encode({ x: 1, y: 2 })

  assert(typeof first === 'object' && 'v' in (first as any), 'first encode should be literal {v:...}')
  assert(typeof second === 'number', `duplicate encode should compress to a numeric ref, got ${JSON.stringify(second)}`)

  const decoded = codec.decode(second)
  assert(decoded.x === 1 && decoded.y === 2, `decoded ref should reproduce original, got ${JSON.stringify(decoded)}`)

  console.log('[smoke] case1 OK — repeated structure compresses to numeric ref; decode roundtrips')
}

// ---------------------------------------------------------------------------
// Case 2: StructCodec emits a delta when structure shifts slightly
// ---------------------------------------------------------------------------
function caseCodecDelta() {
  const codec = new StructCodec()
  codec.encode({ name: 'alice', role: 'admin', active: true })
  const delta = codec.encode({ name: 'alice', role: 'admin', active: false })

  // Either a delta or a nested form is acceptable — both are compression,
  // not a full literal re-emit.
  const isLit = typeof delta === 'object' && delta !== null && 'v' in (delta as any)
  assert(!isLit, `similar-but-different structure should not re-emit as full literal, got ${JSON.stringify(delta)}`)

  const decoded = codec.decode(delta)
  assert(decoded.active === false && decoded.name === 'alice', `delta decode mismatch: ${JSON.stringify(decoded)}`)

  console.log('[smoke] case2 OK — similar structure compresses to delta/nested; decode reconstructs exact value')
}

// ---------------------------------------------------------------------------
// Case 3: compactTree / expandTree — standalone dictionary compaction
// ---------------------------------------------------------------------------
function caseCompactTree() {
  const source = {
    users: [
      { role: 'admin', perms: ['read', 'write'] },
      { role: 'admin', perms: ['read', 'write'] }, // duplicate object
      { role: 'user',  perms: ['read'] }
    ]
  }
  const compacted = compactTree(source)
  const expanded = expandTree(compacted)

  assert(JSON.stringify(expanded) === JSON.stringify(source), 'compactTree → expandTree should round-trip')
  assert(compacted.dict.length >= 1, `expected at least one entry in dict, got ${compacted.dict.length}`)
  console.log(`[smoke] case3 OK — compactTree dict has ${compacted.dict.length} entries; roundtrip exact`)
}

// ---------------------------------------------------------------------------
// Case 4: WireRegistry — bundle + unbundle object graph with adapters
// ---------------------------------------------------------------------------
function caseBundler() {
  // Toy AST: Var references a typed Name by id
  type Name = { kind: 'name'; id: string; value: string }
  type Var = { kind: 'var'; id: string; name: Name }

  const nameAdapter: NodeAdapter<Name> = {
    type: 'name',
    matches: (x: any): x is Name => x && x.kind === 'name',
    key: n => n.id,
    toJSON: (n) => ({ value: n.value }),
    fromJSON: (data) => ({ kind: 'name', id: '', value: data.value } as Name)
  }

  const varAdapter: NodeAdapter<Var> = {
    type: 'var',
    matches: (x: any): x is Var => x && x.kind === 'var',
    key: v => v.id,
    deps: v => [v.name],
    toJSON: (v, ref) => ({ name: ref(v.name) }),
    fromJSON: (data, get) => {
      const nameRef = data.name.$ref
      return { kind: 'var', id: '', name: get(nameRef) } as Var
    }
  }

  const registry = new WireRegistry([nameAdapter, varAdapter])
  const nameNode: Name = { kind: 'name', id: 'n1', value: 'alpha' }
  const varNode: Var = { kind: 'var', id: 'v1', name: nameNode }

  const bundle = registry.bundle([varNode])
  assert(bundle.version === 1, 'bundle should have version 1')
  assert(bundle.roots.length === 1, `expected 1 root, got ${bundle.roots.length}`)
  assert(Object.keys(bundle.table).length === 2, `expected 2 records (var + name), got ${Object.keys(bundle.table).length}`)

  const [restored] = registry.unbundle(bundle)
  assert(restored.kind === 'var', `restored should be var, got ${restored.kind}`)
  assert(restored.name.kind === 'name' && restored.name.value === 'alpha',
    `restored var should reference name with value 'alpha', got ${JSON.stringify(restored.name)}`)

  console.log('[smoke] case4 OK — WireRegistry bundle/unbundle preserves typed-node graph with deps')
}

// ---------------------------------------------------------------------------
// Case 5: djb2 hash is deterministic
// ---------------------------------------------------------------------------
function caseDjb2() {
  const a = djb2('hello world')
  const b = djb2('hello world')
  const c = djb2('hello worlD')  // capital D
  assert(a === b, 'djb2 must be deterministic for same input')
  assert(a !== c, 'djb2 must differ for different input')
  console.log(`[smoke] case5 OK — djb2('hello world') = '${a}' (deterministic, differs on change)`)
}

// ---------------------------------------------------------------------------
// Case 6: HoistCompilerBuilder generates named bindings for non-simple nodes
// ---------------------------------------------------------------------------
function caseCompiler() {
  // Toy arithmetic expression language — compile (Add (Lit 2) (Lit 3)) into
  // generated JS where the Add is hoisted and the Lits inline.
  type ExprLit = { kind: 'lit'; v: number }
  type ExprAdd = { kind: 'add'; l: any; r: any }

  const builder = new HoistCompilerBuilder()
    .add<ExprLit>({
      type: 'lit',
      matches: (x: any): x is ExprLit => x && x.kind === 'lit',
      key: e => `lit:${e.v}`,
      deps: () => [],
      isSimple: () => true,
      renderInline: e => String(e.v),
      renderHoisted: () => ({ body: '' })
    })
    .add<ExprAdd>({
      type: 'add',
      matches: (x: any): x is ExprAdd => x && x.kind === 'add',
      key: e => `add:${JSON.stringify(e)}`,
      classify: () => 'expr',
      deps: e => [e.l, e.r],
      isSimple: () => false,
      renderInline: (_e, _ref) => '',
      renderHoisted: (e, tryCompile) => ({
        body: `${tryCompile(e.l)} + ${tryCompile(e.r)}`,
        bucket: 'expr'
      })
    })

  const compiler = builder.build()
  const expr: ExprAdd = {
    kind: 'add',
    l: { kind: 'lit', v: 2 },
    r: { kind: 'lit', v: 3 }
  }
  const result = compiler.compileAll([expr])

  assert(typeof result === 'object' && result !== null, 'compileAll should return a result object')
  assert('sections' in result && 'body' in result,
    `expected { sections, body }, got keys: ${Object.keys(result)}`)

  const exprSection = result.sections['expr'] ?? []
  assert(exprSection.length === 1, `expected exactly one hoisted Add, got ${exprSection.length}`)
  assert(exprSection[0].body.includes('2') && exprSection[0].body.includes('3'),
    `hoisted body should include '2' and '3', got: ${exprSection[0].body}`)

  const rendered = compiler.emit(result)
  assert(rendered.length > 0, 'emit should produce non-empty output')

  console.log(`[smoke] case6 OK — HoistCompilerBuilder hoists Add, inlines Lits; body: '${exprSection[0].body}'`)
}

async function main() {
  console.log('[smoke] @console-one/wire')
  caseCodecRefCompression()
  caseCodecDelta()
  caseCompactTree()
  caseBundler()
  caseDjb2()
  caseCompiler()
  console.log('[smoke] ALL OK')
}

main().catch(err => {
  console.error('[smoke] FAIL', err)
  process.exit(1)
})
