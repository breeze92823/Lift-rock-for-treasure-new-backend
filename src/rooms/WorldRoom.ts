import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState, PlotItem } from "./schema/WorldState.js";
import {
  LEADERBOARD_REFRESH_MS,
  LEADERBOARD_QUERY_LIMIT,
  LEADERBOARD_ROWS,
  PLAYTIME_FLUSH_MS,
  PLOT_COUNT,
  LEVEL_MAX,
  REBIRTH_MAX,
  AURA_IDS,
  ARM_IDS,
  TRAINING_KEY_MAX,
} from "../constants.js";
import { getPlayers, type PlayerDoc, type ItemDoc } from "../db.js";
import { finite, clampInt, sanitizeProgress, sanitizeItem, sanitizePlot } from "../sanitize.js";

// One board per stat, matching the leaderboards in the hub (client store/useLeaderboardStore.js:
// cash, strength, playTime).
const LEADERBOARD_STATS = ["cash", "strength", "playTime"] as const;
type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
type LeaderboardRow = { id: string; name: string; value: number };
type LeaderboardPayload = Record<LeaderboardStat, LeaderboardRow[]>;
type OnlineRow = { sessionId: string; userId: string | null; username: string } & Record<LeaderboardStat, number>;

// Collapse online rows that still share a userId (e.g. a leave/join racing the same tick) down
// to one, keeping the higher value for the ranked stat. Guests with no id are never collapsed.
function dedupeOnline(rows: OnlineRow[], stat: LeaderboardStat): OnlineRow[] {
  const byUserId = new Map<string, OnlineRow>();
  const anonymous: OnlineRow[] = [];
  for (const row of rows) {
    if (!row.userId) {
      anonymous.push(row);
      continue;
    }
    const existing = byUserId.get(row.userId);
    if (!existing || row[stat] > existing[stat]) byUserId.set(row.userId, row);
  }
  return [...byUserId.values(), ...anonymous];
}

const AVATAR_MAX_LEN = 4096;

function sanitizeAvatar(raw: unknown): string {
  return typeof raw === "string" && raw.length <= AVATAR_MAX_LEN ? raw : "";
}

