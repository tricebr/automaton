import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import vm from "node:vm";
import { openSimulation } from "../v1/simulation.js";
import { startDashboard } from "../v1/dashboard.js";
let sim: ReturnType<typeof openSimulation>;
let ui: Awaited<ReturnType<typeof startDashboard>>;
let auth: string;
function call(route: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const request = http.request(ui.url + route, { method: body === undefined ? "GET" : "POST", headers: {
      "Content-Type": "application/json", "X-Aureus-Token": auth ?? "", ...headers,
    } }, response => { let text = ""; response.on("data", chunk => { text += chunk; }); response.on("end", () => resolve({ status: response.statusCode!, text, headers: response.headers })); });
    request.on("error", reject); if (body !== undefined) request.write(JSON.stringify(body)); request.end();
  });
}
beforeEach(async () => {
  sim = openSimulation(); ui = await startDashboard(sim.runtime);
  const page = await call("/"); auth = /const AUTH="([a-f0-9]+)"/.exec(page.text)![1];
});
afterEach(async () => { await ui.close(); sim.database.close(); fs.rmSync(sim.directory, { recursive: true }); });
describe("loopback dashboard security and controls", () => {
  it("serves the UI with CSP and no live execution permissions", async () => {
    const page = await call("/"); expect(page.status).toBe(200);
    expect(page.text).toContain('<h1>numaron</h1>');
    expect((await call("/api/snapshot", undefined, { "X-Obolus-Token": auth, "X-Aureus-Token": "" })).status).toBe(200);
    expect((await call("/api/snapshot", undefined, { "X-Obolus-Token": "invalid" })).status).toBe(403);
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.text).toContain("SIMULATION");
    const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(page.text)![1];
    expect(() => new vm.Script(script)).not.toThrow();
    const snapshot = JSON.parse((await call("/api/snapshot")).text);
    expect(snapshot.approvals).toMatchObject({ paidProviders: "disabled", shell: "disabled" });
  });
  it("rejects cross-origin mutation, missing token and rebinding hosts", async () => {
    expect((await call("/api/control", { action: "start" }, { Origin: "https://attacker.example" })).status).toBe(403);
    expect((await call("/api/control", { action: "start" }, { "X-Aureus-Token": "" })).status).toBe(403);
    expect((await call("/", undefined, { Host: "attacker.example" })).status).toBe(403);
    expect((await call("/api/snapshot", undefined, { "X-Aureus-Token": "ä".repeat(64) })).status).toBe(403);
    expect(sim.runtime.status).toBe("stopped");
  });
  it("offers working start/pause/resume/stop and latched emergency controls", async () => {
    for (const action of ["start", "pause", "resume", "stop", "start", "emergency"]) {
      expect((await call("/api/control", { action })).status).toBe(200);
    }
    expect((await call("/api/control", { action: "resume" })).status).toBe(400);
    expect(sim.runtime.status).toBe("emergency");
    expect((await call("/api/control", { action: "reset" })).status).toBe(200);
    expect(sim.runtime.status).toBe("stopped");
  });
  it("loads synthetic opportunities and persists paper output without booking revenue", async () => {
    expect((await call("/api/demo", {})).status).toBe(200);
    expect((await call("/api/paper", {})).status).toBe(200);
    const snapshot = JSON.parse((await call("/api/snapshot")).text);
    expect(snapshot.cases).toHaveLength(8); expect(snapshot.paper).toHaveLength(1);
    expect(snapshot.totals.revenueCents).toBe(0);
  });
  it("rejects invalid and oversized control requests", async () => {
    expect((await call("/api/control", { action: "execute_shell" })).status).toBe(400);
    expect((await call("/api/control", { content: "x".repeat(9000) })).status).toBe(413);
    expect((await call("/api/control", {}, { "Content-Type": "text/plain" })).status).toBe(415);
  });
});
