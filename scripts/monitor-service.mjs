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
const RESOURCE_CONTROL_ROUTE_LIMIT = 20;

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
  --shards <csv>                  Shard candidates for auto-selection (default: shard0,shard1,shard2,shard3)
  --segment-interval-ms <ms>      Segment polling interval (default: 10000)
  --output <path|off>             JSONL output path (default: monitor-data/snapshots.jsonl)
  --port <port>                   HTTP server port (default: 3131)
  --history-limit <n>             In-memory history length (default: 200)
  --request-timeout-ms <ms>       API request timeout (default: 15000)
  --no-http                       Disable HTTP server mode
  --memory-fixture <path>         Load memory from JSON file instead of API (for testing)
  --help                          Show this help

Shard behavior:
  Without --shard, the monitor tries all --shards candidates and selects the
  one with the most recent hub analytics, deploy tag timestamp, or latest tick.

Environment variables:
  SCREEPS_TOKEN
  SCREEPS_BASE_URL
  SCREEPS_MONITOR_MEMORY_INTERVAL_MS
  SCREEPS_MONITOR_SEGMENT_ID
  SCREEPS_MONITOR_SHARD
  SCREEPS_MONITOR_SHARDS
  SCREEPS_MONITOR_SEGMENT_INTERVAL_MS
  SCREEPS_MONITOR_OUTPUT
  SCREEPS_MONITOR_PORT
  SCREEPS_MONITOR_HISTORY_LIMIT
  SCREEPS_MONITOR_REQUEST_TIMEOUT_MS
  SCREEPS_MONITOR_MEMORY_FIXTURE
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
      key !== "--request-timeout-ms" &&
      key !== "--memory-fixture" &&
      key !== "--shards"
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
    } else if (key === "--memory-fixture") {
      args.memoryFixture = nextValue;
    } else if (key === "--shards") {
      args.shards = nextValue;
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

  const memoryFixture =
    process.env.SCREEPS_MONITOR_MEMORY_FIXTURE || args.memoryFixture || null;

  const token = args.token || process.env.SCREEPS_TOKEN || (secretMain && secretMain.token) || null;
  // Token required for live API; fixture-only mode with no segment can work without token
  const segmentId = toOptionalInteger(args.segmentId || process.env.SCREEPS_MONITOR_SEGMENT_ID, 0, 99);
  if (!token && !memoryFixture) {
    throw new Error("Missing Screeps token. Use --token, SCREEPS_TOKEN, or .secret.json main.token.");
  }
  if (!token && memoryFixture && segmentId !== null) {
    throw new Error("Missing Screeps token. Token required for segment fetch even with --memory-fixture. Use --segment-id off to disable.");
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

  const shardsRaw = args.shards || process.env.SCREEPS_MONITOR_SHARDS || "shard0,shard1,shard2,shard3";
  const shardCandidates = String(shardsRaw)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const explicitShard = !!(args.shard || process.env.SCREEPS_MONITOR_SHARD);

  return {
    once: args.once,
    noHttp: args.noHttp,
    token,
    baseUrl,
    memoryIntervalMs,
    segmentId,
    shard,
    explicitShard,
    shardCandidates,
    segmentIntervalMs,
    outputPath,
    port,
    historyLimit,
    requestTimeoutMs,
    memoryFixture,
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
      source: "legacy",
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
    source: "legacy",
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

function summarizeCpuMonitor(cpuMonitor, fallbackModuleCpu) {
  // Prefer v2 cpuMonitor when present
  if (cpuMonitor && typeof cpuMonitor === "object" && cpuMonitor.version === 2) {
    const latestRaw = cpuMonitor.latest && typeof cpuMonitor.latest === "object" ? cpuMonitor.latest : null;
    const summaryRaw = cpuMonitor.summary && typeof cpuMonitor.summary === "object" ? cpuMonitor.summary : null;

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

    // Config: segment shape uses cpuMonitor.config.*, Memory shape uses top-level fields
    const configRaw = cpuMonitor.config && typeof cpuMonitor.config === "object" ? cpuMonitor.config : {};
    const sampleInterval = typeof cpuMonitor.sampleInterval === "number" ? cpuMonitor.sampleInterval
      : typeof configRaw.sampleInterval === "number" ? configRaw.sampleInterval : null;
    const historyLimit = typeof cpuMonitor.historyLimit === "number" ? cpuMonitor.historyLimit
      : typeof configRaw.historyLimit === "number" ? configRaw.historyLimit : null;
    const fixedActionCpuCost = typeof configRaw.fixedActionCpuCost === "number" ? configRaw.fixedActionCpuCost : 0.2;

    // Fixed action estimate — 3-tier priority:
    // 1. Sum latest.fixedActionCounts * cost (most precise)
    // 2. latest.fixedActionEstimate if present (segment pre-computed)
    // 3. summary.fixedActionEstimate fallback (aggregated)
    const fixedActionCounts = latestRaw && latestRaw.fixedActionCounts && typeof latestRaw.fixedActionCounts === "object"
      ? latestRaw.fixedActionCounts : {};
    let fixedActionEstimate = 0;
    for (const count of Object.values(fixedActionCounts)) {
      if (typeof count === "number" && Number.isFinite(count)) {
        fixedActionEstimate += count * fixedActionCpuCost;
      }
    }
    if (fixedActionEstimate === 0) {
      if (latestRaw && typeof latestRaw.fixedActionEstimate === "number" && Number.isFinite(latestRaw.fixedActionEstimate)) {
        fixedActionEstimate = latestRaw.fixedActionEstimate;
      } else if (summaryRaw && typeof summaryRaw.fixedActionEstimate === "number" && Number.isFinite(summaryRaw.fixedActionEstimate)) {
        fixedActionEstimate = summaryRaw.fixedActionEstimate;
      }
    }

    // Top rooms/roles
    const topRooms = [];
    const topRoomRoles = [];
    if (latestRaw && latestRaw.rooms && typeof latestRaw.rooms === "object") {
      const roomEntries = [];
      for (const [roomName, roomData] of Object.entries(latestRaw.rooms)) {
        if (!roomData || typeof roomData !== "object") continue;
        let roomTotal = typeof roomData.totalUsed === "number" ? roomData.totalUsed : 0;
        roomEntries.push({ roomName, totalUsed: roomTotal, roles: roomData.roles || {} });
      }
      roomEntries.sort((a, b) => b.totalUsed - a.totalUsed);
      for (const re of roomEntries.slice(0, 5)) {
        topRooms.push({ room: re.roomName, totalUsed: re.totalUsed });
        if (re.roles && typeof re.roles === "object") {
          const roleEntries = Object.entries(re.roles)
            .filter(([, rd]) => rd && typeof rd === "object")
            .map(([role, rd]) => ({ room: re.roomName, role, avgUsed: typeof rd.used === "number" ? rd.used : 0, count: typeof rd.count === "number" ? rd.count : 0 }))
            .sort((a, b) => b.avgUsed - a.avgUsed);
          for (const rre of roleEntries.slice(0, 3)) {
            topRoomRoles.push(rre);
          }
        }
      }
    }

    // Heap
    const heapRaw = latestRaw && latestRaw.heap ? latestRaw.heap : null;
    let heap = null;
    if (heapRaw && typeof heapRaw === "object") {
      heap = {
        used_heap_size: typeof heapRaw.used_heap_size === "number" ? heapRaw.used_heap_size : null,
        total_heap_size: typeof heapRaw.total_heap_size === "number" ? heapRaw.total_heap_size : null,
        heap_size_limit: typeof heapRaw.heap_size_limit === "number" ? heapRaw.heap_size_limit : null,
      };
    }

    // Summary top phases: Memory shape uses avgPhases (record), segment shape uses topPhases (record or array)
    const summaryTopPhases = [];
    if (summaryRaw && summaryRaw.avgPhases && typeof summaryRaw.avgPhases === "object" && !Array.isArray(summaryRaw.avgPhases)) {
      for (const [phase, avg] of Object.entries(summaryRaw.avgPhases).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
        if (typeof avg === "number" && Number.isFinite(avg)) {
          summaryTopPhases.push({ phase, avgUsed: avg });
        }
      }
    } else if (summaryRaw && summaryRaw.topPhases && typeof summaryRaw.topPhases === "object" && !Array.isArray(summaryRaw.topPhases)) {
      // Segment shape: topPhases is a record { phase: avgUsed }
      for (const [phase, avg] of Object.entries(summaryRaw.topPhases).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
        if (typeof avg === "number" && Number.isFinite(avg)) {
          summaryTopPhases.push({ phase, avgUsed: avg });
        }
      }
    } else if (summaryRaw && Array.isArray(summaryRaw.topPhases)) {
      for (const entry of summaryRaw.topPhases.slice(0, 8)) {
        if (entry && typeof entry === "object") {
          const phase = typeof entry.phase === "string" ? entry.phase : String(entry.phase ?? "");
          const avgUsed = typeof entry.avgUsed === "number" && Number.isFinite(entry.avgUsed) ? entry.avgUsed : 0;
          if (phase) summaryTopPhases.push({ phase, avgUsed });
        }
      }
    }

    // Summary top room roles (segment shape)
    const summaryTopRoomRoles = [];
    if (summaryRaw && Array.isArray(summaryRaw.topRoomRoles)) {
      for (const entry of summaryRaw.topRoomRoles.slice(0, 10)) {
        if (entry && typeof entry === "object") {
          summaryTopRoomRoles.push({
            room: typeof entry.room === "string" ? entry.room : "",
            role: typeof entry.role === "string" ? entry.role : "",
            avgUsed: typeof entry.avgUsed === "number" && Number.isFinite(entry.avgUsed) ? entry.avgUsed : 0,
            count: typeof entry.count === "number" ? entry.count : 0,
          });
        }
      }
    }

    // History size
    const historyRaw = Array.isArray(cpuMonitor.history) ? cpuMonitor.history : null;
    const historySize = historyRaw ? historyRaw.length : null;

    return {
      available: true,
      version: 2,
      source: "cpuMonitor",
      updatedAt: typeof cpuMonitor.updatedAt === "number" ? cpuMonitor.updatedAt : null,
      sampleInterval,
      historyLimit,
      config: Object.keys(configRaw).length > 0 ? { fixedActionCpuCost, sampleInterval, historyLimit } : null,
      historySize,
      latest: latestRaw
        ? {
            tick: typeof latestRaw.tick === "number" ? latestRaw.tick : null,
            shard: typeof latestRaw.shard === "string" ? latestRaw.shard : null,
            totalUsed: typeof latestRaw.totalUsed === "number" ? latestRaw.totalUsed : null,
            bucket: typeof latestRaw.bucket === "number" ? latestRaw.bucket : null,
            limit: typeof latestRaw.limit === "number" ? latestRaw.limit : null,
            tickLimit: typeof latestRaw.tickLimit === "number" ? latestRaw.tickLimit : null,
            untracked: typeof latestRaw.untracked === "number" ? latestRaw.untracked : null,
            emaTotalUsed: typeof latestRaw.emaTotalUsed === "number" ? latestRaw.emaTotalUsed : null,
            phases: normalizedPhases,
            topPhases,
            fixedActionEstimate,
            topRooms,
            topRoomRoles,
            heap,
          }
        : null,
      summary: summaryRaw
        ? {
            ticks: typeof summaryRaw.ticks === "number" ? summaryRaw.ticks : null,
            avgTotalUsed: typeof summaryRaw.avgTotalUsed === "number" ? summaryRaw.avgTotalUsed : null,
            maxTotalUsed: typeof summaryRaw.maxTotalUsed === "number" ? summaryRaw.maxTotalUsed : null,
            avgBucket: typeof summaryRaw.avgBucket === "number" ? summaryRaw.avgBucket : null,
            minBucket: typeof summaryRaw.minBucket === "number" ? summaryRaw.minBucket : null,
            emaTotalUsed: typeof summaryRaw.emaTotalUsed === "number" ? summaryRaw.emaTotalUsed : null,
            fixedActionEstimate: (() => {
              if (typeof summaryRaw.fixedActionEstimate === "number" && Number.isFinite(summaryRaw.fixedActionEstimate)) {
                return summaryRaw.fixedActionEstimate;
              }
              if (summaryRaw.avgFixedActionCounts && typeof summaryRaw.avgFixedActionCounts === "object") {
                let sum = 0;
                for (const count of Object.values(summaryRaw.avgFixedActionCounts)) {
                  if (typeof count === "number" && Number.isFinite(count)) sum += count;
                }
                if (sum > 0) return sum * fixedActionCpuCost;
              }
              return null;
            })(),
            topPhases: summaryTopPhases,
            topRoomRoles: summaryTopRoomRoles,
          }
        : null,
    };
  }

  // Legacy fallback
  if (fallbackModuleCpu && typeof fallbackModuleCpu === "object") {
    const legacy = summarizeModuleCpu(fallbackModuleCpu);
    return {
      ...legacy,
      version: 1,
    };
  }

  return {
    available: false,
    version: null,
    source: "none",
    updatedAt: null,
    sampleInterval: null,
    historyLimit: null,
    config: null,
    historySize: null,
    latest: null,
    summary: null,
  };
}

function summarizeHub(hub) {
  if (!hub || typeof hub !== "object") {
    return { available: false, updatedAt: null };
  }
  return {
    available: true,
    updatedAt: hub.updatedAt ?? null,
    enabled: hub.enabled ?? false,
    hubRoomName: hub.hubRoomName ?? "",
    hubRoomVisible: hub.hubRoomVisible ?? false,
    status: hub.status ?? null,
    stage: hub.stage ?? null,
    activeProduct: hub.activeProduct ?? null,
    missingResources: Array.isArray(hub.missingResources) ? hub.missingResources : [],
    lastError: hub.lastError ?? null,
    needsPlan: hub.needsPlan ?? false,
    hubStorageEnergy: hub.hubStorageEnergy ?? 0,
    hubTerminalEnergy: hub.hubTerminalEnergy ?? 0,
    hubInventory: hub.hubInventory && typeof hub.hubInventory === "object" ? hub.hubInventory : {},
    pendingImports: hub.pendingImports ?? 0,
    pendingReclaims: hub.pendingReclaims ?? 0,
    pendingExports: hub.pendingExports ?? 0,
    pendingTaskCount: Array.isArray(hub.pendingTasks) ? hub.pendingTasks.length : 0,
    roomTerminalBlockers: Array.isArray(hub.roomTerminalBlockers) ? hub.roomTerminalBlockers : [],
  };
}

function finiteNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tickAge(referenceTick, eventTick) {
  if (!Number.isFinite(referenceTick) || !Number.isFinite(eventTick)) {
    return null;
  }
  return Math.max(0, referenceTick - eventTick);
}

function summarizeCountMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, count]) => typeof count === "number" && Number.isFinite(count))
      .sort(([leftReason], [rightReason]) => leftReason.localeCompare(rightReason)),
  );
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function summarizeCountMapOrNull(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return summarizeCountMap(value);
}

function summarizeCapacityPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    enabled: booleanOrNull(value.enabled),
    terminalHeadroomRecoveryEnabled: booleanOrNull(value.terminalHeadroomRecoveryEnabled),
    storagePressureFreeCapacity: finiteNumberOrNull(value.storagePressureFreeCapacity),
    storageReliefTargetFreeCapacity: finiteNumberOrNull(value.storageReliefTargetFreeCapacity),
    receiverStorageMinFreeCapacity: finiteNumberOrNull(value.receiverStorageMinFreeCapacity),
    terminalPressureFreeCapacity: finiteNumberOrNull(value.terminalPressureFreeCapacity),
    terminalReliefTargetFreeCapacity: finiteNumberOrNull(value.terminalReliefTargetFreeCapacity),
    receiverTerminalMinFreeCapacity: finiteNumberOrNull(value.receiverTerminalMinFreeCapacity),
  };
}

function summarizeCapacityReservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    committed: finiteNumberOrNull(value.committed),
    remaining: finiteNumberOrNull(value.remaining),
  };
}

function summarizeStaging(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    admittedAmount: finiteNumberOrNull(value.admittedAmount),
    admittedTaskCount: finiteNumberOrNull(value.admittedTaskCount),
    admittedByResource: summarizeCountMap(value.admittedByResource),
    suppressedCount: finiteNumberOrNull(value.suppressedCount),
    suppressedByReason: summarizeCountMap(value.suppressedByReason),
  };
}

