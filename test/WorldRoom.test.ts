import assert from "assert";
import type { Collection } from "mongodb";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { sanitizeProgress, sanitizePlotSlots } from "../src/sanitize.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";

// Hand-rolled fake `players` collection implementing only the subset WorldRoom.ts calls:
// find().sort().limit().toArray(), updateOne() (upsert, $set/$inc), findOne().
function fakePlayersCollection(seed: PlayerDoc[] = []) {
  const docs = new Map<string, PlayerDoc>(seed.map((d) => [d._id, d]));
  const fake = {
    docs,
    async findOne(filter: { _id: string }) {
      return docs.get(filter._id) ?? null;
    },
    async updateOne(filter: { _id: string }, update: any, options: any) {
      const existing = docs.get(filter._id);
      if (!existing && !options?.upsert) return;
      const base = existing ?? ({ _id: filter._id, ...(update.$setOnInsert ?? {}) } as PlayerDoc);
      const next = { ...base, ...(update.$set ?? {}) } as any;
      for (const [k, v] of Object.entries(update.$inc ?? {})) next[k] = (next[k] ?? 0) + (v as number);
      docs.set(filter._id, next as PlayerDoc);
    },
    find(_filter: any) {
      let sortField: string | null = null;
      let limitN = Infinity;
      const cursor = {
        sort(spec: Record<string, number>) {
          sortField = Object.keys(spec)[0];
          return cursor;
        },
        limit(n: number) {
          limitN = n;
          return cursor;
        },
        async toArray() {
          let arr = Array.from(docs.values());
          if (sortField) {
            const field = sortField;
            arr = arr.slice().sort((a: any, b: any) => (b[field] ?? 0) - (a[field] ?? 0));
          }
          return arr.slice(0, limitN);
        },
      };
      return cursor;
    },
  };
  return fake as unknown as Collection<PlayerDoc> & { docs: Map<string, PlayerDoc> };
}

