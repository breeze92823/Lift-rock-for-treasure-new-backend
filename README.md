# Lift Rock for Treasure — server

Colyseus server for the `Lift-rock-for-treasure` client: progress saving, per-player plots,
multiplayer presence and leaderboards. Modelled on the Tnt-Mining backend (same stack, same
Bloxity Legion deploy flow).

```
npm install
npm start        # tsx watch, ws://localhost:2567 (playground + /monitor in dev)
npm test
npm run build    # -> build/, run with `node build/index.js`
```

Config (all optional locally, see `.env.example`): `MONGODB_URI` (without it nothing persists),
`CLIENT_ORIGIN`, `PORT`.

## Protocol (client `src/systems/net.js`)

Room: `world` (`joinOrCreate("world", { userId, username, avatar })`), no player cap (Colyseus default).
Each player gets one of the 6 home plots; beyond 6 players, plots are shared.

| Client → server | Purpose |
| --- | --- |
| `move` | `x y z yaw speed01 grounded bending lifting training holding` (~15 Hz) |
| `appearance` | `equippedAura equippedArm level rebirths heldItem`, sent immediately |
| `saveProgress` | the persisted store keys, debounced (sanitized, upserted in Mongo) |
| `setAvatar` / `identify` | avatar JSON / re-state identity after sign-in or sign-out |

| Server → client | Purpose |
| --- | --- |
| `progress` | saved document + the assigned `homePlot` (hydrates the store) |
| `noProgress` | `{ homePlot }` for a new account / no Mongo — start from defaults |
| `serverError` | saved document could not be read; client shows its retry screen |
| `leaderboard` | `{ cash, strength, playTime }`, rows `{ id, name, value }`, top 10 |

Room state (`WorldState.players`) syncs pose, appearance, held item, `homePlot` and `plotSlots`
to the other clients. Playtime is measured by the server clock, never client-reported.

The game is client-authoritative: the server only enforces shape and bounds on saves
(`src/sanitize.ts`). Allow-lists in `src/constants.ts` (auras, arms, rarities, plot counts)
must be kept in step with the client's `data/` files by hand.

Deploys via `.github/workflows/deploy.yml` (`dev` → dev channel, `main` → prod).
