---
name: Helius RPC compatibility
description: Transaction-version support and DAS request/pagination behavior observed against Helius mainnet
---

Helius mainnet `getTransaction` requests must allow transaction version 1; a version-0 ceiling produced `-32015` errors during live backfill.

**Why:** The worker's initial recent-signature recovery repeatedly failed until the request maximum matched the version Helius returned.

**How to apply:** Preserve version-1 support when changing the Helius transaction request, and verify by fetching a recent confirmed transaction.

Helius DAS `getAsset` and `getTokenAccounts` use an object for JSON-RPC `params`. For token-account pagination, follow the returned cursor; `total` can equal the current page limit while more pages remain.

**Why:** A live Helius request returned `total=limit` and a cursor for USDC, which would have incorrectly marked holder enumeration complete if `total` were treated as a global count.

**How to apply:** Treat a missing next cursor as the completeness signal, and report coverage as partial when the configured account cap is reached.
