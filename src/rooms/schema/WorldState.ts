import { schema, t, type SchemaType } from "@colyseus/schema";

// A treasure placed on one of a player's home slots, drawn on their plot for everyone.
export const PlotItem = schema(
  {
    name: t.string().default(""),
    rarity: t.string().default("Common"),
    glyph: t.string().default(""),
  },
  "PlotItem",
);
export type PlotItem = SchemaType<typeof PlotItem>;

// The live roster: pose/appearance other clients need to draw this player, their plot's
// contents, and what the leaderboards rank. Durable state lives in Mongo (src/db.ts).
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    x: t.float64().default(0),
    y: t.float64().default(0),
    z: t.float64().default(0),
    yaw: t.float64().default(0),
    speed01: t.float64().default(0), // 0..1 gait factor -- purely cosmetic
    grounded: t.boolean().default(true),
    bending: t.boolean().default(false),
    lifting: t.float64().default(-1), // 0..1 progress while heaving a Lift gate, -1 = not lifting
    training: t.string().default(""), // TRAINING_SPOTS key the player stands on, "" = none
    holding: t.boolean().default(false),
    // The player's Bloxity avatar (equipped hat/back + proportions) as an opaque JSON string,
    // stored and relayed as-is (length-capped, never parsed here).
    avatar: t.string().default(""),
    equippedAura: t.string().default("none"),
    equippedArm: t.string().default("dirt"),
    level: t.float64().default(1),
    rebirths: t.float64().default(0),
    // Item in hand (flattened; an empty heldName means hands empty).
    heldName: t.string().default(""),
    heldRarity: t.string().default(""),
    heldGlyph: t.string().default(""),
    // Index into the client's PLOTS, assigned by the server so no two players in a room share one.
    homePlot: t.float64().default(0),
    plotSlots: t.map(PlotItem), // home slot index (string) -> item
    baseUpgraded: t.boolean().default(false), // home upgraded to the two-storey build; other clients draw this plot accordingly
    cash: t.float64().default(0),
    strength: t.float64().default(0),
    // Total seconds connected (saved total for a signed-in player + this session), server-measured.
    playTime: t.float64().default(0),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
