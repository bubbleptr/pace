import { Link } from "@astryxdesign/core/Link";
import type { ReactNode } from "react";
import { FileIcon } from "@/shared/ui/icons";

export type ChatFileRef = { path: string; name: string; line?: number };

/**
 * Whether an href names a local file rather than a URL or document anchor.
 * The scheme check deliberately only matches `scheme://`: `file.ts:12` is a
 * path with a line suffix, not a scheme. Line forms mirror
 * `parseSessionChangeLink` (`:N`, `:N:M`, `#LN`, `#LN-LM`) so a chip's label
 * matches what the click resolves to.
 */
export function parseChatFileHref(href: string): ChatFileRef | null {
  if (
    !href ||
    /^[#?]/.test(href) ||
    href.startsWith("//") ||
    href.includes("\\") ||
    /^(mailto|tel|data|javascript):/i.test(href) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(href)
  ) {
    return null;
  }
  const [pathPart, hash = ""] = href.split("#", 2);
  const suffix = /:(\d+)(?::\d+)?$/.exec(pathPart ?? "");
  const path = suffix ? pathPart!.slice(0, suffix.index) : (pathPart ?? "");
  if (!path) return null;
  const line = Number(/^L(\d+)(?:-L?\d+)?$/.exec(hash)?.[1] ?? suffix?.[1]);
  // A trailing slash names a directory; keep it so `docs/` doesn't read as a
  // file named `docs`.
  const trimmed = path.replace(/\/+$/, "");
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (!base) return null;
  const name = path.endsWith("/") ? `${base}/` : base;
  return {
    path,
    name,
    ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
  };
}

function plainTextOf(children: ReactNode): string | null {
  if (typeof children === "string") return children;
  if (
    Array.isArray(children) &&
    children.every((part) => typeof part === "string")
  ) {
    return children.join("");
  }
  return null;
}

/**
 * Link renderer for chat Markdown with `fileLinks` on. Local file targets get
 * a compact chip (icon + basename[:line]) when the model's label just repeats
 * the target; custom prose labels keep their text. Everything else renders
 * through Astryx Link exactly as the default renderer did — http(s) opens in
 * a new tab, other schemes stay plain anchors.
 */
export function ChatFileLink({
  href,
  children,
}: {
  href: string;
  children?: ReactNode;
}) {
  const file = parseChatFileHref(href);
  if (!file) {
    const external = /^https?:\/\//.test(href);
    return (
      <Link
        color="accent"
        hasUnderline
        href={href}
        type="inherit"
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {children}
      </Link>
    );
  }
  const text = plainTextOf(children);
  const compact =
    text !== null &&
    (text === href ||
      text === file.path ||
      (file.line !== undefined && text === `${file.path}:${file.line}`));
  return (
    <a
      className="chat-file-link"
      data-slot="chat-file-link"
      href={href}
      title={file.line ? `${file.path}:${file.line}` : file.path}
    >
      <FileIcon aria-hidden className="chat-file-link__icon" />
      {compact ? (file.line ? `${file.name}:${file.line}` : file.name) : children}
    </a>
  );
}
