import {
  PIXEL_GENERATOR_PERMANENTLY_DISABLED,
  runPixelGenerator,
} from "@/runtime/pixelGenerator";

describe("pixel generator permanent latch", () => {
  it("never generates a Pixel even when config and bucket would have enabled it", () => {
    Memory.cfg = {
      pixelGenerator: {
        enabled: true,
      },
    };
    Game.cpu = {
      bucket: 10_000,
      generatePixel: jest.fn(() => OK),
    } as unknown as CPU;

    runPixelGenerator();

    expect(PIXEL_GENERATOR_PERMANENTLY_DISABLED).toBe(true);
    expect(Game.cpu.generatePixel).not.toHaveBeenCalled();
  });
});
