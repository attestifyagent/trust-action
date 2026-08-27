# Attestify Trust — GitHub Action

Register your agent once. Every CI run signs evidence that it happened and posts the receipt as
a PR check — free, no wallet, no card. Anyone can independently verify the receipt at
[attestifyos.com/trust/verify](https://attestifyos.com/trust/verify), no account required.

[![Attestify Trust](https://img.shields.io/endpoint?url=https://attestifyos.com/api/trust/v1/agents/YOUR_AGENT_ID/badge.json)](https://attestifyos.com/trust/verify)

## What this attests to

Each run produces one `ci-run/v1` evidence event — a claim that *your registered agent's CI run
happened, on this commit, in this repo, at this time*. It's deliberately narrow: it does **not**
assert anything about what your workflow's other steps actually did (tests passing, a deploy
succeeding, etc.) — sign your own evidence for that with the SDK directly if you want it captured
too. This Action just answers "did a real, identified agent actually run here" honestly.

## One-time setup

Key generation and agent registration happen **locally**, once — never inside CI. A CI job's
default token can't write repo secrets, and even masked log output isn't a safe place to hold a
private key.

```bash
npx attestify-os trust-init --name "My CI Bot" --repo your-org/your-repo
```

(Needs `ATTESTIFY_API_KEY` set — get one free at [attestifyos.com/plans](https://attestifyos.com/plans).
No `--repo`? It just prints the three values instead of pushing them with `gh secret set`.)

This registers an agent, generates its Ed25519 signing key on your machine, and adds three repo
secrets: `TRUST_API_KEY`, `TRUST_AGENT_ID`, `TRUST_PRIVATE_KEY`. The Agent ID and key persist
across every future run — a fresh identity per run would both break your verified-active streak
and pollute Attestify's public census with noise instead of a real number.

## Usage

```yaml
name: CI
on: [pull_request]

permissions:
  checks: write   # needed to post the PR check

jobs:
  trust:
    runs-on: ubuntu-latest
    steps:
      - uses: attestifyagent/trust-action@v1
        with:
          api-key: ${{ secrets.TRUST_API_KEY }}
          agent-id: ${{ secrets.TRUST_AGENT_ID }}
          private-key: ${{ secrets.TRUST_PRIVATE_KEY }}
```

### Inputs

| Input          | Required | Default                     |
|----------------|----------|------------------------------|
| `api-key`      | yes      | —                             |
| `agent-id`     | yes      | —                             |
| `private-key`  | yes      | —                             |
| `base-url`     | no       | `https://attestifyos.com`     |
| `github-token` | no       | `${{ github.token }}`         |
| `post-check`   | no       | `true`                        |

### Outputs

| Output            | Description                                  |
|--------------------|-----------------------------------------------|
| `receipt-id`       | The issued receipt ID (`rcpt_...`)             |
| `receipt-url`      | Public, no-auth link to verify the receipt     |
| `assurance-level`  | The receipt's assurance level (e.g. `L3`)      |

## Badge

Add this to your README, swapping in your own agent ID:

```md
[![Attestify Trust](https://img.shields.io/endpoint?url=https://attestifyos.com/api/trust/v1/agents/YOUR_AGENT_ID/badge.json)](https://attestifyos.com/trust/verify)
```

Shows **verified-active** (green) if the agent has signed evidence in the trailing 30 days,
**registered** (blue) otherwise.

## Why this exists

Part of [Attestify Trust](https://attestifyos.com/trust) — proof of what an agent did, for
agents that never touch a wallet. Full docs: [attestifyos.com/docs#trust](https://attestifyos.com/docs#trust).

## License

MIT
