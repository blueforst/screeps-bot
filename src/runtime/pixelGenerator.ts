const PIXEL_BUCKET_THRESHOLD = 10000;

export function runPixelGenerator(): void {
  if (Memory.cfg?.pixelGenerator?.enabled === false) {
    return;
  }

  if (Game.cpu.bucket < PIXEL_BUCKET_THRESHOLD) {
    return;
  }

  Game.cpu.generatePixel();
}
