import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");

test("production fails closed when Auth0 is not configured", () => {
  assert.match(source, /import\.meta\.env\.DEV\s*&&\s*import\.meta\.env\.VITE_ENABLE_REVIEW_PREVIEW\s*===\s*['"]true['"]/);
  assert.match(source, /!isAuth0Configured\s*&&\s*!reviewPreviewEnabled/);
  assert.match(source, /AuthConfigurationError/);
});

test("preview mode is never enabled by production builds", () => {
  assert.match(source, /const reviewPreviewEnabled = import\.meta\.env\.DEV/);
});
