import {
  CASH_MAX, STRENGTH_MAX, REBIRTH_MAX, LEVEL_MAX, UPGRADE_LEVEL_MAX, INVENTORY_MAX, DISCOVERED_MAX,
  ITEM_VALUE_MAX, TEXT_MAX, TUTORIAL_DONE_STEP, TUTORIAL_REBIRTH_STEP, RARITIES, AURA_IDS, ARM_IDS, PLOT_COUNT, PLOT_SLOT_COUNT,
} from "./constants.js";
import type { ItemDoc, LootDoc, PlayerDoc } from "./db.js";

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
export function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}
export function clampInt(v: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function text(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= TEXT_MAX ? v : null;
}

// Owned auras / arms -> known ids only, no duplicates.
export function sanitizeIds(raw: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id): id is string => typeof id === "string" && allowed.includes(id)))];
}

// { name, rarity, glyph } as held / placed on a plot slot.
export function sanitizeItem(raw: unknown): ItemDoc | null {
  if (!isObject(raw)) return null;
  const name = text(raw.name);
  if (!name || typeof raw.rarity !== "string" || !RARITIES.includes(raw.rarity)) return null;
  const glyph = typeof raw.glyph === "string" && raw.glyph.length <= TEXT_MAX ? raw.glyph : "";
  return { name, rarity: raw.rarity, glyph };
}

// Carried loot { name, rarity, value }.
export function sanitizeInventory(raw: unknown): LootDoc[] {
  if (!Array.isArray(raw)) return [];
  const out: LootDoc[] = [];
  for (const it of raw.slice(0, INVENTORY_MAX)) {
    if (!isObject(it)) continue;
    const name = text(it.name);
    if (!name || typeof it.rarity !== "string" || !RARITIES.includes(it.rarity) || !finite(it.value)) continue;
    out.push({ name, rarity: it.rarity, value: clampNum(it.value, ITEM_VALUE_MAX) });
  }
  return out;
}

// Home slot index (string key) -> item, valid indices only.
export function sanitizePlotSlots(raw: unknown): Record<string, ItemDoc> {
  const out: Record<string, ItemDoc> = {};
  if (!isObject(raw)) return out;
  for (const [key, val] of Object.entries(raw)) {
    const i = Number(key);
    if (!Number.isInteger(i) || i < 0 || i >= PLOT_SLOT_COUNT) continue;
    const item = sanitizeItem(val);
    if (item) out[String(i)] = item;
  }
  return out;
}

export function sanitizeDiscovered(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names = raw.map(text).filter((n): n is string => n !== null);
  return [...new Set(names)].slice(0, DISCOVERED_MAX);
}

// Plot index, or null if it isn't a valid one.
export function sanitizePlot(raw: unknown): number | null {
  return finite(raw) && Number.isInteger(raw) && raw >= 0 && raw < PLOT_COUNT ? raw : null;
}

// What loadProgress sends down as tutorialStep. A doc predating the field reads as finished (those
// players were never shown the tutorial); otherwise the stored step, raised to what the stats prove
// (a saved rebirth means the rebirth step is behind them). Never lowers a stored step.
export function resolveTutorialStep(doc: Partial<PlayerDoc>): number {
  const stored = typeof doc.tutorialStep === "number" && Number.isFinite(doc.tutorialStep) ? doc.tutorialStep : TUTORIAL_DONE_STEP;
  const proven = (doc.rebirths ?? 0) >= 1 ? TUTORIAL_REBIRTH_STEP + 1 : 0;
  return Math.min(TUTORIAL_DONE_STEP, Math.max(0, Math.floor(Math.max(stored, proven))));
}

// The game is client-authoritative -- no server-side gameplay validation. What IS enforced:
// shape and bounds, so a malformed payload can never corrupt this player's own Mongo document.
// A forged number can only ever affect the sender's own save. `homePlot` is deliberately absent:
// the server assigns it.
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};

  if (finite(raw.cash)) out.cash = clampNum(raw.cash, CASH_MAX);
  if (finite(raw.gems)) out.gems = clampInt(raw.gems, CASH_MAX);
  if (finite(raw.rebirths)) out.rebirths = clampInt(raw.rebirths, REBIRTH_MAX);
  if (finite(raw.strength)) out.strength = clampNum(raw.strength, STRENGTH_MAX);
  if (finite(raw.level)) out.level = clampInt(raw.level, LEVEL_MAX, 1);
  if (finite(raw.xp)) out.xp = clampNum(raw.xp, STRENGTH_MAX);
  if (finite(raw.xpNeeded)) out.xpNeeded = clampNum(raw.xpNeeded, STRENGTH_MAX);
  for (const key of ["backpackLevel", "speedLevel"] as const) {
    if (finite(raw[key])) out[key] = clampInt(raw[key] as number, UPGRADE_LEVEL_MAX, 1);
  }
  if (raw.inventory !== undefined) out.inventory = sanitizeInventory(raw.inventory);
  if (raw.ownedAuras !== undefined) out.ownedAuras = sanitizeIds(["none", ...(Array.isArray(raw.ownedAuras) ? raw.ownedAuras : [])], AURA_IDS);
  if (typeof raw.equippedAura === "string" && AURA_IDS.includes(raw.equippedAura)) out.equippedAura = raw.equippedAura;
  if (raw.ownedArms !== undefined) out.ownedArms = sanitizeIds(["dirt", ...(Array.isArray(raw.ownedArms) ? raw.ownedArms : [])], ARM_IDS);
  if (typeof raw.equippedArm === "string" && ARM_IDS.includes(raw.equippedArm)) out.equippedArm = raw.equippedArm;
  if (raw.heldItem !== undefined) out.heldItem = sanitizeItem(raw.heldItem);
  if (raw.plotSlots !== undefined) out.plotSlots = sanitizePlotSlots(raw.plotSlots);
  if (typeof raw.baseUpgraded === "boolean") out.baseUpgraded = raw.baseUpgraded;
  if (raw.discovered !== undefined) out.discovered = sanitizeDiscovered(raw.discovered);
  if (finite(raw.tutorialStep)) out.tutorialStep = clampInt(raw.tutorialStep, TUTORIAL_DONE_STEP);
  if (raw.tutorialItem !== undefined) out.tutorialItem = text(raw.tutorialItem);
  return out;
}
