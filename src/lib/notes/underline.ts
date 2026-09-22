// Underline for note markdown (SPEC §2, owner request 2026-09-22).
// Markdown has no underline syntax, and the renderer deliberately does
// not accept raw HTML. This remark plugin recognises exactly one tag
// pair — `<u>…</u>` — and turns it into a node that mdast-util-to-hast
// renders as a <u> element via `data.hName`, so nothing else that looks
// like HTML in a note ever reaches the DOM. Pure: no unified imports, a
// hand-rolled walk over the mdast tree.

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
};

const OPEN = /^<u>$/i;
const CLOSE = /^<\/u>$/i;

/** Exported for tests: rewrites `children` of every parent in place. */
export function underlineTransform(tree: MdNode): void {
  if (!tree.children) return;
  const out: MdNode[] = [];
  let i = 0;
  const kids = tree.children;
  while (i < kids.length) {
    const node = kids[i];
    if (node.type === "html" && node.value && OPEN.test(node.value.trim())) {
      // Find the matching close tag among the following siblings.
      let j = i + 1;
      while (j < kids.length) {
        const c = kids[j];
        if (c.type === "html" && c.value && CLOSE.test(c.value.trim())) break;
        j++;
      }
      if (j < kids.length) {
        const inner = kids.slice(i + 1, j);
        for (const n of inner) underlineTransform(n);
        out.push({ type: "underline", data: { hName: "u" }, children: inner });
        i = j + 1;
        continue;
      }
    }
    underlineTransform(node);
    out.push(node);
    i++;
  }
  tree.children = out;
}

/** remark plugin: `.use(remarkUnderline)`. */
export function remarkUnderline() {
  return (tree: MdNode) => underlineTransform(tree);
}
