import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createDatabase } from "../state/database.js";
import { SimulationRuntime, DEFAULT_SETTINGS, SECTORS, STAGES, type Candidate, type Settings, type Receipt } from "./runtime.js";
import { walkForwardPaper, type Bar } from "../revenue/paper-trading.js";

export function openSimulation(resumePath?: string, settings: Settings = DEFAULT_SETTINGS, newDirectory?: string, recover = true) {
  if (resumePath && newDirectory) throw new Error("Choose resume or a new simulation directory");
  const directory = resumePath ? path.dirname(path.resolve(resumePath)) : newDirectory ? path.resolve(newDirectory) : fs.mkdtempSync(path.join(os.tmpdir(), "obolus-v1-"));
  if (newDirectory) fs.mkdirSync(directory); // EEXIST is intentional: never overwrite an existing run.
  const file = resumePath ? path.resolve(resumePath) : path.join(directory, "simulation.db");
  if (resumePath) {
    // Inspect read-only BEFORE createDatabase can run migrations. Never accept a live DB.
    const check = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const marker = check.prepare("SELECT mode FROM v1_control WHERE id=1").get() as { mode: string } | undefined;
      if (marker?.mode !== "simulation") throw new Error("Only a marked Obolus simulation database can be resumed");
    } finally { check.close(); }
  }
  const database = createDatabase(file);
  try {
    const runtime = new SimulationRuntime(database.raw, settings);
    // Import/review clients must not claim controller ownership or interrupt work.
    if (recover) runtime.recover();
    return { runtime, database, directory, file };
  } catch (error) { database.close(); throw error; }
}

export function candidate(index: number, succeeds = true): Candidate {
  const sector = SECTORS[index % SECTORS.length];
  const scenario = Object.fromEntries(STAGES.map(stage => [stage, {
    costCents: 40, revenueCents: stage === "monetize" || stage === "scale" ? 600 : 0,
    qualifiedLeads: succeeds ? 4 : 1, paidCustomers: succeeds ? 2 : 0,
    evidenceRef: `simulation:fixture-${index}:${stage}`,
    note: `Synthetic ${stage} result; not real customer evidence`,
  }])) as Record<typeof STAGES[number], Receipt>;
  return { name: `${sector} / simulation ${index}`, sector, source: `simulation:discovery-${index}`,
    hypothesis: "A bounded offer can meet the configured paid-demand and net-return criteria",
    maxCostCents: 1000, forecastNetCents: 800, minLeads: 3, minCustomers: 1, minNetCents: 100, scenario };
}
export function seedDemo(runtime: SimulationRuntime): void {
  if ((runtime.db.prepare("SELECT count(*) n FROM v1_cases").get() as { n: number }).n) return;
  SECTORS.forEach((_sector, i) => runtime.discover(candidate(i, i % 4 !== 3)));
}
export function paperDemo(runtime: SimulationRuntime) {
  // Wholly synthetic, fixed prices; no downloaded data or historical-profit claim.
  const bars: Bar[] = Array.from({ length: 180 }, (_, i) => {
    const open = 10000 + Math.round(Math.sin(i / 7) * 500) + i * 2;
    return { time: Date.UTC(2020, 0, 1) + i * 86400000, open, high: open + 200, low: open - 180, close: open + (i % 2 ? 80 : -60) };
  });
  const result = walkForwardPaper(bars, 60, 20, 1000000, { feeBps: 10, slippageBps: 10 }, training => {
    const threshold = training.slice(-10).reduce((n, b) => n + b.close, 0) / 10;
    return (past, open) => past.at(-1)!.close > threshold ? {
      symbol: "SYNTHETIC", thesis: "Synthetic momentum fixture", entryCents: open,
      stopCents: Math.ceil(open * 0.96), targetsCents: [Math.ceil(open * 1.08)], exitRule: "stop/target/window end", riskFraction: 0.01,
    } : null;
  });
  runtime.db.prepare("INSERT INTO v1_paper(id,result) VALUES(?,?) ON CONFLICT(id) DO NOTHING").run("synthetic-walk-forward-v1", JSON.stringify(result));
  return result;
}

export async function runToIdle(runtime: SimulationRuntime, maxTicks = 5000): Promise<number> {
  let processed = 0;
  for (let i = 0; i < maxTicks; i++) { const n = await runtime.tick(); if (!n) return processed; processed += n; }
  throw new Error("Simulation tick ceiling exceeded");
}
