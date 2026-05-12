import { Panel } from "@/visual/panel";
import type { VisualSurface } from "@/visual/panel";

type VisualCall = { roomName: string; method: string; args: any[] };

function getCalls(): VisualCall[] {
  return (global as any).__roomVisualCalls;
}

function resetCalls(): void {
  (global as any).__resetRoomVisualCalls();
}

function findCalls(
  method: string,
  predicate?: (args: any[]) => boolean,
): VisualCall[] {
  return getCalls().filter(
    (c) => c.method === method && (!predicate || predicate(c.args)),
  );
}

describe("Panel", () => {
  beforeEach(() => resetCalls());

  function makePanel(opts?: { x?: number; y?: number; width?: number }): Panel {
    return new Panel({
      rv: new RoomVisual("W1N1"),
      x: opts?.x ?? 1,
      y: opts?.y ?? 2,
      width: opts?.width ?? 13.5,
    });
  }

  it("sectionHeader emits 1 rect + 1 text and advances cursorY by header stride", () => {
    const panel = makePanel();
    panel.sectionHeader("Title");

    const rects = findCalls("rect");
    const texts = findCalls("text");
    expect(rects).toHaveLength(1);
    expect(texts).toHaveLength(1);

    const headerStride = 0.7;
    expect(panel.cursorY).toBeCloseTo(2 + headerStride, 4);

    // text y (baseline) must be within rect bounds
    const rectY = rects[0].args[1]; // rect top-left y
    const rectH = rects[0].args[3]; // rect height
    const textY = texts[0].args[2]; // text baseline y (text args: [text, x, y, style])
    expect(textY).toBeGreaterThanOrEqual(rectY);
    expect(textY).toBeLessThanOrEqual(rectY + rectH);
  });

  it("textRow emits 1 text and advances cursorY by rowHeight", () => {
    const panel = makePanel();
    panel.textRow("hello");

    const texts = findCalls("text");
    expect(texts).toHaveLength(1);
    expect(texts[0].args[0]).toBe("hello");

    const rowHeight = 0.7;
    expect(panel.cursorY).toBeCloseTo(2 + rowHeight, 4);
  });

  it("progressBar at 50% emits outline rect + fill rect + centered text", () => {
    const panel = makePanel();
    panel.progressBar(0.5, "#00ff88", "500/1000");

    const rects = findCalls("rect");

    // outline rect (transparent fill or no fill)
    const outlines = rects.filter(
      (c) => c.args[4]?.fill === "transparent" || c.args[4]?.fill === undefined,
    );
    expect(outlines.length).toBeGreaterThanOrEqual(1);

    // fill rect
    const fills = rects.filter((c) => c.args[4]?.fill === "#00ff88");
    expect(fills).toHaveLength(1);

    // text label
    const labelTexts = findCalls("text", (args) => args[0] === "500/1000");
    expect(labelTexts).toHaveLength(1);

    // cursorY advanced by barHeight + barPad
    const barAdvance = 0.45 + 0.15; // 0.6
    expect(panel.cursorY).toBeCloseTo(2 + barAdvance, 4);
  });

  it("progressBar at 0% emits NO fill rect (only outline + text)", () => {
    const panel = makePanel();
    panel.progressBar(0, "#00ff88", "0/1000");

    const rects = findCalls("rect");

    // NO colored fill rect
    const coloredFills = rects.filter((c) => c.args[4]?.fill === "#00ff88");
    expect(coloredFills).toHaveLength(0);

    // outline rect still present
    const outlines = rects.filter(
      (c) => c.args[4]?.fill === "transparent" || c.args[4]?.fill === undefined,
    );
    expect(outlines.length).toBeGreaterThanOrEqual(1);

    // text label
    const labelTexts = findCalls("text", (args) => args[0] === "0/1000");
    expect(labelTexts).toHaveLength(1);

    // cursorY still advanced by barHeight + barPad
    const barAdvance = 0.6;
    expect(panel.cursorY).toBeCloseTo(2 + barAdvance, 4);
  });

  it("spacer emits no visual calls and advances cursorY", () => {
    const panel = makePanel();
    panel.spacer(0.5);

    expect(getCalls()).toHaveLength(0);
    expect(panel.cursorY).toBeCloseTo(2 + 0.5, 4);
  });

  it("callsUsed tracks cumulative visual call count", () => {
    const panel = makePanel();

    panel.sectionHeader("A"); // 2 calls (rect + text)
    expect(panel.callsUsed).toBe(2);

    panel.textRow("b"); // 1 call (text)
    expect(panel.callsUsed).toBe(3);
  });

  it("cursorY equals initial y from constructor", () => {
    const panel = makePanel();
    expect(panel.cursorY).toBe(2);
  });
});
