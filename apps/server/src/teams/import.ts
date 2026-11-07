import * as XLSX from "xlsx";
import type { DjClient, DjTeam } from "../domjudge/client";
import type { JsonStore } from "../store/store";
import type { TeamStore } from "../store/teams";

export type ImportResult = { imported: number; skipped: number };

function cell(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function pick(row: Record<string, unknown>, key: string): unknown {
  const wanted = key.toLowerCase();
  for (const header of Object.keys(row)) {
    if (header.trim().toLowerCase() === wanted) return row[header];
  }
  return undefined;
}

/**
 * Import an Excel table with header row `ICPC_ID | PASSWORD` (case-insensitive).
 * Rows whose icpc_id is not in `teams` are counted as skipped, not an error.
 * Password values are encrypted via TeamStore and never logged.
 */
export async function importTeamsFromExcel(
  buffer: Buffer,
  teams: DjTeam[],
  teamStore: TeamStore,
): Promise<ImportResult> {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { imported: 0, skipped: 0 };
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
  const known = new Set(teams.map((t) => (t.icpc_id ?? "").trim()));
  let imported = 0;
  let skipped = 0;
  for (const row of rows) {
    const icpcId = cell(pick(row, "ICPC_ID"));
    const password = cell(pick(row, "PASSWORD"));
    if (!icpcId || !password || !known.has(icpcId)) {
      skipped++;
      continue;
    }
    teamStore.setPassword(icpcId, password);
    imported++;
  }
  return { imported, skipped };
}

/** Pull all teams for a contest from DOMjudge and persist them, returning the count. */
export async function syncTeamsFromDomjudge(
  client: DjClient,
  contestId: string,
  teamsStore: JsonStore<DjTeam[]>,
): Promise<number> {
  const teams = await client.getTeams(contestId);
  teamsStore.save(teams);
  return teams.length;
}
