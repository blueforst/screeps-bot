import {
  getDefaultHubConfig,
  getDefaultHubRuntime,
} from "@/runtime/hubPlanner";

describe("hubPlanner defaults", () => {
  describe("getDefaultHubConfig", () => {
    it("resolves five war-core T3 target compounds", () => {
      const config = getDefaultHubConfig();
      expect(config.targetCompounds).toEqual([
        RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
        RESOURCE_CATALYZED_GHODIUM_ACID,
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
        RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
      ]);
    });

    it("sets reservePerRoom to 1000", () => {
      const config = getDefaultHubConfig();
      expect(config.reservePerRoom).toBe(1000);
    });

    it("is disabled by default", () => {
      const config = getDefaultHubConfig();
      expect(config.enabled).toBe(false);
    });

    it("has empty hubRoomName by default", () => {
      const config = getDefaultHubConfig();
      expect(config.hubRoomName).toBe("");
    });

    it("sets internalOnly to true", () => {
      const config = getDefaultHubConfig();
      expect(config.internalOnly).toBe(true);
    });
  });

  describe("getDefaultHubRuntime", () => {
    it("starts in idle status", () => {
      const runtime = getDefaultHubRuntime();
      expect(runtime.status).toBe("idle");
    });

    it("has empty lastPlanActions", () => {
      const runtime = getDefaultHubRuntime();
      expect(runtime.lastPlanActions).toEqual([]);
    });

    it("does not need a plan initially", () => {
      const runtime = getDefaultHubRuntime();
      expect(runtime.needsPlan).toBe(false);
    });
  });
});
