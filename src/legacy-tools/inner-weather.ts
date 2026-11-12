/**
 * handleMindInnerWeather — current felt atmosphere.
 *
 * Composes actual weather (via getCurrentWeather), time-of-day energy,
 * thread workload (high priority / total active), recent emotional
 * observations, and heavy 24h items into a mood palette. The mind's
 * "what does it feel like right now" snapshot.
 *
 * Lives in legacy-tools/ pending R3 — post-reshape this becomes part of
 * the Atmospherics region.
 */

import type { Env } from "../types";
import { WEATHER_MOODS, getCurrentWeather } from "../shared/weather-api";
import { getTimeOfDayContext } from "../shared/time";

export async function handleMindInnerWeather(env: Env): Promise<string> {
  try {
    // Get actual weather
    const weather = await getCurrentWeather(env);
    const timeCtx = getTimeOfDayContext(env.LOCATION_TIMEZONE);

    const atmosphere = weather.atmosphere;
    const weatherMood = WEATHER_MOODS[atmosphere] || WEATHER_MOODS["clear"];

    // Get threads for workload context
    const threads = await env.DB.prepare(
      `SELECT priority, COUNT(*) as count FROM threads
       WHERE status = 'active' GROUP BY priority`
    ).all();

    const highPriority = ((threads.results || []).find((r: any) => r.priority === 'high')?.count as number) || 0;
    const totalActive = (threads.results || []).reduce((sum: number, r: any) => sum + (r.count as number), 0);

    // Get high priority thread content
    const pressingThreads = await env.DB.prepare(
      `SELECT content, thread_type FROM threads
       WHERE status = 'active' AND priority = 'high' LIMIT 3`
    ).all();

    const pressing = (pressingThreads.results || []).map((t: any) => ({
      content: String(t.content).slice(0, 100),
      type: t.thread_type
    }));

    // Get recent emotional observations
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recentEmotional = await env.DB.prepare(
      `SELECT o.content FROM observations o
       WHERE o.context = 'emotional-processing' AND o.added_at > ?
       ORDER BY o.added_at DESC LIMIT 3`
    ).bind(cutoff).all();

    const emotionalContent = (recentEmotional.results || []).map((r: any) =>
      String(r.content).slice(0, 80)
    );

    // Get heavy observations from last 24h
    const heavyObs = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM observations WHERE weight = 'heavy' AND added_at > ?`
    ).bind(cutoff).first() as {count: number} | null;

    // Build mood palette
    const palette = new Set<string>();
    weatherMood.textures.slice(0, 2).forEach(t => palette.add(t));
    timeCtx.textures.slice(0, 1).forEach(t => palette.add(t));

    if (highPriority > 0) palette.add("weighted");
    if (totalActive > 5) palette.add("full");

    const result: Record<string, any> = {
      timestamp: new Date().toISOString(),
      conditions: {
        weather: weather.temp_f ? `${atmosphere} (${weather.temp_f}F)` : atmosphere,
        location: weather.location,
        time: timeCtx.period,
        time_energy: timeCtx.energy,
        active_threads: totalActive,
        high_priority: highPriority,
        heavy_observations_24h: heavyObs?.count || 0,
        dominant_emotion: weatherMood.energy
      },
      mood_palette: Array.from(palette),
      weather_energy: weatherMood.energy,
      guidance: `Textures present: ${Array.from(palette).join(", ")}`
    };

    // Only include if there's data
    if (pressing.length > 0) {
      result.pressing = pressing;
    }
    if (emotionalContent.length > 0) {
      result.recent_emotional = emotionalContent.slice(0, 2);
    }

    // Debug: include raw weather data
    if (weather.error || weather.weather_code !== undefined) {
      result.weather_debug = {
        code: weather.weather_code,
        temp: weather.temp_f,
        error: weather.error
      };
    }

    return JSON.stringify(result, null, 2);
  } catch (error) {
    console.error("inner_weather failed", error);
    return JSON.stringify({ error: "Internal error" });
  }
}
