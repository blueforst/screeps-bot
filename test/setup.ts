import { refreshGlobalMock } from "@mock/index";

class RoomVisualMock {
  public text(): RoomVisualMock {
    return this;
  }
  public circle(): RoomVisualMock {
    return this;
  }
  public rect(): RoomVisualMock {
    return this;
  }
  public poly(): RoomVisualMock {
    return this;
  }
  public line(): RoomVisualMock {
    return this;
  }
}

Object.assign(global, {
  RoomVisual: RoomVisualMock,
});

refreshGlobalMock();
beforeEach(refreshGlobalMock);
