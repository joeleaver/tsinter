import { expect, test } from "vitest";
import { VERSION } from "@tsinter/compiler";

test("workspace wiring", () => {
  expect(VERSION).toBe("0.0.1");
});
