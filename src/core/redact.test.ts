import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "./redact";

test("persisted text redacts common credentials without removing ordinary code", () => {
  const redacted = redactSecrets('hello\napi_key=sk-abcdefghijklmnop\nauthorization: bearer secret-value\naccess_token=token-value\n{"count": 3}');
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnop|secret-value|token-value/);
  assert.match(redacted, /hello/);
  assert.match(redacted, /\{"count": 3\}/);
});
