import mammoth from "mammoth";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

const STORAGE_KEY = "cus-interview-assistant-resume";

const SUPPORTED_EXTENSIONS = [".txt", ".md", ".text", ".markdown", ".pdf", ".docx"];

export type StoredResume = {
  text: string;
  fileName: string;
};

export function loadStoredResume(): StoredResume | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredResume;
    if (!parsed?.text?.trim()) return null;
    return {
      text: parsed.text.trim(),
      fileName: parsed.fileName?.trim() || "Resume",
    };
  } catch {
    return null;
  }
}

export function saveStoredResume(text: string, fileName: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ text: trimmed, fileName: fileName.trim() || "Resume" }),
  );
}

export function clearStoredResume(): void {
  localStorage.removeItem(STORAGE_KEY);
}

function fileExtension(file: File): string {
  const lower = file.name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

export function isSupportedResumeFile(file: File): boolean {
  const ext = fileExtension(file);
  if (SUPPORTED_EXTENSIONS.includes(ext)) return true;
  const type = file.type.toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/pdf" ||
    type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}

async function readPlainTextFile(file: File): Promise<string> {
  return (await file.text()).trim();
}

async function readPdfFile(file: File): Promise<string> {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocument({ data }).promise;
  const parts: string[] = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    parts.push(pageText);
  }
  return parts.join("\n").trim();
}

async function readDocxFile(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value.trim();
}

/** Extract text from PDF, DOCX, TXT, or MD resume files. */
export async function readResumeFile(file: File): Promise<string> {
  if (!isSupportedResumeFile(file)) {
    throw new Error(
      "Unsupported file type. Upload PDF, DOCX, TXT, or MD, or paste your resume text.",
    );
  }

  const ext = fileExtension(file);
  const type = file.type.toLowerCase();

  let text: string;
  if (ext === ".pdf" || type === "application/pdf") {
    text = await readPdfFile(file);
  } else if (
    ext === ".docx" ||
    type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    text = await readDocxFile(file);
  } else {
    text = await readPlainTextFile(file);
  }

  if (!text) {
    throw new Error(
      "No readable text found in that file. Try another export or paste your resume.",
    );
  }
  return text;
}

export function resumeCharCount(text: string): number {
  return text.trim().length;
}

export function formatResumePreview(text: string, maxLen = 100): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen)}…`;
}
