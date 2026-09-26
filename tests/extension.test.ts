import { describe, expect, it } from "vitest";
import manifest from "../extension/public/manifest.json";
import { hostPattern } from "../extension/src/shared.js";

describe("extension host permissions", () => {
  it("builds port-free match patterns (Chrome rejects ports in patterns)", () => {
    expect(hostPattern("http://localhost:8787")).toBe("http://localhost/*");
    expect(hostPattern("https://mycall.example.com/app")).toBe("https://mycall.example.com/*");
    expect(hostPattern("http://192.168.1.20:8787")).toBe("http://192.168.1.20/*");
    expect(() => hostPattern("ftp://x")).toThrow();
  });

  it("every pattern we request is covered by optional_host_permissions", () => {
    const declared = manifest.optional_host_permissions;
    for (const url of ["http://localhost:8787", "http://192.168.1.20:8787", "https://mycall.example.com"]) {
      const scheme = new URL(url).protocol;
      expect(declared).toContain(`${scheme}//*/*`);
      expect(hostPattern(url)).not.toMatch(/:\d+\//);
    }
  });
});
