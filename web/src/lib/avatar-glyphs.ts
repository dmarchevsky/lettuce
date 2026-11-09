/**
 * The glyph library an agent's face is chosen from (`AvatarSheet`), and the words
 * the sheet's filter matches.
 *
 * A glyph has no text of its own, so `keywords` *is* the search index: a glyph
 * whose keywords nobody would type is a glyph that does not belong in the list.
 * Ours, not upstream's — there is nothing upstream to pick a glyph from.
 *
 * Two rules were applied while building the list, because a glyph a device cannot
 * draw is worse than a missing one:
 *
 * - **nothing from the U+1FAE0 block** — 🫠 🫡 🫥 and their neighbours are older
 *   than they look: Apple shipped them only with iOS 16.4 in 2023, and this app is
 *   opened on whatever phone happens to be nearby;
 * - **no ZWJ sequences** — a two-codepoint sequence is one tile that some fonts
 *   draw as two, which reads as a bug in the picker rather than in the font.
 *
 * `avatar-glyphs.test.ts` enforces both, and re-checks the count, the
 * six-category shape and that nothing is listed twice. All 144 were also checked
 * against the emoji font on the dev machine (Noto, which is what Android ships).
 */

export interface GlyphEntry {
  glyph: string;
  keywords: string[];
}

export interface GlyphCategory {
  id: string;
  label: string;
  glyphs: GlyphEntry[];
}

