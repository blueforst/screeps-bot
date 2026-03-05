#!/usr/bin/env node

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";

const DEFAULT_MEMORY_INTERVAL_MS = 60_000;
const DEFAULT_SEGMENT_INTERVAL_MS = 10_000;
const DEFAULT_HTTP_PORT = 3131;
const DEFAULT_HISTORY_LIMIT = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_OUTPUT_PATH = "monitor-data/snapshots.jsonl";

function printHelp() {
  console.log(`Screeps monitor service

Usage:
  node scripts/monitor-service.mjs [options]

Options:
  --once                          Fetch once and print JSON
  --token <token>                 Screeps auth token
  --base-url <url>                API base URL (default: https://screeps.com/)
  --memory-interval-ms <ms>       Memory polling interval (default: 60000)
  --segment-id <id>               Optional RawMemory segment id (0-99)
  --shard <name>                  Optional shard name (e.g. shard2)
  --segment-interval-ms <ms>      Segment polling interval (default: 10000)
  --output <path|off>             JSONL output path (default: monitor-data/snapshots.jsonl)
  --port <port>                   HTTP server port (default: 3131)
  --history-limit <n>             In-memory history length (default: 200)
  --request-timeout-ms <ms>       API request timeout (default: 15000)
  --no-http                       Disable HTTP server mode
  --help                          Show this help

Environment variables:
  SCREEPS_TOKEN
  SCREEPS_BASE_URL
  SCREEPS_MONITOR_MEMORY_INTERVAL_MS
  SCREEPS_MONITOR_SEGMENT_ID
  SCREEPS_MONITOR_SHARD
  SCREEPS_MONITOR_SEGMENT_INTERVAL_MS
  SCREEPS_MONITOR_OUTPUT
  SCREEPS_MONITOR_PORT
  SCREEPS_MONITOR_HISTORY_LIMIT
  SCREEPS_MONITOR_REQUEST_TIMEOUT_MS
`);
}

function parseArgs(argv) {
  const args = {
    once: false,
    noHttp: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--once") {
      args.once = true;
      continue;
    }
    if (arg === "--no-http") {
      args.noHttp = true;
      continue;
    }

    const [key, inlineValue] = arg.includes("=") ? arg.split("=", 2) : [arg, undefined];
    if (
      key !== "--token" &&
      key !== "--base-url" &&
      key !== "--memory-interval-ms" &&
      key !== "--segment-id" &&
      key !== "--shard" &&
      key !== "--segment-interval-ms" &&
      key !== "--output" &&
      key !== "--port" &&
      key !== "--history-limit" &&
      key !== "--request-timeout-ms"
    ) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    const nextValue = inlineValue === undefined ? argv[index + 1] : inlineValue;
    if (nextValue === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    if (inlineValue === undefined) {
      index += 1;
    }

    if (key === "--token") {
      args.token = nextValue;
    } else if (key === "--base-url") {
      args.baseUrl = nextValue;
    } else if (key === "--memory-interval-ms") {
      args.memoryIntervalMs = nextValue;
    } else if (key === "--segment-id") {
      args.segmentId = nextValue;
    } else if (key === "--shard") {
      args.shard = nextValue;
    } else if (key === "--segment-interval-ms") {
      args.segmentIntervalMs = nextValue;
    } else if (key === "--output") {
      args.outputPath = nextValue;
    } else if (key === "--port") {
      args.port = nextValue;
    } else if (key === "--history-limit") {
      args.historyLimit = nextValue;
    } else if (key === "--request-timeout-ms") {
      args.requestTimeoutMs = nextValue;
    }
  }

  return args;
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url.toString();
}

function toInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function toOptionalInteger(value, min, max) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (value === "off") {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.max(min, Math.min(max, parsed));
}

function toOutputPath(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_OUTPUT_PATH;
  }
  const normalized = String(value).trim();
  if (normalized === "off") {
    return null;
  }
  return normalized;
}

