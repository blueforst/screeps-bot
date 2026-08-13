import {
  VIS_TEXT,
  VIS_HEADER_FILL,
  VIS_PANEL_FILL,
  VIS_PANEL_STROKE,
  VIS_MUTED,
  VIS_OK,
  VIS_WARN,
  VIS_ERROR,
} from "@/visual/palette";

describe("palette constants", () => {
  const all = { VIS_TEXT, VIS_HEADER_FILL, VIS_PANEL_FILL, VIS_PANEL_STROKE, VIS_MUTED, VIS_OK, VIS_WARN, VIS_ERROR };

  it("all palette constants are non-empty strings", () => {
    const entries = Object.entries(all) as [string, string][];
    for (const [name, value] of entries) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("VIS_PANEL_STROKE is #c9c9c9", () => {
    expect(VIS_PANEL_STROKE).toBe("#c9c9c9");
  });

  it("VIS_PANEL_FILL is a defined non-empty string", () => {
    expect(VIS_PANEL_FILL).toBeDefined();
    expect(typeof VIS_PANEL_FILL).toBe("string");
    expect(VIS_PANEL_FILL.length).toBeGreaterThan(0);
  });
});