export const GLYPH_CATEGORIES: GlyphCategory[] = [
  {
    id: "animals",
    label: "Animals",
    glyphs: [
      { glyph: "🦊", keywords: ["fox", "vixen", "sly"] },
      { glyph: "🦉", keywords: ["owl", "bird", "wise", "night"] },
      { glyph: "🦁", keywords: ["lion", "king", "mane"] },
      { glyph: "🐯", keywords: ["tiger", "cat", "stripe"] },
      { glyph: "🐼", keywords: ["panda", "bamboo", "bear"] },
      { glyph: "🐨", keywords: ["koala", "bear", "aussie"] },
      { glyph: "🐘", keywords: ["elephant", "tusk", "big"] },
      { glyph: "🐎", keywords: ["horse", "mare", "race"] },
      { glyph: "🐕", keywords: ["dog", "puppy", "hound"] },
      { glyph: "🐈", keywords: ["cat", "kitten", "feline"] },
      { glyph: "🐇", keywords: ["rabbit", "bunny", "hare"] },
      { glyph: "🐢", keywords: ["turtle", "tortoise", "slow"] },
      { glyph: "🐬", keywords: ["dolphin", "sea", "ocean"] },
      { glyph: "🐳", keywords: ["whale", "sea", "ocean"] },
      { glyph: "🐙", keywords: ["octopus", "tentacle", "ink"] },
      { glyph: "🐸", keywords: ["frog", "toad", "green"] },
      { glyph: "🐧", keywords: ["penguin", "linux", "cold"] },
      { glyph: "🦄", keywords: ["unicorn", "magic", "myth"] },
      { glyph: "🦅", keywords: ["eagle", "bird", "raptor"] },
      { glyph: "🦋", keywords: ["butterfly", "moth", "wing"] },
      { glyph: "🐍", keywords: ["snake", "serpent", "viper"] },
      { glyph: "🐝", keywords: ["bee", "wasp", "honey", "buzz"] },
      { glyph: "🐾", keywords: ["paw", "paws", "pet", "tracks"] },
      { glyph: "🦕", keywords: ["dinosaur", "brontosaurus", "rex"] },
    ],
  },
  {
    id: "mood",
    label: "Mood",
    glyphs: [
      { glyph: "😀", keywords: ["smile", "happy", "grin"] },
      { glyph: "🙂", keywords: ["smile", "slight", "fine"] },
      { glyph: "😉", keywords: ["wink", "flirt", "joking"] },
      { glyph: "😎", keywords: ["cool", "sunglasses", "confident"] },
      { glyph: "🤓", keywords: ["nerd", "geek", "glasses"] },
      { glyph: "🤔", keywords: ["think", "thinking", "hmm"] },
      { glyph: "😴", keywords: ["sleep", "sleepy", "night"] },
      { glyph: "🥱", keywords: ["yawn", "bored", "tired"] },
      { glyph: "😇", keywords: ["angel", "innocent", "halo"] },
      { glyph: "😈", keywords: ["devil", "mischief", "imp"] },
      { glyph: "👻", keywords: ["ghost", "boo", "spooky"] },
      { glyph: "💀", keywords: ["skull", "dead", "danger"] },
      { glyph: "☠️", keywords: ["skull", "bones", "poison"] },
      { glyph: "🤡", keywords: ["clown", "joke", "silly"] },
      { glyph: "😡", keywords: ["angry", "mad", "rage"] },
      { glyph: "🥳", keywords: ["party", "celebrate", "hooray"] },
      { glyph: "😢", keywords: ["cry", "sad", "tears"] },
      { glyph: "😱", keywords: ["scream", "shock", "fear"] },
      { glyph: "🤐", keywords: ["silent", "quiet", "zip it"] },
      { glyph: "😷", keywords: ["mask", "sick", "ill"] },
      { glyph: "🤠", keywords: ["cowboy", "western", "yeehaw"] },
      { glyph: "😏", keywords: ["smirk", "sly", "smug"] },
      { glyph: "🥶", keywords: ["cold", "freezing", "frozen"] },
      { glyph: "🙌", keywords: ["raise hands", "praise", "hooray"] },
    ],
  },
  {
    id: "talking",
    label: "Talking",
    glyphs: [
      { glyph: "✉️", keywords: ["mail", "email", "envelope", "message"] },
      { glyph: "📬", keywords: ["mailbox", "inbox", "mail"] },
      { glyph: "📮", keywords: ["postbox", "post", "mail"] },
      { glyph: "💬", keywords: ["speech", "bubble", "chat", "comment"] },
      { glyph: "💭", keywords: ["thought", "bubble", "dream"] },
      { glyph: "🔔", keywords: ["bell", "notification", "alert"] },
      { glyph: "🔕", keywords: ["mute", "bell off", "quiet"] },
      { glyph: "📢", keywords: ["loudspeaker", "announce", "shout"] },
      { glyph: "📣", keywords: ["megaphone", "cheer", "announce"] },
      { glyph: "📌", keywords: ["pin", "note", "keep"] },
      { glyph: "📎", keywords: ["clip", "attach", "paperclip"] },
      { glyph: "✅", keywords: ["check", "done", "yes", "ok"] },
      { glyph: "❌", keywords: ["cross", "no", "fail", "cancel"] },
      { glyph: "❓", keywords: ["question", "ask", "help"] },
      { glyph: "💯", keywords: ["hundred", "perfect", "score"] },
      { glyph: "👍", keywords: ["thumbs up", "yes", "like"] },
      { glyph: "🙏", keywords: ["please", "thanks", "pray"] },
      { glyph: "🤝", keywords: ["handshake", "deal", "agreement"] },
      { glyph: "✍️", keywords: ["writing", "sign", "handwriting"] },
      { glyph: "📝", keywords: ["memo", "note", "write", "edit"] },
      { glyph: "📋", keywords: ["clipboard", "list", "todo"] },
      { glyph: "🆕", keywords: ["new", "fresh", "badge"] },
      { glyph: "🟢", keywords: ["dot", "online", "green", "live"] },
      { glyph: "🔴", keywords: ["dot", "recording", "red", "live"] },
    ],
  },
  {
    id: "nature",
    label: "Nature",
    glyphs: [
      { glyph: "☀️", keywords: ["sun", "sunny", "day", "bright"] },
      { glyph: "🌤️", keywords: ["sun behind cloud", "partly cloudy", "weather"] },
      { glyph: "☁️", keywords: ["cloud", "cloudy", "overcast"] },
      { glyph: "🌧️", keywords: ["rain", "rainy", "wet", "weather"] },
      { glyph: "⛈️", keywords: ["storm", "thunder", "lightning"] },
      { glyph: "❄️", keywords: ["snow", "snowflake", "winter"] },
      { glyph: "🌈", keywords: ["rainbow", "pride", "color"] },
      { glyph: "🌊", keywords: ["wave", "sea", "water", "surf"] },
      { glyph: "🌋", keywords: ["volcano", "lava", "eruption"] },
      { glyph: "⛰️", keywords: ["mountain", "peak", "hill"] },
      { glyph: "🏔️", keywords: ["snow mountain", "peak", "alps"] },
      { glyph: "🏝️", keywords: ["island", "beach", "palm"] },
      { glyph: "🏕️", keywords: ["camp", "tent", "camping"] },
      { glyph: "🌲", keywords: ["pine", "evergreen", "forest"] },
      { glyph: "🌳", keywords: ["tree", "oak", "green"] },
      { glyph: "🍀", keywords: ["clover", "lucky", "shamrock"] },
      { glyph: "🍁", keywords: ["maple", "autumn", "fall"] },
      { glyph: "🌸", keywords: ["cherry blossom", "spring", "flower"] },
      { glyph: "🌻", keywords: ["sunflower", "summer", "flower"] },
      { glyph: "🌵", keywords: ["cactus", "desert", "succulent"] },
      { glyph: "🍄", keywords: ["mushroom", "toadstool", "fungus"] },
      { glyph: "🌙", keywords: ["moon", "crescent", "night"] },
      { glyph: "🍎", keywords: ["apple", "fruit", "red"] },
      { glyph: "☕", keywords: ["coffee", "tea", "cafe", "morning"] },
    ],
  },
  {
    id: "work",
    label: "Work",
    glyphs: [
      { glyph: "🛠️", keywords: ["tools", "fix", "workshop", "repair"] },
      { glyph: "⚙️", keywords: ["gear", "settings", "config", "cog"] },
      { glyph: "🔧", keywords: ["wrench", "fix", "adjust"] },
      { glyph: "🔨", keywords: ["hammer", "build", "nail"] },
      { glyph: "⛏️", keywords: ["pickaxe", "mine", "dig"] },
      { glyph: "🧰", keywords: ["toolbox", "toolkit", "kit"] },
      { glyph: "🪛", keywords: ["screwdriver", "fix", "screw"] },
      { glyph: "🤖", keywords: ["robot", "bot", "ai", "agent"] },
      { glyph: "🖥️", keywords: ["desktop", "computer", "monitor", "server"] },
      { glyph: "💻", keywords: ["laptop", "computer", "code"] },
      { glyph: "⌨️", keywords: ["keyboard", "type", "keys"] },
      { glyph: "💾", keywords: ["floppy", "save", "disk"] },
      { glyph: "🗄️", keywords: ["cabinet", "records", "archive"] },
      { glyph: "📦", keywords: ["package", "box", "module", "crate"] },
      { glyph: "🔗", keywords: ["link", "chain", "url"] },
      { glyph: "🔍", keywords: ["search", "magnify", "find"] },
      { glyph: "🔬", keywords: ["microscope", "science", "lab"] },
      { glyph: "🧪", keywords: ["test tube", "test", "experiment"] },
      { glyph: "📐", keywords: ["triangle ruler", "design", "angle"] },
      { glyph: "📊", keywords: ["chart", "bar graph", "data", "metrics"] },
      { glyph: "📈", keywords: ["chart up", "growth", "trend"] },
      { glyph: "📚", keywords: ["books", "library", "docs", "study"] },
      { glyph: "💡", keywords: ["idea", "bulb", "insight", "lamp"] },
      { glyph: "🧲", keywords: ["magnet", "attract", "pull"] },
    ],
  },
  {
    id: "abstract",
    label: "Symbols",
    glyphs: [
      { glyph: "⭐", keywords: ["star", "favorite", "starred"] },
      { glyph: "✨", keywords: ["sparkles", "magic", "shine", "new"] },
      { glyph: "⚡", keywords: ["lightning", "bolt", "fast", "power"] },
      { glyph: "🔥", keywords: ["fire", "flame", "hot", "burn"] },
      { glyph: "💧", keywords: ["drop", "water", "drip"] },
      { glyph: "🎯", keywords: ["target", "aim", "bullseye", "goal"] },
      { glyph: "🏆", keywords: ["trophy", "winner", "award"] },
      { glyph: "🎨", keywords: ["art", "palette", "paint", "design"] },
      { glyph: "🎧", keywords: ["headphones", "music", "listen"] },
      { glyph: "🎲", keywords: ["dice", "random", "chance"] },
      { glyph: "🧩", keywords: ["puzzle", "piece", "plugin", "extension"] },
      { glyph: "🔒", keywords: ["lock", "private", "secure"] },
      { glyph: "🔓", keywords: ["unlock", "open lock", "public"] },
      { glyph: "🔑", keywords: ["key", "secret", "access", "token"] },
      { glyph: "🛡️", keywords: ["shield", "defense", "protect"] },
      { glyph: "🧠", keywords: ["brain", "smart", "memory", "mind"] },
      { glyph: "👁️", keywords: ["eye", "see", "watch", "vision"] },
      { glyph: "🛰️", keywords: ["satellite", "orbit", "signal"] },
      { glyph: "🚀", keywords: ["rocket", "launch", "ship it"] },
      { glyph: "🌍", keywords: ["earth", "world", "globe"] },
      { glyph: "⏰", keywords: ["clock", "alarm", "time", "cron"] },
      { glyph: "⌛", keywords: ["hourglass", "waiting", "timer"] },
      { glyph: "⚖️", keywords: ["scales", "balance", "justice"] },
      { glyph: "♻️", keywords: ["recycle", "reuse", "loop"] },
    ],
  },
];

