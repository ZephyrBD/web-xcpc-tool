import type { Config } from "../config";

export type ClientFingerprint = {
  ip: string;
  method: string;
  path: string;
  headers: Record<string, string>;
};

export type IdentifyResult = {
  strategy: "client-id" | "ua-regex" | "custom-header";
  matched: string;
} | null;

const CLIENT_ID_HEADER = "x-oms-client-id";
const DEFAULT_UA_REGEXES = ["OMSClient", "QtWebEngine/\\d"];

export function identifyClient(
  fp: ClientFingerprint,
  cfg: Config["oms"],
  boundClientIds?: Set<string>,
): IdentifyResult {
  const enabled = new Set(cfg.strategies.map((s) => s.toLowerCase()));

  if (enabled.has("client-id")) {
    const header = Object.entries(fp.headers).find(
      ([k]) => k.toLowerCase() === CLIENT_ID_HEADER,
    );
    if (header && boundClientIds?.has(header[1])) {
      return { strategy: "client-id", matched: header[1] };
    }
  }

  if (enabled.has("ua-regex")) {
    const ua =
      Object.entries(fp.headers).find(([k]) => k.toLowerCase() === "user-agent")?.[1] ?? "";
    for (const pattern of cfg.uaRegexes.length > 0 ? cfg.uaRegexes : DEFAULT_UA_REGEXES) {
      try {
        if (new RegExp(pattern).test(ua)) {
          return { strategy: "ua-regex", matched: pattern };
        }
      } catch {
        // invalid pattern: skip
      }
    }
  }

  if (enabled.has("custom-header") && cfg.customHeader) {
    const { name, value } = cfg.customHeader;
    const header = Object.entries(fp.headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
    if (header && header[1] === value) {
      return { strategy: "custom-header", matched: header[1] };
    }
  }

  return null;
}
