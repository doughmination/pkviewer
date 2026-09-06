/**
 * Renders a system's compiled custom CSS.
 *
 * The text arriving here has already been through the compiler in
 * `packages/shared/src/css/sanitize.ts`: allow-listed property by property,
 * every selector rewritten under `#pkv-user`, `url()` and `!important` refused.
 * This component deliberately does NOT check it again.
 *
 * That is a decision, not an omission. Two validators means two things to keep
 * in step, and the moment they disagree the weaker one is the real policy.
 * There is one boundary and it is on the write path, so what a page serves is
 * exactly what was checked when it was saved.
 *
 * `dangerouslySetInnerHTML` is how a <style> gets text content in React; it is
 * not an HTML injection point. `</style>` is the only sequence that could
 * escape the element, and the compiler cannot emit it: `<` and `/` survive
 * neither a selector's character class nor a declaration value.
 */
export function CustomStyle({ css }: { css: string }) {
  if (!css) return null;
  return <style data-pkv-custom="" dangerouslySetInnerHTML={{ __html: css }} />;
}
