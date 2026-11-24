import type { Env, Palette } from "./color.js";

const BANANA = [
  " _",
  "//\\",
  "V  \\",
  " \\  \\_",
  "  \\,'.`-.",
  "   |\\ `. `.",
  "   ( \\  `. `-.                        _,.-:\\",
  "    \\ \\   `.  `-._             __..--' ,-';/",
  "     \\ `.   `-.   `-..___..---'   _.--' ,'/",
  "      `. `.    `-._        __..--'    ,' /",
  "        `. `-_     ``--..''       _.-' ,'",
  "          `-_ `-.___        __,--'   ,'",
  '             `-.__  `----"""    __.-\'',
  "                  `--..____..--'",
];

/** The name and version sit in the empty space to the right of the banana's top. */
const BESIDE_COLUMN = 14;

export interface BannerConditions {
  readonly stderrIsTTY: boolean;
  readonly json: boolean;
  /** False with --no-banner. */
  readonly banner: boolean;
  readonly env: Env;
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/** Shown on an interactive stderr only: never in CI, with --json, with --no-banner or when NO_COLOR is set. */
export function showBanner(conditions: BannerConditions): boolean {
  return (
    conditions.stderrIsTTY &&
    !conditions.json &&
    conditions.banner &&
    !isSet(conditions.env.CI) &&
    !isSet(conditions.env.NO_COLOR)
  );
}

export function renderBanner(version: string, palette: Palette): string {
  const beside: Record<number, string> = {
    1: palette.bold(`chimpd ${version}`),
    2: "mutants and faults",
  };
  const lines = BANANA.map((line, index) => {
    const text = beside[index];
    const art = palette.yellow(line);
    return text === undefined
      ? art
      : `${art}${" ".repeat(BESIDE_COLUMN - line.length)}${text}`;
  });
  return `${lines.join("\n")}\n\n`;
}

export const BANANA_LINES: readonly string[] = BANANA;
