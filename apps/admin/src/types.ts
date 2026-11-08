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
}

/** Payload of GET /admin/api/team-codes: only coded teams are listed;
 *  teams without a code are summarized so the 已发 X / Y counter stays meaningful. */
export interface TeamCodesResponse {
  rows: TeamCodeRow[]
  unassigned: number
}

/** Entry of GET /admin/api/login-history (newest first). */
export interface LoginHistoryEntry {
  icpcId: string
  teamCode: string
  at: string
  ip: string | null
}
