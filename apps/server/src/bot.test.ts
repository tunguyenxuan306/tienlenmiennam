import { describe, expect, it } from "vitest";
import { chooseBotCards } from "./bot";
import { Card, classifyCards } from "./rules";

const card = (rank: number, suit: Card["suit"] = "SPADES"): Card => ({ rank, suit });

describe("bot card selection", () => {
  it("finds valid combinations that are not adjacent in the sorted hand", () => {
    const hand = [
      card(3), card(3, "HEARTS"),
      card(4), card(4, "HEARTS"),
      card(5), card(5, "HEARTS")
    ];
    const play = chooseBotCards(hand, [], "medium");
    expect(classifyCards(play).type).not.toBe("INVALID");
  });

  it("passes when it cannot beat the active combination", () => {
    const hand = [card(3), card(4), card(5)];
    expect(chooseBotCards(hand, [card(15, "HEARTS")])).toEqual([]);
  });
});
