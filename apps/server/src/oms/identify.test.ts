import { describe, expect, test } from "bun:test";
import { identifyClient, type ClientFingerprint } from "./identify";

function fp(headers: Record<string, string>): ClientFingerprint {
  return { ip: "192.168.1.10", method: "GET", path: "/cxtool/api/test", headers };
}

describe("identifyClient", () => {
  test("QtWebEngine UA matches ua-regex with matched pattern", () => {
    const result = identifyClient(
      fp({ "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36 QtWebEngine/6.5.3" }),
      { strategies: ["ua-regex"], uaRegexes: ["OMSClient", "QtWebEngine/\\d"], capture: false },
    );
    expect(result).toEqual({ strategy: "ua-regex", matched: "QtWebEngine/\\d" });
  });

  test("client-id takes priority over OMSClient UA", () => {
    const result = identifyClient(
      fp({ "x-oms-client-id": "client-1", "User-Agent": "OMSClient/1.0" }),
      { strategies: ["client-id", "ua-regex"], uaRegexes: ["OMSClient"], capture: false },
      new Set(["client-1"]),
    );
    expect(result).toEqual({ strategy: "client-id", matched: "client-1" });
  });

  test("no bound client id + plain Chrome UA returns null", () => {
    const result = identifyClient(
      fp({ "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36" }),
      { strategies: ["client-id", "ua-regex"], uaRegexes: ["OMSClient", "QtWebEngine/\\d"], capture: false },
    );
    expect(result).toBeNull();
  });

  test("custom header match", () => {
    const result = identifyClient(
      fp({ "x-exam-hw": "abc" }),
      {
        strategies: ["custom-header"],
        uaRegexes: [],
        capture: false,
        customHeader: { name: "x-exam-hw", value: "abc" },
      },
    );
    expect(result).toEqual({ strategy: "custom-header", matched: "abc" });
  });

  test("disabled strategies are skipped even if they would match", () => {
    const result = identifyClient(
      fp({ "User-Agent": "OMSClient/1.0" }),
      { strategies: [], uaRegexes: ["OMSClient"], capture: false },
    );
    expect(result).toBeNull();
  });

  test("client-id header not in bound set falls through to ua-regex", () => {
    const result = identifyClient(
      fp({ "x-oms-client-id": "unknown", "User-Agent": "OMSClient/1.0" }),
      { strategies: ["client-id", "ua-regex"], uaRegexes: ["OMSClient"], capture: false },
      new Set(["other"]),
    );
    expect(result).toEqual({ strategy: "ua-regex", matched: "OMSClient" });
  });

  test("invalid regex pattern is skipped, not thrown", () => {
    const result = identifyClient(
      fp({ "User-Agent": "OMSClient/1.0" }),
      { strategies: ["ua-regex"], uaRegexes: ["([invalid", "OMSClient"], capture: false },
    );
    expect(result).toEqual({ strategy: "ua-regex", matched: "OMSClient" });
  });
});
