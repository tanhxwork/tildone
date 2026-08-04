import { useEvidenceNotice, type NoticeScope } from "../evidenceNotice";

/** The one line a failed evidence click leaves behind, under the prose that
 *  named the file. Renders nothing until something fails, and clears itself. */
export function EvidenceNotice({ scope }: { scope: NoticeScope }) {
  const { message, scope: at, clear } = useEvidenceNotice();
  if (!message || at !== scope) return null;
  return (
    <p
      className="detail-link-error"
      role="status"
      onClick={(e) => {
        e.stopPropagation();
        clear();
      }}
    >
      {message}
    </p>
  );
}
