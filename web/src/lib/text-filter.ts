/**
 * The match behind the model filter boxes (the Model sheet and a connection's
 * model picker; the conversation search still has its own): each word of the query has to
 * appear somewhere in `text`, in any order, ignoring case. A plain substring
 * match fails "claude 4.5" against "Claude Opus 4.5"; this does not.
 */
export function matchesQuery(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}
