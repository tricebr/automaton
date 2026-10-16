import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Mt5ReadOptions {
  python: string;
  script: string;
  terminal: string;
  expectedLogin: number;
  expectedServer: string;
  expectedTradeMode?: 0;
  scriptArgs?: string[];
}

/** Local telemetry only. Intentionally does not implement LiveOrderAdapter. */
export function validateMt5Snapshot(value: unknown, options: Pick<Mt5ReadOptions,
  'expectedLogin' | 'expectedServer' | 'expectedTradeMode'>, now = Date.now()) {
  const v = value as Record<string, any>;
  if (!v || v.schemaVersion !== 1 || v.readOnly !== true || v.executionEnabled !== false)
    throw new Error('Invalid MT5 telemetry envelope');
  const time = Date.parse(v.observedAt);
  if (!Number.isFinite(time) || time > now + 1000 || now - time > 15000)
    throw new Error('Stale or future MT5 telemetry');
  const a = v.account;
  if (!a || a.login !== options.expectedLogin || a.server !== options.expectedServer)
    throw new Error('Unexpected MT5 account or server');
  if (options.expectedTradeMode === 0 && a.trade_mode !== 0)
    throw new Error('Required MT5 demo account unavailable');
  if (typeof a.currency !== 'string' || !/^[A-Z]{3}$/.test(a.currency))
    throw new Error('Invalid account currency');
  for (const key of ['balance', 'equity', 'profit', 'margin', 'margin_free', 'leverage'])
    if (!Number.isFinite(a[key])) throw new Error('Invalid account number');
  if (!Array.isArray(v.positions) || !Array.isArray(v.pendingOrders))
    throw new Error('Incomplete MT5 exposure');
  for (const item of [...v.positions, ...v.pendingOrders]) {
    if (!item || typeof item.symbol !== 'string' || !Number.isSafeInteger(item.ticket))
      throw new Error('Invalid MT5 exposure');
    for (const [key, number] of Object.entries(item))
      if (key !== 'symbol' && !Number.isFinite(number)) throw new Error('Invalid exposure number');
  }
  for (const p of v.positions)
    for (const key of ['type', 'volume', 'price_open', 'price_current', 'sl', 'tp', 'profit', 'swap'])
      if (!Number.isFinite(p[key])) throw new Error('Incomplete MT5 position');
  for (const p of v.pendingOrders)
    for (const key of ['type', 'volume_current', 'price_open', 'sl', 'tp'])
      if (!Number.isFinite(p[key])) throw new Error('Incomplete MT5 pending order');
  return { observedAt: v.observedAt as string, account: { ...a },
    positions: v.positions.map((p: Record<string, unknown>) => ({ ...p })),
    pendingOrders: v.pendingOrders.map((p: Record<string, unknown>) => ({ ...p })),
    executionEnabled: false as const, source: 'MT5-local-readonly' as const };
}

export async function readMt5Account(options: Mt5ReadOptions) {
  const folder = await mkdtemp(join(tmpdir(), 'obolus-mt5-'));
  try {
    const output = join(folder, 'snapshot.json');
    await promisify(execFile)(options.python, [options.script, '--terminal', options.terminal,
      '--expected-login', String(options.expectedLogin), '--output', output, ...(options.scriptArgs ?? [])],
    { timeout: 15000, windowsHide: true, maxBuffer: 65536 });
    // Unique file for every attempt: a failed refresh can never return an older file.
    return validateMt5Snapshot(JSON.parse(await readFile(output, 'utf8')), options);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
