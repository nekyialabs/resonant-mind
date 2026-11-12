/**
 * POST /api/dreams/compose-test — the dream-voice fitting room (2026-07-11).
 *
 * Audition surface: takes {model} (a Workers AI text model id), runs the REAL
 * dream-work prompt (imported from daemon/dream-compose — single source of
 * truth, never a forked copy) over the most recent dream's actual latent
 * material, and returns the composed prose. Same binding, same runtime, same
 * material as the nightly engine.
 *
 * Reads only. Writes nothing. Kept post-bake-off for future voice auditions
 * and prompt iteration (a prompt edit can be heard here before it ships a
 * night).
 */

import type { Env } from "../../types";
import { jsonResponse } from "../response";
import { DREAM_WORK_SYSTEM, buildDreamUserPrompt, extractModelText } from "../../daemon/dream-compose";

interface FragmentRow {
  content?: string;
  entity?: string;
  type?: string;
}

export async function handleApiDreamComposeTest(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "JSON body required: { model }" }, 400);
  }
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model.startsWith("@cf/")) {
    return jsonResponse({ error: "model must be a Workers AI id (e.g. '@cf/openai/gpt-oss-120b')" }, 400);
  }

  // The most recent real dream's material — the same latent content the
  // nightly composer would receive.
  const dream = (await env.DB.prepare(`
    SELECT id, dream_date, emotional_seed, fragments FROM dreams
    ORDER BY created_at DESC LIMIT 1
  `).first()) as { id: number; dream_date: string; emotional_seed: string; fragments: string } | null;
  if (!dream) return jsonResponse({ error: "no dreams in the table to compose from" }, 404);

  let fragments: FragmentRow[] = [];
  try {
    fragments = JSON.parse(dream.fragments) as FragmentRow[];
  } catch {
    return jsonResponse({ error: `dream #${dream.id} fragments unparseable` }, 500);
  }

  const userPrompt = buildDreamUserPrompt({
    emotionalSeed: dream.emotional_seed,
    fragments: fragments.map((f) => ({ content: String(f.content ?? ""), entity: f.entity, type: f.type })),
  });

  const started = Date.now();
  try {
    const result = (await env.AI.run(model, {
      messages: [
        { role: "system", content: DREAM_WORK_SYSTEM },
        { role: "user", content: userPrompt },
      ],
      max_tokens: typeof body.max_tokens === "number" ? Math.min(8192, body.max_tokens) : 2048,
      temperature: 0.9,
    })) as Record<string, unknown>;

    const text = extractModelText(result);
    if (!text) {
      return jsonResponse({
        model,
        error: "model returned no usable text — raw attached",
        raw: result,
      }, 502);
    }

    return jsonResponse({
      model,
      source_dream: { id: dream.id, date: dream.dream_date, fragment_count: fragments.length },
      ms: Date.now() - started,
      dream: text.trim(),
    });
  } catch (e) {
    console.error("[dream-compose-test] AI.run failed", e);
    return jsonResponse({
      model,
      error: "AI.run failed",
      ms: Date.now() - started,
    }, 502);
  }
}
