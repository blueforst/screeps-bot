/**
 * 市场自动化生产保护合同要求 Pixel 永久关闭。
 *
 * 保留 runPixelGenerator phase 和导出，避免主循环顺序或旧调用方漂移；无论
 * Memory 配置和 CPU bucket 如何，本模块都不会调用 generatePixel。
 */
export const PIXEL_GENERATOR_PERMANENTLY_DISABLED = true;
export function runPixelGenerator(): void {
  return;
}
