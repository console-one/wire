// ─────────────────────────────────────────────────────────────────────────
// HoistCompilerBuilder — node handlers declare isSimple/renderInline/
// renderHoisted; the builder assembles a compiler that hoists non-simple
// nodes into named bindings (bucketed via classify) and inlines simple ones.
// ─────────────────────────────────────────────────────────────────────────

import { HoistCompilerBuilder } from '../index.js';

type ExprLit = { kind: 'lit'; v: number };
type ExprAdd = { kind: 'add'; l: any; r: any };

function buildArithCompiler() {
  return new HoistCompilerBuilder()
    .add<ExprLit>({
      type: 'lit',
      matches: (x: any): x is ExprLit => x && x.kind === 'lit',
      key: (e) => `lit:${e.v}`,
      dependencies: () => [],
      isSimple: () => true,
      renderInline: (e) => String(e.v),
      renderHoisted: () => ({ body: '' }),
    })
    .add<ExprAdd>({
      type: 'add',
      matches: (x: any): x is ExprAdd => x && x.kind === 'add',
      key: (e) => `add:${JSON.stringify(e)}`,
      classify: () => 'expr',
      dependencies: (e) => [e.l, e.r],
      isSimple: () => false,
      renderInline: (_e, _ref) => '',
      renderHoisted: (e, tryCompile) => ({
        body: `${tryCompile(e.l)} + ${tryCompile(e.r)}`,
        bucket: 'expr',
      }),
    })
    .build();
}

export default async (test: (name: string, body: (validator: any) => any) => any) => {
  await test('compileAll returns { sections, body }', async (validator: any) => {
    const compiler = buildArithCompiler();
    const expr: ExprAdd = { kind: 'add', l: { kind: 'lit', v: 2 }, r: { kind: 'lit', v: 3 } };
    const result = compiler.compileAll([expr]);
    return validator.expect({
      hasSections: 'sections' in result,
      hasBody: 'body' in result,
    }).toLookLike({ hasSections: true, hasBody: true });
  });

  await test('non-simple Add is hoisted into the expr bucket', async (validator: any) => {
    const compiler = buildArithCompiler();
    const expr: ExprAdd = { kind: 'add', l: { kind: 'lit', v: 2 }, r: { kind: 'lit', v: 3 } };
    const result = compiler.compileAll([expr]);
    const exprSection = result.sections['expr'] ?? [];
    return validator.expect(exprSection.length).toLookLike(1);
  });

  await test('hoisted body inlines its simple Lit children', async (validator: any) => {
    const compiler = buildArithCompiler();
    const expr: ExprAdd = { kind: 'add', l: { kind: 'lit', v: 2 }, r: { kind: 'lit', v: 3 } };
    const result = compiler.compileAll([expr]);
    const body = result.sections['expr'][0].body;
    return validator.expect({
      includes2: body.includes('2'),
      includes3: body.includes('3'),
      includesPlus: body.includes('+'),
    }).toLookLike({ includes2: true, includes3: true, includesPlus: true });
  });

  await test('emit produces non-empty rendered output', async (validator: any) => {
    const compiler = buildArithCompiler();
    const expr: ExprAdd = { kind: 'add', l: { kind: 'lit', v: 2 }, r: { kind: 'lit', v: 3 } };
    const rendered = compiler.emit(compiler.compileAll([expr]));
    return validator.expect(typeof rendered === 'string' && rendered.length > 0).toLookLike(true);
  });

  await test('shared subexpressions are hoisted once', async (validator: any) => {
    const compiler = buildArithCompiler();
    const shared: ExprAdd = { kind: 'add', l: { kind: 'lit', v: 1 }, r: { kind: 'lit', v: 2 } };
    const outer: ExprAdd = { kind: 'add', l: shared, r: shared };
    const result = compiler.compileAll([outer]);
    const exprSection = result.sections['expr'] ?? [];
    return validator.expect(exprSection.length).toLookLike(2);
  });
};
