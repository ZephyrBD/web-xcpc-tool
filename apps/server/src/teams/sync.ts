import type { DjClient, DjTeam } from "../domjudge/client";
import type { JsonStore } from "../store/store";

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