function baseDoc(overrides: Partial<PlayerDoc> = {}): PlayerDoc {
  return { _id: "test", cash: 0, version: 1, updatedAt: new Date(), ...overrides };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The `progress` / `noProgress` reply can land before a client-side handler is registered, so
// capture what the server sends on the server side.
function captureSends(room: any) {
  const sent: [string, any][] = [];
  const origLoad = room.loadProgress.bind(room);
  room.loadProgress = (c: any, ...rest: any[]) => {
    const origSend = c.send.bind(c);
    c.send = (type: string, msg: any) => {
      sent.push([type, msg]);
      origSend(type, msg);
    };
    return origLoad(c, ...rest);
  };
  return sent;
}

describe("sanitizeProgress", () => {
  it("rejects non-objects and bounds numbers", () => {
    assert.strictEqual(sanitizeProgress(null), null);
    assert.strictEqual(sanitizeProgress([1]), null);
    const out = sanitizeProgress({ cash: -5, strength: Infinity, level: 0, rebirths: 2.9, backpackLevel: 3 })!;
    assert.strictEqual(out.cash, 0);
    assert.strictEqual(out.strength, undefined);
    assert.strictEqual(out.level, 1);
    assert.strictEqual(out.rebirths, 2);
    assert.strictEqual(out.backpackLevel, 3);
  });

  it("keeps only known ids, valid items and valid slots", () => {
    const out = sanitizeProgress({
      ownedAuras: ["halo", "bogus", "halo"],
      equippedAura: "bogus",
      ownedArms: ["wood"],
      equippedArm: "wood",
      inventory: [
        { name: "Coal", rarity: "Common", value: 12 },
        { name: "X", rarity: "Nope", value: 1 },
        { name: "Y", rarity: "Rare" },
      ],
      heldItem: { name: "Gem", rarity: "Uncommon", glyph: "G" },
      plotSlots: { 0: { name: "Gem", rarity: "Uncommon", glyph: "G" }, 99: { name: "Gem", rarity: "Uncommon" }, a: {} },
      discovered: ["Coal", "Coal", 5],
    })!;
    assert.deepStrictEqual(out.ownedAuras, ["none", "halo"]);
    assert.strictEqual(out.equippedAura, undefined);
    assert.deepStrictEqual(out.ownedArms, ["dirt", "wood"]);
    assert.strictEqual(out.equippedArm, "wood");
    assert.deepStrictEqual(out.inventory, [{ name: "Coal", rarity: "Common", value: 12 }]);
    assert.deepStrictEqual(out.heldItem, { name: "Gem", rarity: "Uncommon", glyph: "G" });
    assert.deepStrictEqual(Object.keys(out.plotSlots!), ["0"]);
    assert.deepStrictEqual(out.discovered, ["Coal"]);
    assert.strictEqual(sanitizeProgress({ heldItem: null })!.heldItem, null);
    assert.deepStrictEqual(sanitizePlotSlots(undefined), {});
  });

  it("never lets the client set homePlot", () => {
    assert.strictEqual(sanitizeProgress({ homePlot: 3 })!.homePlot, undefined);
  });
});

describe("WorldRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());
  beforeEach(async () => {
    await colyseus.cleanup();
  });
  afterEach(() => __setPlayersForTest(null));

  it("relays pose to other players and clamps it", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c1 = await colyseus.connectTo(room, { username: "Boomer" });
    const c2 = await colyseus.connectTo(room);

    c1.send("move", { x: 1.5, y: 2, z: -3, yaw: 0.5, speed01: 7, grounded: false, lifting: 0.4, training: "bench", holding: true });
    await room.waitForNextPatch();
    const s = c2.state.players.get(c1.sessionId)!;
    assert.strictEqual(s.username, "Boomer");
    assert.strictEqual(s.x, 1.5);
    assert.strictEqual(s.z, -3);
    assert.strictEqual(s.speed01, 1);
    assert.strictEqual(s.grounded, false);
    assert.strictEqual(s.lifting, 0.4);
    assert.strictEqual(s.training, "bench");
    assert.strictEqual(s.holding, true);

    c1.send("move", { lifting: null, training: null, x: NaN });
    await room.waitForNextPatch();
    const s2 = c2.state.players.get(c1.sessionId)!;
    assert.strictEqual(s2.lifting, -1);
    assert.strictEqual(s2.training, "");
    assert.strictEqual(s2.x, 1.5); // NaN ignored
  });

  it("assigns every player a distinct plot and reuses plots beyond six", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const sent = captureSends(room);
    for (let i = 0; i < 6; i++) await colyseus.connectTo(room, { userId: `u${i}`, username: `P${i}` });
    await sleep(100);
    const plots = sent.filter(([t]) => t === "noProgress").map(([, m]) => m.homePlot);
    assert.strictEqual(plots.length, 6);
    assert.deepStrictEqual([...plots].sort(), [0, 1, 2, 3, 4, 5]);
    await colyseus.connectTo(room, { userId: "u7" }); // no player cap: the 7th shares a plot
    await sleep(60);
    assert.strictEqual(room.state.players.size, 7);
  });

  it("saves progress, keeps the plot and returns everything on the next join", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const sent = captureSends(room);
    const other = await colyseus.connectTo(room, { userId: "other", username: "Bob" }); // takes plot 0
    const c = await colyseus.connectTo(room, { userId: "u1", username: "Ann" });
    await sleep(60);
    assert.strictEqual(sent.find(([t]) => t === "noProgress" && t)![1].homePlot, 0);
    const annPlot = sent.filter(([t]) => t === "noProgress")[1][1].homePlot;
    assert.strictEqual(annPlot, 1);

    c.send("saveProgress", {
      cash: 1234,
      strength: 55,
      rebirths: 2,
      level: 4,
      inventory: [{ name: "Coal", rarity: "Common", value: 12 }],
      ownedAuras: ["none", "halo", "bogus"],
      equippedAura: "halo",
      plotSlots: { 2: { name: "Gem", rarity: "Uncommon", glyph: "G" } },
      discovered: ["Coal", "Gem"],
    });
    await sleep(80);
    const doc = fake.docs.get("u1")!;
    assert.strictEqual(doc.cash, 1234);
    assert.strictEqual(doc.username, "Ann");
    assert.strictEqual(doc.homePlot, 1);
    assert.deepStrictEqual(doc.ownedAuras, ["none", "halo"]);

    // Live roster shows the plot contents and appearance to the other client.
    await room.waitForNextPatch();
    const seen = other.state.players.get(c.sessionId)!;
    assert.strictEqual(seen.plotSlots.get("2")!.name, "Gem");
    assert.strictEqual(seen.equippedAura, "halo");
    assert.strictEqual(seen.cash, 1234);

    // Next join (fresh room): same account gets its plot and data back.
    const room2 = await colyseus.createRoom<WorldState>("world", {});
    const sent2 = captureSends(room2);
    await colyseus.connectTo(room2, { userId: "u1", username: "Ann" });
    await sleep(100);
    const progress = sent2.find(([t]) => t === "progress")![1];
    assert.strictEqual(progress.cash, 1234);
    assert.strictEqual(progress.homePlot, 1);
    assert.deepStrictEqual(progress.inventory, [{ name: "Coal", rarity: "Common", value: 12 }]);
    assert.deepStrictEqual(progress.plotSlots, { 2: { name: "Gem", rarity: "Uncommon", glyph: "G" } });
    assert.deepStrictEqual(progress.discovered, ["Coal", "Gem"]);
  });

  it("evicts a second connection of the same account", async () => {
    __setPlayersForTest(fakePlayersCollection([baseDoc({ _id: "u1", cash: 5, homePlot: 3, username: "Ann" })]));
    const room = await colyseus.createRoom<WorldState>("world", {});
    const sent = captureSends(room);
    await colyseus.connectTo(room, { userId: "u1", username: "Ann" });
    await sleep(60);
    await colyseus.connectTo(room, { userId: "u1", username: "Ann" });
    await sleep(80);
    assert.strictEqual(room.state.players.size, 1);
    const progresses = sent.filter(([t]) => t === "progress");
    assert.strictEqual(progresses[1][1].homePlot, 3); // freed by the evicted session
  });

  it("builds merged leaderboards (cash, strength, playTime)", async () => {
    __setPlayersForTest(
      fakePlayersCollection([
        baseDoc({ _id: "a", username: "Rich", cash: 900, strength: 1, playTime: 10 }),
        baseDoc({ _id: "b", username: "Strong", cash: 1, strength: 800, playTime: 20 }),
      ]),
    );
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "c", username: "Me" });
    const boards: any[] = [];
    c.onMessage("leaderboard", (b: any) => boards.push(b));
    c.send("saveProgress", { cash: 500, strength: 5 });
    await sleep(80);
    await (room as any).refreshLeaderboard();
    await sleep(50);
    const b = boards[boards.length - 1];
    assert.deepStrictEqual(b.cash.map((r: any) => r.name), ["Rich", "Me", "Strong"]);
    assert.deepStrictEqual(b.strength.map((r: any) => r.name), ["Strong", "Me", "Rich"]);
    assert.strictEqual(b.playTime[0].name, "Strong");
  });

  it("reports serverError when the saved doc cannot be read", async () => {
    const fake: any = fakePlayersCollection();
    fake.findOne = async () => {
      throw new Error("boom");
    };
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const errors: string[] = [];
    const orig = (room as any).loadProgress.bind(room);
    (room as any).loadProgress = (c: any, ...rest: any[]) => {
      const s = c.send.bind(c);
      c.send = (t: string, m: any) => (errors.push(t), s(t, m));
      return orig(c, ...rest);
    };
    await colyseus.connectTo(room, { userId: "u1" });
    await sleep(60);
    assert.ok(errors.includes("serverError"));
  });
});
