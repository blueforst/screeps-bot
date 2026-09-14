import type { CompatConfig } from "./treasuryCompatTypes";
/** Hot-path Optimization XI Online I: four fixed points with IX attribution. Budget unchanged. */
export const TREASURY_COMPAT_CONFIG: CompatConfig = Object.freeze({
  enabled: true,
  shardName: "shard1",
  rooms: Object.freeze(["E3N59", "E4N58"]),
  resources: Object.freeze(["energy", "H"]),
  startTick: 73700400,
  endTick: 73700700,
  intervalTicks: 100,
  minBucket: 2000,
  maxSampleCpu: 2,
  reserveCpu: 5,
  maxLogBytes: 16384,
});
