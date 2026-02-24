import { addNumbers } from "./main";

it("adds two numbers", () => {
  expect(addNumbers(1, 2)).toBe(3);
});

it("has screeps-like globals in test env", () => {
  expect(Game).toBeDefined();
  expect(Memory).toMatchObject({ creeps: {}, rooms: {} });
  expect(_).toBeDefined();
});
