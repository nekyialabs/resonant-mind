// HTTP handler for /api/weather/trend — mood trend over N days (JSON).
import { jsonResponse } from "../response";
import type { Env } from "../../types";
import { clampLimit } from "../../shared/limits";

export async function handleApiWeatherTrend(request: Request, env: Env): Promise<Response> {
  const days = clampLimit(new URL(request.url).searchParams.get("days"), 7);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const result = await env.DB.prepare(`
    SELECT
      DATE_TRUNC('day', timestamp) AS day,
      feeling, intensity, COUNT(*) AS n
    FROM relational_state
    WHERE timestamp > $1
    GROUP BY DATE_TRUNC('day', timestamp), feeling, intensity
    ORDER BY day DESC, n DESC
  `).bind(cutoff).all();

  const rows = (result.results || []) as Array<Record<string, unknown>>;
  const byDay: Record<string, { feeling: string; intensity: string; n: number }> = {};
  for (const r of rows) {
    const day = String(r.day).slice(0, 10);
    if (!byDay[day]) {
      byDay[day] = {
        feeling: r.feeling as string,
        intensity: r.intensity as string,
        n: Number(r.n),
      };
    }
  }

  return jsonResponse({
    days,
    trend: Object.entries(byDay).map(([day, top]) => ({ day, ...top })),
  });
}