function summarizeTaskHealth(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    pendingIncoming: finiteNumberOrNull(value.pendingIncoming),
    pendingOutgoing: finiteNumberOrNull(value.pendingOutgoing),
    blockedIncoming: summarizeCountMap(value.blockedIncoming),
    blockedOutgoing: summarizeCountMap(value.blockedOutgoing),
  };
}

function summarizeTaskSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    pending: finiteNumberOrNull(value.pending),
    manualPending: finiteNumberOrNull(value.manualPending),
    automaticPending: finiteNumberOrNull(value.automaticPending),
    blockedByReason: summarizeCountMap(value.blockedByReason),
  };
}

function summarizeCapacityReliefRoutes(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((route) => route && typeof route === "object" && !Array.isArray(route))
    .slice(-RESOURCE_CONTROL_ROUTE_LIMIT)
    .map((route) => ({
      tick: finiteNumberOrNull(route.tick),
      taskId: typeof route.taskId === "string" ? route.taskId : null,
      fromRoomName: typeof route.fromRoomName === "string" ? route.fromRoomName : null,
      toRoomName: typeof route.toRoomName === "string" ? route.toRoomName : null,
      resource: typeof route.resource === "string" ? route.resource : null,
      amount: finiteNumberOrNull(route.amount),
      transferCost: finiteNumberOrNull(route.transferCost),
    }));
}

