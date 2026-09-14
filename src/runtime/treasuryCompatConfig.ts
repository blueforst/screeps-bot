import type { CompatConfig } from "./treasuryCompatTypes";
/** Subphase Online X: four fixed points with bounded IX attribution. Budget unchanged. */
export const TREASURY_COMPAT_CONFIG: CompatConfig = Object.freeze({
  enabled: true,
  shardName: "shard1",
  rooms: Object.freeze(["E3N59", "E4N58"]),
  resources: Object.freeze(["energy", "H"]),
  startTick: 73691600,
  endTick: 73691900,
  intervalTicks: 100,
  minBucket: 2000,
  maxSampleCpu: 2,
  reserveCpu: 5,
  maxLogBytes: 16384,
});
