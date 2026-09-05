import {
  compositionToCssVars,
  resolveComposition,
  resolveTheme,
  themeToCssVars,
  type FontEntry,
} from "@pkviewer/shared";

/**
 * Bridges stored theme data to what the renderer needs.
 *
 * The vocabulary and its validation live in @pkviewer/shared; this only wires
 * them to the page, so a vocabulary change never reaches into components.
 */
export type PageTheme = {
  vars: Record<string, string>;
  darkVars: Record<string, string>;
  colorScheme: "auto" | "light" | "dark";
  fonts: FontEntry[];
  composition: Record<string, string>;
};

export function buildPageTheme(
  systemTokens: unknown,
  memberTokens: unknown = null,
  /**
   * Composition already resolved by the API. Passed through rather than
   * re-resolved so there is one place inheritance happens, not two.
   */
  resolvedComposition: Record<string, string> | null = null,
): PageTheme {
  const theme = resolveTheme(systemTokens, memberTokens);
  const composition = resolvedComposition ?? resolveComposition({}, {});
  const compositionVars = compositionToCssVars(composition);

  return {
    vars: { ...themeToCssVars(theme.light), ...compositionVars },
    darkVars: { ...themeToCssVars(theme.dark), ...compositionVars },
    colorScheme: theme.scheme,
    fonts: theme.fonts,
    composition,
  };
}
