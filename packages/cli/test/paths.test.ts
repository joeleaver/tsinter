import { buildTargetPlatform } from "@tsinter/compiler";
import { expect, test } from "vitest";
import { defaultExecutableName } from "../src/paths.js";

test("default executable names use the Windows PE suffix", () => {
  expect(defaultExecutableName("main", "win32")).toBe("main.exe");
  expect(defaultExecutableName("main", "linux")).toBe("main");
  expect(defaultExecutableName("main", "darwin")).toBe("main");
});

test("Windows cross-builds use the PE suffix on a non-Windows host", () => {
  const platform = buildTargetPlatform({
    SCRIPTC_CC: "zigcc",
    SCRIPTC_TARGET: "x86_64-windows-gnu",
  });
  expect(platform).toBe("win32");
  expect(defaultExecutableName("main", platform)).toBe("main.exe");
});
