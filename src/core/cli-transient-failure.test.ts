import test from "node:test";
import assert from "node:assert/strict";
import { nativeCliFailure, hookCliFailure } from "./cli-transient-failure";

const capacity="■ Selected model is at capacity. Please try a different model.\n\n› Ask Codex to do anything\n? for shortcuts";
test("capacity requires the native Codex idle failure frame, never quoted prose or a working/approval screen",()=>{
  assert.equal(nativeCliFailure("codex",capacity)?.kind,"capacity");
  for(const text of ["Selected model is at capacity",capacity.split("\n")[0],"A source file says: "+capacity,
    capacity+"\nesc to interrupt",capacity+"\nAllow once?",capacity.replace("■","quoted:")])
    assert.equal(nativeCliFailure("codex",text),undefined);
  assert.equal(nativeCliFailure("claude",capacity),undefined);
  assert.equal(nativeCliFailure("antigravity","⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials.\nError ID: aa-bb")?.kind,"authentication");
  assert.equal(nativeCliFailure("antigravity","Please investigate a 401 error"),undefined);
});
test("native hook failures distinguish quota, auth, backend capacity and connection; generic blockers do not reroute",()=>{
  assert.equal(hookCliFailure("authentication_failed","")?.kind,"authentication");
  assert.equal(hookCliFailure("api_error","Selected model is at capacity")?.kind,"capacity");
  assert.equal(hookCliFailure("api_error","fetch failed: ECONNRESET")?.kind,"connection");
  assert.equal(hookCliFailure("rate_limit","429 too many requests"),undefined);
  assert.equal(hookCliFailure("execution_failure","Need a compiler"),undefined);
});