function summarizeResourceControl(runtimeResourceControl, transferTaskStore) {
  const runtime =
    runtimeResourceControl && typeof runtimeResourceControl === "object" && !Array.isArray(runtimeResourceControl)
      ? runtimeResourceControl
      : null;
  const tasks =
    transferTaskStore && typeof transferTaskStore === "object" && !Array.isArray(transferTaskStore)
      ? transferTaskStore
      : null;
  const referenceTick = runtime ? finiteNumberOrNull(runtime.updatedAt) : null;
  const roomsRecord =
    runtime && runtime.rooms && typeof runtime.rooms === "object" && !Array.isArray(runtime.rooms)
      ? runtime.rooms
      : {};

  const rooms = Object.entries(roomsRecord)
    .sort(([leftRoomName], [rightRoomName]) => leftRoomName.localeCompare(rightRoomName))
    .map(([roomName, roomState]) => {
      const room = roomState && typeof roomState === "object" && !Array.isArray(roomState) ? roomState : {};
      return {
        roomName,
        state: typeof room.state === "string" ? room.state : null,
        capacityState: typeof room.capacityState === "string" ? room.capacityState : null,
        storageUsedCapacity: finiteNumberOrNull(room.storageUsedCapacity),
        storageFreeCapacity: finiteNumberOrNull(room.storageFreeCapacity),
        terminalUsedCapacity: finiteNumberOrNull(room.terminalUsedCapacity),
        terminalFreeCapacity: finiteNumberOrNull(room.terminalFreeCapacity),
        storageEnergy: finiteNumberOrNull(room.storageEnergy),
        terminalEnergy: finiteNumberOrNull(room.terminalEnergy),
        energyFloor: finiteNumberOrNull(room.energyFloor),
        energyTarget: finiteNumberOrNull(room.energyTarget),
        energyExportStart: finiteNumberOrNull(room.energyExportStart),
        terminalEnergyReserve: finiteNumberOrNull(room.terminalEnergyReserve),
        desiredTerminalFreeCapacity: finiteNumberOrNull(room.desiredTerminalFreeCapacity),
        terminalRecoveryGap: finiteNumberOrNull(room.terminalRecoveryGap),
        recoverableOffloadAmount: finiteNumberOrNull(room.recoverableOffloadAmount),
        stickyHeadroom: booleanOrNull(room.stickyHeadroom),
        stickyHeadroomReason: typeof room.stickyHeadroomReason === "string" ? room.stickyHeadroomReason : null,
        capacityReservation: summarizeCapacityReservation(room.capacityReservation),
        staging: summarizeStaging(room.staging),
        taskHealth: summarizeTaskHealth(room.taskHealth),
      };
    });

  const pendingTasks = Object.entries(tasks || {})
    .filter(([, task]) => task && typeof task === "object" && task.status === "pending")
    .sort(([leftId, leftTask], [rightId, rightTask]) => {
      const leftCreatedAt = finiteNumberOrNull(leftTask.createdAt) ?? Number.MAX_SAFE_INTEGER;
      const rightCreatedAt = finiteNumberOrNull(rightTask.createdAt) ?? Number.MAX_SAFE_INTEGER;
      if (leftCreatedAt !== rightCreatedAt) {
        return leftCreatedAt - rightCreatedAt;
      }
      const normalizedLeftId = typeof leftTask.id === "string" ? leftTask.id : leftId;
      const normalizedRightId = typeof rightTask.id === "string" ? rightTask.id : rightId;
      return normalizedLeftId.localeCompare(normalizedRightId);
    })
    .map(([taskId, task]) => ({
      id: typeof task.id === "string" ? task.id : taskId,
      resource: typeof task.resource === "string" ? task.resource : null,
      origin: typeof task.origin === "string" ? task.origin : null,
      reason: typeof task.reason === "string" ? task.reason : null,
      sourceRoom: typeof task.fromRoomName === "string" ? task.fromRoomName : null,
      destinationRoom: typeof task.toRoomName === "string" ? task.toRoomName : null,
      remainingAmount: finiteNumberOrNull(task.remainingAmount),
      age: tickAge(referenceTick, task.createdAt),
      blocker: typeof task.blockedReason === "string" ? task.blockedReason : null,
      blockerAge: tickAge(referenceTick, task.blockedSince),
      lastProgressAge: tickAge(referenceTick, task.lastProgressAt),
    }));

  return {
    available: runtime !== null || tasks !== null,
    updatedAt: referenceTick,
    roomCount: rooms.length,
    rooms,
    capacityPolicy: summarizeCapacityPolicy(runtime?.capacityPolicy),
    eligibleReceiverCount: finiteNumberOrNull(runtime?.eligibleReceiverCount),
    receiverExcludedByReason: summarizeCountMapOrNull(runtime?.receiverExcludedByReason),
    suppressedStagingCount: summarizeCountMapOrNull(runtime?.suppressedStagingCount),
    capacityIndexBuildCount: finiteNumberOrNull(runtime?.capacityIndexBuildCount),
    taskSummary: summarizeTaskSummary(runtime?.taskSummary),
    recentCapacityReliefRoutes: summarizeCapacityReliefRoutes(runtime?.recentCapacityReliefRoutes),
    pendingTaskCount: pendingTasks.length,
    pendingTasks,
  };
}

