'use strict';
/** XV: reversible read/diagnostic allocation reductions, not alternate business
 * semantics. Full Store scans, full commitments and old diagnostic wire shape
 * remain. CPU trace count, budget checkpoints and output limits are unchanged. */
const PREVIEW = [
  [
    "ascii-byte-length-fast-path",
    "export function compatUtf8Bytes(s: string): number {\n  let n = 0;",
    "// XV: stateless ASCII detection; non-ASCII retains the exact surrogate-aware path.\n// The reported byte limit is unchanged. No truncation, dropped fields or estimate.\nconst COMPAT_NON_ASCII = /[^\\x00-\\x7f]/;\nexport function compatUtf8Bytes(s: string): number {\n  if (typeof s === \"string\" && !COMPAT_NON_ASCII.test(s)) return s.length;\n  let n = 0;"
  ],
  [
    "one-own-descriptor-per-table-entry",
    "    if (!own(found.value, key)) continue;\n    const descriptor = Object.getOwnPropertyDescriptor(found.value, key);\n    if (!descriptor || !(\"value\" in descriptor)) return { status: \"accessor_unreadable\", count: null, value: undefined };",
    "    // XV: the descriptor lookup itself establishes own membership. Inherited\n    // enumerable keys are ignored; own accessors still reject the WHOLE table.\n    const descriptor = Object.getOwnPropertyDescriptor(found.value, key);\n    if (!descriptor) continue;\n    if (!(\"value\" in descriptor)) return { status: \"accessor_unreadable\", count: null, value: undefined };"
  ]
];
const CPU = [
  [
    "private-definition-lookups",
    "/** One instance per admitted sample; snapshots contain primitive values only.",
    "// XV: private, definition-only membership sets, never business/input caches.\n// No mutator or set reference escapes this module. Snapshot/validation semantics\n// and every CPU observation stay unchanged; no diagnostic overhead is subtracted.\nconst CPU_PHASE_NAMES = new Set<string>(COMPAT_CPU_PHASES);\nconst CPU_SUBPHASE_NAMES = new Set<string>(COMPAT_CPU_SUBPHASES);\nconst CPU_WORK_NAMES = new Set<string>(COMPAT_CPU_WORK_KEYS);\nconst CPU_TAIL_PHASES = Object.freeze([\"serializationAndSize\", \"emit\", \"retention\"] as const);\n/** One instance per admitted sample; snapshots contain primitive values only."
  ],
  [
    "scalar-start-validation",
    "  if (![start, tick, sampleOrdinal].every(Number.isFinite) || start < 0",
    "  if (!Number.isFinite(start) || !Number.isFinite(tick) || !Number.isFinite(sampleOrdinal) || start < 0"
  ],
  [
    "phase-membership",
    "!COMPAT_CPU_PHASES.includes(next ?? phase)",
    "!CPU_PHASE_NAMES.has(next ?? phase)"
  ],
  [
    "subphase-membership",
    "!COMPAT_CPU_SUBPHASES.includes(next)",
    "!CPU_SUBPHASE_NAMES.has(next)"
  ],
  [
    "work-membership",
    "!COMPAT_CPU_WORK_KEYS.includes(key as CompatCpuWorkKey)",
    "!CPU_WORK_NAMES.has(key)"
  ],
  [
    "bounded-work-presence",
    "  const work: Partial<Record<CompatCpuWorkKey, number>> = {};\n  const attribution = () => attributionBoundaries || Object.keys(work).length",
    "  const work: Partial<Record<CompatCpuWorkKey, number>> = {};\n  let hasWork = false;\n  const attribution = () => attributionBoundaries || hasWork"
  ],
  [
    "work-presence-update",
    "        work[key as CompatCpuWorkKey] = next;",
    "        work[key as CompatCpuWorkKey] = next;\n        hasWork = true;"
  ],
  [
    "reuse-tail-key-definition",
    "for (const key of [\"serializationAndSize\", \"emit\", \"retention\"] as const)",
    "for (const key of CPU_TAIL_PHASES)"
  ]
];
const CORE = [
  [
    "lazy-query-memo-container",
    "    const roomResourcesCache = new Map();",
    "    // XV: query results were already lazy. Allocate their private memo container\n    // only if roomResources is queried; no index or view capability is deferred.\n    let roomResourcesCache;"
  ],
  [
    "ensure-query-memo-on-use",
    "        roomResources(roomName) {\n            const cached = roomResourcesCache.get(roomName);",
    "        roomResources(roomName) {\n            if (!roomResourcesCache) roomResourcesCache = new Map();\n            const cached = roomResourcesCache.get(roomName);"
  ]
];
function transform(text, rules, inverse=false) {
  const order=inverse?[...rules].reverse():rules;
  for(const [id,before,after] of order) {
    const from=inverse?after:before, to=inverse?before:after;
    if(text.split(from).length!==2)throw new Error('READ_ENVELOPE_XV_TRANSFORM_COUNT:'+id);
    text=text.replace(from,to);
  }
  return text;
}
const descriptions=rules=>Object.freeze(rules.map(([id,before,after])=>Object.freeze({id,before,after})));
module.exports={previewTransform:s=>transform(s,PREVIEW),previewRestore:s=>transform(s,PREVIEW,true),
  cpuTransform:s=>transform(s,CPU),cpuRestore:s=>transform(s,CPU,true),
  coreTransform:s=>transform(s,CORE),coreRestore:s=>transform(s,CORE,true),
  previewRules:descriptions(PREVIEW),cpuRules:descriptions(CPU),coreRules:descriptions(CORE)};