/**
 * Room every client joins via `client.joinOrCreate("world", { userId, username, avatar })`.
 * Each player gets a home plot (PLOT_COUNT of them); beyond that, plots are shared.
 * Clients report their state (the game is client-authoritative); this room stores it,
 * relays poses/appearance/plot contents to the others and broadcasts the leaderboards.
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();

  // sessionId -> user id (Bloxity id or client guest id). Deliberately NOT part of WorldState:
  // it only gates this room's own Mongo reads/writes.
  userIds = new Map<string, string>();

  // sessionIds that already have a plot assigned (and a progress/noProgress reply sent) for the
  // current identity; cleared when the identity changes so the reply is re-sent.
  private plotted = new Set<string>();

  // sessionId -> epoch ms up to which that connection's playtime has already been counted.
  private playTimeMark = new Map<string, number>();

  messages = {
    // Position / gait, throttled client-side (~15 Hz).
    move: (client: Client, msg: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (finite(msg?.x)) p.x = msg.x;
      if (finite(msg?.y)) p.y = msg.y;
      if (finite(msg?.z)) p.z = msg.z;
      if (finite(msg?.yaw)) p.yaw = msg.yaw;
      if (finite(msg?.speed01)) p.speed01 = Math.min(1, Math.max(0, msg.speed01));
      if (typeof msg?.grounded === "boolean") p.grounded = msg.grounded;
      if (typeof msg?.bending === "boolean") p.bending = msg.bending;
      if (msg?.lifting === null) p.lifting = -1;
      else if (finite(msg?.lifting)) p.lifting = Math.min(1, Math.max(0, msg.lifting));
      if (msg?.training === null) p.training = "";
      else if (typeof msg?.training === "string" && msg.training.length <= TRAINING_KEY_MAX) p.training = msg.training;
      if (typeof msg?.holding === "boolean") p.holding = msg.holding;
    },
    // What other players can see on this one; sent right away instead of waiting for the save debounce.
    appearance: (client: Client, msg: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.equippedAura === "string" && AURA_IDS.includes(msg.equippedAura)) p.equippedAura = msg.equippedAura;
      if (typeof msg?.equippedArm === "string" && ARM_IDS.includes(msg.equippedArm)) p.equippedArm = msg.equippedArm;
      if (finite(msg?.level)) p.level = clampInt(msg.level, LEVEL_MAX, 1);
      if (finite(msg?.rebirths)) p.rebirths = clampInt(msg.rebirths, REBIRTH_MAX);
      if (msg && "heldItem" in msg) this.setHeld(p, sanitizeItem(msg.heldItem));
    },
    // Bloxity avatar JSON; sent on connect and whenever the portal reports a change.
    setAvatar: (client: Client, msg: { avatar?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const avatar = sanitizeAvatar(msg?.avatar);
      if (avatar) p.avatar = avatar;
    },
    // Debounced push of the durable half of the client state. Upserts, so a first save creates
    // the document. Also refreshes the live values the leaderboards and other players read.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch) return;
      this.applyLive(p, patch);

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      try {
        await players.updateOne(
          { _id: userId },
          {
            // Display name comes from this connection's own PlayerState, not `msg`; homePlot is
            // the server-assigned one.
            $set: { ...patch, homePlot: p.homePlot, username: p.username || "Player", updatedAt: new Date() },
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
      }
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest who signs in
    // mid-session). The server answers with progress/noProgress for the new identity.
    identify: (client: Client, msg: { username?: string; userId?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = msg.username.slice(0, 64);
      this.setUserId(client, p, typeof msg?.userId === "string" ? msg.userId : "");
    },
  };

  // Runs once immediately -- a fresh room shouldn't sit on an empty board for a full
  // LEADERBOARD_REFRESH_MS -- then on a timer.
  onCreate() {
    void this.refreshLeaderboard();
    this.clock.setInterval(() => {
      void this.refreshLeaderboard();
    }, LEADERBOARD_REFRESH_MS);
    this.clock.setInterval(() => this.flushAllPlaytime(), PLAYTIME_FLUSH_MS);
  }

  private setHeld(p: PlayerState, item: ItemDoc | null) {
    p.heldName = item?.name ?? "";
    p.heldRarity = item?.rarity ?? "";
    p.heldGlyph = item?.glyph ?? "";
  }

  // Mirrors a sanitized save into the live roster entry.
  private applyLive(p: PlayerState, patch: Partial<PlayerDoc>) {
    if (patch.cash !== undefined) p.cash = patch.cash;
    if (patch.strength !== undefined) p.strength = patch.strength;
    if (patch.level !== undefined) p.level = patch.level;
    if (patch.rebirths !== undefined) p.rebirths = patch.rebirths;
    if (patch.equippedAura !== undefined) p.equippedAura = patch.equippedAura;
    if (patch.equippedArm !== undefined) p.equippedArm = patch.equippedArm;
    if (patch.heldItem !== undefined) this.setHeld(p, patch.heldItem);
    if (patch.plotSlots !== undefined) this.setPlotSlots(p, patch.plotSlots);
  }

  private setPlotSlots(p: PlayerState, slots: Record<string, ItemDoc>) {
    for (const key of [...p.plotSlots.keys()]) if (!(key in slots)) p.plotSlots.delete(key);
    for (const [key, it] of Object.entries(slots)) {
      let cur = p.plotSlots.get(key);
      if (!cur) {
        cur = new PlotItem();
        p.plotSlots.set(key, cur);
      }
      if (cur.name !== it.name) cur.name = it.name;
      if (cur.rarity !== it.rarity) cur.rarity = it.rarity;
      const glyph = it.glyph ?? "";
      if (cur.glyph !== glyph) cur.glyph = glyph;
    }
  }

  // Lowest free plot, preferring `wanted` (the plot saved on the player's document) if nobody
  // else in this room holds it. The room has no player cap, so once all plots are taken the
  // least-shared one is reused.
  private claimPlot(sessionId: string, wanted: number | null): number {
    const counts = new Array<number>(PLOT_COUNT).fill(0);
    this.state.players.forEach((other, sid) => {
      if (sid !== sessionId && this.plotted.has(sid)) counts[other.homePlot]++;
    });
    if (wanted !== null && counts[wanted] === 0) return wanted;
    return counts.indexOf(Math.min(...counts));
  }

  // Adds the seconds elapsed since this session's last mark to its live playTime and, for a
  // signed-in player, $inc's the same amount into Mongo. $inc (not $set) so it can't race
  // saveProgress and a client can never forge or reset its own time.
  private flushPlaytime(sessionId: string) {
    const mark = this.playTimeMark.get(sessionId);
    if (mark === undefined) return;
    const seconds = Math.floor((Date.now() - mark) / 1000);
    if (seconds <= 0) return;
    // Advance by whole seconds only, so sub-second remainders aren't dropped.
    this.playTimeMark.set(sessionId, mark + seconds * 1000);
    const p = this.state.players.get(sessionId);
    if (p) p.playTime += seconds;
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    players
      .updateOne(
        { _id: userId },
        { $inc: { playTime: seconds }, $set: { username: p?.username || "Player", updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      )
      .catch((err) => console.warn("[WorldRoom] playtime flush failed", err));
  }

  private flushAllPlaytime() {
    for (const sessionId of [...this.playTimeMark.keys()]) this.flushPlaytime(sessionId);
  }

  // Drops a session's per-connection bookkeeping after a final playtime flush; frees its plot.
  private forgetSession(sessionId: string) {
    this.flushPlaytime(sessionId);
    this.playTimeMark.delete(sessionId);
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.plotted.delete(sessionId);
  }

  onJoin(client: Client, options?: { username?: string; userId?: string; avatar?: string }) {
    const p = new PlayerState();
    p.username = typeof options?.username === "string" ? options.username.slice(0, 64) : "";
    p.avatar = sanitizeAvatar(options?.avatar);
    this.state.players.set(client.sessionId, p);
    this.playTimeMark.set(client.sessionId, Date.now());

    this.setUserId(client, p, options?.userId ?? "");
    void this.refreshLeaderboard();
  }

  // Client-trusted user id. A forged id can only read/overwrite the SENDER's own save (there is
  // no cross-player read in `saveProgress`). Called from both onJoin and `identify`.
  private setUserId(client: Client, p: PlayerState, raw: string) {
    const userId = typeof raw === "string" ? raw.slice(0, 128) : "";
    const prev = this.userIds.get(client.sessionId) || "";
    if (userId === prev && this.plotted.has(client.sessionId)) return; // no change -- e.g. a username-only identify

    // The old identity's plot is released; the new one is claimed once its document is read.
    this.plotted.delete(client.sessionId);

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never shows
      // as two leaderboard rows / two racing Mongo writers (a crashed tab lingers up to 20s
      // via allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
    } else {
      // No identity: stop persisting for this connection. (The client flushes a final
      // saveProgress under the OLD id before sending `identify`.)
      this.userIds.delete(client.sessionId);
    }

    void this.loadProgress(client, userId, p);
    void this.refreshLeaderboard();
  }

  // Claims this player's plot, seeds their live roster values and sends the saved doc to just
  // this client so it can hydrate its state ("progress"), or "noProgress" when there is nothing
  // to load (new account, no identity, or Mongo unset). A failed read sends "serverError" so the
  // client shows its retry screen instead of overwriting a save it could not read.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", {});
        return;
      }
    }
    // The player may have left, or switched identity again, while the read was in flight.
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    p.homePlot = this.claimPlot(client.sessionId, sanitizePlot(doc?.homePlot));
    this.plotted.add(client.sessionId);

    if (!doc) {
      client.send("noProgress", { homePlot: p.homePlot });
      return;
    }
    p.cash = doc.cash ?? 0;
    p.strength = doc.strength ?? 0;
    p.level = doc.level ?? 1;
    p.rebirths = doc.rebirths ?? 0;
    // Saved total (already includes anything flushed while signed in this session).
    p.playTime = doc.playTime ?? 0;
    const live = sanitizeProgress(doc) ?? {};
    this.applyLive(p, live);

    client.send("progress", {
      cash: doc.cash ?? 0,
      gems: doc.gems,
      rebirths: doc.rebirths,
      strength: doc.strength,
      level: doc.level,
      xp: doc.xp,
      xpNeeded: doc.xpNeeded,
      backpackLevel: doc.backpackLevel,
      speedLevel: doc.speedLevel,
      inventory: live.inventory,
      ownedAuras: live.ownedAuras,
      equippedAura: live.equippedAura,
      ownedArms: live.ownedArms,
      equippedArm: live.equippedArm,
      heldItem: live.heldItem,
      plotSlots: live.plotSlots,
      discovered: live.discovered,
      homePlot: p.homePlot,
      playTime: p.playTime,
    });
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets 20s to reconnect with the same session.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      this.forgetSession(client.sessionId);
      return;
    }
    // Count time up to the drop, then pause the clock for the reconnect window.
    this.flushPlaytime(client.sessionId);
    this.playTimeMark.delete(client.sessionId);
    try {
      await this.allowReconnection(client, 20);
      this.playTimeMark.set(client.sessionId, Date.now());
    } catch {
      this.forgetSession(client.sessionId);
    }
  }

  // Builds and broadcasts the merged "all-time saved + currently online" leaderboard. Only the
  // server has both the live roster and the sessionId->userId map needed to tell "this online
  // player already IS a saved account" apart from "this saved account is offline". Private so
  // tests can call and await it directly.
  private async refreshLeaderboard() {
    const onlineRows: OnlineRow[] = [];
    const onlineUserIds = new Set<string>();
    this.state.players.forEach((p, sessionId) => {
      const userId = this.userIds.get(sessionId) ?? null;
      if (userId) onlineUserIds.add(userId);
      onlineRows.push({
        sessionId,
        userId,
        username: p.username || "Player",
        cash: p.cash,
        strength: p.strength,
        playTime: p.playTime,
      });
    });

    const players = getPlayers();
    const payload = { cash: [], strength: [], playTime: [] } as LeaderboardPayload;

    for (const stat of LEADERBOARD_STATS) {
      // Online rows first: a connected player's live value is more current than their last save.
      const merged: LeaderboardRow[] = dedupeOnline(onlineRows, stat).map((row) => ({
        id: row.sessionId,
        name: row.username,
        value: row[stat],
      }));

      // Then everyone who has EVER saved, minus accounts already shown live.
      if (players) {
        try {
          const docs = await players
            .find({}, { projection: { _id: 1, username: 1, [stat]: 1 } })
            .sort({ [stat]: -1 })
            .limit(LEADERBOARD_QUERY_LIMIT)
            .toArray();

          let offlineIndex = 0;
          for (const doc of docs) {
            if (onlineUserIds.has(doc._id)) continue;
            // Synthetic id -- never broadcast another account's raw user id.
            merged.push({
              id: `offline:${stat}:${offlineIndex++}`,
              name: doc.username || "Player",
              value: (doc[stat] as number | undefined) ?? 0,
            });
          }
        } catch (err) {
          console.warn(`[WorldRoom] leaderboard query failed for stat=${stat}`, err);
        }
      }

      // Collapse rows sharing a display name (the same account under a different id would
      // otherwise appear twice). Keep the higher value but prefer an online row's id so the
      // client can recognise its own row.
      const byName = new Map<string, LeaderboardRow>();
      for (const row of merged) {
        const key = row.name || "Player";
        const existing = byName.get(key);
        if (!existing) {
          byName.set(key, row);
          continue;
        }
        const preferId = existing.id.startsWith("offline:") && !row.id.startsWith("offline:") ? row.id : existing.id;
        byName.set(key, { id: preferId, name: key, value: Math.max(existing.value, row.value) });
      }
      const deduped = [...byName.values()];

      deduped.sort((a, b) => b.value - a.value);
      payload[stat] = deduped.slice(0, LEADERBOARD_ROWS);
    }

    this.broadcast("leaderboard", payload);
  }
}
