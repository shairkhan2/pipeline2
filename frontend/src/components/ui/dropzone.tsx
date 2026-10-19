"use client";

import { createContext, useCallback, useContext, useId, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";

/** Maps a MIME type to the file extensions that count as a match, e.g. `{ "text/csv": [".csv"] }`. */
export type DropzoneAccept = Record<string, string[]>;

/** One reason a file was rejected; a file can carry more than one. */
export type DropzoneRejectionReason = "accept" | "maxSize" | "minSize" | "maxFiles";

/** A file `Dropzone` rejected, with every rule it failed. */
export type DropzoneRejection = { file: File; reasons: DropzoneRejectionReason[] };

/** True when `file` matches `accept` by MIME type (exact or `type/*` wildcard) or by extension. */
export function matchesAccept(file: File, accept: DropzoneAccept): boolean {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  for (const [mime, extensions] of Object.entries(accept)) {
    if (mime === "*/*") return true;
    if (mime.endsWith("/*") && type.startsWith(mime.slice(0, -1))) return true;
    if (type !== "" && type === mime.toLowerCase()) return true;
    if (extensions.some((ext) => name.endsWith(ext.toLowerCase()))) return true;
  }
  return false;
}

/** Options for {@link filterFiles}. */
export type FilterFilesOptions = {
  accept?: DropzoneAccept;
  maxSize?: number;
  minSize?: number;
  maxFiles?: number;
};

/** Result of {@link filterFiles}. */
export type FilterFilesResult = { accepted: File[]; rejections: DropzoneRejection[] };

/**
 * Splits `files` into accepted and rejected by `accept` (MIME or extension), `minSize`/`maxSize`
 * (bytes), and `maxFiles` (a count over the limit rejects the excess files, keeping file order).
 */
export function filterFiles(files: readonly File[], options: FilterFilesOptions = {}): FilterFilesResult {
  const { accept, maxSize, minSize, maxFiles } = options;
  const accepted: File[] = [];
  const rejections: DropzoneRejection[] = [];

  for (const file of files) {
    const reasons: DropzoneRejectionReason[] = [];
    if (accept && !matchesAccept(file, accept)) reasons.push("accept");
    if (maxSize !== undefined && file.size > maxSize) reasons.push("maxSize");
    if (minSize !== undefined && file.size < minSize) reasons.push("minSize");
    if (reasons.length > 0) {
      rejections.push({ file, reasons });
      continue;
    }
    accepted.push(file);
  }

  if (maxFiles !== undefined && accepted.length > maxFiles) {
    const overflow = accepted.splice(maxFiles);
    rejections.push(...overflow.map((file) => ({ file, reasons: ["maxFiles"] as DropzoneRejectionReason[] })));
  }

  return { accepted, rejections };
}

type DropzoneContextValue = {
  src?: File[];
  isDragActive: boolean;
  disabled: boolean;
  accept?: DropzoneAccept;
  maxSize?: number;
};

const DropzoneContext = createContext<DropzoneContextValue | null>(null);

function useDropzoneContext(component: string): DropzoneContextValue {
  const context = useContext(DropzoneContext);
  if (!context) throw new Error(`${component} must be rendered inside <Dropzone>`);
  return context;
}

/** Props for {@link Dropzone}. */
export type DropzoneProps = {
  className?: string;
  children?: ReactNode;
  /** MIME-to-extensions map filtering which files are accepted; omit to accept every file. */
  accept?: DropzoneAccept;
  /** Maximum number of files accepted per drop/pick; also sets the file input's `multiple` (true unless this is 1). Default unlimited. */
  maxFiles?: number;
  /** Maximum file size in bytes. */
  maxSize?: number;
  /** Minimum file size in bytes. */
  minSize?: number;
  disabled?: boolean;
  /** Called with accepted files and any rejections after a drop or a file-picker selection. */
  onDrop?: (acceptedFiles: File[], rejections: DropzoneRejection[]) => void;
  /** Called when the native file read itself fails; filter rejections go through `onDrop` instead. */
  onError?: (error: Error) => void;
  /** Currently held files, for `DropzoneContent`'s default rendering. */
  src?: File[];
  /** Accessible name for the drop surface. */
  "aria-label"?: string;
  /** Single-row layout (icon + content inline) instead of the tall centered box — for reuse in a compact spot, e.g. next to an existing preview. Default false. */
  compact?: boolean;
};

/**
 * Dependency-free file drop zone: native HTML5 drag-and-drop plus a hidden file input, no
 * react-dropzone. Renders `children` (default {@link DropzoneEmptyState} and
 * {@link DropzoneContent}) inside a focusable `role="button"` surface. Click or Enter/Space opens
 * the native picker; a drag-enter/leave depth counter keeps the active state from flickering when
 * the pointer crosses a child element.
 */
export function Dropzone(props: DropzoneProps): ReactNode {
  const { className, children, accept, maxFiles, maxSize, minSize, disabled = false, onDrop, onError, src, compact = false, ...rest } = props;
  const [isDragActive, setIsDragActive] = useState(false);
  const dragDepthRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const emit = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      try {
        const { accepted, rejections } = filterFiles(Array.from(files), { accept, maxSize, minSize, maxFiles });
        onDrop?.(accepted, rejections);
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    [accept, maxSize, minSize, maxFiles, onDrop, onError],
  );

  const openPicker = useCallback(() => {
    if (disabled) return;
    inputRef.current?.click();
  }, [disabled]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openPicker();
    },
    [openPicker],
  );

  const onDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (disabled) return;
      dragDepthRef.current += 1;
      setIsDragActive(true);
    },
    [disabled],
  );

  const onDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
    },
    [],
  );

  const onDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setIsDragActive(false);
    },
    [],
  );

  const onDropHandler = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragActive(false);
      if (disabled) return;
      emit(event.dataTransfer?.files ?? null);
    },
    [disabled, emit],
  );

  return (
    <DropzoneContext.Provider value={{ src, isDragActive, disabled, accept, maxSize }}>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label={rest["aria-label"]}
        aria-describedby={`${inputId}-description`}
        onClick={openPicker}
        onKeyDown={onKeyDown}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDropHandler}
        data-drag-active={isDragActive || undefined}
        data-disabled={disabled || undefined}
        className={cn(
          "flex w-full cursor-pointer rounded-md border border-dashed border-input outline-none transition-colors",
          compact
            ? "min-h-9 flex-row items-center gap-2 px-2 py-1.5 text-start"
            : "min-h-40 flex-col items-center justify-center gap-2 p-6 text-center",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          isDragActive && "border-primary bg-primary/5 ring-2 ring-primary/20",
          disabled && "cursor-not-allowed opacity-50",
          className,
        )}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          className="hidden"
          disabled={disabled}
          multiple={maxFiles !== 1}
          accept={accept ? Object.values(accept).flat().join(",") : undefined}
          // input.click() bubbles a real click back up to this element's own onClick=openPicker —
          // without stopping it here, opening the picker fires it a second time.
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            emit(event.target.files);
            event.target.value = "";
          }}
        />
        <span id={`${inputId}-description`} className="sr-only">
          {accept ? `Accepted file types: ${Object.values(accept).flat().join(", ")}.` : "All file types accepted."}
        </span>
        {children ?? (
          <>
            <DropzoneEmptyState />
            <DropzoneContent />
          </>
        )}
      </div>
    </DropzoneContext.Provider>
  );
}

