// Structural codec — dictionary-based compression with delta encoding
export { StructCodec, compactTree, expandTree } from './codec.js'
export type {
  Diff,
  Encoded,
  EncodedRef,
  EncodedDelta,
  EncodedLit,
  EncodedNested,
  CodecSnapshot,
  CompactedTree
} from './codec.js'

// Bundler — adapter-driven serialization of object graphs with stable keys
export { WireRegistry, djb2 } from './registry.js'
export type { WireRecord, WireBundle } from './registry.js'

// Adapter contract
export type { NodeAdapter } from './nodeadaptor.js'

// Compiler — code generation with hoisting
export { HoistCompilerBuilder } from './compiler.js'
export type {
  TryCompile,
  HoistedNode,
  CompileSections,
  CompileResult,
  HoistHandler,
  NodeHandler,
  CompilerOptions
} from './compiler.js'
