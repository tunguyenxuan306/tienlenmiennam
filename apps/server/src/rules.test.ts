import { describe, expect, it } from "vitest";
import { canBeat, classifyCards, createDeck, Card } from "./rules";

const card = (rank: number, suit: Card["suit"] = "SPADES"): Card => ({ rank, suit });

describe("game rules", () => {
  it("creates a 52-card deck", () => {
    expect(createDeck()).toHaveLength(52);
  });

  it("classifies singles, pairs and triples", () => {
    expect(classifyCards([card(3, "SPADES")]).type).toBe("SINGLE");
    expect(classifyCards([card(5), card(5, "HEARTS")]).type).toBe("PAIR");
    expect(classifyCards([card(7), card(7, "CLUBS"), card(7, "HEARTS")]).type).toBe("TRIPLE");
  });

  it("classifies straights", () => {
    expect(classifyCards([card(3), card(4), card(5), card(6)]).type).toBe("STRAIGHT");
  });

  it("rejects straights containing 2", () => {
    expect(classifyCards([card(12), card(13), card(14), card(15)]).type).toBe("INVALID");
  });

  it("classifies and compares quads", () => {
    const quad3 = [card(3), card(3, "CLUBS"), card(3, "DIAMONDS"), card(3, "HEARTS")];
    const quad5 = [card(5), card(5, "CLUBS"), card(5, "DIAMONDS"), card(5, "HEARTS")];
    expect(classifyCards(quad3).type).toBe("QUAD");
    expect(canBeat(quad5, quad3)).toBe(true);
  });

  it("classifies three consecutive pairs", () => {
    const pairs = [
      card(6), card(6, "HEARTS"),
      card(7), card(7, "HEARTS"),
      card(8), card(8, "HEARTS")
    ];
    expect(classifyCards(pairs).type).toBe("THREE_PAIRS");
  });

  it("rejects duplicated physical cards and non-consecutive three pairs", () => {
    expect(classifyCards([card(3), card(3)])).toEqual({ type: "INVALID", strength: -1 });
    expect(classifyCards([
      card(3), card(3, "HEARTS"),
      card(5), card(5, "HEARTS"),
      card(7), card(7, "HEARTS")
    ]).type).toBe("INVALID");
    expect(classifyCards([
      card(13), card(13, "HEARTS"),
      card(14), card(14, "HEARTS"),
      card(15), card(15, "HEARTS")
    ]).type).toBe("INVALID");
  });

  it("blocks lower same-type combinations", () => {
    expect(canBeat([card(9, "SPADES")], [card(9, "DIAMONDS")])).toBe(false);
    expect(canBeat([card(10, "HEARTS")], [card(9, "DIAMONDS")])).toBe(true);
  });

  it("allows special combinations to cut 2", () => {
    const heo = [card(15, "HEARTS")];
    const quad = [card(4), card(4, "CLUBS"), card(4, "DIAMONDS"), card(4, "HEARTS")];
    expect(canBeat(quad, heo)).toBe(true);
  });

  it("requires a three-pair run to be consecutive to cut a 2", () => {
    const threePairs = [
      card(6), card(6, "HEARTS"),
      card(7), card(7, "HEARTS"),
      card(8), card(8, "HEARTS")
    ];
    expect(canBeat(threePairs, [card(15, "HEARTS")])).toBe(true);
    expect(canBeat(threePairs.slice(0, 4), [card(15, "HEARTS")])).toBe(false);
  });
});
