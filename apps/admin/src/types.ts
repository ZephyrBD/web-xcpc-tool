export type PrintTaskStatus = 'pending' | 'printed' | 'failed'

export interface PrintTask {
  id: string
  location: string
  teamName: string
  teamId: string
  originalFilename: string
  status: PrintTaskStatus
  createdAt: string
}

export interface BalloonTask {
  id: string
  contestId: string
  problemLabel: string
  teamName: string
  location: string | null
  status: 'pending' | 'delivered'
  createdAt: string
  /** DOMjudge balloon id matched at poll time; null/absent when unmatched. */
  balloonId?: number | null
}

export interface Team {
  id: string
  name?: string
}

/** Row of GET /admin/api/team-codes — passwords are never included. */
export interface TeamCodeRow {
  icpcId: string
  name: string
  teamCode: string | null
  hasPassword: boolean
  /** DOMjudge login name recorded at provision time; null when not provisioned. */
  djUsername: string | null
}

/** Payload of GET /admin/api/team-codes: only coded teams are listed;
 *  teams without a code are summarized so the 已发 X / Y counter stays meaningful. */
export interface TeamCodesResponse {
  rows: TeamCodeRow[]
  unassigned: number
}

/** Entry of GET /admin/api/login-history (newest first).
 *  teamName/djUsername are joined server-side and null when the team was deleted or never provisioned. */
export interface LoginHistoryEntry {
  icpcId: string
  teamCode: string
  at: string
  ip: string | null
  teamName: string | null
  djUsername: string | null
}

/** 「队名（账号名）」 label, falling back to whichever is known, then the raw icpcId. */
export function loginHistoryLabel(e: Pick<LoginHistoryEntry, 'icpcId' | 'teamName' | 'djUsername'>): string {
  if (e.teamName && e.djUsername) return `${e.teamName}（${e.djUsername}）`
  return e.teamName || e.djUsername || e.icpcId
}
