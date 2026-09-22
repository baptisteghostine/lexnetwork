import { describe, expect, it } from "vitest";

import { underlineTransform } from "@/lib/notes/underline";

// SPEC §2: `<u>` is the one HTML tag notes render; everything else that
// looks like HTML stays inert. The transform works on the mdast shape
// remark-parse produces — inline HTML tags arrive as separate `html`
// siblings around ordinary text.

const html = (value: string) => ({ type: "html", value });
const text = (value: string) => ({ type: "text", value });

describe("underlineTransform", () => {
  it("wraps the siblings between <u> and </u> in an underline node", () => {
    const tree = {
      type: "paragraph",
      children: [text("a "), html("<u>"), text("b"), html("</u>"), text(" c")],
    };
    underlineTransform(tree);
    expect(tree.children).toEqual([
      text("a "),
      { type: "underline", data: { hName: "u" }, children: [text("b")] },
      text(" c"),
    ]);
  });

  it("leaves an unclosed <u> and other tags as inert html nodes", () => {
    const tree = {
      type: "paragraph",
      children: [html("<u>"), text("b"), html("<script>"), text("x")],
    };
    underlineTransform(tree);
    expect(tree.children).toEqual([html("<u>"), text("b"), html("<script>"), text("x")]);
  });

  it("recurses into nested containers", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "list",
          children: [
            {
              type: "listItem",
              children: [
                { type: "paragraph", children: [html("<U>"), text("deep"), html("</U>")] },
              ],
            },
          ],
        },
      ],
    };
    underlineTransform(tree);
    const para = tree.children[0].children[0].children[0];
    expect(para.children).toEqual([
      { type: "underline", data: { hName: "u" }, children: [text("deep")] },
    ]);
  });
});
