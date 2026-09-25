import type { RuntimePromptImage } from "@pace/core";

export type AttachmentKind = "image" | "text";

export type ComposerAttachment = {
  id: string;
  kind: AttachmentKind;
  name: string;
  sizeLabel: string;
  file: File;
  src?: string;
};

export const ATTACHMENT_REJECT_COPY =
  "Pace can only attach images and text files.";
export const TEXT_TOO_LARGE_COPY =
  "A text attachment is too large to inline into the prompt.";
export const IMAGE_TOO_LARGE_COPY =
  "An image attachment is too large to send.";
export const TEXT_ATTACHMENT_LIMIT_BYTES = 256 * 1024;
export const IMAGE_ATTACHMENT_LIMIT_BYTES = 8 * 1024 * 1024;
export const FILE_ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.txt,.md,.ts,.tsx,.js,.jsx,.mjs,.cjs,.json,.css,.html,.yml,.yaml,.toml,.rs,.go,.py,.rb,.sh";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const TEXT_EXT =
  /\.(txt|md|tsx?|jsx?|mjs|cjs|json|css|html?|ya?ml|toml|rs|go|py|rb|sh)$/i;
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export function classifyFile(file: File): AttachmentKind | "reject" {
  if (file.type.startsWith("image/")) {
    return "image";
  }

  if (file.type.startsWith("text/") || file.type === "application/json") {
    return "text";
  }

  if (IMAGE_EXT.test(file.name)) {
    return "image";
  }

  if (TEXT_EXT.test(file.name)) {
    return "text";
  }

  return "reject";
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function imageMimeType(file: File) {
  if (file.type.startsWith("image/")) {
    return file.type;
  }

  const ext = file.name.split(".").pop()?.toLowerCase();

  return (ext && IMAGE_MIME_BY_EXT[ext]) || "image/png";
}

async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }

  return btoa(binary);
}

export async function buildPromptWithAttachments(
  draft: string,
  items: ComposerAttachment[],
): Promise<
  | { ok: true; prompt: string; images: RuntimePromptImage[] }
  | { ok: false; error: string }
> {
  const chunks: string[] = [];
  const images: RuntimePromptImage[] = [];
  // Token spacing: the editable keeps the NBSP Astryx inserts after inline
  // tokens, but Pi splits command arguments on plain spaces. Normalize on
  // the way out only — writing back into the draft would flatten tokens.
  const trimmed = draft.replace(/\u00A0/g, " ").trim();

  if (trimmed) {
    chunks.push(trimmed);
  }

  for (const item of items) {
    if (item.kind === "image") {
      if (item.file.size > IMAGE_ATTACHMENT_LIMIT_BYTES) {
        return { ok: false, error: IMAGE_TOO_LARGE_COPY };
      }

      images.push({
        mimeType: imageMimeType(item.file),
        data: await fileToBase64(item.file),
        name: item.name,
      });
      continue;
    }

    if (item.file.size > TEXT_ATTACHMENT_LIMIT_BYTES) {
      return { ok: false, error: TEXT_TOO_LARGE_COPY };
    }

    const body = await item.file.text();
    chunks.push(`[Attached file: ${item.name}]\n\n\`\`\`\n${body}\n\`\`\``);
  }

  const prompt = chunks.join("\n\n");

  if (!prompt && images.length === 0) {
    return { ok: false, error: "Type a message or attach a file." };
  }

  return { ok: true, prompt, images };
}