function summarizeMarketSaleAutomation(value) {
  const runtime =
    value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  if (!runtime) {
    return {
      available: false,
      updatedAt: null,
      requestedMode: null,
      phase: null,
      configRevision: null,
      shadowConfigRevision: null,
      shadowConsecutiveCycles: null,
      managedOrderCount: null,
      managedOrders: null,
      managedOrderSummaryTruncated: null,
      orderSlots: null,
      backoffSummary: null,
      pendingCreateCount: null,
      pendingMutationCount: null,
      exposureAmount: null,
      rollingFeeMilli: null,
      creditReserve: null,
      creditSummary: null,
      terminalClaims: null,
      rejectedByReason: null,
      candidates: null,
      canaryLock: null,
      recentActions: null,
      safetyViolationCount: null,
    };
  }

  const candidates =
    runtime.candidates && typeof runtime.candidates === "object" && !Array.isArray(runtime.candidates)
      ? Object.entries(runtime.candidates)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, candidate]) => {
            const row =
              candidate && typeof candidate === "object" && !Array.isArray(candidate)
                ? candidate
                : {};
            return {
              key,
              roomName: typeof row.roomName === "string" ? row.roomName : null,
              resource: typeof row.resource === "string" ? row.resource : null,
              revision: finiteNumberOrNull(row.revision),
              observedAt: finiteNumberOrNull(row.observedAt),
              expiresAt: finiteNumberOrNull(row.expiresAt),
              sellableAmount: finiteNumberOrNull(row.sellableAmount),
              protectedAmount: finiteNumberOrNull(row.protectedAmount),
              hardFloor: finiteNumberOrNull(row.hardFloor),
              historyTrusted:
                typeof row.historyTrusted === "boolean"
                  ? row.historyTrusted
                  : null,
              historyCompleteDayCount: finiteNumberOrNull(
                row.historyCompleteDayCount,
              ),
              historyAcceptedDayCount: finiteNumberOrNull(
                row.historyAcceptedDayCount,
              ),
              historyFloor: finiteNumberOrNull(row.historyFloor),
              ratchetFloor: finiteNumberOrNull(row.ratchetFloor),
              effectiveNetFloor: finiteNumberOrNull(row.effectiveNetFloor),
              makerPrice: finiteNumberOrNull(row.makerPrice),
              makerNetPrice: finiteNumberOrNull(row.makerNetPrice),
              bestDirectNetPrice: finiteNumberOrNull(row.bestDirectNetPrice),
              rejectedReason:
                typeof row.rejectedReason === "string" ? row.rejectedReason : null,
            };
          })
      : null;
  const managedOrders = Array.isArray(runtime.managedOrders)
    ? runtime.managedOrders
        .filter(
          (managed) =>
            managed &&
            typeof managed === "object" &&
            !Array.isArray(managed),
        )
        .sort((left, right) => {
          const leftId =
            typeof left.orderId === "string" ? left.orderId : "";
          const rightId =
            typeof right.orderId === "string" ? right.orderId : "";
          return leftId.localeCompare(rightId);
        })
        .slice(0, 20)
        .map((managed) => ({
          orderId:
            typeof managed.orderId === "string" ? managed.orderId : null,
          roomName:
            typeof managed.roomName === "string" ? managed.roomName : null,
          resourceType:
            typeof managed.resourceType === "string"
              ? managed.resourceType
              : null,
          remainingExposure: finiteNumberOrNull(
            managed.remainingExposure,
          ),
          liveRemainingAmount: finiteNumberOrNull(
            managed.liveRemainingAmount,
          ),
          policyCancelAtTick: finiteNumberOrNull(
            managed.policyCancelAtTick,
          ),
          backoffUntil: finiteNumberOrNull(managed.backoffUntil),
          pendingMutationKind:
            typeof managed.pendingMutationKind === "string"
              ? managed.pendingMutationKind
              : null,
        }))
    : null;
  const orderSlots =
    runtime.orderSlots &&
    typeof runtime.orderSlots === "object" &&
    !Array.isArray(runtime.orderSlots)
      ? {
          total: finiteNumberOrNull(runtime.orderSlots.total),
          current: finiteNumberOrNull(runtime.orderSlots.current),
          free: finiteNumberOrNull(runtime.orderSlots.free),
          reserved: finiteNumberOrNull(runtime.orderSlots.reserved),
          minFree: finiteNumberOrNull(runtime.orderSlots.minFree),
        }
      : null;
  const backoffSummary =
    runtime.backoffSummary &&
    typeof runtime.backoffSummary === "object" &&
    !Array.isArray(runtime.backoffSummary)
      ? {
          activeCount: finiteNumberOrNull(
            runtime.backoffSummary.activeCount,
          ),
          nextUntil: finiteNumberOrNull(runtime.backoffSummary.nextUntil),
        }
      : null;
  const creditSummary =
    runtime.creditSummary &&
    typeof runtime.creditSummary === "object" &&
    !Array.isArray(runtime.creditSummary)
      ? {
          credits: finiteNumberOrNull(runtime.creditSummary.credits),
          reserve: finiteNumberOrNull(runtime.creditSummary.reserve),
          reservedFeesThisTick: finiteNumberOrNull(
            runtime.creditSummary.reservedFeesThisTick,
          ),
          availableAfterReserve: finiteNumberOrNull(
            runtime.creditSummary.availableAfterReserve,
          ),
        }
      : null;
  const lock =
    runtime.canaryLock &&
    typeof runtime.canaryLock === "object" &&
    !Array.isArray(runtime.canaryLock)
      ? {
          roomName:
            typeof runtime.canaryLock.roomName === "string"
              ? runtime.canaryLock.roomName
              : null,
          resourceType:
            typeof runtime.canaryLock.resourceType === "string"
              ? runtime.canaryLock.resourceType
              : null,
          lockedAt: finiteNumberOrNull(runtime.canaryLock.lockedAt),
          configRevision:
            typeof runtime.canaryLock.configRevision === "string"
              ? runtime.canaryLock.configRevision
              : null,
        }
      : null;

  return {
    available: true,
    updatedAt: finiteNumberOrNull(runtime.updatedAt),
    requestedMode:
      typeof runtime.requestedMode === "string" ? runtime.requestedMode : null,
    phase: typeof runtime.phase === "string" ? runtime.phase : null,
    configRevision:
      typeof runtime.configRevision === "string" ? runtime.configRevision : null,
    shadowConfigRevision:
      typeof runtime.shadowConfigRevision === "string"
        ? runtime.shadowConfigRevision
        : null,
    shadowConsecutiveCycles: finiteNumberOrNull(runtime.shadowConsecutiveCycles),
    managedOrderCount: finiteNumberOrNull(runtime.managedOrderCount),
    managedOrders,
    managedOrderSummaryTruncated:
      typeof runtime.managedOrderSummaryTruncated === "boolean"
        ? runtime.managedOrderSummaryTruncated
        : null,
    orderSlots,
    backoffSummary,
    pendingCreateCount: finiteNumberOrNull(runtime.pendingCreateCount),
    pendingMutationCount: finiteNumberOrNull(runtime.pendingMutationCount),
    exposureAmount: finiteNumberOrNull(runtime.exposureAmount),
    rollingFeeMilli: finiteNumberOrNull(runtime.rollingFeeMilli),
    creditReserve: finiteNumberOrNull(runtime.creditReserve),
    creditSummary,
    terminalClaims: Array.isArray(runtime.terminalClaims)
      ? runtime.terminalClaims.filter((claim) => typeof claim === "string")
      : null,
    rejectedByReason: summarizeCountMapOrNull(runtime.rejectedByReason),
    candidates,
    canaryLock: lock,
    recentActions: Array.isArray(runtime.recentActions)
      ? runtime.recentActions.filter((action) => typeof action === "string").slice(-20)
      : null,
    safetyViolationCount: finiteNumberOrNull(runtime.safetyViolationCount),
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

function extractAnalyticsData(parsed) {
  let production = null;
  let moduleCpu = null;
  let cpuMonitor = null;
  let hub = null;

  if (!parsed || typeof parsed !== "object") {
    return { production, moduleCpu, cpuMonitor, hub };
  }

  if ("analytics" in parsed && parsed.analytics) {
    const analytics = parsed.analytics;
    if (typeof analytics === "object" && analytics) {
      if ("production" in analytics) production = analytics.production;
      if ("moduleCpu" in analytics) moduleCpu = analytics.moduleCpu;
      if ("cpuMonitor" in analytics) cpuMonitor = analytics.cpuMonitor;
      if ("hub" in analytics) hub = analytics.hub;
    }
  }
  if (!production && "production" in parsed && parsed.production) {
    production = parsed.production;
    if (!moduleCpu && "moduleCpu" in parsed) moduleCpu = parsed.moduleCpu;
    if (!cpuMonitor && "cpuMonitor" in parsed) cpuMonitor = parsed.cpuMonitor;
  }
  if (!production && "rooms" in parsed) {
    production = parsed;
    if (!moduleCpu && "moduleCpu" in parsed) moduleCpu = parsed.moduleCpu;
    if (!cpuMonitor && "cpuMonitor" in parsed) cpuMonitor = parsed.cpuMonitor;
  }
  // Top-level hub or cpuMonitor overrides
  if ("hub" in parsed && parsed.hub) hub = parsed.hub;
  if ("cpuMonitor" in parsed && parsed.cpuMonitor && !cpuMonitor) cpuMonitor = parsed.cpuMonitor;

  return { production, moduleCpu, cpuMonitor, hub };
}

function extractFixtureResourceControlData(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return {
      runtimeResourceControl: null,
      transferTaskStore: null,
      runtimeMarketSaleAutomation: null,
    };
  }

  const runtime = parsed.runtime && typeof parsed.runtime === "object" ? parsed.runtime : null;
  const data = parsed.data && typeof parsed.data === "object" ? parsed.data : null;
  const dataResourceControl =
    data && data.resourceControl && typeof data.resourceControl === "object" ? data.resourceControl : null;

  return {
    runtimeResourceControl:
      runtime && runtime.resourceControl && typeof runtime.resourceControl === "object"
        ? runtime.resourceControl
        : null,
    transferTaskStore:
      dataResourceControl && dataResourceControl.tasks && typeof dataResourceControl.tasks === "object"
        ? dataResourceControl.tasks
        : null,
    runtimeMarketSaleAutomation:
      runtime &&
      runtime.marketSaleAutomation &&
      typeof runtime.marketSaleAutomation === "object"
        ? runtime.marketSaleAutomation
        : null,
  };
}

