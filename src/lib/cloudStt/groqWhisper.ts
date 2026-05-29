const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo";

function extensionForBlob(blob: Blob): string {
  if (blob.type.includes("ogg")) return "ogg";
  if (blob.type.includes("wav")) return "wav";
  if (blob.type.includes("mp4")) return "mp4";
  return "webm";
}

export async function transcribeAudioBlob(
  blob: Blob,
  apiKey: string,
  prompt?: string,
): Promise<string> {
  if (blob.size < 1200) return "";

  const ext = extensionForBlob(blob);
  const mime = blob.type || (ext === "ogg" ? "audio/ogg" : "audio/webm");
  const form = new FormData();
  form.append("file", new File([blob], `chunk.${ext}`, { type: mime }));
  form.append("model", GROQ_WHISPER_MODEL);
  form.append("language", "en");
  form.append("response_format", "json");
  form.append("temperature", "0");

  const trimmedPrompt = prompt?.trim();
  if (trimmedPrompt) {
    form.append("prompt", trimmedPrompt.slice(-500));
  }

  const response = await fetch(GROQ_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Groq transcription failed (${response.status}): ${body.slice(0, 240)}`,
    );
  }

  const data = (await response.json()) as { text?: string };
  return data.text?.trim() ?? "";
}
