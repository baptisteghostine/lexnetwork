/*
 * Circular avatar with initials fallback (Dex treatment). Photos come from
 * the auth-gated /api/photos route; contacts without one get deterministic
 * pastel initials so the same person always looks the same.
 */

const BG = [
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-pink-500/15 text-pink-700 dark:text-pink-300",
];

const SIZES = {
  sm: "size-6 text-[10px]",
  md: "size-8 text-[11px]",
  lg: "size-14 text-lg",
} as const;

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]][0] ?? "?";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toUpperCase();
}

function hue(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 997;
  return BG[h % BG.length];
}

export function ContactAvatar({
  contactId,
  name,
  hasPhoto,
  size = "md",
}: {
  contactId: number;
  name: string;
  hasPhoto: boolean;
  size?: keyof typeof SIZES;
}) {
  if (hasPhoto) {
    // Plain <img>: photos come from a local auth-gated API route where
    // next/image optimization adds nothing for same-origin private files.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/photos/${contactId}`}
        alt=""
        className={`${SIZES[size]} shrink-0 rounded-full object-cover`}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`${SIZES[size]} ${hue(name)} flex shrink-0 select-none items-center justify-center rounded-full font-semibold`}
    >
      {initials(name)}
    </span>
  );
}
