'use strict';
/** XIV authoring: exact reversible checked-arithmetic and per-sample cursor transforms.
 * Canonical validators, health/owner/expiry helpers and index semantics are retained.
 * First-pending probe pair is bounded per table, including overflow continuations. */
const PREVIEW = [
  [
    "one-descriptor-path-read",
    "    if (!own(p, key)) return { status: \"absent\" };\n    const desc = Object.getOwnPropertyDescriptor(p, key);\n    if (!desc || !(\"value\" in desc)) return { status: \"accessor_unreadable\" };",
    "    const desc = Object.getOwnPropertyDescriptor(p, key);\n    if (!desc) return { status: \"absent\" };\n    if (!(\"value\" in desc)) return { status: \"accessor_unreadable\" };"
  ],
  [
    "projection-cursor-signature",
    "function legacyProjection(memory: unknown, room: string, kind: Kind, d: Direct, tick: number) {\n  const raw = pathValue(memory, [\"runtime\", \"resourceControl\"]);",
    "function legacyProjection(raw: Found, room: string, kind: Kind, d: Direct, tick: number) {"
  ],
  [
    "projection-cursor-sample",
    "      const rows: Rec[] = []; report.endpoints = rows;",
    "      // XIV: own-data path cursor, local to this admitted sample; never Store authority.\n      let projectionSource: Found | undefined;\n      const rows: Rec[] = []; report.endpoints = rows;"
  ],
  [
    "projection-cursor-use",
    "            row.legacyProjection = legacyProjection(memory, name, kind, d.value, tick);",
    "            projectionSource ??= pathFrom(runtimeRoot, [\"resourceControl\"]);\n            row.legacyProjection = legacyProjection(projectionSource, name, kind, d.value, tick);"
  ],
  [
    "task-probe-option",
    "options: { cpuDiagnostics?: boolean; commitmentBoundaryDiagnostics?: boolean; localSafetyStop?: boolean } = {})",
    "options: { cpuDiagnostics?: boolean; commitmentBoundaryDiagnostics?: boolean; localSafetyStop?: boolean; taskBoundaryDiagnostics?: boolean } = {})"
  ],
  [
    "task-probe-enabled",
    "  const traceCommitment = cpuDiagnostics && options?.commitmentBoundaryDiagnostics === true;",
    "  const traceCommitment = cpuDiagnostics && options?.commitmentBoundaryDiagnostics === true;\n  const taskBoundaryDiagnostics = traceCommitment && options?.taskBoundaryDiagnostics === true;"
  ],
  [
    "task-accounting-enable",
    "createCompatCpuAccounting(start.used, tick, sampleOrdinal, traceCommitment)",
    "createCompatCpuAccounting(start.used, tick, sampleOrdinal, traceCommitment, taskBoundaryDiagnostics)"
  ],
  [
    "task-probe-callback",
    "          work(values: Readonly<Partial<Record<CompatCpuWorkKey, number>>>) { sampleAccounting.attributionWork(values); },",
    "          work(values: Readonly<Partial<Record<CompatCpuWorkKey, number>>>) { sampleAccounting.attributionWork(values); },\n          ...(taskBoundaryDiagnostics ? {\n            taskBoundary(mark: \"firstPendingStart\" | \"firstPendingEnd\", recordOrdinal: number) {\n              const c = ports.cpu();\n              if (!validCpu(c) || c.used < latestCpu) throw new Error(\"invalid CPU progression\");\n              sampleAccounting.taskMark(mark, c.used, recordOrdinal);\n              latestCpu = c.used;\n              latch(tick!, c.used - start.used);\n            },\n          } : {}),"
  ],
  [
    "report-revision",
    "report.diagnosticRevision = \"XIII\";",
    "report.diagnosticRevision = taskBoundaryDiagnostics ? \"XIV\" : \"XIII\";"
  ]
];
const CORE = [
  [
    "inline-scope-additions",
    "        const mergedOutgoing = addSafeInteger(outBucket ? outBucket.outgoing : 0, task.remainingAmount);\n        const mergedPendingIncoming = addSafeInteger(inBucket ? inBucket.pendingIncoming : 0, task.remainingAmount);\n        if (mergedOutgoing === null || mergedPendingIncoming === null) {",
    "        // XIV: same additions and safe-integer guards, without per-record helper calls.\n        const mergedOutgoing = (outBucket ? outBucket.outgoing : 0) + task.remainingAmount;\n        const mergedPendingIncoming = (inBucket ? inBucket.pendingIncoming : 0) + task.remainingAmount;\n        if (!Number.isSafeInteger(mergedOutgoing) || !Number.isSafeInteger(mergedPendingIncoming)) {"
  ],
  [
    "inline-reason-addition",
    "        const mergedByReason = addSafeInteger((_h = byReason.get(reason)) !== null && _h !== void 0 ? _h : 0, task.remainingAmount);",
    "        const mergedByReason = ((_h = byReason.get(reason)) !== null && _h !== void 0 ? _h : 0) + task.remainingAmount;"
  ],
  [
    "reason-overflow-guard",
    "        if (mergedByReason === null) {",
    "        if (!Number.isSafeInteger(mergedByReason)) {"
  ],
  [
    "inline-incoming-addition",
    "            const mergedIncoming = addSafeInteger(inBucket.incoming, task.remainingAmount);\n            if (mergedIncoming === null) {",
    "            const mergedIncoming = inBucket.incoming + task.remainingAmount;\n            if (!Number.isSafeInteger(mergedIncoming)) {"
  ],
  [
    "fixed-task-probe-state",
    "    metrics.taskRecords = taskIds.length;\n    for (const taskId of taskIds) {\n        const task = options.tasks[taskId];",
    "    metrics.taskRecords = taskIds.length;\n    // At most one selected first-pending region per whole table, not per-record sampling.\n    const firstPendingProbe = compatDiagnostics && compatDiagnostics.taskBoundary;\n    let firstPendingObserved = false, taskOrdinal = 0;\n    for (const taskId of taskIds) {\n        taskOrdinal += 1;\n        const task = options.tasks[taskId];"
  ],
  [
    "first-pending-region-start",
    "        metrics.pendingTaskRecords += 1;\n        const reason = task.reason || \"\";",
    "        metrics.pendingTaskRecords += 1;\n        const traceThisPending = !firstPendingObserved && typeof firstPendingProbe === \"function\";\n        if (traceThisPending) {\n            firstPendingObserved = true;\n            firstPendingProbe.call(compatDiagnostics, \"firstPendingStart\", taskOrdinal);\n        }\n        try {\n        const reason = task.reason || \"\";"
  ],
  [
    "first-pending-region-finally",
    "            toBucket.healthyCount += 1;\n        }\n    }\n    // ── production reservation",
    "            toBucket.healthyCount += 1;\n        }\n        } finally {\n            // Includes every overflow/early-continue path, without inventing a successful task.\n            if (traceThisPending) firstPendingProbe.call(compatDiagnostics, \"firstPendingEnd\", taskOrdinal);\n        }\n    }\n    // ── production reservation"
  ]
];
function rewrite(text,rules,reverse){let out=text;for(const [name,before,after] of (reverse?[...rules].reverse():rules)){const a=reverse?after:before,b=reverse?before:after;const count=out.split(a).length-1;if(count!==1){const e=new Error('TASK_XIV_TRANSFORM_COUNT:'+name+':'+count);e.code='TASK_XIV_TRANSFORM_COUNT';throw e;}out=out.replace(a,b);}return out;}
const previewTransform=text=>rewrite(text,PREVIEW,false),previewRestore=text=>rewrite(text,PREVIEW,true);
const coreTransform=text=>rewrite(text,CORE,false),coreRestore=text=>rewrite(text,CORE,true);
module.exports={previewTransform,previewRestore,coreTransform,coreRestore,
 previewRules:Object.freeze(PREVIEW.map(([name])=>Object.freeze({name,replacements:1}))),
 coreRules:Object.freeze(CORE.map(([name])=>Object.freeze({name,replacements:1})))};
