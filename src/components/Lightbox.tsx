import { useEffect } from "react";
import { useLightbox } from "../lightbox";
import { imageSrc, useImageBase } from "../utils/images";
import { IconChevronLeft, IconChevronRight, IconX } from "./Icons";

/** Full-size image view over the standard scrim. Esc, click-outside, or ✕
 *  closes; arrow keys step through the task's images. */
export function Lightbox() {
  const { images, index, close, step } = useLightbox();
  useImageBase();
  const image = images[index];

  useEffect(() => {
    if (!image) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    }
    // Capture phase so Escape closes the image, not whatever editor sits below.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [image, close, step]);

  if (!image) return null;
  const src = imageSrc(image);

  return (
    <div
      className="lightbox-overlay"
      role="dialog"
      aria-label={image.filename}
      onClick={close}
    >
      {src && (
        <img
          className="lightbox-image"
          src={src}
          alt={image.filename}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <button type="button" className="lightbox-close" aria-label="Close" onClick={close}>
        <IconX size={14} />
      </button>
      {images.length > 1 && (
        <>
          <button
            type="button"
            className="lightbox-nav prev"
            aria-label="Previous image"
            onClick={(e) => {
              e.stopPropagation();
              step(-1);
            }}
          >
            <IconChevronLeft size={16} />
          </button>
          <button
            type="button"
            className="lightbox-nav next"
            aria-label="Next image"
            onClick={(e) => {
              e.stopPropagation();
              step(1);
            }}
          >
            <IconChevronRight size={16} />
          </button>
          <span className="lightbox-count">
            {index + 1} / {images.length}
          </span>
        </>
      )}
    </div>
  );
}
