import { mountCreep } from "@/mount/mountCreep";
import { mountSpawn } from "@/mount/mountSpawn";

const runtimeGlobal = global;

export function mountAll(): void {
  if (runtimeGlobal.__screepsMounted) {
    return;
  }

  if (typeof Creep === "undefined" || typeof StructureSpawn === "undefined") {
    return;
  }

  mountCreep();
  mountSpawn();

  runtimeGlobal.__screepsMounted = true;
}
