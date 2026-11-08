export type AuthTaskStatus = 'pending' | 'approved' | 'rejected' | 'auto-done'

export interface AuthTask {
  id: string
  examNum: string
  clientId: string | null
  strategy: string
  status: AuthTaskStatus
  createdAt: string
}

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
