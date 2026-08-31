# Moment


Devpost: https://devpost.com/software/moment-c4ns1v


- `apps/api` (Fastify + socket.io)
- `apps/mobile` (Expo SDK 54)

## Install
From the project root:

```bash
pnpm --dir apps/api install --lockfile=false
pnpm --dir apps/mobile install --lockfile=false
```

## Run
Terminal A:

```bash
pnpm run dev
```

Optional API tuning:

```bash
AMM_VIRTUAL_LIQUIDITY=120 pnpm --dir apps/api dev
```

## iPhone (Expo Go)
1. Install Expo Go (SDK 54).
2. Keep iPhone and Mac on the same Wi-Fi.
3. Run `pnpm --dir apps/mobile dev` and scan the QR.

If phone cannot reach API:

```bash
EXPO_PUBLIC_API_BASE_URL=http://<YOUR_MAC_LAN_IP>:4000 pnpm --dir apps/mobile dev
```

## Current mobile tabs
- Sports
- Stocks
- Profile
- Dev

## API endpoints in use
- `POST /auth/register`
- `POST /auth/login`
- `GET /markets/live`
- `GET /markets/:marketId`
- `POST /quotes`
- `POST /picks`
- `GET /picks/:userId`
- `GET /users/:userId`
- `GET /users/:userId/wallet`
- `POST /users/:userId/funds/add`
- `POST /users/:userId/funds/withdraw`
- `GET /events/stream-status`
- `POST /dev/simulate/starter-event`
- `POST /dev/simulate/close-market`
- `POST /dev/simulate/settle-market`
- `POST /dev/simulate/reset`
- `POST /starter/events`
- `POST /closer/resolutions`

## Market lifecycle behavior
- No seeded startup markets.
- No automatic starter interval.
- No automatic timeout suspension.
- Markets are created only via API calls (for example `POST /dev/simulate/starter-event` or `POST /starter/events`).
- Markets are closed/settled only from API-triggered actions.

## WebSocket events
- `market.opened`
- `market.updated`
- `market.closed`
- `market.settled`
- `market.suspended`
- `bet.accepted`
- `bet.updated`
- `bet.rejected`
- `wallet.updated`
- `connection.state`
