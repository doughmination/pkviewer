/**
 * The pkviewer theme vocabulary.
 *
 * This is the product's public design API. It is deliberately small: a person
 * who does not write CSS should be able to hold all of it in their head, and
 * every option should produce a page that still looks composed. It is not
 * "CSS custom properties with a UI" — there is no token here that exists only
 * because a stylesheet happened to need a number.
 *
 * The dividing line used throughout:
 *
 *   THEME       how things look   — colour, type, radius, surface, density
 *   COMPOSITION what appears and how it is arranged — sections, columns, order
 *
 * A knob that changes which information is on the page, or where it sits, is
 * composition. A knob that changes the appearance of whatever is there is a
 * theme token. `directory.columns` is composition; `shape.radius` is a token.
 */

export type TokenType = "color" | "length" | "enum" | "font" | "boolean";

/** Values are stored as strings throughout, matching the storage mechanism. */
export type TokenValue = string;

export type TokenDefBase = {
  key: string;
  label: string;
  /** One line, written for a non-technical editor UI. */
  help: string;
  /**
   * Whether a member may override this on their own page.
   *
   * False is reserved for tokens where a per-member override would make the
   * SITE incoherent rather than the page distinctive.
   */
  memberOverridable: boolean;
};

export type ColorTokenDef = TokenDefBase & {
  type: "color";
  /** Platform default carries both grounds so the default identity works in
   * either scheme without the vocabulary doubling in size. */
  default: { light: string; dark: string };
};

export type EnumTokenDef = TokenDefBase & {
  type: "enum";
  values: readonly string[];
  default: string;
};

export type FontTokenDef = TokenDefBase & {
  type: "font";
  default: FontId;
};

export type LengthTokenDef = TokenDefBase & {
  type: "length";
  unit: "px" | "rem";
  min: number;
  max: number;
  default: string;
};

export type BooleanTokenDef = TokenDefBase & {
  type: "boolean";
  default: boolean;
};

export type TokenDef =
  | ColorTokenDef
  | EnumTokenDef
  | FontTokenDef
  | LengthTokenDef
  | BooleanTokenDef;

// ---------------------------------------------------------------- typefaces

/**
 * The font allow-list.
 *
 * Fixed and finite. No arbitrary families, no uploads, no URLs: a font token
 * carries an id from this table and nothing else, so a theme can never point
 * the browser at a resource we did not choose.
 *
 * Every entry is either the system stack (no network cost at all) or a Google
 * Fonts family, which is the one font host the platform already allows.
 */
export type FontId =
  | "system"
  | "inter"
  | "nunito"
  | "atkinson"
  | "newsreader"
  | "fraunces"
  | "space-grotesk"
  | "jetbrains-mono";

export type FontEntry = {
  id: FontId;
  label: string;
  /** Google Fonts family name, or null for the system stack. */
  family: string | null;
  stack: string;
  weights: readonly number[];
  note: string;
};

const SYSTEM_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const FONTS: Readonly<Record<FontId, FontEntry>> = {
  system: {
    id: "system",
    label: "System",
    family: null,
    stack: SYSTEM_STACK,
    weights: [400, 600],
    note: "Whatever the reader's device uses. Loads instantly.",
  },
  inter: {
    id: "inter",
    label: "Inter",
    family: "Inter",
    stack: `"Inter", ${SYSTEM_STACK}`,
    weights: [400, 600],
    note: "Neutral and modern.",
  },
  nunito: {
    id: "nunito",
    label: "Nunito",
    family: "Nunito",
    stack: `"Nunito", ${SYSTEM_STACK}`,
    weights: [400, 700],
    note: "Rounded and friendly.",
  },
  atkinson: {
    id: "atkinson",
    label: "Atkinson Hyperlegible",
    family: "Atkinson Hyperlegible",
    stack: `"Atkinson Hyperlegible", ${SYSTEM_STACK}`,
    weights: [400, 700],
    note: "Designed for maximum legibility, including for low vision.",
  },
  newsreader: {
    id: "newsreader",
    label: "Newsreader",
    family: "Newsreader",
    stack: '"Newsreader", Georgia, "Iowan Old Style", serif',
    weights: [400, 600],
    note: "A warm serif that reads well at length.",
  },
  fraunces: {
    id: "fraunces",
    label: "Fraunces",
    family: "Fraunces",
    stack: '"Fraunces", Georgia, "Iowan Old Style", serif',
    weights: [400, 600],
    note: "An expressive display serif with real character.",
  },
  "space-grotesk": {
    id: "space-grotesk",
    label: "Space Grotesk",
    family: "Space Grotesk",
    stack: `"Space Grotesk", ${SYSTEM_STACK}`,
    weights: [400, 600],
    note: "Geometric and slightly technical.",
  },
  "jetbrains-mono": {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    family: "JetBrains Mono",
    stack: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
    weights: [400, 700],
    note: "Monospaced, for a deliberately technical look.",
  },
};

export const FONT_IDS = Object.keys(FONTS) as FontId[];

// ------------------------------------------------------------ theme tokens

/**
 * Fourteen tokens.
 *
 * Colour is seven of them because colour is what people actually want to
 * change, and the rest are single decisions with a handful of named options
 * rather than free numbers. Named options are what keep every combination
 * looking composed: a person cannot pick 3px of border radius and 41px of
 * padding and end up with something that reads as broken.
 */
