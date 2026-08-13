"use client";

import Link from "next/link";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

// Renders note markdown. mention:// links become in-app links; images
// (attachment URLs) render inline and constrained.
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-note text-[13px] leading-relaxed [&_a]:text-blue-400 [&_a:hover]:underline [&_code]:rounded [&_code]:bg-accent [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px] [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-[13px] [&_h3]:font-semibold [&_img]:my-2 [&_img]:max-h-80 [&_img]:max-w-full [&_img]:rounded-md [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-1.5 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-accent [&_pre]:p-2 [&_table]:my-2 [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-0.5 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-0.5 [&_ul]:list-disc [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // The default transform strips unknown protocols, which would empty
        // out our mention:// hrefs before the component override sees them.
        urlTransform={(url) =>
          url.startsWith("mention://") ? url : defaultUrlTransform(url)
        }
        components={{
          a: ({ href, children: linkChildren }) => {
            const mention = /^mention:\/\/(contact|group)\/(\d+)$/.exec(
              href ?? ""
            );
            if (mention) {
              const target =
                mention[1] === "contact"
                  ? `/contacts/${mention[2]}`
                  : `/groups`;
              return (
                <Link
                  href={target}
                  className="rounded bg-accent px-1 py-0.5 font-medium !text-foreground no-underline hover:bg-accent/70"
                >
                  {linkChildren}
                </Link>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {linkChildren}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
