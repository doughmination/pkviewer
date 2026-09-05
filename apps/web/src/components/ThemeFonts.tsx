import type { FontEntry } from "@pkviewer/shared";

/**
 * Loads the typefaces a resolved theme actually uses.
 *
 * The families come from the fixed allow-list, never from stored strings, so
 * this can only ever request a font we chose. A theme using the system stack
 * loads nothing at all.
 */
export function ThemeFonts({ fonts }: { fonts: FontEntry[] }) {
  const families = fonts
    .filter((f) => f.family !== null)
    .map((f) => `family=${encodeURIComponent(f.family!).replace(/%20/g, "+")}:wght@${f.weights.join(";")}`);

  if (families.length === 0) return null;

  return (
    <link
      rel="stylesheet"
      href={`https://fonts.googleapis.com/css2?${families.join("&")}&display=swap`}
    />
  );
}
