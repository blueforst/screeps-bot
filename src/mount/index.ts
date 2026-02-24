import { mountCreep } from "@/mount/mountCreep";
import { mountSpawn } from "@/mount/mountSpawn";

export function mountAll(): void {
  if (globalThis.__screepsMounted) {
    return;
  }

  if (typeof Creep === "undefined" || typeof StructureSpawn === "undefined") {
    return;
  }

  mountCreep();
  mountSpawn();

  globalThis.__screepsMounted = true;
}
