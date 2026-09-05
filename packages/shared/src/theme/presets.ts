/**
 * Shipped presets.
 *
 * One click, five genuinely different directions. They differ in typeface,
 * corner treatment, card style, density and ground — not in accent colour
 * alone, which would only prove the vocabulary can hold five hex values.
 *
 * A preset is applied by copying its values into a system theme, so it is a
 * starting point rather than a mode: everything stays editable afterwards, and
 * a preset can be retuned later without silently changing anyone's page.
 */

export type Preset = {
  id: string;
  name: string;
  /** Product-facing description of the visual character. */
  character: string;
  tokens: Record<string, string>;
};

export const PRESETS: readonly Preset[] = [
  {
    id: "notebook",
    name: "Notebook",
    character:
      "The default, and the quietest. Warm off-white paper, a serif for names, " +
      "soft outlined cards and room to breathe. Gets out of the way of whatever " +
      "you put on it.",
    tokens: {
      "color.scheme": "auto",
      "color.page": "#FAF8FB",
      "color.surface": "#FFFFFF",
      "color.text": "#1C1721",
      "color.muted": "#6B6478",
      "color.accent": "#A23B72",
      "color.border": "#E6E1EC",
      "font.body": "system",
      "font.heading": "newsreader",
      "font.size": "medium",
      "shape.radius": "medium",
      "surface.style": "outlined",
      density: "normal",
      "avatar.shape": "rounded",
    },
  },
  {
    id: "broadsheet",
    name: "Broadsheet",
    character:
      "Editorial and dense. High-contrast ink on paper, an expressive display " +
      "serif, square corners and hairline rules instead of cards. Reads like " +
      "something printed.",
    tokens: {
      "color.scheme": "light",
      "color.page": "#FFFDF8",
      "color.surface": "#FFFDF8",
      "color.text": "#141210",
      "color.muted": "#5F5A52",
      "color.accent": "#8C2F1E",
      "color.border": "#D6D0C4",
      "font.body": "newsreader",
      "font.heading": "fraunces",
      "font.size": "medium",
      "shape.radius": "none",
      "surface.style": "plain",
      density: "compact",
      "avatar.shape": "square",
    },
  },
  {
    id: "bloom",
    name: "Bloom",
    character:
      "Soft and friendly. Rounded typeface throughout, generous corners, filled " +
      "cards with no outlines, circular avatars and plenty of space. The " +
      "gentlest of the set.",
    tokens: {
      "color.scheme": "light",
      "color.page": "#FDF6F8",
      "color.surface": "#FFFFFF",
      "color.text": "#33232B",
      "color.muted": "#7C6670",
      "color.accent": "#C4547F",
      "color.border": "#F0DCE4",
      "font.body": "nunito",
      "font.heading": "nunito",
      "font.size": "medium",
      "shape.radius": "large",
      "surface.style": "filled",
      density: "relaxed",
      "avatar.shape": "circle",
    },
  },
  {
    id: "terminal",
    name: "Terminal",
    character:
      "Deliberately technical. Monospaced throughout, near-black ground, square " +
      "corners and no card decoration at all. Everything aligns to a grid.",
    tokens: {
      "color.scheme": "dark",
      "color.page": "#0E0F12",
      "color.surface": "#14161A",
      "color.text": "#D9DEE4",
      "color.muted": "#7C8794",
      "color.accent": "#5FD3A6",
      "color.border": "#242830",
      "font.body": "jetbrains-mono",
      "font.heading": "jetbrains-mono",
      "font.size": "small",
      "shape.radius": "none",
      "surface.style": "plain",
      density: "compact",
      "avatar.shape": "square",
    },
  },
  {
    id: "midnight",
    name: "Midnight",
    character:
      "Modern dark. Geometric headings on a deep blue-grey, filled cards with " +
      "soft corners and a cool accent. Comfortable to read at night.",
    tokens: {
      "color.scheme": "dark",
      "color.page": "#12141C",
      "color.surface": "#1B1E29",
      "color.text": "#E8E9F0",
      "color.muted": "#959AB0",
      "color.accent": "#8AB4F8",
      "color.border": "#2A2E3D",
      "font.body": "inter",
      "font.heading": "space-grotesk",
      "font.size": "medium",
      "shape.radius": "medium",
      "surface.style": "filled",
      density: "normal",
      "avatar.shape": "rounded",
    },
  },
];

export const PRESET_MAP: ReadonlyMap<string, Preset> = new Map(PRESETS.map((p) => [p.id, p]));