export const THEME_TOKENS: readonly TokenDef[] = [
  {
    key: "color.scheme",
    type: "enum",
    values: ["auto", "light", "dark"],
    default: "auto",
    label: "Colour scheme",
    help: "Follow the reader's device, or always use light or dark.",
    // System-only: this is a property of the SITE. A member page flipping to
    // dark while the system page is light makes navigation feel broken rather
    // than personal.
    memberOverridable: false,
  },
  {
    key: "color.page",
    type: "color",
    default: { light: "#FAF8FB", dark: "#151219" },
    label: "Page background",
    help: "The colour behind everything.",
    memberOverridable: true,
  },
  {
    key: "color.surface",
    type: "color",
    default: { light: "#FFFFFF", dark: "#1E1A24" },
    label: "Card background",
    help: "The colour of cards and panels sitting on the page.",
    memberOverridable: true,
  },
  {
    key: "color.text",
    type: "color",
    default: { light: "#1C1721", dark: "#EEEAF2" },
    label: "Text",
    help: "Main text colour.",
    memberOverridable: true,
  },
  {
    key: "color.muted",
    type: "color",
    default: { light: "#6B6478", dark: "#9A93A6" },
    label: "Secondary text",
    help: "Pronouns, IDs, dates and other supporting detail.",
    memberOverridable: true,
  },
  {
    key: "color.accent",
    type: "color",
    default: { light: "#A23B72", dark: "#F58FC2" },
    label: "Accent",
    help: "Links and highlights.",
    memberOverridable: true,
  },
  {
    key: "color.border",
    type: "color",
    default: { light: "#E6E1EC", dark: "#302938" },
    label: "Lines",
    help: "Card edges and dividers.",
    memberOverridable: true,
  },
  {
    key: "font.body",
    type: "font",
    default: "system",
    label: "Body typeface",
    help: "Used for descriptions and general text.",
    memberOverridable: true,
  },
  {
    key: "font.heading",
    type: "font",
    default: "newsreader",
    label: "Heading typeface",
    help: "Used for names and section headings.",
    memberOverridable: true,
  },
  {
    key: "font.size",
    type: "enum",
    values: ["small", "medium", "large"],
    default: "medium",
    label: "Text size",
    help: "Overall reading size.",
    memberOverridable: true,
  },
  {
    key: "shape.radius",
    type: "enum",
    values: ["none", "small", "medium", "large"],
    default: "medium",
    label: "Corner rounding",
    help: "How rounded cards and images are.",
    memberOverridable: true,
  },
  {
    key: "surface.style",
    type: "enum",
    values: ["outlined", "filled", "plain"],
    default: "outlined",
    label: "Card style",
    help: "Cards can have an outline, a filled background, or neither.",
    memberOverridable: true,
  },
  {
    key: "density",
    type: "enum",
    values: ["compact", "normal", "relaxed"],
    default: "normal",
    label: "Spacing",
    help: "How much room everything is given.",
    memberOverridable: true,
  },
  {
    key: "avatar.shape",
    type: "enum",
    values: ["circle", "rounded", "square"],
    default: "rounded",
    label: "Avatar shape",
    help: "How avatars are cropped.",
    memberOverridable: true,
  },
];

export const THEME_TOKEN_MAP: ReadonlyMap<string, TokenDef> = new Map(
  THEME_TOKENS.map((t) => [t.key, t]),
);

export const THEME_TOKEN_KEYS: readonly string[] = THEME_TOKENS.map((t) => t.key);

/** Tokens a member may override on their own page. */
export const MEMBER_OVERRIDABLE_KEYS: readonly string[] = THEME_TOKENS.filter(
  (t) => t.memberOverridable,
).map((t) => t.key);

// ------------------------------------------------------ composition config

/**
 * Composition configuration.
 *
 * Deliberately a SEPARATE vocabulary with its own storage, not theme tokens
 * wearing a different hat. These change what is on the page and how it is
 * arranged; they are not styling, they do not become CSS custom properties,
 * and they belong in a different part of an editor.
 *
 * This is the reason `directory.card.min` never became a token. The renderer
 * needed a pixel value; the product concept is "how many columns", and the
 * pixel value is an implementation detail of expressing that.
 */
export type CompositionDef = EnumTokenDef | BooleanTokenDef;

export const COMPOSITION: readonly CompositionDef[] = [
  {
    key: "banner.display",
    type: "enum",
    values: ["auto", "hidden"],
    default: "auto",
    label: "Banner",
    help: "Show the banner from PluralKit when there is one.",
    memberOverridable: true,
  },
  {
    key: "avatar.size",
    type: "enum",
    values: ["small", "medium", "large"],
    default: "medium",
    label: "Avatar size",
    help: "How prominent the avatar is.",
    memberOverridable: true,
  },
  {
    key: "directory.columns",
    type: "enum",
    values: ["auto", "one", "two", "three"],
    default: "auto",
    label: "Member columns",
    help: "How many members sit side by side. Auto fits the reader's screen.",
    memberOverridable: false,
  },
  {
    key: "directory.card",
    type: "enum",
    values: ["compact", "detailed"],
    default: "compact",
    label: "Member cards",
    help: "Compact shows a name; detailed adds pronouns and a line of description.",
    memberOverridable: false,
  },
  {
    key: "directory.sort",
    type: "enum",
    values: ["pluralkit", "name"],
    default: "pluralkit",
    label: "Member order",
    help: "Keep PluralKit's order, or sort by name.",
    memberOverridable: false,
  },
  {
    key: "show.pronouns",
    type: "boolean",
    default: true,
    label: "Show pronouns",
    help: "Show pronouns where PluralKit makes them public.",
    memberOverridable: true,
  },
  {
    key: "show.birthday",
    type: "boolean",
    default: true,
    label: "Show birthday",
    help: "Show birthdays where PluralKit makes them public.",
    memberOverridable: true,
  },
];

export const COMPOSITION_MAP: ReadonlyMap<string, CompositionDef> = new Map(
  COMPOSITION.map((c) => [c.key, c]),
);

export const COMPOSITION_KEYS: readonly string[] = COMPOSITION.map((c) => c.key);
