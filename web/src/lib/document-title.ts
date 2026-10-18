/**
 * The browser tab's title, naming the open agent.
 *
 * With several tabs open, or one backgrounded on a phone, the tab strip is the
 * only place that says which agent a tab belongs to without switching to it.
 */

const APP_NAME = "Lettuce";

export function documentTitle(agentName: string | null): string {
  const name = agentName?.trim();
  return name ? `${name} | ${APP_NAME}` : APP_NAME;
}

export function applyDocumentTitle(agentName: string | null): void {
  if (typeof document === "undefined") return;
  document.title = documentTitle(agentName);
}
