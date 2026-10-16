import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decryptSecret, encryptSecret } from "./crypto";

describe("crypto", () => {
  it("round-trips a platform credential", () => {
    const encrypted = encryptSecret("cursor_test_key", "dev-secret");
    assert.equal(decryptSecret(encrypted, "dev-secret"), "cursor_test_key");
    assert.notEqual(encrypted, "cursor_test_key");
  });
});
