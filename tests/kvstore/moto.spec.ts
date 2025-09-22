import { describe, test } from "vitest";
import { startMotoServer } from "#tests/kvstore/moto.node.js";

describe("describe1", () => {
  test("test1", async () => {
    await startMotoServer();
  }, {
    timeout: 100000,
  });
});
