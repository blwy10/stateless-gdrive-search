const MIME_TYPE_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/msword": "Word document",
  "application/vnd.google-apps.document": "Google Docs document",
  "application/vnd.google-apps.drawing": "Google Drawing",
  "application/vnd.google-apps.file": "Google Drive file",
  "application/vnd.google-apps.folder": "Google Drive folder",
  "application/vnd.google-apps.form": "Google Form",
  "application/vnd.google-apps.presentation": "Google Slides presentation",
  "application/vnd.google-apps.script": "Google Apps Script project",
  "application/vnd.google-apps.shortcut": "Google Drive shortcut",
  "application/vnd.google-apps.site": "Google Sites file",
  "application/vnd.google-apps.spreadsheet": "Google Sheets spreadsheet",
  "application/vnd.ms-excel": "Excel spreadsheet",
  "application/vnd.ms-powerpoint": "PowerPoint presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "PowerPoint presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel spreadsheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word document",
  "image/gif": "GIF image",
  "image/jpeg": "JPEG image",
  "image/png": "PNG image",
  "image/svg+xml": "SVG image",
  "text/csv": "CSV",
  "text/html": "HTML document",
  "text/markdown": "Markdown document",
  "text/plain": "Plain text"
};

export function formatMimeType(mimeType: string) {
  if (!mimeType) return "Unknown file type";
  const knownLabel = MIME_TYPE_LABELS[mimeType];
  if (knownLabel) return knownLabel;

  if (mimeType.startsWith("application/vnd.google-apps.")) {
    return `Google ${formatMimeSubtype(mimeType.replace("application/vnd.google-apps.", ""))}`;
  }

  const [category, subtype] = mimeType.split("/");
  if (!category || !subtype) return mimeType;
  return `${formatMimeSubtype(subtype)} ${formatMimeCategory(category)}`.trim();
}

function formatMimeCategory(category: string) {
  const labels: Record<string, string> = {
    application: "file",
    audio: "audio",
    image: "image",
    text: "document",
    video: "video"
  };
  return labels[category] ?? category;
}

function formatMimeSubtype(subtype: string) {
  return subtype
    .replace(/^vnd\./, "")
    .replace(/[.+_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
