// src/core/models/wire/compiler.ts


// Andrew Q: Why would hoist handler be typed and try compile not????
// A: TryCompile is the seam *between* handlers — by the time it's called, the
//    static type of the child has been erased and runtime dispatch via matches()
//    is the whole point. It can't be generic in T (T is gone). You could tighten
//    `any` to `unknown` to force handlers to narrow, but generic is impossible.
export type TryCompile = (node: any) => string;

export type HoistedNode = {

  // Andrew Q: I am struggling to determine the difference
  // between key and name. When does one change (or change in how it relates to other things,
  // that makes name unstable???)
  // A: key = structural identity. Same-shape nodes produce the same key. This
  //    is the dedupe ID and drives the `hoisted` Map. Stable across runs given
  //    same input.
  //    name = the symbol actually emitted in output text (`type Foo_abc = ...`).
  //    Derived from key via getNameForKey(), then collision-resolved against
  //    `usedNames`. Can shift between runs if collisions are encountered in a
  //    different order. They're separate so a user-supplied nameForKey() can
  //    produce pretty/custom symbols without breaking dedupe semantics.
  key: string;           // structural key (stable)
  name: string;          // assigned symbol name
  body: string;          // rendered definition body

  doc?: string;          // optional docline
  bucket?: string;       // e.g. "codex" | "type" | ...
  deps?: string[];       // keys of hoisted dependencies
};

export type CompileSections = {
  [bucket: string]: HoistedNode[];
};

export type CompileResult = {
  sections: CompileSections;
  body: string;
};

// Generic handler for hoist/codegen (formerly "NodeHandler")

// Andrew Q: Why would input be typed and not output???
// A: Output is shape-only (Rendered) because every handler produces the same
//    shape regardless of T — T has already been collapsed into a body: string.
//    There's no T-information left to preserve in the return type. Genericness
//    on the output would be noise.
export type HoistHandler<T> = {

  type: string;

  matches(x: any): x is T;

  // Stable structural key for dedupe; fallback to id()
  key?(x: T): string | undefined;

  // Andrew Q: Why is this undifferentiated from key
  // in its API layer description of functionality???
  // A: It's vestigial. `id` predates `key`. The synthesis at every call site is
  //    `h.key?.(x) ?? h.id?.(x) ?? <hash-of-JSON>`. It exists for back-compat
  //    with old handlers (see the NodeHandler<T> alias below). New handlers
  //    should implement `key` only — `id` should be marked @deprecated or
  //    deleted outright.
  id?(x: T): string | undefined;

  // Optional semantic classification (for sectioning)
  // Andrew Q: WHy would this exist on the API layer as well
  // and not as a dependency which determines hoist functionality?
  // A: It lets one handler route nodes to *different* output buckets based on
  //    the node value (not just the handler type). But `rendered.bucket` from
  //    renderHoisted() already takes precedence (see ensureHoisted). So
  //    classify() is effectively redundant with the renderer's return value —
  //    one of them should be removed. Keeping `rendered.bucket` is cleaner
  //    because the renderer already has the node in hand.
  classify?(x: T): string | undefined; // e.g. "codex", "type"

  // Which children exist (used both for rendering and topo)
  dependencies(x: T): any[];

  // Inline vs hoist decision
  isSimple(x: T): boolean;
  // Andrew Q: Why are simple/inline vs hoisted decisions
  // exposed _external_ from the handler itself?
  // A: isSimple is a *predicate* the orchestrator uses to pick which renderer
  //    to call. It's external because the dedupe/hoist state (`hoisted`,
  //    `usedNames`, key allocation) lives on the orchestrator, not the
  //    handler. The handler can't decide alone whether to register-or-reuse
  //    because that's not its data. You could merge into render(x, mode), but
  //    then you'd lose the early-out: "is this node simple?" can be answered
  //    *before* invoking either renderer, which lets ensureHoisted bail when
  //    a node is already memoized.
  renderInline(x: T, tryCompile: TryCompile): string;

  renderHoisted(
    x: T,
    tryCompile: TryCompile
  ): Rendered

  // How to reference a hoisted thing
  refName?(x: T, assignedName: string): string;
};

export type Rendered = { body: string; doc?: string; name?: string; bucket?: string };

// Back‑compat type alias if you want to keep older name around:
export type NodeHandler<T> = HoistHandler<T>;

export type CompilerOptions = {
  nameForKey?: (k: string, bucket?: string) => string; // stable name from key
  maxNameCollisions?: number; // fail-safe
};

// local hasher to avoid circular import on index.ts