/** Every glyph in the library, in category order. */
export const ALL_GLYPHS: GlyphEntry[] = GLYPH_CATEGORIES.flatMap((category) => category.glyphs);

/**
 * Does this glyph answer the query? Matched against the keywords and against the
 * glyph itself (so pasting a glyph into the box narrows to it), case-insensitively,
 * as a substring — a person types "fox", not "U+1F98A".
 */
export function glyphMatches(entry: GlyphEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return entry.glyph.includes(needle) || entry.keywords.some((word) => word.includes(needle));
}

/**
 * The sections the sheet renders: one per category, narrowed by `query` and/or a
 * category chip. Empty sections drop out, so a query that matches nothing in
 * "Mood" leaves no heading with nothing under it.
 */
export function glyphSections(
  query: string,
  categoryId: string | null,
): { label: string; glyphs: GlyphEntry[] }[] {
  return GLYPH_CATEGORIES.filter((category) => categoryId === null || category.id === categoryId)
    .map((category) => ({
      label: category.label,
      glyphs: category.glyphs.filter((entry) => glyphMatches(entry, query)),
    }))
    .filter((section) => section.glyphs.length > 0);
}

/** The glyphs a query matches, flat. */
export function searchGlyphs(query: string): GlyphEntry[] {
  return ALL_GLYPHS.filter((entry) => glyphMatches(entry, query));
}
