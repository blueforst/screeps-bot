import { ACTION_LOG_LIMIT, limitActionLog } from "@/runtime/actionLog";

describe("limitActionLog", () => {
  it("returns the original entries when within the limit", () => {
    const actions = ["a", "b", "c"];

    expect(limitActionLog(actions)).toEqual(actions);
  });

  it("keeps only the most recent entries when exceeding the limit", () => {
    const actions = Array.from({ length: ACTION_LOG_LIMIT + 5 }, (_, index) => `action-${index}`);

    expect(limitActionLog(actions)).toEqual(actions.slice(-ACTION_LOG_LIMIT));
  });
});
