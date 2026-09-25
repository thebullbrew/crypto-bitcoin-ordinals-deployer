# Contributing

Thanks for your interest in improving the Bitcoin Ordinals Deployer.

## Workflow

1. Fork the repo and create a branch from `main`.
2. Test every change against **testnet** before opening a PR — never test with mainnet funds.
3. Keep scripts non-custodial: this tool must never sign transactions or handle raw private keys beyond in-memory WIF parsing.
4. Update the README if you change CLI behavior or env variables.

## Standards

- TypeScript, strict mode, no `any` without justification.
- No secrets in code, logs, or committed files. Ever.
- Fee estimates stay conservative — underestimation burns user funds.
- One concern per module: `config.ts`, `fees.ts`, `inscribe.ts` stay focused.

## Security

If you find a vulnerability (especially around key handling or PSBT construction), please open an issue rather than a PR so it can be handled carefully.
