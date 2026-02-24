const PIXEL_BUCKET_THRESHOLD = 10000;

export function runPixelGenerator(): void {
  if (Memory.pixelGenerator?.enabled === false) {
    return;
  }

  if (Game.cpu.bucket < PIXEL_BUCKET_THRESHOLD) {
    return;
  }

  const result = Game.cpu.generatePixel();
  if (result === OK) {
    console.log(`[pixel] generated at tick ${Game.time}`);
  }
}
