import { describe, expect, test } from "bun:test";
import { signTeamToken, verifyTeamToken } from "./token";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("signTeamToken/verifyTeamToken", () => {
  test("roundtrip", async () => {
    const token = await signTeamToken(SECRET, 60, "t1");
    expect(await verifyTeamToken(SECRET, token)).toEqual({ sub: "t1" });
  });

  test("expired token returns null", async () => {
    const token = await signTeamToken(SECRET, -1, "t1");
    expect(await verifyTeamToken(SECRET, token)).toBeNull();
  });

  test("tampered token returns null", async () => {
    const token = await signTeamToken(SECRET, 60, "t1");
    const [head, payload] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    decoded.sub = "t2";
    const forged = `${head}.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${token.split(".")[2]}`;
    expect(await verifyTeamToken(SECRET, forged)).toBeNull();
  });

  test("malformed token returns null", async () => {
    expect(await verifyTeamToken(SECRET, "not-a-token")).toBeNull();
    expect(await verifyTeamToken(SECRET, "")).toBeNull();
  });

  test("wrong secret returns null", async () => {
    const token = await signTeamToken(SECRET, 60, "t1");
    expect(await verifyTeamToken("ffffffffffffffffffffffffffffffff", token)).toBeNull();
  });
});
