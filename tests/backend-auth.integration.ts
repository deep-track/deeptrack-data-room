import assert from "node:assert/strict";
import test from "node:test";
import { resolveRole } from "../backend/src/auth.js";

test("verified Bryan identity remains founder when the role claim is stale", () => {
  assert.equal(resolveRole({ email: "BRYAN@DEEPTRACK.IO", email_verified: true, "https://deeptrack.io/roles": ["investor"] }), "founder");
});

test("namespaced verified email claim supports access tokens without standard email claims", () => {
  assert.equal(resolveRole({ "https://deeptrack.io/verified_email": "bryan@deeptrack.io", "https://deeptrack.io/roles": ["investor"] }), "founder");
});

test("role claims are normalized without elevating unknown identities", () => {
  assert.equal(resolveRole({ "https://deeptrack.io/roles": ["ADMIN"] }), "investorRelations");
  assert.equal(resolveRole({ email: "external@example.com", email_verified: true, "https://deeptrack.io/roles": ["unknown"] }), "investor");
});
