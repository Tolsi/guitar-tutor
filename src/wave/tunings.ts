/** Guitar tunings: open strings as MIDI notes, from the lowest string. */
export interface Tuning {
  id: string;
  name: string;
  group: string;
  strings: number[];
}

const STANDARD = [40, 45, 50, 55, 59, 64];
const shift = (a: number[], by: number) => a.map((m) => m + by);
/** The lowest string a whole tone down. */
const drop = (a: number[]) => [a[0] - 2, ...a.slice(1)];

export const TUNINGS: Tuning[] = [
  { id: "e", name: "Стандартный (E)", group: "Обычные", strings: STANDARD },
  { id: "eb", name: "На полтона ниже (E♭)", group: "Обычные", strings: shift(STANDARD, -1) },
  { id: "d", name: "На тон ниже (D)", group: "Обычные", strings: shift(STANDARD, -2) },
  { id: "cs", name: "На полтора тона ниже (C♯)", group: "Обычные", strings: shift(STANDARD, -3) },
  { id: "c", name: "На два тона ниже (C)", group: "Обычные", strings: shift(STANDARD, -4) },
  { id: "dropd", name: "Drop D", group: "Drop", strings: drop(STANDARD) },
  { id: "dropcs", name: "Drop C♯", group: "Drop", strings: drop(shift(STANDARD, -1)) },
  { id: "dropc", name: "Drop C", group: "Drop", strings: drop(shift(STANDARD, -2)) },
  { id: "dropb", name: "Drop B", group: "Drop", strings: drop(shift(STANDARD, -3)) },
  { id: "dropas", name: "Drop A♯", group: "Drop", strings: drop(shift(STANDARD, -4)) },
  { id: "dadgad", name: "DADGAD", group: "Открытые", strings: [38, 45, 50, 55, 57, 62] },
  { id: "openg", name: "Открытый G", group: "Открытые", strings: [38, 43, 50, 55, 59, 62] },
  { id: "opend", name: "Открытый D", group: "Открытые", strings: [38, 45, 50, 54, 57, 62] },
  { id: "opene", name: "Открытый E", group: "Открытые", strings: [40, 47, 52, 56, 59, 64] },
  { id: "openc", name: "Открытый C", group: "Открытые", strings: [36, 43, 48, 55, 60, 64] },
  { id: "7", name: "7 струн, стандартный (B)", group: "7 и 8 струн", strings: [35, ...STANDARD] },
  { id: "7dropa", name: "7 струн, Drop A", group: "7 и 8 струн", strings: [33, ...STANDARD] },
  { id: "8", name: "8 струн, стандартный (F♯)", group: "7 и 8 струн", strings: [30, 35, ...STANDARD] },
  { id: "8drope", name: "8 струн, Drop E", group: "7 и 8 струн", strings: [28, 35, ...STANDARD] },
];
