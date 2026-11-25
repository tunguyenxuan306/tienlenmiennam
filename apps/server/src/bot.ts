import { canBeat, Card, classifyCards } from "./rules";

export type BotLevel = "easy" | "medium" | "hard";

export function chooseBotCards(
  hand: Card[],
  current: Card[],
  level: BotLevel = "medium"
) {
  if (!hand.length) return [];
  const candidates: Card[][] = [];
  const selected: Card[] = [];
  function enumerate(start: number) {
    if (selected.length > 0) candidates.push([...selected]);
    for (let index = start; index < hand.length; index++) {
      selected.push(hand[index]);
      enumerate(index + 1);
      selected.pop();
    }
  }
  enumerate(0);

  const valid = candidates.filter((cards) =>
    classifyCards(cards).type !== "INVALID" &&
    (!current.length || canBeat(cards, current))
  );
  if (!valid.length) return [];

  valid.sort((a, b) => {
    const strengthA = classifyCards(a).strength;
    const strengthB = classifyCards(b).strength;
    if (level === "easy") return a.length - b.length || strengthA - strengthB;
    if (level === "hard") return b.length - a.length || strengthA - strengthB;
    return a.length - b.length || strengthA - strengthB;
  });
  return valid[0];
}
