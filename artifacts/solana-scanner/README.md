# Solana Meme Scanner

Standalone Node.js worker and Telegram bot. It does not replace or modify the
existing API server or component preview app. Scanner data is stored in
PostgreSQL tables owned by this package.

## Monitored on-chain programs

- Pump.fun token creation
- PumpSwap pool creation
- Raydium CPMM
- Raydium AMM v4
- Raydium LaunchLab

The worker subscribes to confirmed Helius logs, decodes supported launch
instructions, stores observations, periodically refreshes tracked-token market
snapshots, and sends alerts to the configured Telegram chat. Automatic alerts
are suppressed unless the creator is verified from supported on-chain
instruction data and its observed SOL balance is strictly greater than 2 SOL.

Telegram commands: `/start`, `/status`, `/stats`, `/topdevs`,
`/dev WALLET_ADDRESS`, `/check TOKEN_ADDRESS`, and `/settings`.

## Setup and run

Configure these variables through Replit Secrets/environment settings:

| Variable | Required | Purpose |
| --- | --- | --- |
| `HELIUS_API_KEY` | Yes | Helius Solana mainnet JSON-RPC and WebSocket access |
| `BOT_TOKEN` | Yes | Telegram Bot API |
| `CHAT_ID` | Yes | The only Telegram chat allowed to issue commands and receive alerts |
| `DATABASE_URL` | Yes | Existing PostgreSQL connection |
| `MARKET_POLL_INTERVAL_MS` | No | Market polling interval; defaults to 60 seconds |
| `MAX_TRACKED_TOKENS_PER_POLL` | No | Tokens checked per poll; defaults to 50 |

Apply the additive scanner schema to the development database, then build and
start the worker:

```sh
pnpm --filter @workspace/solana-scanner run db:push
pnpm --filter @workspace/solana-scanner run build
pnpm --filter @workspace/solana-scanner run start
```

For local development, use:

```sh
pnpm --filter @workspace/solana-scanner run dev
```

The worker is a long-running process, not an HTTP server. It must be kept
running by a Replit workflow or another process supervisor.

For a private Telegram chat, open the bot and send `/start`. For a group, add
the bot to the group and configure that group's chat ID. The worker checks that
the configured chat is reachable before sending alerts; pending alerts wait
until Telegram recognizes the chat.

## Data and verification limits

- Helius must permit the RPC methods used here, including WebSocket
  `logsSubscribe` and DAS token-account enumeration. Request limits and DAS
  availability depend on the Helius plan. If complete DAS enumeration fails,
  the scanner falls back to the largest standard-RPC token accounts and marks
  top-10 holder coverage as incomplete.
- DexScreener supplies current market snapshots. Historical market-cap
  observations begin when this scanner first records them; the largest stored
  observation is not a verified all-time high. An external historical market
  data source would be needed for a complete pre-installation history.
- Holder enumeration is capped at 5,000 accounts per mint. Larger sets are
  marked incomplete rather than presented as a complete concentration result.
- Developer history and funding-source checks are bounded samples of recent
  Helius transaction history. They are not claims of complete wallet history.
- Recent startup recovery fetches up to 10 signatures per monitored program.
  Older history is retained only if it was already observed and stored.
- LP lock state is not verified by this release. An LP burn is reported only
  when the scanned on-chain history contains enough evidence to establish it.
  Verifying locks requires supported, protocol-specific locker account
  decoders.
- Developer ratings are transparent heuristics with confidence labels, not
  financial advice or guarantees. All-time success claims are limited to
  market-cap observations actually stored by this scanner.
- The bot only reports and links to token tools. It does not trade, hold
  private keys, or initiate transactions.
