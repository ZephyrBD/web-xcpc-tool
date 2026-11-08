import { describe, expect, test } from 'bun:test'
import { generateBalloonTicket } from '@/utils/printBalloon'
import type { BalloonTask } from '@/types'

const task: BalloonTask = {
  id: 'b1',
  contestId: 'c1',
  problemLabel: 'A',
  teamName: '队伍一',
  location: 'I1',
  status: 'pending',
  createdAt: '2026-11-07T10:00:00.000Z',
}

describe('generateBalloonTicket', () => {
  test('contains problem, team, seat and time', () => {
    const ticket = generateBalloonTicket(task)
    expect(ticket).toContain('BALLOON TICKET')
    expect(ticket).toContain('Problem : A')
    expect(ticket).toContain('Team    : 队伍一')
    expect(ticket).toContain('Seat    : I1')
  })

  test('missing location renders the em-dash placeholder', () => {
    expect(generateBalloonTicket({ ...task, location: null })).toContain('Seat    : —')
  })
})

// printBalloonTask's DOM flow (hidden iframe + print) is exercised end-to-end
// in the browser; the confirm-on-afterprint contract it relies on is covered
// by printPdf.test.ts (confirmOnAfterprint) and the JobsPage ack-flow tests.
