import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { MONITORED_PROGRAMS, SOL_MINT, USDC_MINT, type ProgramFamily } from "../constants.js";
import type { ParsedInstruction, ParsedTransaction } from "../providers/helius.js";

export interface LaunchEvent {
  mint: string;
  creatorWallet: string | null;
  creatorBasis: string;
  creatorVerified: boolean;
  programId: string;
  programName: string;
  family: ProgramFamily;
  launchType: "token" | "pool";
  poolAddress: string | null;
  lpMint: string | null;
  name?: string;
  symbol?: string;
  metadataUri?: string;
}

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function readBorshString(data: Buffer, start: number): { value: string; next: number } | null {
  if (start + 4 > data.length) return null;
  const length = data.readUInt32LE(start);
  const end = start + 4 + length;
  if (length > 2_048 || end > data.length) return null;
  return { value: data.subarray(start + 4, end).toString("utf8"), next: end };
}

function accountAt(ix: ParsedInstruction, index: number): string | null {
  const value = ix.accounts?.[index];
  if (!value) return null;
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return null;
  }
}

function programAddress(ix: ParsedInstruction): string | null {
  if (!ix.programId) return null;
  try {
    return new PublicKey(ix.programId).toBase58();
  } catch {
    return null;
  }
}

function instructionBytes(ix: ParsedInstruction): Buffer | null {
  if (!ix.data) return null;
  try {
    return Buffer.from(bs58.decode(ix.data));
  } catch {
    return null;
  }
}

function instructionsOf(transaction: ParsedTransaction): ParsedInstruction[] {
  const topLevel = transaction.transaction.message.instructions;
  const inner = (transaction.meta?.innerInstructions ?? []).flatMap((group) => group.instructions);
  return [...topLevel, ...inner];
}

function eventFor(
  family: ProgramFamily,
  mint: string,
  creatorWallet: string | null,
  creatorBasis: string,
  creatorVerified: boolean,
  launchType: "token" | "pool",
  poolAddress: string | null,
  lpMint: string | null,
  extra: Pick<LaunchEvent, "name" | "symbol" | "metadataUri"> = {},
): LaunchEvent {
  const program = MONITORED_PROGRAMS.find((item) => item.family === family);
  if (!program) throw new Error(`No monitored program config for ${family}.`);
  return {
    mint,
    creatorWallet,
    creatorBasis,
    creatorVerified,
    programId: program.id,
    programName: program.name,
    family,
    launchType,
    poolAddress,
    lpMint,
    ...extra,
  };
}

function decodePumpCreate(ix: ParsedInstruction): LaunchEvent | null {
  const data = instructionBytes(ix);
  const mint = accountAt(ix, 0);
  if (!data || !mint || data.length < 8 || !data.subarray(0, 8).equals(anchorDiscriminator("create_v2"))) {
    return null;
  }

  let cursor = 8;
  const name = readBorshString(data, cursor);
  if (!name) return null;
  cursor = name.next;
  const symbol = readBorshString(data, cursor);
  if (!symbol) return null;
  cursor = symbol.next;
  const uri = readBorshString(data, cursor);
  if (!uri) return null;
  cursor = uri.next;
  if (cursor + 32 > data.length) return null;

  let creatorWallet: string | null = null;
  try {
    creatorWallet = new PublicKey(data.subarray(cursor, cursor + 32)).toBase58();
  } catch {
    return null;
  }

  return eventFor(
    "pumpfun",
    mint,
    creatorWallet,
    "Pump create_v2 creator argument",
    creatorWallet !== PublicKey.default.toBase58(),
    "token",
    null,
    null,
    { name: name.value, symbol: symbol.value, metadataUri: uri.value },
  );
}

function decodePumpSwapPool(ix: ParsedInstruction): LaunchEvent | null {
  const data = instructionBytes(ix);
  if (!data || data.length < 8 || !data.subarray(0, 8).equals(Buffer.from([233, 146, 209, 142, 207, 104, 64, 188]))) {
    return null;
  }
  const poolAddress = accountAt(ix, 0);
  const creator = accountAt(ix, 2);
  const baseMint = accountAt(ix, 3);
  const lpMint = accountAt(ix, 5);
  if (!poolAddress || !creator || !baseMint || !lpMint) return null;
  return eventFor(
    "pumpswap",
    baseMint,
    creator,
    "PumpSwap pool creator (not necessarily token creator)",
    false,
    "pool",
    poolAddress,
    lpMint,
  );
}

