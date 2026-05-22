import { runAuthenticatedInterviewPrompt } from "./auth";

export type EngineResult<T> = {
  data: T;
  model: string;
};

/** Structured JSON returned by interview-coach prompts. */
export type InterviewCoachJson = {
  headline: string;
  bullets: string[];
  draftAnswer: string;
  caveats?: string;
};

export function parseJsonSafely<T>(raw: string): T {
  const cleaned = raw
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();
  return JSON.parse(cleaned) as T;
}

const JSON_SHAPE_INSTRUCTIONS = `Return ONLY valid JSON (no markdown fences) with this exact shape:
{
  "headline": "short label for what was asked",
  "bullets": ["3-5 concise talking points"],
  "draftAnswer": "first-person answer they can say aloud, 2-5 sentences (longer if code/examples are needed)",
  "caveats": "optional one line if transcript is unclear or assumptions were made; omit or use empty string"  
}`;

const CODING_INSTRUCTION = `If the recruiter question asks for code, an algorithm, implementation details, live coding, or a concrete technical example, include clear code or pseudocode in draftAnswer (and supporting bullets). Use fenced markdown code blocks when showing code.`;

export type CoachContext = {
  resumeText?: string;
};

function resumeSection(resumeText?: string): string {
  const trimmed = resumeText?.trim();
  if (!trimmed) return "";
  return `
Candidate resume (provided by the candidate):
"""
${trimmed}
"""

Resume rules:
- Use resume details ONLY when the recruiter question is about the candidate's background, experience, projects, skills, education, or roles that appear on the resume.
- Ground experience and project answers in facts from the resume when relevant; do not invent employers, dates, technologies, or projects not listed.
- If the question is general, behavioral but not resume-specific, or unrelated to the resume, answer without citing resume details.
- If the question asks about experience not on the resume, say so honestly and answer with transferable skills or general knowledge instead of fabricating resume items.
`;
}

function coachGuidelines(context?: CoachContext): string {
  const hasResume = !!context?.resumeText?.trim();
  const lines = [
    "You are an interview coach helping a candidate respond live.",
    CODING_INSTRUCTION,
  ];
  if (hasResume) {
    lines.push(
      "When the question relates to the candidate's resume, personalize bullets and draftAnswer using only verified resume content.",
    );
  }
  return lines.join("\n");
}

export function buildInterviewCoachPrompt(
  transcript: string,
  context?: CoachContext,
): string {
  return `${coachGuidelines(context)}
The following is what was heard from the recruiter (may be noisy or partial).

Transcript:
"""
${transcript.trim()}
"""
${resumeSection(context?.resumeText)}

${JSON_SHAPE_INSTRUCTIONS}`;
}

export type RefineKind = "shorter" | "technical" | "star";

const REFINE_INSTRUCTIONS: Record<RefineKind, string> = {
  shorter:
    "Make the answer more concise: fewer bullets (2-4), shorter draftAnswer (1-3 sentences). Keep the same meaning.",
  technical:
    "Make the answer more technical: use precise terminology, relevant tools/frameworks, and concrete engineering detail where appropriate.",
  star: "Rewrite draftAnswer using STAR (Situation, Task, Action, Result). Bullets should support that structure.",
};

export function buildRefineCoachPrompt(
  transcript: string,
  previous: InterviewCoachJson,
  kind: RefineKind,
  context?: CoachContext,
): string {
  const prevJson = JSON.stringify(previous, null, 2);
  return `${coachGuidelines(context)}

Recruiter question (transcript):
"""
${transcript.trim()}
"""
${resumeSection(context?.resumeText)}

Previous coach response (JSON):
${prevJson}

Refinement task: ${REFINE_INSTRUCTIONS[kind]}

${JSON_SHAPE_INSTRUCTIONS}`;
}

export function formatInterviewCoachJson(data: InterviewCoachJson): string {
  const lines: string[] = [];
  lines.push(data.headline.trim());
  lines.push("");
  for (const b of data.bullets) {
    lines.push(`• ${b.trim()}`);
  }
  lines.push("");
  lines.push(data.draftAnswer.trim());
  if (data.caveats?.trim()) {
    lines.push("");
    lines.push(`Note: ${data.caveats.trim()}`);
  }
  return lines.join("\n");
}

/** Normalize model output (camelCase or snake_case, missing fields). */
export function coerceInterviewCoachJson(data: unknown): InterviewCoachJson {
  if (!data || typeof data !== "object") {
    throw new Error("AI returned invalid JSON (not an object).");
  }
  const o = data as Record<string, unknown>;
  const headline =
    typeof o.headline === "string"
      ? o.headline
      : typeof o.title === "string"
        ? o.title
        : "Interview coach";
  let bullets: string[] = [];
  if (Array.isArray(o.bullets)) {
    bullets = o.bullets.filter((x): x is string => typeof x === "string");
  } else if (Array.isArray(o.keyPoints)) {
    bullets = o.keyPoints.filter((x): x is string => typeof x === "string");
  }
  const draftRaw =
    typeof o.draftAnswer === "string"
      ? o.draftAnswer
      : typeof o.draft_answer === "string"
        ? o.draft_answer
        : typeof o.suggestedAnswer === "string"
          ? o.suggestedAnswer
          : typeof o.suggested_answer === "string"
            ? o.suggested_answer
            : "";
  const caveats =
    typeof o.caveats === "string"
      ? o.caveats
      : typeof o.caveat === "string"
        ? o.caveat
        : undefined;
  if (!draftRaw.trim() && bullets.length === 0) {
    throw new Error("AI response missing draft answer and bullets.");
  }
  if (bullets.length === 0) {
    bullets = ["(No bullet list returned — use the draft below.)"];
  }
  return {
    headline: headline.trim() || "Interview coach",
    bullets,
    draftAnswer: draftRaw.trim() || "(No draft returned.)",
    caveats: caveats?.trim() || undefined,
  };
}


export async function runMockInterviewPrompt<T>(
  prompt: string,
): Promise<EngineResult<T>> {
  return runAuthenticatedInterviewPrompt<T>(prompt);
}