function toOptionalShard(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

async function readSecretConfig() {
  try {
    const raw = await readFile(resolve(process.cwd(), ".secret.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : null;
  } catch {
    return null;
  }
}

function buildBaseUrlFromSecret(secretMain) {
  if (!secretMain || typeof secretMain !== "object") {
    return null;
  }
  const protocol = typeof secretMain.protocol === "string" ? secretMain.protocol : "https";
  const hostname = typeof secretMain.hostname === "string" ? secretMain.hostname : "screeps.com";
  const port = typeof secretMain.port === "number" ? `:${secretMain.port}` : "";
  const path = typeof secretMain.path === "string" ? secretMain.path : "/";
  return normalizeBaseUrl(`${protocol}://${hostname}${port}${path}`);
}

async function resolveConfig(args) {
  const secret = await readSecretConfig();
  const secretMain = secret && typeof secret.main === "object" ? secret.main : null;

  const token = args.token || process.env.SCREEPS_TOKEN || (secretMain && secretMain.token) || null;
  if (!token) {
    throw new Error("Missing Screeps token. Use --token, SCREEPS_TOKEN, or .secret.json main.token.");
  }

  const secretBaseUrl = buildBaseUrlFromSecret(secretMain);
  const baseUrl =
    normalizeBaseUrl(args.baseUrl || process.env.SCREEPS_BASE_URL || secretBaseUrl || "https://screeps.com/") ||
    "https://screeps.com/";

  const memoryIntervalMs = toInteger(
    args.memoryIntervalMs || process.env.SCREEPS_MONITOR_MEMORY_INTERVAL_MS,
    DEFAULT_MEMORY_INTERVAL_MS,
    5_000,
    3_600_000,
  );
  const segmentId = toOptionalInteger(args.segmentId || process.env.SCREEPS_MONITOR_SEGMENT_ID, 0, 99);
  const shard = toOptionalShard(args.shard || process.env.SCREEPS_MONITOR_SHARD);
  const segmentIntervalMs = toInteger(
    args.segmentIntervalMs || process.env.SCREEPS_MONITOR_SEGMENT_INTERVAL_MS,
    DEFAULT_SEGMENT_INTERVAL_MS,
    5_000,
    3_600_000,
  );
  const outputPath = toOutputPath(args.outputPath || process.env.SCREEPS_MONITOR_OUTPUT);
  const port = toInteger(args.port || process.env.SCREEPS_MONITOR_PORT, DEFAULT_HTTP_PORT, 1, 65535);
  const historyLimit = toInteger(
    args.historyLimit || process.env.SCREEPS_MONITOR_HISTORY_LIMIT,
    DEFAULT_HISTORY_LIMIT,
    1,
    10_000,
  );
  const requestTimeoutMs = toInteger(
    args.requestTimeoutMs || process.env.SCREEPS_MONITOR_REQUEST_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
    1_000,
    120_000,
  );

  return {
    once: args.once,
    noHttp: args.noHttp,
    token,
    baseUrl,
    memoryIntervalMs,
    segmentId,
    shard,
    segmentIntervalMs,
    outputPath,
    port,
    historyLimit,
    requestTimeoutMs,
  };
}

function safeJsonParse(value) {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function decodeScreepsDataString(value) {
  if (typeof value !== "string") {
    return value;
  }

  if (!value.startsWith("gz:")) {
    return safeJsonParse(value) ?? value;
  }

  const encoded = value.slice(3);
  try {
    const decompressed = gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
    return safeJsonParse(decompressed) ?? decompressed;
  } catch {
    return null;
  }
}

function extractRateLimit(headers) {
  return {
    limit: headers.get("x-ratelimit-limit"),
    remaining: headers.get("x-ratelimit-remaining"),
    reset: headers.get("x-ratelimit-reset"),
  };
}

async function fetchApiJson(config, endpoint, params) {
  const url = new URL(endpoint, config.baseUrl);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === null || value === undefined) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Token": config.token,
      "User-Agent": "screeps-monitor-service",
    },
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  const text = await response.text();
  const parsed = safeJsonParse(text);
  const payload = parsed === null ? text : parsed;
  const rateLimit = extractRateLimit(response.headers);

  if (!response.ok) {
    const bodyText = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(
      `HTTP ${response.status} for ${endpoint}: ${bodyText.slice(0, 300)} | remaining=${rateLimit.remaining ?? "?"}`,
    );
  }

  return {
    payload,
    rateLimit,
  };
}

function parseMemoryBody(payload) {
  if (payload && typeof payload === "object") {
    if ("data" in payload) {
      const data = payload.data;
      if (typeof data === "string") {
        const decoded = decodeScreepsDataString(data);
        if (decoded && typeof decoded === "object") {
          return decoded;
        }
        return null;
      }
      if (data && typeof data === "object") {
        return data;
      }
      return null;
    }
    if ("memory" in payload) {
      const memory = payload.memory;
      if (typeof memory === "string") {
        return safeJsonParse(memory);
      }
      if (memory && typeof memory === "object") {
        return memory;
      }
      return null;
    }
    if ("analytics" in payload) {
      return payload;
    }
  }

  if (typeof payload === "string") {
    const decoded = decodeScreepsDataString(payload);
    if (decoded && typeof decoded === "object") {
      return decoded;
    }
    return null;
  }
  return null;
}

function summarizeProduction(production) {
  const roomsRecord = production && typeof production === "object" ? production.rooms : null;
  if (!roomsRecord || typeof roomsRecord !== "object") {
    return {
      roomCount: 0,
      latestTick: null,
      totals: {
        looseEnergy: 0,
        storedEnergy: 0,
        sourceEnergy: 0,
        workers: 0,
        carriers: 0,
        harvesters: 0,
      },
      rooms: [],
    };
  }

  const rooms = Object.entries(roomsRecord).map(([roomName, roomState]) => {
    const latest = roomState && typeof roomState === "object" ? roomState.latest : null;
    const signal = roomState && typeof roomState === "object" ? roomState.signal : null;

    return {
      roomName,
      updatedAt: roomState && typeof roomState === "object" ? roomState.updatedAt ?? null : null,
      latest: {
        tick: latest && typeof latest === "object" ? latest.tick ?? null : null,
        looseEnergy: latest && typeof latest === "object" ? latest.looseEnergy ?? null : null,
        storedEnergy: latest && typeof latest === "object" ? latest.storedEnergy ?? null : null,
        sourceEnergy: latest && typeof latest === "object" ? latest.sourceEnergy ?? null : null,
        workerCount: latest && typeof latest === "object" ? latest.workerCount ?? null : null,
        carrierCount: latest && typeof latest === "object" ? latest.carrierCount ?? null : null,
        harvesterCount: latest && typeof latest === "object" ? latest.harvesterCount ?? null : null,
      },
      signal: {
        looseEnergyTrend: signal && typeof signal === "object" ? signal.looseEnergyTrend ?? null : null,
        sourceEnergyTrend: signal && typeof signal === "object" ? signal.sourceEnergyTrend ?? null : null,
        upgradeRate: signal && typeof signal === "object" ? signal.upgradeRate ?? null : null,
        spawnBusy: signal && typeof signal === "object" ? signal.spawnBusy ?? null : null,
      },
    };
  });

  rooms.sort((left, right) => left.roomName.localeCompare(right.roomName));

  let latestTick = null;
  const totals = {
    looseEnergy: 0,
    storedEnergy: 0,
    sourceEnergy: 0,
    workers: 0,
    carriers: 0,
    harvesters: 0,
  };

  for (const room of rooms) {
    if (typeof room.latest.tick === "number") {
      latestTick = latestTick === null ? room.latest.tick : Math.max(latestTick, room.latest.tick);
    }
    totals.looseEnergy += typeof room.latest.looseEnergy === "number" ? room.latest.looseEnergy : 0;
    totals.storedEnergy += typeof room.latest.storedEnergy === "number" ? room.latest.storedEnergy : 0;
    totals.sourceEnergy += typeof room.latest.sourceEnergy === "number" ? room.latest.sourceEnergy : 0;
    totals.workers += typeof room.latest.workerCount === "number" ? room.latest.workerCount : 0;
    totals.carriers += typeof room.latest.carrierCount === "number" ? room.latest.carrierCount : 0;
    totals.harvesters += typeof room.latest.harvesterCount === "number" ? room.latest.harvesterCount : 0;
  }

  return {
    roomCount: rooms.length,
    latestTick,
    totals,
    rooms,
  };
}

function summarizeModuleCpu(moduleCpu) {
  if (!moduleCpu || typeof moduleCpu !== "object") {
    return {
      available: false,
      updatedAt: null,
      sampleInterval: null,
      historyLimit: null,
      latest: null,
    };
  }

  const latestRaw = moduleCpu.latest && typeof moduleCpu.latest === "object" ? moduleCpu.latest : null;
  const phasesRaw = latestRaw && latestRaw.phases && typeof latestRaw.phases === "object" ? latestRaw.phases : {};
  const normalizedPhases = {};
  for (const [phase, used] of Object.entries(phasesRaw)) {
    if (typeof used === "number" && Number.isFinite(used)) {
      normalizedPhases[phase] = used;
    }
  }

  const topPhases = Object.entries(normalizedPhases)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([phase, used]) => ({ phase, used }));

  return {
    available: true,
    updatedAt: typeof moduleCpu.updatedAt === "number" ? moduleCpu.updatedAt : null,
    sampleInterval: typeof moduleCpu.sampleInterval === "number" ? moduleCpu.sampleInterval : null,
    historyLimit: typeof moduleCpu.historyLimit === "number" ? moduleCpu.historyLimit : null,
    latest: latestRaw
      ? {
          tick: typeof latestRaw.tick === "number" ? latestRaw.tick : null,
          shard: typeof latestRaw.shard === "string" ? latestRaw.shard : null,
          totalUsed: typeof latestRaw.totalUsed === "number" ? latestRaw.totalUsed : null,
          bucket: typeof latestRaw.bucket === "number" ? latestRaw.bucket : null,
          limit: typeof latestRaw.limit === "number" ? latestRaw.limit : null,
          tickLimit: typeof latestRaw.tickLimit === "number" ? latestRaw.tickLimit : null,
          untracked: typeof latestRaw.untracked === "number" ? latestRaw.untracked : null,
          phases: normalizedPhases,
          topPhases,
        }
      : null,
  };
}

function parseSegmentSnapshot(segmentId, payload) {
  if (!payload || typeof payload !== "object") {
    return {
      segmentId,
      parsed: null,
      rawSize: 0,
    };
  }

  const raw = "data" in payload ? payload.data : null;
  if (typeof raw === "string") {
    const parsed = decodeScreepsDataString(raw);
    return {
      segmentId,
      parsed,
      rawSize: raw.length,
    };
  }

  if (raw && typeof raw === "object") {
    return {
      segmentId,
      parsed: raw,
      rawSize: JSON.stringify(raw).length,
    };
  }

  return {
    segmentId,
    parsed: null,
    rawSize: 0,
  };
}

async function fetchMemorySnapshot(config) {
  const { payload, rateLimit } = await fetchApiJson(config, "/api/user/memory", {
    shard: config.shard,
    path: "analytics",
  });
  const memoryOrProduction = parseMemoryBody(payload);
  let production = null;
  let moduleCpu = null;
  if (memoryOrProduction && typeof memoryOrProduction === "object") {
    if ("rooms" in memoryOrProduction) {
      production = memoryOrProduction;
      if ("moduleCpu" in memoryOrProduction) {
        moduleCpu = memoryOrProduction.moduleCpu;
      }
    } else if ("production" in memoryOrProduction && memoryOrProduction.production) {
      production = memoryOrProduction.production;
      if ("moduleCpu" in memoryOrProduction) {
        moduleCpu = memoryOrProduction.moduleCpu;
      }
    } else if ("analytics" in memoryOrProduction && memoryOrProduction.analytics) {
      const analytics = memoryOrProduction.analytics;
      if (typeof analytics === "object" && analytics) {
        if ("production" in analytics) {
          production = analytics.production;
        }
        if ("moduleCpu" in analytics) {
          moduleCpu = analytics.moduleCpu;
        }
      }
    }
  }
  const summary = summarizeProduction(production);
  const moduleCpuSummary = summarizeModuleCpu(moduleCpu);

  return {
    source: "memory",
    fetchedAt: new Date().toISOString(),
    rateLimit,
    summary,
    moduleCpu: moduleCpuSummary,
  };
}

async function fetchSegmentSnapshot(config, segmentId) {
  const { payload, rateLimit } = await fetchApiJson(config, "/api/user/memory-segment", {
    segment: segmentId,
    shard: config.shard,
  });

  return {
    source: "segment",
    fetchedAt: new Date().toISOString(),
    rateLimit,
    snapshot: parseSegmentSnapshot(segmentId, payload),
  };
}

async function appendSnapshot(outputPath, payload) {
  if (!outputPath) {
    return;
  }
  const absolute = resolve(process.cwd(), outputPath);
  await mkdir(dirname(absolute), { recursive: true });
  await appendFile(absolute, `${JSON.stringify(payload)}\n`, "utf8");
}

function createState(config) {
  return {
    startedAt: new Date().toISOString(),
    config: {
      baseUrl: config.baseUrl,
      memoryIntervalMs: config.memoryIntervalMs,
      segmentId: config.segmentId,
      shard: config.shard,
      segmentIntervalMs: config.segmentIntervalMs,
      outputPath: config.outputPath,
      port: config.port,
    },
    latest: {
      memory: null,
      segment: null,
    },
    history: [],
    errors: [],
  };
}

function pushHistory(state, entry, limit) {
  state.history.push(entry);
  while (state.history.length > limit) {
    state.history.shift();
  }
}

function pushError(state, message, limit) {
  state.errors.push({
    at: new Date().toISOString(),
    message,
  });
  while (state.errors.length > limit) {
    state.errors.shift();
  }
}

function summarizeState(state) {
  const memory = state.latest.memory;
  const segment = state.latest.segment;
  const moduleCpu = memory && memory.moduleCpu ? memory.moduleCpu : null;
  const segmentParsed =
    segment && segment.snapshot && segment.snapshot.parsed && typeof segment.snapshot.parsed === "object"
      ? segment.snapshot.parsed
      : null;
  const segmentModuleCpu =
    segmentParsed && segmentParsed.moduleCpu && typeof segmentParsed.moduleCpu === "object" ? segmentParsed.moduleCpu : null;
  const latestModuleCpu = moduleCpu && moduleCpu.latest ? moduleCpu.latest : segmentModuleCpu;
  const segmentTruncated = !!(segmentParsed && segmentParsed.truncated);
  const segmentSchemaVersion = segmentParsed && typeof segmentParsed.version === "number" ? segmentParsed.version : null;

  return {
    startedAt: state.startedAt,
    roomCount: memory ? memory.summary.roomCount : 0,
    latestTick: memory ? memory.summary.latestTick : null,
    totals: memory ? memory.summary.totals : null,
    moduleCpuAvailable: moduleCpu ? moduleCpu.available : false,
    moduleCpuTick: latestModuleCpu ? latestModuleCpu.tick : null,
    moduleCpuTotalUsed: latestModuleCpu ? latestModuleCpu.totalUsed : null,
    moduleCpuTopPhases: latestModuleCpu ? latestModuleCpu.topPhases : [],
    segmentTruncated,
    segmentSchemaVersion,
    hasSegment: !!segment,
    segmentTick:
      segment && segment.snapshot && segment.snapshot.parsed && typeof segment.snapshot.parsed.tick === "number"
        ? segment.snapshot.parsed.tick
        : null,
    errorCount: state.errors.length,
    lastError: state.errors.length > 0 ? state.errors[state.errors.length - 1] : null,
  };
}

function writeJson(res, statusCode, body) {
  const serialized = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(serialized);
}

function createHttpServer(state) {
  return createServer((req, res) => {
    if (!req.url) {
      writeJson(res, 400, { ok: false, error: "missing url" });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname === "/health") {
      writeJson(res, 200, { ok: true, summary: summarizeState(state) });
      return;
    }
    if (url.pathname === "/state") {
      writeJson(res, 200, state);
      return;
    }
    if (url.pathname === "/rooms") {
      writeJson(res, 200, {
        rooms: state.latest.memory ? state.latest.memory.summary.rooms : [],
      });
      return;
    }
    if (url.pathname === "/history") {
      writeJson(res, 200, {
        history: state.history,
      });
      return;
    }
    if (url.pathname === "/cpu") {
      const segmentParsed =
        state.latest.segment &&
        state.latest.segment.snapshot &&
        state.latest.segment.snapshot.parsed &&
        typeof state.latest.segment.snapshot.parsed === "object"
          ? state.latest.segment.snapshot.parsed
          : null;
      writeJson(res, 200, {
        memoryModuleCpu: state.latest.memory ? state.latest.memory.moduleCpu : null,
        segmentModuleCpu: segmentParsed && segmentParsed.moduleCpu ? segmentParsed.moduleCpu : null,
        segmentTick: segmentParsed && typeof segmentParsed.tick === "number" ? segmentParsed.tick : null,
        segmentTruncated: !!(segmentParsed && segmentParsed.truncated),
        segmentSchemaVersion: segmentParsed && typeof segmentParsed.version === "number" ? segmentParsed.version : null,
      });
      return;
    }

    writeJson(res, 200, {
      summary: summarizeState(state),
      endpoints: ["/health", "/state", "/rooms", "/history", "/cpu"],
    });
  });
}

function logMemorySnapshot(snapshot) {
  const summary = snapshot.summary;
  const moduleCpu = snapshot.moduleCpu && snapshot.moduleCpu.latest ? snapshot.moduleCpu.latest : null;
  const topPhase = moduleCpu && moduleCpu.topPhases && moduleCpu.topPhases.length > 0
    ? `${moduleCpu.topPhases[0].phase}:${moduleCpu.topPhases[0].used.toFixed(2)}`
    : "n/a";
  console.log(
    `[monitor][memory] tick=${summary.latestTick ?? "n/a"} rooms=${summary.roomCount} workers=${summary.totals.workers} carriers=${summary.totals.carriers} loose=${summary.totals.looseEnergy} moduleCpuTick=${moduleCpu?.tick ?? "n/a"} moduleCpuUsed=${moduleCpu?.totalUsed ?? "n/a"} topPhase=${topPhase} remaining=${snapshot.rateLimit.remaining ?? "?"}`,
  );
}

function logSegmentSnapshot(snapshot) {
  const parsed = snapshot.snapshot.parsed;
  const tick = parsed && typeof parsed === "object" && typeof parsed.tick === "number" ? parsed.tick : "n/a";
  const version = parsed && typeof parsed === "object" && typeof parsed.version === "number" ? parsed.version : "n/a";
  const truncated = !!(parsed && typeof parsed === "object" && parsed.truncated);
  const moduleCpu = parsed && typeof parsed === "object" && parsed.moduleCpu ? parsed.moduleCpu : null;
  const phaseCount = moduleCpu && typeof moduleCpu.phases === "object" ? Object.keys(moduleCpu.phases).length : 0;
  console.log(
    `[monitor][segment] id=${snapshot.snapshot.segmentId} tick=${tick} ver=${version} truncated=${truncated} phaseCount=${phaseCount} size=${snapshot.snapshot.rawSize} remaining=${snapshot.rateLimit.remaining ?? "?"}`,
  );
}

async function runOnce(config) {
  const memory = await fetchMemorySnapshot(config);
  const segment = config.segmentId === null ? null : await fetchSegmentSnapshot(config, config.segmentId);
  const payload = {
    capturedAt: new Date().toISOString(),
    memory,
    segment,
  };
  await appendSnapshot(config.outputPath, payload);
  console.log(JSON.stringify(payload, null, 2));
}

async function runService(config) {
  const state = createState(config);
  let server = null;
  let memoryBusy = false;
  let segmentBusy = false;

  const pollMemory = async () => {
    if (memoryBusy) {
      return;
    }
    memoryBusy = true;
    try {
      const snapshot = await fetchMemorySnapshot(config);
      state.latest.memory = snapshot;
      pushHistory(
        state,
        {
          type: "memory",
          at: snapshot.fetchedAt,
          tick: snapshot.summary.latestTick,
          roomCount: snapshot.summary.roomCount,
        },
        config.historyLimit,
      );
      await appendSnapshot(config.outputPath, {
        capturedAt: snapshot.fetchedAt,
        memory: snapshot,
        segment: state.latest.segment,
      });
      logMemorySnapshot(snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushError(state, `[memory] ${message}`, config.historyLimit);
      console.error(`[monitor][memory][error] ${message}`);
    } finally {
      memoryBusy = false;
    }
  };

  const pollSegment = async () => {
    if (config.segmentId === null || segmentBusy) {
      return;
    }
    segmentBusy = true;
    try {
      const snapshot = await fetchSegmentSnapshot(config, config.segmentId);
      state.latest.segment = snapshot;
      pushHistory(
        state,
        {
          type: "segment",
          at: snapshot.fetchedAt,
          tick:
            snapshot.snapshot.parsed &&
            typeof snapshot.snapshot.parsed === "object" &&
            typeof snapshot.snapshot.parsed.tick === "number"
              ? snapshot.snapshot.parsed.tick
              : null,
          size: snapshot.snapshot.rawSize,
        },
        config.historyLimit,
      );
      logSegmentSnapshot(snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushError(state, `[segment] ${message}`, config.historyLimit);
      console.error(`[monitor][segment][error] ${message}`);
    } finally {
      segmentBusy = false;
    }
  };

  if (!config.noHttp) {
    server = createHttpServer(state);
    await new Promise((resolvePromise) => {
      server.listen(config.port, () => resolvePromise());
    });
    console.log(`[monitor] HTTP server listening on http://127.0.0.1:${config.port}`);
  }

  await pollMemory();
  if (config.segmentId !== null) {
    await pollSegment();
  }

  const memoryTimer = setInterval(() => {
    void pollMemory();
  }, config.memoryIntervalMs);

  const segmentTimer =
    config.segmentId === null
      ? null
      : setInterval(() => {
          void pollSegment();
        }, config.segmentIntervalMs);

  const shutdown = () => {
    clearInterval(memoryTimer);
    if (segmentTimer) {
      clearInterval(segmentTimer);
    }
    if (server) {
      server.close(() => process.exit(0));
      return;
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const config = await resolveConfig(args);
  console.log(
    `[monitor] base=${config.baseUrl} shard=${config.shard ?? "auto"} memoryInterval=${config.memoryIntervalMs}ms segment=${config.segmentId ?? "off"} output=${config.outputPath ?? "off"}`,
  );

  if (config.once) {
    await runOnce(config);
    return;
  }

  await runService(config);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[monitor][fatal] ${message}`);
  process.exit(1);
});
