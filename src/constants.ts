// Leaderboards: how often WorldRoom re-queries Mongo for the all-time top players per stat,
// how many rows it fetches per stat before merging with the live roster, and how many it sends.
export const LEADERBOARD_REFRESH_MS = 15_000;
export const LEADERBOARD_QUERY_LIMIT = 20;
export const LEADERBOARD_ROWS = 10;

// Playtime: how often each connected player's elapsed time is added to their total.
export const PLAYTIME_FLUSH_MS = 30_000;

// Offline earnings: time away (measured by the SERVER clock) pays out per hour, pro-rated by the
// second. Shorter absences than the minimum pay nothing; the unclaimed total stops growing at the cap.
export const OFFLINE_CASH_PER_HOUR = 500;
export const OFFLINE_STRENGTH_PER_HOUR = 100;
export const OFFLINE_MIN_SECONDS = 60;
export const OFFLINE_MAX_SECONDS = 12 * 3600;

// Client data/world.js: PLOTS has 3 rows x 2 sides = 6 player plots, each holding HOME_SLOTS
// (2 rows x PLOT_SLOT.count 6) = 12 ground-floor treasure slots.
// A room seats one player per plot.
export const PLOT_COUNT = 6;
export const PLOT_SLOT_COUNT = 24; // 12 ground + 12 upper-deck (after the Base Upgrade)
export const ROOM_MAX_CLIENTS = PLOT_COUNT;

// Client data/world.js plotSpawn(i): PLOTS alternate side -1/+1 over PLOT_ROWS_Z, spawn at
// x = side * (PLOT.inner + 2.5), y = PLOT.h. Used only to place a player before their first `move`.
const PLOT_ROWS_Z = [-21, 3, 27];
export const plotSpawn = (i: number) => ({
  x: (i % 2 === 0 ? -1 : 1) * 9.5,
  y: 0.3,
  z: PLOT_ROWS_Z[Math.floor(i / 2)] ?? 0,
});

// Upper bounds for saved values, so a forged payload cannot push a bogus number onto the
// leaderboards. Generous ceilings, not game rules.
export const CASH_MAX = 1_000_000_000_000_000_000; // cash, gems
export const STRENGTH_MAX = 1_000_000_000_000_000_000;
export const REBIRTH_MAX = 1_000_000;
export const LEVEL_MAX = 1_000_000;
export const UPGRADE_LEVEL_MAX = 1_000; // backpackLevel, speedLevel (client data/upgrades.js max is 8 / 17)
export const INVENTORY_MAX = 200; // carried loot (the backpack tops out far below this)
export const DISCOVERED_MAX = 1_000; // client data/loot.js index entries
export const ITEM_VALUE_MAX = 1_000_000_000_000;
export const TEXT_MAX = 64; // item names / glyphs

// Client data/loot.js RARITIES.
export const RARITIES: readonly string[] = [
  "Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic", "Secret", "Celestial", "Divine",
];

// Ids of the client's data/auras.js and data/arms.js. Allow-listed so a forged payload cannot
// invent one; keep in step by hand when auras or arms are added.
export const AURA_IDS: readonly string[] = [
  "none", "radioactive", "halo", "firebeam", "redking", "darkmatter", "fractal", "rainbow", "galaxy",
];
export const ARM_IDS: readonly string[] = [
  "dirt", "wood", "cobblestone", "brick", "gold", "glowstone", "obsidian", "glass", "diamond",
  "lava", "emerald", "glitch", "bedrock", "nuclear", "disco",
];

// Training spot keys (client data/world.js TRAINING_SPOTS) are relayed as opaque short strings.
export const TRAINING_KEY_MAX = 32;

// The client's per-browser fallback id for players who are not signed in to Bloxity
// (systems/net.js localGuestId). Guests are never persisted.
export const GUEST_ID_PREFIX = "guest-";
