export {
  ATTACHMENT_REJECT_COPY,
  FILE_ACCEPT,
  IMAGE_ATTACHMENT_LIMIT_BYTES,
  IMAGE_TOO_LARGE_COPY,
  TEXT_ATTACHMENT_LIMIT_BYTES,
  TEXT_TOO_LARGE_COPY,
  buildPromptWithAttachments,
  classifyFile,
  type ComposerAttachment,
} from "./composer-attachment-logic";
export { ComposerAttachmentDrawer } from "./composer-attachment-drawer";
export {
  ComposerInsertMenu,
  type ComposerInsertCatalog,
} from "./composer-insert-menu";
export {
  useComposerAttachments,
  useFilePicker,
} from "./use-composer-attachments";
