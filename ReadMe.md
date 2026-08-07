# Aruble Faucet Bot

Automated faucet claim bot for [aruble.net](https://aruble.net) built with Node.js and Playwright.

It logs into the site with your account, automatically solves the site's custom
`SlideCaptcha` challenges, reaches the Faucet page, and claims the faucet reward
in a loop with a random 6-7 minute wait between claims.

## Features

- **Login** with email/password, reusing a saved session (`session.json`) so later
  rounds skip the login screen entirely.
- **Automatic captcha solving** for every challenge type the site uses:
  - Press-and-hold gate (`scGateWrap`)
  - Icon order (`scOrderWrap`) - click emojis in the shown sequence
  - Least repeat (`scLeastWrap`) - click the rarest emoji
  - Drag dot (`scDotWrap`) - drag the dot into the circle
  - Slide (`scSlideWrap`) - drag the handle to the glowing zone
- **Faucet claiming** with interstitial-ad handling and claim/cooldown detection.
- **Session persistence** - the login cookie storage is saved to `session.json`
  and restored on the next run.
- **Loop mode** - claims continuously with a random 6-7 minute delay between rounds.
- **Auto re-login on VPN/proxy block** - if `/faucet/claim` responds with
  `VPN or proxy detected`, the bot re-logs in (fresh session) and retries the
  claim up to 3 times before giving up that round.
- **Bot-check solving** - the site's `/faucet` route can redirect to its
  `/bot-check` security page (math question + SlideCaptcha + integrity checks).
  The bot solves it automatically and continues to the faucet.
- **Proxy support** - required if the network IP is flagged as VPN/datacenter,
  because the claim endpoint rejects those IPs.

## Requirements

- Node.js 18+
- Playwright with Chromium installed:

```bash
npm install
npx playwright install --with-deps chromium
```

## Usage

Run locally (credentials are read from the environment):

```bash
export ARUBLE_EMAIL=you@example.com
export ARUBLE_PASSWORD=yourpassword
node login.js
```

### Configuration (environment variables)

| Variable           | Default      | Description                                                            |
| ------------------ | ------------ | ---------------------------------------------------------------------- |
| `ARUBLE_EMAIL`     | **required** | Account email.                                                         |
| `ARUBLE_PASSWORD`  | **required** | Account password.                                                      |
| `PROXY_URL`        | none         | Proxy, e.g. `http://user:pass@host:port`. Needed if your IP is blocked by the site's VPN check. |
| `CLAIM_WAIT_MIN`   | `360`        | Min wait (seconds) between claims (default 6 min).                     |
| `CLAIM_WAIT_MAX`   | `420`        | Max wait (seconds) between claims (default 7 min).                     |
| `MAX_ROUNDS`       | unlimited    | Stop after N claim rounds (useful for testing).                        |

Examples:

```bash
# limited test run with a short wait
ARUBLE_EMAIL=you@example.com ARUBLE_PASSWORD=yourpassword \
MAX_ROUNDS=2 CLAIM_WAIT_MIN=10 CLAIM_WAIT_MAX=15 node login.js

# with a residential proxy
ARUBLE_EMAIL=you@example.com ARUBLE_PASSWORD=yourpassword \
PROXY_URL=http://user:pass@host:port node login.js
```

> Note: The `/faucet/claim` endpoint rejects datacenter/VPN IP addresses with
> `VPN or proxy detected. Please disable it and try again.` Use a residential
> proxy (`PROXY_URL`) or run from a residential network to actually get claims
> approved.

## GitHub Actions

A workflow (`.github/workflows/main.yml`) is included that runs the bot on a
GitHub runner.

1. Push this repository to GitHub.
2. In the repo settings add the following **Actions secrets** (used to avoid
   committing credentials into the repository):
   - `ARUBLE_EMAIL` - the account email
   - `ARUBLE_PASSWORD` - the account password
   - `PROXY_URL` - (recommended) a residential proxy, since GitHub runners use
     datacenter IPs that the claim endpoint will reject
3. Run the workflow manually from the **Actions** tab, or it will run on the
   configured schedule.

> Security note: credentials are **not** stored in the repository. They must be
> supplied through the `ARUBLE_EMAIL` / `ARUBLE_PASSWORD` environment variables
> (locally) or through the matching Actions secrets.

## Project layout

```
login.js              - the bot (config, captcha solver, claim loop)
ReadMe.md             - this file
.github/workflows/main.yml - GitHub Actions workflow
session.json          - saved login session (created at runtime, not committed)
```