function poolTokenMints(ix: ParsedInstruction, firstIndex: number, secondIndex: number): string[] {
  const mints = [accountAt(ix, firstIndex), accountAt(ix, secondIndex)].filter(
    (mint): mint is string => Boolean(mint) && mint !== SOL_MINT && mint !== USDC_MINT,
  );
  return [...new Set(mints)];
}

function decodeRaydium(ix: ParsedInstruction, family: ProgramFamily): LaunchEvent[] {
  const data = instructionBytes(ix);
  if (!data) return [];
  const result: LaunchEvent[] = [];

  if (family === "raydium-launchlab") {
    const isV2 =
      data.length >= 8 && data.subarray(0, 8).equals(anchorDiscriminator("initialize_v2"));
    const isToken2022 =
      data.length >= 8 &&
      data.subarray(0, 8).equals(anchorDiscriminator("initialize_with_token2022"));
    if (!isV2 && !isToken2022) return [];
    const creator = accountAt(ix, 1);
    const pool = accountAt(ix, 5);
    const mint = accountAt(ix, 6);
    if (!creator || !pool || !mint) return [];
    return [
      eventFor(
        family,
        mint,
        creator,
        "Raydium LaunchLab creator account",
        true,
        "token",
        pool,
        null,
      ),
    ];
  }

  if (family === "raydium-cpmm") {
    const supported =
      data.length >= 8 &&
      ["initialize", "initialize_v2", "initialize_with_permission"].some((name) =>
        data.subarray(0, 8).equals(anchorDiscriminator(name)),
      );
    if (!supported) return [];
    const creator = accountAt(ix, 0);
    const pool = accountAt(ix, 3);
    const lpMint = accountAt(ix, 6);
    if (!creator || !pool || !lpMint) return [];
    for (const mint of poolTokenMints(ix, 4, 5)) {
      result.push(
        eventFor(
          family,
          mint,
          creator,
          "Raydium pool creator account",
          false,
          "pool",
          pool,
          lpMint,
        ),
      );
    }
    return result;
  }

  if (family === "raydium-amm-v4") {
    if (data[0] !== 1) return [];
    const creator = accountAt(ix, 15);
    const pool = accountAt(ix, 4);
    const lpMint = accountAt(ix, 7);
    if (!creator || !pool || !lpMint) return [];
    for (const mint of poolTokenMints(ix, 8, 9)) {
      result.push(
        eventFor(
          family,
          mint,
          creator,
          "Raydium AMM v4 pool creator account",
          false,
          "pool",
          pool,
          lpMint,
        ),
      );
    }
  }
  return result;
}

export function decodeLaunches(transaction: ParsedTransaction): LaunchEvent[] {
  if (!transaction.meta || transaction.meta.err) return [];
  const events: LaunchEvent[] = [];

  for (const ix of instructionsOf(transaction)) {
    const programId = programAddress(ix);
    const program = MONITORED_PROGRAMS.find((item) => item.id === programId);
    if (!program) continue;

    if (program.family === "pumpfun") {
      const event = decodePumpCreate(ix);
      if (event) events.push(event);
      continue;
    }
    if (program.family === "pumpswap") {
      const event = decodePumpSwapPool(ix);
      if (event) events.push(event);
      continue;
    }
    events.push(...decodeRaydium(ix, program.family));
  }

  const unique = new Map<string, LaunchEvent>();
  for (const event of events) {
    unique.set(`${event.mint}:${event.poolAddress ?? "token"}`, event);
  }
  return [...unique.values()];
}

export function transactionFeePayer(transaction: ParsedTransaction): string | null {
  const first = transaction.transaction.message.accountKeys[0];
  const address = typeof first === "string" ? first : first?.pubkey;
  if (!address) return null;
  try {
    return new PublicKey(address).toBase58();
  } catch {
    return null;
  }
}

export function directIncomingSolTransfer(
  transaction: ParsedTransaction,
  wallet: string,
): string | null {
  for (const ix of instructionsOf(transaction)) {
    const info = ix.parsed?.info;
    if (
      ix.parsed?.type === "transfer" &&
      typeof info?.source === "string" &&
      info.destination === wallet &&
      typeof info.lamports === "number" &&
      info.lamports > 0
    ) {
      return info.source;
    }
  }
  return null;
}
