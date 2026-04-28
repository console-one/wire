// ─────────────────────────────────────────────────────────────────────────
// WireRegistry — adapter-driven bundling/unbundling of typed object graphs
// with stable keys and explicit dependency edges.
// ─────────────────────────────────────────────────────────────────────────

import { WireRegistry, type NodeAdapter } from '../index.js';

type Name = { kind: 'name'; id: string; value: string };
type Var = { kind: 'var'; id: string; name: Name };

const nameAdapter: NodeAdapter<Name> = {
  type: 'name',
  matches: (x: any): x is Name => x && x.kind === 'name',
  key: (n) => n.id,
  toJSON: (n) => ({ value: n.value }),
  fromJSON: (data) => ({ kind: 'name', id: '', value: data.value } as Name),
};

const varAdapter: NodeAdapter<Var> = {
  type: 'var',
  matches: (x: any): x is Var => x && x.kind === 'var',
  key: (v) => v.id,
  deps: (v) => [v.name],
  toJSON: (v, ref) => ({ name: ref(v.name) }),
  fromJSON: (data, get) => {
    const nameRef = data.name.$ref;
    return { kind: 'var', id: '', name: get(nameRef) } as Var;
  },
};

export default async (test: (name: string, body: (validator: any) => any) => any) => {
  await test('bundle assigns version 1 and a single root', async (validator: any) => {
    const registry = new WireRegistry([nameAdapter, varAdapter]);
    const nameNode: Name = { kind: 'name', id: 'n1', value: 'alpha' };
    const varNode: Var = { kind: 'var', id: 'v1', name: nameNode };
    const bundle = registry.bundle([varNode]);
    return validator.expect({
      version: bundle.version,
      rootCount: bundle.roots.length,
      tableCount: Object.keys(bundle.table).length,
    }).toLookLike({ version: 1, rootCount: 1, tableCount: 2 });
  });

  await test('unbundle restores typed graph including referenced deps', async (validator: any) => {
    const registry = new WireRegistry([nameAdapter, varAdapter]);
    const nameNode: Name = { kind: 'name', id: 'n1', value: 'alpha' };
    const varNode: Var = { kind: 'var', id: 'v1', name: nameNode };
    const bundle = registry.bundle([varNode]);
    const [restored] = registry.unbundle(bundle);
    return validator.expect({
      kind: restored.kind,
      nameKind: restored.name.kind,
      nameValue: restored.name.value,
    }).toLookLike({ kind: 'var', nameKind: 'name', nameValue: 'alpha' });
  });

  await test('shared deps are deduplicated in the bundle table', async (validator: any) => {
    const registry = new WireRegistry([nameAdapter, varAdapter]);
    const shared: Name = { kind: 'name', id: 'shared', value: 'common' };
    const a: Var = { kind: 'var', id: 'a', name: shared };
    const b: Var = { kind: 'var', id: 'b', name: shared };
    const bundle = registry.bundle([a, b]);
    return validator.expect({
      roots: bundle.roots.length,
      total: Object.keys(bundle.table).length,
    }).toLookLike({ roots: 2, total: 3 });
  });
};