/** Formats a byte count as a short human-readable size (e.g. "1.5 MB"). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

/** Props for {@link DropzoneEmptyState}. */
export type DropzoneEmptyStateProps = { title?: string; description?: string };

/** Default idle-state contents of {@link Dropzone}: icon, title, and an accepted-types/size caption. */
export function DropzoneEmptyState(props: DropzoneEmptyStateProps): ReactNode {
  const { title = "Upload a file", description } = props;
  const { src, accept, maxSize } = useDropzoneContext("DropzoneEmptyState");
  if (src && src.length > 0) return null;

  const caption =
    description ??
    [
      "Drag and drop or click to upload",
      accept ? Object.values(accept).flat().join(", ") : undefined,
      maxSize !== undefined ? `up to ${formatBytes(maxSize)}` : undefined,
    ]
      .filter(Boolean)
      .join(" — ");

  return (
    <>
      <Upload className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{caption}</p>
    </>
  );
}

/** Props for {@link DropzoneContent}. */
export type DropzoneContentProps = { children?: ReactNode };

/** Default held-files contents of {@link Dropzone}: one line per file in `src`, hidden until `src` is non-empty. */
export function DropzoneContent(props: DropzoneContentProps): ReactNode {
  const { children } = props;
  const { src } = useDropzoneContext("DropzoneContent");
  if (!src || src.length === 0) return null;
  if (children) return <>{children}</>;

  return (
    <ul className="flex w-full flex-col gap-1 text-start">
      {src.map((file, index) => (
        <li key={`${file.name}-${index}`} className="truncate text-sm text-foreground">
          <span>{file.name}</span> <span className="text-xs text-muted-foreground">({formatBytes(file.size)})</span>
        </li>
      ))}
    </ul>
  );
}


