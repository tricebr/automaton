export interface WalletReader {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** Self-contained so the same audited reader can run in the browser. No writes. */
export async function readBaseBalance(provider: WalletReader, address: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Invalid address");
  const request = (method: string, params: unknown[] = []) => new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Wallet RPC timeout")), 15000);
    Promise.resolve().then(() => provider.request({ method, params })).then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
  const quantity = (value: unknown): bigint => {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new Error("Invalid balance");
    return BigInt(value);
  };
  const format = (value: bigint, decimals: number) => {
    const text = value.toString().padStart(decimals + 1, "0");
    return text.slice(0, -decimals) + "." + text.slice(-decimals);
  };
  if (await request("eth_chainId") !== "0x2105") throw new Error("Base required");
  const block = await request("eth_getBlockByNumber", ["finalized", false]) as { hash?: string; number?: string } | null;
  if (!block || !/^0x[0-9a-fA-F]{64}$/.test(block.hash ?? "") || !/^0x[0-9a-fA-F]+$/.test(block.number ?? "")) throw new Error("Finalized block unavailable");
  const eth = quantity(await request("eth_getBalance", [address, block.number]));
  const usdc = quantity(await request("eth_call", [{
    to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    data: "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0"),
  }, block.number]));
  const verified = await request("eth_getBlockByNumber", [block.number, false]) as { hash?: string } | null;
  if (verified?.hash !== block.hash || await request("eth_chainId") !== "0x2105") throw new Error("Network or block changed");
  return { eth: format(eth, 18), usdc: format(usdc, 6), blockNumber: BigInt(block.number!).toString(), blockHash: block.hash! };
}
