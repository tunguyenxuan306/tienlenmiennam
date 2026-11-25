export type Suit = "SPADES" | "CLUBS" | "DIAMONDS" | "HEARTS";
export type Card = { rank: number; suit: Suit };

export const SUIT_ORDER: Record<Suit, number> = {
  SPADES: 0,
  CLUBS: 1,
  DIAMONDS: 2,
  HEARTS: 3
};
