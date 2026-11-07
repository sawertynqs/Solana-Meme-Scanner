import type { TokenAnalysis } from "../analysis/token.js";
import type { DeveloperSummary } from "../analysis/wallet.js";

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sol(value: number | null | undefined): string {
  return value === null || value === undefined ? "Unknown" : `${value.toFixed(3)} SOL`;
}

function usd(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "Unavailable"
    : `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function shorten(address: string | null): string {
  if (!address) return "Unverified";
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

export function formatTokenReport(analysis: TokenAnalysis): string {
  const developer = analysis.developer;
  const name = analysis.name || "Unknown token";
  const symbol = analysis.symbol ? ` (${analysis.symbol})` : "";
  const topHolderText =
    analysis.top10HolderPct === null
      ? analysis.topTokenAccountPct === null
        ? "Unavailable"
        : `At least ${analysis.topTokenAccountPct.toFixed(1)}% in the 10 largest token accounts; wallet-level holder concentration is unavailable`
      : `${analysis.top10HolderPct.toFixed(1)}%${analysis.top10HolderCoverageComplete ? "" : " (partial sample)"}`;
  const peak =
    developer?.verifiedPeakMarketCapUsd === null || developer?.verifiedPeakMarketCapUsd === undefined
      ? "No verified peak recorded"
      : `${usd(developer.verifiedPeakMarketCapUsd)} observed since this scanner began tracking`;
  const developerLaunches = developer
    ? `${developer.launchCount} verified launch(es); ${developer.verifiedSuccessfulLaunches} previously observed at ≥$100,000`
    : "Not available; creator identity was not verified";
  const extensions =
    analysis.token2022Extensions.length > 0
      ? analysis.token2022Extensions.map(html).join(", ")
      : "None reported";
  const flags =
    analysis.riskFlags.length > 0
      ? analysis.riskFlags.map((flag) => `• ${html(flag)}`).join("\n")
      : "No elevated indicators from the checks that completed.";
  const ratingReasons = analysis.rating.reasons.map((reason) => `• ${html(reason)}`).join("\n");
  const liquidityDrop =
    analysis.liquidityDropPct === null
      ? "No recent comparison available"
      : `${analysis.liquidityDropPct.toFixed(1)}% observed drop from a stored sample`;

  return [
    `<b>${html(name)}${symbol}</b>`,
    `Mint: <code>${html(analysis.mint)}</code>`,
    `Detected through: ${html(analysis.launchProgram)}`,
    `Creator: ${analysis.creatorWallet ? `<code>${html(analysis.creatorWallet)}</code>` : "Unverified"}`,
    `Creator evidence: ${html(analysis.creatorBasis)}`,
    `Developer SOL balance: ${sol(developer?.solBalance)}`,
    `Developer launch history: ${html(developerLaunches)}`,
    `Highest observed market cap: ${html(peak)}`,
    `Current market cap: ${usd(analysis.market?.marketCapUsd)}`,
    `Current liquidity: ${usd(analysis.market?.liquidityUsd)}`,
    `Liquidity movement: ${html(liquidityDrop)}`,
    "",
    "<b>Security checks</b>",
    `Mint authority: ${analysis.mintAuthority ? `<code>${html(analysis.mintAuthority)}</code>` : "Revoked or could not be verified"}`,
    `Freeze authority: ${analysis.freezeAuthority ? `<code>${html(analysis.freezeAuthority)}</code>` : "Revoked or could not be verified"}`,
    `Token-2022 extensions: ${extensions}`,
    `LP burn: ${html(analysis.lpStatus.status)} — ${html(analysis.lpStatus.evidence)}`,
    `LP lock: ${html(analysis.lpStatus.lockStatus)} — no lock is claimed without on-chain proof`,
    `Top 10 holder concentration: ${html(topHolderText)}`,
    `Creator allocation: ${analysis.creatorAllocationPct === null ? "Unavailable" : `${analysis.creatorAllocationPct.toFixed(1)}%`}`,
    `Risk indicators:\n${flags}`,
    "",
    `<b>Developer rating: ${analysis.rating.score}/100 (${analysis.rating.confidence} confidence)</b>`,
    ratingReasons,
    "",
    "Historical market-cap data is limited to observations collected by this scanner; it is not an all-time-high feed.",
    "Manual review only. No trading or wallet-signing actions are performed.",
  ].join("\n");
}

export function formatDeveloperReport(
  developer: DeveloperSummary,
  rating: number | null,
  confidence: string | null,
  reasons: string[],
): string {
  const firstObserved = developer.firstObservedAt
    ? `${developer.firstObservedAt.toISOString()} (oldest activity in sampled history; not necessarily account creation)`
    : "Unknown";
  const successful =
    developer.verifiedSuccessfulLaunches > 0
      ? `${developer.verifiedSuccessfulLaunches} launch(es) observed at ≥$100,000`
      : "None verified in stored observations";
  const peak =
    developer.verifiedPeakMarketCapUsd === null
      ? "No verified peak recorded"
      : usd(developer.verifiedPeakMarketCapUsd);
  return [
    `<b>Developer wallet</b>`,
    `<code>${html(developer.wallet)}</code>`,
    `SOL balance: ${sol(developer.solBalance)}`,
    `First observed activity: ${html(firstObserved)}`,
    `Transactions analyzed: ${developer.observedTransactions}${developer.historyComplete ? " (sample reached available history)" : " (bounded recent sample)"}`,
    `Verified token launches: ${developer.launchCount}`,
    `Previous launches observed at ≥$100,000: ${html(successful)}`,
    `Highest observed market cap: ${html(peak)} (scanner observations only)`,
    `Direct funding source in sampled history: ${developer.fundingSource ? `<code>${html(developer.fundingSource)}</code>` : "Not verified"}`,
    `Directly related wallet(s): ${developer.relatedWallets.length ? developer.relatedWallets.map((wallet) => `<code>${html(wallet)}</code>`).join(", ") : "None verified"}`,
    `Latest rating: ${rating === null ? "Not rated for a specific token" : `${rating}/100 (${html(confidence ?? "unknown")} confidence)`}`,
    reasons.length ? `Rating reasons:\n${reasons.map((reason) => `• ${html(reason)}`).join("\n")}` : "",
    developer.suspiciousFlags.length
      ? `Data notes:\n${developer.suspiciousFlags.map((flag) => `• ${html(flag)}`).join("\n")}`
      : "",
    "Funding relationships are reported only when a direct on-chain SOL transfer was parsed.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function shortAddress(address: string): string {
  return shorten(address);
}

