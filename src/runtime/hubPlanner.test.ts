import {
  getDefaultHubConfig,
  getDefaultHubRuntime,
  planHubChains,
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

describe("planHubChains", () => {
  it("returns 19 steps in correct order for empty hub inventory", () => {
    const result = planHubChains({}, {}, 1000);
    expect(result.steps).toHaveLength(19);

    const products = result.steps.map((s) => s.product);
    expect(products).toEqual([
      RESOURCE_HYDROXIDE,
      RESOURCE_ZYNTHIUM_KEANITE,
      RESOURCE_UTRIUM_LEMERGITE,
      RESOURCE_GHODIUM,
      RESOURCE_UTRIUM_HYDRIDE,
      RESOURCE_UTRIUM_OXIDE,
      RESOURCE_LEMERGIUM_OXIDE,
      RESOURCE_GHODIUM_HYDRIDE,
      RESOURCE_GHODIUM_OXIDE,
      RESOURCE_UTRIUM_ACID,
      RESOURCE_UTRIUM_ALKALIDE,
      RESOURCE_LEMERGIUM_ALKALIDE,
      RESOURCE_GHODIUM_ALKALIDE,
      RESOURCE_GHODIUM_ACID,
      RESOURCE_CATALYZED_UTRIUM_ACID,
      RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
      RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
      RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
      RESOURCE_CATALYZED_GHODIUM_ACID,
    ]);

    const amounts = result.steps.map((s) => s.targetAmount);
    expect(amounts).toEqual([
      5000, 2000, 2000, 2000,
      1000, 1000, 1000, 1000, 1000,
      1000, 1000, 1000, 1000, 1000,
      1000, 1000, 1000, 1000, 1000,
    ]);
  });

  it("accounts for shared intermediates without duplication", () => {
    const result = planHubChains({}, {}, 1000);
    const byProduct = new Map(result.steps.map((s) => [s.product, s]));

    expect(byProduct.get(RESOURCE_HYDROXIDE)!.targetAmount).toBe(5000);
    expect(byProduct.get(RESOURCE_GHODIUM)!.targetAmount).toBe(2000);
    expect(byProduct.get(RESOURCE_ZYNTHIUM_KEANITE)!.targetAmount).toBe(2000);
    expect(byProduct.get(RESOURCE_UTRIUM_LEMERGITE)!.targetAmount).toBe(2000);
  });

  it("reduces production by reclaimed surplus from inventory and incoming", () => {
    const hubInventory: Record<string, number> = {
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 600,
    };
    const incomingResources: Record<string, number> = {
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 500,
    };

    const result = planHubChains(hubInventory, incomingResources, 1000);

    const byProduct = new Map(result.steps.map((s) => [s.product, s]));
    expect(byProduct.has(RESOURCE_CATALYZED_UTRIUM_ACID)).toBe(false);
    expect(byProduct.has(RESOURCE_UTRIUM_ACID)).toBe(false);
    expect(byProduct.has(RESOURCE_UTRIUM_HYDRIDE)).toBe(false);

    expect(byProduct.get(RESOURCE_HYDROXIDE)!.targetAmount).toBe(4000);
  });

  it("reports blocked with missing base minerals when insufficient", () => {
    const partialInventory: Record<string, number> = {
      [RESOURCE_HYDROGEN]: 10000,
      [RESOURCE_OXYGEN]: 10000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
    };

    const result = planHubChains(partialInventory, {}, 1000);
    expect(result.blocked).toBe(true);
    expect(result.missingResources).toContain(RESOURCE_KEANIUM);
    expect(result.missingResources).toContain(RESOURCE_ZYNTHIUM);
    expect(result.missingResources).not.toContain(RESOURCE_HYDROGEN);
    expect(result.missingResources).not.toContain(RESOURCE_OXYGEN);
    expect(result.missingResources).not.toContain(RESOURCE_UTRIUM);
    expect(result.missingResources).not.toContain(RESOURCE_LEMERGIUM);
    expect(result.missingResources).not.toContain(RESOURCE_CATALYST);
  });
});
