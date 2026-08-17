import { Panel } from "@/visual/panel";
import { VIS_PANEL_FILL } from "@/visual/palette";

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

  it("background emits one bounded panel rect without moving the cursor", () => {
    const panel = makePanel();
    panel.background(4.2);

    const backgrounds = findCalls("rect", args => args[4]?.fill === VIS_PANEL_FILL);
    expect(backgrounds).toHaveLength(1);
    expect(backgrounds[0].args[1]).toBeLessThan(2);
    expect(backgrounds[0].args[3]).toBeGreaterThan(4.2);
    expect(panel.cursorY).toBe(2);
    expect(panel.callsUsed).toBe(1);
  });
});
