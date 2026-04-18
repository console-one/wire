// src/core/models/wire/compiler.ts
export type TryCompile = (node: any) => string;

export type HoistedNode = {
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
export type HoistHandler<T> = {
  type: string;
  matches(x: any): x is T;

  // Stable structural key for dedupe; fallback to id()
  key?(x: T): string | undefined;
  id?(x: T): string | undefined;

  // Optional semantic classification (for sectioning)
  classify?(x: T): string | undefined; // e.g. "codex", "type"

  // Which children exist (used both for rendering and topo)
  deps(x: T): any[];

  // Inline vs hoist decision
  isSimple(x: T): boolean;

  // Renderers
  renderInline(x: T, tryCompile: TryCompile): string;
  renderHoisted(
    x: T,
    tryCompile: TryCompile
  ): { body: string; doc?: string; name?: string; bucket?: string };

  // How to reference a hoisted thing
  refName?(x: T, assignedName: string): string;
};

// Back‑compat type alias if you want to keep older name around:
export type NodeHandler<T> = HoistHandler<T>;

export type CompilerOptions = {
  nameForKey?: (k: string, bucket?: string) => string; // stable name from key
  maxNameCollisions?: number; // fail-safe
};

// local hasher to avoid circular import on index.ts
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

  build(opts: CompilerOptions = {}) {
    const handlers = this.handlers.slice();
    const nameForKey = opts.nameForKey ?? defaultName;
    const maxCollisions = Math.max(1, opts.maxNameCollisions ?? 256);

    const find = (x: any) => handlers.find(h => h.matches(x));

    // state during a compilation
    const keyToName = new Map<string, string>();
    const hoisted = new Map<string, HoistedNode>(); // by key
    const usedNames = new Set<string>();

    const ensureHoisted = (h: HoistHandler<any>, node: any, key: string): string => {
      // already hoisted?
      const existing = hoisted.get(key);
      if (existing) return existing.name;

      // Gather deps up-front so we can record edges even if the renderer forgets to recurse.
      const depKeys: string[] = [];

      const refOrInline: TryCompile = (n: any) => {
        const hh = find(n);
        if (!hh) return JSON.stringify(n);
        const k = hh.key?.(n) ?? hh.id?.(n) ?? `${hh.type}:${djb2num(JSON.stringify(n))}`;
        if (hh.isSimple(n)) {
          return hh.renderInline(n, refOrInline);
        }
        const nm = ensureHoisted(hh, n, k);
        depKeys.push(k);
        return hh.refName?.(n, nm) ?? nm;
      };

      // Proactively traverse declared deps to ensure hoisting & edge recording
      (h.deps(node) || []).forEach((child) => {
        const hh = find(child);
        if (!hh) return;
        const ck = hh.key?.(child) ?? hh.id?.(child) ?? `${hh.type}:${djb2num(JSON.stringify(child))}`;
        if (hh.isSimple(child)) {
          // allow handler to inline child (can produce nested refs)
          hh.renderInline(child, refOrInline);
        } else {
          ensureHoisted(hh, child, ck);
          depKeys.push(ck);
        }
      });

      const rendered = h.renderHoisted(node, refOrInline);
      const bucket = rendered.bucket ?? h.classify?.(node) ?? h.type;

      // assign name with collision guard
      const baseName = rendered.name ?? nameForKey(key, bucket);
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
        body: rendered.body,
        doc: rendered.doc,
        bucket,
        deps: Array.from(new Set(depKeys)), // de-dupe
      });
      return assigned;
    };

    const tryCompile: TryCompile = (node: any): string => {
      const h = find(node);
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

    const emit = (res: CompileResult): string => {
      const order = ["codex", "type"]; // preferred section order
      const seen = new Set<string>(order);
      const rest = Object.keys(res.sections).filter(b => !seen.has(b));
      const buckets = [...order, ...rest].filter(b => res.sections[b]?.length);

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
