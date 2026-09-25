# Bitcoin Ordinals Deployer

![banner](assets/banner.jpg)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bitcoin](https://img.shields.io/badge/Bitcoin-Testnet%20%7C%20Mainnet-F7931A.svg)](https://bitcoin.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg)](https://www.typescriptlang.org)

A professional, script-driven toolkit for creating Bitcoin Ordinals inscriptions — fee estimation, taproot commit/reveal transaction building, and unsigned PSBTs you sign in your own wallet. Built on [bitcoinjs-lib](https://github.com/bitcoinjs/bitcoinjs-lib) v6.

## How Ordinals inscriptions work (commit + reveal)

An inscription lives inside a **tapscript envelope** in the *witness* of a transaction:

```
<x-only pubkey> OP_CHECKSIG OP_0 OP_IF "ord" OP_1 <content-type> OP_0 <content…> OP_ENDIF
```

It takes **two transactions** because the content must be *committed to* before it is *revealed* — otherwise anyone watching the mempool could front-run your inscription:

1. **Commit** — you fund a taproot (P2TR) output whose script tree contains the inscription script. Nothing is revealed yet; the content stays private.
2. **Reveal** — you spend that output via the script path. The witness now contains the envelope, and the inscription becomes bound to the first sat of the input (ordinal theory). The inscribed sat goes to your destination address.

This tool builds **both transactions as unsigned PSBTs**. It never signs and never broadcasts — you review, sign, and broadcast in a wallet you trust.

## Features

- **Taproot commit/reveal builder** — correct single-leaf script-path construction with control blocks
- **Fee estimation** — vbyte-accurate commit + reveal estimates at your configured sat/vB rate
- **Batch assets** — one inscription per file in `assets/` (images, JSON metadata, text, HTML)
- **Unsigned PSBTs** — sign externally (Sparrow, Electrum); the tool never touches signing
- **Testnet-first workflow** — defaults to testnet; mainnet is an explicit opt-in
- **CI** — GitHub Actions checks TypeScript compilation on every push

## Prerequisites

- Node.js 18+
- An **ord-compatible wallet** for signing and receiving: [Sparrow](https://sparrowwallet.com) (recommended for PSBTs), Xverse, or UniSat
- A fresh **dedicated inscription key** (WIF) — generate one in Sparrow; never reuse an exchange key
- Testnet BTC from a [faucet](https://coinfaucet.eu/en/btc-testnet/) for practice
- `tiny-secp256k1` is installed alongside `bitcoinjs-lib` — v6 requires an injected ECC library for all taproot operations (`initEccLib`)

## Quickstart

```bash
# 1. Install
npm install

# 2. Configure (testnet first!)
cp .env.example .env
# Edit .env: BITCOIN_NETWORK=testnet, WALLET_WIF, FUNDING_ADDRESS

# 3. Drop files to inscribe into assets/
#    (example-inscription.json is included as a template)

# 4. Phase 1 — build the commit plan + unsigned commit PSBTs
npm run inscribe
```

Then, for each asset:

```bash
# 5. Sign the commit PSBT in Sparrow (File > Open Transaction > load the .psbt),
#    broadcast it, and wait for at least 1 confirmation.

# 6. Record the commit txid in out/plan.json (commitTxid field of the item)

# 7. Phase 2 — build the unsigned reveal PSBT
npm run inscribe:reveal -- --file example-inscription

# 8. Sign the reveal PSBT with the WALLET_WIF key
#    (import it into Sparrow as a single-key wallet), broadcast it.

# 9. Your inscription id is <reveal-txid>i0
#    Track it on https://ordinals.com or https://mempool.space
```

> ⚠️ **Always practice the full loop on testnet first.** Inscription fees are non-refundable — a mispriced reveal burns sats.

## Project structure

```
├── src/
│   ├── config.ts   # Network, fee rate, WIF handling, env config
│   ├── fees.ts     # vbyte-accurate fee estimation helpers
│   ├── inscribe.ts # Commit/reveal builder (unsigned PSBTs + plan.json)
│   └── ecc.d.ts    # Ambient types for tiny-secp256k1
├── assets/
│   └── example-inscription.json  # Template metadata inscription
├── out/            # Generated: plan.json + unsigned .psbt files (gitignored)
├── .env.example
└── .github/workflows/ci.yml
```

## Configuration

| Variable | Description |
|---|---|
| `BITCOIN_NETWORK` | `testnet` (default) or `mainnet` |
| `ORD_API_URL` | Esplora-compatible API (defaults to mempool.space per network) |
| `FEE_RATE_SAT_VB` | Fee rate in sat/vB for commit + reveal |
| `WALLET_WIF` | WIF of the dedicated inscription key (authorizes the reveal) |
| `FUNDING_ADDRESS` | Ord-compatible address whose UTXOs fund the commit |
| `INSCRIPTION_DESTINATION_ADDRESS` | Where inscribed sats go (defaults to funding address) |
| `ASSETS_DIR` | Folder of files to inscribe (default: `assets`) |
| `COMMIT_TXID` | Legacy single-value override; per-item txids live in `out/plan.json` |

Content types are mapped from file extension: `.png` → `image/png`, `.json` → `application/json`, `.txt`, `.html`, `.svg`, `.webp`, `.gif`, `.mp4`, and more (see `CONTENT_TYPES` in `src/inscribe.ts`). Unknown extensions are skipped with a warning.

## Fee model

- **Commit tx**: funding inputs (P2WPKH ≈ 68 vB each) + P2TR output (43 vB) + change output.
- **Commit output value** = 546 sats (dust for the inscription) + estimated reveal fee.
- **Reveal tx**: one script-path input (scales with inscription size) + one P2TR output.
- Estimates are conservative upper bounds. If fees spike between commit and reveal, the tool warns you when the locked commit value no longer covers the reveal — use CPFP or wait for lower fees.

## Security

- **Never commit `.env`** — it holds your inscription WIF. Use a dedicated key per project.
- This tool only emits **unsigned** PSBTs. Always inspect the PSBT in your wallet before signing: check outputs, amounts, and the fee.
- Practice the entire commit → confirm → reveal loop on **testnet** before mainnet.
- The reveal must be signed by the `WALLET_WIF` key — keep it offline except when signing.

## Roadmap

- [ ] Multi-leaf batch reveals (one commit, many inscriptions)
- [ ] Parent/child provenance wiring
- [ ] RBF fee-bump helper for stuck commits
- [ ] Direct mempool.space broadcast option (opt-in)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
