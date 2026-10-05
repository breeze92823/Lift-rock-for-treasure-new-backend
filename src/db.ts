import { MongoClient, type Collection } from "mongodb";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

export interface ItemDoc {
  name: string;
  rarity: string;
  glyph?: string;
}

export interface LootDoc {
  name: string;
  rarity: string;
  value: number;
}

export interface PlayerDoc {
  _id: string; // Bloxity user id, or the client's per-browser `guest-...` id -- see WorldRoom.ts
  // Display name as of the last save, so an offline leaderboard row still has something to show.
  username?: string;
  cash: number;
  gems?: number;
  rebirths?: number;
  strength?: number;
  level?: number;
  xp?: number;
  xpNeeded?: number;
  backpackLevel?: number;
  speedLevel?: number;
  inventory?: LootDoc[];
  ownedAuras?: string[];
  equippedAura?: string;
  ownedArms?: string[];
  equippedArm?: string;
  heldItem?: ItemDoc | null;
  // Index of the player's plot (client data/world.js PLOTS), kept so they get the same one back.
  homePlot?: number;
  // Home ground-floor slot index (as a string key) -> placed item.
  plotSlots?: Record<string, ItemDoc>;
  // Home upgraded to the two-storey build (24 slots).
  baseUpgraded?: boolean;
  // Item names collected at least once (the Index window).
  discovered?: string[];
  // Total seconds connected, measured by the SERVER clock (WorldRoom.ts flushPlaytime) --
  // never client-reported.
  playTime?: number;
  // Server clock: last moment this player was connected (heartbeat + disconnect). The gap to the
  // next join is the time spent offline.
  lastSeenAt?: Date;
  // Unclaimed offline time in seconds; paid out (and reset to 0) by the `claimOffline` message.
  offlineSeconds?: number;
  // Onboarding progress (constants.ts TUTORIAL_*): 0..TUTORIAL_DONE_STEP. Only ever moves forward
  // (WorldRoom.saveProgress uses $max). Docs that predate the field count as finished -- see
  // resolveTutorialStep in sanitize.ts.
  tutorialStep?: number;
  // Name of the Uncommon item picked on the tutorial's loot step, so a resumed tutorial can still
  // point at it.
  tutorialItem?: string | null;
  version: number;
  updatedAt: Date;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");

    // refreshLeaderboard() sorts by each of these; createIndex is idempotent. A failure only
    // means those queries stay unindexed, never blocks startup.
    try {
      await players.createIndex({ cash: -1 });
      await players.createIndex({ strength: -1 });
      await players.createIndex({ playTime: -1 });
    } catch (err) {
      console.warn("[db] failed to create leaderboard indexes:", err);
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the leaderboard/save logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