async function fetchOptionalMemoryPath(config, shard, path) {
  try {
    const { payload } = await fetchApiJson(config, "/api/user/memory", { shard, path });
    return parseMemoryBody(payload);
  } catch {
    return null;
  }
}

async function fetchResourceControlData(config, shard) {
  const [runtimeResourceControl, transferTaskStore, runtimeMarketSaleAutomation] =
    await Promise.all([
    fetchOptionalMemoryPath(config, shard, "runtime.resourceControl"),
    fetchOptionalMemoryPath(config, shard, "data.resourceControl.tasks"),
    fetchOptionalMemoryPath(config, shard, "runtime.marketSaleAutomation"),
  ]);
  return {
    runtimeResourceControl,
    transferTaskStore,
    runtimeMarketSaleAutomation,
  };
}

async function fetchMemorySnapshot(config, options = {}) {
  // Fixture mode: read from file instead of API
  if (config.memoryFixture) {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(config.memoryFixture, "utf-8");
    const parsed = JSON.parse(raw);
    const rateLimit = { limit: "?", remaining: "?", reset: "?" };
    const { production, moduleCpu, cpuMonitor, hub } = extractAnalyticsData(parsed);
    const {
      runtimeResourceControl,
      transferTaskStore,
      runtimeMarketSaleAutomation,
    } = extractFixtureResourceControlData(parsed);

    return {
      source: "memory",
      fetchedAt: new Date().toISOString(),
      rateLimit,
      summary: summarizeProduction(production),
      cpuMonitor: summarizeCpuMonitor(cpuMonitor, moduleCpu),
      moduleCpu: summarizeModuleCpu(moduleCpu),
      hub: summarizeHub(hub),
      resourceControl: summarizeResourceControl(runtimeResourceControl, transferTaskStore),
      marketSaleAutomation: summarizeMarketSaleAutomation(runtimeMarketSaleAutomation),
    };
  }

  const { payload, rateLimit } = await fetchApiJson(config, "/api/user/memory", {
    shard: config.shard,
    path: "analytics",
  });
  const memoryOrProduction = parseMemoryBody(payload);
  const { production, moduleCpu, cpuMonitor, hub } = extractAnalyticsData(memoryOrProduction);
  const summary = summarizeProduction(production);
  const {
    runtimeResourceControl,
    transferTaskStore,
    runtimeMarketSaleAutomation,
  } = options.includeResourceControl === false
    ? {
        runtimeResourceControl: null,
        transferTaskStore: null,
        runtimeMarketSaleAutomation: null,
      }
    : await fetchResourceControlData(config, config.shard);

  return {
    source: "memory",
    fetchedAt: new Date().toISOString(),
    rateLimit,
    summary,
    cpuMonitor: summarizeCpuMonitor(cpuMonitor, moduleCpu),
    moduleCpu: summarizeModuleCpu(moduleCpu),
    hub: summarizeHub(hub),
    resourceControl: summarizeResourceControl(runtimeResourceControl, transferTaskStore),
    marketSaleAutomation: summarizeMarketSaleAutomation(runtimeMarketSaleAutomation),
  };
}

function extractDeployTime(lastDeployTag) {
  if (typeof lastDeployTag !== "string") {
    return -1;
  }

  const markerIndex = lastDeployTag.lastIndexOf("@");
  if (markerIndex < 0) {
    return -1;
  }

  const parsed = Date.parse(lastDeployTag.slice(markerIndex + 1));
  return Number.isFinite(parsed) ? parsed : -1;
}

