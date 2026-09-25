import { useCallback, useEffect, useRef, useState } from "react";
import {
  ATTACHMENT_REJECT_COPY,
  FILE_ACCEPT,
  classifyFile,
  formatBytes,
  type ComposerAttachment,
} from "./composer-attachment-logic";

export function useComposerAttachments() {
  const [items, setItems] = useState<ComposerAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const addFiles = useCallback((files: File[]) => {
    if (!files.length) {
      return;
    }

    const next: ComposerAttachment[] = [];
    let rejected = 0;

    for (const file of files) {
      const kind = classifyFile(file);

      if (kind === "reject") {
        rejected += 1;
        continue;
      }

      const src = kind === "image" ? URL.createObjectURL(file) : undefined;
      next.push({
        id: `local-${crypto.randomUUID()}`,
        kind,
        name: file.name,
        sizeLabel: formatBytes(file.size),
        file,
        src,
      });
    }

    if (next.length) {
      setItems((current) => [...current, ...next]);
    }

    setError(rejected ? ATTACHMENT_REJECT_COPY : null);
  }, []);

  const remove = useCallback((id: string) => {
    setItems((current) => {
      const target = current.find((item) => item.id === id);

      if (target?.src) {
        URL.revokeObjectURL(target.src);
      }

      return current.filter((item) => item.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setItems((current) => {
      for (const item of current) {
        if (item.src) {
          URL.revokeObjectURL(item.src);
        }
      }

      return [];
    });
    setError(null);
  }, []);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    return () => {
      for (const item of itemsRef.current) {
        if (item.src) {
          URL.revokeObjectURL(item.src);
        }
      }
    };
  }, []);

  return { items, error, setError, addFiles, remove, clear };
}

export function useFilePicker(onFiles: (files: File[]) => void) {
  const ref = useRef<HTMLInputElement | null>(null);

  return {
    open: () => ref.current?.click(),
    input: (
      <input
        ref={ref}
        accept={FILE_ACCEPT}
        className="sr-only"
        multiple
        tabIndex={-1}
        type="file"
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
    ),
  };
}
