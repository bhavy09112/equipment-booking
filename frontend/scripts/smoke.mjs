import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const python =
  process.env.TEST_PYTHON ||
  path.join(
    root,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
const temporary = await mkdtemp(path.join(os.tmpdir(), "fieldkit-smoke-"));
const port = process.env.SMOKE_PORT || "8765",
  base = `http://127.0.0.1:${port}`;
let server, browser;
const checks = [];
async function start() {
  server = spawn(
    python,
    ["-m", "uvicorn", "booking:app", "--host", "127.0.0.1", "--port", port],
    {
      cwd: root,
      env: { ...process.env, BOOKING_DB: path.join(temporary, "smoke.db") },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(log);
    try {
      if ((await fetch(base + "/api/equipment")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Server startup timeout: " + log);
}
async function stop() {
  if (server && server.exitCode === null) {
    const done = new Promise((r) => server.once("exit", r));
    server.kill();
    await done;
  }
}
try {
  await start();
  browser = await chromium.launch(
    process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {},
  );
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole("heading", { name: "The equipment shelf" }).waitFor();
  await page.getByRole("button", { name: /Survey drone/ }).click();
  await page.getByLabel("Start · your local time").fill("2030-01-01T10:00");
  await page.getByLabel("End · your local time").fill("2030-01-01T11:00");
  // Commit on the server, then lose the response. The unchanged form must retry the same key.
  await page.route("**/api/reservations", async (route) => {
    if (route.request().method() === "POST") {
      const reply = await route.fetch();
      assert.equal(reply.status(), 201);
      await route.abort();
      await page.unroute("**/api/reservations");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Reserve equipment" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /Failed to fetch|NetworkError|Load failed/ })
    .waitFor();
  assert.equal(
    (await (await fetch(base + "/api/reservations")).json()).length,
    1,
  );
  await page.getByRole("button", { name: "Reserve equipment" }).click();
  await page.getByRole("status").filter({ hasText: "confirmed" }).waitFor();
  assert.equal(
    (await (await fetch(base + "/api/reservations")).json()).length,
    1,
  );
  checks.push(
    "browse and reserve through real UI; lost-response retry creates one row",
  );
  await page.getByLabel("Demo access · switch member").selectOption("sam");
  assert.equal(
    await page.getByRole("button", { name: "Cancel booking" }).count(),
    0,
  );
  await page.getByRole("button", { name: "Reserve equipment" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "already reserved" })
    .waitFor();
  checks.push("conflict message and demo ownership");
  await page.getByLabel("Demo access · switch member").selectOption("alex");
  await page.getByRole("button", { name: "Cancel booking" }).click();
  await page.getByRole("status").filter({ hasText: "cancelled" }).waitFor();
  await page.getByRole("button", { name: "Reserve equipment" }).click();
  await page.getByRole("status").filter({ hasText: "confirmed" }).waitFor();
  checks.push("cancel and reserve refreshed availability");
  const before = await (await fetch(base + "/api/reservations")).json();
  await stop();
  await start();
  await page.reload();
  await page.getByRole("button", { name: "Cancel booking" }).waitFor();
  assert.deepEqual(
    await (await fetch(base + "/api/reservations")).json(),
    before,
  );
  checks.push("actual server process restart persistence");
  await mkdir(path.join(root, "docs"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "docs/desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: path.join(root, "docs/mobile.png"),
    fullPage: true,
  });
  checks.push("desktop/mobile captures and no mobile horizontal overflow");
  // Independent concurrent TCP requests through the real ASGI server and separate SQLite connections.
  const races = [];
  const raceStart = performance.now();
  for (let round = 0; round < 10; round++) {
    const payload = {
      equipment_id: 2,
      start: `2030-02-${String(round + 1).padStart(2, "0")}T10:00:00Z`,
      end: `2030-02-${String(round + 1).padStart(2, "0")}T11:00:00Z`,
    };
    const statuses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        fetch(base + "/api/reservations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Demo-Member": i % 2 ? "sam" : "alex",
            "Idempotency-Key": `race-${round}-${i}`,
          },
          body: JSON.stringify(payload),
        }).then((r) => r.status),
      ),
    );
    assert.equal(statuses.filter((s) => s === 201).length, 1);
    assert.equal(statuses.filter((s) => s === 409).length, 11);
    races.push(statuses);
  }
  const raceMs = Math.round(performance.now() - raceStart);
  checks.push(
    "10 rounds × 12 concurrent HTTP requests: 10 creates / 110 conflicts",
  );
  const rows = await (await fetch(base + "/api/reservations")).json();
  assert.equal(
    rows.filter((r) => r.equipment_id === 2 && r.status === "active").length,
    10,
  );
  assert.deepEqual(errors, []);
  checks.push("no browser runtime errors");
  const report = {
    checks,
    race: {
      rounds: 10,
      concurrentRequests: 12,
      created: 10,
      conflicts: 110,
      elapsedMs: raceMs,
    },
    node: process.version,
    platform: process.platform,
    browser: await browser.version(),
  };
  await writeFile(
    path.join(root, "docs/smoke-results.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await stop();
}