async function fetchRuntimeInfo(config, shard) {
  try {
    const { payload } = await fetchApiJson(config, "/api/user/memory", {
      shard,
      path: "runtime",
    });
    const runtime = parseMemoryBody(payload);
    const lastDeployTag = runtime && typeof runtime === "object" ? runtime.lastDeployTag ?? null : null;
    return {
      lastDeployTag,
      deployTime: extractDeployTime(lastDeployTag),
    };
  } catch {
    return {
      lastDeployTag: null,
      deployTime: -1,
    };
  }
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
  const cpuMonitor = memory && memory.cpuMonitor ? memory.cpuMonitor : null;
  const moduleCpu = memory && memory.moduleCpu ? memory.moduleCpu : null;
  const segmentParsed =
    segment && segment.snapshot && segment.snapshot.parsed && typeof segment.snapshot.parsed === "object"
      ? segment.snapshot.parsed
      : null;

  // Prefer v2 cpuMonitor from segment, fall back to legacy moduleCpu
  const segmentCpuMonitor =
    segmentParsed && segmentParsed.cpuMonitor && typeof segmentParsed.cpuMonitor === "object"
      ? summarizeCpuMonitor(segmentParsed.cpuMonitor, segmentParsed.moduleCpu)
      : (segmentParsed && segmentParsed.moduleCpu
        ? summarizeCpuMonitor(null, segmentParsed.moduleCpu)
        : null);

  const latestCpu = cpuMonitor && cpuMonitor.available ? cpuMonitor :
    (segmentCpuMonitor && segmentCpuMonitor.available ? segmentCpuMonitor : null);
  const latestCpuLatest = latestCpu && latestCpu.latest ? latestCpu.latest : null;

  const segmentTruncated = !!(segmentParsed && segmentParsed.truncated);
  const segmentSchemaVersion = segmentParsed && typeof segmentParsed.version === "number" ? segmentParsed.version : null;

  return {
    startedAt: state.startedAt,
    roomCount: memory ? memory.summary.roomCount : 0,
    latestTick: memory ? memory.summary.latestTick : null,
    totals: memory ? memory.summary.totals : null,
    hub: memory?.hub ?? null,
    resourceControl: memory?.resourceControl ?? null,
    marketSaleAutomation: memory?.marketSaleAutomation ?? null,
    cpuMonitorAvailable: latestCpu ? latestCpu.available : false,
    cpuMonitorVersion: latestCpu ? latestCpu.version : null,
    cpuMonitorSource: latestCpu ? latestCpu.source : null,
    cpuMonitorTick: latestCpuLatest ? latestCpuLatest.tick : null,
    cpuMonitorTotalUsed: latestCpuLatest ? latestCpuLatest.totalUsed : null,
    cpuMonitorEmaTotalUsed: latestCpuLatest ? latestCpuLatest.emaTotalUsed : null,
    cpuMonitorTopPhases: latestCpuLatest ? latestCpuLatest.topPhases : [],
    cpuMonitorTopRooms: latestCpuLatest ? (latestCpuLatest.topRooms || []) : [],
    cpuMonitorTopRoomRoles: latestCpuLatest ? (latestCpuLatest.topRoomRoles || []) : [],
    cpuMonitorHeap: latestCpuLatest ? (latestCpuLatest.heap || null) : null,
    cpuMonitorFixedActionEstimate: latestCpuLatest ? (latestCpuLatest.fixedActionEstimate || 0) : 0,
    cpuMonitorSummary: latestCpu && latestCpu.summary ? latestCpu.summary : null,
    moduleCpuAvailable: moduleCpu ? moduleCpu.available : false,
    moduleCpuTick: moduleCpu && moduleCpu.latest ? moduleCpu.latest.tick : null,
    moduleCpuTotalUsed: moduleCpu && moduleCpu.latest ? moduleCpu.latest.totalUsed : null,
    moduleCpuTopPhases: moduleCpu && moduleCpu.latest ? moduleCpu.latest.topPhases : [],
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
      const segmentCpuMonitor = segmentParsed && segmentParsed.cpuMonitor
        ? summarizeCpuMonitor(segmentParsed.cpuMonitor, segmentParsed.moduleCpu)
        : (segmentParsed && segmentParsed.moduleCpu
          ? summarizeCpuMonitor(null, segmentParsed.moduleCpu)
          : null);
      const segmentHistory = segmentParsed && segmentParsed.cpuMonitor && Array.isArray(segmentParsed.cpuMonitor.history)
        ? segmentParsed.cpuMonitor.history
        : [];
      writeJson(res, 200, {
        memoryCpuMonitor: state.latest.memory ? state.latest.memory.cpuMonitor : null,
        segmentCpuMonitor,
        segmentCpuMonitorHistory: segmentHistory,
        memoryModuleCpu: state.latest.memory ? state.latest.memory.moduleCpu : null,
        segmentModuleCpu: segmentParsed && segmentParsed.moduleCpu ? segmentParsed.moduleCpu : null,
        segmentTick: segmentParsed && typeof segmentParsed.tick === "number" ? segmentParsed.tick : null,
        segmentTruncated: !!(segmentParsed && segmentParsed.truncated),
        segmentSchemaVersion: segmentParsed && typeof segmentParsed.version === "number" ? segmentParsed.version : null,
      });
      return;
    }
    if (url.pathname === "/hub") {
      const hub = state.latest.memory?.hub ?? null;
      writeJson(res, 200, { ok: true, hub, selectedShard: state.selectedShard ?? null });
      return;
    }
    if (url.pathname === "/resource-control") {
      const resourceControl = state.latest.memory?.resourceControl ?? null;
      writeJson(res, 200, { ok: true, resourceControl, selectedShard: state.selectedShard ?? null });
      return;
    }
    if (url.pathname === "/market-sale") {
      const marketSaleAutomation = state.latest.memory?.marketSaleAutomation ?? null;
      writeJson(res, 200, {
        ok: true,
        marketSaleAutomation,
        selectedShard: state.selectedShard ?? null,
      });
      return;
    }

    writeJson(res, 200, {
      summary: summarizeState(state),
      endpoints: [
        "/health",
        "/state",
        "/rooms",
        "/history",
        "/cpu",
        "/hub",
        "/resource-control",
        "/market-sale",
      ],
    });
  });
}

function logMemorySnapshot(snapshot) {
  const summary = snapshot.summary;
  const cpuMon = snapshot.cpuMonitor && snapshot.cpuMonitor.available ? snapshot.cpuMonitor : null;
  const cpuLatest = cpuMon && cpuMon.latest ? cpuMon.latest : null;
  const cpuSource = cpuMon ? cpuMon.source : "none";
  const cpuVersion = cpuMon ? cpuMon.version : "n/a";

  // Prefer v2 fields
  const topPhase = cpuLatest && cpuLatest.topPhases && cpuLatest.topPhases.length > 0
    ? `${cpuLatest.topPhases[0].phase}:${cpuLatest.topPhases[0].used.toFixed(2)}`
    : "n/a";
  const emaStr = cpuLatest && typeof cpuLatest.emaTotalUsed === "number"
    ? ` ema=${cpuLatest.emaTotalUsed.toFixed(2)}`
    : "";
  const fixedStr = cpuLatest && typeof cpuLatest.fixedActionEstimate === "number" && cpuLatest.fixedActionEstimate > 0
    ? ` fixedAct=${cpuLatest.fixedActionEstimate.toFixed(2)}`
    : "";
  const heapStr = cpuLatest && cpuLatest.heap
    ? ` heap=${(cpuLatest.heap.used_heap_size / 1048576).toFixed(1)}MB`
    : "";
  const cpuTick = cpuLatest ? cpuLatest.tick : "n/a";
  const cpuUsed = cpuLatest ? cpuLatest.totalUsed : "n/a";

  // Fallback to legacy moduleCpu when v2 absent
  if (!cpuMon && snapshot.moduleCpu && snapshot.moduleCpu.available && snapshot.moduleCpu.latest) {
    const legacy = snapshot.moduleCpu.latest;
    const legacyTop = legacy.topPhases && legacy.topPhases.length > 0
      ? `${legacy.topPhases[0].phase}:${legacy.topPhases[0].used.toFixed(2)}`
      : "n/a";
    console.log(
      `[monitor][memory] tick=${summary.latestTick ?? "n/a"} rooms=${summary.roomCount} workers=${summary.totals.workers} carriers=${summary.totals.carriers} loose=${summary.totals.looseEnergy} [legacy] moduleCpuTick=${legacy.tick ?? "n/a"} moduleCpuUsed=${legacy.totalUsed ?? "n/a"} topPhase=${legacyTop}${hubStr(snapshot.hub)}${resourceControlStr(snapshot.resourceControl)}${marketSaleStr(snapshot.marketSaleAutomation)} remaining=${snapshot.rateLimit.remaining ?? "?"}`,
    );
    return;
  }

  console.log(
    `[monitor][memory] tick=${summary.latestTick ?? "n/a"} rooms=${summary.roomCount} workers=${summary.totals.workers} carriers=${summary.totals.carriers} loose=${summary.totals.looseEnergy} [cpu-v${cpuVersion}|${cpuSource}] cpuTick=${cpuTick} cpuUsed=${cpuUsed}${emaStr}${fixedStr}${heapStr} topPhase=${topPhase}${hubStr(snapshot.hub)}${resourceControlStr(snapshot.resourceControl)}${marketSaleStr(snapshot.marketSaleAutomation)} remaining=${snapshot.rateLimit.remaining ?? "?"}`,
  );
}