// Andrew Q: Why the fuck would this function be named this?
// And not something as-it-relates-to the fucking hoist?
// A: DJB2 is the actual name of the hash algorithm (Daniel J. Bernstein, 1991).
//    It's named after the *algorithm*, not its use here. Fair criticism: call
//    sites would be more readable wrapped in `structuralHash(s)`, with djb2num
//    kept as the math primitive. The localness (rather than importing) is
//    explained by the circular-import note above.
function djb2num(s: string): number {
  let h = 5381 >>> 0;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

const defaultName = (k: string, bucket?: string) => {
  const tag = (bucket ? bucket[0] : "T").toUpperCase();
  const n = djb2num(k).toString(36).slice(0, 6);
  return `${tag}_${n}`;
};

export class HoistCompilerBuilder {

  private handlers: HoistHandler<any>[] = [];

  add<T>(h: HoistHandler<T>) {
    this.handlers.push(h);
    return this;
  }


  private computeKey(handler, node) {
    return handler.key?.(node) ?? handler.id?.(node) ?? `${handler.type}:${djb2num(JSON.stringify(node))}`;
  }

  build(opts: CompilerOptions = {}) {
    const handlers = this.handlers.slice();

    const getNameForKey = opts.nameForKey ?? defaultName;
    const maxCollisions = Math.max(1, opts.maxNameCollisions ?? 256);
    const getHandlerFor = (x: any) => handlers.find(h => h.matches(x));
    
    // Andrew Comment: The idea that these wouldn't be part of defaults is absolutely shocking to me
    // No structural patch enablement, no pause resume, etc.
    // A: Agreed — this is bare minimum. These three Maps reset on every
    //    compileAll() call. There's no incremental compile, no replace-one-
    //    entry, no resumption. The bones are there (stable `key` is the
    //    precondition for incrementality), but nothing exposes them. This is a
    //    one-shot build compiler. Patching is a future story, not a refactor.
    const keyToName = new Map<string, string>();
    const hoisted = new Map<string, HoistedNode>(); // by key
    const usedNames = new Set<string>();

    // Andrew Q: The difference between 'key', 'assigned' name and
    // A: key = structural identity (dedupe ID, drives the `hoisted` Map).
    //    assigned = the name actually emitted in output, after collision
    //    resolution against `usedNames`. baseName = first-choice name from
    //    rendered.name or getNameForKey(key, bucket); `assigned` falls back to
    //    `${baseName}_${i}` or a hash-suffixed form if collisions exhaust.
    const assignName = (rendered: Rendered, key: string, bucket: string, depKeys: any[]) => {
      const baseName = rendered.name ?? getNameForKey(key, bucket);
      let assigned = baseName;
      if (usedNames.has(assigned)) {
        let i = 2;
        while (i <= maxCollisions && usedNames.has(`${baseName}_${i}`)) i++;
        assigned = i > maxCollisions
          ? `${baseName}_${djb2num(key).toString(36).slice(0, 3)}`
          : `${baseName}_${i}`;
      }
      usedNames.add(assigned);
      keyToName.set(key, assigned);
      hoisted.set(key, {
        key,
        name: assigned,
        // Andrew Q: Why are doc and body structurally seperated and not just the output object type?
        // Is there something different at the level hoist managed _things_ here?
        // A: They're separated so the *emitter* owns formatting. `doc` becomes
        //    `/// ...\n` and `body` becomes the RHS after `type X =`. If they
        //    were one field, the emitter couldn't change comment style or
        //    strip docs without re-parsing. Thin separation of concerns:
        //    handler emits semantic parts, emitter assembles syntax.
        body: rendered.body,
        doc: rendered.doc,
        bucket,
        deps: Array.from(new Set(depKeys)), // de-dupe
      });
      return assigned;
    }

    // Andrew Q: Is this effectively the exact same same thing as a bind?
    // So all hoist operations are a combination of:
    // A: Yes — at its core this is `memoize(key, () => render(handler, node))`.
    //    The extra ceremony is dep-edge recording: it traverses declared
    //    children proactively so topo() has edges later, and it sets up a
    //    per-call `refOrInline` closure that pushes resolved child keys into
    //    `depKeys`. Strip the edges and it's a memoized bind keyed by
    //    structural identity.
    const ensureHoisted = (hoistHandler: HoistHandler<any>, node: any, key: string): string => {
      // already hoisted?
      const existing = hoisted.get(key);
      if (existing) return existing.name;
      // Gather deps up-front so we can record edges even if the renderer forgets to recurse.
      const depKeys: string[] = [];

      const refOrInline: TryCompile = (innerNode: any) => {
        const innerHoistHandler = getHandlerFor(innerNode);
        if (!innerHoistHandler) return JSON.stringify(innerNode);
        let innerNodeKey = this.computeKey(innerHoistHandler, innerNode);
        if (innerHoistHandler.isSimple(innerNode)) {
          return innerHoistHandler.renderInline(innerNode, refOrInline);
        }
        const nm = ensureHoisted(innerHoistHandler, innerNode, innerNodeKey);
        depKeys.push(innerNodeKey);
        return innerHoistHandler.refName?.(innerNode, nm) ?? nm;
      };
      // Proactively traverse declared deps to ensure hoisting & edge recording
      (hoistHandler.dependencies(node) || []).forEach(refOrInline);
      const rendered = hoistHandler.renderHoisted(node, refOrInline);
      const bucket = rendered.bucket ?? hoistHandler.classify?.(node) ?? hoistHandler.type;
      return assignName(rendered, key, bucket, depKeys)
    };

    // Andrew Q: Why is this logic replicated, but in no way differentiated from the 'refOrInline' above
    // Andrew comment: The use of variable names that have zero readability potential is vile.
    // A: Genuine duplication. The only real difference: refOrInline pushes the
    //    resolved key into the *enclosing* ensureHoisted's depKeys (for edge
    //    tracking); tryCompile has no parent and pushes nowhere. Could be
    //    unified as:
    //        compile(node, recordDep?: (k: string) => void): string
    //    with `tryCompile = node => compile(node)` and
    //    `refOrInline = node => compile(node, k => depKeys.push(k))`.
    const tryCompile: TryCompile = (node: any): string => {
      const h = getHandlerFor(node);
      if (!h) return JSON.stringify(node);
      const key = h.key?.(node) ?? h.id?.(node) ?? `${h.type}:${djb2num(JSON.stringify(node))}`;
      // If simple, render inline
      if (h.isSimple(node)) {
        return h.renderInline(node, tryCompile);
      }
      // Otherwise hoist (and return ref)
      const name = ensureHoisted(h, node, key);
      return h.refName?.(node, name) ?? name;
    };

    // Andrew Q: Are we doing anything specific in the topological
    // sort here that is relevant to hoisting itself?
    // If not - why would we not put this in its own utility?
    // For readability and reliance purposes. "knowing" its a
    // general topological sort is a massive benefit to mental
    // shortcut and obtain understanding of the code.
    // The fact that this is also inlined is fucking brutal
    // A: Nothing here is hoist-specific. It's plain Kahn's algorithm with a
    //    cycle-tolerant fallback (cycles are appended in insertion order
    //    rather than dropped). It should be extracted as:
    //        topoSort<T>(nodes: T[], getKey: (n: T) => string,
    //                    getDeps: (n: T) => string[]): T[]
    //    Inlining costs every reader the work of confirming "yep, just topo,
    //    nothing weird."
    const topo = (nodes: HoistedNode[]): HoistedNode[] => {
      // Kahn topo by keys; ignore cycles (keep insertion order for those)
      const byKey = new Map(nodes.map(n => [n.key, n] as const));
      const indeg = new Map<string, number>();
      const adj = new Map<string, string[]>();

      nodes.forEach(n => {
        const ds = (n.deps ?? []).filter(k => byKey.has(k));
        indeg.set(n.key, indeg.get(n.key) ?? 0);
        ds.forEach(d => {
          indeg.set(n.key, (indeg.get(n.key) ?? 0) + 1);
          (adj.get(d) ?? (adj.set(d, []), adj.get(d)!)).push(n.key);
        });
      });

      const q: string[] = nodes.filter(n => (indeg.get(n.key) ?? 0) === 0).map(n => n.key);
      const out: HoistedNode[] = [];
      const pushed = new Set<string>();
      while (q.length) {
        const k = q.shift()!;
        const n = byKey.get(k);
        if (!n) continue;
        out.push(n);
        pushed.add(k);
        for (const m of adj.get(k) ?? []) {
          indeg.set(m, (indeg.get(m) ?? 0) - 1);
          if ((indeg.get(m) ?? 0) === 0) q.push(m);
        }
      }
      // add remaining (cycles) in original insertion order
      nodes.forEach(n => { if (!pushed.has(n.key)) out.push(n); });
      return out;
    };


    const compileAll = (roots: any[]): CompileResult => {
      // Clear per-run state to avoid cross-run bleed
      // Andrew Q: is this a symptom of not actually managing state? Doesn't this increase the bug surface?
      // A: Yes. The Maps live at build() scope but are only meaningfully written
      //    during compileAll, which clears them on entry. Either move them
      //    *inside* compileAll (current contract is one-shot anyway), or
      //    persist them and add an API to retire/replace entries (which would
      //    unlock the patching story above). Current shape is the worst of
      //    both — looks stateful, behaves stateless. The fact that tryCompile
      //    is exposed on the builder return suggests state was meant to
      //    persist across calls, but compileAll defeats that.
      keyToName.clear();
      hoisted.clear();
      usedNames.clear();
      // Render roots (this will populate hoisted map)
      const rendered = roots.map(tryCompile).join("\n");
      // Group hoisted by bucket & topo-sort within each bucket
      const byBucket = new Map<string, HoistedNode[]>();
      for (const h of hoisted.values()) {
        const b = h.bucket ?? "type";
        (byBucket.get(b) ?? (byBucket.set(b, []), byBucket.get(b)!)).push(h);
      }
      const sections: CompileSections = {};
      for (const [bucket, list] of byBucket) {
        sections[bucket] = topo(list);
      }
      return { sections, body: rendered };
    };

    // Andrew Q: What the fuck is compile result being passed back into emit for?
    // A: Phase split. compileAll returns the structured data; emit formats it.
    //    Splitting them lets a caller inspect/filter/reorder sections between
    //    phases (e.g. drop a bucket, prepend custom defs) before stringifying.
    //    Most callers won't — a convenience `compile(roots) = emit(compileAll(roots))`
    //    would be a friendly addition.
    const emit = (res: CompileResult): string => {
      // Andrew Q: Why would this spec not be input???
      // A: Real flaw. ["codex", "type"] should be a CompilerOptions field
      //    (e.g. sectionOrder). It's hardcoded because the original consumer
      //    happened to have exactly those two buckets. Trivial to lift.
      const order = ["codex", "type"]; // preferred section order
      const seen = new Set<string>(order);
      const rest = Object.keys(res.sections).filter(b => !seen.has(b));
      const buckets = [...order, ...rest].filter(b => res.sections[b]?.length);

      // Andrew Q: What do buckets represent ? And what the fuck is this inline
      // code gen? What is the fucking language you are writing here? What is this doing?
      // A: A bucket is a *named section in the output* — a logical grouping of
      //    hoisted definitions. The emitter groups by `bucket`, topo-sorts
      //    each group, and emits:
      //        # Codex
      //        /// optional doc
      //        type C_abc = <body>
      //
      //        # Type
      //        type T_def = <body>
      //
      //        # Body
      //        <rendered roots>
      //    The output is a custom DSL, NOT TypeScript. The `type Name = Body`
      //    syntax is borrowed from TS but the bodies come from handlers and
      //    follow whatever conventions those handlers establish. The
      //    `# Section` headers and `///` doc lines are pure to this format.
      //    compiler.ts is a *skeleton emitter* — it knows how to lay out
      //    hoisted definitions in named sections; the *language* of the
      //    bodies is determined entirely by what handlers produce.
      //
      // Andrew Q (followup): can buckets be bucketed — multi-d lifts?
      // A: Not natively. CompileSections is `{ [bucket: string]: HoistedNode[] }` —
      //    a flat one-level map, and every node carries a single `bucket: string`.
      //    Three ways to add nesting without rewriting the world:
      //      1. Delimited bucket strings ("codex/lookups", "codex/derived").
      //         Handlers already drive bucketing via rendered.bucket, so nothing
      //         in the type model changes — just split on "/" in the emitter to
      //         render as nested # / ## sections. Cheapest path.
      //      2. Promote bucket to `string[]` (a path). Forces CompileSections
      //         into a tree (`{ children: …, nodes: HoistedNode[] }`). Most
      //         general, biggest churn.
      //      3. Parallel `subBucket?: string` field. Two-level only, less
      //         general than (2) without being meaningfully simpler than (1).
      //    (1) is what I'd reach for first — it's a pure emitter change and
      //    handlers gain multi-d lift power for free.
      const defBlock = buckets.map(b => {
        const defs = res.sections[b]
          .map(h => `${h.doc ? `/// ${h.doc}\n` : ""}type ${h.name} = ${h.body}`)
          .join("\n\n");
        const header = `# ${b[0].toUpperCase()}${b.slice(1)}`;
        return `${header}\n${defs}`;
      }).join("\n\n");

      return [defBlock, "# Body", res.body].filter(Boolean).join("\n\n");
    };

    return { tryCompile, compileAll, emit };
  }
}
