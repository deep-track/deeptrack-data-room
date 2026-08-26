import assert from "node:assert/strict";
import test from "node:test";
import { resolveDataRoomRole } from "../src/auth0-roles";

test("Bryan remains founder even when Auth0 incorrectly supplies investor", () => {
  const session = resolveDataRoomRole({ email: "BRYAN@DEEPTRACK.IO", roles: ["investor"] });
  assert.deepEqual(session, { role: "founder", clearanceTier: 3 });
});

test("Yvonne remains investor relations even when Auth0 incorrectly supplies investor", () => {
  const session = resolveDataRoomRole({ email: "ygachara@deeptrack.io", roles: ["investor"] });
  assert.deepEqual(session, { role: "investorRelations", clearanceTier: 3 });
});

test("configured overrides are case-insensitive and support multiple internal identities", () => {
  const session = resolveDataRoomRole({ email: "yvonne@example.com", roles: [] }, { investorRelationsEmails: "yvonne@example.com,staff@example.com" });
  assert.equal(session.role, "investorRelations");
});

test("unknown users remain restricted investors by default", () => {
  const session = resolveDataRoomRole({ email: "external@example.com", roles: ["unknown"] });
  assert.deepEqual(session, { role: "investor", clearanceTier: 1 });
});
