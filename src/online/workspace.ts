import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createDatabase } from "../state/database.js";
import { OnlineRuntime } from "./runtime.js";
import type { PublicFetch } from "./sources.js";

/** Online research has its own marker and DB; simulation/live ledgers are refused. */
export function openOnline(options: { resume?: string; directory?: string; recover?: boolean; request?: PublicFetch } = {}) {
  if (options.resume && options.directory) throw new Error("Choose a new online directory or resume");
  const file = options.resume ? path.resolve(options.resume) : path.join(path.resolve(options.directory ??
    path.join("obolus-online-data", `research-${Date.now()}`)), "research.db");
  if (options.resume) {
    const check = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const row = check.prepare("SELECT mode FROM online_control WHERE id=1").get() as { mode: string } | undefined;
      if (row?.mode !== "online-research") throw new Error("Only marked online research databases can be opened");
    } finally { check.close(); }
  } else {
    fs.mkdirSync(path.dirname(path.dirname(file)), { recursive: true });
    fs.mkdirSync(path.dirname(file)); // Never overwrite an existing workspace.
  }
  const database = createDatabase(file);
  try {
    const runtime = new OnlineRuntime(database.raw, options.request);
    if (options.recover !== false) runtime.recover();
    return { database, runtime, file };
  } catch (error) { database.close(); throw error; }
}
