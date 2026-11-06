import { PublicKey } from "@solana/web3.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const LAMPORTS_PER_SOL = 1_000_000_000;

export const MONITORED_PROGRAMS = [
  {
    id: "BQFtMNSBKP3qLsoyocazbKA7fB8313jizRCSs1R6hBma",
    name: "Pump.fun",
    family: "pumpfun",
  },
  {
    id: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    name: "PumpSwap",
    family: "pumpswap",
  },
  {
    id: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
    name: "Raydium CPMM",
    family: "raydium-cpmm",
  },
  {
    id: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    name: "Raydium AMM v4",
    family: "raydium-amm-v4",
  },
  {
    id: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
    name: "Raydium LaunchLab",
    family: "raydium-launchlab",
  },
] as const;

for (const program of MONITORED_PROGRAMS) {
  try {
    new PublicKey(program.id);
  } catch {
    throw new Error(`Invalid configured Solana program address for ${program.name}.`);
  }
}

export type ProgramFamily = (typeof MONITORED_PROGRAMS)[number]["family"];
