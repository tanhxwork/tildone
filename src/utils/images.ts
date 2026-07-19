import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { BaseDirectory, mkdir, remove, writeFile } from "@tauri-apps/plugin-fs";
import type { TaskImage } from "../types";

/** Hard per-image ceiling. A paste over this is refused outright — a task board
 *  is not a photo library, and one runaway paste must not balloon app-data. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Clipboard screenshots on a retina display arrive at 2x pixel density; anything
 *  wider than this gets scaled down before saving. Card thumbs render at ~56px and
 *  the lightbox caps at the window, so pixels past this are pure disk cost. */
const MAX_IMAGE_WIDTH = 2500;

/** An image captured from the clipboard (or a file), held in memory until the
 *  task exists to attach it to. `url` is an object URL for the preview chip —
 *  callers must release() it when the pending image leaves the screen. */
export interface PendingImage {
  key: string;
  blob: Blob;
  name: string;
  width: number;
  height: number;
  url: string;
}

let pendingKey = 0;

/** Pull every image out of a paste or drop payload. Non-image items are ignored;
 *  over-cap images are skipped and reported via the second return so the UI can
 *  say so instead of silently dropping a paste. */
export async function imagesFromDataTransfer(
  data: DataTransfer,
): Promise<{ images: PendingImage[]; skipped: number }> {
  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  const images: PendingImage[] = [];
  let skipped = 0;
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) {
      skipped += 1;
      continue;
    }
    images.push(await toPending(file));
  }
  return { images, skipped };
}

async function toPending(file: File): Promise<PendingImage> {
  // A clipboard bitmap has no filename ("image.png" is the browser's stand-in);
  // a real dropped/copied file keeps its own name.
  const name = file.name && file.name !== "image.png" ? file.name : "Pasted image";
  return toPendingBlob(file, name);
}

async function toPendingBlob(blob: Blob, name: string): Promise<PendingImage> {
  const scaled = await downscale(blob);
  return {
    key: `pending-${++pendingKey}`,
    blob: scaled.blob,
    name,
    width: scaled.width,
    height: scaled.height,
    url: URL.createObjectURL(scaled.blob),
  };
}

/** Read images straight off the async clipboard (the editor's "Paste image"
 *  tile). Throws where the webview doesn't grant clipboard.read — callers
 *  catch and fall back to the ⌘V hint. */
export async function imagesFromClipboardRead(): Promise<{
  images: PendingImage[];
  skipped: number;
}> {
  const items = await navigator.clipboard.read();
  const images: PendingImage[] = [];
  let skipped = 0;
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith("image/"));
    if (!type) continue;
    const blob = await item.getType(type);
    if (blob.size > MAX_IMAGE_BYTES) {
      skipped += 1;
      continue;
    }
    images.push(await toPendingBlob(blob, "Pasted image"));
  }
  return { images, skipped };
}

/** Cap width at MAX_IMAGE_WIDTH, re-encoding as PNG. Images already under the
 *  cap pass through untouched — no re-encode, no quality loss. */
async function downscale(
  file: Blob,
): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  if (width <= MAX_IMAGE_WIDTH) {
    bitmap.close();
    return { blob: file, width, height };
  }
  const w = MAX_IMAGE_WIDTH;
  const h = Math.round((height / width) * w);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  return { blob: blob ?? file, width: w, height: h };
}

export function releasePending(images: PendingImage[]): void {
  for (const img of images) URL.revokeObjectURL(img.url);
}

export function formatImageBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Write a pending image into <app-data>/attachments/<task_id>/ and return the
 *  row fields (relative path + metadata) for the task_images insert. */
export async function saveImageFile(
  taskId: number,
  image: PendingImage,
): Promise<{ path: string; filename: string; bytes: number; width: number; height: number }> {
  const dir = `attachments/${taskId}`;
  await mkdir(dir, { baseDir: BaseDirectory.AppData, recursive: true });
  const ext = extensionFor(image.blob.type);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${dir}/img-${stamp}-${image.key}.${ext}`;
  const bytes = new Uint8Array(await image.blob.arrayBuffer());
  await writeFile(path, bytes, { baseDir: BaseDirectory.AppData });
  return {
    path,
    filename: image.name,
    bytes: bytes.byteLength,
    width: image.width,
    height: image.height,
  };
}

export async function removeImageFile(image: TaskImage): Promise<void> {
  await remove(image.path, { baseDir: BaseDirectory.AppData });
}

function extensionFor(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return "png";
  }
}

// ---- display -----------------------------------------------------------------

// appDataDir() is async but the value never changes for the life of the process;
// resolve once and let components re-render when it lands.
let appDataBase: string | null = null;
const baseReady = appDataDir()
  .then((dir) => {
    appDataBase = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  })
  .catch(() => {});

/** Absolute path of a stored image, or null until the app-data dir resolves. */
export function imageAbsPath(image: TaskImage): string | null {
  return appDataBase ? `${appDataBase}/${image.path}` : null;
}

/** asset: URL the webview can render, or null until the app-data dir resolves.
 *  Callers that mount before resolution can await imagesReady() and re-render. */
export function imageSrc(image: TaskImage): string | null {
  const abs = imageAbsPath(image);
  return abs ? convertFileSrc(abs) : null;
}

export function imagesReady(): Promise<void> {
  return baseReady;
}

/** Re-render once the app-data dir resolves, so components that mounted before
 *  resolution (first paint) pick up real imageSrc values. */
export function useImageBase(): void {
  const [, setReady] = useState(appDataBase !== null);
  useEffect(() => {
    void baseReady.then(() => setReady(true));
  }, []);
}
