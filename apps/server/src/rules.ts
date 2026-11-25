export type Suit = "SPADES" | "CLUBS" | "DIAMONDS" | "HEARTS";
export type Card = { rank: number; suit: Suit };

export const SUIT_ORDER: Record<Suit, number> = {
  SPADES: 0,
  CLUBS: 1,
  DIAMONDS: 2,
  HEARTS: 3
};

export type Combination =
  | "INVALID"
  | "SINGLE"
  | "PAIR"
  | "TRIPLE"
  | "STRAIGHT"
  | "QUAD"
  | "THREE_PAIRS"
  | "FOUR_PAIRS";

export function cardValue(card: Card) {
  return (card.rank - 3) * 4 + SUIT_ORDER[card.suit];
}

export function createDeck(): Card[] {
  const suits: Suit[] = ["SPADES", "CLUBS", "DIAMONDS", "HEARTS"];
  return suits.flatMap((suit) => Array.from({ length: 13 }, (_, index) => ({
    suit,
    rank: index + 3
  })));
}

export function classifyCards(cards: Card[]): { type: Combination; strength: number } {
  if (!cards.length) return { type: "INVALID", strength: -1 };
  if (cards.some((card) =>
    !Number.isInteger(card.rank) || card.rank < 3 || card.rank > 15 ||
    !Object.prototype.hasOwnProperty.call(SUIT_ORDER, card.suit)
  )) return { type: "INVALID", strength: -1 };
  if (new Set(cards.map((card) => `${card.rank}:${card.suit}`)).size !== cards.length) {
    return { type: "INVALID", strength: -1 };
  }
  if (cards.length === 1) return { type: "SINGLE", strength: cardValue(cards[0]) };

  const ranks = cards.map((card) => card.rank).sort((a, b) => a - b);
  if (cards.length === 2 && ranks[0] === ranks[1]) {
    return { type: "PAIR", strength: Math.max(...cards.map(cardValue)) };
  }
  if (cards.length === 3 && ranks.every((rank) => rank === ranks[0])) {
    return { type: "TRIPLE", strength: ranks[0] };
  }
  if (cards.length === 4 && ranks.every((rank) => rank === ranks[0])) {
    return { type: "QUAD", strength: ranks[0] };
  }
  if (cards.length >= 3 && ranks.every((rank, index) => index === 0 || rank === ranks[index - 1] + 1) && !ranks.includes(15)) {
    return { type: "STRAIGHT", strength: ranks[ranks.length - 1] };
  }

  if (cards.length === 6) {
    const counts = rankCounts(cards);
    const ordered = [...counts.keys()].sort((a, b) => a - b);
    if ([...counts.values()].every((count) => count === 2) && counts.size === 3 &&
      !ordered.includes(15) &&
      ordered.every((rank, index) => index === 0 || rank === ordered[index - 1] + 1)) {
      return { type: "THREE_PAIRS", strength: ordered[ordered.length - 1] };
    }
  }
  if (cards.length === 8) {
    const counts = rankCounts(cards);
    if ([...counts.values()].every((count) => count === 2) && counts.size === 4) {
      const ordered = [...counts.keys()].sort((a, b) => a - b);
      if (!ordered.includes(15) && ordered.every((rank, index) => index === 0 || rank === ordered[index - 1] + 1)) {
        return { type: "FOUR_PAIRS", strength: ordered[ordered.length - 1] };
      }
    }
  }
  return { type: "INVALID", strength: -1 };
}

export function rankCounts(cards: Card[]) {
  const counts = new Map<number, number>();
  for (const card of cards) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  return counts;
}

export function canBeat(play: Card[], current: Card[]) {
  const played = classifyCards(play);
  const target = classifyCards(current);
  if (played.type === "INVALID" || target.type === "INVALID") return false;

  const targetIsHeo = target.type === "SINGLE" && current[0].rank === 15;
  if (targetIsHeo && ["QUAD", "FOUR_PAIRS", "THREE_PAIRS"].includes(played.type)) {
    return true;
  }
  if (played.type === "QUAD" && target.type === "QUAD") return played.strength > target.strength;
  if (played.type === "FOUR_PAIRS" && target.type === "FOUR_PAIRS") return played.strength > target.strength;
  if (played.type === "THREE_PAIRS" && target.type === "THREE_PAIRS") return played.strength > target.strength;
  if (played.type !== target.type || play.length !== current.length) return false;
  return played.strength > target.strength;
}
