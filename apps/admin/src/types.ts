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

/** Entry of GET /admin/api/login-history (newest first). */
export interface LoginHistoryEntry {
  icpcId: string
  teamCode: string
  at: string
  ip: string | null
}
