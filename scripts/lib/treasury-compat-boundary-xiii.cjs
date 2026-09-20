'use strict';
/** XIII: exact XII preview transformation; core definitions are unchanged. */
const RULES = [
  [
    "options",
    "  options: { cpuDiagnostics?: boolean } = {}) {\n  const cpuDiagnostics = options?.cpuDiagnostics === true;",
    "  options: { cpuDiagnostics?: boolean; commitmentBoundaryDiagnostics?: boolean; localSafetyStop?: boolean } = {}) {\n  const cpuDiagnostics = options?.cpuDiagnostics === true;\n  const traceCommitment = cpuDiagnostics && options?.commitmentBoundaryDiagnostics === true;\n  const localSafetyStop = options?.localSafetyStop === true;"
  ],
  [
    "latch-state",
    "  let emitted = 0, cpuSkips = 0;",
    "  let emitted = 0, cpuSkips = 0;\n  // XIII: local containment, never an engine interrupt or a production rollback.\n  // No Memory write. A new heap arriving after the first due tick cannot re-arm.\n  let safetyStop: { tick: number; reason: string; observedCpu: number | null } | undefined;\n  let safetyNoticeAttempted = false;\n  const latch = (tick: number, used: number) => {\n    if (localSafetyStop && used > 5 && !safetyStop)\n      safetyStop = { tick, reason: \"CPU_OBSERVED_SAFETY_STOP\", observedCpu: used };\n  };\n  const notifySafety = () => {\n    if (!safetyStop || safetyNoticeAttempted) return;\n    safetyNoticeAttempted = true;\n    try { ports.emit(JSON.stringify({ kind: \"treasury-compat-safety-stop\", version: 1,\n      ...safetyStop, thresholdCpu: 5, stopsFutureSamples: true,\n      currentCallPreempted: false, scope: \"preview_heap_instance\", authorizesActions: false })); }\n    catch { /* Stop remains latched even if the one control notification fails. */ }\n  };"
  ],
  [
    "latched-return",
    "      if (fault) return { status: \"disabled_after_fault\" };",
    "      if (fault) return { status: \"disabled_after_fault\" };\n      if (safetyStop) return { status: \"disabled_after_safety_stop\" };"
  ],
  [
    "reset-admission",
    "      lastTick = tick;\n      if (ports.shard()",
    "      lastTick = tick;\n      if (localSafetyStop && sampleOrdinal === 0 && tick !== Math.ceil(cfg.startTick / cfg.intervalTicks) * cfg.intervalTicks) {\n        safetyStop = { tick, reason: \"WINDOW_RESTART_UNPROVEN\", observedCpu: null };\n        notifySafety(); return { status: \"disabled_after_safety_stop\" };\n      }\n      if (ports.shard()"
  ],
  [
    "trace-accounting",
    "      if (cpuDiagnostics) accounting = createCompatCpuAccounting(start.used, tick, sampleOrdinal);",
    "      if (cpuDiagnostics) accounting = createCompatCpuAccounting(start.used, tick, sampleOrdinal, traceCommitment);"
  ],
  [
    "budget-latch",
    "        latestCpu = c.used;\n        return c.used - start.used < cfg.maxSampleCpu",
    "        latestCpu = c.used;\n        latch(tick!, c.used - start.used);\n        return !safetyStop && c.used - start.used < cfg.maxSampleCpu"
  ],
  [
    "boundary-latch",
    "            sampleAccounting.attributionBoundary(c.used, phase);\n            latestCpu = c.used;",
    "            sampleAccounting.attributionBoundary(c.used, phase);\n            latestCpu = c.used;\n            latch(tick!, c.used - start.used);"
  ],
  [
    "call-brackets",
    "      const memory = ports.memory();",
    "      // Two added CPU reads per actual traced build. Argument creation stays\n      // inside parentStart -> callStart; wrapper/prologue stays before bodyStart.\n      const markCommitment = (name: \"callStart\" | \"callEnd\") => {\n        if (!traceCommitment || !accounting) return;\n        const c = ports.cpu();\n        if (!validCpu(c) || c.used < latestCpu) throw new Error(\"invalid CPU progression\");\n        accounting.commitmentMark(name, c.used);\n        latestCpu = c.used;\n        latch(tick!, c.used - start.used);\n      };\n      const memory = ports.memory();"
  ],
  [
    "invocation-after-guard",
    "      else if (readers && observations && budget(\"commitmentBuild\")) {\n        accounting?.invoked(\"commitmentBuild\");\n",
    "      else if (readers && observations && budget(\"commitmentBuild\")) {\n"
  ],
  [
    "build-options",
    "        const index = readers.buildCommitments({ tick, tasks: tasks.value, reservations: reservations.value, observation: observations, compatDiagnostics: builderDiagnostics });",
    "        const commitmentOptions = { tick, tasks: tasks.value, reservations: reservations.value, observation: observations, compatDiagnostics: builderDiagnostics };\n        markCommitment(\"callStart\");\n        if (safetyStop || (traceCommitment && latestCpu - start.used >= cfg.maxSampleCpu)) {\n          limited = true;\n          report.commitments = { status: \"not_read_cpu_budget\", rows: null };\n        } else {\n        accounting?.invoked(\"commitmentBuild\");\n        const index = readers.buildCommitments(commitmentOptions);\n        markCommitment(\"callEnd\");"
  ],
  [
    "guard-close",
    "          rows: fields, completeness: { ...c }, allTableScan: true, tableLimitEach: TABLE_LIMIT };\n",
    "          rows: fields, completeness: { ...c }, allTableScan: true, tableLimitEach: TABLE_LIMIT };\n        }\n"
  ],
  [
    "report-revision",
    "      report.cooperativeBudget = true;",
    "      report.cooperativeBudget = true;\n      if (traceCommitment) report.diagnosticRevision = \"XIII\";\n      if (localSafetyStop) report.localSafety = { thresholdCpu: 5, latched: !!safetyStop,\n        reason: safetyStop?.reason ?? null, scope: \"preview_heap_instance\", currentCallPreempted: false };"
  ],
  [
    "ending-latch",
    "      latestCpu = end.used;\n      previous =",
    "      latestCpu = end.used;\n      latch(tick!, end.used - start.used);\n      previous ="
  ],
  [
    "control-notice",
    "        previousCpuProfile = accounting.snapshot(\"afterRetention\");\n      }\n      return { status };",
    "        previousCpuProfile = accounting.snapshot(\"afterRetention\");\n      }\n      notifySafety();\n      return { status };"
  ],
  [
    "stats-latch",
    "    cpuProfile: previousCpuProfile }) };",
    "    cpuProfile: previousCpuProfile,\n    ...(localSafetyStop ? { safetyStopped: !!safetyStop, safetyReason: safetyStop?.reason ?? null } : {}) }) };"
  ]
];
function apply(text,reverse=false) {
  for (const [name,before,after] of reverse ? [...RULES].reverse() : RULES) {
    const from=reverse?after:before,to=reverse?before:after;
    if (text.split(from).length!==2) { const e=new Error('BOUNDARY_XIII_TRANSFORM_COUNT:'+name); e.code='BOUNDARY_XIII_TRANSFORM_COUNT'; throw e; }
    text=text.replace(from,()=>to);
  }
  return text;
}
module.exports={transform:text=>apply(text),restore:text=>apply(text,true),rules:Object.freeze(RULES.map(([name])=>Object.freeze({name,replacements:1})))};