function hubStr(hub) {
  if (!hub || !hub.available) return "";
  return ` hub=${hub.hubRoomName} status=${hub.status ?? "n/a"} stage=${hub.stage ?? "n/a"} product=${hub.activeProduct ?? "n/a"} imports=${hub.pendingImports} exports=${hub.pendingExports}`;
}

function resourceControlStr(resourceControl) {
  if (!resourceControl || !resourceControl.available) return "";
  return ` transferTasks=${resourceControl.pendingTaskCount}`;
}

function marketSaleStr(marketSaleAutomation) {
  if (!marketSaleAutomation || !marketSaleAutomation.available) return "";
  return ` marketSale=${marketSaleAutomation.phase ?? "n/a"} shadow=${marketSaleAutomation.shadowConsecutiveCycles ?? "n/a"} orders=${marketSaleAutomation.managedOrderCount ?? "n/a"}`;
}

function logSegmentSnapshot(snapshot) {
  const parsed = snapshot.snapshot.parsed;
  const tick = parsed && typeof parsed === "object" && typeof parsed.tick === "number" ? parsed.tick : "n/a";
  const version = parsed && typeof parsed === "object" && typeof parsed.version === "number" ? parsed.version : "n/a";
  const truncated = !!(parsed && typeof parsed === "object" && parsed.truncated);

  // Prefer v2 cpuMonitor from segment
  const cpuMon = parsed && typeof parsed === "object" && parsed.cpuMonitor
    ? summarizeCpuMonitor(parsed.cpuMonitor, parsed.moduleCpu)
    : (parsed && typeof parsed === "object" && parsed.moduleCpu
      ? summarizeCpuMonitor(null, parsed.moduleCpu)
      : null);
  const cpuSource = cpuMon ? cpuMon.source : "none";
  const phaseCount = cpuMon && cpuMon.latest && cpuMon.latest.phases ? Object.keys(cpuMon.latest.phases).length : 0;

  console.log(
    `[monitor][segment] id=${snapshot.snapshot.segmentId} tick=${tick} ver=${version} truncated=${truncated} cpuSource=${cpuSource} phaseCount=${phaseCount} size=${snapshot.snapshot.rawSize} remaining=${snapshot.rateLimit.remaining ?? "?"}`,
  );
}

async function fetchWithShardFallback(config) {
  const candidates = [undefined, ...config.shardCandidates];
  let bestResult = null;
  let bestShard = null;
  let bestShardValue;
  let bestHubTime = -1;
  let bestDeployTime = -1;
  let bestTick = -1;
  const shardResults = [];

  for (const shard of candidates) {
    try {
      const result = await fetchMemorySnapshot(
        { ...config, shard, memoryFixture: config.memoryFixture },
        { includeResourceControl: false },
      );
      const runtimeInfo = await fetchRuntimeInfo(config, shard);
      const hubTime = result.memory?.hub?.updatedAt ?? result.hub?.updatedAt ?? -1;
      const tick = result.memory?.summary?.latestTick ?? result.summary?.latestTick ?? -1;
      shardResults.push({
        shard: shard ?? "(default)",
        ok: true,
        hubTime,
        deployTime: runtimeInfo.deployTime,
        lastDeployTag: runtimeInfo.lastDeployTag,
        tick,
      });
      if (
        hubTime > bestHubTime ||
        (hubTime === bestHubTime && runtimeInfo.deployTime > bestDeployTime) ||
        (hubTime === bestHubTime && runtimeInfo.deployTime === bestDeployTime && tick > bestTick)
      ) {
        bestResult = result;
        bestShard = shard ?? "(default)";
        bestShardValue = shard;
        bestHubTime = hubTime;
        bestDeployTime = runtimeInfo.deployTime;
        bestTick = tick;
      }
    } catch (e) {
      shardResults.push({ shard: shard ?? "(default)", ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (bestResult) {
    const {
      runtimeResourceControl,
      transferTaskStore,
      runtimeMarketSaleAutomation,
    } = await fetchResourceControlData(config, bestShardValue);
    bestResult.resourceControl = summarizeResourceControl(runtimeResourceControl, transferTaskStore);
    bestResult.marketSaleAutomation = summarizeMarketSaleAutomation(
      runtimeMarketSaleAutomation,
    );
    bestResult.selectedShard = bestShard;
    bestResult.shardCandidates = shardResults;
  }
  return bestResult;
}

async function fetchSelectedMemorySnapshot(config) {
  return config.explicitShard || config.memoryFixture
    ? fetchMemorySnapshot(config)
    : fetchWithShardFallback(config);
}

async function runOnce(config) {
  const memory = await fetchSelectedMemorySnapshot(config);
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
      const snapshot = await fetchSelectedMemorySnapshot(config);
      if (!snapshot) {
        throw new Error("No shard candidate returned a memory snapshot");
      }
      state.latest.memory = snapshot;
      state.selectedShard = snapshot.selectedShard ?? config.shard ?? null;
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
    `[monitor] base=${config.baseUrl} shard=${config.shard ?? "auto"} memoryInterval=${config.memoryIntervalMs}ms segment=${config.segmentId ?? "off"} output=${config.outputPath ?? "off"} memoryFixture=${config.memoryFixture ?? "off"}`,
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
