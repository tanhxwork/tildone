import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type RefObject,
} from "react";
import { format } from "date-fns";
import { useDropTarget } from "../fileDrop";
import { useSettings } from "../settings";
import { useStore } from "../store";
import { PRIORITY_LABELS } from "../types";
import { dueLabel, todayStr, tomorrowStr } from "../utils/dates";
import {
  formatImageBytes,
  imagesFromDataTransfer,
  imagesFromPaths,
  releasePending,
  type PendingImage,
} from "../utils/images";
import { parseQuickAdd } from "../utils/quickParse";
import { IconPlus, IconX } from "./Icons";

export function QuickAdd({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const { selection, addTask, attachImages, addTag, projects, tags } = useStore();
  const defaultProjectId = useSettings((s) => s.defaultProjectId);
  const [title, setTitle] = useState("");
  // Screenshots pasted while typing, held here until Enter creates the task they
  // land on. Chips render in the preview row beside the parsed text tokens.
  const [pending, setPending] = useState<PendingImage[]>([]);
  const [skippedOversize, setSkippedOversize] = useState(false);
  // Revoke outstanding chip object-URLs if the component unmounts (view switch)
  // with pastes still pending. Ref, not dep-driven cleanup: a cleanup keyed on
  // `pending` would revoke URLs the chips still render.
  const pendingRef = useRef<PendingImage[]>([]);
  pendingRef.current = pending;
  useEffect(() => () => releasePending(pendingRef.current), []);

  const parsed = useMemo(
    () => parseQuickAdd(title, { projects, tags }),
    [title, projects, tags],
  );
  const previewProject = projects.find((p) => p.id === parsed.projectId);
  const hasTokens =
    parsed.dueDate !== null ||
    previewProject !== undefined ||
    parsed.priority > 0 ||
    parsed.tagNames.length > 0;

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const data = e.clipboardData;
    if (!data) return;
    const hasImage = Array.from(data.items).some(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );
    if (!hasImage) return; // plain text pastes stay the input's business
    // A mixed clipboard (image + text) keeps its text half: the default paste
    // inserts the text into the title while the image still becomes a chip.
    if (!data.types.includes("text/plain")) e.preventDefault();
    // imagesFromDataTransfer grabs the files synchronously before its first await,
    // so the clipboard data is safe to read past this handler's return.
    void imagesFromDataTransfer(data).then(({ images, skipped }) => {
      if (images.length > 0) setPending((p) => [...p, ...images]);
      if (skipped > 0) setSkippedOversize(true);
    });
  }

  // Dropping image files onto the bar collects them as chips, exactly as a paste
  // does — the task they attach to is still created on Enter.
  const onDropFiles = useCallback((paths: string[]) => {
    void imagesFromPaths(paths).then(({ images, skipped }) => {
      if (images.length > 0) setPending((p) => [...p, ...images]);
      if (skipped > 0) setSkippedOversize(true);
    });
  }, []);
  const { isOver, dropProps } = useDropTarget("quick-add", onDropFiles);

  function removePending(image: PendingImage) {
    releasePending([image]);
    setPending((p) => p.filter((x) => x.key !== image.key));
  }

  async function submit() {
    const trimmed = title.trim();
    if (!trimmed && pending.length === 0) return;
    const p = trimmed ? parseQuickAdd(trimmed, { projects, tags }) : null;
    // Parsed tokens override the view defaults; absent tokens keep them.
    const project_id =
      p?.projectId ??
      (selection.type === "project" ? selection.projectId : defaultProjectId);
    const due_date =
      p?.dueDate ??
      (selection.type === "today" || selection.type === "week"
        ? todayStr()
        : selection.type === "upcoming"
          ? tomorrowStr()
          : null);
    const tag_ids: number[] = [];
    for (const name of p?.tagNames ?? []) tag_ids.push(await addTag(name));
    const id = await addTask({
      // An input that is all tokens ("tomorrow !high") keeps the raw text as
      // title; an image-only capture auto-titles and stays editable in the card.
      title: p ? p.title || trimmed : `Screenshot ${format(new Date(), "MMM d")}`,
      project_id,
      due_date,
      priority: p?.priority ?? 0,
      tag_ids,
    });
    if (pending.length > 0) {
      const toAttach = pending;
      setPending([]);
      try {
        await attachImages(id, toAttach);
      } finally {
        releasePending(toAttach);
      }
    }
    setSkippedOversize(false);
    setTitle("");
  }

  const defaultProject = projects.find((p) => p.id === defaultProjectId);
  const hint =
    selection.type === "today" || selection.type === "week"
      ? "due today"
      : selection.type === "upcoming"
        ? "due tomorrow"
        : selection.type === "project"
          ? "in this project"
          : defaultProject
            ? `to ${defaultProject.name}`
            : "to inbox";

  return (
    <>
      <div className={`quick-add${isOver ? " drop-over" : ""}`} {...dropProps}>
        <IconPlus size={15} />
        <input
          ref={inputRef}
          value={title}
          placeholder={`Add a task (${hint})… try "pay rent tomorrow #home !high"`}
          aria-label="New task title"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          onPaste={onPaste}
        />
      </div>
      {(hasTokens || pending.length > 0 || skippedOversize) && (
        <div className="quick-add-preview" aria-live="polite">
          {pending.map((img) => (
            <span key={img.key} className="qa-image-chip">
              <img className="qa-image-thumb" src={img.url} alt="" />
              <span className="qa-image-meta">
                <span className="qa-image-name">{img.name}</span>
                <span className="qa-image-size">{formatImageBytes(img.blob.size)}</span>
              </span>
              <button
                type="button"
                className="qa-image-x"
                aria-label={`Remove ${img.name}`}
                onClick={() => removePending(img)}
              >
                <IconX size={12} />
              </button>
            </span>
          ))}
          {skippedOversize && (
            <span className="qa-chip qa-skipped">Image over 10 MB skipped</span>
          )}
          {parsed.dueDate !== null && (
            <span className="qa-chip qa-date">{dueLabel(parsed.dueDate)}</span>
          )}
          {previewProject && <span className="qa-chip qa-project">#{previewProject.name}</span>}
          {parsed.priority > 0 && (
            <span className="qa-chip qa-priority">{PRIORITY_LABELS[parsed.priority]}</span>
          )}
          {parsed.tagNames.map((name) => (
            <span key={name.toLowerCase()} className="qa-chip qa-tag">
              @{name}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
