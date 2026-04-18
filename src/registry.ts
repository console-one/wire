import { NodeAdapter } from "./nodeadaptor.js";

export type WireRecord = { nodeType: string; data: any; deps?: string[] };
export type WireBundle = { version: 1; roots: string[]; table: Record<string, WireRecord> };

export class WireRegistry {
  private adapters: NodeAdapter<any>[];
  constructor(adapters: NodeAdapter<any>[]) { this.adapters = adapters.slice(); }
  private find(x: any) { return this.adapters.find(a => a.matches(x)); }

  bundle(roots: any[]): WireBundle {
    const table = new Map<string, WireRecord>();
    const visiting = new Set<string>();

    const ensure = (node: any): string => {
      const ad = this.find(node);
      if (!ad) throw new Error("No adapter for node: " + (node?.type ?? typeof node));

      const key = ad.key?.(node) ?? ad.id?.(node) ?? `${ad.type}:${djb2(JSON.stringify(node))}`;
      if (table.has(key)) return key;
      if (visiting.has(key)) return key;
      visiting.add(key);

      const deps: string[] = [];
      const ref = (child: any) => { const ck = ensure(child); deps.push(ck); return { $ref: ck }; };

      // explicit child scan if adapter exposes deps()
      const extra = ad.deps?.(node) ?? [];
      for (const d of extra) ensure(d);

      const data = ad.toJSON(node, ref);
      table.set(key, { nodeType: ad.type, data, deps: Array.from(new Set(deps)) });
      visiting.delete(key);
      return key;
    };

    const rootKeys = roots.map(ensure);
    const out: Record<string, WireRecord> = {};
    for (const [k, v] of table) out[k] = v;
    return { version: 1, roots: rootKeys, table: out };
  }

  unbundle(bundle: WireBundle): any[] {
    if (bundle.version !== 1) throw new Error("Unsupported bundle version");
    const out = new Map<string, any>();
    const pending = new Set(Object.keys(bundle.table));

    const byType = new Map<string, NodeAdapter<any>>();
    for (const ad of this.adapters) byType.set(ad.type, ad);

    const get = (k: string) => out.get(k);

    let guard = 200000;
    while (pending.size && guard-- > 0) {
      let progressed = false;
      for (const k of Array.from(pending)) {
        const rec = bundle.table[k];
        const ad = byType.get(rec.nodeType);
        if (!ad) throw new Error("No adapter for nodeType: " + rec.nodeType);
        const deps = rec.deps ?? [];
        if (deps.every(d => out.has(d))) {
          out.set(k, ad.fromJSON(rec.data, get));
          pending.delete(k);
          progressed = true;
        }
      }
      if (!progressed) {
        // Break any cycle by forcing one decode (shouldn't happen for Recipe/FieldType)
        const k = pending.values().next().value as string;
        const rec = bundle.table[k];
        const ad = byType.get(rec.nodeType)!;
        out.set(k, ad.fromJSON(rec.data, get));
        pending.delete(k);
      }
    }
    return bundle.roots.map(k => out.get(k));
  }
}

export function djb2(s: string): string {
  let h = 5381 >>> 0;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return (h >>> 0).toString(36);
}

