import type { DeveloperSummary } from "./wallet.js";

export interface RatingInputs {
  developer: DeveloperSummary | null;
  creatorVerified: boolean;
  mintDataVerified: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  token2022Extensions: string[];
  top10HolderPct: number | null;
  creatorAllocationPct: number | null;
  liquidityDropPct: number | null;
  previousRiskSignalCount: number;
  holderCoverageComplete: boolean;
}

export interface DeveloperRating {
  score: number;
  confidence: "low" | "medium" | "high";
  reasons: string[];
}

const HIGH_RISK_EXTENSIONS = new Set([
  "MintCloseAuthority",
  "TransferFeeConfig",
  "PermanentDelegate",
  "TransferHook",
  "DefaultAccountState",
  "ConfidentialTransferMint",
  "ConfidentialTransferFeeConfig",
  "PausableConfig",
  "PermissionedBurn",
]);

export function rateDeveloper(input: RatingInputs): DeveloperRating {
  let score = 50;
  const reasons: string[] = ["Neutral starting score: 50."];

  const successes = input.developer?.verifiedSuccessfulLaunches ?? 0;
  if (successes > 0) {
    const points = Math.min(24, successes * 8);
    score += points;
    reasons.push(
      `+${points}: ${successes} previous launch(es) have a verified observed market cap of at least $100,000.`,
    );
  } else {
    reasons.push("No previous launch has a verified observed market cap of at least $100,000.");
  }

  if (input.mintAuthority) {
    score -= 10;
    reasons.push("−10: mint authority is still active.");
  } else if (input.mintDataVerified) {
    reasons.push("Mint authority is revoked.");
  } else {
    reasons.push("Mint authority could not be verified; no authority points were applied.");
  }
  if (input.freezeAuthority) {
    score -= 10;
    reasons.push("−10: freeze authority is still active.");
  } else if (input.mintDataVerified) {
    reasons.push("Freeze authority is revoked.");
  } else {
    reasons.push("Freeze authority could not be verified; no authority points were applied.");
  }

  const severeExtensions = input.token2022Extensions.filter((extension) =>
    HIGH_RISK_EXTENSIONS.has(extension),
  );
  if (severeExtensions.length > 0) {
    const penalty = Math.min(15, severeExtensions.length * 5);
    score -= penalty;
    reasons.push(`−${penalty}: Token-2022 extension(s) need extra scrutiny: ${severeExtensions.join(", ")}.`);
  }

  if (input.top10HolderPct !== null) {
    if (input.top10HolderPct >= 80) {
      score -= 20;
      reasons.push("−20: the measured top-10 holder concentration is at least 80%.");
    } else if (input.top10HolderPct >= 60) {
      score -= 10;
      reasons.push("−10: the measured top-10 holder concentration is at least 60%.");
    } else {
      reasons.push("Measured top-10 holder concentration is below 60%.");
    }
  } else {
    reasons.push("Holder concentration is unavailable; no concentration points were applied.");
  }

  if (input.creatorAllocationPct !== null) {
    if (input.creatorAllocationPct >= 50) {
      score -= 15;
      reasons.push("−15: the creator currently holds at least 50% of the supply.");
    } else if (input.creatorAllocationPct >= 25) {
      score -= 10;
      reasons.push("−10: the creator currently holds at least 25% of the supply.");
    }
  } else {
    reasons.push("Creator allocation is unavailable; no allocation points were applied.");
  }

  if (input.liquidityDropPct !== null && input.liquidityDropPct >= 50) {
    score -= 20;
    reasons.push(
      `−20: observed pool liquidity fell ${input.liquidityDropPct.toFixed(1)}% from a recent stored observation.`,
    );
  } else {
    reasons.push("No measured liquidity drop of 50% or more in the recent observation window.");
  }

  if (input.previousRiskSignalCount > 0) {
    const penalty = Math.min(15, input.previousRiskSignalCount * 5);
    score -= penalty;
    reasons.push(
      `−${penalty}: ${input.previousRiskSignalCount} prior tracked token(s) had recorded security risk signals; this does not confirm a rug pull.`,
    );
  } else {
    reasons.push("No prior tracked token security risk signal is recorded.");
  }

  if (!input.creatorVerified) {
    reasons.push("Creator identity is unverified; developer history is not attributed to a wallet.");
  }
  if (!input.holderCoverageComplete) {
    reasons.push("Holder data is partial; concentration may be understated.");
  }
  if (!input.developer?.historyComplete) {
    reasons.push("Developer history is incomplete or limited to a recent transaction sample.");
  }

  const confidence: DeveloperRating["confidence"] =
    input.creatorVerified &&
    Boolean(input.developer?.historyComplete) &&
    input.holderCoverageComplete &&
    (input.developer?.launchCount ?? 0) >= 3
      ? "high"
      : input.creatorVerified &&
          Boolean(input.developer) &&
          (input.developer?.launchCount ?? 0) >= 1 &&
          input.holderCoverageComplete
        ? "medium"
        : "low";

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    confidence,
    reasons,
  };
}
