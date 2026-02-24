import { upsertConfig } from "@/runtime/creepApi";

const runtimeGlobal = global;

export function bootstrapRooms(): void {
  const myRooms = Object.values(Game.rooms).filter((room) => room.controller?.my);

  for (const room of myRooms) {
    const sources = room.find(FIND_SOURCES);

    sources.forEach((source, index) => {
      upsertConfig(`${room.name}:harvester:${index}`, "harvester", [source.id], room.name);
    });

    upsertConfig(`${room.name}:carrier:0`, "carrier", [], room.name);
    upsertConfig(`${room.name}:worker:0`, "worker", [], room.name);

    runtimeGlobal.creepApi.remove(`${room.name}:upgrader:0`);
    runtimeGlobal.creepApi.remove(`${room.name}:builder:0`);
  }
}
