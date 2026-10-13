import test from "node:test";
import assert from "node:assert/strict";
import { collectVerificationProblems, groupVerificationFindings } from "./verification-gates";

test("identical gate explanations are written once while retaining every affected check", () => {
  assert.deepEqual(groupVerificationFindings([{label:"scope",reason:"same evidence missing"},{label:"sources",reason:"same evidence missing"},{label:"test",reason:"other reason"}]),
    ["scope / sources: same evidence missing","test: other reason"]);
});

test("all gate findings and read errors are collected without converting unknown to pass", async () => {
  const seen:string[]=[];
  const problems=await collectVerificationProblems([
    {label:"quality",inspect:async()=>{seen.push("quality");throw new Error("cannot read ledger");},repair:"repair quality"},
    {label:"research",inspect:async()=>{seen.push("research");return ["missing critique"];},repair:"repair research"},
    {label:"HPC",inspect:async()=>{seen.push("HPC");return ["changed kernel"];},repair:"repair HPC"}
  ]);
  assert.deepEqual(seen,["quality","research","HPC"]);
  for(const detail of ["cannot read ledger","missing critique","changed kernel","repair quality","repair research","repair HPC"]) assert.ok(problems.some(p=>p.includes(detail)));
  assert.deepEqual(await collectVerificationProblems([{label:"pass",inspect:async()=>[],repair:"unused"}]),[]);
});
