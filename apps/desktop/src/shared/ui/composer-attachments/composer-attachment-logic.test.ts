import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_REJECT_COPY,
  IMAGE_ATTACHMENT_LIMIT_BYTES,
  IMAGE_TOO_LARGE_COPY,
  TEXT_ATTACHMENT_LIMIT_BYTES,
  TEXT_TOO_LARGE_COPY,
  buildPromptWithAttachments,
  classifyFile,
  formatBytes,
} from "./composer-attachment-logic";

function file(name: string, type: string, body = "hello") {
  return new File([body], name, { type });
}

describe("classifyFile", () => {
  it("accepts images by MIME type", () => {
    expect(classifyFile(file("shot.webp", "image/webp"))).toBe("image");
  });

  it("accepts images by extension when MIME is empty", () => {
    expect(classifyFile(file("diagram.PNG", ""))).toBe("image");
  });

  it("accepts text and JSON by MIME type", () => {
    expect(classifyFile(file("notes.txt", "text/plain"))).toBe("text");
    expect(classifyFile(file("pkg.json", "application/json"))).toBe("text");
  });

  it("accepts code files by extension", () => {
    expect(classifyFile(file("chat-prompt-input.tsx", ""))).toBe("text");
  });

  it("rejects other types", () => {
    expect(classifyFile(file("archive.zip", "application/zip"))).toBe("reject");
    expect(classifyFile(file("clip.mp4", "video/mp4"))).toBe("reject");
  });
});

describe("formatBytes", () => {
  it("uses B, KB, and MB", () => {
    expect(formatBytes(400)).toBe("400 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});

describe("buildPromptWithAttachments", () => {
  it("normalizes non-breaking spaces left by token insertion", async () => {
    // Tokens serialize with a trailing   (Astryx insertToken); Pi splits
    // command arguments on plain spaces only, so the submit path converts.
    await expect(
      buildPromptWithAttachments("/skill:review-pr\u00A0参数", []),
    ).resolves.toEqual({
      ok: true,
      prompt: "/skill:review-pr 参数",
      images: [],
    });
  });

  it("returns the trimmed draft when there are no attachments", async () => {
    await expect(buildPromptWithAttachments("  hello  ", [])).resolves.toEqual({
      ok: true,
      prompt: "hello",
      images: [],
    });
  });

  it("inlines text files after the draft", async () => {
    const result = await buildPromptWithAttachments("look at this", [
      {
        id: "1",
        kind: "text",
        name: "notes.md",
        sizeLabel: "5 B",
        file: file("notes.md", "text/markdown", "line"),
      },
    ]);

    expect(result).toEqual({
      ok: true,
      prompt: "look at this\n\n[Attached file: notes.md]\n\n```\nline\n```",
      images: [],
    });
  });

  it("allows a text file with an empty draft", async () => {
    const result = await buildPromptWithAttachments("   ", [
      {
        id: "1",
        kind: "text",
        name: "only.txt",
        sizeLabel: "2 B",
        file: file("only.txt", "text/plain", "ok"),
      },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prompt).toContain("only.txt");
      expect(result.prompt).toContain("ok");
    }
  });

  it("encodes images as prompt attachments instead of inlining them", async () => {
    const result = await buildPromptWithAttachments("see this", [
      {
        id: "1",
        kind: "image",
        name: "shot.png",
        sizeLabel: "1 KB",
        file: file("shot.png", "image/png", "pixels"),
      },
    ]);

    expect(result).toEqual({
      ok: true,
      prompt: "see this",
      images: [
        {
          mimeType: "image/png",
          data: btoa("pixels"),
          name: "shot.png",
        },
      ],
    });
  });

  it("allows an image-only prompt", async () => {
    const result = await buildPromptWithAttachments("   ", [
      {
        id: "1",
        kind: "image",
        name: "shot.png",
        sizeLabel: "1 KB",
        file: file("shot.png", "image/png", "pixels"),
      },
    ]);

    expect(result).toEqual({
      ok: true,
      prompt: "",
      images: [
        {
          mimeType: "image/png",
          data: btoa("pixels"),
          name: "shot.png",
        },
      ],
    });
  });

  it("refuses oversized images", async () => {
    const body = "x".repeat(IMAGE_ATTACHMENT_LIMIT_BYTES + 1);

    await expect(
      buildPromptWithAttachments("see this", [
        {
          id: "1",
          kind: "image",
          name: "huge.png",
          sizeLabel: "9 MB",
          file: file("huge.png", "image/png", body),
        },
      ]),
    ).resolves.toEqual({
      ok: false,
      error: IMAGE_TOO_LARGE_COPY,
    });
  });

  it("refuses oversized text files", async () => {
    const body = "x".repeat(TEXT_ATTACHMENT_LIMIT_BYTES + 1);

    await expect(
      buildPromptWithAttachments("", [
        {
          id: "1",
          kind: "text",
          name: "huge.md",
          sizeLabel: "257 KB",
          file: file("huge.md", "text/markdown", body),
        },
      ]),
    ).resolves.toEqual({
      ok: false,
      error: TEXT_TOO_LARGE_COPY,
    });
  });

  it("exports the reject copy used by intake", () => {
    expect(ATTACHMENT_REJECT_COPY).toBe(
      "Pace can only attach images and text files.",
    );
  });
});
